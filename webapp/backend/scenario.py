"""Scenario CRUD + isodata/treatment/geodata endpoints.

Handlers are registered without route decorators; ``register_routes`` mounts
them on both Flask apps (port 5000 and port 3000) with distinct endpoint names.
"""

import csv
import os
import shutil
import traceback
import uuid
from datetime import datetime

from flask import jsonify, request, send_file

import state
from fs_utils import (
    _resolve_data_path,
    add_scenario_to_metadata,
    generate_scenario_folder_name,
    load_csv_data_for_scenario,
    load_scenarios_from_metadata_csv,
    write_scenario_metadata_csv,
)


# ──────────────────────────────────────────────────────────────────────────────
# Reserved scenario names
# ──────────────────────────────────────────────────────────────────────────────
# Names that MUST NOT be used for scenarios because their URI encodings match
# dedicated route segments under `/scenarios/:csSlug/*` in the frontend.
# Keep in sync with `RESERVED_SCENARIO_NAMES` in
# `webapp/frontend/src/routes.js`.
RESERVED_SCENARIO_NAMES = {'_qmra', 'qmra', 'main'}


def _reserved_name_error(name):
    """Return an error message if ``name`` is reserved, else None."""
    if name is None:
        return None
    lc = str(name).strip().lower()
    if not lc:
        return None
    if lc in RESERVED_SCENARIO_NAMES:
        return f"'{name}' is a reserved scenario name; please choose another"
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Scenario folder helper
# ──────────────────────────────────────────────────────────────────────────────

def create_scenario_folder(case_study_path, folder_name, transformations=None):
    """Copy the baseline folder to a new named scenario folder inside input/.

    Args:
        case_study_path: Root of the case study directory.
        folder_name:     Name for the new scenario folder (already sanitised).
        transformations: Reserved for future data-transformation hooks.

    Returns:
        Absolute path to the newly created scenario folder.
    """
    baseline_path = os.path.join(case_study_path, 'input', 'baseline')
    scenario_path = os.path.join(case_study_path, 'input', folder_name)

    if os.path.exists(baseline_path):
        shutil.copytree(baseline_path, scenario_path)
    else:
        os.makedirs(scenario_path, exist_ok=True)

    print(f"[DEBUG] Created scenario folder: {scenario_path}")
    return scenario_path


# ──────────────────────────────────────────────────────────────────────────────
# Scenario CRUD
# ──────────────────────────────────────────────────────────────────────────────

def get_scenarios():
    """Get all scenarios or scenarios for a specific case study"""
    case_study_id = request.args.get('case_study_id')

    if case_study_id:
        case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
        if not case_study or not case_study.get('folder_path'):
            return jsonify({"scenarios": []})
        loaded = load_scenarios_from_metadata_csv(case_study['folder_path'])
        for s in loaded:
            s['case_study_id'] = case_study_id
        return jsonify({"scenarios": loaded})
    else:
        all_scenarios = []
        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if cs_path:
                loaded = load_scenarios_from_metadata_csv(cs_path)
                for s in loaded:
                    s['case_study_id'] = case_study['id']
                all_scenarios.extend(loaded)
        return jsonify({"scenarios": all_scenarios})


