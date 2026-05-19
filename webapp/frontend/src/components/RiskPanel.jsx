// QMRA Risk panel -- dashboard view showing annual risk + infections per pathway.
// gr.values[0] from parseGeoraster is an Array of TypedArray subarrays (one per row).
// Iteration must use nested loops: rows[r][c].

import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { ArrowUpRight, ArrowDownRight, ArrowRight, Minus } from 'lucide-react';
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
  [0.0,    [255, 255, 255]],  // white (no risk)
  [0.001,  [255, 230, 220]],  // very light pink
  [0.005,  [255, 190, 170]],  // light salmon
  [0.01,   [255, 150, 120]],  // salmon
  [0.05,   [240,  80,  60]],  // red-orange
  [0.10,   [210,  30,  30]],  // red
  [0.25,   [160,   0,  20]],  // dark red
  [0.50,   [100,   0,  15]],  // very dark red
  [1.0,    [ 50,   0,  10]],  // near-black red
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
    const res = await axios.get(url, { responseType: 'arraybuffer' });
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
function RiskRasterLayer({ tifUrl, isCases, hlCtx }) {
  const map = useMap();
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
          pixelValuesToColorFn: ([v]) => {
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
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
        try { map.fitBounds(layer.getBounds(), { maxZoom: 9 }); } catch {}
      } catch (err) { console.error('RiskRasterLayer error:', err); }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (hlCtx) hlCtx.current.redraw = null;
      if (layer && map) try { map.removeLayer(layer); } catch {};
    };
  }, [tifUrl, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// --- Formatting helpers ------------------------------------------------------
const EM = '\u2014';
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

function RiskMonthBoxes({ primaryValues, secondaryValues, selectedFile, monthToFile, onSelect, annualFile, casesFile }) {
  if (!primaryValues || primaryValues.length < 12) {
    // Even with no data, show clickable month stubs if we have a file map
    if (!monthToFile || !Object.keys(monthToFile).length) return null;
  }
  const hasPrimary = !!(primaryValues && primaryValues.length >= 12);

  // Compute pp deviations per month
  let pps;
  if (hasPrimary) {
    const isComp = !!(secondaryValues && secondaryValues.length >= 12);
    if (isComp) {
      pps = primaryValues.map((p, i) => {
        const s = secondaryValues[i];
        if (p == null || s == null || !isFinite(p) || !isFinite(s)) return null;
        return (s - p) * 100; // pp
      });
    } else {
      const valid = primaryValues.filter(v => v != null && isFinite(v));
      const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      pps = mean === 0 ? primaryValues.map(() => null) : primaryValues.map(v => {
        if (v == null || !isFinite(v)) return null;
        return (v - mean) * 100; // pp from mean
      });
    }
  } else {
    pps = MONTH_KEYS.map(() => null);
  }

  const selIsAnnual = selectedFile === annualFile;
  const selIsCases  = selectedFile === casesFile;
  const activeMonthKey = selectedFile && !selIsAnnual && !selIsCases
    ? Object.entries(monthToFile || {}).find(([, f]) => f === selectedFile)?.[0]
    : null;

  return (
    <div className="mt-2">
      {/* Month boxes */}
      <div className="grid grid-cols-6 gap-0.5">
        {MONTH_ABB3.map((m, i) => {
          const key  = MONTH_KEYS[i];
          const file = monthToFile?.[key];
          const pp   = pps[i];
          const isUp   = pp !== null && pp >  0.001;
          const isDown = pp !== null && pp < -0.001;
          const isActive = activeMonthKey === key;
          const canClick = !!file;
          return (
            <button
              key={i}
              onClick={canClick ? () => onSelect(file) : undefined}
              disabled={!canClick}
              className={`flex flex-col items-center py-1 px-0.5 rounded transition-colors ${
                isActive
                  ? 'bg-wpBlue text-white'
                  : canClick
                    ? 'bg-gray-50 hover:bg-gray-100 cursor-pointer'
                    : 'bg-gray-50 opacity-40 cursor-default'
              }`}
            >
              <span className={`font-medium leading-none mb-0.5 text-sm ${
                isActive ? 'text-white' : 'text-gray-600'
              }`}>{m}</span>
              {pp !== null ? (
                <>
                  {isUp
                    ? <ArrowUpRight   size={9} style={{ color: isActive ? 'white' : '#8B2500' }} />
                    : isDown
                      ? <ArrowDownRight size={9} style={{ color: isActive ? 'white' : '#0B4159' }} />
                      : <Minus size={9} className={isActive ? 'text-white opacity-60' : 'text-gray-300'} />}
                  <span
                    style={{ color: isActive ? undefined : isUp ? '#8B2500' : isDown ? '#0B4159' : undefined }}
                    className={`leading-none tabular-nums text-[11px] ${
                      isActive ? 'opacity-90' : !isUp && !isDown ? 'text-gray-400' : ''
                    }`}
                  >
                    {pp > 0 ? '+' : ''}{pp.toFixed(1)}pp
                  </span>
                </>
              ) : (
                <span className={isActive ? 'text-white text-xs opacity-60' : 'text-gray-300 text-xs'}>…</span>
              )}
            </button>
          );
        })}
      </div>
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
        const res = await fetch(diffUrl);
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
      <div className="flex justify-between mt-0.5">
        {['0', '1%', '10%', '100%'].map(v => (
          <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-1">Annual probability of infection per person</p>
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

// --- Main component ----------------------------------------------------------
export default function RiskPanel({ scenarioId, scenarioName, pathogen = null, secondaryScenarioId = null, secondaryScenarioName = null, geojson = null, areaNames = null }) {
  const [files,       setFiles]      = useState({ combined: { monthly: [], daily: [] }, routes: {} });
  const [qmraStats,   setQmraStats]  = useState(null);
  const [loading,     setLoading]    = useState(false);
  const [outputType,  setOutputType] = useState('monthly');
  const [selectedFile,setSelectedFile] = useState(null);
  const [loadError,     setLoadError]    = useState('');
  const [statsLoading,  setStatsLoading] = useState(false);
  const [secStats,      setSecStats]     = useState(null);
  const [secStatsLoading, setSecStatsLoading] = useState(false);
  // Always-current annual_risk.tif stats for month navigation boxes
  const [navStats,        setNavStats]      = useState(null);
  const [secNavStats,     setSecNavStats]   = useState(null);
  const [riskAreaStats,   setRiskAreaStats] = useState(null); // {iso: {risk, count}}
  const hlCtx = useRef({ band: null, redraw: null });
  const [hlNorm, setHlNorm] = useState(null);

  // Load output file list
  useEffect(() => {
    if (!scenarioId) return;
    setLoadError(''); setQmraStats(null); setSelectedFile(null); setLoading(true);
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

  // Re-fetch stats whenever selected file or output type changes
  useEffect(() => {
    if (!scenarioId || !selectedFile) return;
    let cancelled = false;
    setStatsLoading(true);
    axios.get(`/api/scenarios/${scenarioId}/qmra/stats`, {
      params: { output_type: outputType, file: selectedFile },
    })
      .then(({ data }) => { if (!cancelled) { setQmraStats(data); setStatsLoading(false); } })
      .catch(() => { if (!cancelled) { setQmraStats(null); setStatsLoading(false); } });
    return () => { cancelled = true; };
  }, [scenarioId, outputType, selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch secondary stats whenever comparison scenario / file / type changes
  useEffect(() => {
    if (!secondaryScenarioId || !selectedFile) { setSecStats(null); return; }
    let cancelled = false;
    setSecStatsLoading(true);
    axios.get(`/api/scenarios/${secondaryScenarioId}/qmra/stats`, {
      params: { output_type: outputType, file: selectedFile },
    })
      .then(({ data }) => { if (!cancelled) { setSecStats(data); setSecStatsLoading(false); } })
      .catch(() => { if (!cancelled) { setSecStats(null); setSecStatsLoading(false); } });
    return () => { cancelled = true; };
  }, [secondaryScenarioId, outputType, selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always fetch annual_risk.tif for month navigation (independent of selectedFile)
  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    axios.get(`/api/scenarios/${scenarioId}/qmra/stats`, { params: { output_type: 'monthly', file: 'annual_risk.tif' } })
      .then(({ data }) => { if (!cancelled) setNavStats(data); })
      .catch(() => { if (!cancelled) setNavStats(null); });
    return () => { cancelled = true; };
  }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!secondaryScenarioId) { setSecNavStats(null); return; }
    let cancelled = false;
    axios.get(`/api/scenarios/${secondaryScenarioId}/qmra/stats`, { params: { output_type: 'monthly', file: 'annual_risk.tif' } })
      .then(({ data }) => { if (!cancelled) setSecNavStats(data); })
      .catch(() => { if (!cancelled) setSecNavStats(null); });
    return () => { cancelled = true; };
  }, [secondaryScenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch area stats for risk-by-area breakdown
  useEffect(() => {
    if (!scenarioId) { setRiskAreaStats(null); return; }
    let cancelled = false;
    setRiskAreaStats(null);
    axios.get(`/api/scenarios/${scenarioId}/qmra/area-stats`, { params: { output_type: outputType, file: 'annual_risk.tif' } })
      .then(({ data }) => { if (!cancelled && !data.error) setRiskAreaStats(data); })
      .catch(() => { if (!cancelled) setRiskAreaStats(null); });
    return () => { cancelled = true; };
  }, [scenarioId, outputType]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // When outputType changes, try to keep annual_risk.tif selected if available
  useEffect(() => {
    const list = mapFileList;
    if (!list.includes(selectedFile)) {
      setSelectedFile(list.includes('annual_risk.tif') ? 'annual_risk.tif' : list[0] || null);
    }
  }, [outputType]); // eslint-disable-line react-hooks/exhaustive-deps

  const tifUrl = useMemo(() => {
    if (!selectedFile) return null;
    return `/api/scenarios/${scenarioId}/qmra/raster/combined/${outputType}/${encodeURIComponent(selectedFile)}`;
  }, [scenarioId, outputType, selectedFile]);

  // Helpers to pull a specific quantile out of the stats object
  const getQ   = (riskObj, q) => riskObj?.[q];
  const cRisk  = qmraStats?.combined?.risk  ?? {};
  const combinedRiskQ50  = getQ(cRisk, 'q0.500');
  const combinedRiskQ025 = getQ(cRisk, 'q0.025');
  const combinedRiskQ975 = getQ(cRisk, 'q0.975');
  const combinedCases    = qmraStats?.combined?.cases;
  const secCombinedCases = secStats?.combined?.cases;
  // Month box values always from navStats (annual_risk.tif), not from selected-file stats
  const navMonthlyValues    = navStats?.monthly;
  const secNavMonthlyValues = secNavStats?.monthly;
  const monthlyValues    = qmraStats?.monthly;

  const isComparison    = !!secondaryScenarioId;
  const secCombinedQ50  = getQ(secStats?.combined?.risk ?? {}, 'q0.500');
  // pp = percentage point change in risk probability
  const totalDiffPP = isComparison && combinedRiskQ50 && secCombinedQ50
    ? (secCombinedQ50.mean - combinedRiskQ50.mean) * 100
    : null;

  const diffTifUrl = useMemo(() => {
    if (!isComparison || !selectedFile) return null;
    return `/api/qmra/diff-tif?scA=${scenarioId}&scB=${secondaryScenarioId}&output_type=${outputType}&file=${encodeURIComponent(selectedFile)}`;
  }, [isComparison, scenarioId, secondaryScenarioId, outputType, selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const HDR_H = 'h-[280px]';
  const ROW_H = 'h-[62px]';

  // Ranked areas for risk-by-area list
  const rankedRiskAreas = useMemo(() => {
    if (!riskAreaStats) return [];
    return Object.entries(riskAreaStats)
      .map(([iso, s]) => ({ iso, risk: s.risk ?? 0 }))
      .sort((a, b) => b.risk - a.risk);
  }, [riskAreaStats]);

  const riskAreaBarMax = rankedRiskAreas[0]?.risk ?? 1;

  // Right panel content for MapWithSidePanel
  const sidePanelContent = (
    <>
      {/* ── Top stats: Risk of Infection */}
      <div className="flex-shrink-0 mb-3 pb-2 border-b border-gray-100">
        <div className="text-lg font-outfit font-semibold text-wpBlue uppercase tracking-wide mb-1">
          Risk of Infection
        </div>
        {loading || statsLoading ? <Skeleton w="w-28" h="h-10" /> : isComparison ? (
          <>
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span style={combinedRiskQ50 ? { color: `rgb(${colorForRisk(combinedRiskQ50.mean).join(',')})`, WebkitTextStroke: '0.8px rgba(0,0,0,0.25)' } : {}}
                className="text-3xl font-bold font-outfit tabular-nums text-gray-400">
                {combinedRiskQ50 ? fmtRisk(combinedRiskQ50.mean) : EM}
              </span>
              <ArrowRight size={18} className="text-gray-400 flex-shrink-0" />
              <span style={secCombinedQ50 ? { color: `rgb(${colorForRisk(secCombinedQ50.mean).join(',')})`, WebkitTextStroke: '0.8px rgba(0,0,0,0.25)' } : {}}
                className="text-3xl font-bold font-outfit tabular-nums">
                {secStatsLoading ? '…' : secCombinedQ50 ? fmtRisk(secCombinedQ50.mean) : EM}
              </span>
            </div>
            {totalDiffPP !== null && (
              <p className={`flex items-center gap-0.5 text-base font-outfit font-semibold mt-0.5 ${
                totalDiffPP > 0 ? 'text-red-600' : totalDiffPP < 0 ? 'text-green-700' : 'text-gray-500'
              }`}>
                {totalDiffPP > 0.001 ? <ArrowUpRight size={18}/> : totalDiffPP < -0.001 ? <ArrowDownRight size={18}/> : <Minus size={12}/>}
                {fmtPP(totalDiffPP)}
              </p>
            )}
          </>
        ) : (
          <span style={combinedRiskQ50 ? { color: `rgb(${colorForRisk(combinedRiskQ50.mean).join(',')})`, WebkitTextStroke: '0.8px rgba(0,0,0,0.25)' } : {}}
            className="text-4xl font-bold font-outfit tabular-nums">
            {combinedRiskQ50 ? fmtRisk(combinedRiskQ50.mean) : EM}
          </span>
        )}
        {!loading && combinedRiskQ025 && combinedRiskQ975 && (
          <div className="text-xs text-gray-400 mt-0.5 tabular-nums">
            {fmtRisk(combinedRiskQ025.mean)} {EM} {fmtRisk(combinedRiskQ975.mean)}
            <span className="ml-1 text-gray-300">(q2.5{EM}q97.5)</span>
          </div>
        )}
        {!loading && combinedCases && (
          <div className="text-sm text-gray-400 mt-1">
            <span className="font-semibold text-gray-600">{fmtCases(combinedCases.sum)}</span> expected annual infections
            {isComparison && <DeltaChip pri={combinedCases.sum} sec={secCombinedCases?.sum} loading={secStatsLoading} mode="pct" />}
          </div>
        )}
      </div>

      {/* ── Risk by area */}
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 flex-shrink-0">Risk by area</p>
      <div className="overflow-y-auto flex-1 space-y-0.5 pr-1">
        {rankedRiskAreas.length > 0 ? rankedRiskAreas.map(({ iso, risk }) => {
          const barPct = riskAreaBarMax > 0 ? (risk / riskAreaBarMax) * 100 : 0;
          const name   = areaNames?.[iso] || `Area ${iso}`;
          const [r,g,b] = colorForRisk(risk);
          return (
            <div key={iso} className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 w-20 shrink-0 truncate" title={name}>{name}</span>
              <div className="flex-1 bg-gray-100 rounded-full overflow-hidden" style={{ height: 6 }}>
                <div className="rounded-full h-full transition-all duration-300"
                  style={{ width: `${barPct.toFixed(1)}%`, backgroundColor: `rgb(${r},${g},${b})` }} />
              </div>
              <span className="text-xs font-mono text-gray-500 w-14 text-right shrink-0">{fmtRisk(risk)}</span>
            </div>
          );
        }) : (
          <div className="text-xs text-gray-400 text-center py-3">No area data</div>
        )}
      </div>

      {/* ── Month navigation pills */}
      {!loading && (
        <div className="flex-shrink-0 border-t border-gray-100 pt-2 mt-1">
          <RiskMonthBoxes
            primaryValues={navMonthlyValues?.combined}
            secondaryValues={isComparison ? secNavMonthlyValues?.combined : null}
            selectedFile={selectedFile}
            monthToFile={monthToFile}
            onSelect={setSelectedFile}
            annualFile={mapFileList.includes('annual_risk.tif') ? 'annual_risk.tif' : null}
            casesFile={mapFileList.includes('expected_cases.tif') ? 'expected_cases.tif' : null}
          />
        </div>
      )}
    </>
  );

  return (
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
              onClick={() => setOutputType('monthly')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                outputType === 'monthly' ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
              }`}
            >Annual</button>
            <button
              onClick={() => setOutputType('daily')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                outputType === 'daily' ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
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
              <div className="rounded overflow-hidden border border-gray-100 flex-1">
                <MapContainer
                  style={{ height: '100%', width: '100%' }}
                  center={[0, 30]} zoom={3}
                  scrollWheelZoom={false} zoomControl={false} attributionControl={false}
                >
                  <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
                  {isComparison && diffTifUrl
                    ? <RiskDiffRasterLayer key={diffTifUrl} diffUrl={diffTifUrl} hlCtx={hlCtx} />
                    : tifUrl && <RiskRasterLayer key={tifUrl} tifUrl={tifUrl} isCases={selectedFile === 'expected_cases.tif'} hlCtx={hlCtx} />
                  }
                  {geojson && (
                    <LeafletGeoJSON
                      key={`risk-geojson-${geojson.features?.length}`}
                      data={geojson}
                      style={() => ({ fillColor: 'transparent', fillOpacity: 0, color: '#1e293b', weight: 0.6, opacity: 0.5 })}
                    />
                  )}
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

      {/* ── Pathway table */}
      {availableRoutes.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Risk by Exposure Pathway</p>
          </div>
          <div>
            {availableRoutes.map(rk => {
              const conf  = ROUTE_CONFIG[rk] || { label: rk, description: '' };
              const rQ50  = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, 'q0.500');
              const rQ025 = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, 'q0.025');
              const rQ975 = getQ(qmraStats?.routes?.[rk]?.risk ?? {}, 'q0.975');
              const rCases = qmraStats?.routes?.[rk]?.cases;
              return (
                <div key={rk} className={`flex items-center gap-4 px-4 ${ROW_H} border-b border-gray-100 last:border-b-0`}>
                  {/* Icon + label */}
                  <div className="flex items-center gap-3 w-40 flex-shrink-0">
                    {conf.icon
                      ? <img src={conf.icon} alt={conf.label} className="w-7 h-7 flex-shrink-0 opacity-75" />
                      : <div className="w-7 h-7 flex-shrink-0" />}
                    <div>
                      <div className="text-base font-semibold text-wpBlue leading-tight">{conf.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{conf.description}</div>
                    </div>
                  </div>
                  {/* Risk value */}
                  <div className="flex-1">
                    {loading || statsLoading ? <Skeleton w="w-16" h="h-5" /> : (
                      rQ50
                        ? (
                          <div>
                            <div className="flex items-baseline gap-1 flex-wrap">
                              <span
                                style={{ color: `rgb(${colorForRisk(rQ50.mean).join(',')})`, WebkitTextStroke: '0.8px rgba(0,0,0,0.25)' }}
                                className="text-xl font-bold font-outfit tabular-nums"
                              >
                                {fmtRisk(rQ50.mean)}
                              </span>
                              {isComparison && (
                                <DeltaChip
                                  pri={rQ50.mean}
                                  sec={getQ(secStats?.routes?.[rk]?.risk ?? {}, 'q0.500')?.mean}
                                  loading={secStatsLoading}
                                  mode="pp"
                                />
                              )}
                            </div>
                            {rQ025 && rQ975 && (
                              <span className="text-[10px] text-gray-300 tabular-nums leading-tight">{fmtRisk(rQ025.mean)}{EM}{fmtRisk(rQ975.mean)}</span>
                            )}
                            {rCases && (
                              <div className="text-xs text-gray-400 mt-0.5">
                                {fmtCases(rCases.sum)} infections
                                {isComparison && <DeltaChip pri={rCases.sum} sec={secStats?.routes?.[rk]?.cases?.sum} loading={secStatsLoading} mode="pct" />}
                              </div>
                            )}
                          </div>
                        )
                        : <NoDash title="No valid output pixels for this route." />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
