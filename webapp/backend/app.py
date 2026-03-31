from flask import Flask, jsonify, send_from_directory, send_file, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import os
import requests
import threading
import uuid
import zipfile
import json
import shutil
import struct
import subprocess
import docker
import csv
import io
import sys
import socket
import tempfile
import traceback
from datetime import datetime

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Initialize Docker client
try:
    docker_client = docker.from_env()
    docker_available = True
except Exception as e:
    print(f"Warning: Could not connect to Docker: {e}")
    docker_client = None
    docker_available = False

# Base data directory path (relative to project root)
# Check if running in Docker container
if os.path.exists('/app/data'):
    # Running in Docker container - use the mounted volume
    DATA_DIR = '/app/data'
else:
    # Running locally - use relative path
    DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'data'))

# External WaterPath Data API (projections, etc.)
WATERPATH_DATA_API_URL = os.environ.get(
    'WATERPATH_DATA_API_URL', 'https://dev.waterpath.venthic.com/api'
).rstrip('/')
# The projection endpoint fetches live data from GitHub and does heavy computation;
# allow more time than the default requests timeout. Override via env var if needed.
PROJECTION_API_TIMEOUT = int(os.environ.get('PROJECTION_API_TIMEOUT', '600'))

# Mapping from frontend category id → expected sub-folder name inside baseline/
CATEGORY_FOLDER_MAP = {
    'human-emissions':      'human_emissions',
    'livestock-emissions':  'livestock_emissions',
    'concentrations':       'concentrations',
    'risk':                 'risk',
}

# Incoming raster filenames that must be normalised when copied into baseline/
RASTER_RENAME_MAP = {
    'pop_urban.tif': 'popurban.tif',
    'pop_rural.tif': 'poprural.tif',
}


def create_datapackage_json(case_study_path, case_study_name, case_study_description, created_by, csv_files=None, enabled_categories=None):
    """Create a datapackage.json file with case study metadata and CSV file references"""
    csv_files = csv_files or []
    
    # Create datapackage metadata
    datapackage = {
        "name": case_study_name.lower().replace(" ", "-").replace("_", "-"),
        "title": case_study_name,
        "description": case_study_description,
        "version": "1.0.0",
        "created": datetime.now().isoformat(),
        "created_by": created_by,
        "resources": []
    }

    # Store which categories are enabled (None means "all", i.e. no restriction)
    if enabled_categories is not None:
        datapackage["enabled_categories"] = enabled_categories
    
    # Add CSV files as resources
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
    
    # Save datapackage.json
    datapackage_path = os.path.join(case_study_path, 'datapackage.json')
    with open(datapackage_path, 'w', encoding='utf-8') as f:
        json.dump(datapackage, f, indent=2, ensure_ascii=False)
    
    return datapackage_path

def create_case_study_folders(case_study_id, case_study_name):
    """Create the folder structure for a case study"""
    # Create a safe folder name from the case study name and ID
    safe_name = "".join(c for c in case_study_name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    folder_name = f"{safe_name}_{case_study_id[:8]}"
    
    case_study_path = os.path.join(DATA_DIR, folder_name)
    
    # Create the main case study folder and subdirectories
    os.makedirs(os.path.join(case_study_path, 'input'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'output'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'config'), exist_ok=True)
    os.makedirs(os.path.join(case_study_path, 'input', 'baseline'), exist_ok=True)

    return case_study_path, folder_name

# ──────────────────────────────────────────────────────────────────────────────
# Scenario metadata helpers
# ──────────────────────────────────────────────────────────────────────────────

# Canonical column order for scenario_metadata.csv
SCENARIO_METADATA_FIELDS = [
    'scenario_id', 'name', 'folder', 'ssp', 'pathogen', 'year',
    'is_baseline', 'notes', 'created_at', 'updated_at'
]


def write_scenario_metadata_csv(metadata_path, rows):
    """(Over)write scenario_metadata.csv with the given rows list."""
    with open(metadata_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=SCENARIO_METADATA_FIELDS, extrasaction='ignore')
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, '') for field in SCENARIO_METADATA_FIELDS})


def add_scenario_to_metadata(case_study_path, scenario_entry):
    """Append one scenario entry to the case study's scenario_metadata.csv."""
    config_dir = os.path.join(case_study_path, 'config')
    os.makedirs(config_dir, exist_ok=True)
    metadata_path = os.path.join(config_dir, 'scenario_metadata.csv')

    rows = []
    if os.path.exists(metadata_path):
        with open(metadata_path, 'r', newline='', encoding='utf-8') as f:
            rows = list(csv.DictReader(f))

    rows.append(scenario_entry)
    write_scenario_metadata_csv(metadata_path, rows)
    return metadata_path


def create_baseline_metadata_entry(case_study_path):
    """Write the baseline row into scenario_metadata.csv."""
    baseline_entry = {
        'scenario_id': str(uuid.uuid4()),
        'name': 'Baseline',
        'folder': 'baseline',
        'ssp': '',
        'pathogen': '',
        'year': '',
        'is_baseline': 'True',
        'notes': 'Baseline scenario imported from ZIP file',
        'created_at': datetime.now().isoformat(),
        'updated_at': datetime.now().isoformat(),
    }
    add_scenario_to_metadata(case_study_path, baseline_entry)
    return baseline_entry


def _slugify(value):
    """Lowercase slug: non-alphanumeric runs → underscore, trim edges."""
    import re
    return re.sub(r'[^a-z0-9]+', '_', str(value).lower().strip()).strip('_')


def generate_scenario_folder_name(case_study_name, ssp, pathogen, year):
    """Return a deterministic folder name, e.g. west_athens_ssp3_rotavirus_2050."""
    safe_cs = _slugify(case_study_name) or 'study'
    # Normalise SSP: accept '3', 'SSP3', 'ssp3' → 'ssp3'
    ssp_str = str(ssp).strip()
    if not ssp_str.lower().startswith('ssp'):
        ssp_str = f"ssp{ssp_str}"
    safe_ssp = _slugify(ssp_str) or 'ssp'
    safe_pathogen = _slugify(pathogen) or 'unknown'
    safe_year = _slugify(year) or 'xxxx'
    return f"{safe_cs}_{safe_ssp}_{safe_pathogen}_{safe_year}"


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

    # TODO: apply data transformations once the interface is defined
    # if transformations:
    #     apply_transformations(scenario_path, transformations)

    print(f"[DEBUG] Created scenario folder: {scenario_path}")
    return scenario_path


# Mapping from projection schema → category sub-folder inside input/<scenario>/
_SCHEMA_CATEGORY_MAP = {
    'population':  'human_emissions',
    'sanitation':  'human_emissions',
    'treatment':   'human_emissions',
}


def _livestock_subpath_for_file(base_name):
    """Return the sub-path (relative to scenario_input_path) where a file
    returned by the projections API zip should be written, based on its name.

    Returns one of:
      'livestock_emissions/animals'  – per-animal heads rasters and isodata
      'livestock_emissions'          – livestock root files
      None                           – not a livestock file; use default cat_folder
    """
    name_lo = base_name.lower()
    # {animal}_heads.tif  →  livestock_emissions/animals/
    if name_lo.endswith('_heads.tif'):
        return 'livestock_emissions/animals'
    # isodata_{animal}.csv  →  livestock_emissions/animals/
    if name_lo.startswith('isodata_') and name_lo.endswith('.csv'):
        return 'livestock_emissions/animals'
    # Known livestock root-level files  →  livestock_emissions/
    if base_name in _LIVESTOCK_ROOT_FILES:
        return 'livestock_emissions'
    return None


def apply_projections_to_scenario(case_study_path, folder_name, ssp, year, schemas=None):
    """Call the external WaterPath Data API to auto-calculate projections and
    apply the returned files to an already-created scenario folder.

    Schemas are grouped by their shared ``isodata.csv`` path. When multiple
    schemas (e.g. ``population`` + ``sanitation``) use the same file, a single
    API call is made with ``schema='all'`` so the server returns projections for
    both in one response. Steps per unique isodata.csv:
      1. Locate the ``isodata.csv`` inside the scenario folder.
      2. POST to ``WATERPATH_DATA_API_URL/data/projections/download`` with
         ``schema='all'``.
      3. Extract the returned zip into the category sub-folder of the scenario,
         renaming raster files according to ``RASTER_RENAME_MAP``.
      4. Return per-schema result dicts with keys ``ok``, ``error``, ``summary``.

    Args:
        case_study_path: Root of the case study directory.
        folder_name:     Scenario folder name (already created before this call).
        ssp:             SSP string, e.g. ``'1'``, ``'SSP3'``.
        year:            Projection year, e.g. ``2050``.
        schemas:         List of schema names to project. Defaults to
                         ``['population']``.

    Returns:
        dict mapping each schema name to a result dict.
    """
    if schemas is None:
        schemas = ['population', 'sanitation']

    # Normalise SSP: '1', 'ssp1', 'SSP1' → 'SSP1'
    ssp_str = str(ssp).strip()
    if not ssp_str.upper().startswith('SSP'):
        ssp_str = f"SSP{ssp_str}"

    scenario_input_path = os.path.join(case_study_path, 'input', folder_name)
    results = {}

    # Group schemas by their shared isodata.csv path so that schemas using the
    # same file (e.g. population + sanitation both under human_emissions) are
    # covered by a single API call with schema='all'.
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
        # Use 'all' only when the baseline has livestock data; otherwise
        # request only 'human_emissions' to avoid unnecessary work.
        livestock_path = os.path.join(scenario_input_path, 'livestock_emissions')
        api_schema = 'all' if os.path.isdir(livestock_path) else 'human_emissions'
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

            # Extract the returned zip, routing files to their correct category
            # sub-folder.  The API may return a flat zip (all files at the root)
            # or a structured zip (files under livestock_emissions/animals/ etc.).
            # Strategy:
            #   1. If a zip entry already carries a recognised category path
            #      (e.g. livestock_emissions/animals/cattle_heads.tif), preserve it.
            #   2. Otherwise route by filename pattern via _livestock_subpath_for_file.
            #   3. Unrecognised flat files fall back to target_dir (human_emissions).
            target_dir = os.path.join(scenario_input_path, cat_folder)
            summary_data = None

            # Files from the projection zip that must never overwrite the baseline copy.
            # treatment.csv in the baseline is WWTP point-source data (lon/lat/capacity/
            # treatment_type).  The projection API returns a GID-fraction table under the
            # same name — an incompatible schema that would break GloWPa if written.
            _PROJECTION_SKIP_FILES = {'treatment.csv'}

            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                for member in zf.infolist():
                    if member.is_dir():
                        continue
                    # Sanitise path: normalise separators, drop empty/traversal parts
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

                    # Determine destination directory
                    matched_cat = next(
                        (cat for cat in CATEGORY_FOLDER_MAP.values()
                         if zip_safe_rel.startswith(cat + '/')),
                        None,
                    )
                    if matched_cat:
                        # Zip already has full category structure – preserve it
                        dest_dir = os.path.join(
                            scenario_input_path,
                            *safe_parts[:-1],
                        )
                    else:
                        ls_sub = _livestock_subpath_for_file(base_name)
                        dest_dir = (
                            os.path.join(scenario_input_path, ls_sub)
                            if ls_sub
                            else target_dir
                        )

                    dest_name = RASTER_RENAME_MAP.get(base_name, base_name)
                    dest_path = os.path.join(dest_dir, dest_name)

                    # Security: ensure resolved path stays within scenario_input_path
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


# ──────────────────────────────────────────────────────────────────────────────
# Data loading helpers
# ──────────────────────────────────────────────────────────────────────────────

