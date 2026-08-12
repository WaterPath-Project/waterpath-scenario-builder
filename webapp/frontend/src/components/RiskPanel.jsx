// QMRA Risk panel -- dashboard view showing annual risk + infections per pathway.
// gr.values[0] from parseGeoraster is an Array of TypedArray subarrays (one per row).
// Iteration must use nested loops: rows[r][c].

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import { ArrowUpRight, ArrowDownRight, ArrowRight, Minus, Plus, X, Maximize2, Minimize2, Printer } from 'lucide-react';
import { MapContainer, TileLayer, useMap, GeoJSON as LeafletGeoJSON } from 'react-leaflet';
import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import RiskIcon         from '../../assets/icons/risk.svg';
import DrinkingIcon     from '../../assets/icons/drinking.svg';
import SwimmingIcon     from '../../assets/icons/swimming.svg';
import FloodIcon        from '../../assets/icons/floods.svg';
import OpenDrainIcon    from '../../assets/icons/open_drains.svg';
import PlayingIcon      from '../../assets/icons/playing.svg';
import WashingIcon      from '../../assets/icons/washing.svg';

window.proj4 = proj4;

const TILE_URL  = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';

// --- Colour helpers ---------------------------------------------------------
// Risk scale: white → green → yellow-green → yellow → amber → orange-red → dark red
// Adapted from the concentrations YLORRD scale, starting from green/yellow hues.
const RISK_STOPS = [
  [0.0,   [255, 255, 255]],  // white (no risk)
  [0.01,  [255, 255, 204]],  // pale yellow (1%)
  [0.05,  [255, 237, 160]],  // light yellow
  [0.10,  [254, 217, 118]],  // yellow
  [0.20,  [254, 178,  76]],  // orange
  [0.35,  [253, 141,  60]],  // deep orange
  [0.50,  [252,  78,  42]],  // orange-red
  [0.70,  [227,  26,  28]],  // red
  [0.85,  [189,   0,  38]],  // dark red
  [1.0,   [128,   0,  38]],  // maroon
];
function lerp(a, b, t) { return a + (b - a) * t; }
function colorForRisk(p) {
  const v = Math.max(0, Math.min(1, p));
  for (let i = 0; i < RISK_STOPS.length - 1; i++) {
    const [t0, c0] = RISK_STOPS[i];
    const [t1, c1] = RISK_STOPS[i + 1];
    if (v >= t0 && v <= t1) {
      const t = (v - t0) / (t1 - t0 || 1);
      return [Math.round(lerp(c0[0],c1[0],t)), Math.round(lerp(c0[1],c1[1],t)), Math.round(lerp(c0[2],c1[2],t))];
    }
  }
  return RISK_STOPS[RISK_STOPS.length - 1][1];
}
function colorForCases(v, maxVal) {
  if (!maxVal || maxVal <= 0) return [200, 200, 200];
  const S = [[0,[255,255,204]],[0.25,[253,174,97]],[0.5,[215,48,39]],[1,[103,0,13]]];
  const t = Math.max(0, Math.min(1, v / maxVal));
  for (let i = 0; i < S.length - 1; i++) {
    const [t0,c0] = S[i]; const [t1,c1] = S[i+1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [Math.round(lerp(c0[0],c1[0],f)), Math.round(lerp(c0[1],c1[1],f)), Math.round(lerp(c0[2],c1[2],f))];
    }
  }
  return S[S.length-1][1];
}

// --- Stats computation -------------------------------------------------------
// gr.values[0] -> Array<TypedArray>  (rows x cols per georaster unflatten)
function computeStats(gr) {
  const rows   = gr.values[0];
  const nodata = gr.noDataValue;
  let sum = 0, min = Infinity, max = -Infinity, count = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null || isNaN(v) || !isFinite(v) || v <= 0) continue;
      if (nodata != null && v === nodata) continue;
      sum += v; count++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return count > 0 ? { mean: sum / count, sum, min, max, count } : null;
}

async function fetchRasterData(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
    const gr  = await parseGeoraster(res.data);
    const stats = computeStats(gr);
    if (!stats) console.warn('[RiskPanel] computeStats returned null for', url);
    return { gr, stats };
  } catch (err) {
    console.warn('[RiskPanel] fetchRasterData failed for', url, err);
    return null;
  }
}

// --- Pathway config ----------------------------------------------------------
const ROUTE_ORDER = ['drinking','swimming','flooding','open_drain','playing','washing_clothes'];
const ROUTE_CONFIG = {
  drinking:        { label: 'Drinking Water',  description: 'Annual risk per person', icon: DrinkingIcon  },
  swimming:        { label: 'Swimming',         description: 'Annual risk per person', icon: SwimmingIcon  },
  flooding:        { label: 'Floodwater',       description: 'Annual risk per person', icon: FloodIcon     },
  open_drain:      { label: 'Open Drains',      description: 'Annual risk per person', icon: OpenDrainIcon },
  playing:         { label: 'Children playing', description: 'Annual risk per person', icon: PlayingIcon   },
  washing_clothes: { label: 'Washing clothes',  description: 'Annual risk per person', icon: WashingIcon   },
};

const MONTH_LABELS = {
  jan:'January', feb:'February', mar:'March',   apr:'April',
  may:'May',     jun:'June',     jul:'July',     aug:'August',
  sep:'September', oct:'October', nov:'November', dec:'December',
};
function labelFile(f) {
  if (f === 'annual_risk.tif')   return 'Annual risk';
  if (f === 'expected_cases.tif') return 'Expected infections';
  const m = f.match(/^(.+)_([a-z]{3})\.tif$/i);
  if (m) {
    const pathogen = m[1].replace(/_/g,' ');
    const month    = MONTH_LABELS[m[2].toLowerCase()] || m[2];
    return `${month} -- ${pathogen}`;
  }
  return f;
}

function monthLabelFromFile(file) {
  const match = file?.match(/_([a-z]{3})\.tif$/i);
  if (!match) return null;
  return MONTH_LABELS[match[1].toLowerCase()] || match[1];
}

