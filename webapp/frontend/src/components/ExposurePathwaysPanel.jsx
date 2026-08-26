// Exposure pathways driver -- per-scenario QMRA configuration.
//
// Scenario-wide settings (Monte Carlo iterations, dose-response model and
// parameters, and each pathway's volume distribution) apply to the whole map.
// Enablement, frequency and drinking-water boiling can additionally be varied
// per geographic area; the backend groups areas with identical settings, runs
// the QMRA engine once per group on masked concentration rasters, and
// mosaics the results back together.
//
// Config auto-saves (debounced 600 ms) via PUT /api/scenarios/:id/qmra/config.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Play, RefreshCw, CheckCircle, AlertTriangle, ChevronDown, ChevronRight, SlidersHorizontal, Map as MapIcon, RotateCcw } from 'lucide-react';
import { MapContainer, useMap } from 'react-leaflet';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import parseGeoraster from 'georaster';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from './Dialog';
import AreaEditModeToggle from './AreaEditModeToggle';
import AreaSelector from './AreaSelector';
import OpenFreeMapLayer from './OpenFreeMapLayer';
import DrinkingIcon from '../../assets/icons/drinking.svg';
import SwimmingIcon from '../../assets/icons/swimming.svg';
import FloodIcon from '../../assets/icons/floods.svg';
import OpenDrainIcon from '../../assets/icons/open_drains.svg';
import PlayingIcon from '../../assets/icons/playing.svg';
import WashingIcon from '../../assets/icons/washing.svg';

// Required by georaster-layer-for-leaflet to reproject TIFs not in WGS84
if (typeof window !== 'undefined') window.proj4 = proj4;

const ROUTE_ORDER = ['drinking', 'swimming', 'flooding', 'open_drain', 'playing', 'washing_clothes'];
const ROUTE_LABELS = {
  drinking:        'Drinking water',
  swimming:        'Swimming / bathing',
  flooding:        'Flooding',
  open_drain:      'Open drain contact',
  playing:         'Children playing',
  washing_clothes: 'Washing clothes',
};
const ROUTE_ICONS = {
  drinking: DrinkingIcon,
  swimming: SwimmingIcon,
  flooding: FloodIcon,
  open_drain: OpenDrainIcon,
  playing: PlayingIcon,
  washing_clothes: WashingIcon,
};
const DEFAULT_PATHWAYS = {
  drinking:        { enabled: true,  volume: { type: 'poisson',    lambda: 3.49, glass: 250 }, frequency: { type: 'fixed',   value: 365  }, boiling: false, use_treatment: false },
  swimming:        { enabled: false, volume: { type: 'triangular', min: 20,   mode: 35,   max: 50    }, frequency: { type: 'nbinom',  size: 0.4, prob: 0.11  } },
  flooding:        { enabled: false, volume: { type: 'triangular', min: 10,   mode: 100,  max: 300   }, frequency: { type: 'poisson', lambda: 1.0  } },
  open_drain:      { enabled: false, volume: { type: 'triangular', min: 0.5,  mode: 3,    max: 20    }, frequency: { type: 'poisson', lambda: 200  } },
  playing:         { enabled: false, volume: { type: 'triangular', min: 1,    mode: 10,   max: 50    }, frequency: { type: 'poisson', lambda: 30   } },
  washing_clothes: { enabled: false, volume: { type: 'triangular', min: 0.1,  mode: 1,    max: 5     }, frequency: { type: 'poisson', lambda: 200  } },
};
const PATHOGEN_BP_DEFAULTS = {
  cryptosporidium: { muw: -1.323, muz: -0.206, varw:  0.294, varz:  1.054, cov: -0.0625 },
  rotavirus:       { muw:  0.571, muz: -5.093, varw:  0.677, varz: 28.180, cov: -2.728  },
};
const PATHOGEN_LABELS = { cryptosporidium: 'Cryptosporidium', rotavirus: 'Rotavirus' };
const BP_PARAM_LABELS  = { muw: 'μw', muz: 'μz', varw: 'σ²w', varz: 'σ²z', cov: 'Covariance' };
const DEFAULT_CONFIG = {
  mci: 1000, model: 'bp', quantiles: [0.025, 0.5, 0.975],
  bp_params: PATHOGEN_BP_DEFAULTS, pathways: DEFAULT_PATHWAYS, area_overrides: {},
};

