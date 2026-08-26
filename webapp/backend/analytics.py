"""Analytics endpoints: per-scenario readiness, driver-comparison metrics
and scenario-vs-baseline narrative generation.
"""

import csv
import os
import re
import threading
import time

from flask import jsonify, request

from fs_utils import (
    _locate_scenario,
    _read_csv_table,
    _resolve_data_path,
    check_scenario_readiness,
    load_scenarios_from_metadata_csv,
)
from glowpa import _detect_wwtp_mode
from hydrology import _compute_hydrology_metrics, _detect_hydrology_module
from livestock import _compute_livestock_mean_heads, _detect_livestock_module
from qmra import _qmra_available, resolve_qmra_config
from state import case_studies

# ──────────────────────────────────────────────────────────────────────────────
# Short-lived in-memory cache for get_analytics
#
# With many scenarios (15+), each call to get_analytics does O(N) filesystem
# operations (readiness checks, livestock detection, output-dir listings).
# Multiple components mount simultaneously and fire the same request; the cache
# absorbs these within the same TTL window so work is only done once.
# Key: (case_study_id, scenario_metadata_mtime) — auto-invalidates when
# scenarios are added/removed.  A short wall-clock TTL covers output-dir
# changes (after model runs).
# ──────────────────────────────────────────────────────────────────────────────
_analytics_cache_lock = threading.Lock()
_analytics_cache: dict = {}   # key -> (monotonic_ts, data_dict)
_ANALYTICS_CACHE_TTL = 3.0    # seconds


# ──────────────────────────────────────────────────────────────────────────────
# Per-scenario enrichment helper (shared by get_analytics and get_scenario_info)
# ──────────────────────────────────────────────────────────────────────────────

def _enrich_scenario(scenario, cs_path, case_study_id):
    """Add readiness, has_outputs, has_livestock, has_hydrology, has_qmra_output
    fields to *scenario* in-place.  Returns the mutated dict."""
    scenario['case_study_id'] = case_study_id
    scenario.pop('data', None)
    folder = scenario.get('folder', 'baseline')
    pathogen = scenario.get('pathogen', '')
    readiness = check_scenario_readiness(cs_path, folder, pathogen)
    yaml_filename = f"{folder}_config.yaml"
    yaml_path = os.path.join(cs_path, 'config', yaml_filename)
    readiness['yaml_exists'] = os.path.exists(yaml_path)
    readiness['yaml_filename'] = yaml_filename
    scenario['readiness'] = readiness
    output_dir = os.path.join(cs_path, 'output', folder)
    scenario['has_outputs'] = (
        os.path.isdir(output_dir) and
        any(f.endswith(('.csv', '.tif'))
            for f in os.listdir(output_dir)
            if not f.endswith('.log'))
    )
    ls = _detect_livestock_module(cs_path, folder)
    scenario['has_livestock'] = ls is not None and bool(ls.get('animals'))
    conc_dir = os.path.join(cs_path, 'output', folder, 'hydrology', 'conc')
    scenario['has_hydrology'] = (
        os.path.isdir(conc_dir) and
        any(re.search(r'm\d{1,2}\.tif$', f, re.IGNORECASE)
            for f in os.listdir(conc_dir)
            if f.endswith('.tif'))
    )
    scenario['has_qmra_output'] = os.path.exists(
        os.path.join(cs_path, 'output', folder, 'qmra', 'combined', 'monthly', 'annual_risk.tif')
    )
    scenario['qmra_available'] = _qmra_available(cs_path)
    return scenario


# ──────────────────────────────────────────────────────────────────────────────
# Driver-metric helpers
# ──────────────────────────────────────────────────────────────────────────────

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


# manure_management.csv columns are `<SYSTEM>_<animal>` fractions that sum to 1
# per animal.  System codes mirror MANURE_SYSTEM_LABELS in LivestockEditorPanel.jsx.
# `O` (other systems) is deliberately in no group, so the three shares below need
# not sum to 100%.
_MANURE_DIRECT_SYSTEMS = {'PP', 'DS'}                                  # deposited / spread straight onto land
_MANURE_STORAGE_SYSTEMS = {'SS', 'DL', 'LS', 'UAL', 'Pl1', 'Ph1', 'SSDL'}  # stored, allowing pathogen die-off
_MANURE_TREATED_SYSTEMS = {'AD', 'BF'}                                 # digested / burned, pathogens destroyed