def load_csv_data_for_scenario(case_study_path, folder, legacy_csv_file=None):
    """Load isodata.csv from input/<folder>/ (new format), checking category
    sub-folders when the file is not at the top level.

    Falls back to loading from input/<legacy_csv_file> for old-format case
    studies that stored scenarios as flat CSV files.
    """
    if folder:
        csv_path = _resolve_data_path(case_study_path, folder, 'isodata.csv')
        print(f"[DEBUG] Loading CSV data from: {csv_path}")
        if os.path.exists(csv_path):
            try:
                with open(csv_path, 'r', newline='', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    fieldnames = reader.fieldnames or []
                    data = [dict(row) for row in reader]
                print(f"[DEBUG] Loaded {len(data)} rows")
                return {"data": data, "fieldnames": fieldnames}
            except Exception as e:
                print(f"[DEBUG] Error loading CSV: {e}")

    # Legacy fallback: flat file in input/
    if legacy_csv_file:
        csv_path = os.path.join(case_study_path, 'input', legacy_csv_file)
        if os.path.exists(csv_path):
            try:
                with open(csv_path, 'r', newline='', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    fieldnames = reader.fieldnames or []
                    data = [dict(row) for row in reader]
                print(f"[DEBUG] Loaded {len(data)} rows (legacy path)")
                return {"data": data, "fieldnames": fieldnames}
            except Exception as e:
                print(f"[DEBUG] Error loading legacy CSV: {e}")

    print(f"[DEBUG] No CSV data found for folder='{folder}' legacy='{legacy_csv_file}'")
    return {"data": [], "fieldnames": []}


def load_scenarios_from_metadata_csv(case_study_path):
    """Load all scenarios from config/scenario_metadata.csv.

    Supports both the current format (with 'folder' column) and the legacy
    format (with 'csv_file' column).
    """
    metadata_path = os.path.join(case_study_path, 'config', 'scenario_metadata.csv')
    scenarios_list = []

    print(f"[DEBUG] Loading scenarios from: {metadata_path}")

    if not os.path.exists(metadata_path):
        print(f"[DEBUG] Metadata file not found")
        return scenarios_list

    with open(metadata_path, 'r', newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        fieldnames = reader.fieldnames or []
        rows = list(reader)

    # Detect format: new format has 'folder'; old format has 'csv_file'
    is_legacy = 'folder' not in fieldnames and 'csv_file' in fieldnames

    for row in rows:
        if is_legacy:
            csv_file = row.get('csv_file', '')
            # The baseline is isodata.csv or the csv_file named 'isodata'
            is_baseline = csv_file in ('isodata', 'isodata.csv') or csv_file.startswith('isodata')
            folder = 'baseline' if is_baseline else ''
            legacy_csv = None if is_baseline else csv_file
            notes = row.get('description', '') or row.get('additional_notes', '')
        else:
            folder = row.get('folder', 'baseline')
            is_baseline = row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')
            legacy_csv = None
            notes = row.get('notes', '')

        scenario = {
            'id':            row['scenario_id'],
            'name':          row['name'],
            'case_study_id': '',   # filled by calling endpoint
            'folder':        folder,
            'is_baseline':   is_baseline,
            'ssp':           row.get('ssp', ''),
            'pathogen':      row.get('pathogen', ''),
            'year':          row.get('year', ''),
            'notes':         notes,
            'description':   notes,
            'created_at':    row.get('created_at', ''),
            'updated_at':    row.get('updated_at', ''),
            'data':          load_csv_data_for_scenario(case_study_path, folder, legacy_csv),
        }
        scenarios_list.append(scenario)
        print(f"[DEBUG] Loaded scenario '{scenario['name']}' (folder='{folder}', legacy={is_legacy})")

    print(f"[DEBUG] Total scenarios loaded: {len(scenarios_list)}")
    return scenarios_list

# ──────────────────────────────────────────────────────────────────────────────
# Analytics / model-run helpers
# ──────────────────────────────────────────────────────────────────────────────

# Files that must be present in input/<folder>/ to run the model
ANALYTICS_REQUIRED_FILES = ['isodata.csv', 'isoraster.tif', 'poprural.tif', 'popurban.tif']
ANALYTICS_OPTIONAL_FILES = ['treatment.csv']


def _resolve_data_path(cs_path, folder, filename):
    """Return the canonical disk path for *filename* inside a scenario folder.

    Search order:
      1. input/<folder>/<filename>          (flat / legacy layout)
      2. input/<folder>/<cat_folder>/<filename>  for each category sub-folder
         (new category-based layout from uploaded zips)

    For .RDS files (generated at runtime beside their .csv counterpart) the
    corresponding .csv is located first and the .RDS path is derived from it,
    since the .RDS may not exist on disk yet.

    For write operations the returned path may not exist yet — callers are
    responsible for creating parent directories when needed.
    """
    # For .RDS files derive location from the corresponding .csv
    if filename.lower().endswith('.rds'):
        csv_name = filename[:-4] + '.csv'
        csv_path = _resolve_data_path(cs_path, folder, csv_name)
        return os.path.splitext(csv_path)[0] + '.RDS'

    direct = os.path.join(cs_path, 'input', folder, filename)
    if os.path.exists(direct):
        return direct
    for cat_folder in CATEGORY_FOLDER_MAP.values():
        candidate = os.path.join(cs_path, 'input', folder, cat_folder, filename)
        if os.path.exists(candidate):
            return candidate
    # Fall back to the direct path (used as the target for new file creation)
    return direct


def check_scenario_readiness(case_study_path, folder, pathogen):
    """Return a readiness dict for a scenario.

    Required files (must be present to run):
      isodata.csv, isoraster.tif, poprural.tif, popurban.tif

    Note: isodata.csv / treatment.csv are *automatically* converted to .RDS
    by the backend before the first run — the user never has to do this.
    The pathogen is taken from scenario metadata (not a file requirement).
    """
    missing = []
    present = []
    for fname in ANALYTICS_REQUIRED_FILES:
        if os.path.exists(_resolve_data_path(case_study_path, folder, fname)):
            present.append(fname)
        else:
            missing.append(fname)
    optional_present = [
        f for f in ANALYTICS_OPTIONAL_FILES
        if os.path.exists(_resolve_data_path(case_study_path, folder, f))
    ]
    # geodata sub-folder: check direct path then category sub-folders
    input_path = os.path.join(case_study_path, 'input', folder)
    geodata_dir = os.path.join(input_path, 'geodata')
    if not os.path.isdir(geodata_dir):
        for cat_folder in CATEGORY_FOLDER_MAP.values():
            candidate = os.path.join(input_path, cat_folder, 'geodata')
            if os.path.isdir(candidate):
                geodata_dir = candidate
                break
    has_geodata = (
        os.path.isdir(geodata_dir)
        and any(f.lower().endswith('.shp') for f in os.listdir(geodata_dir))
    ) if os.path.isdir(geodata_dir) else False
    # Pathogen is scenario metadata — not a file requirement, but we warn if absent
    has_pathogen = bool(pathogen and str(pathogen).strip())
    return {
        'ready': len(missing) == 0 and has_pathogen,
        'missing_files': missing,
        'present_files': present,
        'optional_files': optional_present,
        'has_geodata': has_geodata,
        'has_pathogen': has_pathogen,
    }


# Docker image used for one-shot docker run fallback
GLOWPA_IMAGE = 'docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1'


def generate_yaml_content(folder, pathogen, flat=False, cs_path=None, wwtp_mode='POINT'):
    """Return a YAML config string for glowpa_init().

    glowpa reads isodata and wwtp via readRDS(), so the YAML references .RDS
    files which are auto-generated by the CSV→RDS prep step.

    wwtp_mode='POINT'  — WWTP locations in treatment.RDS; input.wwtp is included.
    wwtp_mode='AREA'   — Treatment fractions already in isodata.RDS columns;
                         input.wwtp line is omitted and wwtp.treatment is AREA.

    flat=False  (docker exec mode, default)
        Working directory is set to the case study root before glowpa_init,
        so paths are relative to that: input/<folder>/isodata.RDS etc.

    flat=True   (docker run mode)
        The scenario input dir is mounted at /app/input, output at /app/output,
        config at /app/config. Paths are flat: input/isodata.RDS etc.

    cs_path: when supplied, each input file is resolved through _resolve_data_path
        so category sub-folders (e.g. human_emissions/) are transparently handled.
    """
    p = (pathogen or 'unknown').lower().strip()
    slug = folder
    ls = _detect_livestock_module(cs_path, folder) if cs_path else None

    if flat:
        out_dir  = 'output'
        log_file = 'output/glowpa.log'

        def inp_path(fname):
            """Path relative to /app/input (the mount point)."""
            if cs_path:
                full = _resolve_data_path(cs_path, folder, fname)
                base = os.path.join(cs_path, 'input', folder)
                rel  = os.path.relpath(full, base).replace(os.sep, '/')
                return f'input/{rel}'
            return f'input/{fname}'

        def ls_path(sub):
            """YAML path for a file relative to livestock_emissions/."""
            abs_p = os.path.join(ls['dir'], sub)
            base  = os.path.join(cs_path, 'input', folder)
            return 'input/' + os.path.relpath(abs_p, base).replace(os.sep, '/')
    else:
        out_dir  = f'output/{folder}'
        log_file = f'output/{folder}/glowpa.log'

        def inp_path(fname):
            """Path relative to the case-study root."""
            if cs_path:
                full = _resolve_data_path(cs_path, folder, fname)
                return os.path.relpath(full, cs_path).replace(os.sep, '/')
            return f'input/{folder}/{fname}'

        def ls_path(sub):
            """YAML path for a file relative to livestock_emissions/."""
            abs_p = os.path.join(ls['dir'], sub)
            return os.path.relpath(abs_p, cs_path).replace(os.sep, '/')

    # ── Livestock input section ───────────────────────────────────────────────
    livestock_input_yaml = ''
    if ls:
        if ls['has_manure_management']:
            livestock_input_yaml += (
                f"  manure:\n"
                f"    management_systems: {ls_path('manure_management.RDS')}\n"
            )
        if ls['temperature_tif']:
            temp_sub = os.path.relpath(ls['temperature_tif'], ls['dir']).replace(os.sep, '/')
            livestock_input_yaml += (
                f"  temperature:\n"
                f"    year: {ls_path(temp_sub)}\n"
            )
        ls_subtree = ''
        if ls['has_animal_isoraster']:
            ls_subtree += f"    animal_isoraster: {ls_path('animal_isoraster.tif')}\n"
        if ls['has_production_systems']:
            ls_subtree += f"    production_systems: {ls_path('production_systems.RDS')}\n"
        if ls['has_manure_fractions']:
            ls_subtree += f"    manure_fractions: {ls_path('manure_fractions.RDS')}\n"
        if ls['animals']:
            ls_subtree += "    animals:\n"
            for animal, info in ls['animals'].items():
                if info['has_isodata'] and info['has_heads']:
                    ls_subtree += (
                        f"      {animal}:\n"
                        f"        isodata: {ls_path(f'animals/isodata_{animal}.RDS')}\n"
                        f"        heads: {ls_path(f'animals/{animal}_heads.tif')}\n"
                    )
        if ls_subtree:
            livestock_input_yaml += f"  livestock:\n{ls_subtree}"

    livestock_option_yaml = "livestock:\n  enabled: TRUE\n" if ls else ""
    livestock_output_yaml = (
        f"    livestock:\n"
        f"      land: livestock_sources_land_{p}_{slug}.csv\n"
        f"      surface_water: livestock_sources_water_{p}_{slug}.csv\n"
    ) if ls else ""

    return (
        f"logger:\n"
        f"  enabled: TRUE\n"
        f"  threshold: INFO\n"
        f"  file: {log_file}\n"
        f"  appender: TEE\n"
        f"input:\n"
        f"  isoraster: {inp_path('isoraster.tif')}\n"
        f"  isodata: {inp_path('isodata.RDS')}\n"
        + (f"  wwtp: {inp_path('treatment.RDS')}\n" if wwtp_mode == 'POINT' else "")
        + f"  population:\n"
        f"    urban: {inp_path('popurban.tif')}\n"
        f"    rural: {inp_path('poprural.tif')}\n"
        + livestock_input_yaml
        + f"wwtp:\n"
        f"  treatment: {wwtp_mode}\n"
        + livestock_option_yaml
        + f"population:\n"
        f"  correct: TRUE\n"
        f"pathogen: {p}\n"
        f"output:\n"
        f"  dir: {out_dir}\n"
        f"  sources:\n"
        f"    human:\n"
        f"      land: human_sources_land_{p}_{slug}.csv\n"
        f"      surface_water: human_sources_water_{p}_{slug}.csv\n"
        + livestock_output_yaml
        + f"  sinks:\n"
        f"    surface_water:\n"
        f"      table: surface_water_emissions_{p}_{slug}.csv\n"
        f"      grid: surface_water_emissions_{p}_{slug}.tif\n"
        f"    land:\n"
        f"      table: land_emissions_{p}_{slug}.csv\n"
        f"      grid: land_emissions_{p}_{slug}.tif\n"
        f"constants:\n"
        f"  runoff_fraction: 0.025\n"
        f"  threshold_discharge: 1\n"
    )


def _detect_wwtp_mode(cs_path, folder):
    """Return 'AREA' if treatment.csv contains fraction columns (FractionPrimarytreatment),
    or if treatment.csv is absent/empty and isodata.csv has those columns.
    Otherwise return 'POINT' (WWTP locations mode)."""
    try:
        tr_path = _resolve_data_path(cs_path, folder, 'treatment.csv')
        if os.path.exists(tr_path):
            with open(tr_path, 'r', newline='', encoding='utf-8') as f:
                reader = csv.reader(f)
                headers = next(reader, [])
                has_data = next(reader, None) is not None
            if 'FractionPrimarytreatment' in headers:
                return 'AREA'
            if headers and 'lon' in headers and has_data:
                return 'POINT'
            # POINT headers present but no data rows → fall through to isodata check
        # No valid treatment.csv — fall back to isodata.csv columns
        iso_path = _resolve_data_path(cs_path, folder, 'isodata.csv')
        if os.path.exists(iso_path):
            with open(iso_path, 'r', newline='', encoding='utf-8') as f:
                headers = next(csv.reader(f), [])
            if 'FractionPrimarytreatment' in headers:
                return 'AREA'
    except Exception:
        pass
    return 'POINT'


def _tif_pixel_dimensions(path):
    """Return (width, height) read directly from a TIFF header, or None on failure."""
    try:
        with open(path, 'rb') as f:
            raw = f.read(8)
        if len(raw) < 8:
            return None
        bo = '<' if raw[:2] == b'II' else '>'
        ifd_offset = struct.unpack_from(bo + 'I', raw, 4)[0]
        with open(path, 'rb') as f:
            f.seek(ifd_offset)
            entry_count = struct.unpack_from(bo + 'H', f.read(2))[0]
            entries = f.read(entry_count * 12)
        width = height = None
        for i in range(entry_count):
            tag, typ = struct.unpack_from(bo + 'HH', entries, i * 12)
            val_off = i * 12 + 8
            decode = bo + ('H' if typ == 3 else 'I')
            if tag == 256:
                width = struct.unpack_from(decode, entries, val_off)[0]
            elif tag == 257:
                height = struct.unpack_from(decode, entries, val_off)[0]
        return (width, height) if width and height else None
    except Exception:
        return None


# GloWPa-recognised animal types (per model documentation).
_GLOWPA_ANIMALS = [
    'asses', 'buffaloes', 'camels', 'cattle', 'chickens',
    'ducks', 'goats', 'horses', 'mules', 'pigs', 'sheep',
]

# Files returned by the projections API that belong at the root of
# livestock_emissions/ (not in the animals/ sub-folder).
_LIVESTOCK_ROOT_FILES = frozenset([
    'animal_isoraster.tif',
    'manure_fractions.csv',
    'manure_management.csv',
    'production_systems.csv',
])


def _detect_livestock_module(cs_path, folder):
    """Return livestock input metadata for a scenario, or None if absent.

    Checks for a livestock_emissions/ sub-folder inside the scenario input
    directory.  When present, returns a dict:
      dir                   - absolute path to livestock_emissions/
      animals_dir           - absolute path to livestock_emissions/animals/
      has_animal_isoraster  - bool
      has_production_systems - bool
      has_manure_fractions  - bool
      has_manure_management - bool
      temperature_tif       - absolute path to yearly temperature raster or None
      animals               - {animal: {'has_isodata': bool, 'has_heads': bool}}
    """
    livestock_dir = os.path.join(cs_path, 'input', folder, 'livestock_emissions')
    if not os.path.isdir(livestock_dir):
        return None

    animals_dir = os.path.join(livestock_dir, 'animals')
    animals = {}
    if os.path.isdir(animals_dir):
        for animal in _GLOWPA_ANIMALS:
            isodata_csv = os.path.join(animals_dir, f'isodata_{animal}.csv')
            heads_tif   = os.path.join(animals_dir, f'{animal}_heads.tif')
            if os.path.exists(isodata_csv) or os.path.exists(heads_tif):
                animals[animal] = {
                    'has_isodata': os.path.exists(isodata_csv),
                    'has_heads':   os.path.exists(heads_tif),
                }

    # Look for a yearly temperature raster (several common naming conventions).
    temperature_tif = None
    for tname in ('temperature_year.tif', 'temperature.tif', 'Tair_year.tif'):
        candidate = os.path.join(livestock_dir, tname)
        if os.path.exists(candidate):
            temperature_tif = candidate
            break
    if temperature_tif is None:
        temp_subdir = os.path.join(livestock_dir, 'temperature')
        if os.path.isdir(temp_subdir):
            for fname in sorted(os.listdir(temp_subdir)):
                if fname.lower().endswith('.tif'):
                    temperature_tif = os.path.join(temp_subdir, fname)
                    break

    # Validate that the temperature raster is not a placeholder too small to cover
    # the analysis domain.  Compare pixel area against animal_isoraster.tif; if the
    # temperature raster is less than 25 % of the reference area, discard it so the
    # model does not crash silently.
    if temperature_tif:
        ref_raster = os.path.join(livestock_dir, 'animal_isoraster.tif')
        temp_dims = _tif_pixel_dimensions(temperature_tif)
        ref_dims  = _tif_pixel_dimensions(ref_raster) if os.path.exists(ref_raster) else None
        if temp_dims and ref_dims:
            if (temp_dims[0] * temp_dims[1]) < (ref_dims[0] * ref_dims[1]) * 0.25:
                print(
                    f"WARNING: temperature raster {temperature_tif} "
                    f"({temp_dims[0]}x{temp_dims[1]} px) is too small relative to "
                    f"the analysis domain ({ref_dims[0]}x{ref_dims[1]} px); "
                    "ignoring it to prevent a silent model crash."
                )
                temperature_tif = None

    return {
        'dir':                    livestock_dir,
        'animals_dir':            animals_dir,
        'has_animal_isoraster':   os.path.exists(os.path.join(livestock_dir, 'animal_isoraster.tif')),
        'has_production_systems': os.path.exists(os.path.join(livestock_dir, 'production_systems.csv')),
        'has_manure_fractions':   os.path.exists(os.path.join(livestock_dir, 'manure_fractions.csv')),
        'has_manure_management':  os.path.exists(os.path.join(livestock_dir, 'manure_management.csv')),
        'temperature_tif':        temperature_tif,
        'animals':                animals,
    }


def _r_csv_to_rds_snippet(csv_path, rds_path):
    """R code fragment: idempotently convert csv_path → rds_path."""
    return (
        f"  csv <- '{csv_path}'; rds <- '{rds_path}'; "
        f"if (file.exists(csv) && (!file.exists(rds) || file.mtime(csv) > file.mtime(rds))) {{"
        f" message(paste('Converting', csv, 'to', rds)); "
        f" saveRDS(read.csv(csv, stringsAsFactors=FALSE), rds) "
        f"}}"
    )


def _r_iso_csv_to_rds_snippet(csv_path, rds_path, treatment_csv_path=None):
    """R code fragment: convert isodata csv → RDS, computing fEmitted columns
    (fEmitted_inEffluent_after_treatment_virus/protozoa) if not already present.

    Strategy (in order):
      1. If FractionPrimarytreatment present in isodata.csv → weighted sum per row.
      2a. Else if treatment_csv_path exists and has FractionPrimarytreatment (AREA
          mode) → mean weighted sum across rows.
      2b. Else if treatment_csv_path exists and has capacity/treatment_type (POINT
          mode) → capacity-weighted average from WWTP facilities.
      3. If neither source available → default to Primary-only values.

    Constants match prepare.R:
      primary_viruses=0.75, liquid=0.97 → fEmitted_virus=0.2425
      secondary_viruses=0.95, liquid=0.50 → fEmitted_virus=0.025
      tertiary_viruses=0.99, liquid=0.40 → fEmitted_virus=0.004
      quaternary_viruses=0.9975, liquid=0.40 → fEmitted_virus=0.001
      primary_protozoa=0.50, liquid=0.85 → fEmitted_protozoa=0.425
      secondary_protozoa=0.90, liquid=0.20 → fEmitted_protozoa=0.02
      tertiary_protozoa=0.92, liquid=0.25 → fEmitted_protozoa=0.02
      quaternary_protozoa=0.996, liquid=0.25 → fEmitted_protozoa=0.001
    """
    tr_path_r = f"'{treatment_csv_path}'" if treatment_csv_path else "NULL"
    return (
        f"  local({{ "
        f"  csv <- '{csv_path}'; rds <- '{rds_path}'; "
        f"  if (file.exists(csv) && (!file.exists(rds) || file.mtime(csv) > file.mtime(rds))) {{ "
        f"    message(paste('Converting', csv, 'to', rds)); "
        f"    df <- read.csv(csv, stringsAsFactors=FALSE); "
        # --- Strategy 1: fraction columns already in isodata (AREA WWTP mode cols in isodata) ---
        f"    if (!'fEmitted_inEffluent_after_treatment_virus' %in% names(df) && "
        f"        'FractionPrimarytreatment' %in% names(df)) {{ "
        f"      .fq1 <- if ('FractionQuaternarytreatment' %in% names(df)) df$FractionQuaternarytreatment else 0; "
        f"      df$fEmitted_inEffluent_after_treatment_virus <- "
        f"        df$FractionPrimarytreatment   * (0.97 - 0.97*0.75) + "
        f"        df$FractionSecondarytreatment * (0.50 - 0.50*0.95) + "
        f"        df$FractionTertiarytreatment  * (0.40 - 0.40*0.99) + "
        f"        .fq1                          * (0.40 - 0.40*0.9975); "
        f"      df$fEmitted_inEffluent_after_treatment_protozoa <- "
        f"        df$FractionPrimarytreatment   * (0.85 - 0.85*0.50) + "
        f"        df$FractionSecondarytreatment * (0.20 - 0.20*0.90) + "
        f"        df$FractionTertiarytreatment  * (0.25 - 0.25*0.92) + "
        f"        .fq1                          * (0.25 - 0.25*0.996); "
        f"    }}; "
        # --- Strategy 2 (treatment.csv): AREA or POINT mode ---
        f"    if (!'fEmitted_inEffluent_after_treatment_virus' %in% names(df)) {{ "
        f"      .tr_path <- {tr_path_r}; "
        f"      if (!is.null(.tr_path) && file.exists(.tr_path)) {{ "
        f"        .tr <- read.csv(.tr_path, stringsAsFactors=FALSE); "
        # --- Strategy 2a: AREA mode treatment.csv (has FractionPrimarytreatment) ---
        f"        if ('FractionPrimarytreatment' %in% names(.tr)) {{ "
        f"          .fp <- mean(.tr$FractionPrimarytreatment,   na.rm=TRUE); "
        f"          .fs <- mean(.tr$FractionSecondarytreatment, na.rm=TRUE); "
        f"          .ft <- mean(.tr$FractionTertiarytreatment,  na.rm=TRUE); "
        f"          .fq <- if ('FractionQuaternarytreatment' %in% names(.tr)) mean(.tr$FractionQuaternarytreatment, na.rm=TRUE) else 0; "
        f"          message(paste('fEmitted from AREA treatment.csv: fp=', round(.fp,4), 'fs=', round(.fs,4), 'ft=', round(.ft,4))); "
        f"          df$fEmitted_inEffluent_after_treatment_virus    <- "
        f"            .fp*(0.97-0.97*0.75) + .fs*(0.50-0.50*0.95) + .ft*(0.40-0.40*0.99) + .fq*(0.40-0.40*0.9975); "
        f"          df$fEmitted_inEffluent_after_treatment_protozoa <- "
        f"            .fp*(0.85-0.85*0.50) + .fs*(0.20-0.20*0.90) + .ft*(0.25-0.25*0.92) + .fq*(0.25-0.25*0.996); "
        # --- Strategy 2b: POINT mode treatment.csv (has capacity/treatment_type) ---
        f"        }} else {{ "
        f"          .tot <- sum(.tr$capacity, na.rm=TRUE); "
        f"          if (isTRUE(.tot > 0)) {{ "
        f"            .fp <- sum(.tr$capacity[.tr$treatment_type=='Primary'],    na.rm=TRUE) / .tot; "
        f"            .fs <- sum(.tr$capacity[.tr$treatment_type=='Secondary'],  na.rm=TRUE) / .tot; "
        f"            .ft <- sum(.tr$capacity[.tr$treatment_type=='Tertiary'],   na.rm=TRUE) / .tot; "
        f"            .fq <- sum(.tr$capacity[.tr$treatment_type=='Quaternary'], na.rm=TRUE) / .tot; "
        f"          }} else {{ .fp <- 1; .fs <- 0; .ft <- 0; .fq <- 0 }}; "
        f"          .fem_v <- .fp*0.2425 + .fs*0.025 + .ft*0.004 + .fq*0.001; "
        f"          .fem_p <- .fp*0.425  + .fs*0.02  + .ft*0.02  + .fq*0.001; "
        f"          message(paste('fEmitted from POINT treatment.csv: virus=', round(.fem_v,4), 'protozoa=', round(.fem_p,4))); "
        f"          df$fEmitted_inEffluent_after_treatment_virus    <- .fem_v; "
        f"          df$fEmitted_inEffluent_after_treatment_protozoa <- .fem_p; "
        f"        }} "
        f"      }} else {{ "
        # --- Strategy 3: fallback — assume all Primary ---
        f"        message('fEmitted fallback: assuming all Primary treatment'); "
        f"        df$fEmitted_inEffluent_after_treatment_virus    <- 0.2425; "
        f"        df$fEmitted_inEffluent_after_treatment_protozoa <- 0.425; "
        f"      }} "
        f"    }}; "
        f"    saveRDS(df, rds) "
        f"  }} "
        f"}})"
    )


# R snippet: pre-download pathogenflows remote CSVs and patch read.csv so that
# those specific URLs are served from the local cache instead of being
# re-downloaded every run (the server sometimes returns a partial file).
_R_PATHOGENFLOWS_CACHE = (
    "local({"
    " .pf_cache_dir <- '/tmp/pf_csv_cache'; dir.create(.pf_cache_dir, showWarnings=FALSE, recursive=TRUE);"
    " .pf_urls <- c("
    "  k2p='http://data.waterpathogens.org/dataset/eda3c64c-479e-4177-869c-93b3dc247a10/resource/f99291ab-d536-4536-a146-083a07ea49b9/download/k2p_persistence.csv',"
    "  jmp='http://data.waterpathogens.org/dataset/86741b90-62ab-4dc2-941c-60c85bfe7ffc/resource/9113d653-0e10-4b4d-9159-344c494f7fc7/download/jmp_assumptions.csv'"
    " );"
    " for (nm in names(.pf_urls)) {"
    "  dest <- file.path(.pf_cache_dir, paste0(nm, '.csv'));"
    "  if (!file.exists(dest) || file.size(dest) < 1000) {"
    "   for (att in 1:5) {"
    "    tryCatch(suppressWarnings(download.file(.pf_urls[[nm]], dest, quiet=TRUE)),"
    "     error=function(e) NULL);"
    "    if (file.exists(dest) && file.size(dest) > 1000) break;"
    "    if (file.exists(dest)) file.remove(dest)"
    "   }"
    "  }"
    " };"
    " .pf_map <- setNames(as.list(file.path(.pf_cache_dir, paste0(names(.pf_urls), '.csv'))), .pf_urls);"
    " .orig_read_csv <- utils::read.csv;"
    " .patched_read_csv <- function(file, ...) {"
    "  if (is.character(file) && !is.null(.pf_map[[file]]) && file.exists(.pf_map[[file]])) file <- .pf_map[[file]];"
    "  .orig_read_csv(file, ...)"
    " };"
    " env <- getNamespace('utils');"
    " base::unlockBinding('read.csv', env);"
    " assign('read.csv', .patched_read_csv, envir=env)"
    "}); "
)


def build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=None, wwtp_mode='POINT'):
    """R expression for docker exec mode.

    Sets working directory to the case study root inside the container
    (/app/data/<cs_folder_name>), converts CSVs to RDS in place, then runs
    the model using the saved config YAML.

    cs_path: when supplied, resolves the actual file paths through
        _resolve_data_path so category sub-folders are handled correctly.
    wwtp_mode: 'POINT' builds treatment.RDS; 'AREA' skips it (fractions in isodata).
    """
    if cs_path:
        # Resolve actual disk paths, then make relative to the case-study root
        def _rel(fname):
            full = _resolve_data_path(cs_path, folder, fname)
            return os.path.relpath(full, cs_path).replace(os.sep, '/')
        iso_csv = _rel('isodata.csv')
        iso_rds = _rel('isodata.RDS')
        tr_csv  = _rel('treatment.csv')
        tr_rds  = _rel('treatment.RDS')
    else:
        iso_csv = f'input/{folder}/isodata.csv'
        iso_rds = f'input/{folder}/isodata.RDS'
        tr_csv  = f'input/{folder}/treatment.csv'
        tr_rds  = f'input/{folder}/treatment.RDS'

    # Livestock CSV→RDS conversions (paths relative to case-study root)
    ls = _detect_livestock_module(cs_path, folder) if cs_path else None
    livestock_rds_snippets = []
    if ls:
        def _ls_rel(sub):
            return os.path.relpath(os.path.join(ls['dir'], sub), cs_path).replace(os.sep, '/')
        for fname in ('manure_management', 'production_systems', 'manure_fractions'):
            if os.path.exists(os.path.join(ls['dir'], f'{fname}.csv')):
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(_ls_rel(f'{fname}.csv'), _ls_rel(f'{fname}.RDS'))
                )
        for animal, info in ls['animals'].items():
            if info['has_isodata']:
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(
                        _ls_rel(f'animals/isodata_{animal}.csv'),
                        _ls_rel(f'animals/isodata_{animal}.RDS'),
                    )
                )
    livestock_rds_block = ('; '.join(livestock_rds_snippets) + '; ') if livestock_rds_snippets else ''

    return (
        f"setwd('/app/data/{cs_folder_name}'); "
        f"local({{"
        f"{_r_iso_csv_to_rds_snippet(iso_csv, iso_rds, tr_csv)}; "
        f"if (file.exists('{tr_csv}')) {{ {_r_csv_to_rds_snippet(tr_csv, tr_rds)} }}"
        + (f'; {livestock_rds_block}' if livestock_rds_block else '')
        + f"}}); "
        f"library(glowpa); "
        # GloWPa 0.2.1 ships with broken rotavirus livestock pathogen data:
        #   - storage_time / storage_time_low are NA  -> causes validate_pathogen crash
        #   - Tcoeff_1 = +0.0089 (positive) -> pathogen_decay_rate() requires negative
        #   - Tcoeff_2 = 0.0397 (near-zero) -> yields sub-day t90 at any real temperature
        # No livestock+rotavirus example exists in the package; the only validated
        # livestock Tcoeff values are those for cryptosporidium (-2.5586, 119.63).
        # We fall back to those values so the manure-storage survival calculation runs.
        f"local({{p <- as.data.frame(glowpa:::pathogens); "
        f"p[is.na(p[,'storage_time']),'storage_time'] <- 274L; "
        f"p[is.na(p[,'storage_time_low']),'storage_time_low'] <- 30L; "
        f"p[p[,'name']=='rotavirus','Tcoeff_1'] <- -2.5586; "
        f"p[p[,'name']=='rotavirus','Tcoeff_2'] <- 119.63; "
        f"utils::assignInNamespace('pathogens', p, ns='glowpa')}}); "
        # GloWPa 0.2.1 calls sym() (from rlang) without the rlang:: qualifier inside
        # group_modify / group_map lambdas in pathways_land, output_table_livestock,
        # and several other functions.  With dplyr >= 1.1.x the lambda closures no
        # longer inherit rlang's namespace, so sym() is not found at call time,
        # causing a silent crash after "Finished livestock emissions".
        # Fix: set each affected function's environment to a child env that
        # provides sym = rlang::sym, so the lookup succeeds.
        f"local({{"
        f".patch <- function(fn_name) {{"
        f"  env <- asNamespace('glowpa'); fn <- get(fn_name, envir=env); "
        f"  ne <- new.env(parent=environment(fn)); ne$sym <- rlang::sym; "
        f"  environment(fn) <- ne; "
        f"  base::unlockBinding(fn_name, env); "
        f"  assign(fn_name, fn, envir=env); "
        f"  base::lockBinding(fn_name, env)"
        f"}}; "
        f"for (.fn in c('pathways_land','output_table_livestock','output_table_human',"
        f"'animal_emission','livstock_manure_frac_to_grid','output_sink_table',"
        f"'pathways_humans_rast','prepare_livestock_vermeulen','routing',"
        f"'wwtp_area_emissions_to_grid')) {{"
        f"  tryCatch(.patch(.fn), error=function(e) NULL)"
        f"}}"
        f"}}); "
        f"glowpa_init('config/{yaml_filename}'); "
        f"glowpa_start()"
    )


