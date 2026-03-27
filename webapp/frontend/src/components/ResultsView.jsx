import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, GeoJSON as LeafletGeoJSON, ImageOverlay, useMap } from 'react-leaflet';
import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import proj4 from 'proj4';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import { RefreshCw, BarChart2, AlertTriangle, ArrowRight, X, Droplets, Trees, ArrowUpRight, ArrowDownRight, Minus, Maximize2, Minimize2, Download, Printer } from 'lucide-react';

import LivestockEmissionsIcon from '../../assets/icons/livestock_emissions.svg';
import AssesIcon      from '../../assets/icons/asses.svg';
import CattleIcon  from '../../assets/icons/cattle.svg';
import CamelsIcon     from '../../assets/icons/camels.svg';
import GoatsIcon      from '../../assets/icons/goats.svg';
import HorsesIcon     from '../../assets/icons/horses.svg';
import MulesIcon      from '../../assets/icons/mules.svg';
import PigsIcon       from '../../assets/icons/pigs.svg';
import PoultryIcon    from '../../assets/icons/poultry.svg';
import SheepIcon      from '../../assets/icons/sheep.svg';
import BuffaloesIcon      from '../../assets/icons/buffaloes.svg';
import useSettingsStore      from '../store/settingsStore';

// Make proj4 available globally so georaster-layer-for-leaflet can reproject
// TIFs that are not in WGS84 / Web Mercator.
window.proj4 = proj4;

delete L.Icon.Default.prototype._getIconUrl;

// ─── Constants ──────────────────────────────────────────────────────────────────────────────

const LOG_MIN = 0;
const LOG_MAX = 17;
const TILE_URL        = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const TILE_LABELS_URL = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';
const TILE_ATTR       = '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';

const LIVESTOCK_ICONS = {
  asses:     AssesIcon,
  camels:    CamelsIcon,
  cattle:    CattleIcon,
  goats:     GoatsIcon,
  horses:    HorsesIcon,
  mules:     MulesIcon,
  pigs:      PigsIcon,
  poultry:   PoultryIcon,
  sheep:     SheepIcon,
};

const SOURCE_COLORS = {
  flushSewer: '#2E7D32', flushSeptic: '#388E3C', flushPit: '#43A047',
  pitSlab: '#66BB6A', compostingToilet: '#81C784', containerBased: '#A5D6A7',
  pitNoSlab: '#FFDA46', bucketLatrine: '#FFB300', hangingToilet: '#FF8F00',
  flushOpen: '#FF6F00', flushUnknown: '#FDD835', other: '#D4E157',
  openDefecation: '#FFC000',
};

const SANITATION_GROUPS = [
  { id: 'improved',       label: 'Improved',        color: '#2E7D32', darkText: false,
    sources: ['flushSewer','flushSeptic','flushPit','pitSlab','compostingToilet','containerBased'] },
  { id: 'unimproved',     label: 'Unimproved',      color: '#FFDA46', darkText: true,
    sources: ['pitNoSlab','bucketLatrine','hangingToilet','flushOpen','flushUnknown','other'] },
  { id: 'openDefecation', label: 'Open Defecation', color: '#FFC000', darkText: true,
    sources: ['openDefecation'] },
];

// Rainbow colormap matching the user-specified legend, mapped to log₁₀ 0–17.
// white → lavender → purple → blue → cyan → green → yellow-green → yellow → orange → dark red
const YLORRD_STOPS = [
  [0,       [255, 255, 255]],  // white          → 10^0
  [1/17,    [220, 200, 235]],  // lavender        → 10^1
  [3/17,    [148,  83, 189]],  // purple          → 10^3
  [5/17,    [ 31, 119, 180]],  // blue            → 10^5
  [7/17,    [ 23, 190, 207]],  // cyan            → 10^7
  [9/17,    [ 44, 160,  44]],  // green           → 10^9
  [11/17,   [188, 189,  34]],  // yellow-green    → 10^11
  [13/17,   [255, 215,   0]],  // yellow          → 10^13
  [15/17,   [255, 100,   0]],  // orange          → 10^15
  [1.0,     [140,   0,   0]],  // dark red        → 10^17+
];

// ─── Color helpers ──────────────────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function colorFromNorm(norm) {
  const n = Math.max(0, Math.min(1, norm));
  for (let i = 0; i < YLORRD_STOPS.length - 1; i++) {
    const [t0, c0] = YLORRD_STOPS[i];
    const [t1, c1] = YLORRD_STOPS[i + 1];
    if (n >= t0 && n <= t1) {
      const t = (n - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))})`;
    }
  }
  return '#800026';
}

function emissionColor(value, vmin = LOG_MIN, vmax = LOG_MAX) {
  if (!value || value <= 0) return '#d1d5db';
  const norm = Math.max(0, Math.min(1, (Math.log10(value) - vmin) / (vmax - vmin)));
  return colorFromNorm(norm);
}

/** Snap to the nearest YLORRD stop instead of interpolating — gives distinct categorical bands. */
function emissionColorQuantized(value, vmin = LOG_MIN, vmax = LOG_MAX) {
  if (!value || value <= 0) return null;
  const norm = Math.max(0, Math.min(1, (Math.log10(value) - vmin) / (vmax - vmin)));
  let best = 0, bestDist = 1;
  for (let i = 0; i < YLORRD_STOPS.length; i++) {
    const d = Math.abs(norm - YLORRD_STOPS[i][0]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  const [r, g, b] = YLORRD_STOPS[best][1];
  return `rgb(${r},${g},${b})`;
}

/** Diverging colour: green=decrease(negative%), red=increase(positive%). Saturates at +-100%. */
function diffColor(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '#d1d5db';
  if (Math.abs(pct) < 2) return '#f3f4f6';
  const t = Math.min(1, Math.abs(pct) / 100);
  if (pct > 0) {
    return `rgb(${Math.round(lerp(254,153,t))},${Math.round(lerp(202,27,t))},${Math.round(lerp(202,27,t))})`;
  } else {
    return `rgb(${Math.round(lerp(187,20,t))},${Math.round(lerp(247,83,t))},${Math.round(lerp(208,45,t))})`;
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────────────────────────

function formatSourceName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function formatScientific(val) {
  if (!val || val === 0) return '0';
  let exp = Math.floor(Math.log10(Math.abs(val)));
  let coef = Math.round((val / Math.pow(10, exp)) * 10) / 10;
  if (coef >= 10) { coef = 1.0; exp += 1; }
  const supMap = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻'};
  return `${coef.toFixed(1)}×10${String(exp).split('').map(c => supMap[c] || c).join('')}`;
}

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// ─── Legend ────────────────────────────────────────────────────────────────────────────────────

// Generate gradient CSS directly from YLORRD_STOPS so it is always identical to the map.
const LEGEND_GRADIENT = 'linear-gradient(to right,' +
  YLORRD_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(2)}%`).join(',') + ')';

