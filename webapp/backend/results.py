"""Output-raster + CSV endpoints: PNG diff overlay and per-ISO zonal stats."""

import os

from flask import jsonify, request

from fs_utils import _locate_scenario, find_geodata_shapefile


def _png_from_rgba(rgba):
    """Encode an H×W×4 uint8 numpy array to PNG bytes (pure stdlib, no PIL)."""
    import struct, zlib as zlib_mod
    h, w = rgba.shape[:2]

    def _chunk(tag, data):
        b = tag + data
        return struct.pack('>I', len(data)) + b + struct.pack('>I', zlib_mod.crc32(b) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))
    idat = zlib_mod.compress(raw, 6)
    return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', idat) + _chunk(b'IEND', b'')


# YlOrRd colormap breakpoints (position 0-1 → R,G,B 0-255)
_YLORRD = [
    (0.000, 255, 255, 204),
    (0.125, 255, 237, 160),
    (0.250, 254, 217, 118),
    (0.375, 254, 178,  76),
    (0.500, 253, 141,  60),
    (0.625, 252,  78,  42),
    (0.750, 227,  26,  28),
    (0.875, 189,   0,  38),
    (1.000, 128,   0,  38),
]


def _apply_diverg(diff_pct_2d, scale=100):
    """Apply diverging colour map to a diff % 2D array.
    Negative (decrease) → green; positive (increase) → red. Saturates at ±scale.
    Values within ±2 % of scale → near-white. NaN → transparent.
    """
    import numpy as np
    flat = diff_pct_2d.flatten()
    valid = ~np.isnan(flat)
    pct = np.where(valid, flat, 0.0)
    t = np.clip(np.abs(pct) / max(scale, 1), 0.0, 1.0)
    # Matches frontend diffColor():
    #   increase: rgb(lerp(254,153,t), lerp(202,27,t), lerp(202,27,t))
    #   decrease: rgb(lerp(187,20,t), lerp(247,83,t), lerp(208,45,t))
    is_pos = pct >= 0
    r = np.where(is_pos, 254 + t * (153 - 254), 187 + t * (20 - 187))
    g = np.where(is_pos, 202 + t * (27  - 202), 247 + t * (83 - 247))
    b = np.where(is_pos, 202 + t * (27  - 202), 208 + t * (45 - 208))
    near_zero = np.abs(pct) < scale * 0.02
    r = np.where(near_zero, 243.0, r)
    g = np.where(near_zero, 244.0, g)
    b = np.where(near_zero, 246.0, b)
    a = np.where(valid, 200, 0).astype(np.uint8)
    h2, w2 = diff_pct_2d.shape
    return np.stack([r.astype(np.uint8), g.astype(np.uint8), b.astype(np.uint8), a],
                    axis=-1).reshape(h2, w2, 4)


def _apply_ylorrd(norm_2d):
    """Apply YlOrRd colormap. norm_2d is float H×W in [0,1], NaN → transparent."""
    import numpy as np
    pos = [c[0] for c in _YLORRD]
    Rs  = [c[1] for c in _YLORRD]
    Gs  = [c[2] for c in _YLORRD]
    Bs  = [c[3] for c in _YLORRD]
    flat = norm_2d.flatten()
    valid = ~np.isnan(flat)
    clipped = np.clip(np.where(valid, flat, 0.0), 0.0, 1.0)
    r = np.interp(clipped, pos, Rs).astype(np.uint8)
    g = np.interp(clipped, pos, Gs).astype(np.uint8)
    b = np.interp(clipped, pos, Bs).astype(np.uint8)
    a = np.where(valid, 255, 0).astype(np.uint8)
    h, w = norm_2d.shape
    return np.stack([r, g, b, a], axis=-1).reshape(h, w, 4)


# ──────────────────────────────────────────────────────────────────────────────
# Endpoint handlers
# ──────────────────────────────────────────────────────────────────────────────