def build_r_expr_run(yaml_filename, cs_path=None, folder=None, wwtp_mode='POINT'):
    """R expression for docker run mode.

    The scenario input dir is already mounted at /app/input, so absolute paths
    are used for the CSV→RDS step.  glowpa_init receives the absolute config path.

    cs_path + folder: when supplied, resolves paths relative to the mount point
        so category sub-folders (e.g. human_emissions/) are handled correctly.
    wwtp_mode: 'POINT' builds treatment.RDS; 'AREA' skips it.
    """
    if cs_path and folder:
        def _rel(fname):
            full = _resolve_data_path(cs_path, folder, fname)
            base = os.path.join(cs_path, 'input', folder)
            return os.path.relpath(full, base).replace(os.sep, '/')
        iso_csv = f'/app/input/{_rel("isodata.csv")}'
        iso_rds = f'/app/input/{_rel("isodata.RDS")}'
        tr_csv  = f'/app/input/{_rel("treatment.csv")}'
        tr_rds  = f'/app/input/{_rel("treatment.RDS")}'
    else:
        iso_csv = '/app/input/isodata.csv'
        iso_rds = '/app/input/isodata.RDS'
        tr_csv  = '/app/input/treatment.csv'
        tr_rds  = '/app/input/treatment.RDS'

    # Livestock CSV→RDS conversions (absolute /app/input/ paths)
    ls = _detect_livestock_module(cs_path, folder) if (cs_path and folder) else None
    livestock_rds_snippets = []
    if ls:
        def _ls_flat(sub):
            abs_p = os.path.join(ls['dir'], sub)
            base  = os.path.join(cs_path, 'input', folder)
            return '/app/input/' + os.path.relpath(abs_p, base).replace(os.sep, '/')
        for fname in ('manure_management', 'production_systems', 'manure_fractions'):
            if os.path.exists(os.path.join(ls['dir'], f'{fname}.csv')):
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(_ls_flat(f'{fname}.csv'), _ls_flat(f'{fname}.RDS'))
                )
        for animal, info in ls['animals'].items():
            if info['has_isodata']:
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(
                        _ls_flat(f'animals/isodata_{animal}.csv'),
                        _ls_flat(f'animals/isodata_{animal}.RDS'),
                    )
                )
    livestock_rds_block = ('; '.join(livestock_rds_snippets) + '; ') if livestock_rds_snippets else ''

    return (
        f"local({{"
        f"{_r_iso_csv_to_rds_snippet(iso_csv, iso_rds, tr_csv)}; "
        + (f"if (file.exists('{tr_csv}')) {{ {_r_csv_to_rds_snippet(tr_csv, tr_rds)} }}" if wwtp_mode == 'POINT' else "")
        + (f'; {livestock_rds_block}' if livestock_rds_block else '')
        + f"}}); "
        f"library(glowpa); "
        f"local({{p <- as.data.frame(glowpa:::pathogens); "
        f"p[is.na(p[,'storage_time']),'storage_time'] <- 274L; "
        f"p[is.na(p[,'storage_time_low']),'storage_time_low'] <- 30L; "
        f"p[p[,'name']=='rotavirus','Tcoeff_1'] <- -2.5586; "
        f"p[p[,'name']=='rotavirus','Tcoeff_2'] <- 119.63; "
        f"utils::assignInNamespace('pathogens', p, ns='glowpa')}}); "
        f"local({{"
        f".patch <- function(fn_name) {{"
        f"  env <- asNamespace('glowpa'); fn <- get(fn_name, envir=env); "
        f"  ne <- new.env(parent=environment(fn)); ne$sym <- rlang::sym; "
        f"  environment(fn) <- ne; "
        f"  base::unlockBinding(fn_name, env); "
        f"  assign(fn_name, fn, envir=env); "
        f"  base::lockBinding(fn_name, env)"
        f"}}; "
        f"for (.fn in c('pathways_land','output_table_livestock','output_table_human',"
        f"'animal_emission','livstock_manure_frac_to_grid','output_sink_table',"
        f"'pathways_humans_rast','prepare_livestock_vermeulen','routing',"
        f"'wwtp_area_emissions_to_grid')) {{"
        f"  tryCatch(.patch(.fn), error=function(e) NULL)"
        f"}}"
        f"}}); "
        f"glowpa_init('/app/config/{yaml_filename}'); "
        f"glowpa_start()"
    )


DOCKER_SOCK = 'unix://var/run/docker.sock'


def _get_docker_client():
    """Return a docker.DockerClient connected via unix socket, or None on failure."""
    try:
        client = docker.DockerClient(base_url=DOCKER_SOCK)
        client.ping()
        return client
    except Exception:
        return None


def _glowpa_container_running():
    """Return True if glowpa-container is currently running."""
    client = _get_docker_client()
    if client is None:
        return False
    try:
        container = client.containers.get('glowpa-container')
        return container.status == 'running'
    except Exception:
        return False


def build_model_cmd(cs_path, cs_folder_name, folder, yaml_filename, wwtp_mode='POINT'):
    """Return (cmd_list, mode, yaml_content) for running the model.

    mode='exec'  — docker exec on the persistent glowpa-container.
                   Uses setwd() + relative paths; YAML saved to config/.
    mode='run'   — docker run (one-shot container) with per-scenario volume
                   mounts; used when the persistent container is not running.
                   Uses flat /app/input paths in YAML.
    wwtp_mode: 'POINT' or 'AREA'; controls YAML and RDS conversion.

    In both modes the R expression is written to a temporary .R script file
    rather than passed via 'Rscript -e <expr>'.  Passing long expressions via
    -e is unreliable: the Docker exec API may truncate or mangle multi-KB
    argument strings.  Writing to a file avoids all command-length and
    character-encoding issues, and makes the script inspectable for debugging.
    """
    if _glowpa_container_running():
        r_expr = build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=cs_path, wwtp_mode=wwtp_mode)
        # Write script to the case-study root so both host and container can access it
        script_host = os.path.join(cs_path, 'glowpa_run.R')
        script_cont = f'/app/data/{cs_folder_name}/glowpa_run.R'
        with open(script_host, 'w', encoding='utf-8') as _sf:
            _sf.write(r_expr + '\n')
        return {
            'type': 'exec',
            'container': 'glowpa-container',
            'command': ['Rscript', script_cont],
            'script_host': script_host,
        }, 'exec'
    else:
        input_path  = os.path.join(cs_path, 'input', folder)
        output_path = os.path.join(cs_path, 'output', folder)
        config_path = os.path.join(cs_path, 'config')
        r_expr = build_r_expr_run(yaml_filename, cs_path=cs_path, folder=folder, wwtp_mode=wwtp_mode)
        # Write script to output dir so container can access it via /app/output
        os.makedirs(output_path, exist_ok=True)
        script_host = os.path.join(output_path, 'glowpa_run.R')
        script_cont = '/app/output/glowpa_run.R'
        with open(script_host, 'w', encoding='utf-8') as _sf:
            _sf.write(r_expr + '\n')
        return {
            'type': 'run',
            'image': GLOWPA_IMAGE,
            'command': ['Rscript', script_cont],
            'volumes': {
                input_path:  {'bind': '/app/input',  'mode': 'rw'},
                output_path: {'bind': '/app/output', 'mode': 'rw'},
                config_path: {'bind': '/app/config', 'mode': 'ro'},
            },
            'script_host': script_host,
        }, 'run'


# Keep old name as alias so existing call-sites still compile
build_prepare_and_run_r_expr = build_r_expr_exec



def _execute_model_run(run_id, params):
    """Background thread: run glowpa model via Docker SDK and record output."""
    client = None
    try:
        model_runs[run_id]['status'] = 'running'
        client = _get_docker_client()
        if client is None:
            raise RuntimeError('Cannot connect to Docker socket at ' + DOCKER_SOCK)

        if params['type'] == 'exec':
            container = client.containers.get(params['container'])
            result = container.exec_run(
                params['command'],
                stdout=True, stderr=True, demux=True,
            )
            stdout_b, stderr_b = result.output if result.output else (b'', b'')
            stdout = (stdout_b or b'').decode('utf-8', errors='replace')
            stderr = (stderr_b or b'').decode('utf-8', errors='replace')
            exit_code = result.exit_code
        else:  # 'run'
            output_b = client.containers.run(
                params['image'],
                command=params['command'],
                volumes=params['volumes'],
                remove=True,
                stdout=True, stderr=True,
            )
            stdout = (output_b or b'').decode('utf-8', errors='replace')
            stderr = ''
            exit_code = 0

        model_runs[run_id]['stdout'] = stdout
        model_runs[run_id]['stderr'] = stderr
        model_runs[run_id]['return_code'] = exit_code

        # Read the glowpa.log file from disk — more reliable than stdout alone
        # because the TEE appender writes to both, but long runs may have
        # truncated or buffered stdout in exec mode.
        cs_path = model_runs[run_id].get('cs_path', '')
        folder = model_runs[run_id].get('folder', '')
        log_file_content = ''
        if cs_path and folder:
            log_path = os.path.join(cs_path, 'output', folder, 'glowpa.log')
            try:
                with open(log_path, 'r', encoding='utf-8', errors='replace') as _lf:
                    log_file_content = _lf.read()
            except OSError:
                pass

        combined = stdout + '\n' + stderr + '\n' + log_file_content

        # Primary completion signal (human-only and combined runs)
        finished_simulation = 'Finished GloWPa simulation' in combined

        # Scan the output directory for generated result files
        output_files = []
        if cs_path and folder:
            output_dir = os.path.join(cs_path, 'output', folder)
            if os.path.isdir(output_dir):
                output_files = sorted(
                    f for f in os.listdir(output_dir)
                    if not f.endswith('.log')
                )
        model_runs[run_id]['output_files'] = output_files

        # For livestock-enabled runs the simulation may end with
        # "Finished livestock emissions" without logging the combined
        # "Finished GloWPa simulation" line. Treat that as complete when
        # at least one output file was actually produced.
        finished_livestock = (
            'Finished livestock emissions' in combined
            and len(output_files) > 0
        )

        simulation_complete = finished_simulation or finished_livestock
        model_runs[run_id]['simulation_complete'] = simulation_complete
        model_runs[run_id]['status'] = 'success' if (exit_code == 0 and simulation_complete) else 'error'

        # When GloWPa never created its own glowpa.log (i.e. R crashed before
        # glowpa_init), persist the R session's stdout+stderr to a fallback
        # log file so it survives page refreshes and is visible via the log endpoint.
        if cs_path and folder:
            exec_log = os.path.join(cs_path, 'output', folder, 'glowpa.log')
            if not os.path.exists(exec_log):
                run_log = os.path.join(cs_path, 'output', folder, 'glowpa.log')
                r_output = (stdout or '') + ('\n' + stderr if stderr else '')
                if r_output.strip():
                    try:
                        os.makedirs(os.path.dirname(run_log), exist_ok=True)
                        with open(run_log, 'w', encoding='utf-8') as _lf:
                            _lf.write('[R session output — GloWPa log not created; R crashed before glowpa_init]\n\n')
                            _lf.write(r_output)
                    except OSError:
                        pass

        # Clean up RDS files after run (unless debug mode is enabled)
        if not model_runs[run_id].get('debug_mode', False):
            _cleanup_rds_files(run_id)
    except docker.errors.ContainerError as exc:
        model_runs[run_id]['status'] = 'error'
        model_runs[run_id]['stderr'] = (exc.stderr or b'').decode('utf-8', errors='replace')
        model_runs[run_id]['return_code'] = exc.exit_status
    except Exception as exc:
        model_runs[run_id]['status'] = 'error'
        model_runs[run_id]['stderr'] = str(exc)
    finally:
        # Always remove the temporary R script file written by build_model_cmd
        script_host = params.get('script_host')
        if script_host and os.path.exists(script_host):
            try:
                os.remove(script_host)
            except OSError:
                pass
        model_runs[run_id]['finished_at'] = datetime.now().isoformat()
        if client:
            try:
                client.close()
            except Exception:
                pass


def _cleanup_rds_files(run_id):
    """Delete .RDS files generated during a model run."""
    run = model_runs.get(run_id, {})
    cs_path = run.get('cs_path', '')
    folder = run.get('folder', '')
    if not (cs_path and folder):
        return
    def _del(path):
        if os.path.exists(path):
            try:
                os.remove(path)
                print(f'[model-run] Deleted {path}')
            except Exception as e:
                print(f'[model-run] Could not delete {path}: {e}')

    for rds_name in ['isodata.RDS', 'treatment.RDS']:
        _del(_resolve_data_path(cs_path, folder, rds_name))
    # Also clean up livestock RDS files if present
    ls = _detect_livestock_module(cs_path, folder)
    if ls:
        for fname in ('manure_management.RDS', 'production_systems.RDS', 'manure_fractions.RDS'):
            _del(os.path.join(ls['dir'], fname))
        if os.path.isdir(ls['animals_dir']):
            for fname in os.listdir(ls['animals_dir']):
                if fname.lower().endswith('.rds'):
                    _del(os.path.join(ls['animals_dir'], fname))


