"""Case-study CRUD, datapackage handling, ZIP upload, reload, SPA catch-all.

`register_routes` MUST be called LAST on the frontend app so the catch-all
``/<path:path>`` SPA route is registered after every API endpoint.
"""

import csv
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime

from flask import jsonify, request, send_from_directory

import state
from fs_utils import (
    area_label,
    country_label,
    create_baseline_metadata_entry,
    find_geodata_shapefile,
    write_scenario_metadata_csv,
)


# ──────────────────────────────────────────────────────────────────────────────
# Filesystem helpers
# ──────────────────────────────────────────────────────────────────────────────

# Free-text datapackage fields that exist purely to feed narrative reports.
# They are optional everywhere: absent in older case studies, editable through
# the normal datapackage PUT endpoint, and default to ''.
_NARRATIVE_DATAPACKAGE_FIELDS = (
    'study_area_description',
    'authors',
    'organisation',
    'funding',
    'citation',
    'report_notes',
)


def create_datapackage_json(case_study_path, case_study_name, case_study_description, created_by, csv_files=None, enabled_categories=None):
    """Create a datapackage.json file with case study metadata and CSV file references"""
    csv_files = csv_files or []

    datapackage = {
        "name": case_study_name.lower().replace(" ", "-").replace("_", "-"),
        "title": case_study_name,
        "description": case_study_description,
        "version": "1.0.0",
        "created": datetime.now().isoformat(),
        "created_by": created_by,
        "resources": []
    }

    for field in _NARRATIVE_DATAPACKAGE_FIELDS:
        datapackage[field] = ""

    if enabled_categories is not None:
        datapackage["enabled_categories"] = enabled_categories

    for csv_file in csv_files:
        resource = {
            "name": os.path.splitext(csv_file)[0],
            "path": f"input/baseline/{csv_file}",
            "title": csv_file,
            "description": f"Data file: {csv_file}",
            "format": "csv",
            "mediatype": "text/csv"
        }
        datapackage["resources"].append(resource)

    datapackage_path = os.path.join(case_study_path, 'datapackage.json')
    with open(datapackage_path, 'w', encoding='utf-8') as f:
        json.dump(datapackage, f, indent=2, ensure_ascii=False)

    return datapackage_path


