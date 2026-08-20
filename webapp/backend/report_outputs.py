"""Model-output statistics and map images used by the narrative report.

Reads a scenario's GloWPa / hydrology / QMRA outputs from disk and turns them
into two things the report builder needs:

  * plain numbers the narrative templates can verbalise (source split of the
    emissions, dominant sanitation technologies, most affected areas, seasonal
    peaks, ...) -- see `compute_output_stats`;
  * ready-to-embed PNG map images with a description of their colour scale --
    see `render_scenario_maps`.

Everything here is filesystem-only (no Flask request state), so it can be
called straight from the report builder.  numpy / rasterio / fiona are imported
lazily inside the functions that need them: a case study without model output
must still be reportable on a machine that lacks the geo stack.
"""

import csv
import math
import os
import re
import warnings

from fs_utils import area_label, find_geodata_shapefile

MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
               'July', 'August', 'September', 'October', 'November', 'December']

# Column name -> display label for the per-technology human emission outputs.
SANITATION_LABELS = {
    'flushSewer': 'flush to sewer',
    'flushSeptic': 'flush to septic tank',
    'flushPit': 'flush to pit',
    'flushOpen': 'flush to open drain',
    'flushUnknown': 'flush to unknown destination',
    'pitSlab': 'pit latrine with slab',
    'pitNoSlab': 'pit latrine without slab',
    'compostingToilet': 'composting toilet',
    'bucketLatrine': 'bucket latrine',
    'containerBased': 'container-based sanitation',
    'hangingToilet': 'hanging toilet',
    'openDefecation': 'open defecation',
    'other': 'other facilities',
}

ANIMAL_LABELS = {
    'asses': 'asses', 'buffaloes': 'buffaloes', 'camels': 'camels',
    'cattle': 'cattle', 'goats': 'goats', 'horses': 'horses',
    'mules': 'mules', 'pigs': 'pigs', 'poultry': 'poultry', 'sheep': 'sheep',
}

# The three compartments of surface_water_emissions_*.csv.
EMISSION_SOURCE_LABELS = {
    'humans': 'human excreta reaching water directly',
    'wwtp': 'wastewater treatment plant effluent',
    'land': 'runoff from land, dominated by livestock manure',
}
EMISSION_SOURCE_ORDER = ('humans', 'wwtp', 'land')

# Colour used for reporting areas that carry no data, and for their outlines.
# The outline mirrors the app's polygon style (`color: '#1e293b'` at ~0.2
# opacity in ResultsView.jsx), so it stays a hairline rather than a border.
_MAP_BACKGROUND = (233, 238, 242, 255)
_MAP_OUTLINE = (30, 41, 59, 70)

# ─── Colour ramps ────────────────────────────────────────────────────────────
# Copied verbatim from the app so a map in the report looks like the same map
# on screen.  Each entry is (position along the ramp, (r, g, b)).

# ResultsView.jsx YLORRD_STOPS, used for the emissions raster.
_EMISSION_STOPS = [
    (0.0, (255, 255, 255)), (1 / 17, (220, 200, 235)), (3 / 17, (148, 83, 189)),
    (5 / 17, (31, 119, 180)), (7 / 17, (23, 190, 207)), (9 / 17, (44, 160, 44)),
    (11 / 17, (188, 189, 34)), (13 / 17, (255, 215, 0)), (15 / 17, (255, 100, 0)),
    (1.0, (140, 0, 0)),
]
# ResultsView.jsx HYDRO_ABS_STOPS, used for the in-stream concentration raster.
_CONCENTRATION_STOPS = [
    (0.0, (11, 65, 89)), (0.2, (158, 182, 91)), (0.4, (212, 192, 74)),
    (0.6, (255, 229, 151)), (0.8, (189, 164, 87)), (1.0, (139, 37, 0)),
]
# RiskPanel.jsx RISK_STOPS, used for the probability-of-infection raster.
_RISK_STOPS = [
    (0.0, (255, 255, 255)), (0.01, (255, 255, 204)), (0.05, (255, 237, 160)),
    (0.10, (254, 217, 118)), (0.20, (254, 178, 76)), (0.35, (253, 141, 60)),
    (0.50, (252, 78, 42)), (0.70, (227, 26, 28)), (0.85, (189, 0, 38)),
    (1.0, (128, 0, 38)),
]