# In-memory storage for case studies and scenarios (in production, use a database)
case_studies = []
scenarios = []
glowpa_running = False
model_runs = {}  # run_id -> run status/output dict

# Create a second Flask app for serving React on port 3000
frontend_app = Flask(__name__, static_folder='/app/frontend/build', static_url_path='')
CORS(frontend_app)

@frontend_app.route('/')
def serve_react_app():
    return send_from_directory(frontend_app.static_folder, 'index.html')

@frontend_app.route('/test-route')
def test_route():
    return jsonify({"message": "Frontend app is working", "route": "/test-route"})

# Add API endpoints to frontend app as well
@frontend_app.route('/api/health')
def frontend_health_check():
    return jsonify({"status": "healthy", "message": "Frontend server is running"})

@frontend_app.route('/api/case-studies')
def frontend_get_case_studies():
    print(f"[DEBUG] frontend_get_case_studies called, case_studies type: {type(case_studies)}")
    print(f"[DEBUG] case_studies content: {case_studies}")
    print(f"[DEBUG] case_studies keys: {list(case_studies.keys()) if isinstance(case_studies, dict) else 'Not a dict'}")
    return jsonify({"case_studies": case_studies})

@frontend_app.route('/api/case-studies', methods=['POST'])
def frontend_create_case_study():
    data = request.get_json()
    case_study_id = str(uuid.uuid4())
    case_study_name = data.get("name", "Untitled Case Study")
    case_study_description = data.get("description", "")
    created_by = data.get("created_by", "Anonymous")
    
    # Create folder structure for the case study
    try:
        case_study_path, folder_name = create_case_study_folders(case_study_id, case_study_name)
        
        # Create datapackage.json metadata file
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
        case_studies.append(case_study)
        return jsonify({"case_study": case_study}), 201
    except Exception as e:
        return jsonify({"error": f"Failed to create case study folders: {str(e)}"}), 500

@frontend_app.route('/api/case-studies/<case_study_id>', methods=['DELETE'])
def frontend_delete_case_study(case_study_id):
    """Delete a case study and all its associated files"""
    print(f"[DEBUG] DELETE request received for case study ID: {case_study_id}")
    print(f"[DEBUG] Request method: {request.method}")
    print(f"[DEBUG] Request headers: {dict(request.headers)}")
    
    try:
        # Find the case study
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            print(f"[DEBUG] Case study not found: {case_study_id}")
            return jsonify({"error": "Case study not found"}), 404
        
        print(f"[DEBUG] Found case study: {case_study.get('name', 'Unknown')}")
        
        # Remove the case study folder and all its contents
        import shutil
        folder_path = case_study.get('folder_path')
        if folder_path and os.path.exists(folder_path):
            print(f"[DEBUG] Removing folder: {folder_path}")
            shutil.rmtree(folder_path)
        
        # Remove the case study from the list
        case_studies[:] = [cs for cs in case_studies if cs['id'] != case_study_id]
        
        # Remove associated scenarios
        global scenarios
        scenarios = [s for s in scenarios if s.get('case_study_id') != case_study_id]
        
        print(f"[DEBUG] Case study deleted successfully")
        return jsonify({"message": "Case study deleted successfully"}), 200
    except Exception as e:
        print(f"[DEBUG] Error deleting case study: {str(e)}")
        return jsonify({"error": f"Failed to delete case study: {str(e)}"}), 500

