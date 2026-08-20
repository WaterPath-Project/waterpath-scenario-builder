"""QMRA wrapper: detects whether a scenario has the concentration outputs
required to run the GloWPaQMRA package, builds R wrapper scripts equivalent
to ``qmra_run.R`` from the upstream library, executes them inside the
``qmra-container`` via Docker exec, and exposes the results to the UI.

The generated R script is a scratch artifact: it is written to a temporary
subfolder and deleted once the run finishes (success or failure), so it never
lingers in the persisted output tree. The QMRA config is likewise not
duplicated per scenario -- the shared config lives once under
``input/baseline/qmra/qmra_config.json`` (see ``_baseline_qmra_config_path``).

Fixed layout per scenario (previous run is overwritten each time):

  data/<case_study>/output/<scenario_folder>/qmra/
      qmra.log                      # combined stdout/stderr of the last run
      combined/                     # all enabled routes combined
          monthly/                  # monthly-compounded run
              annual_risk.tif       # 12-month compounded probability of infection
              expected_cases.tif    # annual_risk (q0.5) x population
              <pathogen>_jan.tif … <pathogen>_dec.tif
          daily/                    # single-day exposure run
              <pathogen>_jan.tif … <pathogen>_dec.tif
      routes/<route>/               # same structure, isolated per route
          monthly/
          daily/
"""

import json
import os
import re
import threading
import traceback
import uuid
from datetime import datetime

from flask import jsonify, request, send_file

import state
from fs_utils import _locate_scenario, area_label, find_geodata_shapefile
from state import DOCKER_SOCK, model_runs


# Mirrors the Uganda example values shipped with the upstream qmra_run.R.
# Volumes are mL per event; ``glass`` is mL per "drinking glass".
DEFAULT_EXPOSURE_GROUPS = [
    {
        'name': 'drinking', 'route': 'drinking', 'type': 'poisson',
        'lambda': 3.49, 'glass': 250, 'frequency': 365,
    },
    {
        'name': 'swimming', 'route': 'swimming', 'type': 'triangular',
        'min': 20, 'mode': 35, 'max': 50,
        'frequency': {'dist': 'nbinom', 'size': 0.4, 'prob': 0.11},
    },
    {
        'name': 'flooding', 'route': 'flooding', 'type': 'triangular',
        'min': 10, 'mode': 100, 'max': 300,
        'frequency': {'dist': 'poisson', 'lambda': 1},
    },
    {
        'name': 'open_drain', 'route': 'open_drain', 'type': 'triangular',
        'min': 0.5, 'mode': 3, 'max': 20,
        'frequency': {'dist': 'poisson', 'lambda': 200},
    },
    {
        'name': 'playing', 'route': 'playing', 'type': 'triangular',
        'min': 1, 'mode': 10, 'max': 50,
        'frequency': {'dist': 'poisson', 'lambda': 30},
    },
    {
        'name': 'washing_clothes', 'route': 'washing_clothes', 'type': 'triangular',
        'min': 0.1, 'mode': 1, 'max': 5,
        'frequency': {'dist': 'poisson', 'lambda': 200},
    },
]

# Beta-Poisson defaults, matching the engine fallbacks in the upstream package.
DEFAULT_BP_PARAMS = {
    'cryptosporidium': {'muw': -1.323, 'muz': -0.206, 'varw': 0.294, 'varz': 1.054, 'cov': -0.0625},
    'rotavirus':       {'muw':  0.571, 'muz': -5.093, 'varw': 0.677, 'varz': 28.180, 'cov': -2.728},
}

QMRA_CONTAINER = 'qmra-container'

# Calendar-month suffixes used in the per-month QMRA output filenames
# (e.g. cryptosporidium_jan.tif), in chronological order.
MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
          'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
               'July', 'August', 'September', 'October', 'November', 'December']

# ── Default per-pathway QMRA configuration ───────────────────────────────────
# volume.type: 'poisson' (lambda, glass) or 'triangular' (min, mode, max)  — mL per event
# frequency.type: 'fixed' (value) | 'poisson' (lambda) | 'nbinom' (size, prob)
DEFAULT_QMRA_CONFIG = {
    'mci':       1000,
    'model':     'bp',
    'quantiles': [0.025, 0.5, 0.975],
    'bp_params': DEFAULT_BP_PARAMS,
    'pathways': {
        'drinking': {
            'enabled': True,
            'volume':    {'type': 'poisson',    'lambda': 3.49, 'glass': 250},
            'frequency': {'type': 'fixed',      'value': 365},
            'boiling':   False,
            'use_treatment': False,
        },
        'swimming': {
            'enabled': False,
            'volume':    {'type': 'triangular', 'min': 20.0,  'mode': 35.0,  'max': 50.0},
            'frequency': {'type': 'nbinom',     'size': 0.4,  'prob': 0.11},
        },
        'flooding': {
            'enabled': False,
            'volume':    {'type': 'triangular', 'min': 10.0,  'mode': 100.0, 'max': 300.0},
            'frequency': {'type': 'poisson',    'lambda': 1.0},
        },
        'open_drain': {
            'enabled': False,
            'volume':    {'type': 'triangular', 'min': 0.5,   'mode': 3.0,   'max': 20.0},
            'frequency': {'type': 'poisson',    'lambda': 200.0},
        },
        'playing': {
            'enabled': False,
            'volume':    {'type': 'triangular', 'min': 1.0,   'mode': 10.0,  'max': 50.0},
            'frequency': {'type': 'poisson',    'lambda': 30.0},
        },
        'washing_clothes': {
            'enabled': False,
            'volume':    {'type': 'triangular', 'min': 0.1,   'mode': 1.0,   'max': 5.0},
            'frequency': {'type': 'poisson',    'lambda': 200.0},
        },
    },
}


def _pathway_to_exposure_group(route, pc):
    """Convert per-pathway config dict to an exposure group dict for qmra_ras_batch_fast."""
    vol = pc.get('volume') or {}
    vol_type = vol.get('type', 'triangular')
    g = {'name': route, 'route': route}
    if vol_type == 'poisson':
        g['type'] = 'poisson'
        g['lambda'] = float(vol.get('lambda', 1.0))
        if 'glass' in vol:
            g['glass'] = int(vol['glass'])
    else:  # triangular (default)
        g['type'] = 'triangular'
        g['min']  = float(vol.get('min', 1))
        g['mode'] = float(vol.get('mode', 10))
        g['max']  = float(vol.get('max', 50))
    freq = pc.get('frequency') or {}
    if not isinstance(freq, dict):
        g['frequency'] = 365
    else:
        ft = freq.get('type', 'fixed')
        if ft == 'fixed':
            g['frequency'] = int(float(freq.get('value', 365)))
        elif ft == 'poisson':
            g['frequency'] = {'dist': 'poisson', 'lambda': float(freq.get('lambda', 1))}
        elif ft == 'nbinom':
            g['frequency'] = {'dist': 'nbinom', 'size': float(freq.get('size', 0.4)),
                               'prob': float(freq.get('prob', 0.11))}
        else:
            g['frequency'] = 365
    return g


# ──────────────────────────────────────────────────────────────────────────────
# Concentration discovery
# ──────────────────────────────────────────────────────────────────────────────

def _conc_dir(cs_path, folder):
    """Return the directory holding monthly stream concentration TIFs, or None."""
    candidate = os.path.join(cs_path, 'output', folder, 'hydrology', 'conc')
    return candidate if os.path.isdir(candidate) else None


def _conc_tifs(cs_path, folder):
    d = _conc_dir(cs_path, folder)
    if not d:
        return []
    files = [
        f for f in os.listdir(d)
        if f.lower().endswith('.tif')
           and not f.endswith('.aux.json')
           and re.search(r'm\d{1,2}\.tif$', f, re.IGNORECASE)
    ]
    return sorted(files)


def _pop_rasters(cs_path, folder):
    """Return (poprural_path, popurban_path) for the scenario, or (None, None).

    Search order:
      1. input/<folder>/human_emissions/  — baseline layout
      2. input/<folder>/                  — projection layout (SSP scenarios)
      3. input/baseline/human_emissions/  — fallback to baseline population
    """
    candidates = [
        os.path.join(cs_path, 'input', folder, 'human_emissions'),
        os.path.join(cs_path, 'input', folder),
        os.path.join(cs_path, 'input', 'baseline', 'human_emissions'),
    ]
    for base in candidates:
        rural = os.path.join(base, 'poprural.tif')
        urban = os.path.join(base, 'popurban.tif')
        if os.path.exists(rural) and os.path.exists(urban):
            return rural, urban
    return None, None


