"""Hydrology module: detection of the hydrology/ folder, computed metrics, and
endpoints that return monthly TIF averages, diffs and statistics.
"""

import io
import os
import re

from flask import jsonify, request, send_file

from fs_utils import _locate_scenario


def _detect_hydrology_module(cs_path, folder):
    """Return hydrology input metadata for a scenario, or None if absent.

    Looks for a ``hydrology/`` sub-folder inside the scenario input directory.
    """
    hydrology_dir = os.path.join(cs_path, 'input', folder, 'hydrology')
    if not os.path.isdir(hydrology_dir):
        return None

    def _dir_path(name):
        p = os.path.join(hydrology_dir, name)
        return p if os.path.isdir(p) else None

    def _file_path(*parts):
        p = os.path.join(hydrology_dir, *parts)
        return p if os.path.isfile(p) else None

    doc_file = None
    for doc_name in ('doc.tif', 'doc_global.tif', 'DOC.tif'):
        candidate = os.path.join(hydrology_dir, doc_name)
        if os.path.isfile(candidate):
            doc_file = candidate
            break

    flowdir_file = (_file_path('routing', 'flowdir.tif')
                    or _file_path('flowdir.tif'))
    flowacc_file = (_file_path('routing', 'flowacc.tif')
                    or _file_path('flowacc.tif'))

    return {
        'dir':               hydrology_dir,
        'runoff_dir':        _dir_path('runoff'),
        'discharge_dir':     _dir_path('discharge'),
        'river_temp_dir':    _dir_path('river_temperature'),
        'river_depth_dir':   _dir_path('river_depth'),
        'river_restime_dir': _dir_path('river_restime'),
        'ssrd_dir':          _dir_path('ssrd'),
        'doc_file':          doc_file,
        'flowdir_file':      flowdir_file,
        'flowacc_file':      flowacc_file,
    }


def _compute_hydrology_metrics(hy):
    """Compute spatial annual means for the four scenario-varying hydrology variables."""
    empty = {
        'hydrology_mean_annual_discharge':  None,
        'hydrology_mean_annual_runoff':     None,
        'hydrology_mean_river_temperature': None,
        'hydrology_mean_ssrd':              None,
    }
    if not hy:
        return empty
    try:
        import glob as _glob
        import numpy as np
        import rasterio
    except ImportError:
        return empty

    def _monthly_mean(directory):
        if not directory:
            return None
        tifs = sorted(_glob.glob(os.path.join(directory, '*m??.tif')))
        if not tifs:
            return None
        vals = []
        for tif_path in tifs:
            try:
                with rasterio.open(tif_path) as src:
                    arr = src.read(1).astype(float)
                    nd = src.nodata
                if nd is not None:
                    arr[arr == float(nd)] = np.nan
                arr[arr < 0] = np.nan
                m = float(np.nanmean(arr))
                if np.isfinite(m):
                    vals.append(m)
            except Exception:
                continue
        return float(np.mean(vals)) if vals else None

    return {
        'hydrology_mean_annual_discharge':  _monthly_mean(hy.get('discharge_dir')),
        'hydrology_mean_annual_runoff':     _monthly_mean(hy.get('runoff_dir')),
        'hydrology_mean_river_temperature': _monthly_mean(hy.get('river_temp_dir')),
        'hydrology_mean_ssrd':              _monthly_mean(hy.get('ssrd_dir')),
    }


# ── Endpoints ────────────────────────────────────────────────────────────────