def output_files(scenario_id):
    """List non-log output files for a scenario's output folder."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        output_dir = os.path.join(cs['folder_path'], 'output', folder)
        if not os.path.isdir(output_dir):
            return jsonify({'files': []}), 200
        files = sorted(f for f in os.listdir(output_dir) if not f.endswith('.log'))
        return jsonify({'files': files}), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def raster_area_stats(scenario_id, filename):
    """Return per-ISO zonal statistics (min/max/mean/total/count) from a raster."""
    import numpy as np
    try:
        import rasterio
        from rasterio.mask import mask as rio_mask
        from rasterio.warp import transform_geom
        from rasterio.crs import CRS
        import fiona

        cs, folder = _locate_scenario(scenario_id)
        tif_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(tif_path):
            return jsonify({'error': 'File not found'}), 404

        shp_path = find_geodata_shapefile(cs['folder_path'], folder)
        if not shp_path:
            return jsonify({'error': 'No geodata folder'}), 404

        result = {}
        with rasterio.open(tif_path) as src:
            raster_crs = src.crs or CRS.from_epsg(4326)
            nodata = src.nodata
            wgs84_epsg = 'EPSG:4326'
            with fiona.open(shp_path) as shp:
                shp_crs_str = shp.crs_wkt or wgs84_epsg
                for idx, feat in enumerate(shp):
                    iso = str(idx + 1)  # 1-based index, matching geodata endpoint
                    geom = feat['geometry']
                    # Reproject geometry to raster CRS if needed
                    try:
                        geom_raster = transform_geom(shp_crs_str, raster_crs.to_wkt(), geom)
                    except Exception:
                        geom_raster = geom
                    try:
                        out, _ = rio_mask(src, [geom_raster], crop=True, all_touched=True, filled=True, nodata=np.nan)
                        vals = out[0].astype(float)
                        if nodata is not None:
                            vals[vals == float(nodata)] = np.nan
                        vals[vals <= 0] = np.nan
                        vals[vals > 1e30] = np.nan
                        valid = vals[~np.isnan(vals)]
                        if len(valid):
                            result[iso] = {
                                'min':   float(valid.min()),
                                'max':   float(valid.max()),
                                'mean':  float(valid.mean()),
                                'total': float(valid.sum()),
                                'count': int(len(valid)),
                            }
                        else:
                            result[iso] = None
                    except Exception:
                        result[iso] = None
        return jsonify(result), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def output_raster(scenario_id, filename):
    """Serve the raw GeoTIFF for client-side rendering with georaster-layer-for-leaflet."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        tif_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(tif_path):
            return jsonify({'error': 'File not found'}), 404
        from flask import send_file
        resp = send_file(tif_path, mimetype='image/tiff', as_attachment=False,
                         download_name=filename)
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def raster_diff():
    """Return a colourised diff raster (B − A) / A × 100 % for two scenarios.

    Query params:
      scA   – scenario ID for the baseline raster
      scB   – scenario ID for the comparison raster
      file  – raster filename (relative to each scenario's output folder)

    Returns {image: base64-PNG, bounds: {south,north,east,west}} using a
    diverging green/red colour map (green = decrease, red = increase).
    """
    import base64
    import numpy as np

    sc_a   = request.args.get('scA')
    sc_b   = request.args.get('scB')
    fname  = request.args.get('file')
    fname_a = request.args.get('fileA') or fname
    fname_b = request.args.get('fileB') or fname
    if not sc_a or not sc_b or not fname_a or not fname_b:
        return jsonify({'error': 'scA, scB and file (or fileA+fileB) are required'}), 400

    try:
        import rasterio
        from rasterio.warp import transform_bounds, reproject, Resampling, calculate_default_transform
        from rasterio.crs import CRS

        wgs84    = CRS.from_epsg(4326)
        mercator = CRS.from_epsg(3857)

        def _load_merc(sc_id, tif_fname):
            cs, folder = _locate_scenario(sc_id)
            tif_path = os.path.join(cs['folder_path'], 'output', folder, tif_fname)
            if not os.path.exists(tif_path):
                raise ValueError(f'File not found for scenario {sc_id}: {tif_fname}')
            with rasterio.open(tif_path) as src:
                data    = src.read(1).astype(float)
                src_crs = src.crs or wgs84
                src_tf  = src.transform
                src_nd  = src.nodata
                l, b_b, r, t = src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top
            # Mask nodata/negatives BEFORE any reprojection
            if src_nd is not None:
                data[data == src_nd] = np.nan
            data[(data <= 0) | (data > 1e30)] = np.nan
            # Only reproject if not already in WGS-84; use nearest to avoid averaging
            if src_crs and src_crs.to_epsg() != 4326:
                tmp_tf, tmp_w, tmp_h = calculate_default_transform(
                    src_crs, wgs84, data.shape[1], data.shape[0], left=l, bottom=b_b, right=r, top=t)
                tmp = np.full((tmp_h, tmp_w), np.nan, dtype=float)
                reproject(source=data, destination=tmp, src_transform=src_tf, src_crs=src_crs,
                          dst_transform=tmp_tf, dst_crs=wgs84, resampling=Resampling.nearest,
                          src_nodata=np.nan, dst_nodata=np.nan)
                data, src_tf = tmp, tmp_tf
                l, b_b, r, t = rasterio.transform.array_bounds(tmp_h, tmp_w, tmp_tf)
            return data, src_tf, (data.shape[0], data.shape[1]), (l, b_b, r, t)

        data_a, tf_a, shape_a, bounds_a = _load_merc(sc_a, fname_a)
        data_b, tf_b, shape_b, bounds_b = _load_merc(sc_b, fname_b)

        # Align B onto A's grid if they differ (nearest so no averaging)
        if data_b.shape != data_a.shape:
            tmp = np.full(data_a.shape, np.nan, dtype=float)
            reproject(source=data_b, destination=tmp,
                      src_transform=tf_b, src_crs=wgs84,
                      dst_transform=tf_a, dst_crs=wgs84,
                      resampling=Resampling.nearest,
                      src_nodata=np.nan, dst_nodata=np.nan)
            data_b = tmp

        with np.errstate(divide='ignore', invalid='ignore'):
            diff_pct = np.where(
                (data_a > 0) & ~np.isnan(data_a) & ~np.isnan(data_b),
                (data_b - data_a) / data_a * 100.0,
                np.nan)

        l, b_b2, r, t = bounds_a

        # Reproject the diff image to Web Mercator (EPSG:3857) so that it aligns
        # correctly with Leaflet's Mercator base map via ImageOverlay.
        # A plain WGS-84 pixel grid displayed with lat/lon bounds on a Mercator map
        # appears shifted northward for large study areas because Mercator stretches
        # higher latitudes more than lower ones.  Pre-distorting to EPSG:3857 here
        # compensates for that linear-stretch artefact.
        merc3857 = CRS.from_epsg(3857)
        merc_tf, merc_w, merc_h = calculate_default_transform(
            wgs84, merc3857, data_a.shape[1], data_a.shape[0],
            left=l, bottom=b_b2, right=r, top=t)
        diff_merc = np.full((merc_h, merc_w), np.nan, dtype=float)
        reproject(
            source=diff_pct, destination=diff_merc,
            src_transform=tf_a, src_crs=wgs84,
            dst_transform=merc_tf, dst_crs=merc3857,
            resampling=Resampling.nearest,
            src_nodata=np.nan, dst_nodata=np.nan)
        merc_b = rasterio.transform.array_bounds(merc_h, merc_w, merc_tf)
        wgs_b  = transform_bounds(merc3857, wgs84, *merc_b)
        geo_bounds = {'south': float(wgs_b[1]), 'west': float(wgs_b[0]),
                      'north': float(wgs_b[3]), 'east': float(wgs_b[2])}

        # Compute adaptive colour scale from annual total emissions change.
        # sum(B) vs sum(A) gives the overall % shift; floor to nearest 100, min 100.
        import math
        sum_a = float(np.nansum(data_a))
        sum_b = float(np.nansum(data_b))
        if sum_a > 0:
            annual_total_pct = abs((sum_b - sum_a) / sum_a * 100.0)
        else:
            valid_diffs = diff_merc[~np.isnan(diff_merc)]
            annual_total_pct = float(np.max(np.abs(valid_diffs))) if len(valid_diffs) else 0.0
        scale = max(100, int(math.floor(annual_total_pct / 100)) * 100)

        rgba      = _apply_diverg(diff_merc, scale)
        png_bytes = _png_from_rgba(rgba)
        b64       = base64.b64encode(png_bytes).decode()
        return jsonify({'image': b64, 'bounds': geo_bounds, 'scale': scale}), 200

    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def output_csv_data(scenario_id, filename):
    """Return column totals + ranked sources from an output CSV."""
    import csv as csvmod
    try:
        cs, folder = _locate_scenario(scenario_id)
        csv_path = os.path.join(cs['folder_path'], 'output', folder, filename)
        if not os.path.exists(csv_path):
            return jsonify({'error': 'File not found'}), 404

        rows = []
        with open(csv_path, 'r', encoding='utf-8', newline='') as f:
            reader = csvmod.DictReader(f)
            cols = reader.fieldnames or []
            for row in reader:
                rows.append(row)

        value_cols = [c for c in cols if c.lower() != 'iso']
        totals = {}
        for col in value_cols:
            try:
                totals[col] = sum(float(r[col]) for r in rows if r.get(col))
            except (ValueError, KeyError):
                totals[col] = 0.0

        ranked = sorted(
            [{'source': k, 'total': v} for k, v in totals.items() if v > 0],
            key=lambda x: x['total'], reverse=True,
        )

        # per-ISO totals: sum all value columns per row
        iso_totals = {}
        iso_rows = {}
        for row in rows:
            iso_key = str(row.get('iso', row.get('ISO', ''))).strip()
            if not iso_key:
                continue
            try:
                iso_totals[iso_key] = sum(float(row[c]) for c in value_cols if row.get(c))
            except (ValueError, KeyError):
                iso_totals[iso_key] = 0.0
            iso_rows[iso_key] = {}
            for c in value_cols:
                try:
                    iso_rows[iso_key][c] = float(row.get(c) or 0)
                except (ValueError, TypeError):
                    iso_rows[iso_key][c] = 0.0

        return jsonify({'columns': cols, 'ranked': ranked, 'iso_totals': iso_totals, 'iso_rows': iso_rows}), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def raster_diff_tif():
    """Return raw diff % values as a WGS-84 GeoTIFF for client-side rendering.

    Same query params as raster_diff (scA, scB, fileA/fileB).
    Returns float32 GeoTIFF with nodata=-9999; values are (B-A)/A*100 %.
    """
    import io
    import numpy as np

    sc_a    = request.args.get('scA')
    sc_b    = request.args.get('scB')
    fname   = request.args.get('file')
    fname_a = request.args.get('fileA') or fname
    fname_b = request.args.get('fileB') or fname
    if not sc_a or not sc_b or not fname_a or not fname_b:
        return jsonify({'error': 'scA, scB and file (or fileA+fileB) are required'}), 400

    try:
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.warp import reproject, Resampling, calculate_default_transform
        from rasterio.crs import CRS

        wgs84 = CRS.from_epsg(4326)
        out_nd = np.float32(-9999)

        def _load_wgs84(sc_id, tif_fname):
            cs, folder = _locate_scenario(sc_id)
            tif_path = os.path.join(cs['folder_path'], 'output', folder, tif_fname)
            if not os.path.exists(tif_path):
                raise ValueError(f'File not found for scenario {sc_id}: {tif_fname}')
            with rasterio.open(tif_path) as src:
                data    = src.read(1).astype(np.float32)
                src_crs = src.crs or wgs84
                src_tf  = src.transform
                nd      = src.nodata
                l, bb, r, t = src.bounds
            if nd is not None:
                data[data == np.float32(nd)] = np.nan
            data[(data <= 0) | (data > 1e30)] = np.nan
            if src_crs and src_crs.to_epsg() != 4326:
                tmp_tf, tmp_w, tmp_h = calculate_default_transform(
                    src_crs, wgs84, data.shape[1], data.shape[0], left=l, bottom=bb, right=r, top=t)
                tmp = np.full((tmp_h, tmp_w), np.nan, dtype=np.float32)
                reproject(source=data, destination=tmp, src_transform=src_tf, src_crs=src_crs,
                          dst_transform=tmp_tf, dst_crs=wgs84, resampling=Resampling.nearest,
                          src_nodata=np.nan, dst_nodata=np.nan)
                data, src_tf = tmp, tmp_tf
            return data, src_tf

        data_a, tf_a = _load_wgs84(sc_a, fname_a)
        data_b, tf_b = _load_wgs84(sc_b, fname_b)

        if data_b.shape != data_a.shape:
            tmp = np.full(data_a.shape, np.nan, dtype=np.float32)
            reproject(source=data_b, destination=tmp,
                      src_transform=tf_b, src_crs=wgs84,
                      dst_transform=tf_a, dst_crs=wgs84,
                      resampling=Resampling.nearest, src_nodata=np.nan, dst_nodata=np.nan)
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

        from flask import send_file
        resp = send_file(io.BytesIO(data_bytes), mimetype='image/tiff', as_attachment=False,
                         download_name='emissions_diff.tif')
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/scenarios/<scenario_id>/output-files',                       ['GET'], output_files),
        ('/api/scenarios/<scenario_id>/raster-area-stats/<path:filename>',  ['GET'], raster_area_stats),
        ('/api/scenarios/<scenario_id>/output-raster/<path:filename>',      ['GET'], output_raster),
        ('/api/raster-diff',                                                ['GET'], raster_diff),
        ('/api/raster-diff-tif',                                            ['GET'], raster_diff_tif),
        ('/api/scenarios/<scenario_id>/output-csv-data/<path:filename>',    ['GET'], output_csv_data),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