def _pop_grid_for(cs_path, folder, ref_path):
    """Return total population (rural+urban) resampled onto the grid of ref_path.

    Used to compute population-weighted ("average person's") risk. Returns a
    numpy float64 array aligned to ref_path, or None if population data or
    dependencies are unavailable.
    """
    try:
        import numpy as np
        import rasterio as rio
        from rasterio.warp import reproject, Resampling
    except ImportError:
        return None
    rural, urban = _pop_rasters(cs_path, folder)
    if not (rural and urban):
        return None
    try:
        with rio.open(ref_path) as ref:
            dst_transform = ref.transform
            dst_crs       = ref.crs
            dst_shape     = (ref.height, ref.width)
    except Exception:
        return None

    pop_sum = np.zeros(dst_shape, dtype='float64')
    for p in (rural, urban):
        dst = np.zeros(dst_shape, dtype='float64')
        try:
            with rio.open(p) as psrc:
                reproject(
                    source=rio.band(psrc, 1),
                    destination=dst,
                    src_transform=psrc.transform, src_crs=psrc.crs,
                    dst_transform=dst_transform, dst_crs=dst_crs,
                    resampling=Resampling.bilinear,
                )
                pnd = psrc.nodata
        except Exception:
            return None
        if pnd is not None:
            try:
                pndv = float(pnd)
                if not np.isnan(pndv):
                    dst[dst == pndv] = 0.0
            except (TypeError, ValueError):
                pass
        dst[~np.isfinite(dst)] = 0.0
        dst[dst < 0] = 0.0
        pop_sum += dst
    return pop_sum


def _qmra_base(cs_path, folder):
    """Fixed base directory for QMRA outputs for a scenario."""
    return os.path.join(cs_path, 'output', folder, 'qmra')


def _qmra_has_output(cs_path, folder):
    """True if the combined monthly run has produced annual_risk.tif."""
    return os.path.exists(
        os.path.join(_qmra_base(cs_path, folder), 'combined', 'monthly', 'annual_risk.tif')
    )


def _baseline_qmra_dir(cs_path):
    """Directory holding the shared QMRA config/inputs, imported under baseline."""
    return os.path.join(cs_path, 'input', 'baseline', 'qmra')


def _baseline_qmra_config_path(cs_path):
    """Path to the shared baseline QMRA config JSON (source of truth on import)."""
    return os.path.join(_baseline_qmra_dir(cs_path), 'qmra_config.json')


def _treatment_tif(cs_path, folder):
    """Locate the drinking-water treatment raster for a scenario, or None.

    Imported case studies place it under ``input/<folder>/qmra/treatment.tif``
    with a shared copy under ``input/baseline/qmra/treatment.tif``. Older
    layouts kept it directly under the scenario input dir. The first existing
    candidate wins, falling back to the shared baseline copy.
    """
    candidates = (
        os.path.join(cs_path, 'input', folder, 'qmra', 'treatment.tif'),
        os.path.join(cs_path, 'input', folder, 'treatment.tif'),
        os.path.join(cs_path, 'input', folder, 'human_emissions', 'treatment.tif'),
        os.path.join(cs_path, 'output', folder, 'treatment.tif'),
        os.path.join(_baseline_qmra_dir(cs_path), 'treatment.tif'),
    )
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def _qmra_available(cs_path):
    """True if the imported case study has a baseline QMRA folder and config JSON.

    This is the signal that QMRA can be configured/run for the case study and
    that the "QMRA" tab should appear above the scenarios bar.
    """
    return os.path.isfile(_baseline_qmra_config_path(cs_path))


def _load_baseline_qmra_config(cs_path):
    """Load the shared baseline QMRA config JSON, or None if absent/invalid."""
    path = _baseline_qmra_config_path(cs_path)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'[QMRA] Error loading baseline config {path}: {e}')
        return None


def _save_baseline_qmra_config(cs_path, config):
    """Persist the shared baseline QMRA config JSON."""
    qdir = _baseline_qmra_dir(cs_path)
    os.makedirs(qdir, exist_ok=True)
    with open(_baseline_qmra_config_path(cs_path), 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)


def _baseline_config_to_panel(cfg):
    """Convert an imported baseline QMRA config (exposure_groups list + routes)
    into the panel schema (pathways dict) expected by QmraCaseStudyPanel.

    Falls back to DEFAULT_QMRA_CONFIG values for anything missing. If the config
    already looks like the panel schema (has 'pathways'), it is returned as-is.
    """
    if not cfg:
        return dict(DEFAULT_QMRA_CONFIG)
    if cfg.get('pathways'):
        return cfg

    routes_enabled = set(cfg.get('routes') or ['drinking'])
    include_boiling = bool(cfg.get('include_boiling', False))

    pathways = {}
    for grp in (cfg.get('exposure_groups') or []):
        route = grp.get('route') or grp.get('name')
        if not route:
            continue
        vtype = grp.get('type', 'triangular')
        if vtype == 'poisson':
            volume = {'type': 'poisson', 'lambda': grp.get('lambda', 1.0)}
            if 'glass' in grp:
                volume['glass'] = grp['glass']
        else:
            volume = {
                'type': 'triangular',
                'min':  grp.get('min', 1.0),
                'mode': grp.get('mode', 10.0),
                'max':  grp.get('max', 50.0),
            }
        freq_raw = grp.get('frequency', 365)
        if isinstance(freq_raw, dict):
            dist = freq_raw.get('dist')
            if dist == 'nbinom':
                frequency = {'type': 'nbinom', 'size': freq_raw.get('size', 0.4),
                             'prob': freq_raw.get('prob', 0.11)}
            elif dist == 'poisson':
                frequency = {'type': 'poisson', 'lambda': freq_raw.get('lambda', 1.0)}
            else:
                frequency = {'type': 'fixed', 'value': 365}
        else:
            frequency = {'type': 'fixed', 'value': freq_raw}

        pc = {
            'enabled':   route in routes_enabled,
            'volume':    volume,
            'frequency': frequency,
        }
        if route == 'drinking':
            pc['boiling'] = include_boiling
            pc['use_treatment'] = bool(cfg.get('treatment_raster'))
        pathways[route] = pc

    # Ensure every default route is represented.
    for route, default_pc in DEFAULT_QMRA_CONFIG['pathways'].items():
        pathways.setdefault(route, dict(default_pc))

    return {
        'mci':       cfg.get('mci', DEFAULT_QMRA_CONFIG['mci']),
        'model':     cfg.get('model', DEFAULT_QMRA_CONFIG['model']),
        'quantiles': cfg.get('quantiles', DEFAULT_QMRA_CONFIG['quantiles']),
        'bp_params': cfg.get('bp_params', DEFAULT_QMRA_CONFIG['bp_params']),
        'pathways':  pathways,
    }


def _load_qmra_config(cs_path, folder):
    """Load QMRA config from the qmra_config JSON column in scenario_metadata.csv."""
    import csv as _csv
    meta = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if not os.path.exists(meta):
        return None
    try:
        with open(meta, 'r', newline='', encoding='utf-8') as f:
            for row in _csv.DictReader(f):
                if row.get('folder') == folder:
                    blob = row.get('qmra_config', '').strip()
                    if blob:
                        return json.loads(blob)
    except Exception as e:
        print(f'[QMRA] Error loading config from CSV: {e}')
    return None