// Fields the QMRA engine can be made to vary per area (see AREA_OVERRIDE_FIELDS
// in the backend). Volume distributions and the treatment raster cannot.
const AREA_OVERRIDE_FIELDS = ['enabled', 'frequency', 'boiling'];

// Each distinct parameter set costs a full engine pass, so warn before the
// run time becomes unreasonable.
const GROUP_WARN_THRESHOLD = 4;
const GROUP_HARD_CAP       = 12;

// Helpers
function eventsPerYear(freq) {
  if (!freq) return 365;
  if (freq.type === 'fixed')   return freq.value  ?? 365;
  if (freq.type === 'poisson') return freq.lambda ?? 1;
  if (freq.type === 'nbinom' && freq.size != null && freq.prob != null)
    return (freq.size * (1 - freq.prob)) / freq.prob;
  return 365;
}
function withEventsPerYear(freq, newVal) {
  const v = Math.max(0, parseFloat(newVal) || 0);
  if (!freq || freq.type === 'fixed')   return { type: 'fixed',   value: v };
  if (freq.type === 'poisson')           return { ...freq, lambda: v };
  if (freq.type === 'nbinom' && freq.size != null) {
    const prob = freq.size / (freq.size + v);
    return { ...freq, prob: Math.max(0.001, Math.min(0.999, prob)) };
  }
  return { type: 'fixed', value: v };
}

function NumInput({ value, onChange, min, max, step = 'any', className = '' }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value ?? ''}
      onChange={e => onChange(parseFloat(e.target.value))}
      className={`rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500 ${className}`}
    />
  );
}
function FieldRow({ label, children }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-gray-600 w-28 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}