// --- Legend helpers ---------------------------------------------------------
// Map a risk value (0–1) to its gradient position (0–1) on RISK_STOPS.
function riskToNorm(v) {
  const clamped = Math.max(0, Math.min(1, v));
  for (let i = 0; i < RISK_STOPS.length - 1; i++) {
    const t0 = RISK_STOPS[i][0], t1 = RISK_STOPS[i + 1][0];
    if (clamped >= t0 && clamped <= t1) {
      const frac = (clamped - t0) / (t1 - t0 || 1);
      return (i + frac) / (RISK_STOPS.length - 1);
    }
  }
  return 1;
}
// Map a gradient position (0–1) back to an approximate risk probability.
function normToRisk(norm) {
  const n = Math.max(0, Math.min(1, norm));
  const idx = n * (RISK_STOPS.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.min(Math.ceil(idx), RISK_STOPS.length - 1);
  return lerp(RISK_STOPS[lo][0], RISK_STOPS[hi][0], idx - lo);
}
// Highlight band overlay drawn over a legend gradient bar.
function BandOverlay({ norm, halfWidth = 0.07 }) {
  if (norm === null || norm === undefined) return null;
  const lo = Math.max(0, norm - halfWidth);
  const hi = Math.min(1, norm + halfWidth);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${lo*100}%`, background:'rgba(0,0,0,0.35)' }} />
      <div style={{ position:'absolute', right:0, top:0, bottom:0, width:`${(1-hi)*100}%`, background:'rgba(0,0,0,0.35)' }} />
      <div style={{ position:'absolute', left:`${lo*100}%`, top:0, bottom:0, width:2, background:'white', boxShadow:'0 0 3px rgba(0,0,0,0.6)' }} />
      <div style={{ position:'absolute', left:`${hi*100}%`, top:0, bottom:0, width:2, background:'white', boxShadow:'0 0 3px rgba(0,0,0,0.6)' }} />
    </div>
  );
}
// Floating tooltip rendered inside MapContainer showing the hovered value.
function RiskLegendTooltip({ hlNorm, isComparison }) {
  if (hlNorm === null || hlNorm === undefined) return null;
  let label;
  if (isComparison) {
    const pct = Math.round(hlNorm * 200 - 100);
    label = `${pct >= 0 ? '+' : ''}${pct}%`;
  } else {
    label = fmtRisk(normToRisk(hlNorm));
  }
  return (
    <div style={{
      position: 'absolute', bottom: 36, left: '50%', transform: 'translateX(-50%)',
      zIndex: 1100, pointerEvents: 'none',
      background: 'rgba(15,23,42,0.85)', color: '#fff',
      padding: '4px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'Inter, sans-serif',
      whiteSpace: 'nowrap', backdropFilter: 'blur(4px)',
      border: '1px solid rgba(255,255,255,0.15)',
    }}>
      Highlighting: <strong>{label}</strong>
    </div>
  );
}

// --- Overview map layer ------------------------------------------------------
function RiskRasterLayer({ tifUrl, isCases, hlCtx, bandIndex = 1 }) {
  const map = useMap();
  const bandRef  = useRef(bandIndex);
  const layerRef = useRef(null);
  // Switch which band is coloured without re-fetching the raster.
  useEffect(() => {
    bandRef.current = bandIndex;
    layerRef.current?.redraw?.();
  }, [bandIndex]);
  useEffect(() => {
    if (!tifUrl || !map) return;
    let layer = null, cancelled = false, rafId = null;
    (async () => {
      try {
        const result = await fetchRasterData(tifUrl);
        if (cancelled || !result) return;
        const { gr } = result;
        let maxVal = 1;
        if (isCases) {
          const rows = gr.values[0]; const allVals = [];
          for (let r = 0; r < rows.length; r++)
            for (let c = 0; c < rows[r].length; c++) {
              const v = rows[r][c];
              if (v != null && !isNaN(v) && v > 0) allVals.push(v);
            }
          if (allVals.length) {
            allVals.sort((a,b) => a-b);
            maxVal = allVals[Math.floor(allVals.length * 0.95)] || allVals[allVals.length-1];
          }
        }
        layer = new GeoRasterLayer({
          georaster: gr, opacity: 0.85, resolution: 256, caching: false,
          pixelValuesToColorFn: (values) => {
            const v = isCases ? values[0] : values[(bandRef.current || 1) - 1];
            if (v == null || isNaN(v) || v <= 0) return null;
            const [r,g,b] = isCases ? colorForCases(v, maxVal) : colorForRisk(v);
            const band = hlCtx?.current?.band;
            if (band) {
              const norm = isCases ? v / maxVal : riskToNorm(v);
              if (norm < band[0] || norm > band[1]) return `rgba(${r},${g},${b},0.2)`;
            }
            return `rgb(${r},${g},${b})`;
          },
        });
        layer.addTo(map);
        layerRef.current = layer;
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
          try { map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 12 }); } catch {}
      } catch (err) { console.error('RiskRasterLayer error:', err); }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (hlCtx) hlCtx.current.redraw = null;
      layerRef.current = null;
      if (layer && map) try { map.removeLayer(layer); } catch {};
    };
  }, [tifUrl, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function RiskMapControls() {
  const map = useMap();
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    const handler = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const handleFullscreen = () => {
    const container = map.getContainer();
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const btnCls = 'w-7 h-7 flex items-center justify-center rounded bg-white shadow border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors';

  return (
    <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button className={btnCls} onClick={() => map.zoomIn()} title="Zoom in"><Plus size={13} /></button>
      <button className={btnCls} onClick={() => map.zoomOut()} title="Zoom out"><Minus size={13} /></button>
      <button className={btnCls} onClick={handleFullscreen} title={isFs ? 'Exit fullscreen' : 'Fullscreen'}>{isFs ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
      <button className={btnCls} onClick={() => window.print()} title="Print"><Printer size={13} /></button>
    </div>
  );
}

// --- Formatting helpers ------------------------------------------------------
const EM = '\u2014';
// Soft wpBlue halo for low-risk values, without the hard double-ring artifact
// -webkit-text-stroke produces on glyphs with counters (0, 6, 8, 9, %).
function riskGlowFilter(v) {
  return v != null && v < 0.10
    ? 'drop-shadow(0 0 0.65px rgba(11,65,89,0.55)) drop-shadow(0 0 0.65px rgba(11,65,89,0.35))'
    : 'none';
}
function fmtRisk(v)  { return v == null ? EM : `${(v * 100).toFixed(2)}%`; }
function fmtCases(v) {
  if (v == null) return EM;
  return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(1);
}
function Skeleton({ w = 'w-20', h = 'h-8' }) {
  return <div className={`${w} ${h} bg-gray-200 rounded animate-pulse`} />;
}
function NoDash({ title }) {
  return (
    <span className="text-gray-300 text-sm cursor-help" title={title}>{EM}</span>
  );
}
// --- Month navigation + deviation boxes ------------------------------------
const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_ABB3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// --- Quantile selection ------------------------------------------------------
// Format a quantile number (e.g. 0.5) as the dict key used in stats responses (e.g. 'q0.500').
const qKey = (q) => `q${Number(q).toFixed(3)}`;
const QUANTILES = [
  { value: 0.025, label: 'Low',    title: 'Low estimate (2.5th percentile)' },
  { value: 0.5,   label: 'Median', title: 'Median estimate (50th percentile)' },
  { value: 0.975, label: 'High',   title: 'High estimate (97.5th percentile)' },
];

function RiskMonthBarChart({ values, secValues, isComparison, selectedFile, monthToFile, onSelect, primaryLabel, secondaryLabel }) {
  if (!monthToFile || !Object.keys(monthToFile).length) return null;
  const hasValues = !!(values && values.length >= 12);
  const validVals = hasValues ? values.filter(v => v != null && isFinite(v)) : [];
  const hasSecValues = isComparison && !!(secValues && secValues.length >= 12);
  const validSecVals = hasSecValues ? secValues.filter(v => v != null && isFinite(v)) : [];
  const maxVal = Math.max(validVals.length ? Math.max(...validVals) : 0, validSecVals.length ? Math.max(...validSecVals) : 0);

  const activeMonthKey = selectedFile
    ? Object.entries(monthToFile).find(([, f]) => f === selectedFile)?.[0]
    : null;

  return (
    <div className="flex flex-col h-full">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Risk by month</p>
      <div className="flex-1 flex items-end gap-1.5 min-h-[96px]">
        {MONTH_ABB3.map((m, i) => {
          const key   = MONTH_KEYS[i];
          const file  = monthToFile[key];
          const v     = hasValues ? values[i] : null;
          const sv    = hasSecValues ? secValues[i] : null;
          const pct   = v != null && maxVal > 0 ? Math.max(6, (v / maxVal) * 100) : 0;
          const secPct = sv != null && maxVal > 0 ? Math.max(6, (sv / maxVal) * 100) : 0;
          const isActive = activeMonthKey === key;
          const canClick = !!file;
          const [r, g, b] = v != null ? colorForRisk(v) : [209, 213, 219];
          return (
            <button
              key={i}
              type="button"
              onClick={canClick ? () => onSelect(file) : undefined}
              disabled={!canClick}
              title={
                isComparison
                  ? `${MONTH_LABELS[key]}: ${v != null ? fmtRisk(v) : EM} \u2192 ${sv != null ? fmtRisk(sv) : EM}`
                  : v != null ? `${MONTH_LABELS[key]}: ${fmtRisk(v)}` : MONTH_LABELS[key]
              }
              className={`flex-1 flex flex-col items-center justify-end h-full group ${
                canClick ? 'cursor-pointer' : 'cursor-default opacity-30'
              }`}
            >
              <div className="w-full flex-1 flex items-end gap-0.5">
                {isComparison ? (
                  <>
                    <div className={`flex-1 rounded-t transition-all duration-200 bg-wpBlue ${isActive ? 'ring-2 ring-wpBlue ring-offset-1' : 'group-hover:opacity-75'}`}
                      style={{ height: `${pct}%`, minHeight: v != null ? 3 : 0 }} />
                    <div className={`flex-1 rounded-t transition-all duration-200 bg-wpCypress ${isActive ? 'ring-2 ring-wpCypress ring-offset-1' : 'group-hover:opacity-75'}`}
                      style={{ height: `${secPct}%`, minHeight: sv != null ? 3 : 0 }} />
                  </>
                ) : (
                  <div
                    className={`w-full rounded-t transition-all duration-200 ${
                      isActive ? 'ring-2 ring-wpBlue ring-offset-1' : 'group-hover:opacity-75'
                    }`}
                    style={{ height: `${pct}%`, minHeight: v != null ? 3 : 0, backgroundColor: `rgb(${r},${g},${b})` }}
                  />
                )}
              </div>
              <span className={`text-[10px] mt-1 ${isActive ? 'text-wpBlue font-semibold' : 'text-gray-400'}`}>{m}</span>
            </button>
          );
        })}
      </div>
      {isComparison && (
        <div className="flex items-center gap-3 mt-2">
          <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2 h-2 rounded-sm bg-wpBlue inline-block" />{primaryLabel || 'Primary'}</span>
          <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2 h-2 rounded-sm bg-wpCypress inline-block" />{secondaryLabel || 'Comparison'}</span>
        </div>
      )}
    </div>
  );
}

// --- Diff raster layer (comparison mode) ------------------------------------
// Exact same diffColor as ResultsView: red = higher risk, green = lower risk.
function diffColor(pct, scale = 100) {
  if (pct === null || pct === undefined || isNaN(pct)) return '#d1d5db';
  if (scale > 0 && Math.abs(pct) / scale < 0.02) return '#f3f4f6';
  const t = Math.min(1, Math.abs(pct) / (scale || 100));
  if (pct > 0) {
    return `rgb(${Math.round(lerp(254,153,t))},${Math.round(lerp(202,27,t))},${Math.round(lerp(202,27,t))})`;
  } else {
    return `rgb(${Math.round(lerp(187,20,t))},${Math.round(lerp(247,83,t))},${Math.round(lerp(208,45,t))})`;
  }
}

function RiskDiffRasterLayer({ diffUrl, hlCtx }) {
  const map = useMap();
  useEffect(() => {
    if (!diffUrl || !map) return;
    let layer = null, cancelled = false, rafId = null;
    (async () => {
      try {
        const res = await fetch(diffUrl, { cache: 'no-store' });
        if (!res.ok) { console.error('RiskDiffRasterLayer HTTP', res.status); return; }
        const ab = await res.arrayBuffer();
        if (cancelled) return;
        const gr = await parseGeoraster(ab);
        if (cancelled) return;
        const nd = gr.noDataValue;
        let vmin = Infinity, vmax = -Infinity;
        for (const row of gr.values[0]) {
          for (const v of row) {
            if (v != null && isFinite(v) && v !== nd) {
              if (v < vmin) vmin = v;
              if (v > vmax) vmax = v;
            }
          }
        }
        if (!isFinite(vmin)) { console.warn('RiskDiffRasterLayer: no valid pixels'); return; }
        const absMax = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1;
        const scale  = Math.max(100, Math.floor(absMax / 100) * 100);
        layer = new GeoRasterLayer({
          georaster: gr, opacity: 0.85, resolution: 256, caching: false,
          pixelValuesToColorFn: ([v]) => {
            if (v == null || !isFinite(v) || v === nd) return null;
            const color = diffColor(v, scale);
            const band = hlCtx?.current?.band;
            if (band) {
              const norm = Math.max(0, Math.min(1, (v / scale + 1) / 2));
              if (norm < band[0] || norm > band[1]) return color.replace('rgb(', 'rgba(').replace(')', ',0.2)');
            }
            return color;
          },
        });
        layer.addTo(map);
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
        try { map.fitBounds(layer.getBounds(), { maxZoom: 9 }); } catch {}
      } catch (err) { console.error('RiskDiffRasterLayer error:', err); }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (hlCtx) hlCtx.current.redraw = null;
      if (layer && map) try { map.removeLayer(layer); } catch {};
    };
  }, [diffUrl, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// --- Risk legend -------------------------------------------------------------
const RISK_GRADIENT = RISK_STOPS
  .map(([, [r, g, b]], i) => `rgb(${r},${g},${b}) ${(i / (RISK_STOPS.length - 1) * 100).toFixed(1)}%`)
  .join(', ');

function RiskLegend({ isComparison, hlCtx, hlNorm, onHlChange }) {
  const hlLeave = () => {
    if (hlCtx) { hlCtx.current.band = null; hlCtx.current.redraw?.(); }
    onHlChange?.(null);
  };

  if (isComparison) {
    return (
      <div className="mt-2">
        <div className="relative">
          <div
            className="h-4 rounded-sm w-full cursor-crosshair"
            style={{ background: 'linear-gradient(to right,rgb(20,83,45),rgb(187,247,208),#f3f4f6,rgb(254,202,202),rgb(153,27,27))' }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const norm = (e.clientX - rect.left) / rect.width;
              if (hlCtx) { hlCtx.current.band = [norm - 0.07, norm + 0.07]; hlCtx.current.redraw?.(); }
              onHlChange?.(norm);
            }}
            onMouseLeave={hlLeave}
          />
          <BandOverlay norm={hlNorm} />
        </div>
        <div className="flex justify-between mt-0.5">
          {['≤−100%', '−50%', '0%', '+50%', '≥+100%'].map(v => (
            <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">% change in risk (green = decrease · red = increase)</p>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="relative">
        <div
          className="h-4 rounded-sm w-full cursor-crosshair"
          style={{ background: `linear-gradient(to right, ${RISK_GRADIENT})` }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const norm = (e.clientX - rect.left) / rect.width;
            if (hlCtx) { hlCtx.current.band = [norm - 0.07, norm + 0.07]; hlCtx.current.redraw?.(); }
            onHlChange?.(norm);
          }}
          onMouseLeave={hlLeave}
        />
        <BandOverlay norm={hlNorm} />
      </div>
      <div className="relative h-4 mt-0.5">
        {[0, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0].map((v) => {
          const pos = riskToNorm(v) * 100;
          return (
            <span
              key={v}
              className="absolute text-[10px] text-gray-400 font-inter whitespace-nowrap"
              style={{ left: `${pos}%`, transform: pos <= 2 ? 'none' : pos >= 98 ? 'translateX(-100%)' : 'translateX(-50%)' }}
            >
              {v === 0 ? '0' : v < 0.1 ? `${(v * 100).toFixed(0)}%` : `${(v * 100).toFixed(0)}%`}
            </span>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-1">Per-cell annual probability of infection</p>
    </div>
  );
}

// --- Delta helpers -----------------------------------------------------------
function fmtPP(pp) {
  if (pp === null || pp === undefined || isNaN(pp)) return '\u2014';
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(2)}\u00a0pp`;
}
function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '\u2014';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
// mode='pp'  → shows percentage-point change: (sec-pri)*100 pp (used for risk probabilities)
// mode='pct' → shows relative % change: (sec-pri)/|pri|*100 % (used for counts/infections)
function DeltaChip({ pri, sec, loading, mode = 'pp' }) {
  if (loading) return <span className="inline-block w-10 h-3 bg-gray-200 rounded animate-pulse ml-1" />;
  if (pri == null || sec == null || !isFinite(pri) || !isFinite(sec)) return null;
  let d, label;
  if (mode === 'pp') {
    d = (sec - pri) * 100;
    label = fmtPP(d);
  } else {
    if (Math.abs(pri) < 1e-15) return null;
    d = (sec - pri) / Math.abs(pri) * 100;
    label = fmtPct(d);
  }
  const threshold = mode === 'pp' ? 0.001 : 0.5;
  const isUp   = d >  threshold;
  const isDown = d < -threshold;
  const colorCls = isUp ? 'text-red-600' : isDown ? 'text-green-700' : 'text-gray-500';
  const Icon = isUp ? ArrowUpRight : isDown ? ArrowDownRight : Minus;
  return (
    <span className={`inline-flex items-center gap-0 ml-1 font-semibold tabular-nums text-[11px] ${colorCls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

// --- Region click dialog (per-pathway risk breakdown) -----------------------
function RiskAreaDialog({ area, riskAreaStats, availableRoutes, quantile, onClose }) {
  if (!area) return null;
  const { iso, name } = area;
  const stats = riskAreaStats?.[String(iso)];
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
          <div>
            <p className="font-semibold text-gray-900">{name}</p>
            <p className="text-xs text-gray-400">Risk per pathway &middot; {(quantile * 100).toFixed(1)}th percentile</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-200"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">
          {!stats ? (
            <p className="text-xs text-gray-400 italic">No risk data for this area.</p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Combined</span>
                <span
                  className="text-xl font-bold font-outfit tabular-nums"
                  style={{ color: `rgb(${colorForRisk(stats.risk).join(',')})`, filter: riskGlowFilter(stats.risk) }}
                >{fmtRisk(stats.risk)}</span>
              </div>
              <table className="w-full text-xs"><tbody>
                {availableRoutes.map(rk => {
                  const conf = ROUTE_CONFIG[rk] || { label: rk };
                  const v = stats.routes?.[rk];
                  return (
                    <tr key={rk} className="border-b border-gray-100 last:border-0">
                      <td className="py-1.5 pr-2 text-gray-600 font-medium">
                        <span className="flex items-center gap-1.5">
                          {conf.icon && <img src={conf.icon} alt="" className="w-4 h-4 opacity-70" />}
                          {conf.label}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-semibold tabular-nums"
                        style={v != null ? { color: `rgb(${colorForRisk(v).join(',')})`, filter: riskGlowFilter(v) } : {}}>
                        {v != null ? fmtRisk(v) : EM}
                      </td>
                    </tr>
                  );
                })}
              </tbody></table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main component ----------------------------------------------------------
export default function RiskPanel({ scenarioId, scenarioName, pathogen = null, secondaryScenarioId = null, secondaryScenarioName = null, geojson = null, areaNames = null }) {
  const [files,       setFiles]      = useState({ combined: { monthly: [], daily: [] }, routes: {} });
  const [qmraStats,   setQmraStats]  = useState(null);
  const [loading,     setLoading]    = useState(false);
  // Both the 'Annual' and 'Monthly' tabs read from the backend's 'monthly'
  // (i.e. monthly-compounded) output -- the 'daily' output_type represents a
  // single day's exposure risk (always tiny) and is not exposed in the UI.
  // `viewMode` controls whether the map/stats default to the annual aggregate
  // (annual_risk.tif) or a specific calendar month's compounded risk.
  const outputType = 'monthly';
  const [viewMode,    setViewMode]    = useState('annual'); // 'annual' | 'monthly'
  const [quantile,    setQuantile]    = useState(0.5); // which band drives the headline/map/table
  const [selectedFile,setSelectedFile] = useState(null);
  const [loadError,     setLoadError]    = useState('');
  const [statsLoading,  setStatsLoading] = useState(false);
  const [secStats,      setSecStats]     = useState(null);
  const [secStatsLoading, setSecStatsLoading] = useState(false);
  // Always-current annual_risk.tif stats for the monthly bar chart
  const [navStats,        setNavStats]      = useState(null);
  const [secNavStats,     setSecNavStats]   = useState(null);
  const [riskAreaStats,   setRiskAreaStats] = useState(null); // {iso: {risk, count, cases}}
  const [secRiskAreaStats, setSecRiskAreaStats] = useState(null);
  const hlCtx = useRef({ band: null, redraw: null });
  const [hlNorm, setHlNorm] = useState(null);
  // Which risk layer the map paints: 'combined' or a route key.
  const [mapLayer, setMapLayer] = useState('combined');
  // Region polygon clicked on the map (shows per-pathway risk for that area).
  const [clickedArea, setClickedArea] = useState(null);

  // Load output file list
  useEffect(() => {
    if (!scenarioId) return;
    setLoadError(''); setQmraStats(null); setSelectedFile(null); setLoading(true); setViewMode('annual'); setQuantile(0.5);
    axios.get(`/api/scenarios/${scenarioId}/qmra/output`)
      .then(({ data }) => {
        const f = {
          combined: data.combined || { monthly: [], daily: [] },
          routes:   data.routes   || {},
        };
        setFiles(f);
        const initFile = (f.combined.monthly || []).includes('annual_risk.tif')
          ? 'annual_risk.tif'
          : (f.combined.monthly || [])[0] || null;
        setSelectedFile(initFile);
        setLoading(false);
      })
      .catch(err => { console.error('qmra load error:', err); setLoadError('Failed to load QMRA output.'); setLoading(false); });
  }, [scenarioId]);

  // Re-fetch stats whenever selected file, output type or quantile changes
  useEffect(() => {
    if (!scenarioId || !selectedFile) return;
    let cancelled = false;
    setStatsLoading(true);
    axios.get(`/api/scenarios/${scenarioId}/qmra/stats`, {
      params: { output_type: outputType, file: selectedFile, quantile },
    })
      .then(({ data }) => { if (!cancelled) { setQmraStats(data); setStatsLoading(false); } })
      .catch(() => { if (!cancelled) { setQmraStats(null); setStatsLoading(false); } });
    return () => { cancelled = true; };
  }, [scenarioId, outputType, selectedFile, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch secondary stats whenever comparison scenario / file / type / quantile changes
  useEffect(() => {
    if (!secondaryScenarioId || !selectedFile) { setSecStats(null); return; }
    let cancelled = false;
    setSecStatsLoading(true);
    axios.get(`/api/scenarios/${secondaryScenarioId}/qmra/stats`, {
      params: { output_type: outputType, file: selectedFile, quantile },
    })
      .then(({ data }) => { if (!cancelled) { setSecStats(data); setSecStatsLoading(false); } })
      .catch(() => { if (!cancelled) { setSecStats(null); setSecStatsLoading(false); } });
    return () => { cancelled = true; };
  }, [secondaryScenarioId, outputType, selectedFile, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always fetch annual_risk.tif for month navigation (independent of selectedFile)
  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    axios.get(`/api/scenarios/${scenarioId}/qmra/stats`, { params: { output_type: 'monthly', file: 'annual_risk.tif', quantile } })
      .then(({ data }) => { if (!cancelled) setNavStats(data); })
      .catch(() => { if (!cancelled) setNavStats(null); });
    return () => { cancelled = true; };
  }, [scenarioId, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same as above, for the comparison scenario (drives the monthly bar chart's secondary bars)
  useEffect(() => {
    if (!secondaryScenarioId) { setSecNavStats(null); return; }
    let cancelled = false;
    axios.get(`/api/scenarios/${secondaryScenarioId}/qmra/stats`, { params: { output_type: 'monthly', file: 'annual_risk.tif', quantile } })
      .then(({ data }) => { if (!cancelled) setSecNavStats(data); })
      .catch(() => { if (!cancelled) setSecNavStats(null); });
    return () => { cancelled = true; };
  }, [secondaryScenarioId, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch area stats for risk-by-area breakdown
  useEffect(() => {
    if (!scenarioId) { setRiskAreaStats(null); return; }
    let cancelled = false;
    setRiskAreaStats(null);
    axios.get(`/api/scenarios/${scenarioId}/qmra/area-stats`, { params: { output_type: outputType, file: 'annual_risk.tif', quantile } })
      .then(({ data }) => { if (!cancelled && !data.error) setRiskAreaStats(data); })
      .catch(() => { if (!cancelled) setRiskAreaStats(null); });
    return () => { cancelled = true; };
  }, [scenarioId, outputType, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same as above, for the comparison scenario
  useEffect(() => {
    if (!secondaryScenarioId) { setSecRiskAreaStats(null); return; }
    let cancelled = false;
    setSecRiskAreaStats(null);
    axios.get(`/api/scenarios/${secondaryScenarioId}/qmra/area-stats`, { params: { output_type: outputType, file: 'annual_risk.tif', quantile } })
      .then(({ data }) => { if (!cancelled && !data.error) setSecRiskAreaStats(data); })
      .catch(() => { if (!cancelled) setSecRiskAreaStats(null); });
    return () => { cancelled = true; };
  }, [secondaryScenarioId, outputType, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  const availableRoutes = useMemo(() => {
    const all = Object.keys(files.routes || {});
    return ROUTE_ORDER.filter(r => all.includes(r));
  }, [files]);

  const allEmpty = useMemo(() => {
    const m = files.combined?.monthly || [];
    return m.length === 0 && Object.keys(files.routes || {}).length === 0;
  }, [files]);

  // File list for the currently selected output type (combined only for map)
  const mapFileList = useMemo(() => (files.combined || {})[outputType] || [], [files, outputType]);

  // Map month 3-letter key → monthly filename for navigation
  const monthToFile = useMemo(() => {
    const result = {};
    for (const f of mapFileList) {
      const m = f.match(/_([a-z]{3})\.tif$/i);
      if (m) result[m[1].toLowerCase()] = f;
    }
    return result;
  }, [mapFileList]);

  // When the Annual/Monthly view toggles, pick a sensible default file:
  // Annual -> annual_risk.tif (12-month compounded probability); Monthly ->
  // the first available per-month file (monthly-compounded risk for that
  // calendar month, still from the 'monthly' output_type).
  useEffect(() => {
    const list = mapFileList;
    if (viewMode === 'monthly') {
      const firstMonthFile = MONTH_KEYS.map(k => monthToFile[k]).find(Boolean);
      setSelectedFile(firstMonthFile || (list.includes('annual_risk.tif') ? 'annual_risk.tif' : list[0] || null));
    } else {
      setSelectedFile(list.includes('annual_risk.tif') ? 'annual_risk.tif' : list[0] || null);
    }
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the painted map layer back to Combined when the file/scenario changes.
  useEffect(() => { setMapLayer('combined'); }, [selectedFile, scenarioId]);

  const tifUrl = useMemo(() => {
    if (!selectedFile) return null;
    return `/api/scenarios/${scenarioId}/qmra/raster/combined/${outputType}/${encodeURIComponent(selectedFile)}`;
  }, [scenarioId, outputType, selectedFile]);

  // Helpers to pull a specific quantile out of the stats object
  const getQ   = (riskObj, q) => riskObj?.[q];
  const cRisk  = qmraStats?.combined?.risk  ?? {};
  const secCRisk = secStats?.combined?.risk ?? {};
  const combinedRiskSelQ = getQ(cRisk, qKey(quantile));
  const secCombinedRiskSelQ = getQ(secCRisk, qKey(quantile));
  const combinedRiskQ025 = getQ(cRisk, 'q0.025');
  const combinedRiskQ975 = getQ(cRisk, 'q0.975');
  const combinedCases    = qmraStats?.combined?.cases;
  const secCombinedCases = secStats?.combined?.cases;

  const bands = qmraStats?.bands ?? {};
  const isCasesFile = selectedFile === 'expected_cases.tif';
  // Only offer per-pathway map layers on a plain (non-diff, non-cases) view.
  const layerSelectable = !secondaryScenarioId && !isCasesFile;
  const mapBandIndex = layerSelectable ? (bands?.[mapLayer] || 1) : 1;
  const canClickCombined = layerSelectable && !!bands['combined'];
  // Bar-chart values always from navStats (annual_risk.tif), not from the
  // selected-file stats. Unweighted per-cell mean -- the exact model output,
  // same basis as the headline figure (no population weighting).
  const navMonthlyValues = navStats?.monthly;
  const secNavMonthlyValues = secNavStats?.monthly;

  const isComparison    = !!secondaryScenarioId;

  const diffTifUrl = useMemo(() => {
    if (!isComparison || !selectedFile) return null;
    return `/api/qmra/diff-tif?scA=${scenarioId}&scB=${secondaryScenarioId}&output_type=${outputType}&file=${encodeURIComponent(selectedFile)}&quantile=${quantile}`;
  }, [isComparison, scenarioId, secondaryScenarioId, outputType, selectedFile, quantile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Region polygons on the map are clickable (same interaction as the
  // emissions map): clicking opens a dialog with the per-pathway risk
  // breakdown for that region, at the currently selected quantile.
  const onEachFeature = useCallback((feature, layer) => {
    const iso = feature.properties.iso;
    const isoKey = String(iso);
    const name = feature.properties.NAME_4 || feature.properties.NAME_3 || feature.properties.NAME_2
      || feature.properties.NAME_1 || feature.properties.NAME_0 || feature.properties.subarea
      || areaNames?.[isoKey] || `Area ${iso}`;
    layer.on('mouseover', () => {
      layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, weight: 1.5, color: '#0f172a', opacity: 0.9 });
      layer.bindTooltip(`<strong>${name}</strong>`, { sticky: true });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, color: '#1e293b', weight: 0.6, opacity: 0.5 });
    });
    layer.on('click', () => setClickedArea({ iso: isoKey, name }));
  }, [areaNames]);

  // Ranked areas for risk-by-area list (ranked by primary risk; secondary
  // scenario's risk for the same area is attached when comparing).
  const rankedRiskAreas = useMemo(() => {
    if (!riskAreaStats) return [];
    return Object.entries(riskAreaStats)
      .map(([iso, s]) => ({ iso, risk: s.risk ?? 0, secRisk: secRiskAreaStats?.[iso]?.risk ?? null }))
      .sort((a, b) => b.risk - a.risk);
  }, [riskAreaStats, secRiskAreaStats]);

  const riskAreaBarMax = useMemo(() => {
    const priMax = rankedRiskAreas[0]?.risk ?? 1;
    if (!isComparison || !secRiskAreaStats) return priMax || 1;
    const secVals = Object.values(secRiskAreaStats).map(s => s.risk ?? 0);
    const secMax = secVals.length ? Math.max(...secVals) : 0;
    return Math.max(priMax, secMax) || 1;
  }, [rankedRiskAreas, secRiskAreaStats, isComparison]);

  // Ranked areas for the "Expected annual infections" by-area breakdown --
  // recalculates automatically whenever `quantile` changes because
  // `riskAreaStats` is re-fetched per quantile.
  const rankedCaseAreas = useMemo(() => {
    if (!riskAreaStats) return [];
    return Object.entries(riskAreaStats)
      .filter(([, s]) => s.cases != null)
      .map(([iso, s]) => ({ iso, cases: s.cases, secCases: secRiskAreaStats?.[iso]?.cases ?? null }))
      .sort((a, b) => b.cases - a.cases);
  }, [riskAreaStats, secRiskAreaStats]);

  const selectedQuantileInfo = QUANTILES.find(q => q.value === quantile);
  const selectedMonthLabel = viewMode === 'monthly' ? monthLabelFromFile(selectedFile) : null;

  // Right panel content for MapWithSidePanel
  const sidePanelContent = (
    <>
      {/* ── Top stats: Risk of Infection */}
      <div className="flex-shrink-0 mb-3 pb-2 border-b border-gray-100">
        <div className="flex items-start justify-between gap-3 items-center">
          {/* Left: Risk of Infection heading + headline number */}
          <div className="flex-1 min-w-0">
            <div className="text-lg font-outfit font-semibold text-wpBlue uppercase tracking-wide mb-1 flex items-center gap-1">
              Risk of Infection
              <span
                className="text-gray-300 cursor-help normal-case font-normal"
                title="Combined risk = 1 − ∏(1 − riskᵢ) across pathways."
              >ⓘ</span>
            </div>
            <div
              onClick={canClickCombined ? () => setMapLayer('combined') : undefined}
              title={canClickCombined ? 'Click to view the combined risk map' : undefined}
              className={`-mx-1.5 -mt-0.5 px-1.5 pt-0.5 pb-1 rounded-md transition-colors ${
                canClickCombined ? 'cursor-pointer hover:bg-gray-50' : ''
              } ${canClickCombined && mapLayer === 'combined' ? '' : ''}`}
            >
              {loading || statsLoading ? <Skeleton w="w-28" h="h-10" /> : isComparison ? (
                <>
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span style={combinedRiskSelQ ? { color: `rgb(${colorForRisk(combinedRiskSelQ.mean).join(',')})`, filter: riskGlowFilter(combinedRiskSelQ.mean) } : {}}
                      className="text-3xl font-bold font-outfit tabular-nums text-gray-400">
                      {combinedRiskSelQ ? fmtRisk(combinedRiskSelQ.mean) : EM}
                    </span>
                    <ArrowRight size={18} className="text-gray-400 flex-shrink-0" />
                    <span style={secCombinedRiskSelQ ? { color: `rgb(${colorForRisk(secCombinedRiskSelQ.mean).join(',')})`, filter: riskGlowFilter(secCombinedRiskSelQ.mean) } : {}}
                      className="text-3xl font-bold font-outfit tabular-nums">
                      {secStatsLoading ? '…' : secCombinedRiskSelQ ? fmtRisk(secCombinedRiskSelQ.mean) : EM}
                    </span>
                  </div>
                  {combinedRiskSelQ && secCombinedRiskSelQ && (
                    <p className={`flex items-center gap-0.5 text-base font-outfit font-semibold mt-0.5 ${
                      secCombinedRiskSelQ.mean - combinedRiskSelQ.mean > 0 ? 'text-red-600' : secCombinedRiskSelQ.mean - combinedRiskSelQ.mean < 0 ? 'text-green-700' : 'text-gray-500'
                    }`}>
                      {(secCombinedRiskSelQ.mean - combinedRiskSelQ.mean) > 0.00001 ? <ArrowUpRight size={18}/> : (secCombinedRiskSelQ.mean - combinedRiskSelQ.mean) < -0.00001 ? <ArrowDownRight size={18}/> : <Minus size={12}/>}
                      {fmtPP((secCombinedRiskSelQ.mean - combinedRiskSelQ.mean) * 100)}
                    </p>
                  )}
                </>
              ) : (
                <span style={combinedRiskSelQ ? { color: `rgb(${colorForRisk(combinedRiskSelQ.mean).join(',')})`, filter: riskGlowFilter(combinedRiskSelQ.mean) } : {}}
                  className="text-5xl font-bold font-outfit tabular-nums">
                  {combinedRiskSelQ ? fmtRisk(combinedRiskSelQ.mean) : EM}
                </span>
              )}
              <div className="text-xs text-gray-500 mt-0.5">
                {viewMode === 'monthly' && selectedMonthLabel ? `Risk per person in ${selectedMonthLabel}` : 'Risk per person per year'}
              </div>
            </div>
          </div>
          {/* Right: quantile selector + median caption + Monte Carlo band, as one column */}
          <div className="flex flex-col items-end flex-shrink-0 w-[150px]">
            <div className="flex rounded-md overflow-hidden border border-gray-200" title="Select which uncertainty band drives the figures below and the map">
              {QUANTILES.map(({ value, label, title }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuantile(value)}
                  title={title}
                  className={`px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                    quantile === value ? 'bg-wpBlue text-white' : 'text-gray-500 bg-gray-50 hover:bg-gray-100'
                  }`}
                >{label}</button>
              ))}
            </div>
            {selectedQuantileInfo && (
              <p className="text-[10px] text-gray-400 mt-0.5 text-right leading-tight">
                {selectedQuantileInfo.title}
              </p>
            )}
            {!loading && combinedRiskQ025 && combinedRiskQ975 && (
              <div className="text-[10px] text-gray-400 mt-1.5 tabular-nums text-right leading-tight" title="Monte-Carlo uncertainty band (2.5th–97.5th percentile), averaged across cells.">
                {fmtRisk(combinedRiskQ025.mean)} {EM} {fmtRisk(combinedRiskQ975.mean)}
                <span className="block text-gray-300">(q2.5{EM}q97.5)</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Risk by Exposure Pathway (3 rows × 2 columns) */}
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 flex-shrink-0">Risk by Exposure Pathway</p>
      <div className="grid grid-cols-2 gap-2 flex-1 content-start overflow-y-auto pr-1">
        {availableRoutes.map(rk => {
          const conf  = ROUTE_CONFIG[rk] || { label: rk };
          const rSelQ = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, qKey(quantile));
          const rQ025 = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, 'q0.025');
          const rQ975 = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, 'q0.975');
          const canClick = layerSelectable && !!bands[rk];
          const isActiveLayer = layerSelectable && mapLayer === rk;
          return (
            <div
              key={rk}
              onClick={canClick ? () => setMapLayer(rk) : undefined}
              className={`rounded-md border px-2.5 py-2 transition-colors flex items-center gap-2 ${
                isActiveLayer ? 'bg-wpBlue/5 border-wpBlue/30' : 'border-gray-100'
              } ${canClick ? 'cursor-pointer hover:bg-gray-50' : ''}`}
            >
              {conf.icon
                ? <img src={conf.icon} alt={conf.label} className="w-8 h-8 flex-shrink-0 opacity-75" />
                : <div className="w-8 h-8 flex-shrink-0" />}
              {loading || statsLoading ? <Skeleton w="w-12" h="h-5" /> : (
                rSelQ ? (
                  <div className="min-w-0 flex-1 flex flex-col p-4">
                    <span className="text-sm font-semibold text-wpBlue truncate">{conf.label}</span>
                    <span
                      style={{ color: `rgb(${colorForRisk(rSelQ.mean).join(',')})`, filter: riskGlowFilter(rSelQ.mean) }}
                      className="text-lg font-bold font-outfit tabular-nums"
                    >{fmtRisk(rSelQ.mean)}</span>
                  </div>
                ) : <NoDash title="No valid output pixels for this route." />
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <>
    <div className="space-y-4">
      {/* ── Map + info card */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h3 className="font-semibold text-wpBlue uppercase flex items-center gap-2">
            Health Risk ({pathogen ? pathogen.charAt(0).toUpperCase() + pathogen.slice(1) : 'QMRA'})
            {isComparison && (
              <span className="ml-1 text-xs font-normal text-orange-500 bg-orange-50 px-1.5 py-0.5 rounded">
                vs {secondaryScenarioName || 'comparison'}
              </span>
            )}
          </h3>
          <div className="flex rounded-xl overflow-hidden border border-gray-200 text-sm flex-shrink-0">
            <button
              onClick={() => setViewMode('annual')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === 'annual' ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
              }`}
            >Annual</button>
            <button
              onClick={() => setViewMode('monthly')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === 'monthly' ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
              }`}
            >Monthly</button>
          </div>
        </div>

        {loadError && <div className="px-4 py-2 bg-red-50 text-red-700 text-sm rounded mb-3">{loadError}</div>}

        {allEmpty && !loading ? (
          <div className="py-10 text-sm text-gray-400 text-center">
            No QMRA output yet.<br />
            <span className="text-xs">Configure and run the risk model in the <strong>QMRA</strong> tab.</span>
          </div>
        ) : (
          <div className="flex gap-3" style={{ height: 480 }}>
            {/* Map */}
            <div className="flex flex-col min-w-0" style={{ flex: 2 }}>
              <div className="relative rounded overflow-hidden border border-gray-100 flex-1">
                <MapContainer
                  style={{ height: '100%', width: '100%' }}
                  center={[0, 30]} zoom={3}
                  scrollWheelZoom={false} zoomControl={false} attributionControl={false}
                >
                  <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
                  {isComparison && diffTifUrl
                    ? <RiskDiffRasterLayer key={diffTifUrl} diffUrl={diffTifUrl} hlCtx={hlCtx} />
                    : tifUrl && <RiskRasterLayer key={tifUrl} tifUrl={tifUrl} isCases={selectedFile === 'expected_cases.tif'} hlCtx={hlCtx} bandIndex={mapBandIndex} />
                  }
                  {geojson && (
                    <LeafletGeoJSON
                      key={`risk-geojson-${geojson.features?.length}`}
                      data={geojson}
                      style={() => ({ fillColor: 'transparent', fillOpacity: 0, color: '#1e293b', weight: 0.6, opacity: 0.5 })}
                      onEachFeature={onEachFeature}
                    />
                  )}
                  <RiskMapControls />
                  <RiskLegendTooltip hlNorm={hlNorm} isComparison={isComparison} />
                </MapContainer>
              </div>
              <RiskLegend isComparison={isComparison} hlCtx={hlCtx} hlNorm={hlNorm} onHlChange={setHlNorm} />
            </div>
            {/* Right panel */}
            <div className="flex flex-col border-l border-gray-100 pl-3 overflow-hidden" style={{ flex: 1 }}>
              {sidePanelContent}
            </div>
          </div>
        )}
      </div>

      {/* ── Risk by area + Expected annual infections / monthly bar chart */}
      {(rankedRiskAreas.length > 0 || combinedCases || viewMode === 'monthly') && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-2 gap-6">
            {/* Risk by area */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Risk by area</p>
              <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                {rankedRiskAreas.length > 0 ? rankedRiskAreas.map(({ iso, risk, secRisk }) => {
                  const name = areaNames?.[iso] || `Area ${iso}`;
                  if (isComparison) {
                    const priPct = riskAreaBarMax > 0 ? Math.min(94, (risk / riskAreaBarMax) * 100) : 0;
                    const secPct = secRisk != null && riskAreaBarMax > 0 ? Math.min(94, (secRisk / riskAreaBarMax) * 100) : null;
                    const trackPct = Math.min(94, ((secRisk != null ? Math.max(risk, secRisk) : risk) / (riskAreaBarMax || 1)) * 100);
                    return (
                      <div key={iso} className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-28 shrink-0 truncate" title={name}>{name}</span>
                        <div className="flex-1 h-2 bg-gray-100 rounded-full mx-1 relative">
                          <div className="absolute top-0 h-2 rounded-full bg-wpBlue/20" style={{ width: `${trackPct.toFixed(1)}%`, left: 0 }} />
                          <div className="absolute w-2.5 h-2.5 rounded-full bg-wpBlue border-2 border-white shadow-sm" style={{ left: `${priPct.toFixed(1)}%`, top: '50%', transform: 'translate(-50%,-50%)' }} />
                          {secPct != null && (
                            <div className="absolute w-2.5 h-2.5 rounded-full bg-wpCypress border-2 border-white shadow-sm" style={{ left: `${secPct.toFixed(1)}%`, top: '50%', transform: 'translate(-50%,-50%)' }} />
                          )}
                        </div>
                        <span className="text-xs text-gray-500 font-outfit tabular-nums w-14 text-right shrink-0">
                          <DeltaChip pri={risk} sec={secRisk} mode="pp" />
                        </span>
                      </div>
                    );
                  }
                  const barPct = riskAreaBarMax > 0 ? (risk / riskAreaBarMax) * 100 : 0;
                  const [r, g, b] = colorForRisk(risk);
                  return (
                    <div key={iso} className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-28 shrink-0 truncate" title={name}>{name}</span>
                      <div className="flex-1 bg-gray-100 rounded-full overflow-hidden" style={{ height: 6 }}>
                        <div className="rounded-full h-full transition-all duration-300" style={{ width: `${barPct.toFixed(1)}%`, backgroundColor: `rgb(${r},${g},${b})` }} />
                      </div>
                      <span className="text-xs text-gray-500 font-outfit tabular-nums w-14 text-right shrink-0">{fmtRisk(risk)}</span>
                    </div>
                  );
                }) : (
                  <div className="text-xs text-gray-400 text-center py-3">No area data</div>
                )}
              </div>
              {isComparison && rankedRiskAreas.length > 0 && (
                <div className="flex items-center gap-3 mt-2">
                  <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2 h-2 rounded-sm bg-wpBlue inline-block" />{scenarioName || 'Selected scenario'}</span>
                  <span className="flex items-center gap-1 text-[10px] text-gray-500"><span className="w-2 h-2 rounded-sm bg-wpCypress inline-block" />{secondaryScenarioName || 'Comparison scenario'}</span>
                </div>
              )}
            </div>
            {/* Expected annual infections (Annual tab) / Risk by month (Monthly tab) */}
            <div className="border-l border-gray-100 pl-6">
              {viewMode === 'monthly' ? (
                <RiskMonthBarChart
                  values={navMonthlyValues?.combined}
                  secValues={secNavMonthlyValues?.combined}
                  isComparison={isComparison}
                  selectedFile={selectedFile}
                  monthToFile={monthToFile}
                  onSelect={setSelectedFile}
                  primaryLabel={scenarioName}
                  secondaryLabel={secondaryScenarioName}
                />
              ) : (
                <>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Expected annual infections</p>
                  {loading || statsLoading ? <Skeleton w="w-24" h="h-8" /> : combinedCases ? (
                    isComparison ? (
                      <div>
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-2xl font-bold font-outfit tabular-nums text-gray-400">{fmtCases(combinedCases.sum)}</span>
                          <ArrowRight size={16} className="text-gray-400 flex-shrink-0" />
                          <span className="text-2xl font-bold font-outfit tabular-nums text-wpBlue">
                            {secStatsLoading ? '…' : secCombinedCases ? fmtCases(secCombinedCases.sum) : EM}
                          </span>
                          {secCombinedCases && <DeltaChip pri={combinedCases.sum} sec={secCombinedCases.sum} mode="pct" />}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <span className="text-3xl font-bold font-outfit tabular-nums text-gray-700">{fmtCases(combinedCases.sum)}</span>
                      </div>
                    )
                  ) : (
                    <NoDash title="No infection estimate available." />
                  )}
                  <p className="text-[11px] text-gray-400 mt-1">Annual risk (q{quantile}) &times; population, across all pathways.</p>
                  {rankedCaseAreas.length > 0 && (
                    <div className="mt-3 space-y-1 max-h-40 overflow-y-auto pr-1">
                      {rankedCaseAreas.map(({ iso, cases, secCases }) => {
                        const name = areaNames?.[iso] || `Area ${iso}`;
                        return (
                          <div key={iso} className="flex items-center gap-2 text-xs">
                            <span className="text-gray-500 truncate flex-1" title={name}>{name}</span>
                            {isComparison ? (
                              <span className="font-outfit tabular-nums shrink-0 flex items-center gap-1">
                                <span className="text-gray-400">{fmtCases(cases)}</span>
                                <ArrowRight size={12} className="text-gray-400" />
                                <span className="text-wpBlue">{secCases != null ? fmtCases(secCases) : EM}</span>
                              </span>
                            ) : (
                              <span className="font-outfit tabular-nums text-gray-700 shrink-0">{fmtCases(cases)}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    <RiskAreaDialog
      area={clickedArea}
      riskAreaStats={riskAreaStats}
      availableRoutes={availableRoutes}
      quantile={quantile}
      onClose={() => setClickedArea(null)}
    />
    </>
  );
}