def _save_qmra_config(cs_path, folder, config):
    """Save QMRA config as a JSON blob in the qmra_config column of scenario_metadata.csv."""
    import csv as _csv
    meta = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if not os.path.exists(meta):
        return
    try:
        with open(meta, 'r', newline='', encoding='utf-8') as f:
            rows = list(_csv.DictReader(f))
        for row in rows:
            if row.get('folder') == folder:
                row['qmra_config'] = json.dumps(config)
                break
        with open(meta, 'w', newline='', encoding='utf-8') as f:
            writer = _csv.DictWriter(f, fieldnames=state.SCENARIO_METADATA_FIELDS, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(rows)
    except Exception as e:
        print(f'[QMRA] Error saving config to CSV: {e}')


def _scenario_pathogen(scenario_id):
    """Try to resolve the scenario's pathogen from scenario_metadata.csv."""
    import csv
    try:
        for cs in state.case_studies:
            cs_path = cs.get('folder_path') or ''
            meta = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta):
                continue
            with open(meta, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row.get('scenario_id') == scenario_id:
                        return (row.get('pathogen') or '').strip().lower() or None
    except Exception:
        return None
    return None


# ──────────────────────────────────────────────────────────────────────────────
# R script generation
# ──────────────────────────────────────────────────────────────────────────────

def _r_literal(value):
    """Convert a Python value to an R literal expression."""
    if value is None:
        return 'NULL'
    if value is True:
        return 'TRUE'
    if value is False:
        return 'FALSE'
    if isinstance(value, (int, float)):
        # Allow both integers and floats; rely on R's numeric coercion.
        return repr(value)
    if isinstance(value, str):
        # Escape single-quoted R string.
        escaped = value.replace('\\', '\\\\').replace("'", "\\'")
        return f"'{escaped}'"
    if isinstance(value, list):
        return 'c(' + ', '.join(_r_literal(v) for v in value) + ')'
    if isinstance(value, dict):
        # If keys all look like field names, emit list(name = value, ...)
        parts = []
        for k, v in value.items():
            parts.append(f'`{k}` = {_r_literal(v)}')
        return 'list(' + ', '.join(parts) + ')'
    raise TypeError(f'Cannot convert to R literal: {type(value).__name__}')


def _exposure_groups_r(groups):
    """Render a list of exposure-group dicts as an R ``list(list(...), ...)``."""
    items = []
    for g in groups:
        fields = []
        for k, v in g.items():
            fields.append(f'{k} = {_r_literal(v)}')
        items.append('list(' + ', '.join(fields) + ')')
    return 'list(\n  ' + ',\n  '.join(items) + '\n)'


def _build_qmra_r_script(*,
                         pathogen,
                         conc_paths,
                         treatment_path,
                         pathway_configs,
                         model,
                         mci,
                         quantiles,
                         boiling_lrv,
                         random_seed,
                         output_directory,
                         conc_multiplier,
                         bp_params=None,
                         pop_rural_path=None,
                         pop_urban_path=None):
    """Generate R script that runs QMRA per-route (individual) and combined.

    Output structure:
      <output_directory>/combined/monthly/  — annual_risk.tif, expected_cases.tif, …
      <output_directory>/combined/daily/    — …
      <output_directory>/routes/<route>/monthly/
      <output_directory>/routes/<route>/daily/
    """
    enabled = {r: pc for r, pc in pathway_configs.items() if pc.get('enabled', False)}
    if not enabled:
        enabled = {'drinking': DEFAULT_QMRA_CONFIG['pathways']['drinking']}
    enabled_routes = list(enabled.keys())
    all_groups = [_pathway_to_exposure_group(r, pc) for r, pc in enabled.items()]

    drinking_pc = enabled.get('drinking', {})
    combined_boiling = bool(drinking_pc.get('boiling', False)) if 'drinking' in enabled else False
    use_treatment_combined = bool(drinking_pc.get('use_treatment', False)) if 'drinking' in enabled else False
    combined_treat_r = (f'terra::rast({_r_literal(treatment_path)})'
                        if (treatment_path and use_treatment_combined) else 'NULL')

    pop_rural_r  = _r_literal(pop_rural_path) if pop_rural_path else 'NULL'
    pop_urban_r  = _r_literal(pop_urban_path) if pop_urban_path else 'NULL'
    conc_mult_ln = (f'\nconc.list <- lapply(conc.list, function(r) r * {float(conc_multiplier)})'
                    if conc_multiplier != 1.0 else '')

    helper_fn = f"""\
qmra_run_helper <- function(eg, treat, routes, boiling, out_dir, otype, rname) {{
  GloWPaQMRA::qmra_ras_batch_fast(
    conc.list             = conc.list,
    pathogen              = {_r_literal(pathogen)},
    model                 = {_r_literal(model)},
    bp.params             = bp.params,
    quantiles             = quantiles,
    mci                   = {int(mci)},
    boiling.lrv           = {_r_literal(boiling_lrv)},
    include.immunological = FALSE,
    random.seed           = {int(random_seed)},
    exposure.groups       = eg,
    treatment.raster      = treat,
    routes                = routes,
    include.boiling       = boiling,
    output.directory      = out_dir,
    output.type           = otype,
    run.name              = rname
  )
}}"""

    route_blocks = []
    for route, pc in enabled.items():
        eg = [_pathway_to_exposure_group(route, pc)]
        eg_r = _exposure_groups_r(eg)
        boiling_route = bool(pc.get('boiling', False)) if route == 'drinking' else False
        use_tr_route  = bool(pc.get('use_treatment', False)) if route == 'drinking' else False
        treat_route_r = (f'terra::rast({_r_literal(treatment_path)})'
                         if (treatment_path and use_tr_route) else 'NULL')
        safe = re.sub(r'[^a-z0-9]', '_', route)
        route_dir = output_directory.rstrip('/') + f'/routes/{route}'
        route_blocks.append(f"""
# ── Route: {route}
{{
  eg_{safe} <- {eg_r}
  d_{safe}  <- {_r_literal(route_dir)}
  dir.create(d_{safe}, recursive = TRUE, showWarnings = FALSE)
  t_{safe}  <- {treat_route_r}
  cat('Running {route} (monthly)...\\n')
  qmra_run_helper(eg_{safe}, t_{safe}, {_r_literal([route])}, {_r_literal(boiling_route)}, d_{safe}, 'monthly', 'monthly')
  cat('Running {route} (daily)...\\n')
  qmra_run_helper(eg_{safe}, t_{safe}, {_r_literal([route])}, {_r_literal(boiling_route)}, d_{safe}, 'daily',   'daily')
  cat('{route} done.\\n')
}}""")

    combined_dir = output_directory.rstrip('/') + '/combined'
    all_groups_r = _exposure_groups_r(all_groups)
    routes_r     = _r_literal(enabled_routes)
    route_blocks_str = ''.join(route_blocks)

    return f"""# Auto-generated by waterpath-scenario-builder/webapp/backend/qmra.py
suppressPackageStartupMessages({{
  library(GloWPaQMRA)
  library(terra)
  library(dplyr)
  library(EnvStats)
  library(matrixStats)
  library(rockchalk)
}})

set.seed({int(random_seed)})

conc_paths <- {_r_literal(conc_paths)}
conc.list <- lapply(conc_paths, terra::rast){conc_mult_ln}

bp.params <- {_r_literal(bp_params or DEFAULT_BP_PARAMS)}
quantiles <- {_r_literal(quantiles)}

output_directory <- {_r_literal(output_directory)}
dir.create(output_directory, recursive = TRUE, showWarnings = FALSE)

{helper_fn}
{route_blocks_str}

# ── Combined run ({len(enabled_routes)} route(s))
{{
  combined_dir <- {_r_literal(combined_dir)}
  dir.create(combined_dir, recursive = TRUE, showWarnings = FALSE)
  all_groups <- {all_groups_r}
  cat('Running combined (monthly)...\\n')
  result_monthly <- qmra_run_helper(all_groups, {combined_treat_r}, {routes_r}, {_r_literal(combined_boiling)}, combined_dir, 'monthly', 'monthly')
  cat('Running combined (daily)...\\n')
  qmra_run_helper(all_groups, {combined_treat_r}, {routes_r}, {_r_literal(combined_boiling)}, combined_dir, 'daily', 'daily')
  cat('Combined done.\\n')

  # Expected cases (combined monthly annual_risk × population)
  pop_rural_path <- {pop_rural_r}
  pop_urban_path <- {pop_urban_r}
  if (!is.null(result_monthly) && !is.null(result_monthly$annual_risk) && !is.null(pop_rural_path)) {{
    tryCatch({{
      pop_rural <- terra::rast(pop_rural_path)
      pop_urban <- terra::rast(pop_urban_path)
      pop_total <- pop_rural + pop_urban
      band_names <- names(result_monthly$annual_risk)
      median_bands  <- grep('_q0\\\\.5$', band_names, value = TRUE)
      combined_bands <- grep('^combined_', median_bands, value = TRUE)
      chosen_band <- if (length(combined_bands) > 0) combined_bands[1] else if (length(median_bands) > 0) median_bands[1] else band_names[1]
      ar_median <- result_monthly$annual_risk[[chosen_band]]
      pop_resampled <- terra::resample(pop_total, ar_median, method = 'bilinear')
      expected_cases <- ar_median * pop_resampled
      names(expected_cases) <- 'expected_cases_per_year'
      terra::writeRaster(expected_cases,
                         filename = file.path(combined_dir, 'monthly', 'expected_cases.tif'),
                         overwrite = TRUE)
      cat('Expected cases saved.\\n')
    }}, error = function(e) {{
      cat('Warning: expected cases failed:', conditionMessage(e), '\\n')
    }})
  }}
}}

cat('QMRA run finished.\\n')
"""


# ──────────────────────────────────────────────────────────────────────────────
# Docker exec
# ──────────────────────────────────────────────────────────────────────────────

def _qmra_container_running():
    if state.docker_client is None:
        return False
    try:
        c = state.docker_client.containers.get(QMRA_CONTAINER)
        return c.status == 'running'
    except Exception:
        return False


def _execute_qmra_run(run_id, container_script_path, run_dir, script_host_path=None):
    """Background thread: run the generated R script inside qmra-container."""
    try:
        model_runs[run_id]['status'] = 'running'
        if state.docker_client is None:
            raise RuntimeError(f'Cannot connect to Docker socket at {DOCKER_SOCK}')
        container = state.docker_client.containers.get(QMRA_CONTAINER)
        result = container.exec_run(
            ['Rscript', container_script_path],
            stdout=True, stderr=True, demux=True,
        )
        stdout_b, stderr_b = result.output if result.output else (b'', b'')
        stdout = (stdout_b or b'').decode('utf-8', errors='replace')
        stderr = (stderr_b or b'').decode('utf-8', errors='replace')
        exit_code = result.exit_code

        # Persist combined log next to the script for easy retrieval.
        try:
            log_path = os.path.join(run_dir, 'qmra.log')
            with open(log_path, 'w', encoding='utf-8') as lf:
                lf.write(stdout)
                if stderr:
                    lf.write('\n--- STDERR ---\n')
                    lf.write(stderr)
        except OSError:
            pass

        files = []
        # Collect TIFs from combined/ and routes/*/ subdirs.
        for subdir in ('monthly', 'daily'):
            d = os.path.join(run_dir, 'combined', subdir)
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.lower().endswith('.tif'):
                        files.append(f'combined/{subdir}/{f}')
        routes_dir = os.path.join(run_dir, 'routes')
        if os.path.isdir(routes_dir):
            for route_name in sorted(os.listdir(routes_dir)):
                for subdir in ('monthly', 'daily'):
                    d = os.path.join(routes_dir, route_name, subdir)
                    if os.path.isdir(d):
                        for f in sorted(os.listdir(d)):
                            if f.lower().endswith('.tif'):
                                files.append(f'routes/{route_name}/{subdir}/{f}')

        model_runs[run_id]['stdout'] = stdout
        model_runs[run_id]['stderr'] = stderr
        model_runs[run_id]['return_code'] = exit_code
        model_runs[run_id]['output_files'] = files
        model_runs[run_id]['status'] = 'success' if (exit_code == 0 and files) else 'error'
    except Exception as exc:
        model_runs[run_id]['status'] = 'error'
        model_runs[run_id]['stderr'] = (
            f'{exc}\n{traceback.format_exc()}'
        )
    finally:
        # The generated script is a scratch artifact -- never leave it behind
        # in the persisted (visible) scenario output tree.
        if script_host_path:
            try:
                os.remove(script_host_path)
                parent = os.path.dirname(script_host_path)
                if os.path.isdir(parent) and not os.listdir(parent):
                    os.rmdir(parent)
            except OSError:
                pass


# ──────────────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────────────

def qmra_status():
    return jsonify({'available': _qmra_container_running(), 'container': QMRA_CONTAINER}), 200


def qmra_availability(scenario_id):
    """Tell the frontend whether QMRA can be run for this scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    cs_path = cs['folder_path']
    conc_files = _conc_tifs(cs_path, folder)
    pathogen = _scenario_pathogen(scenario_id)

    treatment_tif = _treatment_tif(cs_path, folder)

    pop_rural, pop_urban = _pop_rasters(cs_path, folder)

    return jsonify({
        'available':              bool(conc_files),
        'container_running':      _qmra_container_running(),
        'pathogen':               pathogen,
        'pathogen_supported':     pathogen in ('cryptosporidium', 'rotavirus'),
        'concentration_files':    conc_files,
        'concentration_count':    len(conc_files),
        'treatment_available':    bool(treatment_tif),
        'population_available':   bool(pop_rural and pop_urban),
        'has_qmra_output':        _qmra_has_output(cs_path, folder),
        'default_exposure_groups': DEFAULT_EXPOSURE_GROUPS,
        'available_routes':       [g['route'] for g in DEFAULT_EXPOSURE_GROUPS],
    }), 200


def qmra_get_config(scenario_id):
    """Return the saved QMRA config for a scenario, or sensible defaults."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    cs_path = cs['folder_path']
    saved = _load_qmra_config(cs_path, folder)
    pathogen = _scenario_pathogen(scenario_id) or 'cryptosporidium'

    if saved:
        return jsonify(saved), 200

    # Return defaults with treatment-availability flag.
    cfg = dict(DEFAULT_QMRA_CONFIG)
    cfg['treatment_available'] = bool(_treatment_tif(cs_path, folder))
    return jsonify(cfg), 200


def qmra_put_config(scenario_id):
    """Save QMRA config for a scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    body = request.get_json(silent=True) or {}
    if not body:
        return jsonify({'error': 'No config provided'}), 400

    try:
        _save_qmra_config(cs['folder_path'], folder, body)
    except OSError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'status': 'saved'}), 200


def _trigger_qmra_run(scenario_id, cs, folder):
    """Internal helper: build and launch a QMRA background run.
    Returns run_id or None on error.
    """
    cs_path = cs['folder_path']
    conc_files = _conc_tifs(cs_path, folder)
    if not conc_files:
        return None

    pathogen = _scenario_pathogen(scenario_id) or 'cryptosporidium'
    if pathogen not in ('cryptosporidium', 'rotavirus'):
        return None

    # Load saved config or use defaults.
    cfg = _load_qmra_config(cs_path, folder) or {}
    pathway_configs = cfg.get('pathways') or DEFAULT_QMRA_CONFIG['pathways']
    model           = cfg.get('model', 'bp')
    mci             = int(cfg.get('mci', 1000))
    quantiles       = cfg.get('quantiles') or DEFAULT_QMRA_CONFIG['quantiles']
    bp_params       = cfg.get('bp_params') or DEFAULT_BP_PARAMS

    def _to_cont(host_path):
        if not host_path:
            return None
        return '/app/data/' + os.path.relpath(host_path, _data_root()).replace(os.sep, '/')

    # Treatment raster — only used when drinking pathway has use_treatment=True
    drinking_pc = pathway_configs.get('drinking', {})
    treatment_path_container = None
    if bool(drinking_pc.get('use_treatment', False)):
        treatment_host = _treatment_tif(cs_path, folder)
        if treatment_host:
            treatment_path_container = _to_cont(treatment_host)

    conc_dir_host  = _conc_dir(cs_path, folder)
    conc_dir_cont  = '/app/data/' + os.path.relpath(conc_dir_host, _data_root()).replace(os.sep, '/')
    conc_paths_cont = [f'{conc_dir_cont}/{f}' for f in conc_files]

    # Fixed output dir — overwritten each run.
    qmra_dir_host = _qmra_base(cs_path, folder)
    os.makedirs(qmra_dir_host, exist_ok=True)
    qmra_dir_cont = '/app/data/' + os.path.relpath(qmra_dir_host, _data_root()).replace(os.sep, '/')

    pop_rural_host, pop_urban_host = _pop_rasters(cs_path, folder)
    pop_rural_cont = _to_cont(pop_rural_host)
    pop_urban_cont = _to_cont(pop_urban_host)

    script = _build_qmra_r_script(
        pathogen=pathogen,
        conc_paths=conc_paths_cont,
        treatment_path=treatment_path_container,
        pathway_configs=pathway_configs,
        model=model,
        mci=mci,
        quantiles=quantiles,
        bp_params=bp_params,
        boiling_lrv={'min': 6, 'max': 9},
        random_seed=100,
        output_directory=qmra_dir_cont,
        conc_multiplier=1.0,
        pop_rural_path=pop_rural_cont,
        pop_urban_path=pop_urban_cont,
    )

    # Scratch location for the generated script -- deleted once the run
    # finishes (see _execute_qmra_run's `finally` block) so it never lingers
    # in the persisted output tree alongside the actual results.
    run_tmp_dir = os.path.join(qmra_dir_host, '.tmp_run')
    os.makedirs(run_tmp_dir, exist_ok=True)
    script_host = os.path.join(run_tmp_dir, 'qmra_run.R')
    with open(script_host, 'w', encoding='utf-8') as f:
        f.write(script)
    script_cont = '/app/data/' + os.path.relpath(script_host, _data_root()).replace(os.sep, '/')

    run_id = str(uuid.uuid4())
    model_runs[run_id] = {
        'status': 'queued',
        'kind': 'qmra',
        'scenario_id': scenario_id,
        'cs_path': cs_path,
        'folder': folder,
        'run_dir': qmra_dir_host,
        'started_at': datetime.now().isoformat(),
    }
    threading.Thread(
        target=_execute_qmra_run,
        args=(run_id, script_cont, qmra_dir_host),
        kwargs={'script_host_path': script_host},
        daemon=True,
    ).start()
    return run_id


def qmra_run(scenario_id):
    """Launch a QMRA run for a scenario. Overwrites previous outputs."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    if not _qmra_container_running():
        return jsonify({'error': 'qmra-container is not running'}), 503

    cs_path = cs['folder_path']
    if not _conc_tifs(cs_path, folder):
        return jsonify({'error': 'No concentration outputs found; run GloWPa first.'}), 400

    # If a config body is provided, save it first so _trigger_qmra_run picks it up.
    body = request.get_json(silent=True) or {}
    if body:
        # Merge with existing config so partial updates work.
        existing = _load_qmra_config(cs_path, folder) or {}
        existing.update(body)
        try:
            _save_qmra_config(cs_path, folder, existing)
        except OSError:
            pass

    run_id = _trigger_qmra_run(scenario_id, cs, folder)
    if run_id is None:
        return jsonify({'error': 'Could not start QMRA run (check pathogen and concentration files).'}), 400

    return jsonify({'run_id': run_id, 'status': 'queued'}), 202


def qmra_run_status(run_id):
    info = model_runs.get(run_id)
    if not info or info.get('kind') != 'qmra':
        return jsonify({'error': 'Run not found'}), 404
    return jsonify({
        'run_id':       run_id,
        'status':       info.get('status'),
        'return_code':  info.get('return_code'),
        'output_files': info.get('output_files', []),
        'stdout':       info.get('stdout', ''),
        'stderr':       info.get('stderr', ''),
        'started_at':   info.get('started_at'),
    }), 200


def qmra_output_files(scenario_id):
    """List available output TIFs grouped by combined/{monthly,daily} and routes/<route>/{monthly,daily}."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    base = _qmra_base(cs['folder_path'], folder)

    # Combined
    combined = {}
    for subdir in ('monthly', 'daily'):
        d = os.path.join(base, 'combined', subdir)
        combined[subdir] = sorted(
            f for f in os.listdir(d) if f.lower().endswith('.tif')
        ) if os.path.isdir(d) else []

    # Per-route
    routes_result = {}
    routes_dir = os.path.join(base, 'routes')
    if os.path.isdir(routes_dir):
        for route_name in sorted(os.listdir(routes_dir)):
            route_data = {}
            for subdir in ('monthly', 'daily'):
                d = os.path.join(routes_dir, route_name, subdir)
                route_data[subdir] = sorted(
                    f for f in os.listdir(d) if f.lower().endswith('.tif')
                ) if os.path.isdir(d) else []
            routes_result[route_name] = route_data

    return jsonify({'combined': combined, 'routes': routes_result}), 200


def _parse_band(desc):
    """Return (route, q_float) from e.g. 'drinking_untreated_monthly_q0.5'."""
    if not desc:
        return None, None
    for sep in ('_monthly_q', '_daily_q'):
        if sep in desc:
            route_with_treatment, q_str = desc.split(sep, 1)
            route = route_with_treatment.rsplit('_', 1)[0]
            try:
                return route, float(q_str)
            except ValueError:
                return None, None
    return None, None


def _select_band_index(descs, route, target_q):
    """Return the 1-based band index for `route` at quantile `target_q`, or None.

    A single route/quantile pair can have several scenario variants baked into
    the same multi-band TIF (e.g. 'untreated' vs 'treated', with/without
    boiling) when the pathway config enables treatment/boiling. The *last*
    matching band reflects the fully-configured option (R lists the plain
    scenario first and the treated/boiled variants after), so we keep the
    last match -- this mirrors the pre-existing "prefer treated" behaviour.
    """
    idx = None
    for i, d in enumerate(descs):
        r, q = _parse_band(d)
        if r != route or q is None or abs(q - target_q) > 0.001:
            continue
        idx = i + 1
    return idx


def _band_stats(arr, nodata):
    import numpy as np
    d = arr.astype(float)
    if nodata is not None:
        try:
            nd_val = float(nodata)
            if not np.isnan(nd_val):
                d[d == nd_val] = np.nan
        except (TypeError, ValueError):
            pass
    valid = d[np.isfinite(d)]
    if len(valid) == 0:
        return None
    positive = valid[valid > 0]
    return {
        'mean':          float(np.mean(valid)),
        'mean_pos':      float(np.mean(positive)) if len(positive) else None,
        'count':         int(len(valid)),
        'nonzero_count': int(len(positive)),
    }


def compute_qmra_summary(cs, folder, output_type='monthly',
                         file_name='annual_risk.tif', target_q=0.5,
                         include_monthly=True):
    """Compute the per-route QMRA risk statistics for one scenario.

    Pure function (no Flask request access) so it can be reused outside the
    HTTP layer -- see `compute_qmra_report_metrics` and the report builder.
    Returns the dict served by `qmra_stats`; raises ImportError when numpy /
    rasterio are unavailable.

    Set `include_monthly=False` to skip the twelve per-month rasters when only
    the annual figures are needed.
    """
    import numpy as np
    import rasterio as rio

    base = _qmra_base(cs['folder_path'], folder)

    # ── Per-route, per-quantile stats from the selected TIF ──────────────────
    combined_risk = {}
    routes_risk   = {}
    band_index    = {}   # route -> 1-based band index of its `quantile` layer
    ar_path = os.path.join(base, 'combined', output_type, file_name)
    if os.path.exists(ar_path):
        with rio.open(ar_path) as src:
            descs = src.descriptions or []
            nd    = src.nodata
            for i, desc in enumerate(descs):
                route, q = _parse_band(desc)
                if route is None:
                    continue
                st    = _band_stats(src.read(i + 1), nd)
                q_key = f'q{q:.3f}'
                if abs(q - target_q) <= 0.001:
                    band_index[route] = i + 1
                if route == 'combined':
                    combined_risk[q_key] = st
                else:
                    routes_risk.setdefault(route, {})[q_key] = st

    # ── Population-weighted ("average person's") risk, per route + combined ────
    # Weight each cell's `quantile` risk by its population, so the headline
    # reflects the risk of a typical person rather than a typical map cell.
    pop_weighted = {}
    pop_total    = None
    combined_band_at_q = None  # captured below for the expected-infections calc
    pop_grid     = _pop_grid_for(cs['folder_path'], folder, ar_path) if os.path.exists(ar_path) else None
    if pop_grid is not None:
        with rio.open(ar_path) as src:
            descs = src.descriptions or []
            nd    = src.nodata
            for i, desc in enumerate(descs):
                route, q = _parse_band(desc)
                if route is None or abs(q - target_q) > 0.001:
                    continue
                band = src.read(i + 1).astype('float64')
                if nd is not None:
                    try:
                        ndv = float(nd)
                        if not np.isnan(ndv):
                            band[band == ndv] = np.nan
                    except (TypeError, ValueError):
                        pass
                band[(band < 0) | (band > 1.0)] = np.nan
                if band.shape != pop_grid.shape:
                    continue
                mask = np.isfinite(band)
                w    = pop_grid[mask]
                rv   = band[mask]
                tp   = float(np.sum(w))
                if tp > 0:
                    pop_weighted[route] = float(np.sum(rv * w) / tp)
                    pop_total = tp
                if route == 'combined':
                    combined_band_at_q = band

    # ── Expected infections: combined risk *at the selected quantile* × ────────
    # population, summed over all valid cells. Recomputed dynamically here
    # (rather than reading the fixed, always-q0.5 expected_cases.tif) so the
    # headline figure tracks the selected quantile, matching the per-area
    # breakdown returned by qmra_area_stats.
    combined_cases = None
    if file_name == 'annual_risk.tif' and output_type == 'monthly' and combined_band_at_q is not None:
        product = combined_band_at_q * pop_grid
        valid = product[np.isfinite(product) & (product > 0)]
        if len(valid) > 0:
            combined_cases = {
                'sum':   float(np.sum(valid)),
                'mean':  float(np.mean(valid)),
                'count': int(len(valid)),
            }

    # ── Monthly variation at `quantile` (only for annual_risk.tif) ─────────────
    # Each per-month TIF can hold several scenario variants of the *same*
    # route/quantile band (e.g. 'untreated' then 'treated', if treatment is
    # configured) -- exactly like the annual file above. We therefore build a
    # fixed-length (12) array per route and let the *last* matching band win
    # for each month, instead of appending every match (which used to produce
    # arrays with more entries than months, silently shifting every later
    # month's value -- this was the source of the "month trends don't agree
    # with annual" bug).
    monthly_by_route      = {}
    monthly_pop_weighted  = {}
    conc_dir = os.path.join(base, 'combined', 'monthly')
    if include_monthly and file_name == 'annual_risk.tif' and os.path.isdir(conc_dir):
        all_files = os.listdir(conc_dir)
        month_files = [
            next((os.path.join(conc_dir, f) for f in all_files
                  if f.lower().endswith(f'_{month}.tif')), None)
            for month in MONTHS
        ]
        for m_idx, month_file in enumerate(month_files):
            if not month_file:
                continue
            try:
                with rio.open(month_file) as src:
                    descs = src.descriptions or []
                    nd    = src.nodata
                    month_vals     = {}   # route -> last-matching q0.5 mean this month
                    month_pop_vals = {}   # route -> last-matching q0.5 pop-weighted this month
                    for i, desc in enumerate(descs):
                        route, q = _parse_band(desc)
                        if route is None or abs(q - target_q) > 0.001:
                            continue
                        st = _band_stats(src.read(i + 1), nd)
                        month_vals[route] = st['mean'] if st else None
                        if pop_grid is not None:
                            band = src.read(i + 1).astype('float64')
                            if nd is not None:
                                try:
                                    ndv = float(nd)
                                    if not np.isnan(ndv):
                                        band[band == ndv] = np.nan
                                except (TypeError, ValueError):
                                    pass
                            band[(band < 0) | (band > 1.0)] = np.nan
                            if band.shape == pop_grid.shape:
                                mask = np.isfinite(band)
                                w    = pop_grid[mask]
                                tp   = float(np.sum(w))
                                if tp > 0:
                                    month_pop_vals[route] = float(np.sum(band[mask] * w) / tp)
                    for route, val in month_vals.items():
                        monthly_by_route.setdefault(route, [None] * len(MONTHS))[m_idx] = val
                    for route, val in month_pop_vals.items():
                        monthly_pop_weighted.setdefault(route, [None] * len(MONTHS))[m_idx] = val
            except Exception:
                pass

    return {
        'combined': {'risk': combined_risk, 'cases': combined_cases},
        'routes':   {r: {'risk': v} for r, v in routes_risk.items()},
        'monthly':  monthly_by_route,
        'monthly_pop_weighted': monthly_pop_weighted,
        'population_weighted': {
            'risk':       pop_weighted,
            'population': pop_total,
        },
        'bands': band_index,
    }


def compute_qmra_report_metrics(cs, folder, quantile=0.5, top_areas=5):
    """Flatten a scenario's QMRA output into report-ready metrics.

    Returns None when the scenario has no QMRA output (or the raster stack
    cannot be read).  All risk figures are annual, population-weighted
    probabilities of infection; `risk_expected_cases` is the expected number
    of annual infections (risk x population, summed per cell).
    """
    if not _qmra_has_output(cs['folder_path'], folder):
        return None

    try:
        summary = compute_qmra_summary(cs, folder, 'monthly', 'annual_risk.tif', quantile)
    except Exception:
        return None

    pop_risk = (summary.get('population_weighted') or {}).get('risk') or {}
    combined = pop_risk.get('combined')
    if combined is None:
        return None

    metrics = {
        'risk_annual_combined': combined,
        'risk_population': (summary.get('population_weighted') or {}).get('population'),
        'risk_quantile': quantile,
    }

    # Uncertainty band. The headline figure is population-weighted, so the
    # bounds must be too -- comparing it against unweighted per-cell means
    # would put the headline outside its own confidence interval. That means
    # re-reading the raster stack at each bound quantile.
    for label, bound_q in (('low', 0.025), ('high', 0.975)):
        value = None
        if abs(bound_q - quantile) <= 0.001:
            value = combined
        else:
            try:
                bound = compute_qmra_summary(cs, folder, 'monthly', 'annual_risk.tif', bound_q,
                                             include_monthly=False)
                value = ((bound.get('population_weighted') or {}).get('risk') or {}).get('combined')
            except Exception:
                value = None
        metrics[f'risk_annual_combined_{label}'] = value

    # Per-pathway population-weighted risk + the dominant pathway.
    routes = {r: v for r, v in pop_risk.items() if r != 'combined' and v is not None}
    for route, value in routes.items():
        metrics[f'risk_annual_{route}'] = value
    metrics['risk_routes'] = routes
    metrics['risk_dominant_route'] = max(routes, key=routes.get) if routes else None

    cases = (summary.get('combined') or {}).get('cases') or {}
    metrics['risk_expected_cases'] = cases.get('sum')

    # Seasonality from the population-weighted monthly series.
    monthly = (summary.get('monthly_pop_weighted') or {}).get('combined') or []
    valid_months = [(i, v) for i, v in enumerate(monthly) if v is not None]
    if valid_months:
        peak_i, peak_v = max(valid_months, key=lambda t: t[1])
        trough_i, trough_v = min(valid_months, key=lambda t: t[1])
        metrics['risk_monthly'] = monthly
        metrics['risk_peak_month'] = MONTH_NAMES[peak_i]
        metrics['risk_peak_value'] = peak_v
        metrics['risk_trough_month'] = MONTH_NAMES[trough_i]
        metrics['risk_trough_value'] = trough_v
    else:
        metrics['risk_monthly'] = []
        metrics['risk_peak_month'] = None
        metrics['risk_peak_value'] = None
        metrics['risk_trough_month'] = None
        metrics['risk_trough_value'] = None

    # Most affected areas.
    try:
        areas = compute_qmra_area_stats(cs, folder, 'monthly', 'annual_risk.tif',
                                        quantile, with_labels=True)
    except Exception:
        areas = {}
    ranked = sorted(
        ({'iso': iso, 'name': v.get('name') or f'Area {iso}',
          'risk': v.get('risk'), 'cases': v.get('cases')}
         for iso, v in areas.items() if v.get('risk') is not None),
        key=lambda a: a['risk'], reverse=True,
    )
    metrics['risk_top_areas'] = ranked[:top_areas]
    metrics['risk_area_count'] = len(ranked)

    return metrics


def qmra_stats(scenario_id):
    """Return per-route risk stats for a given combined output TIF.
    Query params:
      output_type  'monthly' (default) or 'daily'
      file         filename in combined/<output_type>/ (default: annual_risk.tif)
      quantile     which quantile ('0.025', '0.5', '0.975', ...) is used for the
                   population-weighted figures and the map band index (default '0.5')

    Response shape:
        {
          combined: { risk: {'q0.025': {mean, count, nonzero_count}, ...}, cases: {...} },
          routes:   { drinking: { risk: {...} }, ... },
          monthly:  { combined: [jan_mean, ..., dec_mean], ... }
                     (unweighted per-cell mean, one value per calendar month;
                     only populated when file == 'annual_risk.tif')
          monthly_pop_weighted: { combined: [jan, ..., dec], ... }
                     (population-weighted equivalent of `monthly`, same
                     availability condition)
          bands: { route: band_index }  -- band index of `route` at `quantile`
        }
    `combined.cases` (expected annual infections = combined risk at `quantile`
    × population, summed per-cell) is recomputed live from annual_risk.tif at
    the requested quantile -- it is NOT read from the fixed, always-q0.5
    expected_cases.tif -- so it updates whenever `quantile` changes, and is
    only populated when file == 'annual_risk.tif' and output_type == 'monthly'.
    """
    output_type = request.args.get('output_type', 'monthly')
    file_name   = request.args.get('file', 'annual_risk.tif')
    if output_type not in ('monthly', 'daily'):
        return jsonify({'error': 'Invalid output_type'}), 400
    if '..' in file_name or '/' in file_name or '\\' in file_name:
        return jsonify({'error': 'Invalid file parameter'}), 400
    try:
        target_q = float(request.args.get('quantile', '0.5'))
    except ValueError:
        return jsonify({'error': 'Invalid quantile'}), 400

    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    try:
        payload = compute_qmra_summary(cs, folder, output_type, file_name, target_q)
    except ImportError as exc:
        return jsonify({'error': f'Missing dependency: {exc}'}), 500

    return jsonify(payload), 200


def qmra_raster(scenario_id, route_key, output_type, filename):
    """Serve a QMRA output raster.

    route_key: 'combined' or a route name (e.g. 'drinking')
    output_type: 'monthly' or 'daily'
    filename: basename of the .tif file
    """
    if output_type not in ('monthly', 'daily'):
        return jsonify({'error': 'Invalid output_type (must be monthly or daily)'}), 400
    if '/' in filename or '\\' in filename or '..' in filename:
        return jsonify({'error': 'Invalid filename'}), 400
    if '..' in route_key or '/' in route_key or '\\' in route_key:
        return jsonify({'error': 'Invalid route_key'}), 400
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    base = _qmra_base(cs['folder_path'], folder)
    if route_key == 'combined':
        tif_path = os.path.join(base, 'combined', output_type, filename)
    else:
        tif_path = os.path.join(base, 'routes', route_key, output_type, filename)

    if not os.path.exists(tif_path):
        return jsonify({'error': 'File not found'}), 404
    resp = send_file(tif_path, mimetype='image/tiff', as_attachment=False,
                     download_name=filename)
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


def qmra_log(scenario_id):
    """Return the QMRA execution log for a scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    log_path = os.path.join(_qmra_base(cs['folder_path'], folder), 'qmra.log')
    if not os.path.exists(log_path):
        return jsonify({'log': ''}), 200
    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            return jsonify({'log': f.read()}), 200
    except OSError as exc:
        return jsonify({'error': str(exc)}), 500


def qmra_rerun_all(case_study_id):
    """Re-run QMRA for every scenario in a case study that has concentration outputs."""
    import csv as _csv

    if not _qmra_container_running():
        return jsonify({'error': 'qmra-container is not running'}), 503

    cs = next((c for c in state.case_studies if c['id'] == case_study_id), None)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404

    meta_path = os.path.join(cs['folder_path'], 'config', 'scenario_metadata.csv')
    if not os.path.exists(meta_path):
        return jsonify({'error': 'No scenario metadata found'}), 404

    started = []
    with open(meta_path, 'r', newline='', encoding='utf-8') as f:
        for row in _csv.DictReader(f):
            scenario_id = row.get('scenario_id')
            folder = row.get('folder', 'baseline')
            if not scenario_id:
                continue
            if not _conc_tifs(cs['folder_path'], folder):
                continue
            run_id = _trigger_qmra_run(scenario_id, cs, folder)
            if run_id:
                started.append({'scenario_id': scenario_id, 'run_id': run_id})

    return jsonify({'started': len(started), 'runs': started}), 202


def _data_root():
    return getattr(state, 'DATA_DIR', '/app/data')


def qmra_cs_get_config(case_study_id):
    """Return QMRA config shared across all scenarios in a case study.

    Source of truth is the imported baseline config JSON
    (input/baseline/qmra/qmra_config.json), converted to the panel schema.
    Falls back to the qmra_config blob in scenario_metadata.csv, then defaults.
    """
    import csv as _csv
    cs = next((c for c in state.case_studies if c['id'] == case_study_id), None)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    cs_path = cs['folder_path']

    # 1) Prefer the imported baseline config JSON.
    baseline_cfg = _load_baseline_qmra_config(cs_path)
    if baseline_cfg:
        panel_cfg = _baseline_config_to_panel(baseline_cfg)
        panel_cfg['qmra_available'] = True
        return jsonify(panel_cfg), 200

    # 2) Fall back to a saved blob in scenario_metadata.csv.
    meta = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if os.path.exists(meta):
        try:
            with open(meta, 'r', newline='', encoding='utf-8') as f:
                for row in _csv.DictReader(f):
                    blob = row.get('qmra_config', '').strip()
                    if blob:
                        cfg = json.loads(blob)
                        cfg['qmra_available'] = _qmra_available(cs_path)
                        return jsonify(cfg), 200
        except Exception as e:
            print(f'[QMRA] Error reading CS config: {e}')

    default_cfg = dict(DEFAULT_QMRA_CONFIG)
    default_cfg['qmra_available'] = _qmra_available(cs_path)
    return jsonify(default_cfg), 200


def qmra_cs_put_config(case_study_id):
    """Save QMRA config for a case study.

    Writes to the baseline config JSON (source of truth) and mirrors the blob to
    every scenario row in scenario_metadata.csv for backward compatibility.
    """
    import csv as _csv
    cs = next((c for c in state.case_studies if c['id'] == case_study_id), None)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    cs_path = cs['folder_path']
    body = request.get_json(force=True, silent=True) or {}
    body.pop('qmra_available', None)

    # 1) Persist to the baseline config JSON (source of truth).
    try:
        if os.path.isdir(_baseline_qmra_dir(cs_path)):
            _save_baseline_qmra_config(cs_path, body)
    except Exception as e:
        print(f'[QMRA] Error saving baseline config: {e}')

    # 2) Mirror to scenario_metadata.csv for backward compatibility.
    meta = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
    if os.path.exists(meta):
        try:
            with open(meta, 'r', newline='', encoding='utf-8') as f:
                rows = list(_csv.DictReader(f))
            blob = json.dumps(body)
            for row in rows:
                row['qmra_config'] = blob
            with open(meta, 'w', newline='', encoding='utf-8') as f:
                writer = _csv.DictWriter(f, fieldnames=state.SCENARIO_METADATA_FIELDS, extrasaction='ignore')
                writer.writeheader()
                writer.writerows(rows)
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True}), 200


