"""Livestock module: detection of the livestock_emissions/ folder, helpers
that summarise it, and the endpoints that expose the editable per-animal
isodata + heads-by-area + headcount editing.
"""

import csv
import mimetypes
import os

from flask import jsonify, request, send_file

from fs_utils import (
    _livestock_dir_for_scenario,
    _locate_scenario,
    _read_csv_table,
    _resolve_data_path,
    _tif_pixel_dimensions,
)
from state import _GLOWPA_ANIMALS, _LIVESTOCK_EDITABLE_CSVS


# ──────────────────────────────────────────────────────────────────────────────
# Detection
# ──────────────────────────────────────────────────────────────────────────────

def _tif_has_valid_data(tif_path):
    """Return True if `tif_path` has at least one non-nodata pixel.

    Used to detect corrupt/placeholder rasters (e.g. an all-nodata
    temperature.tif) that would otherwise pass file-existence checks but
    crash GloWPa deep inside its R engine. Permissive on read errors — let
    GloWPa itself surface any real problem with the file.
    """
    try:
        import numpy as np
        import rasterio
        with rasterio.open(tif_path) as src:
            data = src.read(1)
            nodata = src.nodata
        if nodata is None:
            return True
        if isinstance(nodata, float) and np.isnan(nodata):
            return bool(np.any(~np.isnan(data)))
        return bool(np.any(data != nodata))
    except Exception:
        return True


# A reasonable global fallback mean annual air temperature (°C), used only
# when a scenario's temperature.tif is corrupt/all-nodata (see
# `_ensure_valid_temperature_tif`). GloWPa hard-requires this raster (via
# `validate_required_field`) so it cannot simply be omitted — but the
# alternative to a fallback value is a hard crash in
# `manure_storage_survival_frac`, which blocks the whole model run.
_FALLBACK_TEMPERATURE_C = 20.0

_VALID_TEMPERATURE_CACHE = {}


def _ensure_valid_temperature_tif(tif_path):
    """If `tif_path` has zero valid (non-nodata) pixels, write a sibling copy
    filled with `_FALLBACK_TEMPERATURE_C` and return its path; otherwise
    return `tif_path` unchanged."""
    if tif_path in _VALID_TEMPERATURE_CACHE:
        return _VALID_TEMPERATURE_CACHE[tif_path]
    out_path = tif_path
    try:
        if not _tif_has_valid_data(tif_path):
            import rasterio
            patched_path = os.path.join(
                os.path.dirname(tif_path),
                '.' + os.path.basename(tif_path).replace('.tif', '.filled.tif'),
            )
            regenerate = (
                not os.path.exists(patched_path)
                or os.path.getmtime(tif_path) > os.path.getmtime(patched_path)
            )
            if regenerate:
                with rasterio.open(tif_path) as src:
                    profile = dict(src.profile, dtype='float64', nodata=None)
                    shape = (src.height, src.width)
                print(
                    f"WARNING: temperature raster {tif_path} has no valid "
                    "(non-nodata) pixel values; filling it with a fallback "
                    f"constant of {_FALLBACK_TEMPERATURE_C}\u00b0C to prevent a "
                    "silent model crash. Livestock manure-survival results "
                    "for this scenario will use this approximation instead "
                    "of real temperature data."
                )
                import numpy as np
                filled = np.full(shape, _FALLBACK_TEMPERATURE_C, dtype='float64')
                with rasterio.open(patched_path, 'w', **profile) as dst:
                    dst.write(filled, 1)
            out_path = patched_path
    except Exception:
        out_path = tif_path
    _VALID_TEMPERATURE_CACHE[tif_path] = out_path
    return out_path