# The app draws emissions on a fixed log10 scale (settingsStore defaults
# `fixedColorScale` to true), so the report uses the same absolute range.
_EMISSION_LOG_MIN = 0
_EMISSION_LOG_MAX = 17


# ─── Small filesystem / CSV helpers ──────────────────────────────────────────

def output_dir(cs_path, folder):
    return os.path.join(cs_path, 'output', folder)


def _first_match(directory, pattern):
    """Return the path of the first file in *directory* matching *pattern*."""
    if not os.path.isdir(directory):
        return None
    rx = re.compile(pattern)
    for name in sorted(os.listdir(directory)):
        if rx.match(name):
            return os.path.join(directory, name)
    return None


def _iso_rows(path):
    """Read an iso-keyed output CSV into {iso: {column: float}}."""
    rows = {}
    if not path or not os.path.exists(path):
        return rows
    with open(path, newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            iso = str(row.get('iso') or '').strip()
            if not iso:
                continue
            values = {}
            for key, raw in row.items():
                if not key or key == 'iso':
                    continue
                try:
                    values[key] = float(raw)
                except (TypeError, ValueError):
                    values[key] = 0.0
            rows[iso] = values
    return rows


def _column_totals(rows):
    totals = {}
    for values in rows.values():
        for key, value in values.items():
            totals[key] = totals.get(key, 0.0) + value
    return totals


def _isodata_names(cs_path, folder):
    """Return {iso: area name} from the scenario's isodata.csv, if present."""
    candidates = [
        os.path.join(cs_path, 'input', folder, 'isodata.csv'),
        os.path.join(cs_path, 'input', 'baseline', 'isodata.csv'),
    ]
    for path in candidates:
        if not os.path.exists(path):
            continue
        names = {}
        with open(path, newline='', encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                iso = str(row.get('iso') or '').strip()
                if not iso:
                    continue
                names[iso] = area_label(row, f'area {iso}')
        if names:
            return names
    return {}


def _ranked_shares(totals, labels, grand_total=None, limit=None):
    """Turn {column: value} into a share list sorted from largest to smallest."""
    total = grand_total if grand_total is not None else sum(v for v in totals.values() if v > 0)
    if not total or total <= 0:
        return []
    items = []
    for key, value in totals.items():
        if value is None or value <= 0:
            continue
        items.append({
            'key': key,
            'label': labels.get(key, key),
            'value': value,
            'pct': value / total * 100.0,
        })
    items.sort(key=lambda i: i['value'], reverse=True)
    return items[:limit] if limit else items


# ─── Emission statistics (CSV based) ─────────────────────────────────────────

def compute_emissions_stats(cs_path, folder, top_areas=5):
    """Summarise the surface-water emission outputs of one scenario.

    Returns None when the scenario has not been run (or produced no emissions).
    """
    out = output_dir(cs_path, folder)
    sw_path = _first_match(out, r'^surface_water_emissions_.*\.csv$')
    if not sw_path:
        return None

    rows = _iso_rows(sw_path)
    totals = _column_totals(rows)
    grand = sum(max(totals.get(k, 0.0), 0.0) for k in EMISSION_SOURCE_ORDER)
    if grand <= 0:
        return None

    sources = [{
        'key': key,
        'label': EMISSION_SOURCE_LABELS[key],
        'value': totals.get(key, 0.0),
        'pct': totals.get(key, 0.0) / grand * 100.0,
    } for key in EMISSION_SOURCE_ORDER]
    sources_ranked = sorted(sources, key=lambda s: s['value'], reverse=True)

    names = _isodata_names(cs_path, folder)
    per_area = []
    for iso, values in rows.items():
        value = sum(max(values.get(k, 0.0), 0.0) for k in EMISSION_SOURCE_ORDER)
        if value <= 0:
            continue
        per_area.append({
            'iso': iso,
            'name': names.get(iso) or f'area {iso}',
            'value': value,
            'pct': value / grand * 100.0,
        })
    per_area.sort(key=lambda a: a['value'], reverse=True)

    human_total = max(totals.get('humans', 0.0), 0.0)
    sanitation = _ranked_shares(
        _column_totals(_iso_rows(_first_match(out, r'^human_sources_water_.*\.csv$'))),
        SANITATION_LABELS, grand_total=human_total or None, limit=4)
    livestock = _ranked_shares(
        _column_totals(_iso_rows(_first_match(out, r'^livestock_sources_water_.*\.csv$'))),
        ANIMAL_LABELS, limit=4)

    top = per_area[:top_areas]
    return {
        'total': grand,
        'unit': 'pathogens per year',
        'sources': sources,
        'sources_ranked': sources_ranked,
        'dominant_source': sources_ranked[0] if sources_ranked else None,
        'human_pct': totals.get('humans', 0.0) / grand * 100.0,
        'wwtp_pct': totals.get('wwtp', 0.0) / grand * 100.0,
        'land_pct': totals.get('land', 0.0) / grand * 100.0,
        'area_count': len(per_area),
        'top_areas': top,
        'top_areas_pct': sum(a['pct'] for a in top),
        'sanitation': sanitation,
        'dominant_sanitation': sanitation[0] if sanitation else None,
        'livestock': livestock,
        'dominant_livestock': livestock[0] if livestock else None,
    }


# ─── Raster helpers ──────────────────────────────────────────────────────────

def _read_masked(path, band=1):
    """Read one raster band as float64 with nodata and non-positive cells NaN."""
    import numpy as np
    import rasterio
    with rasterio.open(path) as src:
        arr = src.read(band).astype(np.float64)
        nodata = src.nodata
        if nodata is not None and not math.isnan(float(nodata)):
            arr[arr == float(nodata)] = np.nan
        arr[~np.isfinite(arr)] = np.nan
        arr[arr <= 0] = np.nan
        arr[arr > 1e30] = np.nan
        return arr, src.transform, src.crs


def _annual_mean(arrays):
    """Mean across monthly rasters, ignoring no-data.

    Cells outside the river network are no-data in every month, so nanmean
    warns about an empty slice for them; that is expected and the resulting
    NaN is what the renderer wants.
    """
    import numpy as np
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        return np.nanmean(np.stack(arrays, axis=0), axis=0)


def _monthly_conc_paths(cs_path, folder):
    """Return the twelve monthly stream-concentration rasters, in month order."""
    conc_dir = os.path.join(output_dir(cs_path, folder), 'hydrology', 'conc')
    if not os.path.isdir(conc_dir):
        return []
    found = []
    for name in os.listdir(conc_dir):
        match = re.search(r'm(\d{1,2})\.tif$', name)
        if match and not name.endswith('.aux.json'):
            found.append((int(match.group(1)), os.path.join(conc_dir, name)))
    found.sort()
    return found


def _zone_raster(cs_path, folder, out_shape, transform, raster_crs):
    """Rasterise the study-area boundaries onto the given grid.

    Returns (zones, labels) where `zones` is an int array (0 = outside every
    reporting area) and `labels` maps zone id -> area name.  Returns
    (None, {}) when the case study ships no geodata.
    """
    try:
        import fiona
        from rasterio.features import rasterize
        from rasterio.warp import transform_geom
    except ImportError:
        return None, {}

    shp_path = find_geodata_shapefile(cs_path, folder)
    if not shp_path:
        return None, {}

    dst_crs = raster_crs.to_wkt() if raster_crs is not None else 'EPSG:4326'
    shapes, labels = [], {}
    try:
        with fiona.open(shp_path) as src:
            src_crs = src.crs_wkt or 'EPSG:4326'
            for idx, feat in enumerate(src):
                zone_id = idx + 1
                geom = feat['geometry']
                try:
                    geom = transform_geom(src_crs, dst_crs, geom)
                except Exception:
                    pass
                shapes.append((geom, zone_id))
                labels[zone_id] = area_label(dict(feat['properties'] or {}), f'area {zone_id}')
        if not shapes:
            return None, {}
        zones = rasterize(shapes, out_shape=out_shape, transform=transform,
                          fill=0, dtype='int32', all_touched=True)
    except Exception:
        return None, {}
    return zones, labels


def _zonal_means(values, zones, labels, limit=5):
    """Rank reporting areas by the mean of *values* inside each zone."""
    import numpy as np
    if zones is None:
        return []
    valid = np.isfinite(values) & (zones > 0)
    if not valid.any():
        return []
    ids = zones[valid].astype(np.int64)
    vals = values[valid]
    size = int(ids.max()) + 1
    sums = np.bincount(ids, weights=vals, minlength=size)
    counts = np.bincount(ids, minlength=size)
    ranked = []
    for zone_id in range(1, size):
        if counts[zone_id] <= 0:
            continue
        ranked.append({
            'iso': str(zone_id),
            'name': labels.get(zone_id, f'area {zone_id}'),
            'value': float(sums[zone_id] / counts[zone_id]),
            'cells': int(counts[zone_id]),
        })
    ranked.sort(key=lambda a: a['value'], reverse=True)
    return ranked[:limit]


# ─── Concentration statistics ────────────────────────────────────────────────

def compute_concentration_stats(cs_path, folder, top_areas=5):
    """Summarise the modelled in-stream concentrations of one scenario."""
    paths = _monthly_conc_paths(cs_path, folder)
    if not paths:
        return None
    try:
        import numpy as np
    except ImportError:
        return None

    monthly, arrays = [], []
    transform = crs = None
    for month, path in paths:
        try:
            arr, tr, arr_crs = _read_masked(path)
        except Exception:
            continue
        if transform is None:
            transform, crs = tr, arr_crs
        if arrays and arr.shape != arrays[0].shape:
            continue
        arrays.append(arr)
        finite = arr[np.isfinite(arr)]
        monthly.append({
            'month': MONTH_NAMES[month - 1] if 1 <= month <= 12 else str(month),
            'value': float(np.mean(finite)) if finite.size else None,
        })
    if not arrays:
        return None

    with_values = [m for m in monthly if m['value'] is not None]
    annual = _annual_mean(arrays)
    finite = annual[np.isfinite(annual)]
    if not finite.size:
        return None

    zones, labels = _zone_raster(cs_path, folder, annual.shape, transform, crs)
    peak = max(with_values, key=lambda m: m['value']) if with_values else None
    trough = min(with_values, key=lambda m: m['value']) if with_values else None
    seasonal_ratio = None
    if peak and trough and trough['value'] and trough['value'] > 0:
        seasonal_ratio = peak['value'] / trough['value']

    return {
        'unit': 'pathogens per litre',
        'mean': float(np.mean(finite)),
        'median': float(np.median(finite)),
        'max': float(np.max(finite)),
        'min': float(np.min(finite)),
        'cell_count': int(finite.size),
        'monthly': monthly,
        'peak_month': peak['month'] if peak else None,
        'peak_value': peak['value'] if peak else None,
        'trough_month': trough['month'] if trough else None,
        'trough_value': trough['value'] if trough else None,
        'seasonal_ratio': seasonal_ratio,
        'top_areas': _zonal_means(annual, zones, labels, limit=top_areas),
    }


def compute_output_stats(cs_path, folder):
    """Bundle the emission and concentration summaries for one scenario."""
    stats = {}
    try:
        stats['emissions'] = compute_emissions_stats(cs_path, folder)
    except Exception:
        stats['emissions'] = None
    try:
        stats['concentration'] = compute_concentration_stats(cs_path, folder)
    except Exception:
        stats['concentration'] = None
    return stats


# ─── Map rendering ───────────────────────────────────────────────────────────

def _scale_ticks(vmin, vmax, log_scale, count=5):
    """Build legend ticks as {pos, mantissa, exponent} along the colour ramp."""
    if not log_scale:
        return [{'pos': i / (count - 1),
                 **_sci_parts(vmin + (i / (count - 1)) * (vmax - vmin))}
                for i in range(count)]

    # On a log axis, whole powers of ten read far better than evenly spaced
    # fractional exponents, so step through the exponents instead.
    lo, hi = math.log10(vmin), math.log10(vmax)
    step = max(1, int(math.ceil((hi - lo) / (count - 1))))
    exponents = list(range(int(math.ceil(lo)), int(math.floor(hi)) + 1, step))
    if not exponents:
        exponents = [int(round(lo)), int(round(hi))]
    span = hi - lo or 1.0
    return [{'pos': (e - lo) / span, **_sci_parts(10.0 ** e)} for e in exponents]


def _sci_parts(value):
    """Split a number into a mantissa string and a base-10 exponent."""
    if value is None or not math.isfinite(value) or value == 0:
        return {'mantissa': '0', 'exponent': None, 'text': '0'}
    exponent = int(math.floor(math.log10(abs(value))))
    mantissa = value / (10 ** exponent)
    if -2 <= exponent <= 3:
        text = f'{value:,.2f}'.rstrip('0').rstrip('.')
        return {'mantissa': text, 'exponent': None, 'text': text}
    mantissa_text = f'{mantissa:.1f}'.rstrip('0').rstrip('.')
    return {'mantissa': mantissa_text, 'exponent': exponent,
            'text': f'{mantissa_text}e{exponent}'}


def _rescale(rgba, target_width=1000, max_width=1500):
    """Nearest-neighbour resize so small model grids stay legible in print."""
    import numpy as np
    height, width = rgba.shape[:2]
    if width <= 0 or height <= 0:
        return rgba
    if width > max_width:
        step = int(math.ceil(width / max_width))
        rgba = rgba[::step, ::step]
        height, width = rgba.shape[:2]
    factor = int(max(1, min(8, round(target_width / width))))
    if factor > 1:
        rgba = np.repeat(np.repeat(rgba, factor, axis=0), factor, axis=1)
    return rgba


def _boundary_mask(zones):
    """One-cell-wide outline of the reporting areas.

    Only the cell on one side of each edge is marked, so the outline stays a
    hairline instead of doubling up into a two-cell border.
    """
    import numpy as np
    edges = np.zeros(zones.shape, dtype=bool)
    edges[:-1, :] |= zones[:-1, :] != zones[1:, :]
    edges[:, :-1] |= zones[:, :-1] != zones[:, 1:]
    return edges & (zones > 0)


def _apply_ramp(norm, stops):
    """Colour a normalised (0..1, NaN = no data) array with a stop list."""
    import numpy as np
    positions = np.array([s[0] for s in stops], dtype='float64')
    colours = np.array([s[1] for s in stops], dtype='float64')
    flat = np.clip(np.nan_to_num(norm, nan=0.0), 0.0, 1.0)
    rgba = np.zeros(norm.shape + (4,), dtype='uint8')
    for channel in range(3):
        rgba[..., channel] = np.interp(flat, positions, colours[:, channel]).round().astype('uint8')
    rgba[..., 3] = np.where(np.isfinite(norm), 255, 0).astype('uint8')
    return rgba


def _gradient_css(stops):
    """The same ramp as a CSS gradient, for the legend bar in the report."""
    parts = ', '.join(
        'rgb(%d,%d,%d) %.4g%%' % (r, g, b, pos * 100) for pos, (r, g, b) in stops)
    return 'linear-gradient(to right, %s)' % parts


def render_map_png(values, zones=None, stops=None, log_scale=True, unit='',
                   vmin=None, vmax=None):
    """Colour a 2D float array (NaN = no data) into a PNG map.

    Returns (png_bytes, legend) or None when the array holds no usable data.
    `vmin`/`vmax` pin the colour range to the same absolute scale the app uses;
    when they are omitted the range is taken from the data itself.
    """
    import numpy as np
    from results import _png_from_rgba

    stops = stops or _EMISSION_STOPS
    finite = values[np.isfinite(values)]
    if not finite.size:
        return None
    lo = vmin if vmin is not None else float(np.min(finite))
    hi = vmax if vmax is not None else float(np.max(finite))
    if log_scale:
        if lo <= 0:
            positive = finite[finite > 0]
            if not positive.size:
                return None
            lo = float(np.min(positive))
        if hi <= lo:
            hi = lo * 10
    elif hi <= lo:
        hi = lo + 1e-12

    with np.errstate(divide='ignore', invalid='ignore'):
        if log_scale:
            norm = (np.log10(values) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))
        else:
            norm = (values - lo) / (hi - lo)
    norm = np.where(np.isfinite(values), np.clip(norm, 0.0, 1.0), np.nan)

    rgba = _apply_ramp(norm, stops)
    if zones is not None:
        empty = (~np.isfinite(values)) & (zones > 0)
        rgba[empty] = _MAP_BACKGROUND

    rgba = _rescale(rgba)
    if zones is not None:
        # Outline after upscaling so it keeps its hairline width.
        outline = _boundary_mask(_rescale(zones[..., None])[..., 0])
        rgba[outline] = _MAP_OUTLINE

    legend = {
        'unit': unit,
        'log_scale': bool(log_scale),
        'gradient': _gradient_css(stops),
        'min': _sci_parts(lo),
        'max': _sci_parts(hi),
        'ticks': _scale_ticks(lo, hi, log_scale),
    }
    return _png_from_rgba(np.ascontiguousarray(rgba)), legend


def _emissions_map(cs_path, folder):
    path = _first_match(output_dir(cs_path, folder), r'^surface_water_emissions_.*\.tif$')
    if not path:
        return None
    values, transform, crs = _read_masked(path)
    zones, _ = _zone_raster(cs_path, folder, values.shape, transform, crs)
    return render_map_png(values, zones, stops=_EMISSION_STOPS, log_scale=True,
                          vmin=10 ** _EMISSION_LOG_MIN, vmax=10 ** _EMISSION_LOG_MAX,
                          unit='pathogens emitted to surface water per year')


def _concentration_map(cs_path, folder):
    import numpy as np
    paths = _monthly_conc_paths(cs_path, folder)
    if not paths:
        return None
    arrays, transform, crs = [], None, None
    for _, path in paths:
        try:
            arr, tr, arr_crs = _read_masked(path)
        except Exception:
            continue
        if transform is None:
            transform, crs = tr, arr_crs
        if arrays and arr.shape != arrays[0].shape:
            continue
        arrays.append(arr)
    if not arrays:
        return None
    annual = _annual_mean(arrays)
    zones, _ = _zone_raster(cs_path, folder, annual.shape, transform, crs)
    finite = annual[np.isfinite(annual)]
    if not finite.size:
        return None
    # The app ranges the concentration layer from 10^0 up to the raster maximum.
    return render_map_png(annual, zones, stops=_CONCENTRATION_STOPS, log_scale=True,
                          vmin=1.0, vmax=float(np.max(finite)),
                          unit='mean annual concentration, pathogens per litre')


def _risk_map(cs_path, folder, quantile=0.5):
    """Render the annual probability-of-infection raster at the given quantile."""
    import rasterio
    path = os.path.join(output_dir(cs_path, folder), 'qmra', 'combined', 'monthly', 'annual_risk.tif')
    if not os.path.exists(path):
        return None
    from qmra import _select_band_index
    with rasterio.open(path) as src:
        descriptions = list(src.descriptions or [])
    band = _select_band_index(descriptions, 'combined', quantile) or 1
    values, transform, crs = _read_masked(path, band=band)
    zones, _ = _zone_raster(cs_path, folder, values.shape, transform, crs)
    # A probability is already 0..1, which is exactly how the app colours it.
    return render_map_png(values, zones, stops=_RISK_STOPS, log_scale=False,
                          vmin=0.0, vmax=1.0,
                          unit='annual probability of infection')


MAP_KINDS = ('emissions', 'concentration', 'risk')

MAP_TITLES = {
    'emissions': 'Where the pathogens enter the water',
    'concentration': 'Where the water carries the highest concentrations',
    'risk': 'Where people face the highest risk',
}

MAP_CAPTIONS = {
    'emissions': 'Annual pathogen emissions to surface water',
    'concentration': 'Mean annual in-stream pathogen concentration',
    'risk': 'Annual probability of infection',
}


def render_scenario_maps(cs_path, folder, quantile=0.5, kinds=MAP_KINDS):
    """Render the requested maps for one scenario.

    Returns {kind: {'png': bytes, 'legend': {...}}} with an entry only for the
    maps whose source rasters exist and could be read.
    """
    builders = {
        'emissions': lambda: _emissions_map(cs_path, folder),
        'concentration': lambda: _concentration_map(cs_path, folder),
        'risk': lambda: _risk_map(cs_path, folder, quantile),
    }
    maps = {}
    for kind in kinds:
        builder = builders.get(kind)
        if not builder:
            continue
        try:
            result = builder()
        except Exception:
            result = None
        if result:
            png, legend = result
            maps[kind] = {'png': png, 'legend': legend}
    return maps
