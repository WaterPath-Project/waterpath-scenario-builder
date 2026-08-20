"""Raw model-input tables for the report appendix.

The narrative chapters summarise each driver; the appendix reproduces the
numbers the model was actually run with, i.e. the same CSVs the driver panels
in /scenarios expose at the bottom of each editor.  Nothing here is derived or
rounded: a reader should be able to rebuild the scenario from the appendix.

Filesystem-only (no Flask request state) so the report builder can call it
directly.
"""

import csv
import os

# Where each driver's raw inputs live inside `input/<folder>/`.  Paths are
# tried both flat and under the category sub-folder, mirroring
# fs_utils._resolve_data_path, because both layouts exist in the wild.
_CATEGORY_FOLDERS = ('', 'human_emissions', 'livestock_emissions', 'concentrations', 'risk')

# Columns that identify a row rather than carry data.  The first one present is
# used as the row label; the rest are dropped from the value columns.
_ID_COLUMNS = ('subarea', 'gid', 'iso', 'id', 'animal')

# A landscape page fits about this many value columns at the appendix font
# size, so wider files are split into several tables.
_MAX_VALUE_COLUMNS = 10

# Guard against a pathological case study turning the appendix into hundreds of
# pages.  Anything longer is truncated with a visible note.
_MAX_ROWS = 400

# Population keeps its own column list (isodata.csv also holds every sanitation
# column, which belongs to the sanitation table instead).
_POPULATION_COLUMNS = ('population', 'fraction_urban_pop', 'fraction_pop_under5', 'hdi')

# Sanitation is everything in isodata.csv that is split urban/rural.
_SANITATION_SUFFIXES = ('_urb', '_rur')


def _resolve(cs_path, folder, relative):
    """Find `relative` inside a scenario's input folder, whatever the layout."""
    parts = relative.split('/')
    for category in _CATEGORY_FOLDERS:
        candidate = os.path.join(cs_path, 'input', folder, category, *parts)
        if os.path.exists(candidate):
            return candidate
    return None