def _do_zip_upload(file):
    """Shared implementation for processing a ZIP-file case-study upload.

    The ZIP is expected to contain a ``baseline/`` top-level directory whose
    contents follow this layout:

      baseline/
        isodata.csv            (required)
        treatment.csv          (optional)
        isoraster.tif          (required for analytics)
        pop_urban.tif          (required for analytics; renamed → popurban.tif)
        pop_rural.tif          (required for analytics; renamed → poprural.tif)
        geodata/               (optional sub-folder)
        human_emissions/       (category sub-folder; enables human-emissions)
        livestock_emissions/   (optional category)
        concentrations/        (optional category)
        risk/                  (optional category)

    If no ``baseline/`` directory is found the entire extraction root is used
    as the source (backward-compatible with old-style flat zips).

    Returns the case-study dict that was appended to `case_studies`.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        zip_path = os.path.join(temp_dir, file.filename)
        file.save(zip_path)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        # ── Determine source root ────────────────────────────────────────────
        # Prefer an explicit baseline/ sub-directory; fall back to temp_dir root
        # for backward compatibility with old-style flat zips.
        baseline_src = os.path.join(temp_dir, 'baseline')
        if not os.path.isdir(baseline_src):
            baseline_src = temp_dir

        # ── Detect available categories ───────────────────────────────────────
        enabled_categories = [
            cat_id
            for cat_id, folder_name in CATEGORY_FOLDER_MAP.items()
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

                # Skip the original ZIP itself
                if os.path.abspath(src_file) == os.path.abspath(zip_path):
                    continue

                # Compute path relative to the source root so sub-folder
                # structure (e.g. geodata/, human_emissions/) is preserved.
                rel_path = os.path.relpath(src_file, baseline_src)

                # Normalise raster filenames (pop_urban.tif → popurban.tif, etc.)
                rel_parts = rel_path.split(os.sep)
                rel_parts[-1] = RASTER_RENAME_MAP.get(rel_parts[-1].lower(), rel_parts[-1])
                rel_path = os.path.join(*rel_parts)

                dest_file = os.path.join(baseline_path, rel_path)
                os.makedirs(os.path.dirname(dest_file), exist_ok=True)
                shutil.copy2(src_file, dest_file)
                files_copied.append(rel_path)

                if rel_parts[-1].lower() == 'isodata.csv':
                    has_isodata = True

        # datapackage.json – keep for metadata-editor UI compatibility
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
        case_studies.append(case_study)

        # Create the single baseline entry in scenario_metadata.csv
        if has_isodata:
            create_baseline_metadata_entry(case_study_path)
        else:
            print(f"[WARN] No isodata.csv found in {file.filename}; baseline entry not created.")

        print(f"[DEBUG] Imported case study '{case_study_name}' — {len(files_copied)} files copied to baseline/")
        return case_study


@frontend_app.route('/api/case-studies/upload', methods=['POST'])
def frontend_upload_case_study():
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

@frontend_app.route('/api/scenarios')
def frontend_get_scenarios():
    print("=== SCENARIOS ENDPOINT CALLED ===")
    import sys
    sys.stdout.flush()
    case_study_id = request.args.get('case_study_id')
    all_scenarios = []
    
    print(f"[DEBUG] GET scenarios request for case_study_id: {case_study_id}")
    print(f"[DEBUG] Available case studies: {len(case_studies)}")
    sys.stdout.flush()
    
    # Load scenarios from scenarios_metadata.csv files for all case studies
    for case_study in case_studies:
        print(f"[DEBUG] Processing case study: {case_study}")
        sys.stdout.flush()
        case_study_path = case_study.get('folder_path')
        if case_study_path:
            print(f"[DEBUG] Loading scenarios from path: {case_study_path}")
            sys.stdout.flush()
            case_study_scenarios = load_scenarios_from_metadata_csv(case_study_path)
            print(f"[DEBUG] Loaded {len(case_study_scenarios)} scenarios")
            sys.stdout.flush()
            all_scenarios.extend(case_study_scenarios)
        else:
            print(f"[DEBUG] No folder_path for case study: {case_study}")
            sys.stdout.flush()
    
    print(f"[DEBUG] Total scenarios loaded: {len(all_scenarios)}")
    sys.stdout.flush()
    
    if case_study_id:
        # For specific case study, load from that case study only
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if case_study and case_study.get('folder_path'):
            print(f"[DEBUG] Loading scenarios for specific case study: {case_study_id}")
            case_study_scenarios = load_scenarios_from_metadata_csv(case_study['folder_path'])
            # Set the case_study_id for all loaded scenarios
            for scenario in case_study_scenarios:
                scenario['case_study_id'] = case_study_id
            print(f"[DEBUG] Loaded {len(case_study_scenarios)} scenarios for case study")
            return jsonify({"scenarios": case_study_scenarios})
        else:
            print(f"[DEBUG] Case study not found or no folder path: {case_study_id}")
            return jsonify({"scenarios": []})
    else:
        # For all case studies
        for case_study in case_studies:
            print(f"[DEBUG] Processing case study: {case_study}")
            sys.stdout.flush()
            case_study_path = case_study.get('folder_path')
            if case_study_path:
                print(f"[DEBUG] Loading scenarios from path: {case_study_path}")
                sys.stdout.flush()
                case_study_scenarios = load_scenarios_from_metadata_csv(case_study_path)
                # Set the case_study_id for all loaded scenarios
                for scenario in case_study_scenarios:
                    scenario['case_study_id'] = case_study['id']
                print(f"[DEBUG] Loaded {len(case_study_scenarios)} scenarios")
                sys.stdout.flush()
                all_scenarios.extend(case_study_scenarios)
            else:
                print(f"[DEBUG] No folder_path for case study: {case_study}")
                sys.stdout.flush()
        
        print(f"[DEBUG] Total scenarios loaded: {len(all_scenarios)}")
        sys.stdout.flush()
        return jsonify({"scenarios": all_scenarios})

@frontend_app.route('/api/scenarios', methods=['POST'])
def frontend_create_scenario():
    """Create a new scenario and save it as CSV file (frontend endpoint)"""
    return create_scenario()  # Delegate to the main implementation

@frontend_app.route('/api/scenarios/<scenario_id>', methods=['DELETE'])
def frontend_delete_scenario(scenario_id):
    """Delete a scenario (frontend endpoint)"""
    return delete_scenario(scenario_id)  # Delegate to the main implementation

@frontend_app.route('/api/scenarios/<scenario_id>', methods=['PUT'])
def frontend_update_scenario(scenario_id):
    """Update a scenario (frontend endpoint)"""
    return update_scenario(scenario_id)  # Delegate to the main implementation

@frontend_app.route('/api/scenarios/<scenario_id>/isodata', methods=['GET'])
def frontend_get_scenario_isodata(scenario_id):
    """Return isodata.csv rows for a scenario (frontend endpoint)"""
    return get_scenario_isodata(scenario_id)

@frontend_app.route('/api/scenarios/<scenario_id>/isodata', methods=['PUT'])
def frontend_update_scenario_isodata(scenario_id):
    """Patch isodata.csv for a scenario (frontend endpoint)"""
    return update_scenario_isodata(scenario_id)

@frontend_app.route('/api/scenarios/<scenario_id>/summary', methods=['GET'])
def frontend_get_scenario_summary(scenario_id):
    """Return summary.json contents for a scenario (frontend endpoint)"""
    return get_scenario_summary(scenario_id)


# ── Wastewater Treatment helpers ──────────────────────────────────────────────

def _locate_scenario(scenario_id):
    """Return (case_study_dict, folder_name) for a scenario_id, or raise ValueError."""
    for case_study in case_studies:
        cs_path = case_study.get('folder_path')
        if not cs_path:
            continue
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    return case_study, row.get('folder', 'baseline')
    raise ValueError(f'Scenario {scenario_id} not found')


_LIVESTOCK_EDITABLE_CSVS = {
    'manure_management.csv',
    'manure_fractions.csv',
    'production_systems.csv',
}


def _livestock_dir_for_scenario(scenario_id):
    """Return (case_study, folder, livestock_dir) for a scenario, or raise ValueError."""
    cs, folder = _locate_scenario(scenario_id)
    ls_dir = os.path.join(cs['folder_path'], 'input', folder, 'livestock_emissions')
    if not os.path.isdir(ls_dir):
        raise ValueError('livestock_emissions folder not found for this scenario')
    return cs, folder, ls_dir


def _read_csv_table(path):
    """Return {'data': [...], 'fieldnames': [...]} for a CSV file path."""
    with open(path, 'r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        data = [dict(row) for row in reader]
    return {'data': data, 'fieldnames': fieldnames}


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-population', methods=['GET'])
def frontend_get_livestock_population(scenario_id):
    """Return a table view over livestock animals/isodata_<animal>.csv files.

    Response schema:
      {
        data: [{ animal, <isodata columns...> }, ...],
        fieldnames: [<isodata columns...>]
      }
    """
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        animals_dir = os.path.join(ls_dir, 'animals')
        if not os.path.isdir(animals_dir):
            return jsonify({'data': [], 'fieldnames': []}), 200

        isodata_files = sorted(
            f for f in os.listdir(animals_dir)
            if f.startswith('isodata_') and f.lower().endswith('.csv')
        )
        if not isodata_files:
            return jsonify({'data': [], 'fieldnames': []}), 200

        data = []
        fieldnames = []
        area_labels = []
        for fname in isodata_files:
            animal = fname[len('isodata_'):-4]
            table = _read_csv_table(os.path.join(animals_dir, fname))
            area_rows = [dict(r) for r in (table['data'] or [])]
            row = dict(area_rows[0]) if area_rows else {}
            for col in table['fieldnames']:
                if col not in fieldnames:
                    fieldnames.append(col)
            # Preserve full per-area data so frontend can support area selection/multi-selection.
            row['areaRows'] = area_rows
            row['animal'] = animal
            data.append(row)

            if not area_labels and area_rows:
                area_labels = [
                    (
                        str(r.get('subarea') or '').strip()
                        or str(r.get('iso') or '').strip()
                        or str(r.get('gid') or '').strip()
                        or f'Area {i + 1}'
                    )
                    for i, r in enumerate(area_rows)
                ]

        # Keep common identifiers at the left when present.
        preferred = ['iso', 'gid']
        ordered = [c for c in preferred if c in fieldnames] + [c for c in fieldnames if c not in preferred]

        return jsonify({'data': data, 'fieldnames': ordered, 'areas': area_labels}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-population', methods=['PUT'])
def frontend_update_livestock_population(scenario_id):
    """Update values in animals/isodata_<animal>.csv files from table rows.

    For safety, identifier fields ('iso', 'gid') are never overwritten.
    If an animal CSV has multiple rows, edited values are applied to all rows.
    """
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        animals_dir = os.path.join(ls_dir, 'animals')
        if not os.path.isdir(animals_dir):
            return jsonify({'error': 'animals folder not found'}), 404

        payload = request.get_json() or {}
        rows = payload.get('rows', [])
        by_animal = {str(r.get('animal', '')).strip(): r for r in rows if str(r.get('animal', '')).strip()}
        if not by_animal:
            return jsonify({'error': 'No animal rows provided'}), 400

        readonly = {'animal', 'iso', 'gid'}
        updated_files = 0
        for animal, src_row in by_animal.items():
            csv_path = os.path.join(animals_dir, f'isodata_{animal}.csv')
            if not os.path.exists(csv_path):
                continue

            table = _read_csv_table(csv_path)
            fieldnames = table['fieldnames']
            rows_existing = table['data']
            if not rows_existing:
                rows_existing = [{k: '' for k in fieldnames}]

            src_area_rows = src_row.get('areaRows')
            if isinstance(src_area_rows, list) and src_area_rows:
                # New behavior: update each CSV row by index (used by area selection in frontend).
                for i, row in enumerate(rows_existing):
                    patch = src_area_rows[i] if i < len(src_area_rows) and isinstance(src_area_rows[i], dict) else None
                    if not patch:
                        continue
                    for k, v in patch.items():
                        if k in readonly:
                            continue
                        if k in fieldnames:
                            row[k] = '' if v is None else str(v)
            else:
                # Backward-compatible behavior: apply one set of values to all rows.
                for row in rows_existing:
                    for k, v in src_row.items():
                        if k in readonly:
                            continue
                        if k in fieldnames:
                            row[k] = '' if v is None else str(v)

            with open(csv_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for r in rows_existing:
                    writer.writerow({k: r.get(k, '') for k in fieldnames})
            updated_files += 1

        return jsonify({'message': 'Livestock population updated', 'updated_files': updated_files}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-tif/<path:filename>', methods=['GET'])
def frontend_livestock_tif(scenario_id, filename):
    """Serve a raw heads TIF file for rendering in the browser (georaster/Leaflet)."""
    import mimetypes
    try:
        name = os.path.basename(filename)
        if not name.lower().endswith('.tif') and not name.lower().endswith('.tiff'):
            return jsonify({'error': 'Only .tif files are served'}), 400
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        tif_path = os.path.join(ls_dir, 'animals', name)
        if not os.path.exists(tif_path):
            return jsonify({'error': f'{name} not found'}), 404
        mime = mimetypes.guess_type(tif_path)[0] or 'image/tiff'
        return send_file(tif_path, mimetype=mime)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/input-raster/<path:filename>', methods=['GET'])
def frontend_input_raster(scenario_id, filename):
    """Serve an input TIF raster (isoraster.tif, poprural.tif, popurban.tif) for the browser."""
    import mimetypes
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


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-available-animals', methods=['GET'])
def frontend_livestock_available_animals(scenario_id):
    """Return animals whose heads TIF has a non-zero grid sum.

    Response: { animals: { <animal>: <total_pixel_sum> | null }, error: null }
    Animals with no TIF file are omitted.  The sum is null when rasterio is
    unavailable (treat as present in that case).
    """
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        animals_dir = os.path.join(ls_dir, 'animals')
        if not os.path.isdir(animals_dir):
            return jsonify({'animals': {}}), 200

        result = {}
        for animal in _GLOWPA_ANIMALS:
            tif_path = os.path.join(animals_dir, f'{animal}_heads.tif')
            if not os.path.exists(tif_path):
                continue
            try:
                import numpy as np
                import rasterio
                with rasterio.open(tif_path) as src:
                    data = src.read(1).astype(float)
                    nd = src.nodata
                if nd is not None:
                    data[data == float(nd)] = np.nan
                data[data < 0] = np.nan
                total = float(np.nansum(data))
                result[animal] = total
            except Exception:
                # rasterio unavailable or TIF unreadable — treat as present
                result[animal] = None

        return jsonify({'animals': result}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-heads-by-area', methods=['GET'])
def frontend_livestock_heads_by_area(scenario_id):
    """Return per-area animal head totals derived from animals/*_heads.tif rasters.

    Response shape:
      {
        areas: [{ iso: "1", label: "Area name" }, ...],
        animals: ["cattle", "goats", ...],
        by_area: { "1": { "cattle": 123.4, ... }, ... },
        totals_by_animal: { "cattle": 999.0, ... }
      }
    """
    import numpy as np
    try:
        import rasterio
        from rasterio.mask import mask as rio_mask
        from rasterio.warp import transform_geom
        from rasterio.crs import CRS
        import fiona

        cs, folder, ls_dir = _livestock_dir_for_scenario(scenario_id)
        animals_dir = os.path.join(ls_dir, 'animals')
        if not os.path.isdir(animals_dir):
            return jsonify({'areas': [], 'animals': [], 'by_area': {}, 'totals_by_animal': {}}), 200

        # Try scenario geodata first, then baseline.
        shp_path = None
        for candidate_folder in [folder, 'baseline']:
            geodata_dir = os.path.join(cs['folder_path'], 'input', candidate_folder, 'geodata')
            if not os.path.isdir(geodata_dir):
                continue
            shp_files = [f for f in os.listdir(geodata_dir) if f.lower().endswith('.shp')]
            if shp_files:
                shp_path = os.path.join(geodata_dir, shp_files[0])
                break
        if not shp_path:
            return jsonify({'error': 'No geodata shapefile found'}), 404

        # Prefer labels from isodata.csv when available.
        area_labels = {}
        isodata_path = _resolve_data_path(cs['folder_path'], folder, 'isodata.csv')
        if os.path.exists(isodata_path):
            with open(isodata_path, 'r', newline='', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for idx, row in enumerate(reader):
                    iso_key = str(row.get('iso') or row.get('gid') or (idx + 1)).strip()
                    label = (
                        row.get('subarea')
                        or row.get('NAME_4')
                        or row.get('NAME_3')
                        or row.get('NAME_2')
                        or row.get('NAME_1')
                        or row.get('NAME_0')
                        or iso_key
                    )
                    area_labels[iso_key] = str(label)

        areas = []
        geometries = []
        with fiona.open(shp_path) as shp:
            shp_crs = shp.crs_wkt or 'EPSG:4326'
            for idx, feat in enumerate(shp):
                iso_key = str(idx + 1)
                props = feat.get('properties') or {}
                label = (
                    area_labels.get(iso_key)
                    or props.get('subarea')
                    or props.get('NAME_4')
                    or props.get('NAME_3')
                    or props.get('NAME_2')
                    or props.get('NAME_1')
                    or props.get('NAME_0')
                    or iso_key
                )
                areas.append({'iso': iso_key, 'label': str(label)})
                geometries.append(feat.get('geometry'))

        by_area = {a['iso']: {} for a in areas}
        totals_by_animal = {}

        animals = []
        for animal in _GLOWPA_ANIMALS:
            tif_path = os.path.join(animals_dir, f'{animal}_heads.tif')
            if not os.path.exists(tif_path):
                continue
            animals.append(animal)
            totals_by_animal[animal] = 0.0

            with rasterio.open(tif_path) as src:
                raster_crs = src.crs or CRS.from_epsg(4326)
                nodata = src.nodata
                for area, geom in zip(areas, geometries):
                    iso_key = area['iso']
                    try:
                        geom_raster = transform_geom(shp_crs, raster_crs.to_wkt(), geom)
                    except Exception:
                        geom_raster = geom
                    try:
                        out, _ = rio_mask(src, [geom_raster], crop=True, all_touched=True, filled=True, nodata=np.nan)
                        vals = out[0].astype(float)
                        if nodata is not None:
                            vals[vals == float(nodata)] = np.nan
                        vals[vals < 0] = np.nan
                        total = float(np.nansum(vals))
                        if not np.isfinite(total):
                            total = 0.0
                    except Exception:
                        total = 0.0

                    by_area[iso_key][animal] = total
                    totals_by_animal[animal] += total

        return jsonify({
            'areas': areas,
            'animals': animals,
            'by_area': by_area,
            'totals_by_animal': totals_by_animal,
        }), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ImportError as e:
        return jsonify({'error': f'Missing geospatial dependency: {e}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-headcount', methods=['PUT'])
def frontend_set_livestock_headcount(scenario_id):
    """Scale livestock heads TIF pixels to match new total head counts.

    Body: { "counts": { "cattle": 12345.0, ... } }

    For each animal, multiplies all valid pixel values by (new_total / old_total)
    so that the grid sum equals the requested count.  Nodata and negative cells
    are left unchanged.  The TIF is written back in float32 in-place.
    """
    try:
        import numpy as np
        import rasterio

        payload = request.get_json() or {}
        counts = payload.get('counts', {})

        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        animals_dir = os.path.join(ls_dir, 'animals')

        results = {}
        for animal, new_total in counts.items():
            animal = str(animal)
            new_total = float(new_total)
            tif_path = os.path.join(animals_dir, f'{animal}_heads.tif')
            if not os.path.exists(tif_path):
                results[animal] = {'skipped': 'TIF not found'}
                continue

            with rasterio.open(tif_path) as src:
                data_arr = src.read(1).astype(float)
                profile = src.profile.copy()
                nodata = src.nodata

            valid = np.ones(data_arr.shape, dtype=bool)
            if nodata is not None:
                valid &= (data_arr != float(nodata))
            valid &= (data_arr >= 0)

            old_total = float(np.nansum(data_arr[valid]))
            if old_total <= 0:
                results[animal] = {'skipped': 'old total was zero, cannot scale'}
                continue

            scale = new_total / old_total
            new_arr = data_arr.copy()
            new_arr[valid] = data_arr[valid] * scale

            profile.update(dtype='float32')
            with rasterio.open(tif_path, 'w', **profile) as dst:
                dst.write(new_arr.astype('float32'), 1)

            results[animal] = {'old_total': round(old_total), 'new_total': round(new_total), 'scale': round(scale, 6)}

        return jsonify({'results': results}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ImportError as e:
        return jsonify({'error': f'Missing geospatial dependency: {e}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', methods=['GET'])
def frontend_get_livestock_csv(scenario_id, filename):
    """Return rows for an editable livestock_emissions CSV file."""
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        name = os.path.basename(filename)
        if name not in _LIVESTOCK_EDITABLE_CSVS:
            return jsonify({'error': f'Unsupported livestock CSV: {name}'}), 400

        csv_path = os.path.join(ls_dir, name)
        if not os.path.exists(csv_path):
            return jsonify({'data': [], 'fieldnames': []}), 200

        table = _read_csv_table(csv_path)
        return jsonify(table), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', methods=['PUT'])
def frontend_update_livestock_csv(scenario_id, filename):
    """Write rows to an editable livestock_emissions CSV file."""
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        name = os.path.basename(filename)
        if name not in _LIVESTOCK_EDITABLE_CSVS:
            return jsonify({'error': f'Unsupported livestock CSV: {name}'}), 400

        payload = request.get_json() or {}
        rows = payload.get('rows', [])
        fieldnames = payload.get('fieldnames', [])

        # If caller omitted fieldnames, preserve existing order.
        csv_path = os.path.join(ls_dir, name)
        if not fieldnames and os.path.exists(csv_path):
            table = _read_csv_table(csv_path)
            fieldnames = table['fieldnames']
        if not fieldnames and rows:
            fieldnames = list(rows[0].keys())

        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in rows:
                writer.writerow({k: r.get(k, '') for k in fieldnames})

        return jsonify({'message': f'{name} updated', 'rows': len(rows)}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/treatment', methods=['GET'])
def frontend_get_treatment(scenario_id):
    """Return treatment.csv rows for a scenario."""
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


@frontend_app.route('/api/scenarios/<scenario_id>/treatment', methods=['PUT'])
def frontend_update_treatment(scenario_id):
    """Write rows to treatment.csv."""
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


@frontend_app.route('/api/scenarios/<scenario_id>/geodata', methods=['GET'])
def frontend_get_geodata(scenario_id):
    """Return GeoJSON for the scenario's geodata shapefile.
    Adds an 'iso' property (1-based index) to each feature so it can be
    joined with the emissions CSV data.
    """
    try:
        cs, folder = _locate_scenario(scenario_id)
        # Try scenario-specific geodata first, fall back to baseline
        for candidate_folder in [folder, 'baseline']:
            geodata_dir = os.path.join(cs['folder_path'], 'input', candidate_folder, 'geodata')
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
        fields = [f[0] for f in sf_obj.fields[1:]]  # skip DeletionFlag
        features = []
        for idx, sr in enumerate(sf_obj.shapeRecords()):
            geom = sr.shape.__geo_interface__
            props = {}
            for k, v in zip(fields, sr.record):
                if isinstance(v, bytes):
                    v = v.decode('utf-8', errors='replace').strip()
                props[k] = v
            props['iso'] = idx + 1  # 1-based index matching emission CSV iso column
            features.append({'type': 'Feature', 'geometry': geom, 'properties': props})

        return jsonify({'type': 'FeatureCollection', 'features': features}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/treatment-fractions', methods=['PUT'])
def frontend_update_treatment_fractions(scenario_id):
    """Patch or add FractionPrimary/Secondary/Tertiary columns in isodata.csv (same value for every row).

    Body parameters:
      fractions   – { fieldName: value, … }  Always written to every row.
      init_fields – { fieldName: value, … }  Only written when the column is not yet present
                                              in isodata.csv (never overwrites existing data).
    """
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = _resolve_data_path(cs['folder_path'], folder, 'isodata.csv')
        if not os.path.exists(csv_path):
            return jsonify({'error': 'isodata.csv not found'}), 404
        data = request.get_json() or {}
        fractions         = data.get('fractions',         {})
        init_fields       = data.get('init_fields',       {})
        indexed_fractions = data.get('indexed_fractions', None)  # list of dicts, one per row by index
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or [])
            rows = list(reader)
        # Always-write fields (uniform across all rows)
        for k in fractions:
            if k not in fieldnames:
                fieldnames.append(k)
        for row in rows:
            for k, v in fractions.items():
                row[k] = str(v)
        # Per-row fractions (index-matched to isodata row order)
        if indexed_fractions is not None:
            for frac_dict in indexed_fractions:
                for k in frac_dict:
                    if k not in fieldnames:
                        fieldnames.append(k)
            for i, (row, frac_dict) in enumerate(zip(rows, indexed_fractions)):
                for k, v in frac_dict.items():
                    row[k] = str(v)
        # Init-only fields: add column + default value only if column is absent
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


# ─── Config endpoints (glowpa package data) ──────────────────────────────────

GLOWPA_DESCRIPTION_PATH = '/usr/local/lib/R/site-library/glowpa/DESCRIPTION'
GLOWPA_EXTDATA_PATHOGENS = '/usr/local/lib/R/site-library/glowpa/extdata/kla/pathogen_inputs.csv'
# Relative path inside the source repo
GLOWPA_DATARAW_PATHOGENS = 'data-raw/pathogens.csv'

# In-memory cache so we only fetch once per server lifetime
_pathogens_cache = None


def _exec_glowpa(cmd):
    """Run a shell command inside glowpa-container. Returns stdout string or raises."""
    if docker_client:
        try:
            container = docker_client.containers.get('glowpa-container')
            exit_code, output = container.exec_run(cmd)
            if exit_code == 0:
                return output.decode('utf-8')
            raise RuntimeError(output.decode('utf-8', errors='replace'))
        except RuntimeError:
            raise  # command ran but returned non-zero — don't mask with CLI fallback
        except Exception as sdk_err:
            print(f'[config] Docker SDK exec failed, falling back to CLI: {sdk_err}')
    result = subprocess.run(
        ['docker', 'exec', 'glowpa-container'] + cmd.split(),
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        raise RuntimeError(f'docker exec failed: {result.stderr.strip()}')
    return result.stdout


def _parse_description(text):
    """Parse key: value pairs from an R DESCRIPTION file (handles line continuations)."""
    fields = {}
    current_key = None
    for line in text.splitlines():
        if line and line[0] != ' ' and ':' in line:
            key, _, val = line.partition(':')
            current_key = key.strip()
            fields[current_key] = val.strip()
        elif current_key and line.startswith(' '):
            fields[current_key] = (fields[current_key] + ' ' + line.strip()).strip()
    return fields


def _fetch_dataraw_pathogens():
    """Try to download data-raw/pathogens.csv from the glowpa GitLab source repo.

    Reads RemoteUrl and RemoteSha from the installed DESCRIPTION file so the
    fetched file always matches the installed package version.
    Returns CSV text, or None if the fetch fails.
    """
    try:
        desc_text = _exec_glowpa(f'cat {GLOWPA_DESCRIPTION_PATH}')
        fields = _parse_description(desc_text)
        remote_url = fields.get('RemoteUrl', '').rstrip('/')
        remote_sha = fields.get('RemoteSha', '')
        if not remote_url or not remote_sha:
            print('[config] RemoteUrl/RemoteSha not found in DESCRIPTION')
            return None
        # GitLab raw URL: <repo>/-/raw/<sha>/<path>
        raw_url = f"{remote_url.removesuffix('.git')}/-/raw/{remote_sha}/{GLOWPA_DATARAW_PATHOGENS}"
        print(f'[config] Fetching pathogens from {raw_url}')
        resp = requests.get(raw_url, timeout=15)
        resp.raise_for_status()
        print('[config] Successfully fetched data-raw/pathogens.csv from source repo')
        return resp.text
    except Exception as e:
        print(f'[config] Source-repo fetch failed: {e}')
        return None


def _read_pathogens():
    """Return the pathogens list, fetching/caching on first call.

    Priority:
      1. data-raw/pathogens.csv from the glowpa GitLab source repo (HTTP fetch)
      2. extdata/kla/pathogen_inputs.csv from the installed package (docker exec)
    """
    global _pathogens_cache
    if _pathogens_cache is not None:
        return _pathogens_cache

    # 1. Try source repo
    csv_text = _fetch_dataraw_pathogens()

    # 2. Fall back to installed extdata file
    if csv_text is None:
        print(f'[config] Falling back to installed extdata: {GLOWPA_EXTDATA_PATHOGENS}')
        csv_text = _exec_glowpa(f'cat {GLOWPA_EXTDATA_PATHOGENS}')

    reader = csv.DictReader(io.StringIO(csv_text))
    pathogens = [dict(row) for row in reader]
    _pathogens_cache = pathogens
    print(f'[config] Loaded {len(pathogens)} pathogen(s)')
    return pathogens


@frontend_app.route('/api/config/pathogens')
def frontend_get_pathogens():
    try:
        pathogens = _read_pathogens()
        return jsonify({'pathogens': pathogens})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Main-app (port 5000) mirrors for the treatment/geodata endpoints ──────────
# Vite proxies /api → port 5000 (main `app`), so these must exist there too.

@app.route('/api/scenarios/<scenario_id>/treatment', methods=['GET'])
def get_treatment(scenario_id):
    return frontend_get_treatment(scenario_id)

@app.route('/api/scenarios/<scenario_id>/treatment', methods=['PUT'])
def update_treatment(scenario_id):
    return frontend_update_treatment(scenario_id)

@app.route('/api/scenarios/<scenario_id>/geodata', methods=['GET'])
def get_geodata(scenario_id):
    return frontend_get_geodata(scenario_id)

@app.route('/api/scenarios/<scenario_id>/treatment-fractions', methods=['PUT'])
def update_treatment_fractions(scenario_id):
    return frontend_update_treatment_fractions(scenario_id)

@app.route('/api/scenarios/<scenario_id>/livestock-population', methods=['GET'])
def get_livestock_population(scenario_id):
    return frontend_get_livestock_population(scenario_id)

@app.route('/api/scenarios/<scenario_id>/livestock-population', methods=['PUT'])
def update_livestock_population(scenario_id):
    return frontend_update_livestock_population(scenario_id)

@app.route('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', methods=['GET'])
def get_livestock_csv(scenario_id, filename):
    return frontend_get_livestock_csv(scenario_id, filename)

@app.route('/api/scenarios/<scenario_id>/livestock-heads-by-area', methods=['GET'])
def get_livestock_heads_by_area(scenario_id):
    return frontend_livestock_heads_by_area(scenario_id)

@app.route('/api/scenarios/<scenario_id>/livestock-headcount', methods=['PUT'])
def put_livestock_headcount(scenario_id):
    return frontend_set_livestock_headcount(scenario_id)

@app.route('/api/scenarios/<scenario_id>/livestock-tif/<path:filename>', methods=['GET'])
def get_livestock_tif(scenario_id, filename):
    return frontend_livestock_tif(scenario_id, filename)

@app.route('/api/scenarios/<scenario_id>/input-raster/<path:filename>', methods=['GET'])
def get_input_raster(scenario_id, filename):
    return frontend_input_raster(scenario_id, filename)

@app.route('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', methods=['PUT'])
def update_livestock_csv(scenario_id, filename):
    return frontend_update_livestock_csv(scenario_id, filename)

@app.route('/api/config/pathogens')
def get_pathogens():
    return frontend_get_pathogens()


@frontend_app.route('/api/glowpa/start', methods=['POST'])
def frontend_start_glowpa():
    global glowpa_running
    try:
        import subprocess
        data = request.get_json() or {}
        case_study_id = data.get('case_study_id')
        
        # First check if container is already running
        check_result = subprocess.run(['docker', 'ps', '--filter', 'name=glowpa-container', '--format', '{{.Status}}'], 
                                    capture_output=True, text=True, timeout=10)
        
        if check_result.returncode == 0 and check_result.stdout.strip() and 'Up' in check_result.stdout:
            glowpa_running = True
            return jsonify({"status": "success", "message": "GloWPa container is already running"})
        
        # Try to start the container
        result = subprocess.run(['docker', 'start', 'glowpa-container'], 
                              capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            glowpa_running = True
            if case_study_id:
                case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
                if case_study:
                    message = f"GloWPa started for case study: {case_study['name']}"
                else:
                    message = "GloWPa started (case study not found)"
            else:
                message = "GloWPa container started successfully"
            return jsonify({"status": "success", "message": message})
        else:
            error_msg = result.stderr.strip() if result.stderr else "Failed to start container"
            return jsonify({"status": "error", "message": f"Failed to start GloWPa: {error_msg}"}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout while starting GloWPa container"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@frontend_app.route('/api/glowpa/stop', methods=['POST'])
def frontend_stop_glowpa():
    global glowpa_running
    try:
        import subprocess
        # Stop the actual Docker container
        result = subprocess.run(['docker', 'stop', 'glowpa-container'], 
                              capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            glowpa_running = False
            return jsonify({"status": "success", "message": "GloWPa container stopped successfully"})
        else:
            error_msg = result.stderr.strip() if result.stderr else "Failed to stop container"
            return jsonify({"status": "error", "message": f"Failed to stop GloWPa: {error_msg}"}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout while stopping GloWPa container"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@frontend_app.route('/api/glowpa-status')
def frontend_glowpa_status():
    try:
        import socket
        # Since Glowpa runs R and doesn't listen on HTTP, we just check if we can resolve the hostname
        # If the container is running and on the same network, the hostname should resolve
        socket.gethostbyname('glowpa-container')
        return jsonify({"glowpa_status": "connected", "message": "Container hostname resolves"})
    except socket.gaierror:
        return jsonify({"glowpa_status": "disconnected", "message": "Container hostname not found"})
    except Exception as e:
        return jsonify({"glowpa_status": "disconnected", "error": str(e)})

@app.route('/api/health')
def health_check():
    return jsonify({"status": "healthy", "message": "Backend is running"})

@app.route('/api/case-studies')
def get_case_studies():
    return jsonify({"case_studies": case_studies})

@app.route('/api/case-studies', methods=['POST'])
def create_case_study():
    data = request.get_json()
    case_study_id = str(uuid.uuid4())
    case_study_name = data.get("name", "Untitled Case Study")
    case_study_description = data.get("description", "")
    created_by = data.get("created_by", "Anonymous")
    
    # Create folder structure for the case study
    try:
        case_study_path, folder_name = create_case_study_folders(case_study_id, case_study_name)
        
        # Create datapackage.json metadata file
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
        case_studies.append(case_study)
        return jsonify({"case_study": case_study}), 201
    except Exception as e:
        return jsonify({"error": f"Failed to create case study folders: {str(e)}"}), 500

@app.route('/api/case-studies/<case_study_id>', methods=['DELETE'])
def delete_case_study(case_study_id):
    """Delete a case study and all its associated files"""
    try:
        # Find the case study
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            return jsonify({"error": "Case study not found"}), 404
        
        # Remove the case study folder and all its contents
        import shutil
        folder_path = case_study.get('folder_path')
        if folder_path and os.path.exists(folder_path):
            shutil.rmtree(folder_path)
        
        # Remove the case study from the list
        case_studies[:] = [cs for cs in case_studies if cs['id'] != case_study_id]
        
        # Remove associated scenarios
        global scenarios
        scenarios = [s for s in scenarios if s.get('case_study_id') != case_study_id]
        
        return jsonify({"message": "Case study deleted successfully"}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to delete case study: {str(e)}"}), 500

@app.route('/api/case-studies/upload', methods=['POST'])
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

@frontend_app.route('/api/case-studies/<case_study_id>/datapackage')
def frontend_get_case_study_datapackage(case_study_id):
    """Get the datapackage.json content for a case study"""
    try:
        print(f"[DEBUG] Looking for case study with ID: '{case_study_id}'")
        print(f"[DEBUG] Available case studies: {[cs.get('id', 'no-id') for cs in case_studies]}")
        
        # Find the case study
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            print(f"[DEBUG] Case study not found for ID: '{case_study_id}'")
            return jsonify({"error": "Case study not found"}), 404
        
        print(f"[DEBUG] Found case study: {case_study.get('name', 'unknown')}")
        
        # Read the datapackage.json file
        datapackage_path = os.path.join(case_study['folder_path'], 'datapackage.json')
        print(f"[DEBUG] Looking for datapackage at: {datapackage_path}")
        
        if os.path.exists(datapackage_path):
            with open(datapackage_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)
            # Detect admin level from baseline geodata shapefile (augment response, not stored)
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

@frontend_app.route('/api/case-studies/<case_study_id>/datapackage', methods=['PUT'])
def frontend_update_case_study_datapackage(case_study_id):
    """Update the datapackage.json content for a case study.

    If the `name` slug in the new datapackage differs from the current folder name
    prefix, the case-study folder is renamed on disk so the filesystem stays in sync
    with the human-readable title.  The case_study_id is re-persisted inside
    datapackage.json so it survives the rename.
    """
    try:
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            return jsonify({"error": "Case study not found"}), 404

        datapackage_data = request.get_json()
        if not datapackage_data:
            return jsonify({"error": "No datapackage data provided"}), 400

        # Always embed the stable case_study_id so it survives future reloads
        datapackage_data['case_study_id'] = case_study_id

        # Read the current datapackage to compare the slug (name field)
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
            # Build new folder name: keep the 8-char hash suffix from the current folder
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

        # Update in-memory name from title
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

# Scenarios endpoints
@app.route('/api/scenarios')
def get_scenarios():
    """Get all scenarios or scenarios for a specific case study"""
    case_study_id = request.args.get('case_study_id')

    if case_study_id:
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study or not case_study.get('folder_path'):
            return jsonify({"scenarios": []})
        loaded = load_scenarios_from_metadata_csv(case_study['folder_path'])
        for s in loaded:
            s['case_study_id'] = case_study_id
        return jsonify({"scenarios": loaded})
    else:
        all_scenarios = []
        for case_study in case_studies:
            cs_path = case_study.get('folder_path')
            if cs_path:
                loaded = load_scenarios_from_metadata_csv(cs_path)
                for s in loaded:
                    s['case_study_id'] = case_study['id']
                all_scenarios.extend(loaded)
        return jsonify({"scenarios": all_scenarios})

@app.route('/api/scenarios', methods=['POST'])
def create_scenario():
    """Create a new scenario folder (copy of baseline) and register it in scenario_metadata.csv."""
    try:
        data = request.get_json()
        print(f"[DEBUG] Creating scenario with data: {data}")

        case_study_id = data.get('case_study_id')
        if not case_study_id:
            return jsonify({"error": "Case study ID is required"}), 400

        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            return jsonify({"error": "Case study not found"}), 404

        scenario_name       = data.get('name', 'New Scenario')
        ssp                 = data.get('ssp', '')
        pathogen            = data.get('pathogen', '')
        year                = data.get('year', '')
        notes               = data.get('notes', data.get('description', ''))
        projection_method   = data.get('projectionMethod', '')

        case_study_path = case_study['folder_path']

        # Build a unique folder name for this scenario
        raw_folder = generate_scenario_folder_name(case_study['name'], ssp, pathogen, year)
        folder_name = raw_folder
        counter = 1
        while os.path.exists(os.path.join(case_study_path, 'input', folder_name)):
            folder_name = f"{raw_folder}_{counter}"
            counter += 1

        # Copy baseline → new scenario folder
        create_scenario_folder(case_study_path, folder_name)

        # Auto-calculate projections via external API when requested
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

        # Persist in scenario_metadata.csv
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

@app.route('/api/scenarios/<scenario_id>', methods=['PUT'])
def update_scenario(scenario_id):
    """Update an existing scenario's metadata in scenario_metadata.csv."""
    try:
        data = request.get_json()

        # Find the case study whose metadata CSV contains this scenario
        target_case_study = None
        for case_study in case_studies:
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
                break

        write_scenario_metadata_csv(meta_path, rows)

        return jsonify(updated_row or {}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to update scenario: {str(e)}"}), 500


@app.route('/api/scenarios/<scenario_id>/isodata', methods=['GET'])
def get_scenario_isodata(scenario_id):
    """Return isodata.csv rows for a scenario, read fresh from disk."""
    try:
        target_case_study = None
        target_folder = None
        for case_study in case_studies:
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


@app.route('/api/scenarios/<scenario_id>/summary', methods=['GET'])
def get_scenario_summary(scenario_id):
    """Return the contents of summary.json for a scenario (if it exists).

    summary.json is written by the WaterPath projection API into each
    category sub-folder inside input/<scenario_folder>/.  We look in all
    known category sub-folders and merge the results so the frontend can
    display per-schema assumptions.

    Returns a dict keyed by schema name (e.g. "population") whose values
    are the parsed JSON objects, or an empty dict {} when no summary exists.
    """
    try:
        target_case_study = None
        target_folder = None
        for case_study in case_studies:
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

        # summary.json is written by the WaterPath projection API into each
        # category sub-folder.  It contains an array of schema objects.
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
                        # New format: { "schemas": [...] } — unwrap the inner list
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


@app.route('/api/scenarios/<scenario_id>/isodata', methods=['PUT'])
def update_scenario_isodata(scenario_id):
    """Patch editable columns (population, fractions) in isodata.csv for a scenario."""
    try:
        data = request.get_json()
        updated_rows = data.get('rows', [])

        # Locate the scenario's folder path
        target_case_study = None
        target_folder = None
        for case_study in case_studies:
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

        # Read-only identifier columns that must never be overwritten
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


@app.route('/api/scenarios/<scenario_id>/clone', methods=['POST'])
def clone_scenario(scenario_id):
    """Clone an existing scenario: copy its input folder and register a new metadata entry.

    Optional JSON body:
      { "name": "New name for the clone" }

    The clone gets a fresh UUID, a unique folder name derived from the source folder,
    and is never a baseline. Output files are intentionally NOT copied.
    """
    try:
        target_case_study = None
        target_row = None

        for case_study in case_studies:
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

        cs_path = target_case_study['folder_path']
        src_folder = target_row.get('folder', '')
        src_input = os.path.join(cs_path, 'input', src_folder)

        # Build a unique destination folder name
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


@frontend_app.route('/api/scenarios/<scenario_id>/clone', methods=['POST'])
def frontend_clone_scenario(scenario_id):
    """Clone a scenario (frontend endpoint)"""
    return clone_scenario(scenario_id)


@app.route('/api/scenarios/<scenario_id>', methods=['DELETE'])
def delete_scenario(scenario_id):
    """Delete a non-baseline scenario: remove its folder and metadata row."""
    try:
        print(f"[DEBUG] Deleting scenario: {scenario_id}")

        target_case_study = None
        target_row = None

        for case_study in case_studies:
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

        # Remove the scenario folder
        if folder:
            scenario_folder = os.path.join(cs_path, 'input', folder)
            if os.path.exists(scenario_folder):
                shutil.rmtree(scenario_folder)
                print(f"[DEBUG] Removed scenario folder: {scenario_folder}")

        # Remove the row from scenario_metadata.csv
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

# Serve React app (fallback for production)
def load_existing_case_studies():
    """Scan DATA_DIR and rebuild the in-memory case_studies list from disk."""
    global case_studies
    case_studies = []

    print(f"Loading case studies from: {DATA_DIR}")

    if not os.path.exists(DATA_DIR):
        print(f"Data directory does not exist: {DATA_DIR}")
        return

    for item in sorted(os.listdir(DATA_DIR)):
        item_path = os.path.join(DATA_DIR, item)
        if not os.path.isdir(item_path):
            continue
        if item in ('input', 'output', 'config'):
            continue
        # Valid case-study folders contain a datapackage.json
        datapackage_path = os.path.join(item_path, 'datapackage.json')
        if not os.path.exists(datapackage_path):
            continue

        try:
            with open(datapackage_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)

            # Use persisted ID from datapackage.json if available (survives folder renames);
            # otherwise derive from folder name for backwards compatibility.
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

            # Count scenarios from scenario_metadata.csv
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
            case_studies.append(case_study)
            print(f"Loaded case study: {case_study['name']} ({scenario_count} scenario(s))")

        except Exception as e:
            print(f"Error loading case study from {item}: {e}")

# Load existing case studies when the app starts
load_existing_case_studies()

# ── Analytics endpoints ──────────────────────────────────────────────────────

@frontend_app.route('/api/case-studies/<case_study_id>/analytics')
def frontend_get_analytics(case_study_id):
    """Return scenarios for a case study, enriched with readiness data."""
    try:
        cs = next((c for c in case_studies if c['id'] == case_study_id), None)
        if not cs:
            return jsonify({'error': 'Case study not found'}), 404
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        scenarios_list = load_scenarios_from_metadata_csv(cs_path)
        result = []
        for scenario in scenarios_list:
            scenario['case_study_id'] = case_study_id
            # Drop heavy data field
            scenario.pop('data', None)
            folder = scenario.get('folder', 'baseline')
            pathogen = scenario.get('pathogen', '')
            readiness = check_scenario_readiness(cs_path, folder, pathogen)
            yaml_filename = f"{folder}_config.yaml"
            yaml_path = os.path.join(cs_path, 'config', yaml_filename)
            readiness['yaml_exists'] = os.path.exists(yaml_path)
            readiness['yaml_filename'] = yaml_filename
            scenario['readiness'] = readiness
            # Check if output files exist for this scenario
            output_dir = os.path.join(cs_path, 'output', folder)
            scenario['has_outputs'] = (
                os.path.isdir(output_dir) and
                any(f.endswith(('.csv', '.tif'))
                    for f in os.listdir(output_dir)
                    if not f.endswith('.log'))
            )
            ls = _detect_livestock_module(cs_path, folder)
            scenario['has_livestock'] = ls is not None and bool(ls.get('animals'))
            result.append(scenario)
        return jsonify({'scenarios': result, 'case_study': cs}), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def _num(v, default=0.0):
    try:
        if v is None:
            return default
        s = str(v).strip()
        if s == '':
            return default
        return float(s)
    except Exception:
        return default


def _clamp01(v):
    return max(0.0, min(1.0, _num(v, 0.0)))


def _read_csv_rows(path):
    if not path or not os.path.exists(path):
        return [], []
    with open(path, 'r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return [dict(r) for r in reader], list(reader.fieldnames or [])


def _weighted_split_mean(rows, urb_field, rur_field):
    weighted_sum = 0.0
    weight = 0.0
    for row in rows:
        pop = max(0.0, _num(row.get('population'), 0.0))
        urban = _clamp01(row.get('fraction_urban_pop'))
        rural = 1.0 - urban
        val = urban * _num(row.get(urb_field), 0.0) + rural * _num(row.get(rur_field), 0.0)
        weighted_sum += pop * val
        weight += pop
    return (weighted_sum / weight) if weight > 0 else None


def _weighted_sanitation_share(rows, source_fields):
    weighted_sum = 0.0
    weight = 0.0
    for row in rows:
        pop = max(0.0, _num(row.get('population'), 0.0))
        urban = _clamp01(row.get('fraction_urban_pop'))
        rural = 1.0 - urban
        urb_share = sum(_num(row.get(f'{src}_urb'), 0.0) for src in source_fields)
        rur_share = sum(_num(row.get(f'{src}_rur'), 0.0) for src in source_fields)
        val = urban * urb_share + rural * rur_share
        weighted_sum += pop * val
        weight += pop
    return (weighted_sum / weight) if weight > 0 else None


def _normalize_treatment_type(raw):
    v = str(raw or '').strip().lower()
    if 'quaternary' in v:
        return 'quaternary'
    if 'tertiary' in v:
        return 'tertiary'
    if 'secondary' in v:
        return 'secondary'
    if 'primary' in v:
        return 'primary'
    return None


def _compute_livestock_mean_heads(ls_dir):
    """Return mean total heads across available animals (absolute), or None."""
    animals_dir = os.path.join(ls_dir, 'animals')
    if not os.path.isdir(animals_dir):
        return None
    tif_files = [
        f for f in os.listdir(animals_dir)
        if f.lower().endswith('_heads.tif')
    ]
    if not tif_files:
        return None

    try:
        import numpy as np
        import rasterio
    except Exception:
        return None

    totals = []
    for fname in tif_files:
        tif_path = os.path.join(animals_dir, fname)
        try:
            with rasterio.open(tif_path) as src:
                arr = src.read(1).astype(float)
                nd = src.nodata
            if nd is not None:
                arr[arr == float(nd)] = np.nan
            arr[arr < 0] = np.nan
            total = float(np.nansum(arr))
            if np.isfinite(total):
                totals.append(total)
        except Exception:
            continue

    if not totals:
        return None
    return float(sum(totals) / len(totals))


def _compute_driver_metrics_for_scenario(cs_path, folder):
    iso_path = _resolve_data_path(cs_path, folder, 'isodata.csv')
    iso_rows, _ = _read_csv_rows(iso_path)

    # Population
    total_population = sum(max(0.0, _num(r.get('population'), 0.0)) for r in iso_rows)
    mean_urban_fraction = _weighted_split_mean(
        [{**r, 'fraction_urban_pop_urb': r.get('fraction_urban_pop', 0), 'fraction_urban_pop_rur': r.get('fraction_urban_pop', 0)} for r in iso_rows],
        'fraction_urban_pop_urb',
        'fraction_urban_pop_rur',
    )
    mean_under5_fraction = _weighted_split_mean(
        [{**r, 'fraction_pop_under5_urb': r.get('fraction_pop_under5', 0), 'fraction_pop_under5_rur': r.get('fraction_pop_under5', 0)} for r in iso_rows],
        'fraction_pop_under5_urb',
        'fraction_pop_under5_rur',
    )
    if iso_rows:
        pop_weight = sum(max(0.0, _num(r.get('population'), 0.0)) for r in iso_rows)
        if pop_weight > 0:
            mean_hdi = sum(max(0.0, _num(r.get('population'), 0.0)) * _num(r.get('hdi'), 0.0) for r in iso_rows) / pop_weight
        else:
            hdi_vals = [_num(r.get('hdi'), None) for r in iso_rows if str(r.get('hdi', '')).strip() != '']
            hdi_vals = [v for v in hdi_vals if v is not None]
            mean_hdi = (sum(hdi_vals) / len(hdi_vals)) if hdi_vals else None
    else:
        mean_hdi = None

    # Sanitation groups
    improved_sources = ['flushSewer', 'flushSeptic', 'flushPit', 'pitSlab', 'compostingToilet', 'containerBased']
    unimproved_sources = ['pitNoSlab', 'bucketLatrine', 'hangingToilet', 'flushOpen', 'flushUnknown', 'other']
    od_sources = ['openDefecation']

    improved_share = _weighted_sanitation_share(iso_rows, improved_sources)
    unimproved_share = _weighted_sanitation_share(iso_rows, unimproved_sources)
    od_share = _weighted_sanitation_share(iso_rows, od_sources)

    # Wastewater treatment
    sewage_treated = _weighted_split_mean(iso_rows, 'sewageTreated_urb', 'sewageTreated_rur')
    fecal_sludge_treated = _weighted_split_mean(iso_rows, 'fecalSludgeTreated_urb', 'fecalSludgeTreated_rur')
    wwtp_mode = _detect_wwtp_mode(cs_path, folder).lower()  # 'point' | 'area'

    point_facilities = None
    point_total_capacity = None
    share_primary = None
    share_secondary = None
    share_tertiary = None
    share_quaternary = None

    treatment_path = _resolve_data_path(cs_path, folder, 'treatment.csv')
    treatment_rows, treatment_fields = _read_csv_rows(treatment_path)

    if wwtp_mode == 'point':
        rows = [r for r in treatment_rows if str(r.get('lon', '')).strip() and str(r.get('lat', '')).strip()]
        point_facilities = float(len(rows))
        cap_by_type = {'primary': 0.0, 'secondary': 0.0, 'tertiary': 0.0, 'quaternary': 0.0}
        total_cap = 0.0
        for row in rows:
            cap = max(0.0, _num(row.get('capacity'), 0.0))
            ttype = _normalize_treatment_type(row.get('treatment_type'))
            total_cap += cap
            if ttype:
                cap_by_type[ttype] += cap
        point_total_capacity = total_cap
        if total_cap > 0:
            share_primary = 100.0 * cap_by_type['primary'] / total_cap
            share_secondary = 100.0 * cap_by_type['secondary'] / total_cap
            share_tertiary = 100.0 * cap_by_type['tertiary'] / total_cap
            share_quaternary = 100.0 * cap_by_type['quaternary'] / total_cap
    else:
        # AREA mode: derive treatment shares from area fractions where available.
        frac_fields = [
            'FractionPrimarytreatment',
            'FractionSecondarytreatment',
            'FractionTertiarytreatment',
            'FractionQuaternarytreatment',
        ]
        if iso_rows and any(f in (iso_rows[0].keys() if iso_rows else []) for f in frac_fields):
            weighted = {f: 0.0 for f in frac_fields}
            weight = 0.0
            for row in iso_rows:
                pop = max(0.0, _num(row.get('population'), 0.0))
                weight += pop
                for f in frac_fields:
                    weighted[f] += pop * _num(row.get(f), 0.0)
            if weight > 0:
                share_primary = 100.0 * (weighted['FractionPrimarytreatment'] / weight)
                share_secondary = 100.0 * (weighted['FractionSecondarytreatment'] / weight)
                share_tertiary = 100.0 * (weighted['FractionTertiarytreatment'] / weight)
                share_quaternary = 100.0 * (weighted['FractionQuaternarytreatment'] / weight)
        elif treatment_rows and 'FractionPrimarytreatment' in treatment_fields:
            def _mean_col(col):
                vals = [_num(r.get(col), None) for r in treatment_rows if str(r.get(col, '')).strip() != '']
                vals = [v for v in vals if v is not None]
                return (sum(vals) / len(vals)) if vals else 0.0
            share_primary = 100.0 * _mean_col('FractionPrimarytreatment')
            share_secondary = 100.0 * _mean_col('FractionSecondarytreatment')
            share_tertiary = 100.0 * _mean_col('FractionTertiarytreatment')
            share_quaternary = 100.0 * _mean_col('FractionQuaternarytreatment')

    # Livestock + production systems
    ls = _detect_livestock_module(cs_path, folder)
    livestock_mean_growth = None
    production_progress_intensive = None
    if ls:
        livestock_mean_growth = _compute_livestock_mean_heads(ls['dir'])
        ps_rows, ps_fields = _read_csv_rows(os.path.join(ls['dir'], 'production_systems.csv'))
        intensive_fields = [f for f in ps_fields if f.endswith('_i')]
        vals = []
        for row in ps_rows:
            for f in intensive_fields:
                vals.append(_num(row.get(f), None))
        vals = [v for v in vals if v is not None]
        if vals:
            production_progress_intensive = 100.0 * (sum(vals) / len(vals))

    return {
        'wwtp_mode': wwtp_mode,
        'metrics': {
            'population_total': total_population if total_population > 0 else None,
            'population_urban_mean_pct': (100.0 * mean_urban_fraction) if mean_urban_fraction is not None else None,
            'population_under5_mean_pct': (100.0 * mean_under5_fraction) if mean_under5_fraction is not None else None,
            'population_hdi_mean': mean_hdi,
            'sanitation_improved_pct': (100.0 * improved_share) if improved_share is not None else None,
            'sanitation_unimproved_pct': (100.0 * unimproved_share) if unimproved_share is not None else None,
            'sanitation_open_defecation_pct': (100.0 * od_share) if od_share is not None else None,
            'wastewater_sewage_treated_pct': (100.0 * sewage_treated) if sewage_treated is not None else None,
            'wastewater_fecal_sludge_treated_pct': (100.0 * fecal_sludge_treated) if fecal_sludge_treated is not None else None,
            'wastewater_facility_count': point_facilities,
            'wastewater_total_capacity': point_total_capacity,
            'wastewater_share_primary_pct': share_primary,
            'wastewater_share_secondary_pct': share_secondary,
            'wastewater_share_tertiary_pct': share_tertiary,
            'wastewater_share_quaternary_pct': share_quaternary,
            'livestock_mean_population_growth': livestock_mean_growth,
            'production_mean_progress_intensive_pct': production_progress_intensive,
        },
    }


@frontend_app.route('/api/case-studies/<case_study_id>/driver-comparison', methods=['GET'])
def frontend_get_driver_comparison(case_study_id):
    """Return per-scenario driver metrics used by the Analytics driver-change dialog."""
    try:
        cs = next((c for c in case_studies if c['id'] == case_study_id), None)
        if not cs:
            return jsonify({'error': 'Case study not found'}), 404

        cs_path = cs['folder_path']
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        if not os.path.exists(meta_path):
            return jsonify({'baseline_scenario_id': None, 'metrics': [], 'scenarios': []}), 200

        include_ids = [s.strip() for s in (request.args.get('scenario_ids', '') or '').split(',') if s.strip()]
        include_set = set(include_ids) if include_ids else None

        scenarios_out = []
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                scenario_id = row.get('scenario_id')
                if not scenario_id:
                    continue
                if include_set is not None and scenario_id not in include_set:
                    continue

                folder = row.get('folder', 'baseline')
                derived = _compute_driver_metrics_for_scenario(cs_path, folder)
                scenarios_out.append({
                    'id': scenario_id,
                    'name': row.get('name', 'Unnamed scenario'),
                    'year': row.get('year', ''),
                    'is_baseline': str(row.get('is_baseline', 'False')).lower() in ('true', '1', 'yes'),
                    'wwtp_mode': derived['wwtp_mode'],
                    'metrics': derived['metrics'],
                })

        baseline = next((s for s in scenarios_out if s.get('is_baseline')), None)
        if baseline is None:
            baseline = next((s for s in scenarios_out if str(s.get('name', '')).strip().lower() == 'baseline'), None)
        if baseline is None and scenarios_out:
            def _year_key(s):
                try:
                    return int(s.get('year') or 0)
                except Exception:
                    return 0
            baseline = sorted(scenarios_out, key=_year_key)[0]

        metric_defs = [
            {'key': 'population_total', 'driver': 'Population', 'label': 'Total population', 'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
            {'key': 'population_urban_mean_pct', 'driver': 'Population', 'label': 'Mean urban fraction', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'neutral'},
            {'key': 'population_under5_mean_pct', 'driver': 'Population', 'label': 'Mean under-5 fraction', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'neutral'},
            {'key': 'population_hdi_mean', 'driver': 'Population', 'label': 'Mean HDI', 'delta_mode': 'absolute', 'value_format': 'hdi', 'color_direction': 'positive_good'},
            {'key': 'sanitation_improved_pct', 'driver': 'Sanitation', 'label': 'Improved %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'sanitation_unimproved_pct', 'driver': 'Sanitation', 'label': 'Unimproved %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'negative_good'},
            {'key': 'sanitation_open_defecation_pct', 'driver': 'Sanitation', 'label': 'Open defecation %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'negative_good'},
            {'key': 'wastewater_sewage_treated_pct', 'driver': 'Wastewater treatment', 'label': 'Sewage treated %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'wastewater_fecal_sludge_treated_pct', 'driver': 'Wastewater treatment', 'label': 'Fecal sludge treated %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'wastewater_facility_count', 'driver': 'Wastewater treatment', 'label': 'Number of treatment facilities', 'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'positive_good'},
            {'key': 'wastewater_total_capacity', 'driver': 'Wastewater treatment', 'label': 'Total treatment capacity', 'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'positive_good'},
            {'key': 'wastewater_share_primary_pct', 'driver': 'Wastewater treatment', 'label': 'Share of Primary', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'negative_good'},
            {'key': 'wastewater_share_secondary_pct', 'driver': 'Wastewater treatment', 'label': 'Share of Secondary', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'wastewater_share_tertiary_pct', 'driver': 'Wastewater treatment', 'label': 'Share of Tertiary', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'wastewater_share_quaternary_pct', 'driver': 'Wastewater treatment', 'label': 'Share of Quaternary', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
            {'key': 'livestock_mean_population_growth', 'driver': 'Livestock population', 'label': 'Mean Population growth (all animals)', 'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
            {'key': 'production_mean_progress_intensive_pct', 'driver': 'Production systems', 'label': 'Mean progress towards intensive', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'neutral'},
        ]

        return jsonify({
            'baseline_scenario_id': baseline.get('id') if baseline else None,
            'metrics': metric_defs,
            'scenarios': scenarios_out,
        }), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


# ── Output file endpoints ────────────────────────────────────────────────────

def _png_from_rgba(rgba):
    """Encode an H×W×4 uint8 numpy array to PNG bytes (pure stdlib, no PIL)."""
    import struct, zlib as zlib_mod
    h, w = rgba.shape[:2]

    def _chunk(tag, data):
        b = tag + data
        return struct.pack('>I', len(data)) + b + struct.pack('>I', zlib_mod.crc32(b) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))
    idat = zlib_mod.compress(raw, 6)
    return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', idat) + _chunk(b'IEND', b'')


# YlOrRd colormap breakpoints (position 0-1 → R,G,B 0-255)
_YLORRD = [
    (0.000, 255, 255, 204),
    (0.125, 255, 237, 160),
    (0.250, 254, 217, 118),
    (0.375, 254, 178,  76),
    (0.500, 253, 141,  60),
    (0.625, 252,  78,  42),
    (0.750, 227,  26,  28),
    (0.875, 189,   0,  38),
    (1.000, 128,   0,  38),
]


def _apply_diverg(diff_pct_2d):
    """Apply diverging colour map (matching frontend diffColor) to a diff % 2D array.
    Negative (decrease) → green; positive (increase) → red. Saturates at ±100 %.
    Values within ±2 % → near-white. NaN → transparent.
    """
    import numpy as np
    flat = diff_pct_2d.flatten()
    valid = ~np.isnan(flat)
    pct = np.where(valid, flat, 0.0)
    t = np.clip(np.abs(pct) / 100.0, 0.0, 1.0)
    # Matches frontend diffColor():
    #   increase: rgb(lerp(254,153,t), lerp(202,27,t), lerp(202,27,t))
    #   decrease: rgb(lerp(187,20,t), lerp(247,83,t), lerp(208,45,t))
    is_pos = pct >= 0
    r = np.where(is_pos, 254 + t * (153 - 254), 187 + t * (20 - 187))
    g = np.where(is_pos, 202 + t * (27  - 202), 247 + t * (83 - 247))
    b = np.where(is_pos, 202 + t * (27  - 202), 208 + t * (45 - 208))
    near_zero = np.abs(pct) < 2
    r = np.where(near_zero, 243.0, r)
    g = np.where(near_zero, 244.0, g)
    b = np.where(near_zero, 246.0, b)
    a = np.where(valid, 200, 0).astype(np.uint8)
    h2, w2 = diff_pct_2d.shape
    return np.stack([r.astype(np.uint8), g.astype(np.uint8), b.astype(np.uint8), a],
                    axis=-1).reshape(h2, w2, 4)


def _apply_ylorrd(norm_2d):
    """Apply YlOrRd colormap. norm_2d is float H×W in [0,1], NaN → transparent."""
    import numpy as np
    pos = [c[0] for c in _YLORRD]
    Rs  = [c[1] for c in _YLORRD]
    Gs  = [c[2] for c in _YLORRD]
    Bs  = [c[3] for c in _YLORRD]
    flat = norm_2d.flatten()
    valid = ~np.isnan(flat)
    clipped = np.clip(np.where(valid, flat, 0.0), 0.0, 1.0)
    r = np.interp(clipped, pos, Rs).astype(np.uint8)
    g = np.interp(clipped, pos, Gs).astype(np.uint8)
    b = np.interp(clipped, pos, Bs).astype(np.uint8)
    a = np.where(valid, 255, 0).astype(np.uint8)
    h, w = norm_2d.shape
    return np.stack([r, g, b, a], axis=-1).reshape(h, w, 4)


@frontend_app.route('/api/scenarios/<scenario_id>/output-files')
def frontend_output_files(scenario_id):
    """List non-log output files for a scenario's output folder."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        output_dir = os.path.join(cs['folder_path'], 'output', folder)
        if not os.path.isdir(output_dir):
            return jsonify({'files': []}), 200
        files = sorted(f for f in os.listdir(output_dir) if not f.endswith('.log'))
        return jsonify({'files': files}), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/raster-area-stats/<path:filename>')
def frontend_raster_area_stats(scenario_id, filename):
    """Return per-ISO zonal statistics (min/max/mean/total/count) from a raster."""
    import numpy as np
    try:
        import rasterio
        from rasterio.mask import mask as rio_mask
        from rasterio.warp import transform_geom
        from rasterio.crs import CRS
        import fiona

        cs, folder = _locate_scenario(scenario_id)
        tif_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(tif_path):
            return jsonify({'error': 'File not found'}), 404

        geo_dir = os.path.join(cs['folder_path'], 'input', 'baseline', 'geodata')
        if not os.path.isdir(geo_dir):
            return jsonify({'error': 'No geodata folder'}), 404
        shp_files = [f for f in os.listdir(geo_dir) if f.endswith('.shp')]
        if not shp_files:
            return jsonify({'error': 'No shapefile found'}), 404
        shp_path = os.path.join(geo_dir, shp_files[0])

        result = {}
        with rasterio.open(tif_path) as src:
            raster_crs = src.crs or CRS.from_epsg(4326)
            nodata = src.nodata
            wgs84_epsg = 'EPSG:4326'
            with fiona.open(shp_path) as shp:
                shp_crs_str = shp.crs_wkt or wgs84_epsg
                for idx, feat in enumerate(shp):
                    iso = str(idx + 1)  # 1-based index, matching geodata endpoint
                    geom = feat['geometry']
                    # Reproject geometry to raster CRS if needed
                    try:
                        geom_raster = transform_geom(shp_crs_str, raster_crs.to_wkt(), geom)
                    except Exception:
                        geom_raster = geom
                    try:
                        out, _ = rio_mask(src, [geom_raster], crop=True, all_touched=True, filled=True, nodata=np.nan)
                        vals = out[0].astype(float)
                        if nodata is not None:
                            vals[vals == float(nodata)] = np.nan
                        vals[vals <= 0] = np.nan
                        vals[vals > 1e30] = np.nan
                        valid = vals[~np.isnan(vals)]
                        if len(valid):
                            result[iso] = {
                                'min':   float(valid.min()),
                                'max':   float(valid.max()),
                                'mean':  float(valid.mean()),
                                'total': float(valid.sum()),
                                'count': int(len(valid)),
                            }
                        else:
                            result[iso] = None
                    except Exception:
                        result[iso] = None
        return jsonify(result), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/output-raster/<path:filename>')
def frontend_output_raster(scenario_id, filename):
    """Serve the raw GeoTIFF for client-side rendering with georaster-layer-for-leaflet."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        tif_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(tif_path):
            return jsonify({'error': 'File not found'}), 404
        from flask import send_file
        return send_file(tif_path, mimetype='image/tiff', as_attachment=False,
                         download_name=filename)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/raster-diff')
def frontend_raster_diff():
    """Return a colourised diff raster (B − A) / A × 100 % for two scenarios.

    Query params:
      scA   – scenario ID for the baseline raster
      scB   – scenario ID for the comparison raster
      file  – raster filename (relative to each scenario's output folder)

    Returns {image: base64-PNG, bounds: {south,north,east,west}} using a
    diverging green/red colour map (green = decrease, red = increase).
    """
    import base64
    import numpy as np

    sc_a   = request.args.get('scA')
    sc_b   = request.args.get('scB')
    fname  = request.args.get('file')
    fname_a = request.args.get('fileA') or fname
    fname_b = request.args.get('fileB') or fname
    if not sc_a or not sc_b or not fname_a or not fname_b:
        return jsonify({'error': 'scA, scB and file (or fileA+fileB) are required'}), 400

    try:
        import rasterio
        from rasterio.warp import transform_bounds, reproject, Resampling, calculate_default_transform
        from rasterio.crs import CRS

        wgs84    = CRS.from_epsg(4326)
        mercator = CRS.from_epsg(3857)

        def _load_merc(sc_id, tif_fname):
            cs, folder = _locate_scenario(sc_id)
            tif_path = os.path.join(cs['folder_path'], 'output', folder, tif_fname)
            if not os.path.exists(tif_path):
                raise ValueError(f'File not found for scenario {sc_id}: {tif_fname}')
            with rasterio.open(tif_path) as src:
                data    = src.read(1).astype(float)
                src_crs = src.crs or wgs84
                src_tf  = src.transform
                src_nd  = src.nodata
                l, b_b, r, t = src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top
            # Mask nodata/negatives BEFORE any reprojection
            if src_nd is not None:
                data[data == src_nd] = np.nan
            data[(data <= 0) | (data > 1e30)] = np.nan
            # Only reproject if not already in WGS-84; use nearest to avoid averaging
            if src_crs and src_crs.to_epsg() != 4326:
                tmp_tf, tmp_w, tmp_h = calculate_default_transform(
                    src_crs, wgs84, data.shape[1], data.shape[0], left=l, bottom=b_b, right=r, top=t)
                tmp = np.full((tmp_h, tmp_w), np.nan, dtype=float)
                reproject(source=data, destination=tmp, src_transform=src_tf, src_crs=src_crs,
                          dst_transform=tmp_tf, dst_crs=wgs84, resampling=Resampling.nearest,
                          src_nodata=np.nan, dst_nodata=np.nan)
                data, src_tf = tmp, tmp_tf
                l, b_b, r, t = rasterio.transform.array_bounds(tmp_h, tmp_w, tmp_tf)
            return data, src_tf, (data.shape[0], data.shape[1]), (l, b_b, r, t)

        data_a, tf_a, shape_a, bounds_a = _load_merc(sc_a, fname_a)
        data_b, tf_b, shape_b, bounds_b = _load_merc(sc_b, fname_b)

        # Align B onto A's grid if they differ (nearest so no averaging)
        if data_b.shape != data_a.shape:
            tmp = np.full(data_a.shape, np.nan, dtype=float)
            reproject(source=data_b, destination=tmp,
                      src_transform=tf_b, src_crs=wgs84,
                      dst_transform=tf_a, dst_crs=wgs84,
                      resampling=Resampling.nearest,
                      src_nodata=np.nan, dst_nodata=np.nan)
            data_b = tmp

        with np.errstate(divide='ignore', invalid='ignore'):
            diff_pct = np.where(
                (data_a > 0) & ~np.isnan(data_a) & ~np.isnan(data_b),
                (data_b - data_a) / data_a * 100.0,
                np.nan)

        l, b_b2, r, t = bounds_a

        # Reproject the diff image to Web Mercator (EPSG:3857) so that it aligns
        # correctly with Leaflet's Mercator base map via ImageOverlay.
        # A plain WGS-84 pixel grid displayed with lat/lon bounds on a Mercator map
        # appears shifted northward for large study areas because Mercator stretches
        # higher latitudes more than lower ones.  Pre-distorting to EPSG:3857 here
        # compensates for that linear-stretch artefact.
        merc3857 = CRS.from_epsg(3857)
        merc_tf, merc_w, merc_h = calculate_default_transform(
            wgs84, merc3857, data_a.shape[1], data_a.shape[0],
            left=l, bottom=b_b2, right=r, top=t)
        diff_merc = np.full((merc_h, merc_w), np.nan, dtype=float)
        reproject(
            source=diff_pct, destination=diff_merc,
            src_transform=tf_a, src_crs=wgs84,
            dst_transform=merc_tf, dst_crs=merc3857,
            resampling=Resampling.nearest,
            src_nodata=np.nan, dst_nodata=np.nan)
        merc_b = rasterio.transform.array_bounds(merc_h, merc_w, merc_tf)
        wgs_b  = transform_bounds(merc3857, wgs84, *merc_b)
        geo_bounds = {'south': float(wgs_b[1]), 'west': float(wgs_b[0]),
                      'north': float(wgs_b[3]), 'east': float(wgs_b[2])}

        rgba      = _apply_diverg(diff_merc)
        png_bytes = _png_from_rgba(rgba)
        b64       = base64.b64encode(png_bytes).decode()
        return jsonify({'image': b64, 'bounds': geo_bounds}), 200

    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/output-csv-data/<path:filename>')
def frontend_output_csv_data(scenario_id, filename):
    """Return column totals + ranked sources from an output CSV."""
    import csv as csvmod
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(csv_path):
            return jsonify({'error': 'File not found'}), 404

        rows = []
        with open(csv_path, 'r', encoding='utf-8', newline='') as f:
            reader = csvmod.DictReader(f)
            cols = reader.fieldnames or []
            for row in reader:
                rows.append(row)

        value_cols = [c for c in cols if c.lower() != 'iso']
        totals = {}
        for col in value_cols:
            try:
                totals[col] = sum(float(r[col]) for r in rows if r.get(col))
            except (ValueError, KeyError):
                totals[col] = 0.0

        ranked = sorted(
            [{'source': k, 'total': v} for k, v in totals.items() if v > 0],
            key=lambda x: x['total'], reverse=True,
        )

        # per-ISO totals: sum all value columns per row
        iso_totals = {}
        iso_rows = {}
        for row in rows:
            iso_key = str(row.get('iso', row.get('ISO', ''))).strip()
            if not iso_key:
                continue
            try:
                iso_totals[iso_key] = sum(float(row[c]) for c in value_cols if row.get(c))
            except (ValueError, KeyError):
                iso_totals[iso_key] = 0.0
            iso_rows[iso_key] = {}
            for c in value_cols:
                try:
                    iso_rows[iso_key][c] = float(row.get(c) or 0)
                except (ValueError, TypeError):
                    iso_rows[iso_key][c] = 0.0

        return jsonify({'columns': cols, 'ranked': ranked, 'iso_totals': iso_totals, 'iso_rows': iso_rows}), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


# ── Port-5000 mirrors for output + geodata endpoints ─────────────────────────
@app.route('/api/scenarios/<scenario_id>/output-files')
def main_output_files(scenario_id):
    return frontend_output_files(scenario_id)

@app.route('/api/scenarios/<scenario_id>/output-raster/<path:filename>')
def main_output_raster(scenario_id, filename):
    return frontend_output_raster(scenario_id, filename)

@app.route('/api/scenarios/<scenario_id>/raster-area-stats/<path:filename>')
def main_raster_area_stats(scenario_id, filename):
    return frontend_raster_area_stats(scenario_id, filename)

@app.route('/api/raster-diff')
def main_raster_diff():
    return frontend_raster_diff()

@app.route('/api/scenarios/<scenario_id>/output-csv-data/<path:filename>')
def main_output_csv_data(scenario_id, filename):
    return frontend_output_csv_data(scenario_id, filename)


@frontend_app.route('/api/scenarios/<scenario_id>/generate-yaml', methods=['POST'])
def frontend_generate_yaml(scenario_id):
    """Generate and save the YAML config file for a scenario.

    Detects which run mode would be used (exec vs run) and generates the
    appropriate YAML, saving it to config/<folder>_config.yaml.
    Returns both YAML variants and the detected mode so the UI can show
    the correct preview.
    """
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        yaml_filename = f"{folder}_config.yaml"
        yaml_path = os.path.join(cs_path, 'config', yaml_filename)
        mode = 'exec' if _glowpa_container_running() else 'run'
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
        with open(yaml_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)
        return jsonify({
            'yaml_content': yaml_content,
            'yaml_path': yaml_path,
            'yaml_filename': yaml_filename,
            'mode': mode,
            'wwtp_mode': wwtp_mode,
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/diagnose', methods=['GET'])
def frontend_diagnose_scenario(scenario_id):
    """Return diagnostic info for a scenario: detected mode, YAML, and the R
    expression that would be executed — without actually running the model.
    Useful for debugging silent R crashes where glowpa.log is never created.
    """
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        yaml_filename = f"{folder}_config.yaml"
        mode = 'exec' if _glowpa_container_running() else 'run'
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        ls = _detect_livestock_module(cs_path, folder)
        if mode == 'exec':
            r_expr = build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=cs_path, wwtp_mode=wwtp_mode)
        else:
            r_expr = build_r_expr_run(yaml_filename, cs_path=cs_path, folder=folder, wwtp_mode=wwtp_mode)
        # Check existing files
        rds_files = {}
        for fname in ['isodata.RDS', 'treatment.RDS']:
            p = _resolve_data_path(cs_path, folder, fname)
            rds_files[fname] = {'exists': os.path.exists(p), 'path': p}
        log_path = os.path.join(cs_path, 'output', folder, 'glowpa.log')
        return jsonify({
            'mode': mode,
            'wwtp_mode': wwtp_mode,
            'pathogen': pathogen,
            'folder': folder,
            'yaml_content': yaml_content,
            'r_expression': r_expr,
            'livestock_detected': ls is not None,
            'livestock_animals': list(ls['animals'].keys()) if ls else [],
            'temperature_tif': ls['temperature_tif'] if ls else None,
            'rds_files': rds_files,
            'log_exists': os.path.exists(log_path),
            'log_path': log_path,
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc), 'traceback': traceback.format_exc()}), 500


@frontend_app.route('/api/scenarios/<scenario_id>/run-model', methods=['POST'])
def frontend_run_model(scenario_id):
    """Start the glowpa model for a scenario.

    Chooses between docker exec (persistent container) and docker run
    (one-shot container with isolated volume mounts) automatically.
    """
    try:
        body = request.get_json(silent=True) or {}
        debug_mode = bool(body.get('debug_mode', False))

        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        # Decide mode, generate matching YAML and build execution params
        yaml_filename = f"{folder}_config.yaml"
        yaml_path = os.path.join(cs_path, 'config', yaml_filename)
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        params, mode = build_model_cmd(cs_path, cs_folder_name, folder, yaml_filename, wwtp_mode=wwtp_mode)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
        with open(yaml_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)
        # Ensure output directory exists
        os.makedirs(os.path.join(cs_path, 'output', folder), exist_ok=True)
        run_id = str(uuid.uuid4())
        model_runs[run_id] = {
            'status': 'pending',
            'mode': mode,
            'scenario_id': scenario_id,
            'cs_path': cs_path,
            'folder': folder,
            'debug_mode': debug_mode,
            'started_at': datetime.now().isoformat(),
            'finished_at': None,
            'stdout': '',
            'stderr': '',
            'return_code': None,
            'simulation_complete': False,
            'output_files': [],
        }
        threading.Thread(target=_execute_model_run, args=(run_id, params), daemon=True).start()
        return jsonify({'status': 'started', 'run_id': run_id, 'mode': mode}), 202
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/run-status/<run_id>')
def frontend_run_status(run_id):
    """Poll the status of a model run."""
    run = model_runs.get(run_id)
    if not run:
        return jsonify({'error': 'Run not found'}), 404
    return jsonify(run), 200


# Also expose analytics endpoints on the main app (port 5000)
@app.route('/api/case-studies/<case_study_id>/analytics')
def main_get_analytics(case_study_id):
    return frontend_get_analytics(case_study_id)

@app.route('/api/case-studies/<case_study_id>/driver-comparison')
def main_get_driver_comparison(case_study_id):
    return frontend_get_driver_comparison(case_study_id)

@app.route('/api/scenarios/<scenario_id>/generate-yaml', methods=['POST'])
def main_generate_yaml(scenario_id):
    return frontend_generate_yaml(scenario_id)

@app.route('/api/scenarios/<scenario_id>/diagnose', methods=['GET'])
def main_diagnose_scenario(scenario_id):
    return frontend_diagnose_scenario(scenario_id)

@app.route('/api/scenarios/<scenario_id>/run-model', methods=['POST'])
def main_run_model(scenario_id):
    return frontend_run_model(scenario_id)

@app.route('/api/run-status/<run_id>')
def main_run_status(run_id):
    return frontend_run_status(run_id)


# ── Log endpoints ────────────────────────────────────────────────────────────

@frontend_app.route('/api/scenarios/<scenario_id>/glowpa-log')
def frontend_get_glowpa_log(scenario_id):
    """Return the contents of glowpa.log for a scenario.

    Checks both candidate log paths (exec mode: output/<folder>/glowpa.log,
    run mode: output/glowpa.log) and returns whichever exists.
    Query param: tail=N (default 500 lines, 0 = all).
    """
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        tail = int(request.args.get('tail', 500))

        # Check exec-mode path first, then run-mode fallback
        candidates = [
            os.path.join(cs_path, 'output', folder, 'glowpa.log'),
            os.path.join(cs_path, 'output', 'glowpa.log'),
        ]
        log_path = next((p for p in candidates if os.path.exists(p)), None)

        if log_path is None:
            return jsonify({
                'exists': False,
                'content': '',
                'path': candidates[0],
                'lines': 0,
            }), 200

        with open(log_path, 'r', encoding='utf-8', errors='replace') as fh:
            all_lines = fh.readlines()

        trimmed = all_lines[-tail:] if tail > 0 else all_lines
        return jsonify({
            'exists': True,
            'content': ''.join(trimmed),
            'path': log_path,
            'lines': len(all_lines),
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@frontend_app.route('/api/glowpa/container-logs')
def frontend_get_container_logs():
    """Return docker logs from the persistent glowpa-container via Docker SDK.

    Query param: tail=N (default 200).
    """
    tail = int(request.args.get('tail', 200))
    client = None
    try:
        client = _get_docker_client()
        if client is None:
            return jsonify({'error': 'Cannot connect to Docker socket. Is /var/run/docker.sock mounted?'}), 500
        try:
            container = client.containers.get('glowpa-container')
        except docker.errors.NotFound:
            return jsonify({'error': 'glowpa-container not found'}), 404
        log_bytes = container.logs(stdout=True, stderr=True, tail=tail, timestamps=False)
        log_text = log_bytes.decode('utf-8', errors='replace') if isinstance(log_bytes, bytes) else log_bytes
        return jsonify({
            'stdout': log_text,
            'stderr': '',
            'combined': log_text,
            'return_code': 0,
        }), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


# Mirror log endpoints on the main app (port 5000)
@app.route('/api/scenarios/<scenario_id>/glowpa-log')
def main_get_glowpa_log(scenario_id):
    return frontend_get_glowpa_log(scenario_id)

@app.route('/api/glowpa/container-logs')
def main_get_container_logs():
    return frontend_get_container_logs()


@frontend_app.route('/api/metrics/summary')
def frontend_metrics_summary():
    """Return aggregate metrics: count of scenarios that have produced outputs."""
    try:
        scenarios_with_outputs = 0
        for cs in case_studies:
            cs_path = cs.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    folder = row.get('folder', '')
                    if not folder:
                        continue
                    output_dir = os.path.join(cs_path, 'output', folder)
                    if os.path.isdir(output_dir) and any(
                        fn.endswith(('.csv', '.tif'))
                        for fn in os.listdir(output_dir)
                        if not fn.endswith('.log')
                    ):
                        scenarios_with_outputs += 1
        return jsonify({'scenarios_with_outputs': scenarios_with_outputs}), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/api/metrics/summary')
def main_metrics_summary():
    return frontend_metrics_summary()


@frontend_app.route('/api/activity')
def frontend_get_activity():
    """Return recent filesystem activity across all case studies.

    Scans output directories and scenario_metadata.csv timestamps to produce a
    sorted list of recent events (new case study, new scenario, new outputs).
    """
    try:
        events = []
        now = datetime.now().timestamp()

        for cs in case_studies:
            cs_path = cs.get('folder_path')
            cs_name = cs.get('name', 'Unknown')
            if not cs_path or not os.path.exists(cs_path):
                continue

            # Case study folder creation/modification time
            cs_mtime = os.path.getmtime(cs_path)
            events.append({
                'type': 'case_study',
                'icon': 'folderOpen',
                'message': f'Case study available: {cs_name}',
                'detail': cs.get('folder_name', ''),
                'mtime': cs_mtime,
                'time_iso': datetime.fromtimestamp(cs_mtime).isoformat(),
            })

            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue

            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    folder = row.get('folder', '')
                    sc_name = row.get('name', folder)
                    is_baseline = row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')

                    # New scenario event (non-baseline)
                    if not is_baseline:
                        sc_created = row.get('created_at', '')
                        try:
                            ts = datetime.fromisoformat(sc_created).timestamp()
                        except Exception:
                            ts = os.path.getmtime(meta_path)
                        events.append({
                            'type': 'scenario',
                            'icon': 'barChart',
                            'message': f'Scenario created: {sc_name}',
                            'detail': cs_name,
                            'mtime': ts,
                            'time_iso': datetime.fromtimestamp(ts).isoformat(),
                        })

                    # Output event
                    output_dir = os.path.join(cs_path, 'output', folder)
                    if os.path.isdir(output_dir):
                        out_files = [
                            fn for fn in os.listdir(output_dir)
                            if fn.endswith(('.csv', '.tif')) and not fn.endswith('.log')
                        ]
                        if out_files:
                            latest = max(
                                os.path.getmtime(os.path.join(output_dir, fn))
                                for fn in out_files
                            )
                            events.append({
                                'type': 'output',
                                'icon': 'checkCircle',
                                'message': f'Outputs ready: {sc_name}',
                                'detail': cs_name,
                                'mtime': latest,
                                'time_iso': datetime.fromtimestamp(latest).isoformat(),
                            })

        # Sort by most recent first, return top 20
        events.sort(key=lambda e: e['mtime'], reverse=True)
        # Compute human-readable relative time
        for ev in events:
            delta = int(now - ev['mtime'])
            if delta < 60:
                ev['rel'] = 'just now'
            elif delta < 3600:
                ev['rel'] = f"{delta // 60} min ago"
            elif delta < 86400:
                ev['rel'] = f"{delta // 3600} hr ago"
            else:
                ev['rel'] = f"{delta // 86400} days ago"

        return jsonify({'events': events[:20]}), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@app.route('/api/activity')
def main_get_activity():
    return frontend_get_activity()


@frontend_app.route('/api/case-studies/reload', methods=['GET', 'POST'])
def frontend_reload_case_studies():
    """Reload case studies from filesystem"""
    try:
        print(f"Frontend reload endpoint called with method: {request.method}")  # Debug log
        load_existing_case_studies()
        print(f"Loaded {len(case_studies)} case studies")  # Debug log
        return jsonify({
            "status": "success", 
            "message": f"Reloaded {len(case_studies)} case studies",
            "case_studies_count": len(case_studies),
            "method_used": request.method
        })
    except Exception as e:
        print(f"Error in reload: {str(e)}")  # Debug log
        return jsonify({"error": f"Failed to reload case studies: {str(e)}"}), 500

# CATCH-ALL ROUTE FOR SPA ROUTING - MUST BE LAST!
@frontend_app.route('/<path:path>')
def serve_static_files(path):
    print(f"[DEBUG] Catch-all route hit with path: '{path}'")
    print(f"[DEBUG] Static folder: '{frontend_app.static_folder}'")
    full_path = os.path.join(frontend_app.static_folder, path)
    print(f"[DEBUG] Checking if file exists: '{full_path}'")
    if os.path.exists(full_path):
        print(f"[DEBUG] File exists, serving: '{path}'")
        return send_from_directory(frontend_app.static_folder, path)
    else:
        print(f"[DEBUG] File doesn't exist, serving index.html for SPA routing")
        return send_from_directory(frontend_app.static_folder, 'index.html')

# Also add the reload endpoint to the regular app
@app.route('/api/case-studies/reload', methods=['POST'])
def reload_case_studies():
    """Reload case studies from filesystem"""
    try:
        load_existing_case_studies()
        return jsonify({
            "status": "success", 
            "message": f"Reloaded {len(case_studies)} case studies",
            "case_studies_count": len(case_studies)
        })
    except Exception as e:
        return jsonify({"error": f"Failed to reload case studies: {str(e)}"}), 500

@app.route('/api/case-studies/<case_study_id>/datapackage')
def get_case_study_datapackage(case_study_id):
    """Get the datapackage.json content for a case study"""
    try:
        print(f"[DEBUG] (main app) Looking for case study with ID: '{case_study_id}'")
        print(f"[DEBUG] (main app) Available case studies: {[cs.get('id', 'no-id') for cs in case_studies]}")
        
        # Find the case study
        case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
        if not case_study:
            print(f"[DEBUG] (main app) Case study not found for ID: '{case_study_id}'")
            return jsonify({"error": "Case study not found"}), 404
        
        print(f"[DEBUG] (main app) Found case study: {case_study.get('name', 'unknown')}")
        
        # Read the datapackage.json file
        datapackage_path = os.path.join(case_study['folder_path'], 'datapackage.json')
        print(f"[DEBUG] (main app) Looking for datapackage at: {datapackage_path}")
        
        if os.path.exists(datapackage_path):
            with open(datapackage_path, 'r', encoding='utf-8') as f:
                datapackage = json.load(f)
            return jsonify(datapackage)
        else:
            print(f"[DEBUG] (main app) Datapackage file not found at: {datapackage_path}")
            return jsonify({"error": "Datapackage file not found"}), 404
            
    except Exception as e:
        print(f"[DEBUG] (main app) Exception in datapackage endpoint: {str(e)}")
        return jsonify({"error": f"Failed to read datapackage: {str(e)}"}), 500

@app.route('/api/case-studies/<case_study_id>/datapackage', methods=['PUT'])
def update_case_study_datapackage(case_study_id):
    return frontend_update_case_study_datapackage(case_study_id)

@app.route('/api/test', methods=['GET', 'POST'])
def frontend_test():
    """Test endpoint for debugging"""
    return jsonify({
        "status": "ok", 
        "message": "Frontend app is working", 
        "method": request.method,
        "case_studies_count": len(case_studies),
        "case_studies": [{"id": cs.get("id", "no-id"), "name": cs.get("name", "no-name")} for cs in case_studies]
    })

@app.route('/api/glowpa-status')
def main_glowpa_status():
    try:
        import socket
        # Since Glowpa runs R and doesn't listen on HTTP, we just check if we can resolve the hostname
        # If the container is running and on the same network, the hostname should resolve
        socket.gethostbyname('glowpa-container')
        return jsonify({"glowpa_status": "connected", "message": "Container hostname resolves"})
    except socket.gaierror:
        return jsonify({"glowpa_status": "disconnected", "message": "Container hostname not found"})
    except Exception as e:
        return jsonify({"glowpa_status": "disconnected", "error": str(e)})

@app.route('/api/glowpa/start', methods=['POST'])
def main_start_glowpa():
    global glowpa_running
    try:
        import subprocess
        data = request.get_json() or {}
        case_study_id = data.get('case_study_id')
        
        # First check if container is already running
        check_result = subprocess.run(['docker', 'ps', '--filter', 'name=glowpa-container', '--format', '{{.Status}}'], 
                                    capture_output=True, text=True, timeout=10)
        
        if check_result.returncode == 0 and check_result.stdout.strip() and 'Up' in check_result.stdout:
            glowpa_running = True
            return jsonify({"status": "success", "message": "GloWPa container is already running"})
        
        # Try to start the container
        result = subprocess.run(['docker', 'start', 'glowpa-container'], 
                              capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            glowpa_running = True
            if case_study_id:
                case_study = next((cs for cs in case_studies if cs['id'] == case_study_id), None)
                if case_study:
                    message = f"GloWPa started for case study: {case_study['name']}"
                else:
                    message = "GloWPa started (case study not found)"
            else:
                message = "GloWPa container started successfully"
            return jsonify({"status": "success", "message": message})
        else:
            error_msg = result.stderr.strip() if result.stderr else "Failed to start container"
            return jsonify({"status": "error", "message": f"Failed to start GloWPa: {error_msg}"}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout while starting GloWPa container"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/glowpa/stop', methods=['POST'])
def main_stop_glowpa():
    global glowpa_running
    try:
        # Write the Docker command to a file for manual execution
        with open('/app/data/docker_commands.txt', 'a') as f:
            f.write(f"# Stop command requested at {datetime.now()}\n")
            f.write("docker stop glowpa-container\n\n")
        
        glowpa_running = False
        return jsonify({
            "status": "success", 
            "message": "Stop command logged. Please run 'docker stop glowpa-container' manually to actually stop the container."
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# Load existing case studies on startup
load_existing_case_studies()

# Pre-warm the pathogens cache in background so the first UI request is instant
def _prefetch_pathogens():
    try:
        _read_pathogens()
    except Exception as e:
        print(f'[config] Background pathogens prefetch failed (will retry on first request): {e}')

threading.Thread(target=_prefetch_pathogens, daemon=True).start()

def run_frontend_server():
    """Run the frontend Flask app on port 3000"""
    # Debug: Print all registered routes
    print("[DEBUG] Frontend app registered routes:")
    for rule in frontend_app.url_map.iter_rules():
        print(f"  {rule.rule} -> {rule.endpoint} (methods: {rule.methods})")
    
    frontend_app.run(host='0.0.0.0', port=3000, debug=False)

if __name__ == '__main__':
    # Start frontend server in a separate thread
    frontend_thread = threading.Thread(target=run_frontend_server, daemon=True)
    frontend_thread.start()
    
    print("Starting Flask servers...")
    print("Frontend server: http://localhost:3000")
    print("Backend API server: http://localhost:5000")
    
    # Start backend server with SocketIO
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)