def qmra_cs_treatment_tif(case_study_id):
    """Serve the shared baseline QMRA treatment raster for client-side map preview."""
    cs = next((c for c in state.case_studies if c['id'] == case_study_id), None)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    tif_path = _treatment_tif(cs['folder_path'], 'baseline')
    if not tif_path:
        return jsonify({'error': 'Treatment raster not found'}), 404
    return send_file(tif_path, mimetype='image/tiff', as_attachment=False,
                     download_name='treatment.tif')


# Treatment code definitions derived from generate_qmra_lut() in GloWPaQMRA.
# Codes 5–8 map to the treatment.regimes in the R package; code 0 is used for
# cells with no treatment (untreated/surface water).  Any other value found in
# the raster is shown as "Unknown (code N)".
TREATMENT_CODE_LABELS = {
    0: {'label': 'No treatment',        'steps': []},
    1: {'label': 'No treatment',        'steps': []},
    2: {'label': 'No treatment',        'steps': []},
    3: {'label': 'No treatment',        'steps': []},
    4: {'label': 'No treatment',        'steps': []},
    5: {
        'label': 'Basic treatment',
        'steps': ['Chlorination', 'Coagulation/flocculation', 'Rapid sand filtration'],
    },
    6: {
        'label': 'Conventional treatment',
        'steps': ['Chlorination', 'Coagulation/flocculation', 'GAC', 'Chlorination'],
    },
    7: {
        'label': 'Advanced treatment',
        'steps': ['Coagulation/flocculation', 'Ozonation', 'Rapid sand filtration', 'GAC', 'Chlorination'],
    },
    8: {
        'label': 'Advanced treatment (MF)',
        'steps': ['Microfiltration', 'Coagulation/flocculation', 'RSF', 'UV', 'GAC', 'Microfiltration', 'Chlorination'],
    },
}

