"""Filesystem and CSV helpers shared across the backend.

These are pure utilities with no Flask dependencies: path resolution inside
the case-study/scenario directory layout, scenario_metadata.csv I/O, scenario
look-ups, and TIFF header parsing.
"""

import csv
import os
import re
import struct
import uuid
from datetime import datetime

import state
from state import (
    CATEGORY_FOLDER_MAP,
    SCENARIO_METADATA_FIELDS,
    ANALYTICS_REQUIRED_FILES,
    ANALYTICS_OPTIONAL_FILES,
    case_studies,
)


# ─── Slug / folder-name helpers ──────────────────────────────────────────────

def _slugify(value):
    """Lowercase slug: non-alphanumeric runs → underscore, trim edges."""
    return re.sub(r'[^a-z0-9]+', '_', str(value).lower().strip()).strip('_')


def generate_scenario_folder_name(case_study_name, ssp, pathogen, year):
    """Return a deterministic folder name, e.g. west_athens_ssp3_rotavirus_2050."""
    safe_cs = _slugify(case_study_name) or 'study'
    ssp_str = str(ssp).strip()
    if not ssp_str.lower().startswith('ssp'):
        ssp_str = f"ssp{ssp_str}"
    safe_ssp = _slugify(ssp_str) or 'ssp'
    safe_pathogen = _slugify(pathogen) or 'unknown'
    safe_year = _slugify(year) or 'xxxx'
    return f"{safe_cs}_{safe_ssp}_{safe_pathogen}_{safe_year}"


# ─── scenario_metadata.csv helpers ───────────────────────────────────────────

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


# ─── Path resolution ─────────────────────────────────────────────────────────

def _resolve_data_path(cs_path, folder, filename):
    """Return the canonical disk path for *filename* inside a scenario folder.

    Search order:
      1. input/<folder>/<filename>          (flat / legacy layout)
      2. input/<folder>/<cat_folder>/<filename>  for each category sub-folder

    For .RDS files (generated at runtime beside their .csv counterpart) the
    corresponding .csv is located first and the .RDS path is derived from it,
    since the .RDS may not exist on disk yet.

    For write operations the returned path may not exist yet.
    """
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
    return direct


# ─── CSV loading ─────────────────────────────────────────────────────────────

def _read_csv_table(path):
    """Return {'data': [...], 'fieldnames': [...]} for a CSV file path."""
    with open(path, 'r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        data = [dict(row) for row in reader]
    return {'data': data, 'fieldnames': fieldnames}


def load_csv_data_for_scenario(case_study_path, folder, legacy_csv_file=None):
    """Load isodata.csv from input/<folder>/ (new format), checking category
    sub-folders.  Falls back to input/<legacy_csv_file> for old-format case
    studies.
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

    is_legacy = 'folder' not in fieldnames and 'csv_file' in fieldnames

    for row in rows:
        if is_legacy:
            csv_file = row.get('csv_file', '')
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
            'case_study_id': '',
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


# ─── Scenario lookup ─────────────────────────────────────────────────────────

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


def _livestock_dir_for_scenario(scenario_id):
    """Return (case_study, folder, livestock_dir) for a scenario, or raise ValueError."""
    cs, folder = _locate_scenario(scenario_id)
    ls_dir = os.path.join(cs['folder_path'], 'input', folder, 'livestock_emissions')
    if not os.path.isdir(ls_dir):
        raise ValueError('livestock_emissions folder not found for this scenario')
    return cs, folder, ls_dir


def find_geodata_shapefile(cs_path, folder):
    """Return the path to the scenario's geodata .shp file, or None if not found.

    Case studies use different layouts depending on when/how they were
    imported, so all known locations are checked in order:
      1. input/<folder>/geodata/            (per-scenario geodata)
      2. input/baseline/geodata/             (legacy layout)
      3. input/geodata/                      (shared top-level geodata)
    """
    candidate_dirs = [
        os.path.join(cs_path, 'input', folder, 'geodata'),
        os.path.join(cs_path, 'input', 'baseline', 'geodata'),
        os.path.join(cs_path, 'input', 'geodata'),
    ]
    for geodata_dir in candidate_dirs:
        if not os.path.isdir(geodata_dir):
            continue
        shp_files = [f for f in os.listdir(geodata_dir) if f.lower().endswith('.shp')]
        if shp_files:
            return os.path.join(geodata_dir, shp_files[0])
    return None


# ─── TIFF header parser (no PIL/rasterio) ────────────────────────────────────

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


# ─── Scenario readiness ──────────────────────────────────────────────────────

def check_scenario_readiness(case_study_path, folder, pathogen):
    """Return a readiness dict for a scenario.

    Required files (must be present to run):
      isodata.csv, isoraster.tif, poprural.tif, popurban.tif

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
    has_pathogen = bool(pathogen and str(pathogen).strip())
    return {
        'ready': len(missing) == 0 and has_pathogen,
        'missing_files': missing,
        'present_files': present,
        'optional_files': optional_present,
        'has_geodata': has_geodata,
        'has_pathogen': has_pathogen,
    }
