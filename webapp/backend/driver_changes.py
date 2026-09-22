"""Track editable driver inputs against each scenario's original values."""

import csv
import hashlib
import json
import os


REFERENCE_DIR = 'scenario_driver_references'

POPULATION_FIELDS = {
    'population', 'fraction_urban_pop', 'fraction_pop_under5', 'hdi',
}
SANITATION_BASE_FIELDS = {
    'flushSewer', 'flushSeptic', 'flushPit', 'pitSlab', 'compostingToilet',
    'containerBased', 'pitNoSlab', 'bucketLatrine', 'hangingToilet',
    'flushOpen', 'flushUnknown', 'other', 'openDefecation', 'sewageTreated',
    'fecalSludgeTreated', 'onsiteDumpedland', 'pitAdditive', 'urine',
    'twinPits', 'coverBury', 'isWatertight', 'hasLeach', 'emptyFrequency',
}
SANITATION_FIELDS = {
    f'{field}{suffix}'
    for field in SANITATION_BASE_FIELDS
    for suffix in ('_urb', '_rur')
}
WASTEWATER_FIELDS = {
    'FractionPrimarytreatment', 'FractionSecondarytreatment',
    'FractionTertiarytreatment', 'FractionQuaternarytreatment',
    'sewageTreated_urb', 'sewageTreated_rur',
    'fecalSludgeTreated_urb', 'fecalSludgeTreated_rur',
    'fEmitted_inEffluent_after_treatment_virus',
    'fEmitted_inEffluent_after_treatment_protozoa',
}


def _digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _csv_columns(path, fields):
    if not os.path.isfile(path):
        return None
    with open(path, 'r', newline='', encoding='utf-8') as csv_file:
        reader = csv.DictReader(csv_file)
        present = [field for field in (reader.fieldnames or []) if field in fields]
        return {
            'fields': present,
            'rows': [[row.get(field, '') for field in present] for row in reader],
        }


def _file_digest(path):
    if not os.path.isfile(path):
        return None
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _find_file(root, filename):
    direct = os.path.join(root, filename)
    if os.path.isfile(direct):
        return direct
    if os.path.isdir(root):
        for current_root, _, filenames in os.walk(root):
            if filename in filenames:
                return os.path.join(current_root, filename)
    return direct


def _matching_file_digests(root, predicate):
    matches = {}
    if not os.path.isdir(root):
        return matches
    for current_root, _, filenames in os.walk(root):
        for filename in sorted(filenames):
            if predicate(filename):
                path = os.path.join(current_root, filename)
                matches[os.path.relpath(path, root).replace('\\', '/')] = _file_digest(path)
    return matches


def compute_driver_fingerprints(case_study_path, folder):
    scenario_root = os.path.join(case_study_path, 'input', folder)
    isodata_path = _find_file(scenario_root, 'isodata.csv')
    treatment_path = _find_file(scenario_root, 'treatment.csv')
    livestock_root = os.path.join(scenario_root, 'livestock_emissions')
    qmra_config_path = os.path.join(scenario_root, 'qmra', 'qmra_config.json')

    return {
        'population': _digest(_csv_columns(isodata_path, POPULATION_FIELDS)),
        'sanitation': _digest(_csv_columns(isodata_path, SANITATION_FIELDS)),
        'wastewater-treatment': _digest({
            'isodata': _csv_columns(isodata_path, WASTEWATER_FIELDS),
            'treatment': _file_digest(treatment_path),
        }),
        'livestock-population': _digest(_matching_file_digests(
            os.path.join(livestock_root, 'animals'),
            lambda name: (name.startswith('isodata_') and name.endswith('.csv')) or name.endswith('_heads.tif'),
        )),
        'manure-management': _digest(_matching_file_digests(
            livestock_root,
            lambda name: name in {'manure_management.csv', 'manure_fractions.csv'},
        )),
        'production-systems': _digest(_matching_file_digests(
            livestock_root,
            lambda name: name == 'production_systems.csv',
        )),
        'exposure-pathways': _digest(_file_digest(qmra_config_path)),
    }


def _reference_path(case_study_path, scenario_id):
    return os.path.join(case_study_path, 'config', REFERENCE_DIR, f'{scenario_id}.json')


def initialize_driver_reference(case_study_path, scenario_id, folder, overwrite=False):
    path = _reference_path(case_study_path, scenario_id)
    if os.path.isfile(path) and not overwrite:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as reference_file:
        json.dump(compute_driver_fingerprints(case_study_path, folder), reference_file, indent=2)


def initialize_case_study_driver_references(case_study_path):
    metadata_path = os.path.join(case_study_path, 'config', 'scenario_metadata.csv')
    if not os.path.isfile(metadata_path):
        return
    with open(metadata_path, 'r', newline='', encoding='utf-8') as metadata_file:
        for row in csv.DictReader(metadata_file):
            scenario_id = row.get('scenario_id')
            if scenario_id:
                initialize_driver_reference(case_study_path, scenario_id, row.get('folder') or 'baseline')


def get_changed_drivers(case_study_path, scenario_id, folder):
    path = _reference_path(case_study_path, scenario_id)
    if not os.path.isfile(path):
        initialize_driver_reference(case_study_path, scenario_id, folder)
        return []
    with open(path, 'r', encoding='utf-8') as reference_file:
        original = json.load(reference_file)
    current = compute_driver_fingerprints(case_study_path, folder)
    return [driver_id for driver_id, fingerprint in current.items() if original.get(driver_id) != fingerprint]