TREATMENT_CODE_COLORS = {
    0: '#d1d5db',   # gray-300  – no treatment
    1: '#d1d5db',
    2: '#d1d5db',
    3: '#d1d5db',
    4: '#d1d5db',
    5: '#bfdbfe',   # blue-200  – basic
    6: '#60a5fa',   # blue-400  – conventional
    7: '#2563eb',   # blue-600  – advanced
    8: '#1e3a8a',   # blue-900  – advanced MF
}


def qmra_cs_treatment_codes(case_study_id):
    """Return the treatment code legend: labels, step lists, colours, and unique
    code values present in the baseline treatment raster."""
    cs = next((c for c in state.case_studies if c['id'] == case_study_id), None)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404

    tif_path = _treatment_tif(cs['folder_path'], 'baseline')
    present_codes = []
    if tif_path:
        try:
            import rasterio
            with rasterio.open(tif_path) as src:
                data = src.read(1)
                nodata = src.nodata
                vals = set(data.flatten().tolist())
                vals.discard(nodata)
                vals.discard(float('nan'))
                present_codes = sorted([int(v) for v in vals if not (isinstance(v, float) and (v != v))])
        except Exception:
            pass  # rasterio may not be installed; skip raster inspection

    legend = []
    for code in sorted(TREATMENT_CODE_LABELS):
        info = TREATMENT_CODE_LABELS[code]
        legend.append({
            'code':    code,
            'label':   info['label'],
            'steps':   info['steps'],
            'color':   TREATMENT_CODE_COLORS.get(code, '#94a3b8'),
            'present': code in present_codes,
        })

    return jsonify({
        'legend':        legend,
        'present_codes': present_codes,
        'has_tif':       bool(tif_path),
    }), 200


