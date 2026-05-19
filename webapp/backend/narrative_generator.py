"""
narrative_generator.py
======================

Jinja2-based narrative generator for GloWPa scenario comparison.

All text content lives in  templates/narrative/*.j2  (one file per driver).
This module only computes numeric context dicts and renders the templates.

Adding a new driver
-------------------
1.  Create  templates/narrative/<driver_slug>.j2  with the text.
2.  Write   _build_<driver>_ctx(bm, sm) -> dict  below.
3.  Append  (driver_name, template_file, builder_fn, needs_wwtp_mode)
    to  _DRIVER_BUILDERS.

Usage
-----
    from narrative_generator import generate_narrative
    result = generate_narrative(baseline_scenario, comparison_scenario)
    # result: { 'drivers': { '<Driver>': str|None, ... }, 'summary': str }
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


# ── Change magnitude thresholds ───────────────────────────────────────────────

_T_REL  = (5.0,  20.0)   # relative % changes
_T_PP   = (2.0,  10.0)   # percentage-point changes
_T_HDI  = (0.02,  0.05)  # HDI absolute
_T_TEMP = (0.5,   2.0)   # river temperature °C


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

def _build_population_ctx(bm: dict, sm: dict) -> dict:
    return {
        'pop': _mc(
            _m(bm, 'population_total'), _m(sm, 'population_total'),
            'relative_pct', _T_REL, _int_str,
        ),
        'urbanisation': _mc(
            _m(bm, 'population_urban_mean_pct'), _m(sm, 'population_urban_mean_pct'),
            'pp', _T_PP, _pct_str,
        ),
        'hdi': _mc(
            _m(bm, 'population_hdi_mean'), _m(sm, 'population_hdi_mean'),
            'absolute', _T_HDI, lambda v: _dec_str(v, dp=3),
        ),
    }


def _build_sanitation_ctx(bm: dict, sm: dict) -> dict:
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


def _build_wastewater_ctx(bm: dict, sm: dict, wwtp_mode: str = 'area') -> dict:
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
        'treatment_level_changed': treatment_level_sig,
        'advanced_treatment_increased': combined_adv > 0,
        'primary_treatment_increased': (prim_d or 0.0) > 0,
    }


def _build_livestock_ctx(bm: dict, sm: dict) -> dict:
    return {
        'population': _mc(
            _m(bm, 'livestock_mean_population_growth'), _m(sm, 'livestock_mean_population_growth'),
            'relative_pct', _T_REL,
        ),
        'production_systems': _mc(
            _m(bm, 'production_mean_progress_intensive_pct'), _m(sm, 'production_mean_progress_intensive_pct'),
            'pp', _T_PP, _pct_str,
        ),
    }


def _build_hydrology_ctx(bm: dict, sm: dict) -> dict:
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


def _build_summary_ctx(baseline: dict, scenario: dict, driver_texts: dict) -> dict:
    name = scenario.get('name', 'this scenario')
    year = str(scenario.get('year', '') or '')
    ssp  = str(scenario.get('ssp',  '') or '')

    header_parts = [p for p in [name, ssp, year] if p]
    header = ' \u2014 '.join(header_parts)

    active = [d for d, t in driver_texts.items() if t]
    if len(active) <= 1:
        driver_list_str = active[0] if active else ''
    elif len(active) == 2:
        driver_list_str = f'{active[0]} and {active[1]}'
    else:
        driver_list_str = ', '.join(active[:-1]) + f', and {active[-1]}'

    # Score net risk direction
    bm = baseline.get('metrics', {})
    sm = scenario.get('metrics', {})
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

    return {
        'header': header,
        'has_changes': bool(active),
        'driver_list_str': driver_list_str,
        'outlook': outlook,
    }


# ── Template renderer ─────────────────────────────────────────────────────────

def _render(template_name: str, ctx: dict) -> Optional[str]:
    """Render a Jinja2 template, collapse whitespace, return None if empty."""
    try:
        tmpl = _env.get_template(template_name)
        raw = tmpl.render(**ctx)
        text = re.sub(r'\s+', ' ', raw).strip()
        return text or None
    except Exception:
        return None


# ── Driver registry ───────────────────────────────────────────────────────────

# (driver_name, template_file, context_builder, needs_wwtp_mode)
_DRIVER_BUILDERS: list[tuple] = [
    ('Population',           'population.j2',  _build_population_ctx,  False),
    ('Sanitation',           'sanitation.j2',  _build_sanitation_ctx,  False),
    ('Wastewater treatment', 'wastewater.j2',  _build_wastewater_ctx,  True),
    ('Livestock',            'livestock.j2',   _build_livestock_ctx,   False),
    ('Hydrology',            'hydrology.j2',   _build_hydrology_ctx,   False),
]


# ── Public API ────────────────────────────────────────────────────────────────

def generate_narrative(baseline: dict, scenario: dict) -> dict:
    """Generate Jinja2-rendered narrative paragraphs for a scenario comparison.

    Args:
        baseline: scenario dict with keys 'metrics', 'wwtp_mode', 'name', 'year', 'ssp'.
        scenario: same shape as baseline.

    Returns:
        {
            'drivers': { '<Driver name>': '<paragraph>' | None, ... },
            'summary': '<one-paragraph summary>',
        }
    """
    bm = baseline.get('metrics', {})
    sm = scenario.get('metrics', {})
    wwtp_mode = scenario.get('wwtp_mode', 'area')

    driver_texts: dict[str, Optional[str]] = {}
    for driver_name, template_file, ctx_builder, needs_wwtp in _DRIVER_BUILDERS:
        ctx = ctx_builder(bm, sm, wwtp_mode) if needs_wwtp else ctx_builder(bm, sm)
        driver_texts[driver_name] = _render(template_file, ctx)

    summary_ctx = _build_summary_ctx(baseline, scenario, driver_texts)
    summary = _render('summary.j2', summary_ctx)

    return {
        'drivers': driver_texts,
        'summary': summary,
    }