def _compute_manure_management_metrics(ls_dir):
    """Mean share of manure handled by each system group, averaged over every
    (area, animal) pair that has a non-empty management mix.

    Returns a dict of three fractions (0-1), each possibly None.
    """
    empty = {'direct': None, 'storage': None, 'treated': None}
    rows, fields = _read_csv_rows(os.path.join(ls_dir, 'manure_management.csv'))
    if not rows:
        return empty

    # column name -> (system, animal); e.g. 'SSDL_poultry' -> ('SSDL', 'poultry')
    by_animal = {}
    for field in fields:
        if field in ('iso', 'gid') or '_' not in field:
            continue
        system, _, animal = field.rpartition('_')
        if not system or not animal:
            continue
        by_animal.setdefault(animal, {})[system] = field
    if not by_animal:
        return empty

    sums = {'direct': 0.0, 'storage': 0.0, 'treated': 0.0}
    count = 0
    for row in rows:
        for systems in by_animal.values():
            values = {sys_code: _num(row.get(col), 0.0) for sys_code, col in systems.items()}
            total = sum(values.values())
            if total <= 0:
                continue  # animal absent / unspecified in this area
            sums['direct'] += sum(v for s, v in values.items() if s in _MANURE_DIRECT_SYSTEMS) / total
            sums['storage'] += sum(v for s, v in values.items() if s in _MANURE_STORAGE_SYSTEMS) / total
            sums['treated'] += sum(v for s, v in values.items() if s in _MANURE_TREATED_SYSTEMS) / total
            count += 1

    if count == 0:
        return empty
    return {k: v / count for k, v in sums.items()}


def _exposure_events_per_year(freq):
    if not isinstance(freq, dict):
        return None
    ftype = freq.get('type')
    if ftype == 'fixed':
        return _num(freq.get('value'), None)
    if ftype == 'poisson':
        return _num(freq.get('lambda'), None)
    if ftype == 'nbinom':
        size = _num(freq.get('size'), None)
        prob = _num(freq.get('prob'), None)
        if size is not None and prob:
            return size * (1.0 - prob) / prob
    return None


def _compute_exposure_pathway_metrics(cs_path, folder):
    """Summarise the scenario's QMRA exposure-pathway configuration."""
    route_keys = ('drinking', 'swimming', 'flooding', 'open_drain', 'playing', 'washing_clothes')
    empty = {f'exposure_{route}_events_per_year': None for route in route_keys}
    try:
        cfg = resolve_qmra_config(cs_path, folder)
    except Exception:
        return empty

    pathways = cfg.get('pathways') or {}
    return {
        f'exposure_{route}_events_per_year': _exposure_events_per_year(
            (pathways.get(route) or {}).get('frequency')
        )
        for route in route_keys
    }


def _compute_driver_metrics_for_scenario(cs_path, folder):
    iso_path = _resolve_data_path(cs_path, folder, 'isodata.csv')
    iso_rows, _ = _read_csv_rows(iso_path)

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

    improved_sources = ['flushSewer', 'flushSeptic', 'flushPit', 'pitSlab', 'compostingToilet', 'containerBased']
    unimproved_sources = ['pitNoSlab', 'bucketLatrine', 'hangingToilet', 'flushOpen', 'flushUnknown', 'other']
    od_sources = ['openDefecation']

    improved_share = _weighted_sanitation_share(iso_rows, improved_sources)
    unimproved_share = _weighted_sanitation_share(iso_rows, unimproved_sources)
    od_share = _weighted_sanitation_share(iso_rows, od_sources)

    sewage_treated = _weighted_split_mean(iso_rows, 'sewageTreated_urb', 'sewageTreated_rur')
    fecal_sludge_treated = _weighted_split_mean(iso_rows, 'fecalSludgeTreated_urb', 'fecalSludgeTreated_rur')
    wwtp_mode = _detect_wwtp_mode(cs_path, folder).lower()

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

    ls = _detect_livestock_module(cs_path, folder)
    livestock_mean_growth = None
    production_progress_intensive = None
    manure = {'direct': None, 'storage': None, 'treated': None}
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
        manure = _compute_manure_management_metrics(ls['dir'])

    hy = _detect_hydrology_module(cs_path, folder)
    hy_metrics = _compute_hydrology_metrics(hy)

    ep_metrics = _compute_exposure_pathway_metrics(cs_path, folder)

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
            'manure_direct_land_application_pct': (100.0 * manure['direct']) if manure['direct'] is not None else None,
            'manure_storage_pct': (100.0 * manure['storage']) if manure['storage'] is not None else None,
            'manure_treated_pct': (100.0 * manure['treated']) if manure['treated'] is not None else None,
            'production_mean_progress_intensive_pct': production_progress_intensive,
            **hy_metrics,
            **ep_metrics,
        },
    }