def _detect_livestock_module(cs_path, folder):
    """Return livestock input metadata for a scenario, or None if absent.

    Checks for a livestock_emissions/ sub-folder inside the scenario input
    directory.
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
    # the analysis domain, and repair it if it's corrupt/empty (all nodata) —
    # either of these makes GloWPa's `manure_storage_survival_frac` crash with
    # "'names' attribute [1] must be the same length as the vector [0]"
    # instead of failing gracefully. GloWPa hard-requires a temperature raster
    # to be declared for the livestock module, so an all-nodata file can't
    # simply be dropped — see `_ensure_valid_temperature_tif`.
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
        if temperature_tif:
            temperature_tif = _ensure_valid_temperature_tif(temperature_tif)

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


# ──────────────────────────────────────────────────────────────────────────────
# Prevalence format normalisation helpers
# ──────────────────────────────────────────────────────────────────────────────

_PREV_FIELDS = ('prev_young', 'prev_adult')

# Real-world names for the IPCC/Vermeulen-2017 macro-regions used by the
# `iso` column in livestock_emissions/animals/isodata_<animal>.csv files.
# Verified against the source data (vermeulen_2017/ippc_region_animal.csv,
# waterpath-data-service) which lists exactly these 7 regions, in this row
# order, for every animal.
IPCC_REGION_NAMES = {
    1: 'Africa',
    2: 'Asia',
    3: 'Europe',
    4: 'Latin America',
    5: 'NENA (Near East / North Africa)',
    6: 'North America',
    7: 'Oceania',
}


def _ipcc_region_label(iso, fallback_index):
    iso_str = str(iso or '').strip()
    try:
        name = IPCC_REGION_NAMES.get(int(float(iso_str)))
    except (TypeError, ValueError):
        name = None
    if name:
        return f"{name} (IPCC region {iso_str})"
    return f"IPCC Region {iso_str or (fallback_index + 1)}"


def _is_prev_fraction_format(all_area_rows):
    """Return True if prev_young/prev_adult are stored as fractions (0-1).

    Detection rule: every non-blank numeric value for those fields must be ≤ 1.
    If any value exceeds 1 they are already in percentage (0-100) format.
    """
    for rows in all_area_rows:
        for row in rows:
            for field in _PREV_FIELDS:
                raw = str(row.get(field) or '').strip()
                if not raw:
                    continue
                try:
                    if float(raw) > 1:
                        return False
                except ValueError:
                    pass
    return True


def _is_prev_fraction_format_file(csv_path):
    """Same detection, but read directly from a single CSV file."""
    try:
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                for field in _PREV_FIELDS:
                    raw = str(row.get(field) or '').strip()
                    if not raw:
                        continue
                    try:
                        if float(raw) > 1:
                            return False
                    except ValueError:
                        pass
    except Exception:
        return False
    return True


# ──────────────────────────────────────────────────────────────────────────────
# Endpoint handlers
# ──────────────────────────────────────────────────────────────────────────────

def get_livestock_population(scenario_id):
    """Return a table view over livestock animals/isodata_<animal>.csv files.

    Note: the 'iso' column in these per-animal files is an IPCC/Vermeulen-2017
    macro-region code, NOT the district/GID identifier used in the case
    study's human isodata.csv (those are unrelated numbering spaces that just
    happen to overlap for low values). Rows are therefore labelled generically
    as "IPCC Region <n>" rather than resolved against case-study geography.
    """
    try:
        cs, folder, ls_dir = _livestock_dir_for_scenario(scenario_id)
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
            row['areaRows'] = area_rows
            row['animal'] = animal
            data.append(row)

            if not area_labels and area_rows:
                area_labels = [
                    _ipcc_region_label(r.get('iso'), i)
                    for i, r in enumerate(area_rows)
                ]

        # Normalise prevalence fields to percentage (0-100) for display.
        # Some case studies store them as fractions (0-1, GloWPa native format);
        # others already use percentages.  Detect once across all animals.
        all_area_rows = [row['areaRows'] for row in data]
        if _is_prev_fraction_format(all_area_rows):
            for row in data:
                for ar in row.get('areaRows', []):
                    for field in _PREV_FIELDS:
                        raw = str(ar.get(field) or '').strip()
                        if raw:
                            try:
                                ar[field] = str(round(float(raw) * 100, 10))
                            except ValueError:
                                pass
                # Update the top-level summary value too (first area row)
                if row.get('areaRows'):
                    for field in _PREV_FIELDS:
                        row[field] = row['areaRows'][0].get(field, row.get(field, ''))

        preferred = ['iso', 'gid']
        ordered = [c for c in preferred if c in fieldnames] + [c for c in fieldnames if c not in preferred]

        return jsonify({'data': data, 'fieldnames': ordered, 'areas': area_labels}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def update_livestock_population(scenario_id):
    """Update values in animals/isodata_<animal>.csv files from table rows."""
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
                for row in rows_existing:
                    for k, v in src_row.items():
                        if k in readonly:
                            continue
                        if k in fieldnames:
                            row[k] = '' if v is None else str(v)

            # If this file stores prevalence as fractions (0-1), convert the
            # incoming percentage values (0-100) back to fractions before saving.
            prev_is_fraction = _is_prev_fraction_format_file(csv_path)

            with open(csv_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for r in rows_existing:
                    out = {k: r.get(k, '') for k in fieldnames}
                    if prev_is_fraction:
                        for field in _PREV_FIELDS:
                            if field in out and out[field] != '':
                                try:
                                    out[field] = str(round(float(out[field]) / 100, 10))
                                except ValueError:
                                    pass
                    writer.writerow(out)
            updated_files += 1

        return jsonify({'message': 'Livestock population updated', 'updated_files': updated_files}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def get_livestock_tif(scenario_id, filename):
    """Serve a raw heads TIF file for rendering in the browser."""
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


def get_input_raster(scenario_id, filename):
    """Serve an input TIF raster (isoraster.tif, poprural.tif, popurban.tif)."""
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


def get_livestock_available_animals(scenario_id):
    """Return animals whose heads TIF has a non-zero grid sum."""
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
                result[animal] = None

        return jsonify({'animals': result}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# In-process cache for get_livestock_heads_by_area keyed by (scenario_id, max_mtime)
_HEADS_BY_AREA_CACHE = {}


def _heads_by_area_cache_key(animals_dir):
    """Return max mtime across all *_heads.tif files, or None if dir is missing."""
    try:
        mtimes = [
            os.path.getmtime(os.path.join(animals_dir, f))
            for f in os.listdir(animals_dir)
            if f.lower().endswith('_heads.tif')
        ]
        return max(mtimes) if mtimes else None
    except Exception:
        return None


def _invalidate_heads_by_area_cache(scenario_id):
    """Drop all cache entries for a scenario (called after headcount edits)."""
    keys_to_drop = [k for k in _HEADS_BY_AREA_CACHE if k[0] == scenario_id]
    for k in keys_to_drop:
        del _HEADS_BY_AREA_CACHE[k]


def get_livestock_heads_by_area(scenario_id):
    """Return per-area animal head totals derived from animals/*_heads.tif rasters."""
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

        cache_key = (scenario_id, _heads_by_area_cache_key(animals_dir))
        if cache_key[1] is not None and cache_key in _HEADS_BY_AREA_CACHE:
            return jsonify(_HEADS_BY_AREA_CACHE[cache_key]), 200

        shp_path = None
        candidate_dirs = [
            os.path.join(cs['folder_path'], 'input', folder, 'geodata'),
            os.path.join(cs['folder_path'], 'input', 'baseline', 'geodata'),
            os.path.join(cs['folder_path'], 'input', 'geodata'),
        ]
        for geodata_dir in candidate_dirs:
            if not os.path.isdir(geodata_dir):
                continue
            shp_files = [f for f in os.listdir(geodata_dir) if f.lower().endswith('.shp')]
            if shp_files:
                shp_path = os.path.join(geodata_dir, shp_files[0])
                break
        if not shp_path:
            return jsonify({'error': 'No geodata shapefile found'}), 404

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

        result = {
            'areas': areas,
            'animals': animals,
            'by_area': by_area,
            'totals_by_animal': totals_by_animal,
        }
        if cache_key[1] is not None:
            _HEADS_BY_AREA_CACHE[cache_key] = result
        return jsonify(result), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ImportError as e:
        return jsonify({'error': f'Missing geospatial dependency: {e}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def set_livestock_headcount(scenario_id):
    """Scale livestock heads TIF pixels to match new total head counts."""
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

        _invalidate_heads_by_area_cache(scenario_id)
        return jsonify({'results': results}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except ImportError as e:
        return jsonify({'error': f'Missing geospatial dependency: {e}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def get_livestock_csv(scenario_id, filename):
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


def update_livestock_csv(scenario_id, filename):
    """Write rows to an editable livestock_emissions CSV file."""
    try:
        _, _, ls_dir = _livestock_dir_for_scenario(scenario_id)
        name = os.path.basename(filename)
        if name not in _LIVESTOCK_EDITABLE_CSVS:
            return jsonify({'error': f'Unsupported livestock CSV: {name}'}), 400

        payload = request.get_json() or {}
        rows = payload.get('rows', [])
        fieldnames = payload.get('fieldnames', [])

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


# ──────────────────────────────────────────────────────────────────────────────
# Route registration
# ──────────────────────────────────────────────────────────────────────────────

def register_routes(app, frontend_app):
    """Register livestock endpoints onto both Flask apps.

    The original code defined every endpoint twice (once on ``frontend_app``
    and once on ``app``) so that both servers can serve the API.  Use distinct
    endpoint names for each registration so Flask's url_map stays unambiguous.
    """
    routes = [
        ('/api/scenarios/<scenario_id>/livestock-population', ['GET'], get_livestock_population),
        ('/api/scenarios/<scenario_id>/livestock-population', ['PUT'], update_livestock_population),
        ('/api/scenarios/<scenario_id>/livestock-tif/<path:filename>', ['GET'], get_livestock_tif),
        ('/api/scenarios/<scenario_id>/input-raster/<path:filename>', ['GET'], get_input_raster),
        ('/api/scenarios/<scenario_id>/livestock-available-animals', ['GET'], get_livestock_available_animals),
        ('/api/scenarios/<scenario_id>/livestock-heads-by-area', ['GET'], get_livestock_heads_by_area),
        ('/api/scenarios/<scenario_id>/livestock-headcount', ['PUT'], set_livestock_headcount),
        ('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', ['GET'], get_livestock_csv),
        ('/api/scenarios/<scenario_id>/livestock-csv/<path:filename>', ['PUT'], update_livestock_csv),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
