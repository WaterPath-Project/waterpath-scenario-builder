"""Communication with the WaterPath Data API: projection downloads and
livestock-aware unzipping into the scenario folder layout.
"""

import io
import json
import os
import zipfile

import requests

from state import (
    CATEGORY_FOLDER_MAP,
    PROJECTION_API_TIMEOUT,
    RASTER_RENAME_MAP,
    WATERPATH_DATA_API_URL,
    _LIVESTOCK_ROOT_FILES,
    _SCHEMA_CATEGORY_MAP,
)
from hydrology import _detect_hydrology_module


def _livestock_subpath_for_file(base_name):
    """Return the sub-path (relative to scenario_input_path) where a file
    returned by the projections API zip should be written, based on its name.
    """
    name_lo = base_name.lower()
    if name_lo.endswith('_heads.tif'):
        return 'livestock_emissions/animals'
    if name_lo.startswith('isodata_') and name_lo.endswith('.csv'):
        return 'livestock_emissions/animals'
    if base_name in _LIVESTOCK_ROOT_FILES:
        return 'livestock_emissions'
    return None


def apply_projections_to_scenario(case_study_path, folder_name, ssp, year, schemas=None):
    """Call the WaterPath Data API and apply the returned files to a scenario."""
    if schemas is None:
        schemas = ['population', 'sanitation']
        if _detect_hydrology_module(case_study_path, folder_name):
            schemas.append('hydrology')

    ssp_str = str(ssp).strip()
    if not ssp_str.upper().startswith('SSP'):
        ssp_str = f"SSP{ssp_str}"

    scenario_input_path = os.path.join(case_study_path, 'input', folder_name)
    results = {}

    isodata_to_schemas = {}
    isodata_to_cat_folder = {}
    for schema in schemas:
        cat_folder = _SCHEMA_CATEGORY_MAP.get(schema, 'human_emissions')
        isodata_path = os.path.join(scenario_input_path, cat_folder, 'isodata.csv')
        isodata_to_schemas.setdefault(isodata_path, []).append(schema)
        isodata_to_cat_folder[isodata_path] = cat_folder

    for isodata_path, schema_group in isodata_to_schemas.items():
        cat_folder = isodata_to_cat_folder[isodata_path]

        if not os.path.exists(isodata_path):
            for schema in schema_group:
                results[schema] = {
                    'ok': False,
                    'error': f"isodata.csv not found at {isodata_path}",
                    'summary': None,
                }
                print(f"[WARNING] Projection skipped for schema='{schema}': isodata.csv missing")
            continue

        url = f"{WATERPATH_DATA_API_URL}/data/projections/download"
        livestock_path = os.path.join(scenario_input_path, 'livestock_emissions')
        has_livestock = os.path.isdir(livestock_path)
        needs_hydrology = 'hydrology' in schema_group
        if has_livestock and needs_hydrology:
            api_schema = 'all'
        elif has_livestock:
            api_schema = 'human_emissions,livestock_emissions'
        elif needs_hydrology:
            api_schema = 'human_emissions,hydrology'
        else:
            api_schema = 'human_emissions'
        params = {'schema': api_schema, 'year': int(year), 'ssp': ssp_str}

        print(f"[DEBUG] Calling projections API: POST {url} params={params} schemas={schema_group}")
        try:
            with open(isodata_path, 'rb') as f:
                resp = requests.post(
                    url,
                    params=params,
                    files={'file': ('isodata.csv', f, 'text/csv')},
                    timeout=PROJECTION_API_TIMEOUT,
                )

            if resp.status_code != 200:
                for schema in schema_group:
                    results[schema] = {
                        'ok': False,
                        'error': f"API returned {resp.status_code}: {resp.text[:500]}",
                        'summary': None,
                    }
                print(f"[WARNING] Projection API error for schemas={schema_group}: {resp.text[:500]}")
                continue

            target_dir = os.path.join(scenario_input_path, cat_folder)
            summary_data = None
            _PROJECTION_SKIP_FILES = {'treatment.csv'}

            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                for member in zf.infolist():
                    if member.is_dir():
                        continue
                    safe_parts = [
                        p for p in member.filename.replace('\\', '/').split('/')
                        if p and p != '..'
                    ]
                    if not safe_parts:
                        continue
                    base_name = safe_parts[-1]
                    if not base_name:
                        continue
                    if base_name in _PROJECTION_SKIP_FILES:
                        print(f"[DEBUG] Skipping projection zip entry '{base_name}' (protected baseline file)")
                        continue
                    zip_safe_rel = '/'.join(safe_parts)

                    matched_cat = next(
                        (cat for cat in CATEGORY_FOLDER_MAP.values()
                         if zip_safe_rel.startswith(cat + '/')),
                        None,
                    )
                    if matched_cat or zip_safe_rel.startswith('hydrology/'):
                        dest_dir = os.path.join(scenario_input_path, *safe_parts[:-1])
                    else:
                        ls_sub = _livestock_subpath_for_file(base_name)
                        dest_dir = (
                            os.path.join(scenario_input_path, ls_sub)
                            if ls_sub
                            else target_dir
                        )

                    dest_name = RASTER_RENAME_MAP.get(base_name, base_name)
                    dest_path = os.path.join(dest_dir, dest_name)

                    scenario_abs = os.path.realpath(scenario_input_path)
                    if not os.path.realpath(dest_path).startswith(scenario_abs + os.sep):
                        print(f"[WARNING] Skipping unsafe zip entry: {member.filename!r}")
                        continue

                    os.makedirs(dest_dir, exist_ok=True)
                    with zf.open(member) as src, open(dest_path, 'wb') as dst:
                        dst.write(src.read())
                    if base_name == 'summary.json':
                        try:
                            with open(dest_path, 'r', encoding='utf-8') as sf:
                                summary_data = json.load(sf)
                        except Exception:
                            pass

            print(f"[DEBUG] Projection applied for schemas={schema_group} → {target_dir}")
            for schema in schema_group:
                results[schema] = {'ok': True, 'error': None, 'summary': summary_data}

        except Exception as exc:
            for schema in schema_group:
                results[schema] = {'ok': False, 'error': str(exc), 'summary': None}
            print(f"[WARNING] Projection exception for schemas={schema_group}: {exc}")

    return results