def _read_csv(path):
    """Return (fieldnames, rows) for a CSV, sniffing the ';' variant."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        sample = f.read(4096)
        f.seek(0)
        delimiter = ';' if sample.count(';') > sample.count(',') else ','
        reader = csv.DictReader(f, delimiter=delimiter)
        fieldnames = [name for name in (reader.fieldnames or []) if name]
        rows = [dict(row) for row in reader]
    return fieldnames, rows


def _label_column(fieldnames):
    for name in _ID_COLUMNS:
        if name in fieldnames:
            return name
    return fieldnames[0] if fieldnames else None


def _build_tables(title, fieldnames, rows, columns, note=None):
    """Split one CSV into page-width tables of at most _MAX_VALUE_COLUMNS."""
    columns = [c for c in columns if c in fieldnames]
    if not columns or not rows:
        return []
    label_col = _label_column([c for c in fieldnames if c not in columns]) \
        or _label_column(fieldnames)

    truncated = len(rows) > _MAX_ROWS
    body = rows[:_MAX_ROWS]

    chunks = [columns[i:i + _MAX_VALUE_COLUMNS]
              for i in range(0, len(columns), _MAX_VALUE_COLUMNS)]
    tables = []
    for index, chunk in enumerate(chunks):
        part = ''
        if len(chunks) > 1:
            first = index * _MAX_VALUE_COLUMNS + 1
            part = ' (columns %d to %d of %d)' % (
                first, first + len(chunk) - 1, len(columns))
        tables.append({
            'title': title + part,
            'note': note if index == 0 else None,
            'label_column': label_col or '',
            'columns': chunk,
            'rows': [{
                'label': str(row.get(label_col, '') or ''),
                'cells': [str(row.get(column, '') or '') for column in chunk],
            } for row in body],
            'truncated': truncated,
            'total_rows': len(rows),
        })
    return tables


def _isodata_tables(cs_path, folder):
    path = _resolve(cs_path, folder, 'isodata.csv')
    if not path:
        return {}
    fieldnames, rows = _read_csv(path)
    sanitation = [c for c in fieldnames if c.endswith(_SANITATION_SUFFIXES)]
    return {
        'Population': _build_tables(
            'isodata.csv', fieldnames, rows, _POPULATION_COLUMNS),
        'Sanitation': _build_tables(
            'isodata.csv', fieldnames, rows, ['fraction_urban_pop'] + sanitation,
            note='Shares of the sanitation ladder per reporting area, given '
                 'separately for the urban (_urb) and rural (_rur) population.'),
    }


def _simple_tables(cs_path, folder, relative, note=None):
    path = _resolve(cs_path, folder, relative)
    if not path:
        return []
    fieldnames, rows = _read_csv(path)
    columns = [c for c in fieldnames if c not in _ID_COLUMNS]
    return _build_tables(os.path.basename(relative), fieldnames, rows, columns, note=note)


def _animal_tables(cs_path, folder):
    """One small table per animal, from livestock_emissions/animals/."""
    directory = None
    for category in _CATEGORY_FOLDERS:
        candidate = os.path.join(cs_path, 'input', folder, category, 'animals')
        if os.path.isdir(candidate):
            directory = candidate
            break
    if not directory:
        return []
    tables = []
    for name in sorted(os.listdir(directory)):
        if not name.startswith('isodata_') or not name.endswith('.csv'):
            continue
        fieldnames, rows = _read_csv(os.path.join(directory, name))
        columns = [c for c in fieldnames if c not in _ID_COLUMNS]
        tables.extend(_build_tables(name, fieldnames, rows, columns))
    return tables


def build_raw_data_tables(cs_path, folder):
    """Return [{driver, tables:[...]}] of raw model inputs for one scenario.

    Drivers whose inputs are rasters rather than CSVs (most of hydrology) are
    omitted; there is nothing tabular to show for them.
    """
    if not folder:
        return []

    try:
        isodata = _isodata_tables(cs_path, folder)
    except Exception:
        isodata = {}

    plan = [
        ('Population', lambda: isodata.get('Population') or []),
        ('Sanitation', lambda: isodata.get('Sanitation') or []),
        ('Wastewater treatment', lambda: _simple_tables(
            cs_path, folder, 'treatment.csv',
            note='Treated fractions per area, or the location, capacity and '
                 'treatment type of each plant when the scenario models '
                 'individual facilities.')),
        ('Livestock population', lambda: _animal_tables(cs_path, folder)),
        ('Manure management', lambda: (
            _simple_tables(cs_path, folder, 'manure_management.csv',
                           note='Fraction of each animal group\'s manure going '
                                'to each management system.')
            + _simple_tables(cs_path, folder, 'manure_fractions.csv'))),
        ('Production systems', lambda: _simple_tables(
            cs_path, folder, 'production_systems.csv',
            note='Split between intensive (_i) and extensive (_e) production '
                 'per animal group.')),
        ('Hydrology', lambda: _simple_tables(
            cs_path, folder, 'hydrology/assumptions.csv',
            note='The remaining hydrology inputs (discharge, runoff, '
                 'temperature and solar radiation) are gridded rasters and '
                 'cannot be tabulated here.')),
    ]

    groups = []
    for driver, builder in plan:
        try:
            tables = builder()
        except Exception:
            tables = []
        if tables:
            groups.append({'driver': driver, 'tables': tables})
    return groups


def build_raw_data_appendix(cs_path, scenarios):
    """Raw input tables for every scenario in the report, baseline first.

    `scenarios` is a list of dicts with at least `name` and `folder`.
    """
    appendix = []
    for scenario in scenarios or []:
        groups = build_raw_data_tables(cs_path, scenario.get('folder'))
        if not groups:
            continue
        appendix.append({
            'scenario_id': scenario.get('id'),
            'name': scenario.get('name') or 'Scenario',
            'year': scenario.get('year'),
            'ssp': scenario.get('ssp'),
            'folder': scenario.get('folder'),
            'groups': groups,
        })
    return appendix
