import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MapContainer, GeoJSON as LeafletGeoJSON, ImageOverlay, useMap } from 'react-leaflet';
import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import proj4 from 'proj4';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import { useNavigate, useLocation } from 'react-router-dom';
import { RefreshCw, BarChart2, AlertTriangle, ArrowRight, X, Droplets, Trees, ArrowUpRight, ArrowDownRight, Minus, Plus, Maximize2, Minimize2, Download, Printer } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './Dialog';
import { paths } from '../routes';

import RiskPanel from './RiskPanel';
import EmissionsTabIcon      from '../../assets/icons/emissions.svg';
import ConcentrationsTabIcon from '../../assets/icons/concentrations.svg';
import RiskTabIcon           from '../../assets/icons/risk.svg';
import SurfaceWaterIcon      from '../../assets/icons/surface_water.svg';
import LandIcon              from '../../assets/icons/land.svg';
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
import OpenFreeMapLayer from './OpenFreeMapLayer';

// Make proj4 available globally so georaster-layer-for-leaflet can reproject
// TIFs that are not in WGS84 / Web Mercator.
window.proj4 = proj4;

delete L.Icon.Default.prototype._getIconUrl;

// ─── Constants ──────────────────────────────────────────────────────────────────────────────

const LOG_MIN = 0;
const LOG_MAX = 17;
const LIVESTOCK_ICONS = {
  asses:     AssesIcon,
  camels:    CamelsIcon,
  cattle:    CattleIcon,
  buffaloes: BuffaloesIcon,
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

// ─── Hydrology map color scale ─────────────────────────────────────────────────────────────────
// Low (green) → mid (blue) → high (yellow/brown) — same palette as the flow diagram
const HYDRO_ABS_STOPS = [
  [0.0,  [ 11,  65,  89]], // #0B4159 — wpBlue (deep navy)
  [0.2,  [158, 182,  91]], // #9EB65B — wpCypress (lower-mid)
  [0.4,  [212, 192,  74]], // #D4C04A — gold transition
  [0.6,  [255, 229, 151]], // #FFE597 — pale yellow
  [0.8,  [189, 164,  87]], // #BDA457 — wpBrown-900
  [1.0,  [139,  37,   0]], // #8B2500 — deep rust red (highest)
];

const HYDRO_LEGEND_GRADIENT = 'linear-gradient(to right,' +
  HYDRO_ABS_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`).join(',') + ')';

function hydroAbsColor(value, logMin, logMax) {
  if (!value || value <= 0) return null;
  const norm = Math.max(0, Math.min(1, (Math.log10(value) - logMin) / (logMax - logMin)));
  for (let i = 0; i < HYDRO_ABS_STOPS.length - 1; i++) {
    const [t0, c0] = HYDRO_ABS_STOPS[i];
    const [t1, c1] = HYDRO_ABS_STOPS[i + 1];
    if (norm >= t0 && norm <= t1) {
      const t = (t1 === t0) ? 0 : (norm - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))})`;
    }
  }
  const last = HYDRO_ABS_STOPS[HYDRO_ABS_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

// ─── Temperature colour scale ────────────────────────────────────────────────────────────────────
// Cold blue → green-yellow → hot red. Applied to river_temperature input rasters.
const TEMP_STOPS = [
  [0.00, [10,  100, 180]], // deep blue (cold)
  [0.30, [80,  170, 220]], // light blue
  [0.50, [200, 230, 160]], // yellow-green (mild)
  [0.70, [240, 180,  50]], // amber
  [1.00, [200,  30,  20]], // deep red (hot)
];
const TEMP_LEGEND_GRADIENT = 'linear-gradient(to right,' +
  TEMP_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`).join(',') + ')';

function tempColorFromNorm(norm) {
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    const [t0, c0] = TEMP_STOPS[i];
    const [t1, c1] = TEMP_STOPS[i + 1];
    if (norm >= t0 && norm <= t1) {
      const t = (t1 === t0) ? 0 : (norm - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))})`;
    }
  }
  const last = TEMP_STOPS[TEMP_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

// ─── Runoff colour scale ─────────────────────────────────────────────────────────────────────────
// White/light blue → mid blue → deep blue. Applied to runoff input rasters (mm or m³/s per cell).
const RUNOFF_STOPS = [
  [0.00, [240, 248, 255]], // near-white (very low)
  [0.30, [100, 180, 240]], // light blue
  [0.65, [ 30, 100, 200]], // mid blue
  [1.00, [  5,  30, 120]], // deep navy (high)
];
const RUNOFF_LEGEND_GRADIENT = 'linear-gradient(to right,' +
  RUNOFF_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`).join(',') + ')';

function runoffColorFromNorm(norm) {
  for (let i = 0; i < RUNOFF_STOPS.length - 1; i++) {
    const [t0, c0] = RUNOFF_STOPS[i];
    const [t1, c1] = RUNOFF_STOPS[i + 1];
    if (norm >= t0 && norm <= t1) {
      const t = (t1 === t0) ? 0 : (norm - t0) / (t1 - t0);
      return `rgba(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))},0.8)`;
    }
  }
  const last = RUNOFF_STOPS[RUNOFF_STOPS.length - 1][1];
  return `rgba(${last[0]},${last[1]},${last[2]},0.8)`;
}

// ─── SSRD colour scale ───────────────────────────────────────────────────────────────────────────
// Dark → orange → bright gold. Applied to ssrd (solar radiation) input rasters.
const SSRD_STOPS = [
  [0.00, [ 20,  20,  40]], // near-black (very low)
  [0.35, [100,  60,  20]], // dark brown-orange
  [0.65, [220, 150,  20]], // amber
  [1.00, [255, 235,  90]], // bright gold (high)
];
const SSRD_LEGEND_GRADIENT = 'linear-gradient(to right,' +
  SSRD_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`).join(',') + ')';

function ssrdColorFromNorm(norm) {
  for (let i = 0; i < SSRD_STOPS.length - 1; i++) {
    const [t0, c0] = SSRD_STOPS[i];
    const [t1, c1] = SSRD_STOPS[i + 1];
    if (norm >= t0 && norm <= t1) {
      const t = (t1 === t0) ? 0 : (norm - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))})`;
    }
  }
  const last = SSRD_STOPS[SSRD_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
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

// Compute symmetric colour scale from a % change value:
// floor(|pct| to nearest 100), minimum 100.
// e.g. +353% → 300, +85% → 100, +1200% → 1200.
function diffScale(pct) {
  if (pct == null || !isFinite(pct)) return 100;
  return Math.max(100, Math.floor(Math.abs(pct) / 100) * 100);
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

// Adaptive decimal places: enough digits so the value isn't shown as zero.
function fmtBarPct(v) {
  if (v === 0) return '0';
  if (v >= 1) return v.toFixed(1);
  const decimals = Math.max(1, Math.ceil(-Math.log10(v)) + 1);
  return v.toFixed(decimals);
}

// ─── Legend ────────────────────────────────────────────────────────────────────────────────────

// Generate gradient CSS directly from YLORRD_STOPS so it is always identical to the map.
const LEGEND_GRADIENT = 'linear-gradient(to right,' +
  YLORRD_STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(2)}%`).join(',') + ')';

