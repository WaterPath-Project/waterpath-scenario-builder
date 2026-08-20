"""
narrative_generator.py
======================

Jinja2-based narrative generator for GloWPa scenario comparison and for the
full reports produced by the /narratives section.

All text content lives in  templates/narrative/*.j2  (one file per section).
This module only computes numeric context dicts and renders the templates.
Rendered output is **Markdown**: paragraphs are separated by blank lines while
heading, list and table lines keep their own line breaks, so the browser editor
and the PDF renderer can both treat a section as Markdown.

Adding a new driver
-------------------
1.  Create  templates/narrative/<driver_slug>.j2  with the text.
2.  Write   _build_<driver>_ctx(baseline, scenario) -> dict  below.
3.  Append  (driver_name, template_file, builder_fn)  to  _DRIVER_BUILDERS,
    keeping the same order as the /scenarios sidebar.

Usage
-----
    from narrative_generator import generate_narrative, generate_report

    result = generate_narrative(baseline_scenario, comparison_scenario)
    # { 'drivers': { '<Driver>': str|None, ... }, 'summary': str }

    sections = generate_report(case_study_context, baseline, [scenario, ...])
    # [ { 'id', 'kind', 'title', 'scenario_id', 'driver', 'markdown' }, ... ]
"""

from __future__ import annotations

import os
import re
from typing import Optional

import jinja2

# ── Jinja2 environment ────────────────────────────────────────────────────────

_TEMPLATES_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'templates', 'narrative'
)

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(_TEMPLATES_DIR),
    autoescape=False,
    trim_blocks=True,       # swallow the newline after a block tag
    lstrip_blocks=True,     # strip leading whitespace before block tags
    undefined=jinja2.Undefined,
)

# Custom filter: format a float as "12" or "12.3" (drops trailing .0)
def _numfmt(v, dp: int = 1) -> str:
    if v is None:
        return 'N/A'
    rounded = round(float(v), dp)
    return str(int(rounded)) if rounded == int(rounded) else f'{rounded:.{dp}f}'

_env.filters['num'] = _numfmt


def _joinfmt(items, conjunction: str = 'and') -> str:
    """Join a list into readable prose: 'a', 'a and b', 'a, b and c'."""
    items = [str(i) for i in (items or []) if str(i).strip()]
    if not items:
        return ''
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f'{items[0]} {conjunction} {items[1]}'
    return ', '.join(items[:-1]) + f' {conjunction} {items[-1]}'


_env.filters['listjoin'] = _joinfmt


def _scifmt(v) -> str:
    """Compact rendering of the very large/small numbers in model outputs."""
    if v is None:
        return 'n/a'
    try:
        value = float(v)
    except (TypeError, ValueError):
        return 'n/a'
    if value != value or value == 0:
        return '0'
    import math as _math
    exponent = int(_math.floor(_math.log10(abs(value))))
    if -3 <= exponent <= 5:
        return f'{value:,.2f}'.rstrip('0').rstrip('.')
    mantissa = f'{value / (10 ** exponent):.1f}'.rstrip('0').rstrip('.')
    return f'{mantissa} x 10^{exponent}'


_env.filters['sci'] = _scifmt


# ── Change magnitude thresholds ───────────────────────────────────────────────

_T_REL  = (5.0,  20.0)   # relative % changes
_T_PP   = (2.0,  10.0)   # percentage-point changes
_T_HDI  = (0.02,  0.05)  # HDI absolute
_T_TEMP = (0.5,   2.0)   # river temperature °C
_T_RISK = (5.0,  25.0)   # relative % change in probability of infection


# Human-readable labels for the QMRA exposure routes (mirrors RiskPanel.jsx).
ROUTE_LABELS = {
    'drinking':        'drinking water',
    'swimming':        'swimming',
    'flooding':        'floodwater',
    'open_drain':      'open drains',
    'playing':         'children playing',
    'washing_clothes': 'washing clothes',
}


# ── Low-level helpers ─────────────────────────────────────────────────────────

def _delta(base, scen, mode: str) -> Optional[float]:
    """Signed change: relative_pct | pp | absolute."""
    if base is None or scen is None:
        return None
    if mode == 'relative_pct':
        return None if base == 0 else 100.0 * (scen - base) / abs(base)
    return float(scen) - float(base)


def _magnitude(d: Optional[float], thresholds: tuple) -> str:
    if d is None:
        return 'slightly'
    a = abs(d)
    if a < thresholds[0]:
        return 'slightly'
    if a < thresholds[1]:
        return 'moderately'
    return 'substantially'


