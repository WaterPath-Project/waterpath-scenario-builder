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
from fs_utils import create_baseline_metadata_entry


# ──────────────────────────────────────────────────────────────────────────────
# Filesystem helpers
# ──────────────────────────────────────────────────────────────────────────────

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


def _do_zip_upload(file):
    """Shared implementation for processing a ZIP-file case-study upload."""
    with tempfile.TemporaryDirectory() as temp_dir:
        zip_path = os.path.join(temp_dir, file.filename)
        file.save(zip_path)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        baseline_src = os.path.join(temp_dir, 'baseline')
        if not os.path.isdir(baseline_src):
            baseline_src = temp_dir

        enabled_categories = [
            cat_id
            for cat_id, folder_name in state.CATEGORY_FOLDER_MAP.items()
            if os.path.isdir(os.path.join(baseline_src, folder_name))
        ]
        print(f"[DEBUG] Detected enabled categories: {enabled_categories}")

        case_study_id = str(uuid.uuid4())
        case_study_name = os.path.splitext(file.filename)[0]

        case_study_path, folder_name = create_case_study_folders(case_study_id, case_study_name)
        baseline_path = os.path.join(case_study_path, 'input', 'baseline')

        files_copied = []
        has_isodata = False

        for root, dirs, files_in_dir in os.walk(baseline_src):
            for f in files_in_dir:
                src_file = os.path.join(root, f)

                if os.path.abspath(src_file) == os.path.abspath(zip_path):
                    continue

                rel_path = os.path.relpath(src_file, baseline_src)

                rel_parts = rel_path.split(os.sep)
                rel_parts[-1] = state.RASTER_RENAME_MAP.get(rel_parts[-1].lower(), rel_parts[-1])
                rel_path = os.path.join(*rel_parts)

                dest_file = os.path.join(baseline_path, rel_path)
                os.makedirs(os.path.dirname(dest_file), exist_ok=True)
                shutil.copy2(src_file, dest_file)
                files_copied.append(rel_path)

                if rel_parts[-1].lower() == 'isodata.csv':
                    has_isodata = True

        csv_files = [p for p in files_copied if p.lower().endswith('.csv')]
        datapackage_path = create_datapackage_json(
            case_study_path,
            case_study_name,
            f"Imported from {file.filename}",
            created_by="Upload User",
            csv_files=[os.path.basename(p) for p in csv_files],
            enabled_categories=enabled_categories if enabled_categories else None,
        )

        case_study = {
            "id": case_study_id,
            "name": case_study_name,
            "description": f"Imported from {file.filename} — {len(files_copied)} files",
            "created_at": datetime.now().isoformat(),
            "scenario_count": 1 if has_isodata else 0,
            "files": files_copied,
            "folder_name": folder_name,
            "folder_path": case_study_path,
            "datapackage_path": datapackage_path,
            "enabled_categories": enabled_categories if enabled_categories else None,
            "scenarios": [],
        }
        state.case_studies.append(case_study)

        if has_isodata:
            create_baseline_metadata_entry(case_study_path)
        else:
            print(f"[WARN] No isodata.csv found in {file.filename}; baseline entry not created.")

        print(f"[DEBUG] Imported case study '{case_study_name}' — {len(files_copied)} files copied to baseline/")
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
    """Catch-all SPA route — MUST be registered last on frontend_app."""
    print(f"[DEBUG] Catch-all route hit with path: '{path}'")
    print(f"[DEBUG] Static folder: '{state.frontend_app.static_folder}'")
    full_path = os.path.join(state.frontend_app.static_folder, path)
    print(f"[DEBUG] Checking if file exists: '{full_path}'")
    if os.path.exists(full_path):
        print(f"[DEBUG] File exists, serving: '{path}'")
        return send_from_directory(state.frontend_app.static_folder, path)
    else:
        print(f"[DEBUG] File doesn't exist, serving index.html for SPA routing")
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