// Band indicator overlay: renders a semi-transparent highlight + left/right border lines
// on a gradient bar to show the user which range is currently highlighted on the map.
function BandOverlay({ norm, halfWidth = 0.07 }) {
  if (norm === null || norm === undefined) return null;
  const lo = Math.max(0, norm - halfWidth);
  const hi = Math.min(1, norm + halfWidth);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* dim sides */}
      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${lo*100}%`, background:'rgba(0,0,0,0.35)' }} />
      <div style={{ position:'absolute', right:0, top:0, bottom:0, width:`${(1-hi)*100}%`, background:'rgba(0,0,0,0.35)' }} />
      {/* boundary lines */}
      <div style={{ position:'absolute', left:`${lo*100}%`, top:0, bottom:0, width:2, background:'white', boxShadow:'0 0 3px rgba(0,0,0,0.6)' }} />
      <div style={{ position:'absolute', left:`${hi*100}%`, top:0, bottom:0, width:2, background:'white', boxShadow:'0 0 3px rgba(0,0,0,0.6)' }} />
    </div>
  );
}

// Floating tooltip inside MapContainer showing the hovered legend value.
function LegendMapTooltip({ hlNorm, scaleType, effectiveLogMax, isDiff, diffScale: ds = 100 }) {
  if (hlNorm === null || hlNorm === undefined) return null;
  let label;
  if (isDiff) {
    const pct = Math.round((hlNorm * 2 * ds) - ds);
    label = `${pct >= 0 ? '+' : ''}${pct}%`;
  } else {
    const logVal = hlNorm * effectiveLogMax;
    label = `10^${logVal.toFixed(1)}`;
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

function Legend({ hlCtx, hlNorm, onHlChange }) {
  const { heatmapView: smoothing, fixedColorScale, dynamicLogMax } = useSettingsStore();
  const effectiveLogMax = fixedColorScale ? LOG_MAX : (dynamicLogMax ?? LOG_MAX);
  const hlLeave = () => {
    if (hlCtx) { hlCtx.current.band = null; hlCtx.current.redraw?.(); }
    onHlChange?.(null);
  };

  if (!smoothing) {
    // Discrete swatches — one per stop (skip the white "0" stop).
    // Only show stops whose log₁₀ value falls within the effective range.
    const swatches = YLORRD_STOPS.slice(1)
      .filter(([t]) => Math.round(t * LOG_MAX) <= Math.ceil(effectiveLogMax))
      .map(([t, [r, g, b]]) => ({
        t,
        color: `rgb(${r},${g},${b})`,
        label: `${String(Math.round(t * LOG_MAX))}`,
      }));
    return (
      <div className="mt-2">
        <div className="flex items-center flex-wrap">
          <div className="flex flex-col items-center" onMouseLeave={hlLeave}>
            <div className="h-3 w-[70px] border b-gray-100" style={{ background: '#fff' }}/>
            <span className="text-sm text-gray-400 mt-0.5 font-inter leading-none">NA</span>
          </div>
          {swatches.map(({ t, color, label }) => (
            <div key={label} className="flex flex-col items-center" style={{ minWidth: 24, cursor: hlCtx ? 'crosshair' : 'default' }}
              onMouseEnter={() => {
                if (hlCtx) { hlCtx.current.band = [t - 0.07, t + 0.07]; hlCtx.current.redraw?.(); }
                onHlChange?.(t);
              }}
              onMouseLeave={hlLeave}
            >
              <div className="relative" style={{ position: 'relative' }}>
                <div className="h-5 w-full" style={{ background: color, minWidth: 80 }}/>
                {hlNorm !== null && Math.abs(hlNorm - t) < 0.07 && (
                  <div style={{ position:'absolute', inset:0, border:'2px solid white', boxShadow:'0 0 4px rgba(0,0,0,0.5)', pointerEvents:'none', borderRadius:1 }} />
                )}
              </div>
              <span className="text-sm text-gray-500 mt-0.5 font-inter leading-none">{label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">Log₁₀ scale · pathogen particles / grid cell / year</p>
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
          <div className="h-5 w-20" style={{ background: '#fff' }}/>
          <span className="text-sm text-gray-400 mt-0.5 font-inter leading-none">NA</span>
        </div>
        {/* Gradient bar with tick labels positioned under each stop */}
        <div className="flex-1">
          <div className="relative">
            <div className="h-5 rounded-sm w-full"
              style={{ background: LEGEND_GRADIENT, cursor: hlCtx ? 'crosshair' : 'default' }}
              onMouseMove={(e) => {
                if (!hlCtx) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const norm = (e.clientX - rect.left) / rect.width;
                hlCtx.current.band = [norm - 0.07, norm + 0.07];
                hlCtx.current.redraw?.();
                onHlChange?.(norm);
              }}
              onMouseLeave={hlLeave}
            />
            <BandOverlay norm={hlNorm} />
          </div>
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
      <p className="text-xs text-gray-400 mt-1">Log₁₀ scale · pathogen particles / grid cell / year</p>
    </div>
  );
}

function DiffLegend({ hlCtx, hlNorm, onHlChange, scale = 100 }) {
  const hlLeave = () => {
    if (hlCtx) { hlCtx.current.band = null; hlCtx.current.redraw?.(); }
    onHlChange?.(null);
  };
  const half = Math.round(scale / 2);
  const ticks = [
    `≤-${scale}%`,
    `-${half}%`,
    '0%',
    `+${half}%`,
    `≥+${scale}%`,
  ];
  return (
    <div className="mt-2">
      <div className="relative">
        <div className="h-5 rounded"
          style={{ background: 'linear-gradient(to right,rgb(20,83,45),rgb(187,247,208),#f3f4f6,rgb(254,202,202),rgb(153,27,27))', cursor: hlCtx ? 'crosshair' : 'default' }}
          onMouseMove={(e) => {
            if (!hlCtx) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const norm = (e.clientX - rect.left) / rect.width;
            hlCtx.current.band = [norm - 0.07, norm + 0.07];
            hlCtx.current.redraw?.();
            onHlChange?.(norm);
          }}
          onMouseLeave={hlLeave}
        />
        <BandOverlay norm={hlNorm} />
      </div>
      <div className="flex justify-between mt-0.5">
        {ticks.map(v => <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>)}
      </div>
      <p className="text-xs text-gray-400 mt-1">% change (green = decrease · red = increase)</p>
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
    if (!map.getPane('waterPane')) {
      const wp = map.createPane('waterPane');
      wp.style.zIndex = '540';
      wp.style.pointerEvents = 'none';
      wp.style.mixBlendMode = 'multiply';
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
            <p className="text-xs text-gray-400">pathogen particles / grid cell / year</p>
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

function GeoTiffLayer({ url, hlCtx }) {
  const map = useMap();
  const { heatmapView: smoothing, fixedColorScale, setDynamicLogMax } = useSettingsStore();

  useEffect(() => {
    if (!url) return;
    let layer = null;
    let cancelled = false;
    let rafId = null;

    (async () => {
      try {
        const ab = await fetch(url, { cache: 'no-store' }).then(r => r.arrayBuffer());
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
            const color = smoothing ? emissionColor(v, LOG_MIN, logMax) : emissionColorQuantized(v, LOG_MIN, logMax);
            const band = hlCtx?.current?.band;
            if (band) {
              const norm = Math.max(0, Math.min(1, (Math.log10(v) - LOG_MIN) / (logMax - LOG_MIN)));
              if (norm < band[0] || norm > band[1]) return 'rgba(200,200,200,0.15)';
            }
            return color;
          },
        });

        layer.on('tileload', (e) => {
          if (!e.tile) return;
          // Always crisp — cells should not blur into each other regardless of colour mode.
          e.tile.style.imageRendering = 'pixelated';
        });

        map.addLayer(layer);
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
      } catch (e) {
        console.error('GeoTIFF render error:', e);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (layer) map.removeLayer(layer);
      if (hlCtx) hlCtx.current.redraw = null;
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
      <button className={btnCls} onClick={() => map.zoomIn()} title="Zoom in">
        <Plus size={13}/>
      </button>
      <button className={btnCls} onClick={() => map.zoomOut()} title="Zoom out">
        <Minus size={13}/>
      </button>
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
  choroplethMode = false,
}) {
  const primRef = useRef(primaryIsoTotals);
  const compRef = useRef(isComparison);
  const secRef  = useRef(secondaryIsoTotals);
  const selRef  = useRef(selectedAreas);
  useEffect(() => { primRef.current = primaryIsoTotals; }, [primaryIsoTotals]);
  useEffect(() => { compRef.current = isComparison; secRef.current = secondaryIsoTotals; }, [isComparison, secondaryIsoTotals]);
  useEffect(() => { selRef.current = selectedAreas; }, [selectedAreas]);

  const choroplethModeRef = useRef(choroplethMode);
  useEffect(() => { choroplethModeRef.current = choroplethMode; }, [choroplethMode]);

  const hlCtx = useRef({ band: null, redraw: null });
  const [hlNorm, setHlNorm] = useState(null);
  const geoJsonLayerRef = useRef(null);

  const { heatmapView: smoothing, fixedColorScale, setDynamicLogMax } = useSettingsStore();
  const effectiveLogMax = fixedColorScale ? LOG_MAX : (useSettingsStore(s => s.dynamicLogMax) ?? LOG_MAX);

  // In choropleth mode the raster is never loaded, so set dynamic log scale from ISO totals
  // directly so the Legend component shows the right tick marks.
  useEffect(() => {
    if (!choroplethMode) return;
    if (fixedColorScale) { setDynamicLogMax(null); return; }
    const vals = Object.values(primaryIsoTotals || {}).filter(v => v > 0);
    if (vals.length > 0) setDynamicLogMax(Math.log10(Math.max(...vals)));
  }, [choroplethMode, primaryIsoTotals, fixedColorScale]); // eslint-disable-line

  // Wire hlCtx.current.redraw so the DiffLegend can trigger choropleth style refresh.
  // Only active when in choropleth mode — in raster mode the GeoTIFF layer owns redraw.
  const getStyleRef = useRef(null);
  useEffect(() => {
    if (!choroplethMode) return;
    hlCtx.current.redraw = () => geoJsonLayerRef.current?.setStyle(getStyleRef.current);
    return () => { hlCtx.current.redraw = null; };
  }, [choroplethMode]); // eslint-disable-line

  // Scale for the diverging diff colour map, derived from annual total emissions change.
  // Computed from per-area totals so it's available before the diff TIF loads.
  const emScale = useMemo(() => {
    if (!isComparison) return 100;
    const totalA = Object.values(primaryIsoTotals || {}).reduce((s, v) => s + v, 0);
    const totalB = Object.values(secondaryIsoTotals || {}).reduce((s, v) => s + v, 0);
    return totalA > 0 ? diffScale((totalB - totalA) / totalA * 100) : 100;
  }, [isComparison, primaryIsoTotals, secondaryIsoTotals]); // eslint-disable-line

  // Kept in a ref so stale useCallback closures (getStyle) always read the latest value.
  const emScaleRef = useRef(100);
  useEffect(() => { emScaleRef.current = emScale; }, [emScale]);

  // URL for the raw diff GeoTIFF endpoint (client-side rendering with band highlighting).
  const diffTifUrl = (isComparison && scenarioId && secondaryScenarioId && rasterFile)
    ? `/api/raster-diff-tif?scA=${scenarioId}&scB=${secondaryScenarioId}&fileA=${encodeURIComponent(rasterFile)}&fileB=${encodeURIComponent(secondaryRasterFile || rasterFile)}&_v=${rasterVersion || 0}`
    : null;
  const singleRasterUrl = (!isComparison && scenarioId && rasterFile)
    ? `/api/scenarios/${scenarioId}/output-raster/${rasterFile}?_v=${rasterVersion || 0}` : null;

  const getStyle = useCallback((feature) => {
    const iso = String(feature.properties.iso);
    const isSel = !selRef.current || selRef.current.has(iso);
    if (choroplethModeRef.current) {
      const val = primRef.current?.[iso];
      const secVal = compRef.current ? secRef.current?.[iso] : undefined;
      let fillColor;
      if (compRef.current && val != null && secVal != null) {
        const pct = val > 0 ? ((secVal - val) / val) * 100 : null;
        fillColor = diffColor(pct, emScaleRef.current);
        // Band highlight: dim polygons outside the selected % range
        const band = hlCtx.current?.band;
        if (band && pct != null) {
          const sc = emScaleRef.current || 100;
          const norm = Math.max(0, Math.min(1, (pct + sc) / (2 * sc)));
          if (norm < band[0] || norm > band[1]) {
            return { fillColor: '#d1d5db', fillOpacity: isSel ? 0.2 : 0.1,
                     color: '#1e293b', weight: 0.5, opacity: 0.2, pane: 'polygonPane' };
          }
        }
      } else {
        fillColor = val > 0 ? emissionColor(val) : '#e5e7eb';
      }
      return { fillColor, fillOpacity: isSel ? 0.85 : 0.25,
               color: '#1e293b', weight: 0.8, opacity: isSel ? 0.7 : 0.2, pane: 'polygonPane' };
    }
    return { fillColor: 'transparent', fillOpacity: 0,
             color: '#1e293b', weight: 0.6, opacity: isSel ? 0.5 : 0.15, pane: 'polygonPane' };
  }, []);
  // Keep a stable ref so the redraw closure can always call the latest getStyle
  getStyleRef.current = getStyle;

  const onAreaClickRef = useRef(onAreaClick);
  useEffect(() => { onAreaClickRef.current = onAreaClick; }, [onAreaClick]);

  const onEachFeature = useCallback((feature, layer) => {
    const iso = feature.properties.iso;
    const isoKey = String(iso);
    const name = feature.properties.NAME_4 || feature.properties.NAME_3 || feature.properties.NAME_2 || feature.properties.NAME_1 || feature.properties.NAME_0 || feature.properties.subarea || areaNames?.[isoKey] || `Area ${iso}`;
    layer.on('mouseover', () => {
      const val = primRef.current?.[isoKey];
      const secVal = secRef.current?.[isoKey];
      const pct = (compRef.current && val > 0 && secVal != null) ? ((secVal - val) / val) * 100 : null;
      const tip = (pct !== null)
        ? `<strong>${name}</strong><br/>${formatScientific(val||0)} \u2192 ${formatScientific(secVal||0)}<br/>${pct >= 0 ? '+' : ''}${pct?.toFixed(1)}%`
        : `<strong>${name}</strong><br/>${formatScientific(val||0)} vp`;
      layer.bindTooltip(tip, { sticky: true });
      if (choroplethModeRef.current) {
        // In choropleth mode keep the fill; only highlight the border
        layer.setStyle({ weight: 2.5, color: '#0f172a', opacity: 1, pane: 'polygonPane' });
      } else {
        layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, weight: 1.5, color: '#0f172a', opacity: 0.9, pane: 'polygonPane' });
      }
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      // Re-apply full style (includes band-dim logic) so comparison highlighting is respected.
      layer.setStyle(getStyle(feature));
    });
    layer.on('click', () => onAreaClickRef.current?.({ iso, name }));
  }, [areaNames, getStyle]);

  const geoKey = `${scenarioId}-${secondaryScenarioId}-${Object.keys(primaryIsoTotals || {}).length}-${isComparison}-${selectedAreas?.size ?? 'all'}-${emissionType}-ch${choroplethMode?1:0}-sm${smoothing?1:0}-sc${emScale}`;

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
              className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='water' ? 'bg-white text-wpBlue' : 'text-wpBlue-100 bg-wpGray-100 hover:bg-wpGray-300'}`}>
              <img src={SurfaceWaterIcon} alt="" className="w-8 h-8" style={emissionType !== 'water' ? {opacity:'0.5'} : {}}/> Surface Water
            </button>
            <button onClick={() => onChangeEmissionType('land')}
              className={`flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors ${emissionType==='land' ? 'bg-white text-wpBlue' : 'text-wpBlue-100 bg-wpGray-100 hover:bg-wpGray-300'}`}>
              <img src={LandIcon} alt="" className="w-8 h-8" style={emissionType !== 'land' ? {opacity:'0.5'} : {}}/> Land
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
                <OpenFreeMapLayer />
                <CreateBlendPane/>
                {/* Single raster: GeoTIFF rendered via georaster-layer-for-leaflet with proj4 CRS support.
                    Skipped in choropleth mode — area is too small for the raster grid, polygons are
                    filled directly with emission colours instead. */}
                {!choroplethMode && singleRasterUrl && <GeoTiffLayer url={singleRasterUrl} hlCtx={hlCtx} />}
                {/* Diff raster: client-side GeoTIFF rendering (skipped in choropleth mode —
                    polygon fill uses diffColor() per area instead). Band highlighting works
                    because pixelValuesToColorFn checks hlCtx.current.band live. */}
                {!choroplethMode && isComparison && diffTifUrl && (
                  <HydrologyDiffGeoTiffLayer
                    key={`${diffTifUrl}-${emScale}`}
                    url={diffTifUrl}
                    scale={emScale}
                    colorFn={diffColor}
                    hlCtx={hlCtx}
                    onError={() => {}}
                  />
                )}
                <LeafletGeoJSON key={geoKey} ref={geoJsonLayerRef} data={geojson} style={getStyle} onEachFeature={onEachFeature}/>
                <FitBounds geojson={geojson}/>
                <MapExportControls title={title}/>
                <LegendMapTooltip hlNorm={hlNorm} effectiveLogMax={effectiveLogMax} isDiff={isComparison} diffScale={emScale} />
              </MapContainer>
            </div>
            {isComparison ? <DiffLegend hlCtx={hlCtx} hlNorm={hlNorm} onHlChange={setHlNorm} scale={emScale}/> : <Legend hlCtx={hlCtx} hlNorm={hlNorm} onHlChange={setHlNorm}/>}
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
              <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">Combined pathogen particle emissions across all areas, sanitation technologies, and emission pathways (pathogen particles / year).</p>
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
  const landDiffPct = isComparison && priLand > 0 ? ((secLand - priLand) / priLand) * 100 : null;
  const humDiffPct = isComparison && humTotal > 0 ? ((secHumTotal - humTotal) / humTotal) * 100 : null;

  const livestockCol = hasLivestock && (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Livestock</p>
        {emissionType === 'water' && (
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-semibold tabular-nums ${isComparison ? 'opacity-40 text-gray-600' : 'text-gray-600'}`}>{formatScientific(priLand)}</span>
            {isComparison && <span className="text-sm font-semibold tabular-nums text-wpBlue">{formatScientific(secLand)}</span>}
            {landDiffPct !== null && (
              <span className={`text-xs font-semibold ${landDiffPct > 0 ? 'text-red-600' : landDiffPct < 0 ? 'text-green-600' : 'text-gray-500'}`}>{fmtPct(landDiffPct)}</span>
            )}
          </div>
        )}
      </div>
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
                      <div className="absolute w-2.5 h-2.5 rounded-full bg-wpBlue border-2 border-white shadow-sm"
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

  // ── WWTP column (surface water mode only) ──────────────────────────────────
  const wwtpDiffPct = isComparison && priWwtp > 0 ? ((secWwtp - priWwtp) / priWwtp) * 100 : null;

  const wwtpCol = emissionType === 'water' && (priWwtp > 0 || secWwtp > 0) && (
    <div className="space-y-4">
      <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">WWTP</p>
      <p className="text-xs text-gray-400 -mt-2">Pathogens remaining in wastewater treatment plant effluent discharged to surface water.</p>
      <div className="flex gap-4 min-h-0">
        <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Total Effluent</p>
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold tabular-nums ${isComparison ? 'opacity-40' : ''}`}>{formatScientific(priWwtp)}</span>
            {isComparison && <span className="text-sm font-bold tabular-nums text-wpBlue">{formatScientific(secWwtp)}</span>}
            {wwtpDiffPct !== null && (
              <span className={`text-xs font-semibold ${wwtpDiffPct > 0 ? 'text-red-600' : wwtpDiffPct < 0 ? 'text-green-600' : 'text-gray-500'}`}>
                {fmtPct(wwtpDiffPct)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // ── Distribution bar ─────────────────────────────────────────────────────────
  const BAR_DEFS = emissionType === 'water'
    ? [
        { key: 'humans',    label: 'Humans',    color: '#0B4159', priV: humTotal,   secV: secHumTotal },
        { key: 'livestock', label: 'Livestock', color: '#D97706', priV: priLand,    secV: secLand     },
        { key: 'wwtp',      label: 'WWTP',      color: '#18B6A3', priV: priWwtp,    secV: secWwtp     },
      ]
    : [
        { key: 'humans',    label: 'Humans',    color: '#0B4159', priV: humTotal,   secV: secHumTotal },
        { key: 'livestock', label: 'Livestock', color: '#D97706', priV: priLsTotal, secV: secLsTotal  },
      ];

  const activeBarSegs = BAR_DEFS.filter(s => s.priV > 0 || s.secV > 0);
  const priBarTotal = activeBarSegs.reduce((s, seg) => s + seg.priV, 0) || 1;
  const secBarTotal = activeBarSegs.reduce((s, seg) => s + seg.secV, 0) || 1;

  const distributionBar = activeBarSegs.length > 1 && (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden">
        {activeBarSegs.map(seg => {
          const pct = (seg.priV / priBarTotal) * 100;
          if (pct < 0.05) return null;
          return <div key={seg.key} style={{ width: `${pct.toFixed(2)}%`, backgroundColor: seg.color }} title={`${seg.label}: ${formatScientific(seg.priV)}`} />;
        })}
      </div>
      {isComparison && (
        <div className="flex h-1.5 rounded-full overflow-hidden opacity-50">
          {activeBarSegs.map(seg => {
            const pct = (seg.secV / secBarTotal) * 100;
            if (pct < 0.05) return null;
            return <div key={seg.key} style={{ width: `${pct.toFixed(2)}%`, backgroundColor: seg.color }} title={`${seg.label}: ${formatScientific(seg.secV)}`} />;
          })}
        </div>
      )}
      <div className="flex gap-4 flex-wrap">
        {activeBarSegs.map(seg => {
          const pct = (seg.priV / priBarTotal) * 100;
          const secPct = (seg.secV / secBarTotal) * 100;
          return (
            <div key={seg.key} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-xs text-gray-500">{seg.label}</span>
              <span className={`text-xs font-semibold tabular-nums ${isComparison ? 'opacity-50 text-gray-600' : 'text-gray-600'}`}>{fmtBarPct(pct)}%</span>
              {isComparison && <span className="text-xs font-semibold tabular-nums text-wpBlue">{fmtBarPct(secPct)}%</span>}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Layout ─────────────────────────────────────────────────────────────────

  if (hasLivestock) {
    return (
      <div className="space-y-4 pt-6">
        {distributionBar}
        <div className={`grid ${wwtpCol ? 'grid-cols-3' : 'grid-cols-2'} gap-0 divide-x divide-gray-100`}>
        {/* Left column: Humans */}
        <div className="space-y-4 pr-6">
          {emissionType === 'water' && (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Humans</p>
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-semibold tabular-nums ${isComparison ? 'opacity-40 text-gray-600' : 'text-gray-600'}`}>{formatScientific(humTotal)}</span>
                  {isComparison && <span className="text-sm font-semibold tabular-nums text-wpBlue">{formatScientific(secHumTotal)}</span>}
                  {humDiffPct !== null && (
                    <span className={`text-xs font-semibold ${humDiffPct > 0 ? 'text-red-600' : humDiffPct < 0 ? 'text-green-600' : 'text-gray-500'}`}>{fmtPct(humDiffPct)}</span>
                  )}
                </div>
              </div>
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
        {/* Middle column: Livestock */}
        <div className={wwtpCol ? 'px-6' : 'pl-6'}>
          {livestockCol}
        </div>
        {/* Right column: WWTP (surface water mode only) */}
        {wwtpCol && (
          <div className="pl-6">
            {wwtpCol}
          </div>
        )}
        </div>
      </div>
    );
  }

  // Layout: two-column when WWTP data available (water mode), single-column otherwise
  if (wwtpCol) {
    return (
      <div className="space-y-4 pt-6">
        {distributionBar}
        <div className="grid grid-cols-2 gap-0 divide-x divide-gray-100">
        {/* Left column: Humans */}
        <div className="space-y-4 pr-6">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Humans</p>
            <div className="flex items-baseline gap-2">
              <span className={`text-sm font-semibold tabular-nums ${isComparison ? 'opacity-40 text-gray-600' : 'text-gray-600'}`}>{formatScientific(humTotal)}</span>
              {isComparison && <span className="text-sm font-semibold tabular-nums text-wpBlue">{formatScientific(secHumTotal)}</span>}
              {humDiffPct !== null && (
                <span className={`text-xs font-semibold ${humDiffPct > 0 ? 'text-red-600' : humDiffPct < 0 ? 'text-green-600' : 'text-gray-500'}`}>{fmtPct(humDiffPct)}</span>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-400 -mt-2">Emissions originating from human sanitation systems, broken down by technology and toilet category.</p>
          <div className="flex gap-4 min-h-0">
            <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
            {toiletCategoryCol}
            <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />
            {contribTechCol}
          </div>
        </div>
        {/* Right column: WWTP */}
        <div className="pl-6">
          {wwtpCol}
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-6">
      {distributionBar}
      {emissionType === 'water' && (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-md font-semibold text-wpBlue uppercase font-outfit tracking-wide">Humans</p>
            <div className="flex items-baseline gap-2">
              <span className={`text-sm font-semibold tabular-nums ${isComparison ? 'opacity-40 text-gray-600' : 'text-gray-600'}`}>{formatScientific(humTotal)}</span>
              {isComparison && <span className="text-sm font-semibold tabular-nums text-wpBlue">{formatScientific(secHumTotal)}</span>}
              {humDiffPct !== null && (
                <span className={`text-xs font-semibold ${humDiffPct > 0 ? 'text-red-600' : humDiffPct < 0 ? 'text-green-600' : 'text-gray-500'}`}>{fmtPct(humDiffPct)}</span>
              )}
            </div>
          </div>
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

// ─── HydrologyMapSection ─────────────────────────────────────────────────────────────────────────

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── HydrologyGeoTiffLayer ────────────────────────────────────────────────────────────────────────
// Like GeoTiffLayer but always auto-ranges from the raster's own maximum and never
// writes to the global settingsStore (avoids corrupting the emissions map's legend scale).

function HydrologyGeoTiffLayer({ url, hlCtx }) {
  const map = useMap();
  const { heatmapView: smoothing } = useSettingsStore();

  useEffect(() => {
    if (!url) return;
    let layer = null;
    let cancelled = false;
    let rafId = null;

    (async () => {
      try {
        const ab = await fetch(url).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;

        const nd = gr.noDataValue;
        const logMax = (gr.maxs?.[0] > 0) ? Math.log10(gr.maxs[0]) : LOG_MAX;

        layer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.85,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: (values) => {
            const v = values[0];
            if (v == null || !isFinite(v) || v <= 0 || v === nd) return null;
            const color = hydroAbsColor(v, LOG_MIN, logMax);
            const band = hlCtx?.current?.band;
            if (band && color) {
              const norm = Math.max(0, Math.min(1, (Math.log10(v) - LOG_MIN) / (logMax - LOG_MIN)));
              if (norm < band[0] || norm > band[1]) return 'rgba(200,200,200,0.15)';
            }
            return color;
          },
        });

        layer.on('tileload', (e) => {
          if (e.tile) e.tile.style.imageRendering = 'pixelated';
        });

        map.addLayer(layer);
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
      } catch (e) {
        console.error('Hydrology GeoTIFF render error:', e);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (layer) map.removeLayer(layer);
      if (hlCtx) hlCtx.current.redraw = null;
    };
  }, [url, map, smoothing]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function hydroDiffColor(pct, scale = 100) {
  if (!isFinite(pct)) return null;
  if (scale > 0 && Math.abs(pct) / scale < 0.005) return '#f5f5f5';
  const t = Math.min(1, Math.abs(pct) / (scale || 100));
  if (pct > 0) {
    // white → orange → deep red
    const r = lerp(245, 178, t); // stays high
    const g = lerp(245,  24, t);
    const b = lerp(245,  43, t);
    return `rgb(${r},${g},${b})`;
  } else {
    // white → cornflower → deep blue
    const r = lerp(245,  33, t);
    const g = lerp(245, 102, t);
    const b = lerp(245, 172, t);
    return `rgb(${r},${g},${b})`;
  }
}

function HydrologyDiffGeoTiffLayer({ url, hlCtx, onError, onStats, scale: scaleProp, colorFn }) {
  const map = useMap();

  useEffect(() => {
    if (!url) return;
    let layer = null;
    let cancelled = false;
    let rafId = null;

    (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) { if (!cancelled) onError?.(); return; }
        const ab = await res.arrayBuffer();
        const gr = await parseGeoraster(ab);
        if (cancelled) return;

        const nd = gr.noDataValue;

        // Compute actual min/max of valid diff values for adaptive colour scale
        let vmin = Infinity, vmax = -Infinity;
        for (const row of gr.values[0]) {
          for (const v of row) {
            if (v != null && isFinite(v) && v !== nd) {
              if (v < vmin) vmin = v;
              if (v > vmax) vmax = v;
            }
          }
        }
        if (!isFinite(vmin)) { if (!cancelled) onError?.(); return; }
        const absMax = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1;
        // Use passed scale if provided (e.g. from annual total change); else auto-range from pixels.
        const scale = (scaleProp != null) ? scaleProp : diffScale(absMax);
        if (!cancelled) onStats?.({ min: vmin, max: vmax, absMax, scale });

        layer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.85,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: (values) => {
            const v = values[0];
            if (v == null || !isFinite(v) || v === nd) return null;
            const color = (colorFn || hydroDiffColor)(v, scale);
            const band = hlCtx?.current?.band;
            if (band && color) {
              const norm = Math.max(0, Math.min(1, (v + scale) / (2 * scale)));
              if (norm < band[0] || norm > band[1]) return 'rgba(200,200,200,0.15)';
            }
            return color;
          },
        });

        layer.on('tileload', (e) => {
          if (e.tile) e.tile.style.imageRendering = 'pixelated';
        });

        map.addLayer(layer);
        if (hlCtx) {
          hlCtx.current.redraw = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => layer?.redraw());
          };
        }
      } catch (e) {
        console.error('Hydrology diff GeoTIFF render error:', e);
        if (!cancelled) onError?.();
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (layer) map.removeLayer(layer);
      if (hlCtx) hlCtx.current.redraw = null;
    };
  }, [url, map]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ─── HydroInputRasterLayer ───────────────────────────────────────────────────────────────────────
// Generic GeoTIFF overlay for input rasters (temperature, SSRD, etc.).
// colorFn(norm: 0–1) → CSS colour string. Normalises against the raster's own min/max.

function HydroInputRasterLayer({ url, colorFn, opacity = 0.75, onStats }) {
  const map = useMap();

  useEffect(() => {
    if (!url || !colorFn) return;
    let layer = null;
    let cancelled = false;

    (async () => {
      try {
        const ab = await fetch(url).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;
        const nd = gr.noDataValue;
        // Compute finite min/max for normalisation
        let vmin = Infinity, vmax = -Infinity;
        for (const row of gr.values[0]) {
          for (const v of row) {
            if (v == null || !isFinite(v) || v === nd) continue;
            if (v < vmin) vmin = v;
            if (v > vmax) vmax = v;
          }
        }
        if (!isFinite(vmin)) return;
        if (onStats) onStats({ min: vmin, max: vmax });
        const range = vmax - vmin || 1;
        layer = new GeoRasterLayer({
          georaster: gr,
          opacity,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: (values) => {
            const v = values[0];
            if (v == null || !isFinite(v) || v === nd) return null;
            const norm = Math.max(0, Math.min(1, (v - vmin) / range));
            return colorFn(norm);
          },
        });
        layer.on('tileload', (e) => { if (e.tile) e.tile.style.imageRendering = 'pixelated'; });
        map.addLayer(layer);
      } catch (e) {
        console.error('HydroInputRasterLayer error:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (layer) map.removeLayer(layer);
    };
  }, [url, colorFn, opacity, map]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ─── FlowArrowLayer ───────────────────────────────────────────────────────────────────────────────
// Fetches flow-vector GeoJSON from the backend and renders D8-direction arrows on a canvas layer.
// Arrow size scales with log(flow accumulation); arrow colour scales with discharge.
// Only arrows above the "significant river" threshold (acc >= backend threshold) are rendered.

function FlowArrowLayer({ scenarioId, month, minAccPct = 0, onLegendData }) {
  const map = useMap();

  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    let rafId = null;
    let features = [];
    let cellDegX = 0;
    let cellDegY = 0;

    const container = map.getContainer();
    const canvasEl  = document.createElement('canvas');
    canvasEl.className = 'leaflet-flow-arrow-layer';
    canvasEl.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:590;';
    container.appendChild(canvasEl);

    const resizeCanvas = () => {
      const size = map.getSize();
      canvasEl.width  = size.x;
      canvasEl.height = size.y;
    };
    resizeCanvas();
    const ctx = canvasEl.getContext('2d');

    const drawArrows = () => {
      if (!features.length) return;
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

      const disVals = features.map(f => f.properties.discharge).filter(v => v != null && v > 0);
      const maxDis  = disVals.length ? Math.max(...disVals) : 1;

      // Flow accumulation: log-scale fallback when depth unavailable
      const accVals   = features.map(f => f.properties.acc).filter(v => v > 0);
      const logMaxAcc = accVals.length ? Math.log10(Math.max(...accVals)) : 6;

      // Depth: used for arrow sizing when available (physically meaningful channel size)
      const hasDepth  = features.some(f => f.properties.depth != null && f.properties.depth > 0);
      const depVals   = hasDepth ? features.map(f => f.properties.depth ?? 0).filter(v => v > 0) : [];
      const logMaxDep = hasDepth ? Math.log10(Math.max(...depVals, 0.01)) : 0;
      const logMinDep = hasDepth ? Math.log10(Math.max(Math.min(...depVals), 0.001)) : 0;

      // Cell size in screen pixels
      const refFeat = features[Math.floor(features.length / 2)];
      const [refLon, refLat] = refFeat.geometry.coordinates;
      const ptRef  = map.latLngToContainerPoint([refLat, refLon]);
      const ptOffX = map.latLngToContainerPoint([refLat, refLon + (cellDegX || 0.5)]);
      const ptOffY = map.latLngToContainerPoint([refLat + (cellDegY || 0.5), refLon]);
      const cellPxW = Math.abs(ptOffX.x - ptRef.x);
      const cellPxH = Math.abs(ptOffY.y - ptRef.y);
      const arrowSz = Math.max(8, Math.min(120, Math.min(cellPxW, cellPxH) * 0.75));

      const bounds = map.getBounds();

      for (const feat of features) {
        const [lon, lat] = feat.geometry.coordinates;
        if (!bounds.contains([lat, lon])) continue;

        const bearing = feat.properties.bearing ?? 0;
        const dis     = feat.properties.discharge;
        const acc     = feat.properties.acc ?? 1;
        const depth   = feat.properties.depth;

        // Colour: pale cyan (#a1ebe3) for low discharge → wpTeal (#18B6A3) → dark teal (#0d6b63) for high
        let arrowColor = '#18B6A3';
        if (dis != null && dis > 0) {
          const t = Math.min(1, Math.log10(Math.max(dis, 1)) / Math.log10(Math.max(maxDis, 2)));
          arrowColor = `rgb(${Math.round(161 - t * 148)},${Math.round(235 - t * 128)},${Math.round(227 - t * 128)})`;
        }

        // Size / weight: prefer depth (hydraulic channel size) over acc (topographic)
        let sizeNorm;
        if (hasDepth && depth != null && depth > 0) {
          const logDep = Math.log10(Math.max(depth, 0.001));
          sizeNorm = logMaxDep > logMinDep ? Math.max(0, Math.min(1, (logDep - logMinDep) / (logMaxDep - logMinDep))) : 0.5;
        } else {
          const logAcc = Math.log10(Math.max(acc, 1));
          sizeNorm = logMaxAcc > 0 ? logAcc / logMaxAcc : 0.5;
        }

        const lineWidth = (0.08 + sizeNorm * 0.22) * arrowSz;

        const pt      = map.latLngToContainerPoint([lat, lon]);
        const rad     = (bearing - 90) * (Math.PI / 180);
        const stemLen = arrowSz * 0.7;
        const hw      = arrowSz * 0.28 * (0.5 + sizeNorm * 0.5); // head scales with channel size
        const hl      = arrowSz * 0.44 * (0.5 + sizeNorm * 0.5);

        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.translate(pt.x, pt.y);
        ctx.rotate(rad);

        ctx.beginPath();
        ctx.moveTo(-stemLen / 2, 0);
        ctx.lineTo(stemLen / 2, 0);
        ctx.strokeStyle = arrowColor;
        ctx.lineWidth   = Math.max(0.8, lineWidth);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(stemLen / 2, 0);
        ctx.lineTo(stemLen / 2 - hl, -hw);
        ctx.lineTo(stemLen / 2 - hl,  hw);
        ctx.closePath();
        ctx.fillStyle = arrowColor;
        ctx.fill();

        ctx.restore();
      }
    };

    const scheduleRedraw = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(drawArrows);
    };

    const onMove   = () => scheduleRedraw();
    const onResize = () => { resizeCanvas(); scheduleRedraw(); };
    map.on('move moveend zoomend', onMove);
    map.on('resize', onResize);

    const monthParam = month === 'avg' ? 'avg' : month;
    fetch(`/api/scenarios/${scenarioId}/hydrology-flow-vectors?month=${monthParam}&spacing=1&min_acc_pct=${minAccPct}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        features  = data.features || [];
        cellDegX  = data.cell_deg_x || 0.5;
        cellDegY  = data.cell_deg_y || 0.5;
        console.log(`[FlowArrowLayer] encoding=${data.encoding}, features=${features.length}, threshold=${minAccPct}% of max`);
        // Compute legend range from data
        const disVals2 = features.map(f => f.properties.discharge).filter(v => v != null && v > 0);
        const hasAcc   = features.some(f => f.properties.acc > 1);
        const hasDepthData = features.some(f => f.properties.depth != null && f.properties.depth > 0);
        if (!cancelled) onLegendData?.({
          minDis: disVals2.length ? Math.min(...disVals2) : null,
          maxDis: disVals2.length ? Math.max(...disVals2) : null,
          hasDischarge: disVals2.length > 0,
          hasAcc,
          hasDepth: hasDepthData,
        });
        scheduleRedraw();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      map.off('move moveend zoomend', onMove);
      map.off('resize', onResize);
      if (canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    };
  }, [scenarioId, month, minAccPct, map]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ─── HydroMapControls ────────────────────────────────────────────────────────────────────────────
// Absolutely-positioned panel rendered inside the MapContainer.
// Hosts all hydrology map toggles (Flow, Temp, SSRD, Runoff) and the river-network density slider.

const LAYER_INFO = {
  flow:   'D8 flow-direction arrows from a routing model. Arrow width scales with stream size (flow accumulation % of basin max); colour scales with discharge (m³/s). The "Streams" slider sets the minimum catchment size shown — slide left to reveal headwater streams, right to show only major rivers.',
  temp:   'Monthly or annual average river water temperature (°C) from climate input data.',
  ssrd:   'Surface downwelling shortwave solar radiation (MJ m⁻²). Higher radiation accelerates pathogen die-off in open water.',
  runoff: 'Overland surface runoff (mm or m³/s per cell) — water that flows across the land surface before entering channels. High-runoff areas are the main pathways for flushing pathogens from land into rivers.',
};

function HydroMapControls({ activeOverlay, setActiveOverlay, minAccPct, setMinAccPct, hasTempData, hasSsrdData, hasRunoffData, tempStats, ssrdStats, runoffStats, flowLegend }) {
  const panelRef   = useRef(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const showFlow   = activeOverlay === 'flow';
  const showTemp   = activeOverlay === 'temp';
  const showSsrd   = activeOverlay === 'ssrd';
  const showRunoff = activeOverlay === 'runoff';
  const toggle     = (layer) => setActiveOverlay(prev => prev === layer ? null : layer);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }, []);

  return (
    <div
      ref={panelRef}
      style={{ position: 'absolute', bottom: 36, left: 8, zIndex: 650 }}
      className="bg-white/90 backdrop-blur-sm rounded-lg shadow border border-gray-100 px-3 py-2.5 flex flex-col gap-1.5 min-w-[168px]"
    >
      {/* Header row with hover-info button */}
      <div className="flex items-center justify-between mb-0.5">
        <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-400">Layers</div>
        <div className="relative">
          <button
            onMouseEnter={() => setInfoOpen(true)}
            onMouseLeave={() => setInfoOpen(false)}
            className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center bg-gray-100 text-gray-400 hover:bg-gray-200 transition-colors flex-shrink-0"
          >i</button>
          {/* Floating popover — appears to the right of the panel */}
          {infoOpen && (
            <div
              style={{ position: 'absolute', bottom: 0, left: 'calc(100% + 8px)', zIndex: 700, width: 260 }}
              className="bg-white rounded-lg shadow-lg border border-gray-100 px-3 py-2.5 text-[9px] text-gray-500 leading-relaxed space-y-2"
            >
              <div><span className="font-semibold text-gray-700">Flow: </span>{LAYER_INFO.flow}</div>
              {hasTempData   && <div><span className="font-semibold text-gray-700">River temperature: </span>{LAYER_INFO.temp}</div>}
              {hasSsrdData   && <div><span className="font-semibold text-gray-700">Solar radiation: </span>{LAYER_INFO.ssrd}</div>}
              {hasRunoffData && <div><span className="font-semibold text-gray-700">Runoff: </span>{LAYER_INFO.runoff}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Flow toggle */}
      <button
        onClick={() => toggle('flow')}
        className={`flex items-center justify-between gap-3 px-2 py-1 rounded text-xs font-medium transition-colors ${showFlow ? 'bg-wpBlue text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
      >
        <span>Flow</span>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showFlow ? 'bg-white/70' : 'bg-gray-300'}`} />
      </button>

      {/* Stream threshold slider + discharge legend */}
      {showFlow && (
        <div className="flex flex-col gap-1 px-1 pb-0.5">
          <div className="flex justify-between text-[9px] text-gray-400">
            <span>Streams</span>
            <span className="text-gray-300">{minAccPct}% of max</span>
          </div>
          <input
            type="range" min="0" max="50" step="5" value={minAccPct}
            onChange={e => setMinAccPct(Number(e.target.value))}
            className="w-full h-1 cursor-pointer accent-wpBlue"
          />
          <div className="flex justify-between text-[8px] text-gray-300">
            <span>all sizes</span><span>major only</span>
          </div>
          {flowLegend && (
            <div className="mt-1">
              {flowLegend.hasDischarge ? (
                <>
                  <div className="text-[9px] text-gray-400 mb-0.5">Discharge (m³/s)</div>
                  <div className="h-2.5 w-full rounded" style={{ background: 'linear-gradient(to right, #a1ebe3, #18B6A3, #0d6b63)' }} />
                  <div className="flex justify-between text-[8px] text-gray-400 mt-0.5">
                    <span>{flowLegend.minDis == null ? '—' : flowLegend.minDis >= 1000 ? `${(flowLegend.minDis/1000).toFixed(1)} k` : flowLegend.minDis.toFixed(1)}</span>
                    <span>{flowLegend.maxDis == null ? '—' : flowLegend.maxDis >= 1000 ? `${(flowLegend.maxDis/1000).toFixed(1)} k` : flowLegend.maxDis.toFixed(1)}</span>
                  </div>
                  <div className="text-[8px] text-gray-300 mt-1">
                    {flowLegend.hasDepth ? 'Width = river depth' : 'Width = flow accumulation'}
                  </div>
                </>
              ) : (
                <div className="text-[9px] text-gray-300">No discharge data</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Temperature toggle + legend */}
      {hasTempData && (
        <>
          <button
            onClick={() => toggle('temp')}
            className={`flex items-center justify-between gap-3 px-2 py-1 rounded text-xs font-medium transition-colors ${showTemp ? 'bg-wpBlue text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
          >
            <span>River temperature</span>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showTemp ? 'bg-white/70' : 'bg-gray-300'}`} />
          </button>
          {showTemp && (
            <div className="px-1 pb-0.5">
              <div className="h-3.5 w-full rounded" style={{ background: TEMP_LEGEND_GRADIENT }} />
              <div className="flex justify-between text-[8px] text-gray-400 mt-0.5">
                <span>{tempStats ? `${tempStats.min.toFixed(1)} °C` : '...'}</span>
                <span>{tempStats ? `${tempStats.max.toFixed(1)} °C` : '...'}</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* SSRD toggle + legend */}
      {hasSsrdData && (
        <>
          <button
            onClick={() => toggle('ssrd')}
            className={`flex items-center justify-between gap-3 px-2 py-1 rounded text-xs font-medium transition-colors ${showSsrd ? 'bg-wpBlue text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
          >
            <span>Solar radiation</span>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showSsrd ? 'bg-white/70' : 'bg-gray-300'}`} />
          </button>
          {showSsrd && (
            <div className="px-1 pb-0.5">
              <div className="h-3.5 w-full rounded" style={{ background: SSRD_LEGEND_GRADIENT }} />
              <div className="flex justify-between text-[8px] text-gray-400 mt-0.5">
                {ssrdStats
                  ? <><span>{(ssrdStats.min / 1e6).toFixed(1)} MJ m⁻²</span><span>{(ssrdStats.max / 1e6).toFixed(1)} MJ m⁻²</span></>
                  : <><span>low</span><span>high (MJ m⁻²)</span></>}
              </div>
            </div>
          )}
        </>
      )}

      {/* Runoff toggle + legend */}
      {hasRunoffData && (
        <>
          <button
            onClick={() => toggle('runoff')}
            className={`flex items-center justify-between gap-3 px-2 py-1 rounded text-xs font-medium transition-colors ${showRunoff ? 'bg-wpBlue text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
          >
            <span>Runoff</span>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showRunoff ? 'bg-white/70' : 'bg-gray-300'}`} />
          </button>
          {showRunoff && (
            <div className="px-1 pb-0.5">
              <div className="h-3.5 w-full rounded" style={{ background: RUNOFF_LEGEND_GRADIENT }} />
              <div className="flex justify-between text-[8px] text-gray-400 mt-0.5">
                <span>{runoffStats ? `${runoffStats.min.toFixed(1)} mm` : 'low'}</span>
                <span>{runoffStats ? `${runoffStats.max.toFixed(1)} mm` : 'high'}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── MapWithSidePanel ─────────────────────────────────────────────────────────────────────────────
// Shared layout wrapper used by Concentrations and Risk tabs.
// Renders a white card with map (flex:2) on the left and info panel (flex:1) on the right.

function MapWithSidePanel({
  title, titleControls, isComparison, hasGeodata = true,
  mapChildren, legendChildren, sidePanelChildren,
  height = 480,
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      {(title || titleControls) && (
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h3 className="font-semibold text-wpBlue uppercase flex items-center gap-2">
            {title}
            {isComparison && (
              <span className="ml-1 text-xs font-normal text-wpTeal bg-wpTeal/10 px-1.5 py-0.5 rounded">comparison</span>
            )}
          </h3>
          {titleControls}
        </div>
      )}
      {hasGeodata ? (
        <div className="flex gap-3" style={{ height }}>
          <div className="flex flex-col min-w-0" style={{ flex: 2 }}>
            <div className="rounded overflow-hidden border border-gray-100 flex-1">
              {mapChildren}
            </div>
            {legendChildren}
          </div>
          <div className="flex flex-col border-l border-gray-100 pl-3 overflow-hidden" style={{ flex: 1 }}>
            {sidePanelChildren}
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

// ─── Concentration area dialog ────────────────────────────────────────────────────────────────
// Shown when a polygon on the Concentrations map is clicked. Displays the annual-average
// concentration for that area alongside the calendar month with the highest concentration.

function ConcentrationAreaDialog({ area, avgAreaStats, onClose }) {
  if (!area) return null;
  const M3_TO_L = 1000;
  const stats = avgAreaStats?.[area.iso];

  const peakMonth = stats?.peak_month ?? null;
  const peakVal   = peakMonth != null ? stats?.by_month?.[String(peakMonth)] : null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
          <div>
            <p className="font-semibold text-gray-900">{area.name}</p>
            <p className="text-xs text-gray-400">pathogen particles / L</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-200"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {stats ? (
            <>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Monthly average</p>
                <p className="text-2xl font-bold font-outfit tabular-nums text-wpBlue">{formatScientific((stats.mean ?? 0) / M3_TO_L)}</p>
              </div>
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Highest month</p>
                {peakMonth != null ? (
                  <div className="flex items-baseline gap-2">
                    <p className="text-2xl font-bold font-outfit tabular-nums text-wpTeal">{MONTH_LABELS[peakMonth - 1]}</p>
                    {peakVal != null && (
                      <span className="text-sm font-mono text-gray-500">{formatScientific(peakVal / M3_TO_L)}</span>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 italic">No monthly breakdown available</p>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-400 italic">No data available for this area</p>
          )}
        </div>
      </div>
    </div>
  );
}

function HydrologyMapSection({ scenarioId, geojson, hydrologyFiles, secondaryScenarioId, areaNames, pathogen }) {
  // 'avg' = averaged view (default); 1–12 = specific month
  const [month,        setMonth]        = useState('avg');
  const [showDiff,     setShowDiff]     = useState(true);  // show % deviation from avg when month selected
  const [activeOverlay, setActiveOverlay] = useState(null); // null | 'flow' | 'temp' | 'ssrd' | 'runoff'
  const [minAccPct,    setMinAccPct]    = useState(5);     // river network density filter
  const [tempStats,    setTempStats]    = useState(null);  // {min, max} from loaded temp raster
  const [ssrdStats,    setSsrdStats]    = useState(null);  // {min, max} from loaded ssrd raster
  const [runoffStats,  setRunoffStats]  = useState(null);  // {min, max} from loaded runoff raster
  const [flowLegend,   setFlowLegend]   = useState(null);  // {minDis, maxDis, hasDischarge, hasAcc}
  const [rasterStats,  setRasterStats]  = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [monthlyStats, setMonthlyStats] = useState(null);
  const [secondaryMonthlyStats, setSecondaryMonthlyStats] = useState(null);
  const [diffError, setDiffError] = useState(false); // true when comparison diff fetch failed
  const [diffStats, setDiffStats] = useState(null);  // {min, max, absMax, scale} from loaded diff raster
  const [areaStats, setAreaStats] = useState(null);  // {iso: {mean, max, count}}
  const [areaStatsLoading, setAreaStatsLoading] = useState(false);
  const [areaStatMode, setAreaStatMode] = useState('mean'); // 'mean' | 'max'
  const [avgAreaStats, setAvgAreaStats] = useState(null); // {iso: {mean, max, count, by_month, peak_month}} — always the annual-average breakdown, used by the area-click dialog
  const [clickedArea, setClickedArea] = useState(null); // {iso, name} — set when a polygon on the Concentrations map is clicked
  const hlCtx = useRef({ band: null, redraw: null });
  const [hlNorm, setHlNorm] = useState(null);

  const isComparison = !!secondaryScenarioId;

  const hasConc      = Object.keys(hydrologyFiles?.concentration || {}).length > 0;
  const hasTempData  = Object.keys(hydrologyFiles?.river_temperature || {}).length > 0;
  const hasSsrdData   = Object.keys(hydrologyFiles?.ssrd    || {}).length > 0;
  const hasRunoffData  = Object.keys(hydrologyFiles?.runoff  || {}).length > 0;

  const filesForMetric = hydrologyFiles?.concentration || {};
  const availMonths    = Object.keys(filesForMetric).map(Number).sort((a, b) => a - b);

  // Primary scenario annual-average raster (always shown as the base layer)
  const rasterUrl = (() => {
    if (!scenarioId || !hasConc) return null;
    return `/api/scenarios/${scenarioId}/hydrology-average?metric=concentration&_v=concentration`;
  })();

  // Diff URL:
  //   comparison mode → cross-scenario diff; metric depends on activeOverlay
  //   single mode     → intra-scenario % deviation from annual avg (only for specific months)
  const compareMetric = (() => {
    if (activeOverlay === 'temp')   return 'river_temperature';
    if (activeOverlay === 'ssrd')   return 'ssrd';
    if (activeOverlay === 'flow')   return 'discharge';
    if (activeOverlay === 'runoff') return 'runoff';
    return 'concentration';
  })();

  const diffUrl = (() => {
    if (!scenarioId) return null;
    if (isComparison && !diffError) {
      const m = month === 'avg' ? 'avg' : month;
      return `/api/hydrology-compare-diff?scA=${scenarioId}&scB=${secondaryScenarioId}&metric=${compareMetric}&month=${m}`;
    }
    if (!isComparison && month !== 'avg' && showDiff)
      return `/api/scenarios/${scenarioId}/hydrology-diff?metric=concentration&month=${month}`;
    return null;
  })();

  // Reset diff + input-raster stats when secondary scenario, active overlay, or month changes
  useEffect(() => {
    setDiffError(false); setDiffStats(null);
    setTempStats(null); setSsrdStats(null); setRunoffStats(null);
  }, [secondaryScenarioId, activeOverlay, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Annual total % change for concentration (used to set the diff colour scale)
  const annualTotalPct = useMemo(() => {
    if (!isComparison || !monthlyStats || !secondaryMonthlyStats) return null;
    const pri = Object.values(monthlyStats.months || {}).reduce((s, m) => s + (m.sum || 0), 0);
    const sec = Object.values(secondaryMonthlyStats.months || {}).reduce((s, m) => s + (m.sum || 0), 0);
    return pri > 0 ? (sec - pri) / pri * 100 : null;
  }, [monthlyStats, secondaryMonthlyStats, isComparison]); // eslint-disable-line react-hooks/exhaustive-deps

  // Colour scale for the diff overlay:
  //   - concentration: derived from annual total % change (known before TIF loads)
  //   - other metrics: derived from pixel absMax reported back via onStats
  const hydroScale = (() => {
    if (!isComparison) return null;
    if (compareMetric === 'concentration' && annualTotalPct != null) return diffScale(annualTotalPct);
    if (diffStats?.absMax != null) return diffScale(diffStats.absMax);
    return null; // layer will auto-range and report back
  })();

  const showFlow   = activeOverlay === 'flow';
  const showTemp   = activeOverlay === 'temp';
  const showSsrd   = activeOverlay === 'ssrd';
  const showRunoff = activeOverlay === 'runoff';

  // Temperature overlay URL
  const tempUrl = (() => {
    if (!showTemp || !hasTempData) return null;
    if (month === 'avg') return `/api/scenarios/${scenarioId}/hydrology-input-average?metric=river_temperature`;
    const fname = hydrologyFiles.river_temperature?.[String(month)];
    return fname ? `/api/scenarios/${scenarioId}/hydrology-input-raster/river_temperature/${fname}` : null;
  })();

  // SSRD overlay URL
  const ssrdUrl = (() => {
    if (!showSsrd || !hasSsrdData) return null;
    if (month === 'avg') return `/api/scenarios/${scenarioId}/hydrology-input-average?metric=ssrd`;
    const fname = hydrologyFiles.ssrd?.[String(month)];
    return fname ? `/api/scenarios/${scenarioId}/hydrology-input-raster/ssrd/${fname}` : null;
  })();

  // Runoff overlay URL
  const runoffUrl = (() => {
    if (!showRunoff || !hasRunoffData) return null;
    if (month === 'avg') return `/api/scenarios/${scenarioId}/hydrology-input-average?metric=runoff`;
    const fname = hydrologyFiles.runoff?.[String(month)];
    return fname ? `/api/scenarios/${scenarioId}/hydrology-input-raster/runoff/${fname}` : null;
  })();

  // Stable color function refs so HydroInputRasterLayer doesn't remount on every render
  const tempColorFn   = useCallback((norm) => tempColorFromNorm(norm),   []); // eslint-disable-line react-hooks/exhaustive-deps
  const ssrdColorFn   = useCallback((norm) => ssrdColorFromNorm(norm),   []); // eslint-disable-line react-hooks/exhaustive-deps
  const runoffColorFn = useCallback((norm) => runoffColorFromNorm(norm), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Raster stats: sum/max/count over valid pixels
  useEffect(() => {
    if (!rasterUrl) { setRasterStats(null); setStatsLoading(false); return; }
    let cancelled = false;
    setRasterStats(null);
    setStatsLoading(true);
    (async () => {
      try {
        const ab = await fetch(rasterUrl).then(r => r.arrayBuffer());
        if (cancelled) return;
        const gr = await parseGeoraster(ab);
        if (cancelled) return;
        const nd = gr.noDataValue;
        let sum = 0, max = -Infinity, count = 0;
        for (const row of gr.values[0]) {
          for (const v of row) {
            if (v != null && isFinite(v) && v > 0 && v !== nd) {
              sum += v; count++;
              if (v > max) max = v;
            }
          }
        }
        if (!cancelled) {
          setRasterStats(isFinite(max) ? { sum, max, count } : null);
          setStatsLoading(false);
        }
      } catch (_) {
        if (!cancelled) { setRasterStats(null); setStatsLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [rasterUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Monthly aggregate stats for the sidebar: fetched once per scenario + metric
  useEffect(() => {
    if (!scenarioId) { setMonthlyStats(null); return; }
    let cancelled = false;
    setMonthlyStats(null);
    (async () => {
      try {
        const res  = await fetch(`/api/scenarios/${scenarioId}/hydrology-monthly-stats?metric=concentration`);
        const data = await res.json();
        if (!cancelled && !data.error) setMonthlyStats(data);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Secondary monthly stats: fetched when in comparison mode
  useEffect(() => {
    if (!isComparison || !secondaryScenarioId) { setSecondaryMonthlyStats(null); return; }
    let cancelled = false;
    setSecondaryMonthlyStats(null);
    (async () => {
      try {
        const res  = await fetch(`/api/scenarios/${secondaryScenarioId}/hydrology-monthly-stats?metric=concentration`);
        const data = await res.json();
        if (!cancelled && !data.error) setSecondaryMonthlyStats(data);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [secondaryScenarioId, isComparison]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Area stats for sidebar breakdown
  useEffect(() => {
    if (!scenarioId) { setAreaStats(null); setAreaStatsLoading(false); return; }
    let cancelled = false;
    setAreaStatsLoading(true);
    setAreaStats(null);
    (async () => {
      try {
        const params = `metric=concentration&month=${month}`;
        const res  = await fetch(`/api/scenarios/${scenarioId}/hydrology-area-stats?${params}`);
        const data = await res.json();
        if (!cancelled && !data.error) setAreaStats(data);
      } catch (_) {}
      finally {
        if (!cancelled) setAreaStatsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scenarioId, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Annual-average area stats (independent of the selected month): powers the area-click
  // dialog so it can always show the average concentration and the peak month for that area.
  useEffect(() => {
    if (!scenarioId) { setAvgAreaStats(null); return; }
    let cancelled = false;
    setAvgAreaStats(null);
    (async () => {
      try {
        const res  = await fetch(`/api/scenarios/${scenarioId}/hydrology-area-stats?metric=concentration&month=avg`);
        const data = await res.json();
        if (!cancelled && !data.error) setAvgAreaStats(data);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hydrologyFiles) return null;
  if (!hasConc) return null;

  const M3_TO_L = 1000;

  // Compute global mean/peak from rasterStats (whole-map)
  const globalMean = rasterStats ? rasterStats.sum / M3_TO_L / rasterStats.count : null;
  const globalPeak = rasterStats ? rasterStats.max / M3_TO_L : null;

  // Ranked areas for area breakdown
  const rankedAreas = useMemo(() => {
    if (!areaStats) return [];
    return Object.entries(areaStats)
      .map(([iso, s]) => ({ iso, mean: (s.mean ?? 0) / M3_TO_L, max: (s.max ?? 0) / M3_TO_L }))
      .sort((a, b) => (b[areaStatMode] ?? 0) - (a[areaStatMode] ?? 0));
  }, [areaStats, areaStatMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const areaBarMax = rankedAreas[0]?.[areaStatMode] ?? 1;

  // Click handler for area polygons on the Concentrations map: highlight on hover, open the
  // peak-month/average dialog on click.
  const onAreaFeature = useCallback((feature, layer) => {
    const iso  = feature.properties.iso;
    const name = areaNames?.[String(iso)] || feature.properties.NAME_4 || feature.properties.NAME_3 || feature.properties.NAME_2 || feature.properties.NAME_1 || feature.properties.NAME_0 || feature.properties.subarea || `Area ${iso}`;
    layer.on('mouseover', () => {
      layer.bindTooltip(name, { sticky: true });
      layer.setStyle({ fillColor: '#0B4159', fillOpacity: 0.15, weight: 1.5, color: '#0f172a', opacity: 0.9 });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      layer.setStyle({ fillColor: 'transparent', fillOpacity: 0, color: '#1e293b', weight: 0.6, opacity: 0.5 });
    });
    layer.on('click', () => setClickedArea({ iso: String(iso), name }));
  }, [areaNames]);

  // Legend block (used inside MapWithSidePanel legendChildren)
  const legendBlock = (
    <div className="pt-2">
      {isComparison ? (
        !diffError ? (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <div className="h-4 rounded w-full"
                style={{ background: 'linear-gradient(to right, rgb(33,102,172), rgb(140,178,220), #f5f5f5, rgb(220,150,120), rgb(178,24,43))', cursor: 'crosshair' }}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const norm = (e.clientX - rect.left) / rect.width;
                  hlCtx.current.band = [norm - 0.07, norm + 0.07];
                  hlCtx.current.redraw?.();
                  setHlNorm(norm);
                }}
                onMouseLeave={() => { hlCtx.current.band = null; hlCtx.current.redraw?.(); setHlNorm(null); }}
              />
              <BandOverlay norm={hlNorm} />
              {(() => {
                const sc = hydroScale ?? diffStats?.scale ?? 100;
                const half = Math.round(sc / 2);
                const ticks = [`≤-${sc}%`, `-${half}%`, '0%', `+${half}%`, `≥+${sc}%`];
                return (
                  <div className="flex justify-between mt-0.5">
                    {ticks.map(v => <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>)}
                  </div>
                );
              })()}
            </div>
            <span className="text-xs text-gray-400 flex-shrink-0">Concentration change</span>
          </div>
        ) : (
          <p className="text-xs text-amber-600 bg-amber-50 rounded px-2 py-1">
            Comparison overlay unavailable — the secondary scenario may not have data for this layer.
          </p>
        )
      ) : diffUrl ? (
        <div>
          <div className="h-4 rounded w-full"
            style={{ background: 'linear-gradient(to right, rgb(33,102,172), rgb(140,178,220), #f5f5f5, rgb(220,150,120), rgb(178,24,43))', cursor: 'crosshair' }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const norm = (e.clientX - rect.left) / rect.width;
              hlCtx.current.band = [norm - 0.07, norm + 0.07];
              hlCtx.current.redraw?.();
              setHlNorm(norm);
            }}
            onMouseLeave={() => { hlCtx.current.band = null; hlCtx.current.redraw?.(); setHlNorm(null); }}
          />
          <BandOverlay norm={hlNorm} />
          <div className="flex justify-between mt-0.5">
            {['-100%', '-50%', '0%', '+50%', '+100%'].map(v => (
              <span key={v} className="text-xs text-gray-400 font-inter">{v}</span>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">% deviation · blue = below avg · red = above</p>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <div className="flex flex-col items-center flex-shrink-0">
              <div className="h-4 w-10 border border-gray-100" style={{ background: '#e5e7eb' }} />
              <span className="text-xs text-gray-400 mt-0.5">0</span>
            </div>
            <div className="flex-1">
              <div className="relative">
                <div className="h-4 rounded-sm w-full"
                  style={{ background: HYDRO_LEGEND_GRADIENT, cursor: 'crosshair' }}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const norm = (e.clientX - rect.left) / rect.width;
                    hlCtx.current.band = [norm - 0.07, norm + 0.07];
                    hlCtx.current.redraw?.();
                    setHlNorm(norm);
                  }}
                  onMouseLeave={() => { hlCtx.current.band = null; hlCtx.current.redraw?.(); setHlNorm(null); }}
                />
                <BandOverlay norm={hlNorm} />
              </div>
              <div className="relative" style={{ height: 14 }}>
                {(() => {
                  const lmax = rasterStats ? Math.log10(Math.max(rasterStats.max, 1)) : LOG_MAX;
                  const sups = '⁰¹²³⁴⁵⁶⁷⁸⁹';
                  const fmtPow = v => v === 0 ? '1' : '10' + String(v).split('').map(c => sups[+c] ?? c).join('');
                  const ticks = [];
                  for (let v = 0; v <= Math.ceil(lmax); v += 3) ticks.push(v);
                  return ticks.map((v, i) => {
                    const pct = lmax > 0 ? (v / lmax * 100) : 0;
                    return (
                      <span key={v}
                        className={`absolute text-xs text-gray-400 font-inter leading-none ${i === ticks.length - 1 ? '-translate-x-full' : ''}`}
                        style={{ left: `${pct.toFixed(1)}%`, top: 2 }}
                      >
                        {fmtPow(v)}
                      </span>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Log₁₀ · pathogen particles / L</p>
        </div>
      )}
    </div>
  );

  // Right panel: top stats + area list + month pills
  const sidePanelContent = (
    <>
      {/* ── Top stats block */}
      <div className="flex-shrink-0 mb-3 pb-2 border-b border-gray-100">
        <p className="text-lg font-outfit font-semibold text-wpBlue uppercase tracking-wide mb-1">Concentrations ({areaStatMode === 'mean' ? 'mean' : 'peak'})</p>
        {rasterStats ? (
          <div>
            <p className="text-5xl font-bold font-outfit tabular-nums text-wpBlue">{formatScientific(areaStatMode === 'mean' ? globalMean : globalPeak)}</p>
          </div>
        ) : statsLoading ? (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <RefreshCw size={11} className="animate-spin" /> Computing…
          </div>
        ) : null}
        <p className="text-xs text-gray-400 mt-1">pathogen particles / L</p>
        {/* Comparison annual change summary */}
        {isComparison && monthlyStats && secondaryMonthlyStats && (() => {
          const priTotal = Object.values(monthlyStats.months || {}).reduce((s, m) => s + (m.sum || 0), 0);
          const secTotal = Object.values(secondaryMonthlyStats.months || {}).reduce((s, m) => s + (m.sum || 0), 0);
          const pct = priTotal > 0 ? (secTotal - priTotal) / priTotal * 100 : null;
          if (pct === null) return null;
          return (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Annual change</span>
              <span className={`text-sm font-bold tabular-nums ${pct > 0 ? 'text-red-600' : pct < 0 ? 'text-green-600' : 'text-gray-500'}`}>
                {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
              </span>
            </div>
          );
        })()}
      </div>

      {/* ── Area breakdown header */}
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-shrink-0 mb-1">Concentrations by area</p>

      {/* ── Area bar list */}
      <div className="overflow-y-auto flex-1 space-y-0.5 pr-1">
        {areaStatsLoading ? (
          <div className="text-xs text-gray-400 text-center py-3 flex items-center justify-center gap-1.5">
            <RefreshCw size={11} className="animate-spin" /> Loading area data…
          </div>
        ) : rankedAreas.length > 0 ? rankedAreas.map(({ iso, mean: meanVal, max: maxVal }) => {
          const val     = areaStatMode === 'mean' ? meanVal : maxVal;
          const barPct  = areaBarMax > 0 ? (val / areaBarMax) * 100 : 0;
          const name    = areaNames?.[iso] || `Area ${iso}`;
          return (
            <div key={iso} className="flex items-center gap-1.5 group">
              <span className="text-xs text-gray-500 w-20 shrink-0 truncate" title={name}>{name}</span>
              <div className="flex-1 bg-gray-100 rounded-full overflow-hidden" style={{ height: 6 }}>
                <div className="bg-wpBlue rounded-full h-full transition-all duration-300" style={{ width: `${barPct.toFixed(1)}%` }} />
              </div>
              <span className="text-xs font-mono text-gray-500 w-16 text-right shrink-0">{formatScientific(val)}</span>
            </div>
          );
        }) : (
          <div className="text-xs text-gray-400 text-center py-3">No area data</div>
        )}
      </div>

      {/* ── Month pills */}
      {availMonths.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-100 pt-2 mt-1">
          {/* Inline controls above pills */}
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <button
              onClick={() => { setMonth('avg'); setShowDiff(false); }}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                month === 'avg' ? 'bg-wpTeal text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >Monthly average</button>
            {!isComparison && month !== 'avg' && (
              <div className="flex rounded-xl overflow-hidden border border-gray-200 text-xs flex-shrink-0">
                <button
                  onClick={() => setShowDiff(true)}
                  className={`px-2 py-0.5 font-medium transition-colors ${
                    showDiff ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
                  }`}
                >Difference from average</button>
                <button
                  onClick={() => setShowDiff(false)}
                  className={`px-2 py-0.5 font-medium transition-colors ${
                    !showDiff ? 'bg-white text-wpBlue' : 'text-wpBlue/60 bg-gray-100 hover:bg-gray-200'
                  }`}
                >Absolute values</button>
              </div>
            )}
            
          </div>
          <div className="grid grid-cols-6 gap-0.5">
            {availMonths.map(m => {
              const sel = month === m;
              let pct = null;
              if (isComparison) {
                const sumA = monthlyStats?.months?.[String(m)]?.sum;
                const sumB = secondaryMonthlyStats?.months?.[String(m)]?.sum;
                if (sumA != null && sumB != null && sumA > 0) pct = (sumB - sumA) / sumA * 100;
              } else {
                pct = monthlyStats?.months?.[String(m)]?.pct_diff ?? null;
              }
              return (
                <button
                  key={m}
                  onClick={() => { setMonth(m); setShowDiff(true); }}
                  className={`flex flex-col items-center px-0.5 py-1 rounded text-sm transition-colors ${
                    sel ? 'bg-wpBlue text-white' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="font-medium leading-none mb-0.5">{MONTH_LABELS[m - 1]}</span>
                  {pct !== null ? (
                    <span style={{ color: sel ? undefined : pct > 1 ? '#8B2500' : pct < -1 ? '#0B4159' : undefined }}
                      className={`leading-none text-xs ${sel ? 'opacity-80' : Math.abs(pct) <= 1 ? 'text-gray-400' : ''}`}>
                      {pct > 0 ? '+' : ''}{pct.toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-gray-300 text-xs">…</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
    <MapWithSidePanel
      title={pathogen ? `${pathogen.charAt(0).toUpperCase() + pathogen.slice(1)} Concentrations` : 'Concentrations'}
      isComparison={isComparison}
      hasGeodata={!!geojson}
      height={520}
      legendChildren={legendBlock}
      mapChildren={
        <MapContainer center={[0, 0]} zoom={2} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <OpenFreeMapLayer />
          <CreateBlendPane />
          {!isComparison && rasterUrl && <HydrologyGeoTiffLayer key={rasterUrl} url={rasterUrl} hlCtx={hlCtx} />}
          {diffUrl && <HydrologyDiffGeoTiffLayer key={`${diffUrl}-${hydroScale ?? 'auto'}`} url={diffUrl} scale={hydroScale} hlCtx={hlCtx} onError={() => setDiffError(true)} onStats={setDiffStats} />}
          {!isComparison && showTemp && tempUrl && <HydroInputRasterLayer key={`temp-${tempUrl}`} url={tempUrl} colorFn={tempColorFn} opacity={0.75} onStats={setTempStats} />}
          {!isComparison && showSsrd   && ssrdUrl   && <HydroInputRasterLayer key={`ssrd-${ssrdUrl}`}     url={ssrdUrl}   colorFn={ssrdColorFn}   opacity={0.75} onStats={setSsrdStats}   />}
          {!isComparison && showRunoff && runoffUrl && <HydroInputRasterLayer key={`runoff-${runoffUrl}`} url={runoffUrl} colorFn={runoffColorFn} opacity={0.75} onStats={setRunoffStats} />}
          <LeafletGeoJSON
            key={`hydro-${scenarioId}-${geojson?.features?.length}`}
            data={geojson}
            style={() => ({ fillColor: 'transparent', fillOpacity: 0, color: '#1e293b', weight: 0.6, opacity: 0.5 })}
            onEachFeature={onAreaFeature}
          />
          <FitBounds geojson={geojson} />
          <MapExportControls title={'Concentrations'} />
          {!isComparison && showFlow && <FlowArrowLayer key={`flow-${scenarioId}-${month}-${minAccPct}`} scenarioId={scenarioId} month={month} minAccPct={minAccPct} onLegendData={setFlowLegend} />}
          <LegendMapTooltip hlNorm={hlNorm} effectiveLogMax={LOG_MAX} isDiff={!!diffUrl} diffScale={hydroScale ?? diffStats?.scale ?? 100} />
          <HydroMapControls
            activeOverlay={activeOverlay} setActiveOverlay={setActiveOverlay}
            minAccPct={minAccPct} setMinAccPct={setMinAccPct}
            hasTempData={hasTempData} hasSsrdData={hasSsrdData} hasRunoffData={hasRunoffData}
            tempStats={tempStats} ssrdStats={ssrdStats} runoffStats={runoffStats}
            flowLegend={flowLegend}
          />
        </MapContainer>
      }
      sidePanelChildren={sidePanelContent}
    />
    <ConcentrationAreaDialog area={clickedArea} avgAreaStats={avgAreaStats} onClose={() => setClickedArea(null)} />
    </>
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

  const [geoRes, wEmRes, lEmRes, wSrcRes, lSrcRes, wLsRes, lLsRes, wStatsRes, lStatsRes, hydRes] = await Promise.all([
    axios.get(`/api/scenarios/${scId}/geodata`),
    waterEmFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterEmFile}`)  : Promise.resolve(null),
    landEmFile   ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landEmFile}`)   : Promise.resolve(null),
    waterSrcFile ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterSrcFile}`) : Promise.resolve(null),
    landSrcFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landSrcFile}`)  : Promise.resolve(null),
    waterLsFile  ? axios.get(`/api/scenarios/${scId}/output-csv-data/${waterLsFile}`)  : Promise.resolve(null),
    landLsFile   ? axios.get(`/api/scenarios/${scId}/output-csv-data/${landLsFile}`)   : Promise.resolve(null),
    waterTifFile ? axios.get(`/api/scenarios/${scId}/raster-area-stats/${waterTifFile}`).catch(() => null) : Promise.resolve(null),
    landTifFile  ? axios.get(`/api/scenarios/${scId}/raster-area-stats/${landTifFile}`).catch(() => null)  : Promise.resolve(null),
    axios.get(`/api/scenarios/${scId}/hydrology-files`).catch(() => null),
  ]);

  // Count valid pixels per TIF so choropleth mode can be decided per emission type at render time.
  // Choropleth is preferred when the TIF has fewer valid pixels than the user-configured threshold
  // (settable in Settings → Map Display). This happens when the study area is smaller than the
  // output raster grid resolution, leaving only a handful of blocky cells.
  const waterRasterPixels = Object.values(wStatsRes?.data || {})
    .reduce((sum, s) => sum + (s?.count ?? 0), 0);
  const landRasterPixels = Object.values(lStatsRes?.data || {})
    .reduce((sum, s) => sum + (s?.count ?? 0), 0);

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
    waterRasterPixels,
    landRasterPixels,
    hydrologyFiles:         hydRes?.data   || null,
    loadedAt:               Date.now(),
  };
}

// ─── Main component ────────────────────────────────────────────────────────────────────────────────

export default function ResultsView({ caseStudies, initialCaseStudyId, initialScenarioIds, initialEmissionType, initialArea, onCaseStudyChange }) {
  const { choroplethPixelThreshold } = useSettingsStore();
  const navigate = useNavigate();
  const location = useLocation();

  const [selectedCsId,       setSelectedCsId]       = useState(initialCaseStudyId || '');
  const [availableScenarios, setAvailableScenarios] = useState([]);
  const [scenariosLoading,   setScenariosLoading]   = useState(false);

  // Up to 2 selected scenario IDs.  index 0 = primary, index 1 = secondary
  const [selectedScIds, setSelectedScIds] = useState(() => (initialScenarioIds || []).slice(0, 2));
  const [emissionType,  setEmissionType]  = useState(initialEmissionType === 'land' ? 'land' : 'water');

  // Cached data keyed by scenario id.  Value: output object | 'loading' | 'error'
  const [scenarioData, setScenarioData] = useState({});

  // Area filter: null = all, Set<string iso> = specific
  const [selectedAreas, setSelectedAreas] = useState(() => (initialArea ? new Set([initialArea]) : null));
  const [clickedArea,   setClickedArea]   = useState(null);
  const [activeTab,     setActiveTab]     = useState('emissions');
  const [driverData] = useState(null);

  // ── Sync externally supplied IDs (e.g. resolved from the URL on deep-link / case-study switch)
  useEffect(() => { if (initialCaseStudyId) setSelectedCsId(initialCaseStudyId); }, [initialCaseStudyId]);
  useEffect(() => {
    const next = (initialScenarioIds || []).slice(0, 2);
    if (!next.length) return;
    setSelectedScIds(prev => (prev.length === next.length && prev.every((id, i) => id === next[i])) ? prev : next);
  }, [initialScenarioIds]);
  useEffect(() => { if (initialEmissionType === 'land' || initialEmissionType === 'water') setEmissionType(initialEmissionType); }, [initialEmissionType]);
  useEffect(() => {
    if (!initialArea) return;
    setSelectedAreas(prev => (prev && prev.size === 1 && prev.has(initialArea)) ? prev : new Set([initialArea]));
  }, [initialArea]);
  useEffect(() => {
    if (!selectedCsId && !initialCaseStudyId && caseStudies.length === 1) setSelectedCsId(caseStudies[0].id);
  }, [caseStudies]); // eslint-disable-line

  // ── Write scenario picks / emission type / area filter back into the URL so
  // the current comparison view is a shareable, deep-linkable, refresh-safe link.
  // Guarded on scenariosLoading to avoid a spurious URL clear while the scenario
  // list (needed to resolve ids -> names) is still in flight after a case-study switch.
  useEffect(() => {
    if (!selectedCsId || scenariosLoading) return;
    if (!location.pathname.startsWith('/analytics/')) return;
    const cs = caseStudies.find(c => c.id === selectedCsId);
    if (!cs) return;
    const scenarioNames = selectedScIds
      .map(id => availableScenarios.find(s => s.id === id)?.name)
      .filter(Boolean);
    const area = (selectedAreas && selectedAreas.size) ? [...selectedAreas][0] : '';
    const target = paths.analytics(cs, { scenarios: scenarioNames, emissionType, area });
    const current = `${location.pathname}${location.search}`;
    if (target !== current) navigate(target, { replace: true });
  }, [selectedCsId, selectedScIds, emissionType, selectedAreas, availableScenarios, scenariosLoading, caseStudies, location.pathname, location.search]); // eslint-disable-line

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

  // Reset area filter on primary change (but not on the initial mount, so a
  // deep-linked `area` query param survives the first render).
  const prevPrimRef = useRef(selectedScIds[0] || null);
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
      m[iso] = f.properties.NAME_4 || f.properties.NAME_3 || f.properties.NAME_2 || f.properties.NAME_1
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

      {/* Selector bar + Tab bar */}
      <div className="flex items-stretch my-2 flex-shrink-0 rounded-xl overflow-hidden">
        {/* Tab selector — Emissions / Concentrations / Risk */}
        <div className="flex items-center justify-start px-4 bg-wpGray-200 w-1/2 flex-shrink-0">
          <div className="flex rounded-2xl bg-white/20 p-1.5 gap-1">
            {[
              { id: 'emissions',      label: 'Emissions',      icon: EmissionsTabIcon,      disabled: false },
              { id: 'concentrations', label: 'Concentrations', icon: ConcentrationsTabIcon, disabled: !primaryData?.hydrologyFiles },
              { id: 'risk',           label: 'Risk',           icon: RiskTabIcon,           disabled: !primaryData?.hydrologyFiles },
            ].map(tab => (
              <button key={tab.id}
                onClick={() => !tab.disabled && setActiveTab(tab.id)}
                disabled={tab.disabled}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-md font-medium transition-colors ${
                  tab.disabled
                    ? 'text-gray-300 cursor-not-allowed'
                    : activeTab === tab.id
                      ? 'bg-white text-wpBlue font-bold shadow-sm'
                      : 'text-gray-500 hover:text-wpBlue'
                }`}>
                <img src={tab.icon} alt="" className={`w-10 h-10 flex-shrink-0 ${
                  tab.disabled ? 'opacity-30' : activeTab === tab.id ? 'opacity-100' : 'opacity-50'
                }`}/>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scenario selector */}
        <div className="flex items-start gap-4 py-4 px-4 flex-wrap bg-wpBrown-200 border-l border-wpBrown flex-1 min-w-0">
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
      </div>

      {/* Empty state */}
      {!primaryScId && (
        <div className="flex-1 flex items-center justify-center py-24">
          <div className="text-center text-gray-400">
            <BarChart2 size={48} className="mx-auto mb-3 text-gray-200"/>
            <p className="text-lg font-medium text-gray-300">No scenario selected</p>
            <p className="text-sm mt-1">Select a case study and at least one completed scenario.</p>
          </div>
        </div>
      )}

      {/* ── Emissions tab ─────────────────────────────────────────────── */}
      {primaryScId && activeTab === 'emissions' && (
        <div className="space-y-4 mt-2 pb-6 pt-3">

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
            emissionType={emissionType}
            onChangeEmissionType={setEmissionType}
            choroplethMode={
              emissionType === 'water'
                ? (!waterTif || (primaryData?.waterRasterPixels ?? 0) < choroplethPixelThreshold)
                : (!landTif  || (primaryData?.landRasterPixels  ?? 0) < choroplethPixelThreshold)
            }
          />

          {/* Sources of contamination */}
          {primaryData && (
            <div className="bg-white rounded-lg border border-gray-200 px-4 py-4 space-y-4">
              <p className="text-md font-semibold text-wpBlue uppercase tracking-wide mr-6">
                Sources of contamination
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

        </div>
      )}

      {/* ── Concentrations tab ────────────────────────────────────────── */}
      {primaryScId && activeTab === 'concentrations' && (
        <div className="space-y-4 mt-2 pb-6 pt-3">
          {primaryData?.hydrologyFiles ? (
            <HydrologyMapSection
              scenarioId={primaryScId}
              geojson={geojson}
              hydrologyFiles={primaryData.hydrologyFiles}
              secondaryScenarioId={isComparison ? secondaryScId : null}
              areaNames={areaNames}
              pathogen={availableScenarios.find(s => s.id === primaryScId)?.pathogen}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center py-24">
              <div className="text-center text-gray-400">
                <p className="text-lg font-medium text-gray-300">No concentration data available</p>
                <p className="text-sm mt-1">Concentration outputs have not been generated for this scenario.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Risk tab ──────────────────────────────────────────────────── */}
      {primaryScId && activeTab === 'risk' && (
        <div className="space-y-4 mt-2 pb-6 pt-3">
          {primaryData?.hydrologyFiles ? (
            <RiskPanel
              scenarioId={primaryScId}
              scenarioName={availableScenarios.find(s => s.id === primaryScId)?.name || primaryScId}
              pathogen={availableScenarios.find(s => s.id === primaryScId)?.pathogen}
              secondaryScenarioId={isComparison ? secondaryScId : null}
              secondaryScenarioName={isComparison ? secondaryScenario?.name || secondaryScId : null}
              geojson={geojson}
              areaNames={areaNames}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center py-24">
              <div className="text-center text-gray-400">
                <p className="text-lg font-medium text-gray-300">No risk data available</p>
                <p className="text-sm mt-1">Risk outputs have not been generated for this scenario.</p>
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