def _m(metrics: dict, key: str):
    return metrics.get(key)


def _pct_str(v) -> str:
    return f'{v:.1f}%' if v is not None else 'N/A'


def _int_str(v) -> str:
    return f'{int(round(v)):,}' if v is not None else 'N/A'


def _dec_str(v, dp: int = 1) -> str:
    return f'{v:.{dp}f}' if v is not None else 'N/A'


def _risk_str(v) -> str:
    """Format a probability of infection the same way the UI does."""
    if v is None:
        return 'N/A'
    if 0 < v < 0.001:
        return f'{v:.2e}'
    return f'{v:.4f}'


def _metrics(scenario: dict) -> dict:
    return (scenario or {}).get('metrics') or {}


def _mc(base_val, scen_val, mode: str, thresholds: tuple, fmt_fn=None) -> dict:
    """Return a standardised metric context dict for use in templates.

    Keys available in templates:
        is_significant  bool
        increased       bool   (True = scen > base)
        magnitude       str    'slightly' | 'moderately' | 'substantially'
        abs_delta       float  pre-rounded to 1 dp (use with | num filter)
        base_val        str    formatted baseline value
        scen_val        str    formatted scenario value
    """
    d = _delta(base_val, scen_val, mode)
    sig = d is not None and abs(d) >= thresholds[0]
    fmt = fmt_fn or (lambda v: _dec_str(v))
    abs_d = round(abs(d), 1) if d is not None else None
    return {
        'is_significant': sig,
        'increased': bool(d is not None and d > 0),
        'magnitude': _magnitude(d, thresholds),
        'abs_delta': abs_d,
        'base_val': fmt(base_val) if base_val is not None else 'N/A',
        'scen_val': fmt(scen_val) if scen_val is not None else 'N/A',
    }


# ── Context builders (one per driver) ────────────────────────────────────────