def create_scenario():
    """Create a new scenario folder (copy of baseline) and register it in scenario_metadata.csv."""
    from data import apply_projections_to_scenario  # late import (data.py imports nothing from us)
    try:
        data = request.get_json()
        print(f"[DEBUG] Creating scenario with data: {data}")

        case_study_id = data.get('case_study_id')
        if not case_study_id:
            return jsonify({"error": "Case study ID is required"}), 400

        case_study = next((cs for cs in state.case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            return jsonify({"error": "Case study not found"}), 404

        scenario_name       = data.get('name', 'New Scenario')
        ssp                 = data.get('ssp', '')
        pathogen            = data.get('pathogen', '')
        year                = data.get('year', '')
        notes               = data.get('notes', data.get('description', ''))
        projection_method   = data.get('projectionMethod', '')

        reserved_err = _reserved_name_error(scenario_name)
        if reserved_err:
            return jsonify({"error": reserved_err}), 400

        case_study_path = case_study['folder_path']

        raw_folder = generate_scenario_folder_name(case_study['name'], ssp, pathogen, year)
        folder_name = raw_folder
        counter = 1
        while os.path.exists(os.path.join(case_study_path, 'input', folder_name)):
            folder_name = f"{raw_folder}_{counter}"
            counter += 1

        create_scenario_folder(case_study_path, folder_name)

        projection_results = {}
        if projection_method == 'isimip' and ssp and year:
            print(f"[DEBUG] Auto-calculating projections for '{folder_name}' (ssp={ssp}, year={year})")
            projection_results = apply_projections_to_scenario(
                case_study_path, folder_name,
                ssp=ssp, year=year,
            )
            for schema, result in projection_results.items():
                if result['ok']:
                    print(f"[DEBUG] Projection OK for schema='{schema}'")
                else:
                    print(f"[WARNING] Projection failed for schema='{schema}': {result.get('error')}")

        scenario_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        scenario_entry = {
            'scenario_id':  scenario_id,
            'name':         scenario_name,
            'folder':       folder_name,
            'ssp':          ssp,
            'pathogen':     pathogen,
            'year':         str(year),
            'is_baseline':  'False',
            'notes':        notes,
            'created_at':   now,
            'updated_at':   now,
        }
        add_scenario_to_metadata(case_study_path, scenario_entry)

        case_study['scenario_count'] = case_study.get('scenario_count', 0) + 1

        new_scenario = {
            'id':           scenario_id,
            'name':         scenario_name,
            'case_study_id': case_study_id,
            'folder':       folder_name,
            'ssp':          ssp,
            'pathogen':     pathogen,
            'year':         year,
            'notes':        notes,
            'description':  notes,
            'is_baseline':  False,
            'created_at':   now,
            'updated_at':   now,
            'projection_results': projection_results,
        }

        print(f"[DEBUG] Created scenario '{scenario_name}' in folder '{folder_name}'")
        return jsonify(new_scenario), 201

    except Exception as e:
        print(f"[ERROR] Failed to create scenario: {traceback.format_exc()}")
        return jsonify({"error": f"Failed to create scenario: {str(e)}"}), 500


def update_scenario(scenario_id):
    """Update an existing scenario's metadata in scenario_metadata.csv."""
    try:
        data = request.get_json()

        # Reject reserved names before touching disk.
        if 'name' in (data or {}):
            reserved_err = _reserved_name_error(data.get('name'))
            if reserved_err:
                return jsonify({"error": reserved_err}), 400

        target_case_study = None
        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        break
            if target_case_study:
                break

        if not target_case_study:
            return jsonify({"error": "Scenario not found"}), 404

        cs_path = target_case_study['folder_path']
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')

        rows = []
        updated_row = None
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            rows = list(csv.DictReader(f))

        new_pathogen = None
        for row in rows:
            if row['scenario_id'] == scenario_id:
                row['name']        = data.get('name',       row['name'])
                row['notes']       = (data.get('notes')
                                      or data.get('description', '')
                                      or data.get('additional_notes', '')
                                      or row.get('notes', ''))
                row['ssp']         = data.get('ssp',         row.get('ssp', ''))
                row['pathogen']    = data.get('pathogen',    row.get('pathogen', ''))
                row['year']        = str(data.get('year',    row.get('year', '')))
                row['updated_at']  = datetime.now().isoformat()
                updated_row = dict(row)
                # Track if pathogen was set on a baseline so we can propagate it.
                is_baseline = row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')
                if is_baseline and row['pathogen']:
                    new_pathogen = row['pathogen']
                break

        # Propagate pathogen to non-baseline scenarios that have none set.
        if new_pathogen:
            now = datetime.now().isoformat()
            for row in rows:
                is_bl = row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')
                if not is_bl and not row.get('pathogen', '').strip():
                    row['pathogen']   = new_pathogen
                    row['updated_at'] = now

        write_scenario_metadata_csv(meta_path, rows)

        return jsonify(updated_row or {}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to update scenario: {str(e)}"}), 500


def get_scenario_isodata(scenario_id):
    """Return isodata.csv rows for a scenario, read fresh from disk."""
    try:
        target_case_study = None
        target_folder = None
        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        target_folder = row.get('folder', 'baseline')
                        break
            if target_case_study:
                break

        if not target_case_study:
            return jsonify({'error': 'Scenario not found'}), 404

        cs_path = target_case_study['folder_path']
        data = load_csv_data_for_scenario(cs_path, target_folder)
        return jsonify(data), 200

    except Exception as e:
        return jsonify({'error': f'Failed to read isodata: {str(e)}'}), 500


def get_scenario_summary(scenario_id):
    """Return the contents of summary.json for a scenario (if it exists)."""
    import json
    try:
        target_case_study = None
        target_folder = None
        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        target_folder = row.get('folder', 'baseline')
                        break
            if target_case_study:
                break

        if not target_case_study:
            return jsonify({'error': 'Scenario not found'}), 404

        cs_path = target_case_study['folder_path']
        scenario_input_path = os.path.join(cs_path, 'input', target_folder)

        summaries = []
        for cat_folder in {'human_emissions'}:
            summary_path = os.path.join(scenario_input_path, cat_folder, 'summary.json')
            if os.path.exists(summary_path):
                try:
                    with open(summary_path, 'r', encoding='utf-8') as sf:
                        data = json.load(sf)
                    if isinstance(data, list):
                        summaries.extend(data)
                    elif isinstance(data, dict):
                        inner = data.get('schemas')
                        if isinstance(inner, list):
                            summaries.extend(inner)
                        else:
                            summaries.append(data)
                except Exception:
                    pass

        return jsonify(summaries), 200

    except Exception as e:
        return jsonify({'error': f'Failed to read summary: {str(e)}'}), 500


def update_scenario_isodata(scenario_id):
    """Patch editable columns (population, fractions) in isodata.csv for a scenario."""
    try:
        data = request.get_json()
        updated_rows = data.get('rows', [])

        target_case_study = None
        target_folder = None
        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        target_folder = row.get('folder', 'baseline')
                        break
            if target_case_study:
                break

        if not target_case_study:
            return jsonify({'error': 'Scenario not found'}), 404

        cs_path = target_case_study['folder_path']
        csv_path = _resolve_data_path(cs_path, target_folder, 'isodata.csv')

        if not os.path.exists(csv_path):
            return jsonify({'error': 'isodata.csv not found'}), 404

        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames or []
            existing_rows = list(reader)

        READONLY_FIELDS = {'iso', 'gid', 'iso3', 'subarea', 'hdi'}
        for idx, upd in enumerate(updated_rows):
            if idx < len(existing_rows):
                for field, value in upd.items():
                    if field in fieldnames and field not in READONLY_FIELDS:
                        existing_rows[idx][field] = str(value)

        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(existing_rows)

        real_path = os.path.realpath(csv_path)
        print(f'[DEBUG] isodata written to: {real_path} ({len(existing_rows)} rows)')
        return jsonify({
            'message': 'isodata.csv updated',
            'rows': len(existing_rows),
            'written_path': real_path,
        }), 200

    except Exception as e:
        return jsonify({'error': f'Failed to update isodata: {str(e)}'}), 500


def clone_scenario(scenario_id):
    """Clone an existing scenario: copy its input folder and register a new metadata entry."""
    try:
        target_case_study = None
        target_row = None

        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        target_row = dict(row)
                        break
            if target_row:
                break

        if not target_row:
            return jsonify({'error': 'Scenario not found'}), 404

        data = request.get_json(silent=True) or {}
        src_name = target_row.get('name', 'Scenario')
        clone_name = data.get('name') or f"{src_name} (clone)"

        reserved_err = _reserved_name_error(clone_name)
        if reserved_err:
            return jsonify({"error": reserved_err}), 400

        cs_path = target_case_study['folder_path']
        src_folder = target_row.get('folder', '')
        src_input = os.path.join(cs_path, 'input', src_folder)

        base_dest = f"{src_folder}_clone"
        dest_folder = base_dest
        counter = 1
        while os.path.exists(os.path.join(cs_path, 'input', dest_folder)):
            dest_folder = f"{base_dest}_{counter}"
            counter += 1

        dest_input = os.path.join(cs_path, 'input', dest_folder)

        if os.path.exists(src_input):
            shutil.copytree(src_input, dest_input)
        else:
            os.makedirs(dest_input, exist_ok=True)

        new_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        scenario_entry = {
            'scenario_id': new_id,
            'name':        clone_name,
            'folder':      dest_folder,
            'ssp':         target_row.get('ssp', ''),
            'pathogen':    target_row.get('pathogen', ''),
            'year':        target_row.get('year', ''),
            'is_baseline': 'False',
            'notes':       target_row.get('notes', ''),
            'created_at':  now,
            'updated_at':  now,
        }
        add_scenario_to_metadata(cs_path, scenario_entry)
        target_case_study['scenario_count'] = target_case_study.get('scenario_count', 0) + 1

        new_scenario = {
            'id':            new_id,
            'name':          clone_name,
            'case_study_id': target_case_study['id'],
            'folder':        dest_folder,
            'ssp':           target_row.get('ssp', ''),
            'pathogen':      target_row.get('pathogen', ''),
            'year':          target_row.get('year', ''),
            'notes':         target_row.get('notes', ''),
            'description':   target_row.get('notes', ''),
            'is_baseline':   False,
            'created_at':    now,
            'updated_at':    now,
        }
        print(f"[DEBUG] Cloned scenario '{src_name}' → '{clone_name}' in folder '{dest_folder}'")
        return jsonify(new_scenario), 201

    except Exception as e:
        print(f"[ERROR] Failed to clone scenario: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to clone scenario: {str(e)}'}), 500


def delete_scenario(scenario_id):
    """Delete a non-baseline scenario: remove its folder and metadata row."""
    try:
        print(f"[DEBUG] Deleting scenario: {scenario_id}")

        target_case_study = None
        target_row = None

        for case_study in state.case_studies:
            cs_path = case_study.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row['scenario_id'] == scenario_id:
                        target_case_study = case_study
                        target_row = dict(row)
                        break
            if target_row:
                break

        if not target_row:
            return jsonify({"error": "Scenario not found"}), 404

        is_baseline = target_row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')
        if is_baseline:
            return jsonify({"error": "Cannot delete the baseline scenario"}), 400

        cs_path = target_case_study['folder_path']
        folder = target_row.get('folder', '')

        if folder:
            scenario_folder = os.path.join(cs_path, 'input', folder)
            if os.path.exists(scenario_folder):
                shutil.rmtree(scenario_folder)
                print(f"[DEBUG] Removed scenario folder: {scenario_folder}")

        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            rows = [r for r in csv.DictReader(f) if r['scenario_id'] != scenario_id]
        write_scenario_metadata_csv(meta_path, rows)

        target_case_study['scenario_count'] = max(0, target_case_study.get('scenario_count', 1) - 1)

        print(f"[DEBUG] Scenario '{target_row['name']}' deleted successfully")
        return jsonify({"message": f"Scenario '{target_row['name']}' deleted successfully"}), 200

    except Exception as e:
        print(f"[ERROR] Failed to delete scenario: {traceback.format_exc()}")
        return jsonify({"error": f"Failed to delete scenario: {str(e)}"}), 500


# ──────────────────────────────────────────────────────────────────────────────
# Treatment / geodata / fractions endpoints
# ──────────────────────────────────────────────────────────────────────────────

def get_treatment(scenario_id):
    """Return treatment.csv rows for a scenario."""
    from fs_utils import _locate_scenario
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = _resolve_data_path(cs['folder_path'], folder, 'treatment.csv')
        if not os.path.exists(csv_path):
            return jsonify({'data': [], 'fieldnames': ['lon', 'lat', 'capacity', 'treatment_type']}), 200
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or ['lon', 'lat', 'capacity', 'treatment_type'])
            data = [dict(row) for row in reader]
        return jsonify({'data': data, 'fieldnames': fieldnames}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def update_treatment(scenario_id):
    """Write rows to treatment.csv."""
    from fs_utils import _locate_scenario
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = _resolve_data_path(cs['folder_path'], folder, 'treatment.csv')
        data = request.get_json() or {}
        rows = data.get('rows', [])
        fieldnames = ['lon', 'lat', 'capacity', 'treatment_type']
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                writer.writerow({k: row.get(k, '') for k in fieldnames})
        return jsonify({'message': 'treatment.csv updated', 'rows': len(rows)}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def get_baseline_treatment(scenario_id):
    """Return the case study's baseline treatment.csv rows (WWTP facilities).

    Lets a non-baseline scenario offer "copy WWTP locations from baseline"
    even when the scenario's own treatment data was projected forward as
    area-based fractions instead (future WWTP locations are unknown, so
    projections only carry fraction data — the baseline's point locations
    are never propagated automatically).
    """
    from fs_utils import _locate_scenario
    try:
        cs, _folder = _locate_scenario(scenario_id)
        csv_path = _resolve_data_path(cs['folder_path'], 'baseline', 'treatment.csv')
        if not os.path.exists(csv_path):
            return jsonify({'data': [], 'fieldnames': [], 'is_point_mode': False}), 200
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or [])
            data = [dict(row) for row in reader]
        is_point_mode = 'lon' in fieldnames and 'lat' in fieldnames and len(data) > 0
        return jsonify({'data': data, 'fieldnames': fieldnames, 'is_point_mode': is_point_mode}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def get_geodata(scenario_id):
    """Return GeoJSON for the scenario's geodata shapefile.
    Adds an 'iso' property (1-based index) to each feature so it can be
    joined with the emissions CSV data.
    """
    from fs_utils import _locate_scenario
    try:
        cs, folder = _locate_scenario(scenario_id)
        candidate_dirs = [
            os.path.join(cs['folder_path'], 'input', folder, 'geodata'),
            os.path.join(cs['folder_path'], 'input', 'baseline', 'geodata'),
            os.path.join(cs['folder_path'], 'input', 'geodata'),
        ]
        for geodata_dir in candidate_dirs:
            if os.path.isdir(geodata_dir):
                shp_files = [f for f in os.listdir(geodata_dir) if f.lower().endswith('.shp')]
                if shp_files:
                    break
        else:
            return jsonify({'type': 'FeatureCollection', 'features': []}), 200

        shp_path = os.path.join(geodata_dir, shp_files[0])
        try:
            import shapefile as sf_lib
        except ImportError:
            return jsonify({'error': 'pyshp not installed. Run: pip install pyshp'}), 500

        sf_obj = sf_lib.Reader(shp_path)
        fields = [f[0] for f in sf_obj.fields[1:]]
        features = []
        for idx, sr in enumerate(sf_obj.shapeRecords()):
            geom = sr.shape.__geo_interface__
            props = {}
            for k, v in zip(fields, sr.record):
                if isinstance(v, bytes):
                    v = v.decode('utf-8', errors='replace').strip()
                props[k] = v
            props['iso'] = idx + 1
            features.append({'type': 'Feature', 'geometry': geom, 'properties': props})

        return jsonify({'type': 'FeatureCollection', 'features': features}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def update_treatment_fractions(scenario_id):
    """Patch or add Fraction* columns in isodata.csv.

    Body parameters:
      fractions          – {fieldName: value, …}  Always written to every row.
      init_fields        – {fieldName: value, …}  Only written when column absent.
      indexed_fractions  – list of dicts, one per row by index.
    """
    from fs_utils import _locate_scenario
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = _resolve_data_path(cs['folder_path'], folder, 'isodata.csv')
        if not os.path.exists(csv_path):
            return jsonify({'error': 'isodata.csv not found'}), 404
        data = request.get_json() or {}
        fractions         = data.get('fractions',         {})
        init_fields       = data.get('init_fields',       {})
        indexed_fractions = data.get('indexed_fractions', None)
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or [])
            rows = list(reader)
        for k in fractions:
            if k not in fieldnames:
                fieldnames.append(k)
        for row in rows:
            for k, v in fractions.items():
                row[k] = str(v)
        if indexed_fractions is not None:
            for frac_dict in indexed_fractions:
                for k in frac_dict:
                    if k not in fieldnames:
                        fieldnames.append(k)
            for i, (row, frac_dict) in enumerate(zip(rows, indexed_fractions)):
                for k, v in frac_dict.items():
                    row[k] = str(v)
        for k, v in init_fields.items():
            if k not in fieldnames:
                fieldnames.append(k)
                for row in rows:
                    row[k] = str(v)
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(rows)
        return jsonify({'message': 'Treatment fractions saved', 'rows': len(rows)}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def input_raster(scenario_id, filename):
    """Serve an input TIF raster (isoraster.tif, poprural.tif, popurban.tif) for the browser."""
    import mimetypes
    from fs_utils import _locate_scenario
    ALLOWED = {'isoraster.tif', 'poprural.tif', 'popurban.tif'}
    try:
        name = os.path.basename(filename)
        if name not in ALLOWED:
            return jsonify({'error': f'{name} not allowed'}), 400
        cs, folder = _locate_scenario(scenario_id)
        tif_path = _resolve_data_path(cs['folder_path'], folder, name)
        if not os.path.exists(tif_path):
            tif_path = _resolve_data_path(cs['folder_path'], 'baseline', name)
        if not os.path.exists(tif_path):
            return jsonify({'error': f'{name} not found'}), 404
        mime = mimetypes.guess_type(tif_path)[0] or 'image/tiff'
        return send_file(tif_path, mimetype=mime)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/scenarios',                                              ['GET'],    get_scenarios),
        ('/api/scenarios',                                              ['POST'],   create_scenario),
        ('/api/scenarios/<scenario_id>',                                ['PUT'],    update_scenario),
        ('/api/scenarios/<scenario_id>',                                ['DELETE'], delete_scenario),
        ('/api/scenarios/<scenario_id>/clone',                          ['POST'],   clone_scenario),
        ('/api/scenarios/<scenario_id>/isodata',                        ['GET'],    get_scenario_isodata),
        ('/api/scenarios/<scenario_id>/isodata',                        ['PUT'],    update_scenario_isodata),
        ('/api/scenarios/<scenario_id>/summary',                        ['GET'],    get_scenario_summary),
        ('/api/scenarios/<scenario_id>/treatment',                      ['GET'],    get_treatment),
        ('/api/scenarios/<scenario_id>/treatment',                      ['PUT'],    update_treatment),
        ('/api/scenarios/<scenario_id>/baseline-treatment',             ['GET'],    get_baseline_treatment),
        ('/api/scenarios/<scenario_id>/geodata',                        ['GET'],    get_geodata),
        ('/api/scenarios/<scenario_id>/treatment-fractions',            ['PUT'],    update_treatment_fractions),
        ('/api/scenarios/<scenario_id>/input-raster/<path:filename>',   ['GET'],    input_raster),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}_{methods[0]}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}_{methods[0]}', view_func=view, methods=methods)