# ──────────────────────────────────────────────────────────────────────────────
# Route registration
# ──────────────────────────────────────────────────────────────────────────────

def qmra_diff_tif():
    """Return a float32 GeoTIFF of (B − A) / A × 100 % for two QMRA combined output files.

    Query params: scA, scB, output_type (monthly|daily), file (e.g. annual_risk.tif),
    quantile (which quantile band to diff, default '0.5').
    Returns nodata=-9999 float32 GeoTIFF in WGS-84.  Band 1 holds the first (or only)
    matching band; for multi-band TIFs (annual_risk.tif) we use the combined band at
    `quantile` (last-matching scenario variant, e.g. 'treated' if configured).
    """
    import io
    import numpy as np

    sc_a        = request.args.get('scA')
    sc_b        = request.args.get('scB')
    output_type = request.args.get('output_type', 'monthly')
    file_name   = request.args.get('file', 'annual_risk.tif')

    if not sc_a or not sc_b:
        return jsonify({'error': 'scA and scB are required'}), 400
    if output_type not in ('monthly', 'daily'):
        return jsonify({'error': 'Invalid output_type'}), 400
    if '..' in file_name or '/' in file_name or '\\' in file_name:
        return jsonify({'error': 'Invalid file parameter'}), 400
    try:
        target_q = float(request.args.get('quantile', '0.5'))
    except ValueError:
        return jsonify({'error': 'Invalid quantile'}), 400

    try:
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.warp import reproject, Resampling
        from rasterio.crs import CRS

        wgs84  = CRS.from_epsg(4326)
        out_nd = np.float32(-9999)

        def _load_q50_band(sc_id):
            cs, folder = _locate_scenario(sc_id)
            tif_path = os.path.join(_qmra_base(cs['folder_path'], folder),
                                    'combined', output_type, file_name)
            if not os.path.exists(tif_path):
                raise ValueError(f'File not found for scenario {sc_id}: {file_name}')
            with rasterio.open(tif_path) as src:
                descs  = src.descriptions or []
                nd     = src.nodata
                src_tf = src.transform
                src_crs = src.crs or wgs84
                band_idx = _select_band_index(descs, 'combined', target_q) or 1
                data = src.read(band_idx).astype(np.float32)
                bounds = src.bounds
            if nd is not None:
                try:
                    data[data == np.float32(nd)] = np.nan
                except Exception:
                    pass
            data[(data < 0) | (data > 1.0)] = np.nan
            # Reproject to WGS-84 if needed
            if src_crs and src_crs.to_epsg() != 4326:
                from rasterio.warp import calculate_default_transform
                tmp_tf, tmp_w, tmp_h = calculate_default_transform(
                    src_crs, wgs84, data.shape[1], data.shape[0],
                    left=bounds.left, bottom=bounds.bottom, right=bounds.right, top=bounds.top)
                tmp = np.full((tmp_h, tmp_w), np.nan, dtype=np.float32)
                reproject(source=data, destination=tmp,
                          src_transform=src_tf, src_crs=src_crs,
                          dst_transform=tmp_tf, dst_crs=wgs84,
                          resampling=Resampling.nearest,
                          src_nodata=np.nan, dst_nodata=np.nan)
                data, src_tf = tmp, tmp_tf
            return data, src_tf

        data_a, tf_a = _load_q50_band(sc_a)
        data_b, tf_b = _load_q50_band(sc_b)

        # Align B onto A's grid
        if data_b.shape != data_a.shape:
            tmp = np.full(data_a.shape, np.nan, dtype=np.float32)
            reproject(source=data_b, destination=tmp,
                      src_transform=tf_b, src_crs=wgs84,
                      dst_transform=tf_a, dst_crs=wgs84,
                      resampling=Resampling.nearest,
                      src_nodata=np.nan, dst_nodata=np.nan)
            data_b = tmp

        with np.errstate(divide='ignore', invalid='ignore'):
            diff = np.where(
                np.isfinite(data_a) & (data_a > 0) & np.isfinite(data_b),
                (data_b - data_a) / data_a * 100.0,
                np.nan).astype(np.float32)

        diff_out = np.where(np.isnan(diff), out_nd, diff)
        h, w = data_a.shape
        profile = {
            'driver': 'GTiff', 'dtype': 'float32', 'nodata': float(out_nd),
            'width': w, 'height': h, 'count': 1,
            'crs': wgs84, 'transform': tf_a, 'compress': 'lzw',
        }
        with MemoryFile() as memfile:
            with memfile.open(**profile) as dst:
                dst.write(diff_out, 1)
            memfile.seek(0)
            data_bytes = memfile.read()

        resp = send_file(io.BytesIO(data_bytes), mimetype='image/tiff',
                         as_attachment=False, download_name='risk_diff.tif')
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def compute_qmra_area_stats(cs, folder, output_type='monthly',
                            file_name='annual_risk.tif', target_q=0.5,
                            with_labels=False):
    """Per-polygon QMRA risk for one scenario.

    Pure function (no Flask request access) so it can be reused by the report
    builder.  Returns `{iso: {risk, count, routes, cases[, name]}}`.
    Raises ImportError (missing deps) or FileNotFoundError (missing raster /
    geodata).  When *with_labels* is true each entry also carries a human
    readable `name` taken from the shapefile attributes.
    """
    import numpy as np
    import rasterio
    from rasterio.mask import mask as rio_mask
    from rasterio.warp import transform_geom
    from rasterio.crs import CRS
    from rasterio.features import geometry_mask
    import fiona

    tif_path = os.path.join(_qmra_base(cs['folder_path'], folder),
                            'combined', output_type, file_name)
    if not os.path.exists(tif_path):
        raise FileNotFoundError(f'File not found: {file_name}')

    shp_path = find_geodata_shapefile(cs['folder_path'], folder)
    if not shp_path:
        raise FileNotFoundError('No geodata folder')

    result = {}
    with rasterio.open(tif_path) as src:
        raster_crs = src.crs or CRS.from_epsg(4326)
        descs      = src.descriptions or []
        nodata     = src.nodata
        wgs84      = 'EPSG:4326'

        # Pick the combined band, plus one band per available pathway
        # route, all at `target_q` (last-matching scenario variant wins
        # -- see _select_band_index).
        combined_idx = _select_band_index(descs, 'combined', target_q) or 1
        route_keys = []
        seen = set()
        for desc in descs:
            r, _q = _parse_band(desc)
            if r and r != 'combined' and r not in seen:
                seen.add(r)
                route_keys.append(r)
        band_keys    = ['combined'] + route_keys
        band_indexes = [combined_idx]
        for r in route_keys:
            band_indexes.append(_select_band_index(descs, r, target_q) or combined_idx)

        # Full-grid combined band + resampled population, used to derive
        # per-area *expected infections* (risk_cell × population_cell,
        # summed within each polygon) that track the selected quantile --
        # unlike the fixed expected_cases.tif (always baked at q0.5).
        pop_grid = None
        combined_band_full = None
        if file_name == 'annual_risk.tif' and output_type == 'monthly':
            pop_grid = _pop_grid_for(cs['folder_path'], folder, tif_path)
            if pop_grid is not None:
                combined_band_full = src.read(combined_idx).astype('float64')
                if nodata is not None:
                    try:
                        ndv = float(nodata)
                        if not np.isnan(ndv):
                            combined_band_full[combined_band_full == ndv] = np.nan
                    except (TypeError, ValueError):
                        pass
                combined_band_full[(combined_band_full < 0) | (combined_band_full > 1.0)] = np.nan
                if combined_band_full.shape != pop_grid.shape:
                    combined_band_full = None

        with fiona.open(shp_path) as shp:
            shp_crs_str = shp.crs_wkt or wgs84
            for idx, feat in enumerate(shp):
                iso  = str(idx + 1)
                geom = feat['geometry']
                try:
                    geom_r = transform_geom(shp_crs_str, raster_crs.to_wkt(), geom)
                except Exception:
                    geom_r = geom
                try:
                    out, _ = rio_mask(src, [geom_r], crop=True, all_touched=True,
                                      filled=True, nodata=np.nan, indexes=band_indexes)
                    combined_val   = None
                    combined_count = 0
                    routes_out     = {}
                    for pos, key in enumerate(band_keys):
                        vals = out[pos].astype(float)
                        if nodata is not None:
                            try:
                                vals[vals == float(nodata)] = np.nan
                            except Exception:
                                pass
                        vals[vals < 0]   = np.nan
                        vals[vals > 1.0] = np.nan
                        valid = vals[~np.isnan(vals)]
                        # Average over populated (nonzero) cells so this matches
                        # the headline "area-average" figure; background zero
                        # cells inside the polygon would otherwise dilute it.
                        positive = valid[valid > 0]
                        if len(positive):
                            mean_val = float(np.mean(positive))
                            if key == 'combined':
                                combined_val   = mean_val
                                combined_count = int(len(positive))
                            else:
                                routes_out[key] = mean_val
                    if combined_val is not None:
                        cases_val = None
                        if combined_band_full is not None and pop_grid is not None:
                            try:
                                feat_mask = geometry_mask(
                                    [geom_r], out_shape=combined_band_full.shape,
                                    transform=src.transform, invert=True,
                                )
                                valid_c = (
                                    feat_mask
                                    & np.isfinite(combined_band_full) & (combined_band_full > 0)
                                    & np.isfinite(pop_grid)
                                )
                                if np.any(valid_c):
                                    cases_val = float(np.sum(
                                        combined_band_full[valid_c] * pop_grid[valid_c]
                                    ))
                            except Exception:
                                cases_val = None
                        entry = {
                            'risk':   combined_val,
                            'count':  combined_count,
                            'routes': routes_out,
                            'cases':  cases_val,
                        }
                        if with_labels:
                            entry['name'] = area_label(feat.get('properties') or {}) or f'Area {iso}'
                        result[iso] = entry
                except Exception:
                    pass

    return result