# ──────────────────────────────────────────────────────────────────────────────
# Endpoint handlers
# ──────────────────────────────────────────────────────────────────────────────

def get_analytics(case_study_id):
    """Return scenarios for a case study, enriched with readiness data."""
    try:
        cs = next((c for c in case_studies if c['id'] == case_study_id), None)
        if not cs:
            return jsonify({'error': 'Case study not found'}), 404
        cs_path = cs['folder_path']
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')

        # ── Cache lookup ──────────────────────────────────────────────────────
        try:
            mtime = os.path.getmtime(meta_path) if os.path.exists(meta_path) else 0.0
        except OSError:
            mtime = 0.0
        cache_key = (case_study_id, mtime)
        with _analytics_cache_lock:
            entry = _analytics_cache.get(cache_key)
        if entry and (time.monotonic() - entry[0]) < _ANALYTICS_CACHE_TTL:
            return jsonify(entry[1]), 200

        # ── Compute ───────────────────────────────────────────────────────────
        scenarios_list = load_scenarios_from_metadata_csv(cs_path)
        result = [_enrich_scenario(s, cs_path, case_study_id) for s in scenarios_list]
        cs_out = dict(cs)
        cs_out['qmra_available'] = _qmra_available(cs_path)
        payload = {'scenarios': result, 'case_study': cs_out}

        # ── Cache store ───────────────────────────────────────────────────────
        with _analytics_cache_lock:
            # Evict any stale entries for this case study before storing.
            stale = [k for k in list(_analytics_cache) if k[0] == case_study_id and k != cache_key]
            for k in stale:
                del _analytics_cache[k]
            _analytics_cache[cache_key] = (time.monotonic(), payload)

        return jsonify(payload), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