def create_case_study_folders(case_study_id, case_study_name):
    """Create the folder structure for a case study"""
    safe_name = "".join(c for c in case_study_name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    folder_name = f"{safe_name}_{case_study_id[:8]}"

    case_study_path = os.path.join(state.DATA_DIR, folder_name)

    os.makedirs(os.path.join(case_study_path, 'input'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'output'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'config'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'input', 'baseline'), exist_ok=True)

    return case_study_path, folder_name


def _parse_ssp_year(folder_name):
    """Extract SSP and year from a folder name like 'SSP1_2030' or 'ssp3_2050'.
    Returns (ssp_str, year_str) or ('', '') if not parseable."""
    ssp = ''
    year = ''
    for part in folder_name.split('_'):
        upper = part.upper()
        if upper.startswith('SSP') and len(upper) >= 4 and upper[3:].isdigit():
            ssp = upper
        elif part.isdigit() and len(part) == 4:
            year = part
    return ssp, year


def _copy_folder_to_dest(src_dir, dst_dir, zip_path, files_collected, prefix):
    """Walk src_dir and copy files to dst_dir, applying RASTER_RENAME_MAP.
    Appends prefix/rel_path strings to files_collected.

    Uses ``shutil.copy`` (data only, no ``copystat``) and caches which
    destination directories already exist, since ``dst_dir`` is typically a
    slow bind-mounted volume (e.g. Docker Desktop on Windows) where every
    extra syscall — timestamp/permission copies, redundant ``makedirs``
    stats — adds noticeable per-file latency across hundreds/thousands of
    files.
    """
    made_dirs = set()
    for root, _dirs, flist in os.walk(src_dir):
        for f in flist:
            src_file = os.path.join(root, f)
            if os.path.abspath(src_file) == os.path.abspath(zip_path):
                continue
            rel = os.path.relpath(src_file, src_dir)
            parts = rel.split(os.sep)
            parts[-1] = state.RASTER_RENAME_MAP.get(parts[-1].lower(), parts[-1])
            rel = os.path.join(*parts)
            dest_file = os.path.join(dst_dir, rel)
            dest_dir = os.path.dirname(dest_file)
            if dest_dir not in made_dirs:
                os.makedirs(dest_dir, exist_ok=True)
                made_dirs.add(dest_dir)
            shutil.copy(src_file, dest_file)
            files_collected.append(os.path.join(prefix, rel))


def _do_zip_upload(file):
    """Shared implementation for processing a ZIP-file case-study upload.

    Handles three ZIP layouts:
    1. Full export  – has an ``input/`` subdirectory (mirrors the on-disk case
       study structure).  ``config/``, ``input/``, and ``output/`` are copied
       verbatim.
    2. Share format – has a ``baseline/`` directory at the root, plus optional
       non-baseline scenario directories and/or a ``config/`` directory.
    3. Flat         – no ``baseline/`` or ``input/`` dir; entire root is treated
       as baseline data.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        zip_path = os.path.join(temp_dir, file.filename)
        file.save(zip_path)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        # Unwrap single top-level folder (common when zipping a directory).
        top_level = [e for e in os.listdir(temp_dir) if e != os.path.basename(zip_path)]
        if len(top_level) == 1 and os.path.isdir(os.path.join(temp_dir, top_level[0])):
            extract_root = os.path.join(temp_dir, top_level[0])
        else:
            extract_root = temp_dir

        case_study_id   = str(uuid.uuid4())
        case_study_name = os.path.splitext(file.filename)[0]
        case_study_path, folder_name = create_case_study_folders(case_study_id, case_study_name)

        files_copied  = []
        cat_check_dir = os.path.join(case_study_path, 'input', 'baseline')

        has_input_dir   = os.path.isdir(os.path.join(extract_root, 'input'))
        has_baseline_dir = os.path.isdir(os.path.join(extract_root, 'baseline'))

        if has_input_dir:
            # ── Layout 1: full case-study export ──────────────────────────
            for subdir in ('input', 'config', 'output'):
                src_dir = os.path.join(extract_root, subdir)
                if os.path.isdir(src_dir):
                    dst_dir = os.path.join(case_study_path, subdir)
                    # copy_function=shutil.copy skips copystat (timestamps/perms) —
                    # each extra syscall adds up across hundreds of files on a
                    # slow bind-mounted destination.
                    shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True, copy_function=shutil.copy)
                    for root_w, _, flist in os.walk(dst_dir):
                        for f in flist:
                            files_copied.append(
                                os.path.join(os.path.relpath(root_w, case_study_path), f)
                            )
        else:
            # ── Layout 2 / 3: share format or flat baseline ───────────────
            src_baseline = (
                os.path.join(extract_root, 'baseline') if has_baseline_dir else extract_root
            )
            baseline_dst = os.path.join(case_study_path, 'input', 'baseline')
            _copy_folder_to_dest(src_baseline, baseline_dst, zip_path, files_copied, 'baseline')

            if has_baseline_dir:
                # Copy any additional scenario dirs (siblings of baseline/).
                skip = {'baseline', 'config', 'output'}
                for entry in sorted(os.listdir(extract_root)):
                    entry_path = os.path.join(extract_root, entry)
                    if (
                        not os.path.isdir(entry_path)
                        or entry.lower() in skip
                        or entry.startswith('.')
                        or entry.startswith('__')
                    ):
                        continue
                    scen_dst = os.path.join(case_study_path, 'input', entry)
                    os.makedirs(scen_dst, exist_ok=True)
                    _copy_folder_to_dest(entry_path, scen_dst, zip_path, files_copied, entry)

            # Copy config/ if present.
            config_src = os.path.join(extract_root, 'config')
            if os.path.isdir(config_src):
                shutil.copytree(config_src, os.path.join(case_study_path, 'config'),
                                dirs_exist_ok=True, copy_function=shutil.copy)

        # ── Flatten input/scenarios/<dir>/ → input/<dir>/ if present ────────
        # Some ZIPs pack non-baseline scenarios under input/scenarios/ rather
        # than directly under input/.  Move each subfolder up one level so the
        # rest of the backend can find them at input/<folder>/.
        flattened_scenario_dirs = []
        scenarios_subdir = os.path.join(case_study_path, 'input', 'scenarios')
        if os.path.isdir(scenarios_subdir):
            for scen_dir in sorted(os.listdir(scenarios_subdir)):
                scen_src = os.path.join(scenarios_subdir, scen_dir)
                if not os.path.isdir(scen_src):
                    continue
                scen_dst = os.path.join(case_study_path, 'input', scen_dir)
                shutil.move(scen_src, scen_dst)
                flattened_scenario_dirs.append(scen_dir)
            shutil.rmtree(scenarios_subdir)
            print(f"[DEBUG] Flattened {len(flattened_scenario_dirs)} scenario dir(s) from input/scenarios/")

        # ── Detect enabled categories from baseline folder ─────────────────
        enabled_categories = [
            cat_id
            for cat_id, cat_folder in state.CATEGORY_FOLDER_MAP.items()
            if os.path.isdir(os.path.join(cat_check_dir, cat_folder))
        ]
        print(f"[DEBUG] Detected enabled categories: {enabled_categories}")

        # ── Create datapackage.json ────────────────────────────────────────
        csv_files = [p for p in files_copied if p.lower().endswith('.csv')]
        datapackage_path = create_datapackage_json(
            case_study_path,
            case_study_name,
            f"Imported from {file.filename}",
            created_by="Upload User",
            csv_files=[os.path.basename(p) for p in csv_files],
            enabled_categories=enabled_categories or None,
        )

        # ── Build / import scenario metadata ───────────────────────────────
        meta_csv_path  = os.path.join(case_study_path, 'config', 'scenario_metadata.csv')
        scenario_count = 0

        if os.path.exists(meta_csv_path):
            # Re-stamp scenario IDs so they're unique to this installation.
            with open(meta_csv_path, 'r', newline='', encoding='utf-8') as f:
                rows = list(csv.DictReader(f))
            now = datetime.now().isoformat()
            for row in rows:
                row['scenario_id'] = str(uuid.uuid4())
                row['created_at']  = now
                row['updated_at']  = now
            write_scenario_metadata_csv(meta_csv_path, rows)
            scenario_count = len(rows)
            print(f"[DEBUG] Imported {scenario_count} scenario(s) from scenario_metadata.csv")
        elif flattened_scenario_dirs:
            # Auto-generate metadata from the flattened scenario directories.
            now = datetime.now().isoformat()
            rows = []
            # Baseline entry (always present when input/scenarios/ exists)
            rows.append({
                'scenario_id': str(uuid.uuid4()),
                'name':        'Baseline',
                'folder':      'baseline',
                'ssp':         '',
                'pathogen':    '',
                'year':        '',
                'is_baseline': 'True',
                'notes':       f'Baseline imported from {file.filename}',
                'created_at':  now,
                'updated_at':  now,
            })
            for scen_dir in flattened_scenario_dirs:
                ssp, year = _parse_ssp_year(scen_dir)
                name = f"{ssp} {year}".strip() if (ssp or year) else scen_dir
                rows.append({
                    'scenario_id': str(uuid.uuid4()),
                    'name':        name,
                    'folder':      scen_dir,
                    'ssp':         ssp,
                    'pathogen':    '',  # user must configure
                    'year':        year,
                    'is_baseline': 'False',
                    'notes':       f'Imported from {file.filename}',
                    'created_at':  now,
                    'updated_at':  now,
                })
            write_scenario_metadata_csv(meta_csv_path, rows)
            scenario_count = len(rows)
            print(f"[DEBUG] Auto-generated {scenario_count} scenario entries from flattened dirs")
        else:
            has_isodata = any(os.path.basename(p).lower() == 'isodata.csv' for p in files_copied)
            if has_isodata:
                create_baseline_metadata_entry(case_study_path)
                scenario_count = 1
            else:
                print(f"[WARN] No isodata.csv found in {file.filename}; baseline entry not created.")

        case_study = {
            "id":               case_study_id,
            "name":             case_study_name,
            "description":      f"Imported from {file.filename} — {len(files_copied)} files",
            "created_at":       datetime.now().isoformat(),
            "scenario_count":   scenario_count,
            "files":            files_copied,
            "folder_name":      folder_name,
            "folder_path":      case_study_path,
            "datapackage_path": datapackage_path,
            "enabled_categories": enabled_categories or None,
            "scenarios":        [],
        }
        state.case_studies.append(case_study)

        print(f"[DEBUG] Imported '{case_study_name}' — {len(files_copied)} files, {scenario_count} scenario(s)")
        return case_study


def load_existing_case_studies():
    """Scan DATA_DIR and rebuild the in-memory case_studies list from disk."""
    state.case_studies.clear()

    print(f"Loading case studies from: {state.DATA_DIR}")

    if not os.path.exists(state.DATA_DIR):
        print(f"Data directory does not exist: {state.DATA_DIR}")
        return

    for item in sorted(os.listdir(state.DATA_DIR)):
        item_path = os.path.join(state.DATA_DIR, item)
        if not os.path.isdir(item_path):
            continue
        if item in ('input', 'output', 'config'):
            continue
        datapackage_path = os.path.join(item_path, 'datapackage.json')
        if not os.path.exists(datapackage_path):
            continue

        try:
            with open(datapackage_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)

            import hashlib
            stored_id = datapackage.get('case_study_id')
            if stored_id:
                case_study_id = stored_id
            else:
                folder_hash = hashlib.md5(item.encode()).hexdigest()
                case_study_id = (
                    folder_hash[:8] + '-' + folder_hash[8:12] + '-' +
                    folder_hash[12:16] + '-' + folder_hash[16:20] + '-' +
                    folder_hash[20:32]
                )

            meta_path = os.path.join(item_path, 'config', 'scenario_metadata.csv')
            scenario_count = 0
            if os.path.exists(meta_path):
                with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                    scenario_count = sum(1 for _ in csv.DictReader(f))

            parts = item.rsplit('_', 1)
            title = datapackage.get('title', parts[0].replace('-', ' ').title() if parts else item)

            case_study = {
                "id":             case_study_id,
                "name":           title,
                "description":    datapackage.get('description', 'Loaded from existing folder'),
                "created_by":     (datapackage.get('contributors') or [{}])[0].get('title', 'Unknown'),
                "created_at":     datapackage.get('created', datetime.now().isoformat()),
                "scenario_count": scenario_count,
                "files":          [],
                "folder_name":    item,
                "folder_path":    item_path,
                "datapackage_path": datapackage_path,
                "enabled_categories": datapackage.get('enabled_categories', None),
                "scenarios":      [],
            }
            state.case_studies.append(case_study)
            print(f"Loaded case study: {case_study['name']} ({scenario_count} scenario(s))")

        except Exception as e:
            print(f"Error loading case study from {item}: {e}")


# ──────────────────────────────────────────────────────────────────────────────
# Endpoint handlers
# ──────────────────────────────────────────────────────────────────────────────

def health_check():
    return jsonify({"status": "healthy", "message": "Backend is running"})


def frontend_health_check():
    return jsonify({"status": "healthy", "message": "Frontend server is running"})


def serve_react_app():
    return send_from_directory(state.frontend_app.static_folder, 'index.html')


def test_route():
    return jsonify({"message": "Frontend app is working", "route": "/test-route"})


def test_endpoint():
    """Test endpoint for debugging"""
    return jsonify({
        "status": "ok",
        "message": "Frontend app is working",
        "method": request.method,
        "case_studies_count": len(state.case_studies),
        "case_studies": [{"id": cs.get("id", "no-id"), "name": cs.get("name", "no-name")} for cs in state.case_studies]
    })


def get_case_studies():
    return jsonify({"case_studies": state.case_studies})


def create_case_study():
    data = request.get_json()
    case_study_id = str(uuid.uuid4())
    case_study_name = data.get("name", "Untitled Case Study")
    case_study_description = data.get("description", "")
    created_by = data.get("created_by", "Anonymous")

    try:
        case_study_path, folder_name = create_case_study_folders(case_study_id, case_study_name)

        datapackage_path = create_datapackage_json(
            case_study_path,
            case_study_name,
            case_study_description,
            created_by
        )

        case_study = {
            "id": case_study_id,
            "name": case_study_name,
            "description": case_study_description,
            "created_by": created_by,
            "created_at": datetime.now().isoformat(),
            "scenario_count": 0,
            "folder_name": folder_name,
            "folder_path": case_study_path,
            "datapackage_path": datapackage_path
        }
        state.case_studies.append(case_study)
        return jsonify({"case_study": case_study}), 201
    except Exception as e:
        return jsonify({"error": f"Failed to create case study folders: {str(e)}"}), 500


def delete_case_study(case_study_id):
    """Delete a case study and all its associated files"""
    print(f"[DEBUG] DELETE request received for case study ID: {case_study_id}")
    print(f"[DEBUG] Request method: {request.method}")
    print(f"[DEBUG] Request headers: {dict(request.headers)}")

    try:
        case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            print(f"[DEBUG] Case study not found: {case_study_id}")
            return jsonify({"error": "Case study not found"}), 404

        print(f"[DEBUG] Found case study: {case_study.get('name', 'Unknown')}")

        folder_path = case_study.get('folder_path')
        if folder_path and os.path.exists(folder_path):
            print(f"[DEBUG] Removing folder: {folder_path}")
            shutil.rmtree(folder_path)

        state.case_studies[:] = [cs for cs in state.case_studies if cs['id'] != case_study_id]

        # Remove associated scenarios
        state.scenarios = [s for s in state.scenarios if s.get('case_study_id') != case_study_id]

        print(f"[DEBUG] Case study deleted successfully")
        return jsonify({"message": "Case study deleted successfully"}), 200
    except Exception as e:
        print(f"[DEBUG] Error deleting case study: {str(e)}")
        return jsonify({"error": f"Failed to delete case study: {str(e)}"}), 500


def upload_case_study():
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not file.filename.endswith('.zip'):
        return jsonify({"error": "File must be a ZIP archive"}), 400
    try:
        case_study = _do_zip_upload(file)
        return jsonify({"case_study": case_study, "scenarios_created": case_study["scenario_count"]}), 201
    except Exception as e:
        return jsonify({"error": f"Failed to process ZIP file: {str(e)}"}), 500


def get_case_study_datapackage(case_study_id):
    """Get the datapackage.json content for a case study (with admin_level augment)."""
    try:
        print(f"[DEBUG] Looking for case study with ID: '{case_study_id}'")
        print(f"[DEBUG] Available case studies: {[cs.get('id', 'no-id') for cs in state.case_studies]}")

        case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            print(f"[DEBUG] Case study not found for ID: '{case_study_id}'")
            return jsonify({"error": "Case study not found"}), 404

        print(f"[DEBUG] Found case study: {case_study.get('name', 'unknown')}")

        datapackage_path = os.path.join(case_study['folder_path'], 'datapackage.json')
        print(f"[DEBUG] Looking for datapackage at: {datapackage_path}")

        if os.path.exists(datapackage_path):
            with open(datapackage_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)
            try:
                geodata_dir = os.path.join(case_study['folder_path'], 'input', 'baseline', 'geodata')
                if os.path.isdir(geodata_dir):
                    shp_files = [f for f in os.listdir(geodata_dir) if f.lower().endswith('.shp')]
                    if shp_files:
                        import shapefile as sf_lib
                        sf_obj = sf_lib.Reader(os.path.join(geodata_dir, shp_files[0]))
                        fields = [f[0] for f in sf_obj.fields[1:]]
                        max_level = 0
                        for field in fields:
                            if field.upper().startswith('GID_') and field[4:].isdigit():
                                max_level = max(max_level, int(field[4:]))
                        if max_level > 0:
                            datapackage['admin_level'] = max_level
            except Exception:
                pass
            return jsonify(datapackage)
        else:
            print(f"[DEBUG] Datapackage file not found at: {datapackage_path}")
            return jsonify({"error": "Datapackage file not found"}), 404

    except Exception as e:
        print(f"[DEBUG] Exception in datapackage endpoint: {str(e)}")
        return jsonify({"error": f"Failed to read datapackage: {str(e)}"}), 500


def update_case_study_datapackage(case_study_id):
    """Update the datapackage.json content for a case study (with rename-on-disk).
    """
    try:
        case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            return jsonify({"error": "Case study not found"}), 404

        datapackage_data = request.get_json()
        if not datapackage_data:
            return jsonify({"error": "No datapackage data provided"}), 400

        datapackage_data['case_study_id'] = case_study_id

        old_datapackage_path = os.path.join(case_study['folder_path'], 'datapackage.json')
        try:
            with open(old_datapackage_path, 'r', encoding='utf-8') as f:
                old_dp = json.load(f)
        except Exception:
            old_dp = {}

        old_name = old_dp.get('name', '')
        new_name = datapackage_data.get('name', '')
        renamed_folder = None

        if new_name and new_name != old_name:
            data_dir = os.path.dirname(case_study['folder_path'])
            old_folder = case_study['folder_name']
            parts = old_folder.rsplit('_', 1)
            hash_suffix = parts[1] if len(parts) == 2 and len(parts[1]) <= 12 and parts[1].isalnum() else old_folder[-8:]
            candidate = f"{new_name}_{hash_suffix}"
            new_folder = candidate
            counter = 1
            while os.path.exists(os.path.join(data_dir, new_folder)) and new_folder != old_folder:
                new_folder = f"{candidate}_{counter}"
                counter += 1
            if new_folder != old_folder:
                new_path = os.path.join(data_dir, new_folder)
                try:
                    os.rename(case_study['folder_path'], new_path)
                    case_study['folder_name'] = new_folder
                    case_study['folder_path'] = new_path
                    case_study['datapackage_path'] = os.path.join(new_path, 'datapackage.json')
                    renamed_folder = new_folder
                    print(f"[INFO] Renamed case study folder: {old_folder} → {new_folder}")
                except OSError as rename_err:
                    print(f"[WARN] Could not rename case study folder '{old_folder}' → '{new_folder}': {rename_err}. Saving datapackage in place.")

        new_title = datapackage_data.get('title')
        if new_title:
            case_study['name'] = new_title

        datapackage_path = os.path.join(case_study['folder_path'], 'datapackage.json')
        with open(datapackage_path, 'w', encoding='utf-8') as f:
            json.dump(datapackage_data, f, indent=2, ensure_ascii=False)

        resp = {"status": "success", "message": "Datapackage updated successfully"}
        if renamed_folder:
            resp["renamed_folder"] = renamed_folder
        return jsonify(resp)

    except Exception as e:
        return jsonify({"error": f"Failed to update datapackage: {str(e)}"}), 500


def _geodata_context(cs_path):
    """Describe the case study's study area from its geodata shapefile.

    Returns admin level (max GID_n field), polygon count, the distinct
    countries covered and a short sample of area names. Any failure yields
    empty values rather than an error -- geodata is optional.
    """
    out = {'admin_level': None, 'area_count': None, 'countries': [], 'area_names_sample': []}
    shp_path = find_geodata_shapefile(cs_path, 'baseline')
    if not shp_path:
        return out
    try:
        import shapefile as sf_lib
        reader = sf_lib.Reader(shp_path)
        fields = [f[0] for f in reader.fields[1:]]

        levels = [int(f[4:]) for f in fields
                  if f.upper().startswith('GID_') and f[4:].isdigit()]
        if levels:
            out['admin_level'] = max(levels)

        records = reader.records()
        out['area_count'] = len(records)

        countries = []
        names = []
        for rec in records:
            props = dict(zip(fields, list(rec)))
            country = country_label(props)
            if country and country not in countries:
                countries.append(country)
            if len(names) < 8:
                name = area_label(props)
                if name and name not in names:
                    names.append(name)
        out['countries'] = countries
        out['area_names_sample'] = names
    except Exception:
        pass
    return out


def derive_case_study_context(case_study):
    """Assemble the descriptive context used to write a report's introduction.

    Combines editable datapackage metadata with facts derived from the
    scenario metadata CSV and the geodata shapefile.
    """
    cs_path = case_study['folder_path']

    datapackage = {}
    dp_path = os.path.join(cs_path, 'datapackage.json')
    if os.path.exists(dp_path):
        try:
            with open(dp_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)
        except Exception:
            datapackage = {}

    pathogens, ssps, years = [], [], []
    scenario_count = 0
    baseline_name = None
    meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if not row.get('scenario_id'):
                        continue
                    scenario_count += 1
                    if str(row.get('is_baseline', '')).lower() in ('true', '1', 'yes'):
                        baseline_name = row.get('name') or baseline_name
                    for value, bucket in ((row.get('pathogen'), pathogens),
                                          (row.get('ssp'), ssps),
                                          (row.get('year'), years)):
                        value = (value or '').strip()
                        if value and value not in bucket:
                            bucket.append(value)
        except Exception:
            pass

    def _year_sort(value):
        try:
            return (0, int(value))
        except (TypeError, ValueError):
            return (1, 0)

    context = {
        'case_study_id': case_study['id'],
        'title': datapackage.get('title') or case_study.get('name') or '',
        'name': datapackage.get('name') or case_study.get('folder_name') or '',
        'description': datapackage.get('description') or '',
        'version': datapackage.get('version') or '',
        'created': datapackage.get('created') or '',
        'created_by': datapackage.get('created_by') or '',
        'enabled_categories': datapackage.get('enabled_categories') or [],
        'scenario_count': scenario_count,
        'baseline_name': baseline_name,
        'pathogens': pathogens,
        'ssps': sorted(ssps),
        'years': sorted(years, key=_year_sort),
    }
    for field in _NARRATIVE_DATAPACKAGE_FIELDS:
        context[field] = datapackage.get(field) or ''
    context.update(_geodata_context(cs_path))
    return context


def get_case_study_context(case_study_id):
    """Descriptive context for a case study, used by the narrative reports."""
    case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
    if not case_study:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        return jsonify(derive_case_study_context(case_study)), 200
    except Exception as e:
        return jsonify({'error': f'Failed to derive case study context: {str(e)}'}), 500


def reload_case_studies():
    """Reload case studies from filesystem"""
    try:
        print(f"Reload endpoint called with method: {request.method}")
        load_existing_case_studies()
        print(f"Loaded {len(state.case_studies)} case studies")
        return jsonify({
            "status": "success",
            "message": f"Reloaded {len(state.case_studies)} case studies",
            "case_studies_count": len(state.case_studies),
            "method_used": request.method
        })
    except Exception as e:
        print(f"Error in reload: {str(e)}")
        return jsonify({"error": f"Failed to reload case studies: {str(e)}"}), 500


def serve_static_files(path):
    """Catch-all SPA route — MUST be registered last on frontend_app.

    Serves an on-disk static asset if the path resolves to a real file inside
    ``static_folder``; otherwise returns ``index.html`` so React Router can
    handle client-side routing. Requests that reach here under ``/api/`` are
    unregistered API endpoints — return a JSON 404 rather than the HTML shell
    so client fetch() calls fail loudly instead of parsing an HTML body.
    """
    # Reject unknown API routes early with JSON so callers don't accidentally
    # parse the index.html shell as an API response.
    if path.startswith('api/'):
        return jsonify({"error": f"Unknown API endpoint: /{path}"}), 404

    # Constrain resolution to the static folder to avoid any path-traversal
    # via ``..`` segments; ``os.path.normpath`` collapses ``..`` and we then
    # verify the resulting absolute path still lives under static_folder.
    static_root = os.path.abspath(state.frontend_app.static_folder)
    candidate = os.path.abspath(os.path.join(static_root, path))
    if candidate.startswith(static_root + os.sep) and os.path.isfile(candidate):
        return send_from_directory(state.frontend_app.static_folder, path)
    return send_from_directory(state.frontend_app.static_folder, 'index.html')


def register_routes(app, frontend_app):
    """Register all case-study routes. The SPA catch-all is added last on frontend_app."""
    # Health endpoints
    app.add_url_rule('/api/health', endpoint='main_health_check',
                     view_func=health_check, methods=['GET'])
    frontend_app.add_url_rule('/api/health', endpoint='frontend_health_check',
                              view_func=frontend_health_check, methods=['GET'])

    # SPA root + test route on frontend
    frontend_app.add_url_rule('/', endpoint='frontend_serve_react_app',
                              view_func=serve_react_app, methods=['GET'])
    frontend_app.add_url_rule('/test-route', endpoint='frontend_test_route',
                              view_func=test_route, methods=['GET'])

    # Test endpoint (was on main app only, /api/test) — keep on main only
    app.add_url_rule('/api/test', endpoint='main_test_endpoint',
                     view_func=test_endpoint, methods=['GET', 'POST'])

    # Case-study CRUD (mirrored on both apps)
    routes = [
        ('/api/case-studies',                                    ['GET'],         get_case_studies),
        ('/api/case-studies',                                    ['POST'],        create_case_study),
        ('/api/case-studies/<case_study_id>',                    ['DELETE'],      delete_case_study),
        ('/api/case-studies/upload',                             ['POST'],        upload_case_study),
        ('/api/case-studies/<case_study_id>/datapackage',        ['GET'],         get_case_study_datapackage),
        ('/api/case-studies/<case_study_id>/datapackage',        ['PUT'],         update_case_study_datapackage),
        ('/api/case-studies/<case_study_id>/context',            ['GET'],         get_case_study_context),
        ('/api/case-studies/reload',                             ['GET', 'POST'], reload_case_studies),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}_{methods[0]}',
                         view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}_{methods[0]}',
                                  view_func=view, methods=methods)

    # SPA catch-all — MUST be last on frontend_app.
    frontend_app.add_url_rule('/<path:path>', endpoint='frontend_serve_static_files',
                              view_func=serve_static_files, methods=['GET'])