def qmra_area_stats(scenario_id):
    """Return per-ISO risk from a QMRA combined output TIF, at a given quantile.

    Query params:
      output_type  'monthly' (default) or 'daily'
      file         filename in combined/<output_type>/ (default: annual_risk.tif)
      quantile     which quantile ('0.025', '0.5', '0.975', ...) to read (default '0.5')

    Returns:
      { iso: { risk: float, count: int, routes: { route: float, ... }, cases: float|None } }
    where `risk` is the requested-quantile combined probability value per
    polygon, `routes` gives the same for each individual exposure pathway
    present in the file (used by the region-click risk breakdown), and
    `cases` is the expected annual infections for that polygon (combined
    risk at `quantile` × population, summed per-cell) -- only populated when
    `file == 'annual_risk.tif'` and population rasters are available.
    """
    output_type = request.args.get('output_type', 'monthly')
    file_name   = request.args.get('file', 'annual_risk.tif')
    if output_type not in ('monthly', 'daily'):
        return jsonify({'error': 'Invalid output_type'}), 400
    if '..' in file_name or '/' in file_name or '\\' in file_name:
        return jsonify({'error': 'Invalid file parameter'}), 400
    try:
        target_q = float(request.args.get('quantile', '0.5'))
    except ValueError:
        return jsonify({'error': 'Invalid quantile'}), 400

    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    try:
        result = compute_qmra_area_stats(cs, folder, output_type, file_name, target_q)
        return jsonify(result), 200
    except ImportError:
        return jsonify({'error': 'rasterio/numpy/fiona not available'}), 500
    except FileNotFoundError as exc:
        return jsonify({'error': str(exc)}), 404
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/qmra/status',                                                                  ['GET'],  qmra_status),
        ('/api/scenarios/<scenario_id>/qmra/availability',                                    ['GET'],  qmra_availability),
        ('/api/scenarios/<scenario_id>/qmra/config',                                          ['GET'],  qmra_get_config),
        ('/api/scenarios/<scenario_id>/qmra/config',                                          ['PUT'],  qmra_put_config),
        ('/api/scenarios/<scenario_id>/qmra/run',                                             ['POST'], qmra_run),
        ('/api/qmra/run-status/<run_id>',                                                     ['GET'],  qmra_run_status),
        ('/api/scenarios/<scenario_id>/qmra/output',                                          ['GET'],  qmra_output_files),
        ('/api/scenarios/<scenario_id>/qmra/stats',                                           ['GET'],  qmra_stats),
        ('/api/scenarios/<scenario_id>/qmra/area-stats',                                      ['GET'],  qmra_area_stats),
        ('/api/scenarios/<scenario_id>/qmra/raster/<route_key>/<output_type>/<path:filename>',['GET'],  qmra_raster),
        ('/api/scenarios/<scenario_id>/qmra/log',                                             ['GET'],  qmra_log),
        ('/api/qmra/diff-tif',                                                                ['GET'],  qmra_diff_tif),
        ('/api/case-studies/<case_study_id>/qmra/rerun-all',                                  ['POST'], qmra_rerun_all),
        ('/api/case-studies/<case_study_id>/qmra/config',                                     ['GET'],  qmra_cs_get_config),
        ('/api/case-studies/<case_study_id>/qmra/config',                                     ['PUT'],  qmra_cs_put_config),
        ('/api/case-studies/<case_study_id>/qmra/treatment-tif',                              ['GET'],  qmra_cs_treatment_tif),
        ('/api/case-studies/<case_study_id>/qmra/treatment-codes',                            ['GET'],  qmra_cs_treatment_codes),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