# Every driver metric surfaced in the comparison table, in display order.
# Shared by the /driver-comparison endpoint, the /summary table and the
# narrative report generator so all three describe the same set of metrics.
DRIVER_METRIC_DEFS = [
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
    {'key': 'manure_direct_land_application_pct', 'driver': 'Manure management', 'label': 'Directly applied to land %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'negative_good'},
    {'key': 'manure_storage_pct', 'driver': 'Manure management', 'label': 'Stored before application %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
    {'key': 'manure_treated_pct', 'driver': 'Manure management', 'label': 'Digested or burned %', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'positive_good'},
    {'key': 'production_mean_progress_intensive_pct', 'driver': 'Production systems', 'label': 'Mean progress towards intensive', 'delta_mode': 'pp', 'value_format': 'percent', 'color_direction': 'neutral'},
    {'key': 'hydrology_mean_annual_discharge',   'driver': 'Hydrology', 'label': 'Mean river discharge (m³/s)',   'delta_mode': 'relative_pct', 'value_format': 'decimal', 'color_direction': 'positive_good'},
    {'key': 'hydrology_mean_annual_runoff',      'driver': 'Hydrology', 'label': 'Mean surface runoff (mm/day)',  'delta_mode': 'relative_pct', 'value_format': 'decimal', 'color_direction': 'negative_good'},
    {'key': 'hydrology_mean_river_temperature',  'driver': 'Hydrology', 'label': 'Mean river temperature (°C)',   'delta_mode': 'absolute',     'value_format': 'decimal', 'color_direction': 'positive_good'},
    {'key': 'hydrology_mean_ssrd',               'driver': 'Hydrology', 'label': 'Mean solar radiation (W/m²)', 'delta_mode': 'relative_pct', 'value_format': 'decimal', 'color_direction': 'positive_good'},
    {'key': 'exposure_drinking_events_per_year',        'driver': 'Exposure pathways', 'label': 'Drinking',        'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
    {'key': 'exposure_swimming_events_per_year',        'driver': 'Exposure pathways', 'label': 'Swimming',        'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
    {'key': 'exposure_flooding_events_per_year',        'driver': 'Exposure pathways', 'label': 'Flooding',        'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
    {'key': 'exposure_open_drain_events_per_year',      'driver': 'Exposure pathways', 'label': 'Open drain',      'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
    {'key': 'exposure_playing_events_per_year',         'driver': 'Exposure pathways', 'label': 'Playing',         'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
    {'key': 'exposure_washing_clothes_events_per_year', 'driver': 'Exposure pathways', 'label': 'Washing clothes', 'delta_mode': 'relative_pct', 'value_format': 'integer', 'color_direction': 'neutral'},
]


def get_driver_comparison(case_study_id):
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

        return jsonify({
            'baseline_scenario_id': baseline.get('id') if baseline else None,
            'metrics': DRIVER_METRIC_DEFS,
            'scenarios': scenarios_out,
        }), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def load_scenario_rows(cs_path):
    """Return the scenario_metadata.csv rows keyed by scenario_id (empty if absent)."""
    meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if not os.path.exists(meta_path):
        return {}
    rows_by_id = {}
    with open(meta_path, 'r', newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            sid = row.get('scenario_id')
            if sid:
                rows_by_id[sid] = row
    return rows_by_id


def build_narrative_scenario(cs, row, quantile=0.5, include_qmra=True):
    """Assemble the scenario dict consumed by narrative_generator.

    Combines the driver metrics derived from the scenario's inputs with the
    flattened QMRA results, if the scenario has been run. `qmra` is None when
    there are no risk outputs, which the templates handle explicitly.
    """
    folder = row.get('folder', 'baseline')
    derived = _compute_driver_metrics_for_scenario(cs['folder_path'], folder)
    scenario = {
        'id': row.get('scenario_id'),
        'name': row.get('name', 'Unnamed'),
        'folder': folder,
        'year': row.get('year', ''),
        'ssp': row.get('ssp', ''),
        'pathogen': row.get('pathogen', ''),
        'is_baseline': str(row.get('is_baseline', 'False')).lower() in ('true', '1', 'yes'),
        'wwtp_mode': derived['wwtp_mode'],
        'metrics': derived['metrics'],
        'qmra': None,
    }
    if include_qmra:
        try:
            from qmra import compute_qmra_report_metrics
            scenario['qmra'] = compute_qmra_report_metrics(cs, folder, quantile)
        except Exception:
            scenario['qmra'] = None
    return scenario


def get_narrative(case_study_id):
    """Generate a template-based narrative comparing two scenarios."""
    try:
        from narrative_generator import generate_narrative

        baseline_id = (request.args.get('baseline_id') or '').strip()
        scenario_id = (request.args.get('scenario_id') or '').strip()
        if not baseline_id or not scenario_id:
            return jsonify({'error': 'baseline_id and scenario_id are required'}), 400

        cs = next((c for c in case_studies if c['id'] == case_study_id), None)
        if not cs:
            return jsonify({'error': 'Case study not found'}), 404

        rows_by_id = load_scenario_rows(cs['folder_path'])
        if not rows_by_id:
            return jsonify({'error': 'No scenario metadata found'}), 404

        for sid in (baseline_id, scenario_id):
            if sid not in rows_by_id:
                return jsonify({'error': f'Scenario {sid!r} not found in metadata'}), 404

        baseline_sc = build_narrative_scenario(cs, rows_by_id[baseline_id])
        scenario_sc = build_narrative_scenario(cs, rows_by_id[scenario_id])

        narrative = generate_narrative(baseline_sc, scenario_sc)
        return jsonify({
            'narrative': narrative,
            'baseline_name': baseline_sc['name'],
            'scenario_name': scenario_sc['name'],
        }), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def get_scenario_info(scenario_id):
    """Return analytics info for a single scenario — fast alternative to loading
    all scenarios.  Used by ScenarioDetailView after a model run completes."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        scenarios_list = load_scenarios_from_metadata_csv(cs_path)
        scenario = next((s for s in scenarios_list if s.get('id') == scenario_id), None)
        if scenario is None:
            return jsonify({'error': 'Scenario not found'}), 404
        _enrich_scenario(scenario, cs_path, cs['id'])
        # Invalidate the case-study analytics cache so the next full-list fetch
        # reflects the updated has_outputs / has_livestock values.
        with _analytics_cache_lock:
            stale = [k for k in list(_analytics_cache) if k[0] == cs['id']]
            for k in stale:
                del _analytics_cache[k]
        return jsonify(scenario), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/case-studies/<case_study_id>/analytics',         ['GET'], get_analytics),
        ('/api/case-studies/<case_study_id>/driver-comparison', ['GET'], get_driver_comparison),
        ('/api/case-studies/<case_study_id>/narrative',         ['GET'], get_narrative),
        ('/api/scenarios/<scenario_id>/info',                   ['GET'], get_scenario_info),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