def hydrology_average(scenario_id):
    """Return a pixel-wise mean GeoTIFF averaged across all monthly rasters."""
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500
    try:
        metric = request.args.get('metric', 'loads')
        if metric not in ('loads', 'concentration'):
            return jsonify({'error': 'metric must be loads or concentration'}), 400

        cs, folder = _locate_scenario(scenario_id)
        output_dir = os.path.join(cs['folder_path'], 'output', folder)
        subdir = 'loads' if metric == 'loads' else 'conc'
        tif_dir = os.path.join(output_dir, 'hydrology', subdir)
        if not os.path.isdir(tif_dir):
            return jsonify({'error': 'No hydrology output directory found'}), 404

        tif_paths = sorted(
            os.path.join(tif_dir, f) for f in os.listdir(tif_dir)
            if f.endswith('.tif') and not f.endswith('.aux.json')
               and re.search(r'm\d{1,2}\.tif$', f)
        )
        if not tif_paths:
            return jsonify({'error': 'No monthly TIFs found'}), 404

        arrays = []
        profile = None
        nodata_val = None
        for path in tif_paths:
            with rasterio.open(path) as src:
                if profile is None:
                    profile = src.profile.copy()
                    nodata_val = src.nodata
                arr = src.read(1).astype(np.float64)
                if nodata_val is not None:
                    arr[arr == nodata_val] = np.nan
                arr[arr <= 0] = np.nan
                arrays.append(arr)

        stack = np.stack(arrays, axis=0)
        mean_arr = np.nanmean(stack, axis=0)

        out_nodata = nodata_val if nodata_val is not None else -9999.0
        mean_arr = np.where(np.isnan(mean_arr), out_nodata, mean_arr)

        profile.update(dtype='float64', count=1, nodata=out_nodata, compress='lzw')
        with MemoryFile() as memfile:
            with memfile.open(**profile) as dst:
                dst.write(mean_arr.astype(np.float64), 1)
            memfile.seek(0)
            data = memfile.read()
        return send_file(io.BytesIO(data), mimetype='image/tiff', as_attachment=False,
                         download_name=f'hydrology_average_{metric}.tif')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_diff(scenario_id):
    """Return (month - annual_avg) / annual_avg * 100 percent-deviation GeoTIFF."""
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500
    try:
        metric = request.args.get('metric', 'loads')
        month_str = request.args.get('month', '')
        if metric not in ('loads', 'concentration'):
            return jsonify({'error': 'metric must be loads or concentration'}), 400
        try:
            month_int = int(month_str)
            if month_int < 1 or month_int > 12:
                raise ValueError()
        except (ValueError, TypeError):
            return jsonify({'error': 'month must be 1-12'}), 400

        cs, folder = _locate_scenario(scenario_id)
        output_dir = os.path.join(cs['folder_path'], 'output', folder)
        subdir = 'loads' if metric == 'loads' else 'conc'
        tif_dir = os.path.join(output_dir, 'hydrology', subdir)
        if not os.path.isdir(tif_dir):
            return jsonify({'error': 'No hydrology output directory found'}), 404

        tif_paths = sorted(
            os.path.join(tif_dir, f) for f in os.listdir(tif_dir)
            if f.endswith('.tif') and not f.endswith('.aux.json')
               and re.search(r'm\d{1,2}\.tif$', f)
        )
        if not tif_paths:
            return jsonify({'error': 'No monthly TIFs found'}), 404

        month_path = next(
            (p for p in tif_paths
             if (m := re.search(r'm(\d{1,2})\.tif$', p)) and int(m.group(1)) == month_int),
            None
        )
        if not month_path:
            return jsonify({'error': f'TIF for month {month_int} not found'}), 404

        arrays = []
        profile = None
        nodata_val = None
        for path in tif_paths:
            with rasterio.open(path) as src:
                if profile is None:
                    profile = src.profile.copy()
                    nodata_val = src.nodata
                arr = src.read(1).astype(np.float64)
                if nodata_val is not None:
                    arr[arr == nodata_val] = np.nan
                arr[arr <= 0] = np.nan
                arrays.append(arr)
        avg_arr = np.nanmean(np.stack(arrays, axis=0), axis=0)

        with rasterio.open(month_path) as src:
            month_arr = src.read(1).astype(np.float64)
        if nodata_val is not None:
            month_arr[month_arr == nodata_val] = np.nan
        month_arr[month_arr <= 0] = np.nan

        out_nodata = -9999.0
        diff_arr = np.full_like(avg_arr, out_nodata)
        valid = np.isfinite(avg_arr) & (avg_arr > 0) & np.isfinite(month_arr)
        diff_arr[valid] = (month_arr[valid] - avg_arr[valid]) / avg_arr[valid] * 100.0

        profile.update(dtype='float64', count=1, nodata=out_nodata, compress='lzw')
        with MemoryFile() as memfile:
            with memfile.open(**profile) as dst:
                dst.write(diff_arr.astype(np.float64), 1)
            memfile.seek(0)
            data = memfile.read()
        return send_file(io.BytesIO(data), mimetype='image/tiff', as_attachment=False,
                         download_name=f'hydrology_diff_{metric}_m{month_int:02d}.tif')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_monthly_stats(scenario_id):
    """Return per-month aggregate stats and percent deviation from the annual mean."""
    try:
        import numpy as np
        import rasterio
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500
    try:
        metric = request.args.get('metric', 'loads')
        if metric not in ('loads', 'concentration'):
            return jsonify({'error': 'metric must be loads or concentration'}), 400

        cs, folder = _locate_scenario(scenario_id)
        output_dir = os.path.join(cs['folder_path'], 'output', folder)
        subdir = 'loads' if metric == 'loads' else 'conc'
        tif_dir = os.path.join(output_dir, 'hydrology', subdir)
        if not os.path.isdir(tif_dir):
            return jsonify({'error': 'No hydrology output directory found'}), 404

        tif_files = sorted(
            f for f in os.listdir(tif_dir)
            if f.endswith('.tif') and not f.endswith('.aux.json')
               and re.search(r'm\d{1,2}\.tif$', f)
        )
        if not tif_files:
            return jsonify({'error': 'No monthly TIFs found'}), 404

        month_sums = {}
        for fname in tif_files:
            m = re.search(r'm(\d{1,2})\.tif$', fname)
            if not m:
                continue
            month_int = int(m.group(1))
            with rasterio.open(os.path.join(tif_dir, fname)) as src:
                arr = src.read(1).astype(np.float64)
                nd  = src.nodata
            if nd is not None:
                arr[arr == nd] = np.nan
            arr[arr <= 0] = np.nan
            month_sums[month_int] = float(np.nansum(arr))

        avg_sum = float(np.mean(list(month_sums.values()))) if month_sums else 0.0

        months_result = {}
        for m_int, s in month_sums.items():
            pct = (s - avg_sum) / avg_sum * 100.0 if avg_sum > 0 else 0.0
            months_result[str(m_int)] = {'sum': s, 'pct_diff': round(pct, 1)}

        return jsonify({'avg_sum': avg_sum, 'months': months_result}), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_files(scenario_id):
    """Return organised hydrology output files grouped by metric and month."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        output_dir    = os.path.join(cs['folder_path'], 'output', folder)
        input_hydro   = os.path.join(cs['folder_path'], 'input',  folder, 'hydrology')
        result = {'loads': {}, 'concentration': {}, 'river_temperature': {}, 'ssrd': {}, 'runoff': {}}

        # Output metrics (loads, concentration)
        subdir_metric = [
            (os.path.join(output_dir, 'hydrology', 'loads'), 'hydrology/loads', 'loads'),
            (os.path.join(output_dir, 'hydrology', 'conc'),  'hydrology/conc',  'concentration'),
        ]
        for abs_dir, rel_prefix, metric_key in subdir_metric:
            if not os.path.isdir(abs_dir):
                continue
            for fname in os.listdir(abs_dir):
                if not fname.endswith('.tif'):
                    continue
                m = re.search(r'm(\d{1,2})\.tif$', fname)
                if m:
                    month = int(m.group(1))
                    result[metric_key][str(month)] = f'{rel_prefix}/{fname}'

        # Input metrics (river_temperature, ssrd, runoff) — return bare filename so the
        # frontend can build /api/.../hydrology-input-raster/<metric>/<fname>
        for metric_key, subdir in [('river_temperature', 'river_temperature'), ('ssrd', 'ssrd'), ('runoff', 'runoff')]:
            input_dir = os.path.join(input_hydro, subdir)
            if not os.path.isdir(input_dir):
                continue
            for fname in os.listdir(input_dir):
                if not fname.endswith('.tif'):
                    continue
                m = re.search(r'm(\d{1,2})\.tif$', fname)
                if m:
                    month = int(m.group(1))
                    result[metric_key][str(month)] = fname

        return jsonify(result), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


_INPUT_METRICS = {'river_temperature', 'ssrd', 'discharge', 'runoff', 'river_depth'}


def hydrology_input_raster(scenario_id, metric, fname):
    """Serve a single monthly input GeoTIFF (river_temperature, ssrd, etc.)."""
    if metric not in _INPUT_METRICS:
        return jsonify({'error': 'Unknown metric'}), 400
    # Guard against path traversal
    fname = os.path.basename(fname)
    try:
        cs, folder = _locate_scenario(scenario_id)
        tif_path = os.path.join(cs['folder_path'], 'input', folder, 'hydrology', metric, fname)
        if not os.path.exists(tif_path):
            return jsonify({'error': 'File not found'}), 404
        return send_file(tif_path, mimetype='image/tiff', as_attachment=False,
                         download_name=fname)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_input_average(scenario_id):
    """Return a pixel-wise mean GeoTIFF across all months for an input metric."""
    metric = request.args.get('metric', 'river_temperature')
    if metric not in _INPUT_METRICS:
        return jsonify({'error': 'Unknown metric'}), 400
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500
    try:
        cs, folder = _locate_scenario(scenario_id)
        input_dir = os.path.join(cs['folder_path'], 'input', folder, 'hydrology', metric)
        if not os.path.isdir(input_dir):
            return jsonify({'error': f'No input directory for metric {metric}'}), 404
        paths = sorted(
            os.path.join(input_dir, f) for f in os.listdir(input_dir)
            if f.endswith('.tif') and re.search(r'm\d{1,2}\.tif$', f)
        )
        if not paths:
            return jsonify({'error': 'No monthly TIFs found'}), 404
        arrays, profile = [], None
        for path in paths:
            with rasterio.open(path) as src:
                arr = src.read(1).astype(np.float64)
                nd  = src.nodata
                if profile is None:
                    profile = src.profile.copy()
            if nd is not None:
                arr[arr == nd] = np.nan
            arrays.append(arr)
        mean_arr = np.nanmean(np.stack(arrays, axis=0), axis=0)
        out_nd = -9999.0
        mean_arr = np.where(np.isfinite(mean_arr), mean_arr, out_nd)
        profile.update(dtype='float64', count=1, nodata=out_nd, compress='lzw')
        with MemoryFile() as memfile:
            with memfile.open(**profile) as dst:
                dst.write(mean_arr.astype(np.float64), 1)
            memfile.seek(0)
            data = memfile.read()
        return send_file(io.BytesIO(data), mimetype='image/tiff', as_attachment=False,
                         download_name=f'{metric}_average.tif')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_compare_diff():
    """Return (scB − scA) / scA × 100 % cross-scenario comparison GeoTIFF.

    Query params:
      scA    – baseline scenario ID
      scB    – comparison scenario ID
      metric – concentration | loads  (default: concentration)
      month  – avg | 1-12            (default: avg)
    """
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.warp import reproject, Resampling
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500

    sc_a      = request.args.get('scA')
    sc_b      = request.args.get('scB')
    metric    = request.args.get('metric', 'concentration')
    month_str = request.args.get('month', 'avg')

    if not sc_a or not sc_b:
        return jsonify({'error': 'scA and scB are required'}), 400

    _OUT = {'concentration': 'conc', 'loads': 'loads'}
    _IN  = {'river_temperature', 'ssrd', 'discharge', 'runoff', 'river_depth'}
    if metric not in _OUT and metric not in _IN:
        return jsonify({'error': f'metric must be one of: {", ".join(sorted(_OUT) + sorted(_IN))}'}), 400

    try:
        def _tif_paths(scenario_id):
            cs, folder = _locate_scenario(scenario_id)
            if metric in _OUT:
                tif_dir = os.path.join(cs['folder_path'], 'output', folder, 'hydrology', _OUT[metric])
            else:
                tif_dir = os.path.join(cs['folder_path'], 'input', folder, 'hydrology', metric)
            if not os.path.isdir(tif_dir):
                raise ValueError(f'No hydrology directory for metric {metric!r}, scenario {scenario_id}')
            paths = sorted(
                os.path.join(tif_dir, f) for f in os.listdir(tif_dir)
                if f.endswith('.tif') and not f.endswith('.aux.json')
                   and re.search(r'm\d{1,2}\.tif$', f)
            )
            if not paths:
                raise ValueError(f'No monthly TIFs for scenario {scenario_id}')
            return paths

        def _read(path):
            with rasterio.open(path) as src:
                arr  = src.read(1).astype(np.float64)
                nd   = src.nodata
                prof = src.profile.copy()
            if nd is not None:
                arr[arr == nd] = np.nan
            arr[arr <= 0] = np.nan
            return arr, prof

        def _avg(paths):
            arrays, prof = [], None
            for p in paths:
                a, pr = _read(p)
                if prof is None:
                    prof = pr
                arrays.append(a)
            return np.nanmean(np.stack(arrays, axis=0), axis=0), prof

        def _month_path(paths, m):
            for p in paths:
                mm = re.search(r'm(\d{1,2})\.tif$', p)
                if mm and int(mm.group(1)) == m:
                    return p
            return None

        def _align(src_arr, src_prof, dst_prof):
            if src_arr.shape == (dst_prof['height'], dst_prof['width']):
                return src_arr
            tmp = np.full((dst_prof['height'], dst_prof['width']), np.nan, dtype=np.float64)
            reproject(
                source=src_arr, destination=tmp,
                src_transform=src_prof['transform'], src_crs=src_prof.get('crs'),
                dst_transform=dst_prof['transform'], dst_crs=dst_prof.get('crs'),
                resampling=Resampling.nearest,
                src_nodata=np.nan, dst_nodata=np.nan,
            )
            return tmp

        paths_a = _tif_paths(sc_a)
        paths_b = _tif_paths(sc_b)

        if month_str == 'avg':
            arr_a, prof_a = _avg(paths_a)
            arr_b, prof_b = _avg(paths_b)
        else:
            try:
                m_int = int(month_str)
                if not 1 <= m_int <= 12:
                    raise ValueError()
            except (ValueError, TypeError):
                return jsonify({'error': 'month must be avg or 1-12'}), 400

            pa = _month_path(paths_a, m_int)
            pb = _month_path(paths_b, m_int)
            if not pa:
                return jsonify({'error': f'Month {m_int} not found for scA'}), 404
            if not pb:
                return jsonify({'error': f'Month {m_int} not found for scB'}), 404
            arr_a, prof_a = _read(pa)
            arr_b, prof_b = _read(pb)

        arr_b = _align(arr_b, prof_b, prof_a)

        out_nd = -9999.0
        diff   = np.full_like(arr_a, out_nd)
        valid  = np.isfinite(arr_a) & (arr_a > 0) & np.isfinite(arr_b)
        diff[valid] = (arr_b[valid] - arr_a[valid]) / arr_a[valid] * 100.0

        prof_a.update(dtype='float64', count=1, nodata=out_nd, compress='lzw')
        with MemoryFile() as memfile:
            with memfile.open(**prof_a) as dst:
                dst.write(diff.astype(np.float64), 1)
            memfile.seek(0)
            data = memfile.read()

        suffix = 'avg' if month_str == 'avg' else f'm{int(month_str):02d}'
        return send_file(io.BytesIO(data), mimetype='image/tiff', as_attachment=False,
                         download_name=f'hydrology_compare_{metric}_{suffix}.tif')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_flow_vectors(scenario_id):
    """Return D8 flow-direction arrows as a GeoJSON FeatureCollection.

    Query params:
      month       – avg | 1-12 (discharge/depth attached when available; default: avg)
      spacing     – integer downsample step (default: 1 = every cell)
      min_acc_pct – include only cells where acc >= max_acc * pct/100 (default: 5)
    """
    try:
        import numpy as np
        import rasterio
    except ImportError:
        return jsonify({'error': 'rasterio/numpy not available'}), 500

    month_str   = request.args.get('month', 'avg')
    try:
        spacing = max(1, int(request.args.get('spacing', 1)))
    except (ValueError, TypeError):
        spacing = 1
    try:
        min_acc_pct = max(0.0, float(request.args.get('min_acc_pct', 5)))
    except (ValueError, TypeError):
        min_acc_pct = 5.0

    # D8 bearing lookup tables (degrees clockwise from North)
    ESRI_BEARING   = {1: 90, 2: 135, 4: 180, 8: 225, 16: 270, 32: 315, 64: 0, 128: 45}
    TAUDEM_BEARING = {1: 90, 2: 45,  3: 0,   4: 315, 5: 270,  6: 225,  7: 180, 8: 135}

    try:
        cs, folder = _locate_scenario(scenario_id)
        hy = _detect_hydrology_module(cs['folder_path'], folder)
        if not hy:
            return jsonify({'error': 'No hydrology data found'}), 404

        flowdir_file = hy.get('flowdir_file')
        flowacc_file = hy.get('flowacc_file')
        if not flowdir_file or not flowacc_file:
            return jsonify({'error': 'flowdir.tif or flowacc.tif not found'}), 404

        with rasterio.open(flowdir_file) as src:
            flowdir   = src.read(1)
            nd_dir    = src.nodata
            transform = src.transform
            height, width = src.height, src.width

        with rasterio.open(flowacc_file) as src:
            flowacc = src.read(1).astype(np.float64)
            nd_acc  = src.nodata

        if nd_dir is not None:
            flowdir = np.where(flowdir == nd_dir, 0, flowdir)
        if nd_acc is not None:
            flowacc = np.where(flowacc == nd_acc, np.nan, flowacc)
        flowacc[flowacc < 0] = np.nan

        # Detect ESRI (powers-of-2) vs TauDEM (1-8) encoding.
        # Strategy: look at the unique values present in the raster.
        #   - Any value in {3,5,6,7}     → must be TauDEM (not powers of 2)
        #   - Any value in {16,32,64,128} → must be ESRI   (> TauDEM max of 8)
        #   - Otherwise (only {1,2,4,8}) → ambiguous; default to ESRI (safer,
        #     since TauDEM cells with those values happen to share the same meaning)
        unique_vals = set(np.unique(flowdir[(flowdir > 0) & (flowdir <= 255)]).tolist())
        if unique_vals & {3, 5, 6, 7}:
            is_esri = False   # TauDEM-only values present
        elif unique_vals & {16, 32, 64, 128}:
            is_esri = True    # ESRI-only values present
        else:
            is_esri = True    # ambiguous — default to ESRI
        bearing_lookup = ESRI_BEARING if is_esri else TAUDEM_BEARING

        cell_deg_x = abs(transform.a)
        cell_deg_y = abs(transform.e)

        max_acc   = float(np.nanmax(flowacc)) if np.any(np.isfinite(flowacc)) else 1.0
        threshold = max_acc * min_acc_pct / 100.0

        # --- optional: load discharge and depth for the requested month ---
        def _load_monthly_raster(directory, month_str):
            """Read a single monthly TIF or the annual average."""
            if not directory or not os.path.isdir(directory):
                return None
            fnames = [f for f in os.listdir(directory) if re.search(r'm\d{1,2}\.tif$', f)]
            if not fnames:
                return None
            if month_str == 'avg':
                arrays = []
                for fn in sorted(fnames):
                    try:
                        with rasterio.open(os.path.join(directory, fn)) as s:
                            a = s.read(1).astype(np.float64)
                            nd = s.nodata
                        if nd is not None:
                            a[a == nd] = np.nan
                        a[a < 0] = np.nan
                        arrays.append(a)
                    except Exception:
                        pass
                return np.nanmean(np.stack(arrays, axis=0), axis=0) if arrays else None
            else:
                try:
                    m_int = int(month_str)
                except (ValueError, TypeError):
                    return None
                for fn in fnames:
                    mm = re.search(r'm(\d{1,2})\.tif$', fn)
                    if mm and int(mm.group(1)) == m_int:
                        try:
                            with rasterio.open(os.path.join(directory, fn)) as s:
                                a = s.read(1).astype(np.float64)
                                nd = s.nodata
                            if nd is not None:
                                a[a == nd] = np.nan
                            a[a < 0] = np.nan
                            return a
                        except Exception:
                            return None
                return None

        discharge_arr = _load_monthly_raster(hy.get('discharge_dir'), month_str)
        depth_arr     = _load_monthly_raster(hy.get('river_depth_dir'), month_str)

        # --- vectorised feature extraction ---
        rows_idx = np.arange(0, height, spacing)
        cols_idx = np.arange(0, width,  spacing)
        rr, cc   = np.meshgrid(rows_idx, cols_idx, indexing='ij')
        rr, cc   = rr.ravel(), cc.ravel()

        acc_vals = flowacc[rr, cc]
        mask     = np.isfinite(acc_vals) & (acc_vals >= threshold)
        rr, cc, acc_vals = rr[mask], cc[mask], acc_vals[mask]

        raw_dir  = np.round(flowdir[rr, cc].astype(float)).astype(int)
        bearings = np.array([bearing_lookup.get(int(d), -1) for d in raw_dir])
        valid    = bearings >= 0
        rr, cc, acc_vals, bearings = rr[valid], cc[valid], acc_vals[valid], bearings[valid]

        # Cell-centre geographic coordinates (north-up raster assumed)
        lons = transform.c + (cc + 0.5) * transform.a
        lats = transform.f + (rr + 0.5) * transform.e

        features = []
        for i in range(len(rr)):
            r_i, c_i = int(rr[i]), int(cc[i])
            props = {
                'bearing': int(bearings[i]),
                'acc':     round(float(acc_vals[i]), 2),
            }
            if discharge_arr is not None and r_i < discharge_arr.shape[0] and c_i < discharge_arr.shape[1]:
                v = discharge_arr[r_i, c_i]
                if np.isfinite(v) and v > 0:
                    props['discharge'] = round(float(v), 4)
            if depth_arr is not None and r_i < depth_arr.shape[0] and c_i < depth_arr.shape[1]:
                v = depth_arr[r_i, c_i]
                if np.isfinite(v) and v > 0:
                    props['depth'] = round(float(v), 4)
            features.append({
                'type':     'Feature',
                'geometry': {'type': 'Point', 'coordinates': [round(float(lons[i]), 6), round(float(lats[i]), 6)]},
                'properties': props,
            })

        return jsonify({
            'type':       'FeatureCollection',
            'features':   features,
            'cell_deg_x': round(float(cell_deg_x), 8),
            'cell_deg_y': round(float(cell_deg_y), 8),
            'encoding':   'esri' if is_esri else 'taudem',
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def hydrology_area_stats(scenario_id):
    """Return per-ISO zonal statistics (mean / max / count) for a concentration raster.

    Query params:
      metric  'concentration' (default)
      month   'avg' (default) or integer 1–12

    Returns:
      { iso: { mean: float, max: float, count: int } }
    Each ISO key is a 1-based integer string matching the geodata endpoint.
    """
    try:
        import numpy as np
        import rasterio
        from rasterio.mask import mask as rio_mask
        from rasterio.warp import transform_geom
        from rasterio.crs import CRS
        import fiona
    except ImportError:
        return jsonify({'error': 'rasterio/numpy/fiona not available'}), 500

    metric = request.args.get('metric', 'concentration')
    month  = request.args.get('month', 'avg')

    if metric not in ('concentration', 'loads'):
        return jsonify({'error': 'metric must be concentration or loads'}), 400

    try:
        cs, folder = _locate_scenario(scenario_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404

    cs_path    = cs['folder_path']
    output_dir = os.path.join(cs_path, 'output', folder)
    subdir     = 'conc' if metric == 'concentration' else 'loads'
    tif_dir    = os.path.join(output_dir, 'hydrology', subdir)

    if not os.path.isdir(tif_dir):
        return jsonify({'error': 'No hydrology output directory found'}), 404

    # Locate the shapefile used for zonal statistics (same as raster_area_stats)
    geo_dir = os.path.join(cs_path, 'input', 'baseline', 'geodata')
    if not os.path.isdir(geo_dir):
        return jsonify({'error': 'No geodata folder'}), 404
    shp_files = [f for f in os.listdir(geo_dir) if f.endswith('.shp')]
    if not shp_files:
        return jsonify({'error': 'No shapefile found'}), 404
    shp_path = os.path.join(geo_dir, shp_files[0])

    try:
        import numpy as np

        def _zonal_stats_from_tif(tif_path):
            """Return dict: iso -> (mean, max, count) arrays from one TIF."""
            result = {}
            with rasterio.open(tif_path) as src:
                raster_crs = src.crs or CRS.from_epsg(4326)
                nodata     = src.nodata
                wgs84      = 'EPSG:4326'
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
                                              filled=True, nodata=np.nan)
                            vals = out[0].astype(float)
                            if nodata is not None:
                                vals[vals == float(nodata)] = np.nan
                            vals[vals <= 0] = np.nan
                            vals[vals > 1e30] = np.nan
                            valid = vals[~np.isnan(vals)]
                            if len(valid):
                                result[iso] = {
                                    'mean':  float(valid.mean()),
                                    'max':   float(valid.max()),
                                    'count': int(len(valid)),
                                }
                        except Exception:
                            pass
            return result

        if month != 'avg':
            # Specific month: find the matching TIF
            try:
                month_int = int(month)
            except (ValueError, TypeError):
                return jsonify({'error': 'month must be avg or an integer 1–12'}), 400
            tif_files = [
                f for f in os.listdir(tif_dir)
                if f.endswith('.tif') and re.search(rf'm{month_int}\.tif$', f)
            ]
            if not tif_files:
                return jsonify({'error': f'No TIF found for month {month_int}'}), 404
            tif_path = os.path.join(tif_dir, tif_files[0])
            return jsonify(_zonal_stats_from_tif(tif_path)), 200

        else:
            # Average: aggregate per-area stats across all monthly TIFs
            all_files = sorted(
                f for f in os.listdir(tif_dir)
                if f.endswith('.tif') and re.search(r'm\d{1,2}\.tif$', f)
            )
            if not all_files:
                return jsonify({'error': 'No monthly TIFs found'}), 404

            # Accumulate sum/max/count per ISO across all months
            accum = {}  # iso -> {sum_mean, max_val, n_months}
            for fname in all_files:
                stats = _zonal_stats_from_tif(os.path.join(tif_dir, fname))
                for iso, s in stats.items():
                    if iso not in accum:
                        accum[iso] = {'sum_mean': 0.0, 'max_val': -1e308, 'n_months': 0}
                    accum[iso]['sum_mean']  += s['mean']
                    accum[iso]['max_val']    = max(accum[iso]['max_val'], s['max'])
                    accum[iso]['n_months']  += 1

            result = {}
            for iso, a in accum.items():
                if a['n_months'] > 0:
                    result[iso] = {
                        'mean':  a['sum_mean'] / a['n_months'],
                        'max':   a['max_val'],
                        'count': a['n_months'],
                    }
            return jsonify(result), 200

    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/scenarios/<scenario_id>/hydrology-average',                              ['GET'], hydrology_average),
        ('/api/scenarios/<scenario_id>/hydrology-diff',                                 ['GET'], hydrology_diff),
        ('/api/scenarios/<scenario_id>/hydrology-monthly-stats',                        ['GET'], hydrology_monthly_stats),
        ('/api/scenarios/<scenario_id>/hydrology-files',                                ['GET'], hydrology_files),
        ('/api/scenarios/<scenario_id>/hydrology-input-raster/<metric>/<path:fname>',   ['GET'], hydrology_input_raster),
        ('/api/scenarios/<scenario_id>/hydrology-input-average',                        ['GET'], hydrology_input_average),
        ('/api/hydrology-compare-diff',                                                 ['GET'], hydrology_compare_diff),
        ('/api/scenarios/<scenario_id>/hydrology-flow-vectors',                         ['GET'], hydrology_flow_vectors),
        ('/api/scenarios/<scenario_id>/hydrology-area-stats',                           ['GET'], hydrology_area_stats),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