def _build_population_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'pop': _mc(
            _m(bm, 'population_total'), _m(sm, 'population_total'),
            'relative_pct', _T_REL, _int_str,
        ),
        'urbanisation': _mc(
            _m(bm, 'population_urban_mean_pct'), _m(sm, 'population_urban_mean_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'under5': _mc(
            _m(bm, 'population_under5_mean_pct'), _m(sm, 'population_under5_mean_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'hdi': _mc(
            _m(bm, 'population_hdi_mean'), _m(sm, 'population_hdi_mean'),
            'absolute', _T_HDI, lambda v: _dec_str(v, dp=3),
        ),
    }


def _build_sanitation_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'improved': _mc(
            _m(bm, 'sanitation_improved_pct'), _m(sm, 'sanitation_improved_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'open_defecation': _mc(
            _m(bm, 'sanitation_open_defecation_pct'), _m(sm, 'sanitation_open_defecation_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'unimproved': _mc(
            _m(bm, 'sanitation_unimproved_pct'), _m(sm, 'sanitation_unimproved_pct'),
            'pp', _T_PP, _pct_str,
        ),
    }


def _build_wastewater_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    wwtp_mode = (scenario or {}).get('wwtp_mode', 'area')
    tert_d = _delta(_m(bm, 'wastewater_share_tertiary_pct'),   _m(sm, 'wastewater_share_tertiary_pct'),   'pp')
    quat_d = _delta(_m(bm, 'wastewater_share_quaternary_pct'), _m(sm, 'wastewater_share_quaternary_pct'), 'pp')
    prim_d = _delta(_m(bm, 'wastewater_share_primary_pct'),    _m(sm, 'wastewater_share_primary_pct'),    'pp')
    combined_adv = (tert_d or 0.0) + (quat_d or 0.0)
    treatment_level_sig = any(d is not None and abs(d) >= _T_PP[0] for d in (tert_d, quat_d, prim_d))
    return {
        'is_point_mode': wwtp_mode == 'point',
        'sewage_treated': _mc(
            _m(bm, 'wastewater_sewage_treated_pct'), _m(sm, 'wastewater_sewage_treated_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'fecal_sludge': _mc(
            _m(bm, 'wastewater_fecal_sludge_treated_pct'), _m(sm, 'wastewater_fecal_sludge_treated_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'facility_count': _mc(
            _m(bm, 'wastewater_facility_count'), _m(sm, 'wastewater_facility_count'),
            'relative_pct', _T_REL, _int_str,
        ),
        'capacity': _mc(
            _m(bm, 'wastewater_total_capacity'), _m(sm, 'wastewater_total_capacity'),
            'relative_pct', _T_REL, _int_str,
        ),
        'treatment_level_changed': treatment_level_sig,
        'advanced_treatment_increased': combined_adv > 0,
        'primary_treatment_increased': (prim_d or 0.0) > 0,
    }


def _build_livestock_population_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'population': _mc(
            _m(bm, 'livestock_mean_population_growth'), _m(sm, 'livestock_mean_population_growth'),
            'relative_pct', _T_REL,
        ),
    }


def _build_manure_management_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'direct': _mc(
            _m(bm, 'manure_direct_land_application_pct'), _m(sm, 'manure_direct_land_application_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'storage': _mc(
            _m(bm, 'manure_storage_pct'), _m(sm, 'manure_storage_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'treated': _mc(
            _m(bm, 'manure_treated_pct'), _m(sm, 'manure_treated_pct'),
            'pp', _T_PP, _pct_str,
        ),
    }


def _build_production_systems_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'production_systems': _mc(
            _m(bm, 'production_mean_progress_intensive_pct'), _m(sm, 'production_mean_progress_intensive_pct'),
            'pp', _T_PP, _pct_str,
        ),
    }


def _build_hydrology_ctx(baseline: dict, scenario: dict) -> dict:
    bm, sm = _metrics(baseline), _metrics(scenario)
    return {
        'discharge': _mc(
            _m(bm, 'hydrology_mean_annual_discharge'), _m(sm, 'hydrology_mean_annual_discharge'),
            'relative_pct', _T_REL,
        ),
        'runoff': _mc(
            _m(bm, 'hydrology_mean_annual_runoff'), _m(sm, 'hydrology_mean_annual_runoff'),
            'relative_pct', _T_REL,
        ),
        'temperature': _mc(
            _m(bm, 'hydrology_mean_river_temperature'), _m(sm, 'hydrology_mean_river_temperature'),
            'absolute', _T_TEMP, lambda v: _dec_str(v, dp=1),
        ),
        'ssrd': _mc(
            _m(bm, 'hydrology_mean_ssrd'), _m(sm, 'hydrology_mean_ssrd'),
            'relative_pct', _T_REL,
        ),
    }


def _build_risk_ctx(baseline: dict, scenario: dict) -> dict:
    """Context for the QMRA / Risk narrative.

    Consumes the flattened dict produced by `qmra.compute_qmra_report_metrics`,
    attached to each scenario under the 'qmra' key. Either side may be missing:
    a scenario that has never been run has no risk results, and a baseline
    without results means only absolute figures can be reported.
    """
    sq = (scenario or {}).get('qmra') or {}
    bq = (baseline or {}).get('qmra') or {}

    if sq.get('risk_annual_combined') is None:
        return {'has_risk': False}

    combined = sq.get('risk_annual_combined')
    low, high = sq.get('risk_annual_combined_low'), sq.get('risk_annual_combined_high')

    # Rank exposure pathways by population-weighted annual risk.
    routes = sq.get('risk_routes') or {}
    ranked = sorted(routes.items(), key=lambda kv: kv[1], reverse=True)
    route_rows = [
        {'key': key, 'label': ROUTE_LABELS.get(key, key.replace('_', ' ')),
         'value': _risk_str(value)}
        for key, value in ranked
    ]
    dominant_key = sq.get('risk_dominant_route')

    # Seasonality only reads as meaningful once the peak sits a few percent
    # above the trough; below that the monthly series is essentially flat.
    peak_v, trough_v = sq.get('risk_peak_value'), sq.get('risk_trough_value')
    seasonal_ratio = (peak_v / trough_v) if (peak_v and trough_v and trough_v > 0) else None

    top_areas = [
        {'name': a.get('name'), 'risk': _risk_str(a.get('risk')),
         'cases': _int_str(a.get('cases'))}
        for a in (sq.get('risk_top_areas') or [])
    ]

    return {
        'has_risk': True,
        'has_baseline_risk': bq.get('risk_annual_combined') is not None,
        'quantile': sq.get('risk_quantile'),
        'combined_val': _risk_str(combined),
        'combined': _mc(
            bq.get('risk_annual_combined'), combined,
            'relative_pct', _T_RISK, _risk_str,
        ),
        'has_band': low is not None and high is not None,
        'band_low': _risk_str(low),
        'band_high': _risk_str(high),
        'band_is_wide': bool(low and high and low > 0 and (high / low) >= 2.0),
        'dominant_label': ROUTE_LABELS.get(dominant_key, (dominant_key or '').replace('_', ' ')),
        'dominant_val': _risk_str(routes.get(dominant_key)),
        'route_rows': route_rows,
        'secondary_labels': [r['label'] for r in route_rows[1:3]],
        'cases_val': _int_str(sq.get('risk_expected_cases')),
        'cases': _mc(
            bq.get('risk_expected_cases'), sq.get('risk_expected_cases'),
            'relative_pct', _T_RISK, _int_str,
        ),
        'population_val': _int_str(sq.get('risk_population')),
        'has_seasonality': bool(seasonal_ratio and seasonal_ratio >= 1.05),
        'peak_month': sq.get('risk_peak_month'),
        'peak_val': _risk_str(peak_v),
        'trough_month': sq.get('risk_trough_month'),
        'trough_val': _risk_str(trough_v),
        'seasonal_pct': round((seasonal_ratio - 1.0) * 100.0, 1) if seasonal_ratio else None,
        'top_areas': top_areas,
        'area_count': sq.get('risk_area_count'),
        'worst_area': top_areas[0]['name'] if top_areas else None,
        'show_area_ranking': len(top_areas) > 1,
    }


# ── Non-driver section builders ──────────────────────────────────────────────

_ADMIN_LEVEL_DESC = {
    0: 'national',
    1: 'first-level sub-national (e.g. province or region)',
    2: 'second-level sub-national (e.g. district)',
    3: 'third-level sub-national (e.g. sub-county)',
    4: 'fourth-level sub-national (e.g. parish or ward)',
}


def _build_intro_ctx(context: dict, baseline: dict, scenarios: list) -> dict:
    """Context for the report introduction, from the case-study metadata."""
    context = context or {}
    countries = context.get('countries') or []

    scenario_rows = []
    for s in scenarios or []:
        detail = ', '.join(b for b in (str(s.get('ssp') or ''), str(s.get('year') or '')) if b)
        scenario_rows.append({
            'name': s.get('name') or 'Unnamed scenario',
            'detail': detail,
            'has_risk': (s.get('qmra') or {}).get('risk_annual_combined') is not None,
        })

    admin_level = context.get('admin_level')
    return {
        'title': context.get('title') or 'Case study',
        'description': context.get('description') or '',
        'study_area_description': context.get('study_area_description') or '',
        'authors': context.get('authors') or '',
        'organisation': context.get('organisation') or '',
        'funding': context.get('funding') or '',
        'report_notes': context.get('report_notes') or '',
        'countries': countries,
        'country_count': len(countries),
        'has_geography': bool(countries or context.get('area_count')),
        'area_count': context.get('area_count'),
        'admin_level': admin_level,
        'admin_level_desc': _ADMIN_LEVEL_DESC.get(admin_level),
        'area_names_sample': context.get('area_names_sample') or [],
        'pathogens': context.get('pathogens') or [],
        'ssps': context.get('ssps') or [],
        'years': context.get('years') or [],
        'baseline_name': (baseline or {}).get('name') or context.get('baseline_name'),
        'baseline_year': str((baseline or {}).get('year') or ''),
        'scenario_count': len(scenarios or []),
        'scenario_rows': scenario_rows,
        'any_risk': any(r['has_risk'] for r in scenario_rows),
        'driver_notes': _applicable_driver_notes(baseline, scenarios),
    }


# Plain-language explanation of every driver, in /scenarios sidebar order.
# `prefix` is the metric-key prefix used to decide whether the driver is
# actually parameterised for a given case study; None means "always shown".
DRIVER_DESCRIPTIONS = [
    ('Population', 'population_',
     'How many people live in each reporting area, how urban that population is, what share is '
     'under five and how the Human Development Index develops. Population size and its '
     'distribution set the amount of human excreta that has to be managed.'),
    ('Sanitation', 'sanitation_',
     'The mix of toilet facilities people use, summarised as the improved, unimproved and '
     'open-defecation shares of the sanitation ladder. The facility type decides how much excreta '
     'is contained and how much reaches soil and water directly.'),
    ('Wastewater treatment', 'wastewater_',
     'What happens to the excreta that is collected: the share of sewage and of faecal sludge that '
     'is treated, the number and capacity of treatment plants, and the treatment levels applied. '
     'Higher treatment levels remove more pathogens before the effluent is discharged.'),
    ('Livestock population', 'livestock_',
     'The number of animals kept in the study area, by species. Livestock manure is usually the '
     'largest diffuse source of pathogens reaching surface water.'),
    ('Manure management', 'manure_',
     'What happens to livestock manure: direct application to land, storage before application, or '
     'digestion and burning. Storage and treatment give pathogens time to die off before the '
     'manure reaches a field.'),
    ('Production systems', 'production_',
     'How far livestock keeping shifts from extensive towards intensive '
     'production. Intensive systems concentrate manure in fewer places, which changes both where '
     'emissions arise and how they can be controlled.'),
    ('Hydrology', 'hydrology_',
     'The climate and river conditions that transport and dilute the pathogens: river discharge, '
     'surface runoff, water temperature and solar radiation. Discharge dilutes the load, while '
     'temperature and sunlight speed up die-off.'),
    ('Risk', None,
     'Determines the probability that a person becomes infected, given how often and in what way they come into contact with the water.'),
]


def _applicable_driver_notes(baseline: dict, scenarios: list) -> list:
    """Describe only the drivers this case study actually parameterises."""
    all_scenarios = [s for s in ([baseline] + list(scenarios or [])) if s]
    has_risk = any((s.get('qmra') or {}).get('risk_annual_combined') is not None
                   for s in all_scenarios)

    notes = []
    for name, prefix, description in DRIVER_DESCRIPTIONS:
        if prefix is None:
            if not has_risk:
                continue
        else:
            present = any(
                value is not None
                for s in all_scenarios
                for key, value in (_metrics(s) or {}).items()
                if key.startswith(prefix)
            )
            if not present:
                continue
        notes.append({'name': name, 'description': description})
    return notes


def _amount_str(value: float, mode: str) -> str:
    """Format the size of a change with the unit implied by its delta mode."""
    if mode == 'relative_pct':
        return f'{_numfmt(value)}%'
    if mode == 'pp':
        return f'{_numfmt(value)} pp'
    # Absolute changes span very different scales (HDI ~0.05, temperature ~3).
    if abs(value) < 1:
        return f'{value:.3f}'.rstrip('0').rstrip('.')
    return _numfmt(value, 1)


def _build_driver_table_ctx(metric_defs: list, baseline: dict, scenarios: list) -> dict:
    """Context for the page introducing the driver-comparison table.

    Names exactly which metrics crossed the significance threshold, so the
    reader knows what to look for in the table that follows. Changes are
    aggregated per metric across the selected scenarios -- a report comparing
    fifteen scenarios would otherwise produce an unreadable list.
    """
    modes = {'pp': _T_PP, 'relative_pct': _T_REL, 'absolute': _T_TEMP}
    bm = _metrics(baseline)
    scenarios = scenarios or []
    total = len(scenarios)

    changed_by_driver: dict[str, list] = {}
    driver_order: list[str] = []

    for md in metric_defs or []:
        driver = md.get('driver', 'Other')
        if driver not in driver_order:
            driver_order.append(driver)

        mode = md.get('delta_mode', 'absolute')
        thresh = _T_HDI if md.get('key') == 'population_hdi_mean' else modes.get(mode, _T_REL)

        deltas = []
        for s in scenarios:
            d = _delta(_m(bm, md['key']), _m(_metrics(s), md['key']), mode)
            if d is not None and abs(d) >= thresh[0]:
                deltas.append((s.get('name') or 'Unnamed scenario', d))
        if not deltas:
            continue

        ups = [d for _, d in deltas if d > 0]
        downs = [d for _, d in deltas if d < 0]
        direction = 'increases' if not downs else ('decreases' if not ups else 'changes')

        sizes = sorted(abs(d) for _, d in deltas)
        amount = _amount_str(sizes[0], mode)
        if len(sizes) > 1 and sizes[0] != sizes[-1]:
            amount = f'{amount} to {_amount_str(sizes[-1], mode)}'

        if len(deltas) == 1:
            scope = deltas[0][0] if total > 1 else ''
        elif len(deltas) == total:
            scope = 'all scenarios'
        else:
            scope = f'{len(deltas)} of {total} scenarios'

        changed_by_driver.setdefault(driver, []).append({
            'label': md.get('label') or md.get('key'),
            'direction': direction,
            'magnitude': _magnitude(sizes[-1], thresh),
            'amount': amount,
            'scope': scope,
        })

    return {
        'has_changes': bool(changed_by_driver),
        'scenario_count': total,
        'baseline_name': (baseline or {}).get('name') or 'the baseline',
        'multi_scenario': total > 1,
        'changed_by_driver': [
            {'driver': d, 'entries': changed_by_driver[d]}
            for d in driver_order if d in changed_by_driver
        ],
        'changed_driver_names': [d for d in driver_order if d in changed_by_driver],
        'unchanged_drivers': [d for d in driver_order if d not in changed_by_driver],
    }


def _build_summary_ctx(baseline: dict, scenario: dict, driver_texts: dict) -> dict:
    name = scenario.get('name', 'this scenario')
    year = str(scenario.get('year', '') or '')
    ssp  = str(scenario.get('ssp',  '') or '')

    header_parts = [p for p in [name, ssp, year] if p]
    header = ', '.join(header_parts)

    active = [d for d, t in driver_texts.items() if t and d != 'Risk']

    # Score net risk direction
    bm = _metrics(baseline)
    sm = _metrics(scenario)
    positive = negative = 0
    checks = [
        ('sanitation_improved_pct',            'pp',           +1),
        ('sanitation_open_defecation_pct',     'pp',           -1),
        ('wastewater_sewage_treated_pct',      'pp',           +1),
        ('wastewater_fecal_sludge_treated_pct','pp',           +1),
        ('hydrology_mean_annual_discharge',    'relative_pct', +1),
        ('hydrology_mean_annual_runoff',       'relative_pct', -1),
        ('hydrology_mean_river_temperature',   'absolute',     +1),
        ('hydrology_mean_ssrd',                'relative_pct', +1),
        ('livestock_mean_population_growth',   'relative_pct', -1),
        ('manure_direct_land_application_pct', 'pp',           -1),
        ('manure_storage_pct',                 'pp',           +1),
        ('manure_treated_pct',                 'pp',           +1),
    ]
    for key, mode, good_dir in checks:
        d = _delta(_m(bm, key), _m(sm, key), mode)
        thresh = _T_PP if mode == 'pp' else (_T_TEMP if mode == 'absolute' else _T_REL)
        if d is None or abs(d) < thresh[0]:
            continue
        if (d > 0 and good_dir == +1) or (d < 0 and good_dir == -1):
            positive += 1
        else:
            negative += 1

    if positive > negative:
        outlook = 'positive'
    elif negative > positive:
        outlook = 'negative'
    else:
        outlook = 'mixed'

    # Where QMRA has actually been run, the modelled risk outranks the
    # direction inferred from the input drivers.
    sq = (scenario or {}).get('qmra') or {}
    bq = (baseline or {}).get('qmra') or {}
    risk_delta = _delta(bq.get('risk_annual_combined'), sq.get('risk_annual_combined'),
                        'relative_pct')
    risk_confirms = None
    if risk_delta is not None and abs(risk_delta) >= _T_RISK[0]:
        modelled = 'negative' if risk_delta > 0 else 'positive'
        risk_confirms = (modelled == outlook)
        outlook = modelled

    return {
        'header': header,
        'has_changes': bool(active),
        'driver_list_str': _joinfmt(active),
        'outlook': outlook,
        'has_modelled_risk': risk_delta is not None,
        'risk_is_significant': risk_delta is not None and abs(risk_delta) >= _T_RISK[0],
        'risk_increased': bool(risk_delta is not None and risk_delta > 0),
        'risk_abs_delta': round(abs(risk_delta), 1) if risk_delta is not None else None,
        'risk_confirms_drivers': risk_confirms,
    }


# ── Result map sections ───────────────────────────────────────────────────────

def _outputs(scenario: dict, key: str):
    """Model-output statistics attached by report_outputs.compute_output_stats."""
    return ((scenario or {}).get('outputs') or {}).get(key) or None


def _build_map_emissions_ctx(baseline: dict, scenario: dict) -> dict:
    stats = _outputs(scenario, 'emissions')
    if not stats:
        return {'available': False}
    base = _outputs(baseline, 'emissions')
    change = _delta((base or {}).get('total'), stats.get('total'), 'relative_pct')
    return {
        'available': True,
        'e': stats,
        'is_baseline': bool(scenario.get('is_baseline')),
        'has_change': change is not None and not scenario.get('is_baseline'),
        'change_pct': abs(change) if change is not None else None,
        'increased': bool(change is not None and change > 0),
        'magnitude': _magnitude(change, _T_REL),
    }


def _build_map_concentration_ctx(baseline: dict, scenario: dict) -> dict:
    stats = _outputs(scenario, 'concentration')
    if not stats:
        return {'available': False}
    base = _outputs(baseline, 'concentration')
    change = _delta((base or {}).get('mean'), stats.get('mean'), 'relative_pct')
    return {
        'available': True,
        'c': stats,
        'is_baseline': bool(scenario.get('is_baseline')),
        'has_change': change is not None and not scenario.get('is_baseline'),
        'change_pct': abs(change) if change is not None else None,
        'increased': bool(change is not None and change > 0),
        'magnitude': _magnitude(change, _T_REL),
        'strong_seasonality': bool((stats.get('seasonal_ratio') or 0) >= 2),
    }


def _build_map_risk_ctx(baseline: dict, scenario: dict) -> dict:
    risk = (scenario or {}).get('qmra') or {}
    if risk.get('risk_annual_combined') is None:
        return {'available': False}
    top = risk.get('risk_top_areas') or []
    spread = None
    if len(top) > 1 and top[-1].get('risk'):
        spread = top[0]['risk'] / top[-1]['risk']
    return {
        'available': True,
        'r': risk,
        'top_areas': top,
        'top_area_names': [a['name'] for a in top[:3]],
        'area_count': risk.get('risk_area_count'),
        'spread': spread,
        'route_label': ROUTE_LABELS.get(risk.get('risk_dominant_route'),
                                        risk.get('risk_dominant_route')),
        'quantile': risk.get('risk_quantile'),
    }


# (map kind, section title, template, context builder). `map kind` matches the
# keys produced by report_outputs.render_scenario_maps, so the report builder
# can attach the right image to each section.
_MAP_BUILDERS: list[tuple] = [
    ('emissions',     'Emissions to surface water',  'map_emissions.j2',     _build_map_emissions_ctx),
    ('concentration', 'Concentrations in rivers',    'map_concentration.j2', _build_map_concentration_ctx),
    ('risk',          'Spatial spread of the risk',  'map_risk.j2',          _build_map_risk_ctx),
]


# ── Template renderer ─────────────────────────────────────────────────────────

# Lines that carry Markdown structure and must keep their own line break.
_STRUCTURAL_RE = re.compile(r'^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```)')


def _tidy_markdown(raw: str) -> str:
    """Normalise Jinja output into clean Markdown.

    Templates wrap prose over several source lines for readability; those lines
    are joined back into single paragraphs. Structural lines (headings, list
    items, table rows, quotes, code fences) keep their line breaks so that
    Markdown still parses them.
    """
    blocks: list[str] = []
    paragraph: list[str] = []
    structural: list[str] = []

    def flush_paragraph():
        if paragraph:
            blocks.append(re.sub(r'\s+', ' ', ' '.join(paragraph)).strip())
            paragraph.clear()

    def flush_structural():
        if structural:
            blocks.append('\n'.join(structural))
            structural.clear()

    for line in (raw or '').split('\n'):
        if not line.strip():
            flush_paragraph()
            flush_structural()
        elif _STRUCTURAL_RE.match(line):
            flush_paragraph()
            structural.append(re.sub(r'[ \t]+', ' ', line).strip())
        else:
            flush_structural()
            paragraph.append(line.strip())
    flush_paragraph()
    flush_structural()

    return '\n\n'.join(b for b in blocks if b)


def _render(template_name: str, ctx: dict) -> Optional[str]:
    """Render a Jinja2 template to Markdown; return None if it produces nothing."""
    try:
        tmpl = _env.get_template(template_name)
        return _tidy_markdown(tmpl.render(**ctx)) or None
    except Exception:
        return None


# ── Driver registry ───────────────────────────────────────────────────────────

# (driver_name, template_file, context_builder) in /scenarios sidebar order.
# Every builder receives the full baseline and scenario dicts.
_DRIVER_BUILDERS: list[tuple] = [
    ('Population',           'population.j2',           _build_population_ctx),
    ('Sanitation',           'sanitation.j2',           _build_sanitation_ctx),
    ('Wastewater treatment', 'wastewater.j2',           _build_wastewater_ctx),
    ('Livestock population', 'livestock_population.j2', _build_livestock_population_ctx),
    ('Manure management',    'manure_management.j2',    _build_manure_management_ctx),
    ('Production systems',   'production_systems.j2',   _build_production_systems_ctx),
    ('Hydrology',            'hydrology.j2',            _build_hydrology_ctx),
    ('Risk',                 'risk.j2',                 _build_risk_ctx),
]


# ── Public API ────────────────────────────────────────────────────────────────

def generate_narrative(baseline: dict, scenario: dict) -> dict:
    """Generate Jinja2-rendered narrative paragraphs for a scenario comparison.

    Args:
        baseline: scenario dict with keys 'metrics', 'wwtp_mode', 'name', 'year',
            'ssp' and optionally 'qmra'.
        scenario: same shape as baseline.

    Returns:
        {
            'drivers': { '<Driver name>': '<markdown>' | None, ... },
            'summary': '<one-paragraph summary>',
        }
    """
    driver_texts: dict[str, Optional[str]] = {}
    for driver_name, template_file, ctx_builder in _DRIVER_BUILDERS:
        driver_texts[driver_name] = _render(template_file, ctx_builder(baseline, scenario))

    summary = _render('summary.j2', _build_summary_ctx(baseline, scenario, driver_texts))

    return {
        'drivers': driver_texts,
        'summary': summary,
    }


def _slug(value) -> str:
    return re.sub(r'[^a-z0-9]+', '-', str(value or '').lower()).strip('-') or 'section'


def generate_report(context: dict, baseline: dict, scenarios: list,
                    metric_defs: Optional[list] = None) -> list:
    """Build the ordered list of report sections for a case study.

    Args:
        context: output of `case_study.derive_case_study_context`.
        baseline: the baseline scenario dict (metrics + optional 'qmra').
        scenarios: the comparison scenarios the user selected, in display order.
        metric_defs: the `metrics` list from `analytics.get_driver_comparison`,
            used to name the metrics that changed significantly.

    Returns:
        A list of section dicts with keys
        `id`, `kind`, `title`, `scenario_id`, `driver`, `markdown` and, for map
        sections, `map_kind`.  `kind` is one of:
        intro | driver_table | driver | map | risk | summary.
        The raw-data appendix is not part of this list: it is a separate,
        on-demand document (see report_render.render_appendix_html).
    """
    scenarios = scenarios or []

    sections = [{
        'id': 'introduction',
        'kind': 'intro',
        'title': 'Introduction',
        'scenario_id': None,
        'driver': None,
        'markdown': _render('introduction.j2',
                            _build_intro_ctx(context, baseline, scenarios)) or '',
    }, {
        'id': 'driver-table',
        'kind': 'driver_table',
        'title': 'Summary of driver changes',
        'scenario_id': None,
        'driver': None,
        'markdown': _render('driver_table_intro.j2',
                            _build_driver_table_ctx(metric_defs or [], baseline, scenarios)) or '',
    }]

    for scenario in scenarios:
        scenario_id = scenario.get('id') or _slug(scenario.get('name'))
        driver_texts: dict[str, Optional[str]] = {}

        def emit_maps(kinds):
            """Append the result-map sections whose narrative could be built."""
            for map_kind, title, template_file, ctx_builder in _MAP_BUILDERS:
                if map_kind not in kinds:
                    continue
                text = _render(template_file, ctx_builder(baseline, scenario))
                if not text:
                    continue
                sections.append({
                    'id': f'{scenario_id}--map-{map_kind}',
                    'kind': 'map',
                    'title': title,
                    'scenario_id': scenario_id,
                    'driver': None,
                    'map_kind': map_kind,
                    'markdown': text,
                })

        for driver_name, template_file, ctx_builder in _DRIVER_BUILDERS:
            text = _render(template_file, ctx_builder(baseline, scenario))
            driver_texts[driver_name] = text
            # Results follow the input drivers, so the maps sit between the
            # hydrology narrative and the risk narrative they explain.
            if driver_name == 'Risk':
                emit_maps(('emissions', 'concentration'))
            if not text:
                continue
            sections.append({
                'id': f'{scenario_id}--{_slug(driver_name)}',
                'kind': 'risk' if driver_name == 'Risk' else 'driver',
                'title': driver_name,
                'scenario_id': scenario_id,
                'driver': driver_name,
                'markdown': text,
            })
            if driver_name == 'Risk':
                emit_maps(('risk',))

        sections.append({
            'id': f'{scenario_id}--summary',
            'kind': 'summary',
            'title': 'Summary',
            'scenario_id': scenario_id,
            'driver': None,
            'markdown': _render('summary.j2',
                                _build_summary_ctx(baseline, scenario, driver_texts)) or '',
        })

    return sections