function Legend() {
  const { heatmapView: smoothing, fixedColorScale, dynamicLogMax } = useSettingsStore();
  const effectiveLogMax = fixedColorScale ? LOG_MAX : (dynamicLogMax ?? LOG_MAX);

  if (!smoothing) {
    // Discrete swatches — one per stop (skip the white "0" stop).
    // Only show stops whose log₁₀ value falls within the effective range.
    const swatches = YLORRD_STOPS.slice(1)
      .filter(([t]) => Math.round(t * LOG_MAX) <= Math.ceil(effectiveLogMax))
      .map(([t, [r, g, b]]) => ({
        color: `rgb(${r},${g},${b})`,
        label: `${String(Math.round(t * LOG_MAX))}`,
      }));
    return (
      <div className="mt-2">
        <div className="flex items-center flex-wrap">
          <div className="flex flex-col items-center">
            <div className="h-3 w-[70px] border b-gray-100" style={{ background: '#fff' }}/>
            <span className="text-sm text-gray-400 mt-0.5 font-inter leading-none">NA</span>
          </div>
          {swatches.map(({ color, label }) => (
            <div key={label} className="flex flex-col items-center" style={{ minWidth: 24 }}>
              <div className="h-3 w-full" style={{ background: color, minWidth: 80 }}/>
              <span className="text-sm text-gray-500 mt-0.5 font-inter leading-none">{label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">Log₁₀ scale · viral particles / grid cell / year</p>
      </div>
    );
  }

  // Continuous gradient: same white→dark-red shape, ticks scaled to effectiveLogMax.
  const legendTicks = [];
  for (let v = 1; v <= Math.floor(effectiveLogMax); v += 2) legendTicks.push(v);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        {/* NA swatch */}
        <div className="flex flex-col items-center flex-shrink-0">
          <div className="h-3 w-20" style={{ background: '#fff' }}/>
          <span className="text-sm text-gray-400 mt-0.5 font-inter leading-none">NA</span>
        </div>
        {/* Gradient bar with tick labels positioned under each stop */}
        <div className="flex-1">
          <div className="h-3 rounded-sm w-full" style={{ background: LEGEND_GRADIENT }}/>
          <div className="relative" style={{ height: 14 }}>
            {legendTicks.map(v => (
              <span
                key={v}
                className="absolute text-sm text-gray-500 font-inter leading-none -translate-x-1/2"
                style={{ left: `${(v / effectiveLogMax) * 100}%`, top: 2 }}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
        {/* Open-ended indicator only shown when fixed scale */}
        {fixedColorScale && <span className="text-gray-400 text-xs font-bold flex-shrink-0">+</span>}
      </div>
      <p className="text-xs text-gray-400 mt-1">Log₁₀ scale · viral particles / grid cell / year</p>
    </div>
  );
}

function DiffLegend() {
  return (
    <div className="mt-2">
      <div className="h-3 rounded" style={{ background: 'linear-gradient(to right,rgb(20,83,45),rgb(187,247,208),#f3f4f6,rgb(254,202,202),rgb(153,27,27))' }} />
      <div className="flex justify-between mt-0.5">
        {['-100%','-50%','0%','+50%','+100%'].map(v => <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>)}
      </div>
      <p className="text-xs text-gray-400 mt-1">% change (green = decrease · red = increase)</p>
    </div>
  );
}

// ─── Map helpers ────────────────────────────────────────────────────────────────────────────────────

function FitBounds({ geojson }) {
  const map = useMap();
  useEffect(() => {
    if (!geojson?.features?.length) return;
    try {
      const bounds = L.geoJSON(geojson).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    } catch (_) {}
  }, [geojson, map]);
  return null;
}

function CreateBlendPane() {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane('polygonPane')) {
      const p = map.createPane('polygonPane'); p.style.zIndex = '450';
    }
    if (!map.getPane('labelsPane')) {
      const lp = map.createPane('labelsPane'); lp.style.zIndex = '600'; lp.style.pointerEvents = 'none';
    }
  }, [map]);
  return null;
}

// ─── Area dialog ─────────────────────────────────────────────────────────────────────────────────

function AreaDialog({ area, waterStats, landStats, onClose }) {
  if (!area) return null;
  const { iso, name } = area;
  const key = String(iso);
  const ws = waterStats?.[key];
  const ls = landStats?.[key];

  const renderStats = (stats, color) => {
    if (!stats) return <p className="text-xs text-gray-400 italic">No raster data</p>;
    const rows = [
      { label: 'Min',   val: stats.min   },
      { label: 'Max',   val: stats.max   },
      { label: 'Mean',  val: stats.mean  },
      { label: 'Total', val: stats.total }
    ];
    return (
      <table className="w-full text-xs"><tbody>
        {rows.map(({ label, val, raw }) => (
          <tr key={label} className="border-b border-gray-100 last:border-0">
            <td className="py-1 pr-2 text-gray-500 font-medium">{label}</td>
            <td className="py-1 text-right font-inter tabular-nums font-semibold"
                style={{ color }}>
              {raw ? val?.toLocaleString() : formatScientific(val)}
            </td>
          </tr>
        ))}
      </tbody></table>
    );
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
          <div>
            <p className="font-semibold text-gray-900">{name}</p>
            <p className="text-xs text-gray-400">viral particles / grid cell / year</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-200"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 grid grid-cols-2 gap-5">
          <div>
            <p className="text-xs font-semibold text-wpBlue mb-2 flex items-center gap-1"><Droplets size={12} /> Surface Water</p>
            {renderStats(ws, '#0B4159')}
          </div>
          <div>
            <p className="text-xs font-semibold text-wpGreen mb-2 flex items-center gap-1"><Trees size={12} /> Land</p>
            {renderStats(ls, '#2E7D32')}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── GeoTiffLayer: renders a GeoTIFF via georaster-layer-for-leaflet ─────────────────────────────
// Uses proj4 for CRS reprojection so TIFs in any projection (e.g. UTM) are
// placed correctly on the Web-Mercator base map.
// Smoothing (heatmapView setting) controls colour mapping only — rendering is always crisp:
//   true  (default) → emissionColor()          – continuous YlOrRd gradient per pixel value
//   false            → emissionColorQuantized() – value snapped to nearest discrete log₁₀ stop

function GeoTiffLayer({ url }) {
  const map = useMap();
  const { heatmapView: smoothing, fixedColorScale, setDynamicLogMax } = useSettingsStore();

  useEffect(() => {
    if (!url) return;
    let layer = null;
    let cancelled = false;

    (async () => {
      try {
        const ab = await fetch(url).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;

        const nd = gr.noDataValue;

        // Compute the effective log₁₀ max for this raster.
        // fixedColorScale=true  → always use the global LOG_MAX (17) for cross-dataset comparability.
        // fixedColorScale=false → derive from the raster's own maximum so the full colour range is used.
        let logMax = LOG_MAX;
        if (!fixedColorScale && gr.maxs?.[0] > 0) {
          logMax = Math.log10(gr.maxs[0]);
        }
        // Publish the effective max to the store so <Legend> can display matching tick marks.
        setDynamicLogMax(fixedColorScale ? null : logMax);

        // Always use full-resolution 256px tiles with pixelated rendering.
        // The smoothing flag only switches between the continuous and quantized colour functions.
        const tileResolution = 256;

        layer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.85,
          resolution: tileResolution,
          caching: false,  // prototype-level cache persists across instances; always re-render with current colorFn
          pixelValuesToColorFn: (values) => {
            const v = values[0];
            if (v == null || !isFinite(v) || v <= 0 || v === nd) return null;
            // When smoothing is off, snap to the nearest stop for distinct categorical colours.
            return smoothing ? emissionColor(v, LOG_MIN, logMax) : emissionColorQuantized(v, LOG_MIN, logMax);
          },
        });

        layer.on('tileload', (e) => {
          if (!e.tile) return;
          // Always crisp — cells should not blur into each other regardless of colour mode.
          e.tile.style.imageRendering = 'pixelated';
        });

        map.addLayer(layer);
      } catch (e) {
        console.error('GeoTIFF render error:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (layer) map.removeLayer(layer);
    };
  }, [url, map, smoothing, fixedColorScale]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ─── MapExportControls: fullscreen, PNG download, print ──────────────────────────────────────────
// Rendered as absolute-positioned overlay inside the MapContainer so it has
// access to the Leaflet map instance via useMap().

function MapExportControls({ title }) {
  const map = useMap();
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    const handler = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const handleFullscreen = () => {
    const c = map.getContainer();
    if (!document.fullscreenElement) {
      c.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const handleDownloadPng = async () => {
    const container = map.getContainer();
    const size = map.getSize();
    const offscreen = document.createElement('canvas');
    offscreen.width = size.x;
    offscreen.height = size.y;
    const ctx = offscreen.getContext('2d');
    const mapRect = container.getBoundingClientRect();
    ctx.fillStyle = '#f2f2f0';
    ctx.fillRect(0, 0, size.x, size.y);
    // Re-fetch base tiles with crossOrigin='anonymous' to avoid canvas taint.
    // OSM and most tile providers support CORS, so this works in practice.
    const tileImgs = Array.from(container.querySelectorAll('.leaflet-tile-pane img'));
    await Promise.all(tileImgs.map(img => new Promise(resolve => {
      const fresh = new Image();
      fresh.crossOrigin = 'anonymous';
      fresh.onload = () => {
        try {
          const r = img.getBoundingClientRect();
          ctx.drawImage(fresh, r.left - mapRect.left, r.top - mapRect.top, r.width, r.height);
        } catch (_) {}
        resolve();
      };
      fresh.onerror = resolve;
      // Append cache-bust param so the browser re-fetches with the CORS header
      fresh.src = img.src.includes('?') ? img.src + '&_cb=1' : img.src + '?_cb=1';
    })));
    // GeoRaster canvas tiles — same-origin, no taint risk
    container.querySelectorAll('canvas').forEach(c => {
      if (!c.width || !c.height) return;
      try { const r = c.getBoundingClientRect(); ctx.drawImage(c, r.left - mapRect.left, r.top - mapRect.top, r.width, r.height); } catch (_) {}
    });
    const a = document.createElement('a');
    a.download = `${title ? title.replace(/\s+/g, '_').toLowerCase() : 'emissions_map'}.png`;
    a.href = offscreen.toDataURL('image/png');
    a.click();
  };

  const handlePrint = () => window.print();

  const btnCls = 'w-7 h-7 flex items-center justify-center rounded bg-white shadow border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors';

  return (
    <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button className={btnCls} onClick={handleFullscreen} title={isFs ? 'Exit fullscreen' : 'Fullscreen'}>
        {isFs ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}
      </button>
      <button className={btnCls} onClick={handleDownloadPng} title="Download PNG">
        <Download size={13}/>
      </button>
      <button className={btnCls} onClick={handlePrint} title="Print">
        <Printer size={13}/>
      </button>
    </div>
  );
}

// ─── EmissionMapPanel ─────────────────────────────────────────────────────────────────────────────

function EmissionMapPanel({
  title, icon: Icon,
  geojson, primaryIsoTotals, secondaryIsoTotals,
  rasterFile, secondaryRasterFile, rasterVersion,
  scenarioId, secondaryScenarioId,
  isComparison,
  onAreaClick, loading,
  emissionType, onChangeEmissionType,
  areaNames, selectedAreas, onAreaSelect,
}) {
  const primRef = useRef(primaryIsoTotals);
  const compRef = useRef(isComparison);
  const secRef  = useRef(secondaryIsoTotals);
  const selRef  = useRef(selectedAreas);
  useEffect(() => { primRef.current = primaryIsoTotals; }, [primaryIsoTotals]);
  useEffect(() => { compRef.current = isComparison; secRef.current = secondaryIsoTotals; }, [isComparison, secondaryIsoTotals]);
  useEffect(() => { selRef.current = selectedAreas; }, [selectedAreas]);

  const [diffData, setDiffData] = useState(null);
  // Only fetch diff image when in comparison mode; single raster is handled by GeoTiffLayer.
  // rasterVersion changes on every re-run so the diff is always recomputed fresh.
  useEffect(() => {
    if (!isComparison || !rasterFile || !scenarioId || !secondaryScenarioId) { setDiffData(null); return; }
    const fileB = secondaryRasterFile || rasterFile;
    const bust  = rasterVersion || Date.now();
    axios.get(`/api/raster-diff?scA=${scenarioId}&scB=${secondaryScenarioId}&fileA=${encodeURIComponent(rasterFile)}&fileB=${encodeURIComponent(fileB)}&_v=${bust}`, { params: {} })
      .then(({ data }) => setDiffData(data)).catch(() => setDiffData(null));
  }, [scenarioId, secondaryScenarioId, rasterFile, secondaryRasterFile, isComparison, rasterVersion]);
  // Append version timestamp so browsers don't serve a stale cached TIF after a re-run
  const singleRasterUrl = (!isComparison && scenarioId && rasterFile)
    ? `/api/scenarios/${scenarioId}/output-raster/${rasterFile}?_v=${rasterVersion || 0}` : null;

  const getStyle = useCallback((feature) => {
    const iso = String(feature.properties.iso);
    const isSel = !selRef.current || selRef.current.has(iso);
    return { fillColor: 'transparent', fillOpacity: 0,
             color: '#1e293b', weight: 0.6, opacity: isSel ? 0.5 : 0.15, pane: 'polygonPane' };
  }, []);

  const onAreaClickRef = useRef(onAreaClick);
  useEffect(() => { onAreaClickRef.current = onAreaClick; }, [onAreaClick]);

  const onEachFeature = useCallback((feature, layer) => {
    const iso = feature.properties.iso;
    const isoKey = String(iso);
    const name = feature.properties.NAME_3 || feature.properties.NAME_2 || feature.properties.NAME_1 || feature.properties.NAME_0 || feature.properties.subarea || areaNames?.[isoKey] || `Area ${iso}`;
    layer.on('mouseover', () => {
      const val = primRef.current?.[isoKey];
      const secVal = secRef.current?.[isoKey];
      const pct = (compRef.current && val > 0 && secVal != null) ? ((secVal - val) / val) * 100 : null;
      const tip = (pct !== null)
        ? `<strong>${name}</strong><br/>${formatScientific(val||0)} \u2192 ${formatScientific(secVal||0)}<br/>${pct >= 0 ? '+' : ''}${pct?.toFixed(1)}%`
        : `<strong>${name}</strong><br/>${formatScientific(val||0)} vp`;
      layer.bindTooltip(tip, { sticky: true });
      layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, weight: 1.5, color: '#0f172a', opacity: 0.9, pane: 'polygonPane' });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      const isSel = !selRef.current || selRef.current.has(isoKey);
      layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, weight: 0.6, color: '#1e293b', opacity: isSel ? 0.5 : 0.15, pane: 'polygonPane' });
    });
    layer.on('click', () => onAreaClickRef.current?.({ iso, name }));
  }, [areaNames]);

  const geoKey = `${scenarioId}-${secondaryScenarioId}-${Object.keys(primaryIsoTotals || {}).length}-${isComparison}-${selectedAreas?.size ?? 'all'}`;

  const rankedAreas = useMemo(() => {
    const base = primaryIsoTotals || {};
    return Object.entries(base)
      .sort(([,a],[,b]) => b - a)
      .slice(0, 20)
      .map(([iso, val]) => ({
        iso, val,
        name: areaNames?.[iso] || `Area ${iso}`,
        secVal: secondaryIsoTotals?.[iso] ?? null,
      }));
  }, [primaryIsoTotals, secondaryIsoTotals, areaNames]);

  const maxVal = useMemo(() => {
    const primMax = rankedAreas[0]?.val || 1;
    if (!isComparison || !secondaryIsoTotals) return primMax;
    const secVals = Object.values(secondaryIsoTotals);
    const secMax = secVals.length > 0 ? Math.max(...secVals) : 0;
    return Math.max(primMax, isFinite(secMax) ? secMax : 0);
  }, [rankedAreas, secondaryIsoTotals, isComparison]);

  const priTotal = useMemo(() => {
    if (!primaryIsoTotals) return 0;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(primaryIsoTotals);
    return keys.reduce((s, k) => s + (primaryIsoTotals[k] || 0), 0);
  }, [primaryIsoTotals, selectedAreas]);

  const secTotal = useMemo(() => {
    if (!secondaryIsoTotals) return 0;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(secondaryIsoTotals);
    return keys.reduce((s, k) => s + (secondaryIsoTotals[k] || 0), 0);
  }, [secondaryIsoTotals, selectedAreas]);

  const totalDiffPct = (isComparison && priTotal > 0) ? ((secTotal - priTotal) / priTotal) * 100 : null;
  const totalDiffAbs = isComparison ? secTotal - priTotal : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold text-wpBlue uppercase flex items-center gap-2">
          {Icon && <Icon size={15} className="text-wpBlue" />}{title}
          {isComparison && <span className="ml-1 text-xs font-normal text-wpTeal bg-wpTeal/10 px-1.5 py-0.5 rounded">comparison</span>}
        </h3>
        {onChangeEmissionType && (
          <div className="flex rounded-xl overflow-hidden border border-gray-200 text-sm flex-shrink-0">
            <button onClick={() => onChangeEmissionType('water')}
              className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='water' ? 'bg-wpBlue text-white' : 'text-wpBlue hover:bg-gray-100'}`}>
              <Droplets size={13}/> Surface Water
            </button>
            <button onClick={() => onChangeEmissionType('land')}
              className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='land' ? 'bg-wpGreen text-white' : 'text-wpBlue hover:bg-gray-100'}`}>
              <Trees size={13}/> Land
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-72">
          <RefreshCw size={20} className="animate-spin text-gray-400 mr-2"/>
          <span className="text-sm text-gray-400">Loading…</span>
        </div>
      ) : geojson ? (
        <div className="flex gap-3" style={{ height: 480 }}>
          <div className="flex flex-col min-w-0" style={{ flex: 2 }}>
            <div className="rounded overflow-hidden border border-gray-100 flex-1">
              <MapContainer center={[0,0]} zoom={2} style={{ height:'100%', width:'100%' }} scrollWheelZoom>
                <TileLayer url={TILE_URL} attribution={TILE_ATTR}/>
                <CreateBlendPane/>
                {/* Single raster: GeoTIFF rendered via georaster-layer-for-leaflet with proj4 CRS support */}
                {singleRasterUrl && <GeoTiffLayer url={singleRasterUrl} />}
                {/* Diff raster: server-computed relative-change PNG */}
                {isComparison && diffData?.image && diffData.bounds && (
                  <ImageOverlay
                    url={`data:image/png;base64,${diffData.image}`}
                    bounds={[[diffData.bounds.south,diffData.bounds.west],[diffData.bounds.north,diffData.bounds.east]]}
                    opacity={0.85} zIndex={400}
                  />
                )}
                <LeafletGeoJSON key={geoKey} data={geojson} style={getStyle} onEachFeature={onEachFeature}/>
                <TileLayer url={TILE_LABELS_URL} pane="labelsPane"/>
                <FitBounds geojson={geojson}/>
                <MapExportControls title={title}/>
              </MapContainer>
            </div>
            {isComparison ? <DiffLegend/> : <Legend/>}
          </div>

          <div className="flex flex-col border-l border-gray-100 pl-3 overflow-hidden" style={{ flex: 1 }}>
            {/* Total emissions summary */}
            <div className="flex-shrink-0 mb-3 pb-2 border-b border-gray-100">
              <p className="text-lg text-wpBlue font-outfit font-semibold text-gray-500 uppercase tracking-wide mb-1">Total emissions</p>
              {isComparison && totalDiffPct !== null ? (
                <div>
                  <div className="flex items-baseline gap-1.5 mb-0.5">
                    <span className="text-4xl font-outfit tabular-nums text-gray-400">{formatScientific(priTotal)}</span>
                    <span className="text-4xl font-outfit"><ArrowRight size={36}/></span>
                    <span className="text-4xl font-outfit tabular-nums font-bold text-wpBlue">{formatScientific(secTotal)}</span>
                  </div>
                  <p className={`flex items-center gap-0.5 text-xl font-outfit font-semibold ${totalDiffPct > 0 ? 'text-red-600' : totalDiffPct < 0 ? 'text-green-700' : 'text-gray-500'}`}>
                    {totalDiffPct > 1 ? <ArrowUpRight size={24}/> : totalDiffPct < -1 ? <ArrowDownRight size={24}/> : <Minus size={13}/>}
                    {fmtPct(totalDiffPct)}
                    
                  </p>
                </div>
              ) : (
                <p className="text-5xl font-bold font-outfit tabular-nums text-wpBlue">{formatScientific(priTotal)}</p>
              )}
              <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">Combined viral particle emissions across all areas, sanitation technologies, and emission pathways (viral particles / year).</p>
            </div>

            {/* Emissions by area */}
            <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1 flex-shrink-0">
              Emissions by area
            </p>
            <div className="overflow-y-auto flex-1 space-y-0.5 pr-1">
              {rankedAreas.map(({ iso, name, val, secVal }) => {
                const isSel = !selectedAreas || selectedAreas.has(iso);
                const diff = (isComparison && val > 0 && secVal != null) ? ((secVal - val) / val) * 100 : null;
                return (
                  <button key={iso} onClick={() => onAreaSelect?.(iso)}
                    className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-left hover:bg-gray-50 transition-colors ${!isSel ? 'opacity-35' : ''}`}>
                    <span className="text-xs text-gray-600 truncate flex-shrink-0" style={{ width: 72 }} title={name}>{name}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full mx-1 relative">
                      <div className="absolute top-0 h-2 rounded-full bg-wpBlue/20"
                        style={{ width:`${Math.min(94,(Math.max(val, (isComparison && secVal != null) ? secVal : 0)/maxVal)*100).toFixed(1)}%`, left:0 }}/>
                      <div className="absolute w-2.5 h-2.5 rounded-full bg-wpBlue border-2 border-white shadow-sm"
                        style={{ left:`${Math.min(94,(val/maxVal)*100).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                      {isComparison && secVal != null && (
                        <div className="absolute w-2.5 h-2.5 rounded-full bg-wpCypress border-2 border-white shadow-sm"
                          style={{ left:`${Math.min(94,(secVal/maxVal)*100).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                      )}
                    </div>
                    {isComparison && diff !== null ? (
                      <span className={`text-xs font-inter flex-shrink-0 w-10 text-right ${diff>0?'text-red-600':'text-green-600'}`}>
                        {diff>=0?'+':''}{diff.toFixed(0)}%
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 font-inter flex-shrink-0 w-10 text-right">{formatScientific(val)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-gray-400 p-4 bg-gray-50 rounded">
          <AlertTriangle size={14}/> No geodata available for this scenario.
        </div>
      )}
    </div>
  );
}

// ─── Source → sanitation group color helper ────────────────────────────────────────────────────────

function groupColorForSource(src) {
  const g = SANITATION_GROUPS.find(grp => grp.sources.includes(src));
  return g?.color || '#6B7280';
}

function StatsSection({ primaryData, secondaryData, isComparison, selectedAreas, emissionType }) {
  // Use human_sources CSV data for sanitation group breakdown and top-tech
  const priSrcData = emissionType === 'water' ? primaryData?.waterSources  : primaryData?.landSources;
  const secSrcData = isComparison ? (emissionType === 'water' ? secondaryData?.waterSources : secondaryData?.landSources) : null;

  const computeSourceTotals = useCallback((isoRows) => {
    if (!isoRows) return {};
    const out = {};
    const relevant = selectedAreas ? [...selectedAreas] : Object.keys(isoRows);
    relevant.forEach(iso => {
      if (!isoRows[iso]) return;
      Object.entries(isoRows[iso]).forEach(([src, v]) => { out[src] = (out[src] || 0) + v; });
    });
    return out;
  }, [selectedAreas]);

  const priSrc = useMemo(() => computeSourceTotals(priSrcData?.iso_rows), [priSrcData, selectedAreas]);
  const secSrc = useMemo(() => computeSourceTotals(secSrcData?.iso_rows), [secSrcData, selectedAreas]);

  // ── Livestock data ────────────────────────────────────────────────────────────
  const priLsData = emissionType === 'water' ? primaryData?.livestockWaterSources : primaryData?.livestockLandSources;
  const secLsData = isComparison ? (emissionType === 'water' ? secondaryData?.livestockWaterSources : secondaryData?.livestockLandSources) : null;

  const computeLsAnimalTotals = useCallback((isoRows) => {
    if (!isoRows) return {};
    const out = {};
    const relevant = selectedAreas ? [...selectedAreas] : Object.keys(isoRows);
    relevant.forEach(iso => {
      if (!isoRows[iso]) return;
      Object.entries(isoRows[iso]).forEach(([animal, v]) => { out[animal] = (out[animal] || 0) + v; });
    });
    return out;
  }, [selectedAreas]);

  const priLsAnimalTotals = useMemo(() => computeLsAnimalTotals(priLsData?.iso_rows), [priLsData, selectedAreas]);
  const secLsAnimalTotals = useMemo(() => computeLsAnimalTotals(secLsData?.iso_rows), [secLsData, selectedAreas]);

  // ── Land + WWTP totals from surface_water_emissions CSV (water mode only) ─────────────────────
  const computeColTotal = useCallback((isoRows, col) => {
    if (!isoRows) return 0;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(isoRows);
    return keys.reduce((sum, iso) => sum + (isoRows[iso]?.[col] || 0), 0);
  }, [selectedAreas]);

  const priWaterEmIsoRows = primaryData?.waterEmissions?.iso_rows;
  const secWaterEmIsoRows = secondaryData?.waterEmissions?.iso_rows;
  const priLand = useMemo(() => computeColTotal(priWaterEmIsoRows, 'land'), [priWaterEmIsoRows, selectedAreas]);
  const secLand = useMemo(() => computeColTotal(secWaterEmIsoRows, 'land'), [secWaterEmIsoRows, selectedAreas]);
  const priWwtp = useMemo(() => computeColTotal(priWaterEmIsoRows, 'wwtp'), [priWaterEmIsoRows, selectedAreas]);
  const secWwtp = useMemo(() => computeColTotal(secWaterEmIsoRows, 'wwtp'), [secWaterEmIsoRows, selectedAreas]);

  // All non-zero sources sorted by descending value – computed as memos before any early returns
  const priSrcEntries = useMemo(
    () => Object.entries(priSrc).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a),
    [priSrc]
  );
  const humTotal    = useMemo(() => priSrcEntries.reduce((s, [, v]) => s + v, 0), [priSrcEntries]);
  const secHumTotal = useMemo(
    () => isComparison ? Object.values(secSrc).reduce((s, v) => s + v, 0) : 0,
    [secSrc, isComparison]
  );

  // Grand total: sum ALL value columns (humans + land + wwtp + …) across selected areas.
  // iso_totals from the backend already holds per-area row-sum of all value columns.
  const priEmIsoTotals = emissionType === 'water'
    ? primaryData?.waterEmissions?.iso_totals
    : primaryData?.landEmissions?.iso_totals;
  const secEmIsoTotals = emissionType === 'water'
    ? secondaryData?.waterEmissions?.iso_totals
    : secondaryData?.landEmissions?.iso_totals;

  const priGrandTotal = useMemo(() => {
    if (!priEmIsoTotals) return humTotal;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(priEmIsoTotals);
    return keys.reduce((sum, iso) => sum + (priEmIsoTotals[iso] || 0), 0);
  }, [priEmIsoTotals, selectedAreas, humTotal]);

  const secGrandTotal = useMemo(() => {
    if (!isComparison || !secEmIsoTotals) return secHumTotal;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(secEmIsoTotals);
    return keys.reduce((sum, iso) => sum + (secEmIsoTotals[iso] || 0), 0);
  }, [secEmIsoTotals, selectedAreas, isComparison, secHumTotal]);

  const lsAnimalEntries = useMemo(() =>
    Object.entries(priLsAnimalTotals).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a),
    [priLsAnimalTotals]
  );
  const priLsTotal = useMemo(() => lsAnimalEntries.reduce((s, [, v]) => s + v, 0), [lsAnimalEntries]);
  const secLsTotal = useMemo(() => Object.values(secLsAnimalTotals).reduce((s, v) => s + v, 0), [secLsAnimalTotals]);
  const hasLivestock = lsAnimalEntries.length > 0;

  if (!priSrcData) return null;

  const topEntry = priSrcEntries[0] || null;

  // ── Shared render fragments ────────────────────────────────────────────────


  const toiletCategoryCol = (
    <div className="flex-shrink-0 w-40">
      <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1.5">By Toilet Category</p>
      <div className="space-y-2">
        {SANITATION_GROUPS.map(g => {
          const pv = g.sources.reduce((s, src) => s + (priSrc[src] || 0), 0);
          const sv = g.sources.reduce((s, src) => s + (secSrc[src] || 0), 0);
          if (pv === 0 && sv === 0) return null;
          const pct = humTotal > 0 ? (pv / humTotal) * 100 : 0;
          const secPct = secHumTotal > 0 ? (sv / secHumTotal) * 100 : 0;
          return (
            <div key={g.id}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: g.color }} />
                <span className="text-sm text-gray-600 truncate">{g.label}</span>
                <span className="ml-auto text-sm text-gray-500 tabular-nums">{pct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct.toFixed(1)}%`, backgroundColor: g.color }} />
              </div>
              {isComparison && (
                <div className="h-1 bg-gray-50 rounded-full overflow-hidden mt-0.5">
                  <div className="h-full rounded-full opacity-60" style={{ width: `${secPct.toFixed(1)}%`, backgroundColor: g.color }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );

  const contribTechCol = (
    <div className="flex-1 min-w-0">
      {priSrcEntries.length > 0 ? (
        <div>
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Contributing technologies</p>
          {(() => {
            const overallMaxV = topEntry
              ? (isComparison
                  ? Math.max(topEntry[1], ...priSrcEntries.map(([s]) => secSrc[s] || 0), 1)
                  : topEntry[1])
              : 1;
            return (
              <div className="space-y-1">
                {priSrcEntries.map(([src, val]) => {
                  const secVal = secSrc[src] || 0;
                  const diffPct = isComparison && val > 0 ? ((secVal - val) / val) * 100 : null;
                  return (
                    <div key={src} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: groupColorForSource(src) }}/>
                      <span className="text-xs text-gray-500 flex-shrink-0" style={{ width: 110 }}>{formatSourceName(src)}</span>
                      <div className="flex-1 relative h-2 bg-gray-100 rounded-full">
                        <div className="absolute top-0 h-2 rounded-full bg-wpBlue/20"
                          style={{ width:`${Math.min(94,(Math.max(val, isComparison ? secVal : 0)/overallMaxV)*100).toFixed(1)}%`, left:0 }}/>
                        <div className="absolute w-2.5 h-2.5 rounded-full bg-wpBlue border-2 border-white shadow-sm"
                          style={{ left:`${Math.min(94,(val/overallMaxV)*100).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                        {isComparison && (
                          <div className="absolute w-2.5 h-2.5 rounded-full bg-wpCypress border-2 border-white shadow-sm"
                            style={{ left:`${Math.min(94,(secVal/overallMaxV)*100).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                        )}
                      </div>
                      {diffPct !== null ? (
                        <span className={`text-xs font-inter flex-shrink-0 w-12 text-right ${diffPct>0?'text-red-600':'text-green-600'}`}>
                          {diffPct>=0?'+':''}{diffPct.toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500 font-inter flex-shrink-0 w-12 text-right">
                          {formatScientific(val)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : (
        <p className="text-xs text-gray-400 italic">No source data available</p>
      )}
    </div>
  );

  // ── Livestock column ───────────────────────────────────────────────────────

  const lsMaxVal = lsAnimalEntries[0]?.[1] || 1;
  const lsDiffPct = isComparison && priLsTotal > 0 ? ((secLsTotal - priLsTotal) / priLsTotal) * 100 : null;

  const livestockCol = hasLivestock && (
    <div className="space-y-4">
      <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Livestock</p>
      <p className="text-xs text-gray-400 -mt-2">Emissions from livestock manure deposited on land and transported to water, broken down by animal species.</p>
      <div className="flex gap-4 min-h-0">
        <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
        {/* Per-animal breakdown */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">By Animal</p>
          <div className="space-y-2">
            {lsAnimalEntries.map(([animal, val]) => {
              const icon = LIVESTOCK_ICONS[animal] || LivestockEmissionsIcon;
              const secVal = secLsAnimalTotals[animal] || 0;
              const barPct = (val / lsMaxVal) * 100;
              const secBarPct = (isComparison && secVal > 0) ? (secVal / Math.max(lsMaxVal, secVal)) * 100 : 0;
              const diffPct = isComparison && val > 0 ? ((secVal - val) / val) * 100 : null;
              return (
                <div key={animal}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <img src={icon} alt={animal} className="w-4 h-4 flex-shrink-0"/>
                    <span className="text-xs text-gray-600 flex-shrink-0 capitalize" style={{ width: 64 }}>{animal}</span>
                    <div className="flex-1 relative h-2 bg-gray-100 rounded-full">
                      <div className="absolute top-0 h-2 rounded-full bg-amber-500/20"
                        style={{ width:`${Math.min(94, Math.max(barPct, isComparison ? secBarPct : 0)).toFixed(1)}%`, left:0 }}/>
                      <div className="absolute w-2.5 h-2.5 rounded-full bg-amber-600 border-2 border-white shadow-sm"
                        style={{ left:`${Math.min(94, barPct).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                      {isComparison && (
                        <div className="absolute w-2.5 h-2.5 rounded-full bg-wpCypress border-2 border-white shadow-sm"
                          style={{ left:`${Math.min(94, secBarPct).toFixed(1)}%`, top:'50%', transform:'translate(-50%,-50%)' }}/>
                      )}
                    </div>
                    {diffPct !== null ? (
                      <span className={`text-xs font-inter flex-shrink-0 w-12 text-right ${diffPct > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {diffPct >= 0 ? '+' : ''}{diffPct.toFixed(0)}%
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 font-inter flex-shrink-0 w-12 text-right">
                        {formatScientific(val)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  // ── Layout ─────────────────────────────────────────────────────────────────

  if (hasLivestock) {
    return (
      <div className="grid grid-cols-2 gap-0 pt-6 divide-x divide-gray-100">
        {/* Left column: Humans + Land + WWTP */}
        <div className="space-y-4 pr-6">
          {emissionType === 'water' && (
            <>
              <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Humans</p>
              <p className="text-xs text-gray-400 -mt-2">Emissions originating from human sanitation systems, broken down by technology and toilet category.</p>
            </>
          )}
          <div className="flex gap-4 min-h-0">
            <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
            {toiletCategoryCol}
            <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
            {contribTechCol}
          </div>
        </div>
        {/* Right column: Livestock */}
        <div className="pl-6">
          {livestockCol}
        </div>
      </div>
    );
  }

  // Original single-column layout (no livestock data)
  return (
    <div className="space-y-4 pt-6">
      {emissionType === 'water' && (
        <>
          <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Humans</p>
          <p className="text-xs text-gray-400 -mt-2">Emissions originating from human sanitation systems, broken down by technology and toilet category.</p>
        </>
      )}
      <div className="flex gap-4 min-h-0">
        <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
        {toiletCategoryCol}
        <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
        {contribTechCol}
      </div>
    </div>
  );
}

function PathwaysSection({ primaryData, secondaryData, isComparison, selectedAreas }) {
  const sumIsoRows = useCallback((isoRows) => {
    if (!isoRows) return 0;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(isoRows);
    return keys.reduce((sum, iso) => {
      const row = isoRows[iso] || {};
      const rowTotal = Object.values(row).reduce((acc, v) => acc + (Number(v) || 0), 0);
      return sum + rowTotal;
    }, 0);
  }, [selectedAreas]);

  const sumCol = useCallback((isoRows, col) => {
    if (!isoRows) return 0;
    const keys = selectedAreas ? [...selectedAreas] : Object.keys(isoRows);
    return keys.reduce((sum, iso) => sum + (isoRows[iso]?.[col] || 0), 0);
  }, [selectedAreas]);

  const priHumanToWater = sumIsoRows(primaryData?.waterSources?.iso_rows);
  const secHumanToWater = sumIsoRows(secondaryData?.waterSources?.iso_rows);

  const priHumanToLand = sumIsoRows(primaryData?.landSources?.iso_rows);
  const secHumanToLand = sumIsoRows(secondaryData?.landSources?.iso_rows);

  const priLivestockToLand = sumIsoRows(primaryData?.livestockLandSources?.iso_rows);
  const secLivestockToLand = sumIsoRows(secondaryData?.livestockLandSources?.iso_rows);

  const priLandToWater = sumCol(primaryData?.waterEmissions?.iso_rows, 'land');
  const secLandToWater = sumCol(secondaryData?.waterEmissions?.iso_rows, 'land');

  const priWwtpToWater = sumCol(primaryData?.waterEmissions?.iso_rows, 'wwtp');
  const secWwtpToWater = sumCol(secondaryData?.waterEmissions?.iso_rows, 'wwtp');

  const PATHWAY_DESCRIPTIONS = {
    h2w:  'Pathogens from human sanitation discharged directly into surface water bodies.',
    h2l:  'Pathogens deposited on land through open defecation and on-site sanitation systems.',
    ls2l: 'Pathogens from livestock manure deposited on agricultural, pasture, and rangelands.',
    l2w:  'Pathogens transported from land to surface water via runoff.',
    w2w:  'Pathogens remaining in wastewater treatment plant effluent discharged to surface water.',
  };

  const flows = [
    { id: 'h2w', from: 'Humans', to: 'Surface Water', label: 'Direct discharge', value: priHumanToWater, secValue: secHumanToWater },
    { id: 'h2l', from: 'Humans', to: 'Land', label: 'On-land emissions', value: priHumanToLand, secValue: secHumanToLand },
    { id: 'l2w', from: 'Land', to: 'Surface Water', label: 'Runoff transport', value: priLandToWater, secValue: secLandToWater },
    { id: 'w2w', from: 'WWTP', to: 'Surface Water', label: 'Treated effluent', value: priWwtpToWater, secValue: secWwtpToWater },
  ];

  if (priLivestockToLand > 0 || secLivestockToLand > 0) {
    flows.splice(2, 0, {
      id: 'ls2l', from: 'Livestock', to: 'Land', label: 'Manure loading', value: priLivestockToLand, secValue: secLivestockToLand,
    });
  }

  const visibleFlows = flows.filter(f => (f.value || 0) > 0 || (f.secValue || 0) > 0);
  if (visibleFlows.length === 0) return null;

  return (
    <div className="space-y-2.5">
      {visibleFlows.map(flow => {
        const pct = isComparison && flow.value > 0 ? ((flow.secValue - flow.value) / flow.value) * 100 : null;
        const desc = PATHWAY_DESCRIPTIONS[flow.id];
        return (
          <div key={flow.id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-gray-100 bg-white">
            <div className="px-2.5 py-1 rounded bg-wpBlue/10 text-wpBlue text-xs font-semibold min-w-[96px] text-center">{flow.from}</div>
            <ArrowRight size={14} className="text-gray-300 flex-shrink-0"/>
            <div className="px-2.5 py-1 rounded bg-wpTeal/10 text-wpTeal text-xs font-semibold min-w-[116px] text-center">{flow.to}</div>
            {desc && (
              <p className="text-xs text-gray-400 flex-1 leading-snug hidden sm:block">{desc}</p>
            )}
            <div className="ml-auto text-right flex-shrink-0">
              <div className="flex items-center justify-end gap-2">
                <span className={`text-sm font-bold tabular-nums ${isComparison ? 'opacity-40' : ''}`}>{formatScientific(flow.value)}</span>
                {isComparison && <span className="text-sm font-bold tabular-nums text-wpBlue">{formatScientific(flow.secValue)}</span>}
                {pct !== null && (
                  <span className={`text-xs font-semibold ${pct > 0 ? 'text-red-600' : pct < 0 ? 'text-green-600' : 'text-gray-500'}`}>
                    {fmtPct(pct)}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Data loading ─────────────────────────────────────────────────────────────────────────────

async function loadScenarioOutputs(scId) {
  const filesRes = await axios.get(`/api/scenarios/${scId}/output-files`);
  const files = filesRes.data.files || [];
  const waterEmFile  = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.csv'));
  const landEmFile   = files.find(f => f.includes('land_emissions')          && f.endsWith('.csv'));
  const waterSrcFile = files.find(f => f.includes('human_sources_water')     && f.endsWith('.csv'));
  const landSrcFile  = files.find(f => f.includes('human_sources_land')      && f.endsWith('.csv'));
  const waterLsFile  = files.find(f => f.includes('livestock_sources_water') && f.endsWith('.csv'));
  const landLsFile   = files.find(f => f.includes('livestock_sources_land')  && f.endsWith('.csv'));
  const waterTifFile = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.tif'));
  const landTifFile  = files.find(f => f.includes('land_emissions')          && f.endsWith('.tif'));

  const [geoRes, wEmRes, lEmRes, wSrcRes, lSrcRes, wLsRes, lLsRes, wStatsRes, lStatsRes] = await Promise.all([
    axios.get(`/api/scenarios/${scId}/geodata`),
    waterEmFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterEmFile}`)  : Promise.resolve(null),
    landEmFile   ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landEmFile}`)   : Promise.resolve(null),
    waterSrcFile ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterSrcFile}`) : Promise.resolve(null),
    landSrcFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landSrcFile}`)  : Promise.resolve(null),
    waterLsFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterLsFile}`)  : Promise.resolve(null),
    landLsFile   ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landLsFile}`)   : Promise.resolve(null),
    waterTifFile ? axios.get(`/api/scenarios/${scId}/raster-area-stats/${waterTifFile}`).catch(() => null) : Promise.resolve(null),
    landTifFile  ? axios.get(`/api/scenarios/${scId}/raster-area-stats/${landTifFile}`).catch(() => null)  : Promise.resolve(null),
  ]);

  return {
    geojson:                geoRes?.data   || null,
    waterEmissions:         wEmRes?.data   || null,
    landEmissions:          lEmRes?.data   || null,
    waterSources:           wSrcRes?.data  || null,
    landSources:            lSrcRes?.data  || null,
    livestockWaterSources:  wLsRes?.data   || null,
    livestockLandSources:   lLsRes?.data   || null,
    waterTif:               waterTifFile   || null,
    landTif:                landTifFile    || null,
    waterRasterStats:       wStatsRes?.data || null,
    landRasterStats:        lStatsRes?.data || null,
    loadedAt:               Date.now(),
  };
}

// ─── Main component ────────────────────────────────────────────────────────────────────────────────

export default function ResultsView({ caseStudies, initialCaseStudyId, initialScenarioId, onCaseStudyChange }) {
  const [selectedCsId,       setSelectedCsId]       = useState(initialCaseStudyId || '');
  const [availableScenarios, setAvailableScenarios] = useState([]);
  const [scenariosLoading,   setScenariosLoading]   = useState(false);

  // Up to 2 selected scenario IDs.  index 0 = primary, index 1 = secondary
  const [selectedScIds, setSelectedScIds] = useState(initialScenarioId ? [initialScenarioId] : []);
  const [emissionType,  setEmissionType]  = useState('water');

  // Cached data keyed by scenario id.  Value: output object | 'loading' | 'error'
  const [scenarioData, setScenarioData] = useState({});

  // Area filter: null = all, Set<string iso> = specific
  const [selectedAreas, setSelectedAreas] = useState(null);
  const [clickedArea,   setClickedArea]   = useState(null);

  // ── Sync externally supplied IDs
  useEffect(() => { if (initialCaseStudyId) setSelectedCsId(initialCaseStudyId); }, [initialCaseStudyId]);
  useEffect(() => {
    if (initialScenarioId) setSelectedScIds(prev => prev.includes(initialScenarioId) ? prev : [initialScenarioId]);
  }, [initialScenarioId]);
  useEffect(() => {
    if (!selectedCsId && !initialCaseStudyId && caseStudies.length === 1) setSelectedCsId(caseStudies[0].id);
  }, [caseStudies]); // eslint-disable-line

  // ── Load scenario list
  useEffect(() => {
    if (!selectedCsId) { setAvailableScenarios([]); setSelectedScIds([]); return; }
    setScenariosLoading(true);
    axios.get(`/api/case-studies/${selectedCsId}/analytics`)
      .then(({ data }) => {
        const all = data.scenarios || [];
        setAvailableScenarios(all);
        const withOutputs = all.filter(s => s.has_outputs);
        // Keep previously-selected scenarios that still have outputs;
        // if none remain and exactly one scenario has outputs, auto-select it.
        setSelectedScIds(prev => {
          const filtered = prev.filter(id => all.find(s => s.id === id && s.has_outputs));
          if (filtered.length === 0 && withOutputs.length === 1) return [withOutputs[0].id];
          return filtered;
        });
      })
      .catch(() => setAvailableScenarios([]))
      .finally(() => setScenariosLoading(false));
  }, [selectedCsId]); // eslint-disable-line

  // ── Load output data
  useEffect(() => {
    selectedScIds.forEach(scId => {
      if (scenarioData[scId]) return;
      setScenarioData(prev => ({ ...prev, [scId]: 'loading' }));
      loadScenarioOutputs(scId)
        .then(d  => setScenarioData(prev => ({ ...prev, [scId]: d })))
        .catch(() => setScenarioData(prev => ({ ...prev, [scId]: 'error' })));
    });
    setScenarioData(prev => {
      const next = {};
      selectedScIds.forEach(id => { if (prev[id]) next[id] = prev[id]; });
      return next;
    });
  }, [JSON.stringify(selectedScIds)]); // eslint-disable-line

  // Reset area filter on primary change
  const prevPrimRef = useRef(null);
  useEffect(() => {
    const prim = selectedScIds[0] || null;
    if (prim !== prevPrimRef.current) { setSelectedAreas(null); prevPrimRef.current = prim; }
  }, [selectedScIds]);

  // ── Derived data
  const primaryScId   = selectedScIds[0] || null;
  const secondaryScId = selectedScIds[1] || null;
  const isComparison  = !!primaryScId && !!secondaryScId;

  const primaryData   = (primaryScId   && scenarioData[primaryScId]   !== 'loading' && scenarioData[primaryScId]   !== 'error') ? scenarioData[primaryScId]   : null;
  const secondaryData = (secondaryScId && scenarioData[secondaryScId] !== 'loading' && scenarioData[secondaryScId] !== 'error') ? scenarioData[secondaryScId] : null;
  const isLoading     = selectedScIds.some(id => scenarioData[id] === 'loading');

  const geojson  = primaryData?.geojson  || null;
  const waterTif = primaryData?.waterTif || null;
  const landTif  = primaryData?.landTif  || null;

  const primaryWaterTotals   = primaryData?.waterEmissions?.iso_totals   || null;
  const primaryLandTotals    = primaryData?.landEmissions?.iso_totals    || null;
  const secondaryWaterTotals = secondaryData?.waterEmissions?.iso_totals || null;
  const secondaryLandTotals  = secondaryData?.landEmissions?.iso_totals  || null;

  const currentPriTotals = emissionType === 'water' ? primaryWaterTotals   : primaryLandTotals;
  const currentSecTotals = emissionType === 'water' ? secondaryWaterTotals : secondaryLandTotals;

  const areaNames = useMemo(() => {
    const m = {};
    geojson?.features?.forEach(f => {
      const iso = String(f.properties.iso);
      // Cascade through all GADM NAME levels so any admin granularity shows real names.
      m[iso] = f.properties.NAME_3 || f.properties.NAME_2 || f.properties.NAME_1
             || f.properties.NAME_0 || f.properties.subarea || f.properties.name || `Area ${iso}`;
    });
    return m;
  }, [geojson]);

  const areaOptions = useMemo(() => {
    if (!geojson?.features) return [];
    return geojson.features
      .map(f => ({ iso: String(f.properties.iso), name: areaNames[String(f.properties.iso)] || `Area ${f.properties.iso}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [geojson, areaNames]);

  // ── Handlers
  const handleScenarioPillClick = (scId) => {
    setSelectedScIds(prev => {
      let next;
      if (prev.includes(scId)) {
        next = prev.filter(id => id !== scId);
      } else {
        next = prev.length >= 2 ? [...prev.slice(1), scId] : [...prev, scId];
      }
      // Sort: earlier year = scenario 1, later year = scenario 2.
      // Equal-year pairs keep insertion order (stable sort).
      return [...next].sort((a, b) => {
        const yA = availableScenarios.find(s => s.id === a)?.year ?? 0;
        const yB = availableScenarios.find(s => s.id === b)?.year ?? 0;
        if (yA !== yB) return yA - yB;
        return next.indexOf(a) - next.indexOf(b);
      });
    });
  };

  const handleAreaSelect = (iso) => {
    setSelectedAreas(prev => {
      // Single-select: clicking the active area deselects it (→ All). Clicking another replaces.
      if (prev?.size === 1 && prev.has(iso)) return null;
      return new Set([iso]);
    });
  };

  // ── Selectors
  const primaryScenario   = availableScenarios.find(s => s.id === primaryScId);
  const secondaryScenario = availableScenarios.find(s => s.id === secondaryScId);

  return (
    <div className="flex flex-col h-full overflow-auto p-6 pt-0">

      {/* Selector bar */}
      <div className="flex items-start gap-4 my-2 py-4 px-4 flex-shrink-0 flex-wrap rounded-xl bg-wpBrown-200">
        <select
          value={selectedCsId}
          onChange={e => {
            const id = e.target.value;
            setSelectedCsId(id);
            setSelectedScIds([]);
            if (id) { const cs = caseStudies.find(c => c.id === id); if (cs) onCaseStudyChange?.(cs); }
          }}
          className="px-3 py-2.5 border text-sm border-wpBrown bg-wpWhite-100 text-wpBlue font-bold font-inter rounded-lg focus:ring-2 focus:ring-wpBlue flex-shrink-0"
        >
          <option value="">Select a case study…</option>
          {caseStudies.map(cs => <option key={cs.id} value={cs.id}>{cs.name}</option>)}
        </select>

        <div className="flex-1 flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-2">
            {scenariosLoading && <span className="text-sm text-gray-400 italic py-1">Loading…</span>}
            {!scenariosLoading && availableScenarios.length === 0 && selectedCsId && (
              <span className="text-sm text-gray-400 italic py-1">No scenarios found</span>
            )}
            {!scenariosLoading && availableScenarios.map(s => {
              const idx = selectedScIds.indexOf(s.id);
              const isPrimary   = idx === 0;
              const isSecondary = idx === 1;
              const active = idx !== -1;
              const hasOutputs = s.has_outputs;
              return (
                <button key={s.id}
                  onClick={() => hasOutputs ? handleScenarioPillClick(s.id) : undefined}
                  disabled={!hasOutputs}
                  title={!hasOutputs ? 'Model has not been run for this scenario' : undefined}
                  className={`relative flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                    !hasOutputs
                      ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60'
                      : isPrimary   ? 'bg-wpBlue text-white border-wpBlue' :
                        isSecondary ? 'bg-wpCypress text-white border-wpCypress' :
                                      'bg-wpWhite-100 text-wpBlue border-wpBrown hover:bg-wpBrown-100'
                  }`}>
                  {active ? (
                    <span className={`w-4 h-4 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 ${
                      isPrimary ? 'bg-white text-wpBlue' : 'bg-white text-wpCypress'
                    }`}>{idx + 1}</span>
                  ) : (
                    <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                      hasOutputs ? 'border-wpBlue' : 'border-gray-300'
                    }`}/>
                  )}
                  {s.name}
                </button>
              );
            })}
          </div>
          {selectedCsId && (
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              Select up to 2 scenarios to compare
            </p>
          )}
        </div>
      </div>

      {/* Category tabs — hidden; only human-emissions view is currently active */}

      {/* Empty state */}
      {!primaryScId && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-400">
            <BarChart2 size={48} className="mx-auto mb-3 text-gray-200"/>
            <p className="text-lg font-medium text-gray-300">No scenario selected</p>
            <p className="text-sm mt-1">Select a case study and at least one completed scenario.</p>
          </div>
        </div>
      )}

      {/* Human emissions */}
      {primaryScId && (
        <div className="space-y-4 mt-2 pb-6 pt-3">

          {/* Scenario info + emission-type toggle bar */}
          {primaryScId && (
            <div className="flex items-center gap-4 px-4 py-2.5 rounded-xl bg-wpWhite-100 border border-gray-200">
              <div className="flex items-center gap-3 flex-1 flex-wrap">
                {primaryScenario && (
                  <div className="flex items-center gap-1.5 text-sm font-medium text-wpBlue">
                    <span className="w-5 h-5 rounded-full bg-wpBlue text-white text-xs font-bold flex items-center justify-center">1</span>
                    {primaryScenario.name}
                    <span className="text-xs font-normal text-gray-400 ml-0.5">({primaryScenario.year || 2025})</span>
                  </div>
                )}
                {isComparison && secondaryScenario && (
                  <>
                    <span className="text-gray-300 text-sm">vs</span>
                    <div className="flex items-center gap-1.5 text-sm font-medium text-wpCypress">
                      <span className="w-5 h-5 rounded-full bg-wpCypress text-white text-xs font-bold flex items-center justify-center">2</span>
                      {secondaryScenario.name}
                      <span className="text-xs font-normal text-gray-400 ml-0.5">({secondaryScenario.year || 2025})</span>
                    </div>
                  </>
                )}
              </div>
              <div className="flex rounded-xl overflow-hidden border border-gray-200 text-sm flex-shrink-0">
                <button onClick={() => setEmissionType('water')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='water' ? 'bg-wpBlue text-white' : 'text-wpBlue hover:bg-gray-100'}`}>
                  <Droplets size={13}/> Surface Water
                </button>
                <button onClick={() => setEmissionType('land')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='land' ? 'bg-wpGreen text-white' : 'text-wpBlue hover:bg-gray-100'}`}>
                  <Trees size={13}/> Land
                </button>
              </div>
            </div>
          )}

          <EmissionMapPanel
            title={`${primaryScenario?.pathogen ? (primaryScenario.pathogen.charAt(0).toUpperCase() + primaryScenario.pathogen.slice(1)) : ''} Emissions by area`}
            icon={null}
            geojson={geojson}
            primaryIsoTotals={currentPriTotals}
            secondaryIsoTotals={isComparison ? currentSecTotals : null}
            rasterFile={emissionType === 'water' ? waterTif : landTif}
            secondaryRasterFile={isComparison ? (emissionType === 'water' ? secondaryData?.waterTif || null : secondaryData?.landTif || null) : null}
            rasterVersion={primaryData?.loadedAt || 0}
            scenarioId={primaryScId}
            secondaryScenarioId={isComparison ? secondaryScId : null}
            isComparison={isComparison}
            onAreaClick={setClickedArea}
            loading={isLoading}
            areaNames={areaNames}
            selectedAreas={selectedAreas}
            onAreaSelect={handleAreaSelect}
          />

          {/* Section 1: area filter for map/area breakdown */}
          {areaOptions.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Filter by area</p>
              <div className="flex flex-wrap gap-1">
                {areaOptions.map(({ iso, name }) => {
                  const isActive = selectedAreas?.has(iso);
                  return (
                    <button key={iso} onClick={() => handleAreaSelect(iso)}
                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                        isActive
                          ? 'bg-wpBlue text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}>
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 2: most contributing sources */}
          {primaryData && (
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-4 space-y-4">
              <p className="text-md font-semibold text-wpBlue uppercase tracking-wide mr-6">
                Most Contributing Sources
                {isComparison && <span className="ml-1 text-xs font-normal text-wpTeal bg-wpTeal/10 px-1.5 py-0.5 rounded">comparison</span>}
              </p>
              <StatsSection
                primaryData={primaryData}
                secondaryData={secondaryData}
                isComparison={isComparison}
                selectedAreas={selectedAreas}
                emissionType={emissionType}
              />
            </div>
          )}

          {/* Section 3: simple high-level pathways — constrained to 50% width */}
          {emissionType === 'water' && primaryData && (
            <div className="w-1/2">
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-4 space-y-3">
                <p className="text-md font-semibold text-wpBlue uppercase tracking-wide mr-6">
                  Emission Pathways
                  {isComparison && <span className="ml-1 text-xs font-normal text-wpTeal bg-wpTeal/10 px-1.5 py-0.5 rounded">comparison</span>}
                </p>
                <PathwaysSection
                  primaryData={primaryData}
                  secondaryData={secondaryData}
                  isComparison={isComparison}
                  selectedAreas={selectedAreas}
                />
              </div>
            </div>
          )}

        </div>
      )}

      {/* Area click modal */}
      {clickedArea && (
        <AreaDialog
          area={clickedArea}
          waterStats={primaryData?.waterRasterStats}
          landStats={primaryData?.landRasterStats}
          onClose={() => setClickedArea(null)}
        />
      )}
    </div>
  );
}