// Dose-response parameter card (Beta-Poisson)
function BpParamsCard({ pathogen, config, setConfig }) {
  const defaultsForPathogen = PATHOGEN_BP_DEFAULTS[pathogen] || PATHOGEN_BP_DEFAULTS.cryptosporidium;
  const currentParams = ((config.bp_params || PATHOGEN_BP_DEFAULTS)[pathogen]) || defaultsForPathogen;
  const setParam = (key, val) => setConfig(prev => ({
    ...prev,
    bp_params: {
      ...(prev.bp_params || PATHOGEN_BP_DEFAULTS),
      [pathogen]: {
        ...((prev.bp_params || PATHOGEN_BP_DEFAULTS)[pathogen] || defaultsForPathogen),
        [key]: val,
      },
    },
  }));
  const resetToDefaults = () => setConfig(prev => ({
    ...prev,
    bp_params: { ...(prev.bp_params || PATHOGEN_BP_DEFAULTS), [pathogen]: { ...defaultsForPathogen } },
  }));
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Dose-response defaults
          {pathogen && (
            <span className="ml-2 text-wpBlue normal-case font-normal">({PATHOGEN_LABELS[pathogen] ?? pathogen})</span>
          )}
        </h4>
        {pathogen && (
          <button className="text-xs text-wpBlue hover:underline" onClick={resetToDefaults}>Reset to defaults</button>
        )}
      </div>
      {!pathogen && (
        <p className="text-xs text-gray-400 italic">No pathogen detected. Run the GloWPa model for this scenario first.</p>
      )}
      {pathogen && config.model === 'exp' && (
        <p className="text-xs text-gray-400 italic">Exponential model uses built-in parameters from GloWPaQMRA; no overrides needed.</p>
      )}
      {pathogen && config.model === 'bp' && (
        <div className="space-y-2">
          {Object.entries(BP_PARAM_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-gray-600 w-24 flex-shrink-0">{label}</span>
              <input type="number" step="any"
                value={currentParams[key] ?? ''}
                onChange={e => setParam(key, parseFloat(e.target.value))}
                className="w-28 rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500" />
              <span className="text-xs text-gray-400">default: {defaultsForPathogen[key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-pathway card.
//
// `areaMode` restricts editing to the fields the engine can vary spatially;
// the volume distribution and treatment raster are then shown read-only.
function PathwayCard({ route, pc, onChange, treatmentAvailable, advanced = true, areaMode = false, overridden = false }) {
  const [open, setOpen] = useState(pc.enabled);
  const isDrinking = route === 'drinking';
  const set     = (key, val) => onChange(route, { [key]: val });
  const setVol  = (key, val) => onChange(route, { volume:    { ...pc.volume,    [key]: val } });
  const setFreq = (key, val) => onChange(route, { frequency: { ...pc.frequency, [key]: val } });
  const vol      = pc.volume    || {};
  const freq     = pc.frequency || {};
  const volType  = vol.type  || 'triangular';
  const freqType = freq.type || 'fixed';
  const epy      = eventsPerYear(freq);
  const handleEnable = checked => { onChange(route, { enabled: checked }); if (checked) setOpen(true); };
  return (
    <div className="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-col gap-1 shadow-sm">
      <div className={`flex items-center gap-2 px-4 py-2.5 ${advanced && pc.enabled ? 'cursor-pointer' : ''} select-none`} onClick={() => advanced && pc.enabled && setOpen(o => !o)}>
        <input type="checkbox" checked={!!pc.enabled} onChange={e => handleEnable(e.target.checked)} onClick={e => e.stopPropagation()} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
        <img src={ROUTE_ICONS[route]} alt="" aria-hidden="true" className={`h-7 w-7 flex-shrink-0 ${pc.enabled ? '' : 'opacity-40 grayscale'}`} />
        <span className={`font-medium text-sm flex-1 ${pc.enabled ? 'text-wpBlue' : 'text-gray-500'}`}>{ROUTE_LABELS[route]}</span>
        {overridden && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700" title="Differs from the scenario default for the selected area(s)">
            Overridden
          </span>
        )}
        {advanced && pc.enabled && (open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />)}
      </div>
      {/* Standard mode: simplified controls */}
      {!advanced && pc.enabled && (
        <div className="px-4 pb-3 border-t border-gray-100 pt-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-28 flex-shrink-0">Events / year</span>
            <input type="number" min={0} max={36500} step={1}
              value={Math.round(epy * 10) / 10}
              onChange={e => onChange(route, { frequency: withEventsPerYear(freq, e.target.value) })}
              className="w-24 rounded border border-gray-300 px-2 py-1 text-xs focus:ring-1 focus:ring-wpBlue focus:border-wpBlue" />
            <span className="text-[10px] text-gray-400">= {(epy / 12).toFixed(1)}/mo</span>
          </div>
          {isDrinking && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={!!pc.boiling} onChange={e => set('boiling', e.target.checked)} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
              <span className="text-xs text-gray-600">Include boiling behaviour</span>
            </label>
          )}
        </div>
      )}
      {/* Advanced mode: full distribution controls */}
      {advanced && pc.enabled && open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3 text-sm">
          {/* Volume */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Volume (mL){areaMode && <span className="ml-1.5 normal-case font-normal text-gray-400">— scenario-wide</span>}
            </p>
            {areaMode ? (
              <p className="text-xs text-gray-500">
                {volType === 'poisson'
                  ? `Poisson, lambda ${vol.lambda ?? '—'}${isDrinking ? `, glass ${vol.glass ?? '—'} mL` : ''}`
                  : `Triangular, min ${vol.min ?? '—'} / mode ${vol.mode ?? '—'} / max ${vol.max ?? '—'}`}
              </p>
            ) : isDrinking ? (
              <div className="space-y-1.5">
                <FieldRow label="Distribution"><span className="text-gray-500 text-xs">Poisson</span></FieldRow>
                <FieldRow label="lambda (mean)">
                  <NumInput value={vol.lambda} onChange={v => setVol('lambda', v)} min={0} className="w-24" />
                  <span className="text-xs text-gray-400">mL avg per glass</span>
                </FieldRow>
                <FieldRow label="Glass size">
                  <NumInput value={vol.glass} onChange={v => setVol('glass', Math.round(v))} min={1} step={1} className="w-20" />
                  <span className="text-xs text-gray-400">mL</span>
                </FieldRow>
              </div>
            ) : (
              <div className="space-y-1.5">
                <FieldRow label="Distribution">
                  <select value={volType} onChange={e => onChange(route, { volume: { type: e.target.value } })} className="rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500">
                    <option value="triangular">Triangular</option>
                    <option value="poisson">Poisson</option>
                  </select>
                </FieldRow>
                {volType === 'triangular' ? (
                  <>
                    <FieldRow label="Min"><NumInput  value={vol.min}  onChange={v => setVol('min',  v)} min={0} className="w-20" /></FieldRow>
                    <FieldRow label="Mode"><NumInput value={vol.mode} onChange={v => setVol('mode', v)} min={0} className="w-20" /></FieldRow>
                    <FieldRow label="Max"><NumInput  value={vol.max}  onChange={v => setVol('max',  v)} min={0} className="w-20" /></FieldRow>
                  </>
                ) : (
                  <FieldRow label="lambda"><NumInput value={vol.lambda} onChange={v => setVol('lambda', v)} min={0} className="w-24" /></FieldRow>
                )}
              </div>
            )}
          </div>
          {/* Frequency */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Frequency (events/year)</p>
            {isDrinking ? (
              <FieldRow label="Events/year">
                <NumInput value={freq.value ?? 365} onChange={v => setFreq('value', Math.round(v))} min={1} step={1} className="w-24" />
              </FieldRow>
            ) : (
              <div className="space-y-1.5">
                <FieldRow label="Distribution">
                  <select value={freqType} onChange={e => onChange(route, { frequency: { type: e.target.value } })} className="rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500">
                    <option value="poisson">Poisson</option>
                    <option value="nbinom">Negative binomial</option>
                  </select>
                </FieldRow>
                {freqType === 'poisson' ? (
                  <FieldRow label="lambda"><NumInput value={freq.lambda} onChange={v => setFreq('lambda', v)} min={0} className="w-24" /></FieldRow>
                ) : (
                  <>
                    <FieldRow label="size (r)"><NumInput value={freq.size} onChange={v => setFreq('size', v)} min={0} step={0.01} className="w-24" /></FieldRow>
                    <FieldRow label="prob"><NumInput    value={freq.prob} onChange={v => setFreq('prob', v)}  min={0} max={1} step={0.01} className="w-24" /></FieldRow>
                  </>
                )}
              </div>
            )}
          </div>
          {/* Drinking-only toggles */}
          {isDrinking && (
            <div className="space-y-1.5 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!pc.boiling} onChange={e => set('boiling', e.target.checked)} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
                <span className="text-gray-700">Include boiling behaviour</span>
              </label>
              {treatmentAvailable && (
                areaMode ? (
                  <p className="text-xs text-gray-500">
                    Treatment raster: {pc.use_treatment ? 'applied' : 'not applied'} <span className="text-gray-400">— scenario-wide</span>
                  </p>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!pc.use_treatment} onChange={e => set('use_treatment', e.target.checked)} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
                    <span className="text-gray-700">Apply treatment raster</span>
                  </label>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Treatment raster preview (drinking-water treatment wired into QMRA) ──────

// Default color map matching the backend TREATMENT_CODE_COLORS.
// The map is also fetched from /qmra/treatment-codes so it stays in sync.
const DEFAULT_CODE_COLORS = {
  0: '#d1d5db', 1: '#d1d5db', 2: '#d1d5db', 3: '#d1d5db', 4: '#d1d5db',
  5: '#bfdbfe', 6: '#60a5fa', 7: '#2563eb', 8: '#1e3a8a',
};

function TreatmentRasterLayer({ tifUrl, codeColors }) {
  const map = useMap();
  const layerRef = useRef(null);
  useEffect(() => {
    if (!tifUrl || !map) return;
    let cancelled = false;
    const colors = codeColors || DEFAULT_CODE_COLORS;
    (async () => {
      try {
        const ab = await fetch(tifUrl).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;
        const nd = gr.noDataValue;
        const layer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.9,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: ([v]) => {
            if (v == null || v === nd || isNaN(v)) return null;
            const code = Math.round(v);
            return colors[code] ?? '#94a3b8';
          },
        });
        if (layerRef.current) { try { map.removeLayer(layerRef.current); } catch (_) {} }
        layer.addTo(map);
        layerRef.current = layer;
        try {
          const bounds = layer.getBounds();
          if (bounds?.isValid?.()) map.fitBounds(bounds, { padding: [16, 16] });
        } catch (_) {}
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
      if (layerRef.current) { try { map.removeLayer(layerRef.current); } catch (_) {} layerRef.current = null; }
    };
  }, [tifUrl, map, codeColors]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function TreatmentLegend({ legend }) {
  if (!legend?.length) return null;
  // Only show codes that are actually present in the raster, plus any absent ones dimmed
  const present = legend.filter(e => e.present);
  const absent  = legend.filter(e => !e.present && e.code >= 5);
  const entries = present.length > 0 ? [...present, ...absent] : legend.filter(e => e.code >= 5);
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-gray-600 mb-2">Treatment levels (GloWPaQMRA codes)</p>
      <div className="flex flex-col gap-1">
        {entries.map(e => (
          <div key={e.code} className={`flex items-start gap-2.5 ${!e.present && 'opacity-35'}`}>
            <span
              className="flex-shrink-0 w-5 h-5 rounded border border-gray-300 mt-0.5"
              style={{ background: e.color }}
            />
            <div className="min-w-0">
              <span className="text-xs font-medium text-gray-800">
                {e.code} — {e.label}
              </span>
              {e.steps?.length > 0 && (
                <span className="text-xs text-gray-500 ml-1.5">
                  ({e.steps.join(' → ')})
                </span>
              )}
              {!e.present && <span className="text-xs text-gray-400 ml-1.5 italic">not in this dataset</span>}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Cells with no treatment (codes 0–4) are shown in gray and receive no log-reduction in the QMRA model.
      </p>
    </div>
  );
}

function TreatmentMap({ caseStudyId }) {
  const [legend, setLegend]   = useState(null);
  const [failed, setFailed]   = useState(false);
  const tifUrl = caseStudyId ? `/api/case-studies/${caseStudyId}/qmra/treatment-tif` : null;

  useEffect(() => {
    if (!caseStudyId) return;
    let alive = true;
    axios.get(`/api/case-studies/${caseStudyId}/qmra/treatment-codes`)
      .then(({ data }) => { if (alive) setLegend(data.legend || []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [caseStudyId]);

  const codeColors = legend
    ? Object.fromEntries(legend.map(e => [e.code, e.color]))
    : DEFAULT_CODE_COLORS;

  if (failed) {
    return <p className="text-sm text-gray-500">No treatment raster found for this case study.</p>;
  }
  return (
    <div className="space-y-1">
      <MapContainer center={[0, 0]} zoom={2} style={{ height: 400, width: '100%', borderRadius: 8 }}>
        <OpenFreeMapLayer />
        <TreatmentRasterLayer tifUrl={tifUrl} codeColors={codeColors} />
      </MapContainer>
      <p className="text-xs text-gray-400">
        Treatment raster wired into the drinking-water pathway. Log-reduction values are sampled per treatment step at run time.
      </p>
      <TreatmentLegend legend={legend} />
    </div>
  );
}

function RunStatusLine({ status, groupCount }) {
  if (status === 'running') {
    return (
      <div className="flex items-center gap-1.5 text-blue-700 text-xs">
        <RefreshCw size={13} className="animate-spin" />
        {groupCount > 1 ? `Running QMRA — ${groupCount} area groups…` : 'Running QMRA…'}
      </div>
    );
  }
  if (status === 'success') {
    return <div className="flex items-center gap-1.5 text-green-600 text-xs"><CheckCircle size={13} /> Risk outputs updated.</div>;
  }
  if (status === 'error' || status === 'timeout') {
    return <div className="flex items-center gap-1.5 text-red-600 text-xs"><AlertTriangle size={13} /> QMRA run failed. Check the run log.</div>;
  }
  return null;
}

// Count distinct effective parameter sets the same way the backend does, so the
// user can see the run cost before hitting the button.
function countRunGroups(config, areaKeys) {
  const pathways = config.pathways || DEFAULT_PATHWAYS;
  const overrides = config.area_overrides || {};
  const signature = (key) => {
    const merged = {};
    for (const route of ROUTE_ORDER) {
      const base = { ...(pathways[route] || DEFAULT_PATHWAYS[route]) };
      const ov = overrides[key]?.[route];
      if (ov) for (const f of AREA_OVERRIDE_FIELDS) if (f in ov) base[f] = ov[f];
      merged[route] = base;
    }
    return JSON.stringify(merged);
  };
  const sigs = new Set([signature('__none__')]);
  for (const key of areaKeys) sigs.add(signature(key));
  return sigs.size;
}

export default function ExposurePathwaysPanel({ scenario, caseStudyId }) {
  const scenarioId = scenario?.id;
  const [config, setConfig]                     = useState(DEFAULT_CONFIG);
  const [areas, setAreas]                       = useState([]);
  const [pathogen, setPathogen]                 = useState(null);
  const [treatmentAvailable, setTreatmentAvail] = useState(false);
  const [loading, setLoading]                   = useState(true);
  const [saveOk, setSaveOk]                     = useState(false);
  const [advanced, setAdvanced]                 = useState(false);
  const [editMode, setEditMode]                 = useState('all');
  const [selectedIndices, setSelectedIndices]   = useState(new Set());
  const [runStatus, setRunStatus]               = useState('idle');
  const [runGroupCount, setRunGroupCount]       = useState(1);
  const isFirstLoad   = useRef(true);
  const autoSaveTimer = useRef(null);
  const pollRef       = useRef(null);

  useEffect(() => () => { clearInterval(pollRef.current); clearTimeout(autoSaveTimer.current); }, []);

  useEffect(() => {
    if (!scenarioId) return;
    isFirstLoad.current = true;
    setLoading(true);
    Promise.all([
      axios.get(`/api/scenarios/${scenarioId}/qmra/config`),
      axios.get(`/api/scenarios/${scenarioId}/qmra/areas`).catch(() => ({ data: { areas: [] } })),
    ])
      .then(([cfgRes, areaRes]) => {
        const data = cfgRes.data;
        setTreatmentAvail(!!data.treatment_available);
        setPathogen(data.pathogen ?? null);
        setConfig({
          mci:            data.mci            ?? 1000,
          model:          data.model          ?? 'bp',
          quantiles:      data.quantiles      ?? [0.025, 0.5, 0.975],
          bp_params:      data.bp_params      ?? PATHOGEN_BP_DEFAULTS,
          pathways:       data.pathways       ?? DEFAULT_PATHWAYS,
          area_overrides: data.area_overrides ?? {},
        });
        setAreas(areaRes.data.areas || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scenarioId]);

  useEffect(() => {
    if (loading) return;
    if (isFirstLoad.current) { isFirstLoad.current = false; return; }
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      if (!scenarioId) return;
      try {
        const { data } = await axios.put(`/api/scenarios/${scenarioId}/qmra/config`, config);
        if (data?.run_group_count) setRunGroupCount(data.run_group_count);
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 1500);
      } catch (_) {}
    }, 600);
    return () => clearTimeout(autoSaveTimer.current);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const areaKeys   = useMemo(() => areas.map(a => a.key), [areas]);
  const areaLabels = useMemo(() => areas.map(a => a.name), [areas]);
  const hasAreas   = areas.length > 0;
  const perArea    = editMode === 'individual' && hasAreas && selectedIndices.size > 0;
  const selectedKeys = useMemo(
    () => [...selectedIndices].map(i => areaKeys[i]).filter(Boolean),
    [selectedIndices, areaKeys],
  );

  const groupCount = useMemo(() => countRunGroups(config, areaKeys), [config, areaKeys]);
  useEffect(() => { setRunGroupCount(groupCount); }, [groupCount]);

  const overridesForFirstSelected = perArea ? (config.area_overrides?.[selectedKeys[0]] || {}) : {};

  // Pathway values shown in the cards: scenario defaults, with the first
  // selected area's overrides layered on top when editing individual areas.
  const displayedPathways = useMemo(() => {
    const base = config.pathways || DEFAULT_PATHWAYS;
    if (!perArea) return base;
    const out = {};
    for (const route of ROUTE_ORDER) {
      const pc = { ...(base[route] || DEFAULT_PATHWAYS[route]) };
      const ov = overridesForFirstSelected[route];
      if (ov) for (const f of AREA_OVERRIDE_FIELDS) if (f in ov) pc[f] = ov[f];
      out[route] = pc;
    }
    return out;
  }, [config.pathways, perArea, overridesForFirstSelected]);

  const handlePathwayChange = useCallback((route, patch) => {
    setConfig(prev => {
      if (!perArea) {
        return {
          ...prev,
          pathways: { ...prev.pathways, [route]: { ...prev.pathways[route], ...patch } },
        };
      }
      // Per-area: only the fields the engine can vary spatially are stored.
      const allowed = Object.fromEntries(
        Object.entries(patch).filter(([k]) => AREA_OVERRIDE_FIELDS.includes(k)),
      );
      if (!Object.keys(allowed).length) return prev;
      const nextOverrides = { ...(prev.area_overrides || {}) };
      for (const key of selectedKeys) {
        const forArea = { ...(nextOverrides[key] || {}) };
        forArea[route] = { ...(forArea[route] || {}), ...allowed };
        nextOverrides[key] = forArea;
      }
      return { ...prev, area_overrides: nextOverrides };
    });
  }, [perArea, selectedKeys]);

  const handleResetAreas = useCallback(() => {
    setConfig(prev => {
      const next = { ...(prev.area_overrides || {}) };
      for (const key of selectedKeys) delete next[key];
      return { ...prev, area_overrides: next };
    });
  }, [selectedKeys]);

  const handleResetDefaults = useCallback(() => setConfig(DEFAULT_CONFIG), []);

  const handleRerun = useCallback(async () => {
    if (!scenarioId) return;
    clearInterval(pollRef.current);
    setRunStatus('running');
    let runId = null;
    try {
      const { data } = await axios.post(`/api/scenarios/${scenarioId}/qmra/run`);
      runId = data.run_id;
    } catch (_) {
      setRunStatus('error');
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await axios.get(`/api/qmra/run-status/${runId}`);
        if (data.group_count) setRunGroupCount(data.group_count);
        if (['success', 'error', 'timeout'].includes(data.status)) {
          clearInterval(pollRef.current);
          setRunStatus(data.status);
        }
      } catch (_) {
        clearInterval(pollRef.current);
        setRunStatus('error');
      }
    }, 2000);
  }, [scenarioId]);

  const overriddenKeys = new Set(Object.keys(config.area_overrides || {}));
  const areaBadges = areaKeys.map(k =>
    overriddenKeys.has(k) ? { color: '#f59e0b', title: 'Has area-specific settings' } : null,
  );

  if (!scenarioId) return null;

  const pathways = displayedPathways;
  const overCap  = groupCount > GROUP_HARD_CAP;

  const runBlock = (
    <div className="space-y-2">
      <button onClick={handleRerun} disabled={runStatus === 'running' || overCap}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-wpBlue text-white text-sm font-semibold hover:bg-wpBlue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        {runStatus === 'running' ? <><RefreshCw size={14} className="animate-spin" /> Running&hellip;</> : <><Play size={14} /> Re-run risk</>}
      </button>
      {groupCount > GROUP_WARN_THRESHOLD && (
        <p className={`text-xs ${overCap ? 'text-red-600' : 'text-amber-600'}`}>
          <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
          {groupCount} distinct area settings — the model runs once per group.
          {overCap
            ? ` Reduce to ${GROUP_HARD_CAP} or fewer before running.`
            : ' This will take considerably longer than a single run.'}
        </p>
      )}
      <RunStatusLine status={runStatus} groupCount={runGroupCount} />
    </div>
  );

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm text-gray-600 flex-1 min-w-[200px]">
          Configure how people are exposed to contaminated water in this scenario.
        </p>
        {saveOk && <span className="flex items-center gap-1 text-green-600 text-xs"><CheckCircle size={12} /> Saved</span>}
        {loading && <RefreshCw size={14} className="animate-spin text-gray-400" />}
        <button
          onClick={handleResetDefaults}
          title="Reset all settings to defaults"
          className="px-2.5 py-1.5 rounded-lg border text-xs font-medium text-gray-600 border-gray-300 bg-white hover:bg-gray-50 transition-colors"
        >
          Reset to defaults
        </button>
        {treatmentAvailable && (
          <Dialog>
            <DialogTrigger asChild>
              <button
                title="View the treatment raster wired into the QMRA drinking-water pathway"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium text-gray-600 border-gray-300 bg-white hover:bg-gray-50 transition-colors"
              >
                <MapIcon size={13} /> View treatment data
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Treatment raster</DialogTitle>
              </DialogHeader>
              <TreatmentMap caseStudyId={caseStudyId} />
            </DialogContent>
          </Dialog>
        )}
        <div className="inline-flex items-center rounded-lg border border-gray-300 bg-gray-100 p-0.5" aria-label="Settings detail level">
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            aria-pressed={!advanced}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              !advanced ? 'bg-wpBlue text-white' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            aria-pressed={advanced}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              advanced ? 'bg-wpBlue text-white' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Advanced
          </button>
        </div>
      </div>

      {/* Area scope */}
      {hasAreas && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <AreaEditModeToggle
              mode={editMode}
              onChange={(m) => { setEditMode(m); if (m === 'all') setSelectedIndices(new Set()); }}
            />
            {editMode === 'individual' && selectedKeys.length > 0 && (
              <button
                onClick={handleResetAreas}
                className="flex items-center gap-1 text-xs text-wpBlue hover:underline"
              >
                <RotateCcw size={11} /> Reset selected area{selectedKeys.length !== 1 ? 's' : ''} to scenario default
              </button>
            )}
          </div>
          {editMode === 'individual' && (
            <>
              <AreaSelector
                labels={areaLabels}
                selectedIndices={selectedIndices}
                onChange={setSelectedIndices}
                allowAll={false}
              />
              <p className="text-xs text-gray-500">
                {selectedKeys.length === 0
                  ? 'Select one or more areas to give them their own pathway settings.'
                  : 'Enabling/disabling pathways for this scenario will affect all scenarios.'}
              </p>
            </>
          )}
        </div>
      )}

      {editMode === 'individual' && hasAreas && selectedKeys.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <p className="text-sm text-gray-500">Select an area above to edit its exposure pathways.</p>
        </div>
      ) : !advanced ? (
        /* Standard mode: compact single-column layout */
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Exposure pathways{perArea && ` - ${selectedKeys.length} area${selectedKeys.length !== 1 ? 's' : ''} selected`}
            </h4>
            {ROUTE_ORDER.map(route => (
              <PathwayCard key={route} route={route} pc={pathways[route] || DEFAULT_PATHWAYS[route]}
                onChange={handlePathwayChange} treatmentAvailable={treatmentAvailable} advanced={false}
                areaMode={perArea} overridden={perArea && !!overridesForFirstSelected[route]} />
            ))}
          </div>
          <div className="border-t border-gray-100 pt-3">{runBlock}</div>
        </div>
      ) : (
        /* Advanced mode: two-column grid */
        <div className="grid grid-cols-[380px_1fr] gap-6 items-start">
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4 text-sm">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Engine settings</h4>
              {perArea && <p className="text-xs text-gray-400 italic">These apply to the whole scenario.</p>}
              <div className="flex items-center gap-3">
                <label className="text-gray-700 w-44 flex-shrink-0">Monte Carlo iterations</label>
                <input type="number" min={100} max={10000} step={100} value={config.mci ?? 1000}
                  onChange={e => setConfig(prev => ({ ...prev, mci: parseInt(e.target.value, 10) || 1000 }))}
                  className="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500" />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-gray-700 w-44 flex-shrink-0">Dose-response model</span>
                <div className="flex gap-4">
                  {[['bp', 'Beta-Poisson'], ['exp', 'Exponential']].map(([val, label]) => (
                    <label key={val} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="qmra-model" value={val} checked={config.model === val}
                        onChange={() => setConfig(prev => ({ ...prev, model: val }))}
                        className="text-wpBlue-600 focus:ring-wpBlue-500" />
                      <span className="text-gray-700">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-gray-700 w-100 pt-1">Quantiles</span>
                <div className="flex gap-2">
                  {['Lower', 'Median', 'Upper'].map((lbl, i) => (
                    <label key={lbl} className="flex flex-col items-center gap-0.5">
                      <span className="text-xs text-gray-500">{lbl}</span>
                      <input type="number" min={0} max={1} step={0.001}
                        value={(config.quantiles ?? [0.025, 0.5, 0.975])[i] ?? ''}
                        onChange={e => {
                          const q = [...(config.quantiles ?? [0.025, 0.5, 0.975])];
                          q[i] = parseFloat(e.target.value);
                          setConfig(prev => ({ ...prev, quantiles: q }));
                        }}
                        className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500" />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <BpParamsCard pathogen={pathogen} config={config} setConfig={setConfig} />

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3 text-sm">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Run</h4>
              <p className="text-xs text-gray-500">Re-run QMRA for this scenario using the configuration above. Emission and concentration outputs are not affected.</p>
              {runBlock}
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Exposure pathways{perArea && ` — ${selectedKeys.length} area${selectedKeys.length !== 1 ? 's' : ''} selected`}
            </h4>
            {ROUTE_ORDER.map(route => (
              <PathwayCard key={route} route={route} pc={pathways[route] || DEFAULT_PATHWAYS[route]}
                onChange={handlePathwayChange} treatmentAvailable={treatmentAvailable} advanced={true}
                areaMode={perArea} overridden={perArea && !!overridesForFirstSelected[route]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
