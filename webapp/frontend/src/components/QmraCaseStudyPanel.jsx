// QMRA case-study configuration panel -- shown as the overhead "QMRA" tab.
// Config is case-study-wide and stored as a JSON blob in scenario_metadata.csv.
// Changes auto-save (debounced 600 ms) via PUT /api/case-studies/:id/qmra/config.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { Play, RefreshCw, CheckCircle, AlertTriangle, ChevronDown, ChevronRight, SlidersHorizontal, Map as MapIcon } from 'lucide-react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import parseGeoraster from 'georaster';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from './Dialog';
import RiskIcon from '../../assets/icons/risk.svg';

// Required by georaster-layer-for-leaflet to reproject TIFs not in WGS84
if (typeof window !== 'undefined') window.proj4 = proj4;

// Constants
const ROUTE_ORDER = ['drinking', 'swimming', 'flooding', 'open_drain', 'playing', 'washing_clothes'];
const ROUTE_LABELS = {
  drinking:        'Drinking water',
  swimming:        'Swimming / bathing',
  flooding:        'Flooding',
  open_drain:      'Open drain contact',
  playing:         'Children playing',
  washing_clothes: 'Washing clothes',
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
const DEFAULT_CONFIG = { mci: 1000, model: 'bp', quantiles: [0.025, 0.5, 0.975], bp_params: PATHOGEN_BP_DEFAULTS, pathways: DEFAULT_PATHWAYS };

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
        <p className="text-xs text-gray-400 italic">No pathogen detected. Run the GloWPa model for at least one scenario first.</p>
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

// Per-pathway card
function PathwayCard({ route, pc, onChange, treatmentAvailable, advanced = true }) {
  const [open, setOpen] = useState(pc.enabled);
  const isDrinking = route === 'drinking';
  const set     = (key, val) => onChange(route, { ...pc, [key]: val });
  const setVol  = (key, val) => onChange(route, { ...pc, volume:    { ...pc.volume,    [key]: val } });
  const setFreq = (key, val) => onChange(route, { ...pc, frequency: { ...pc.frequency, [key]: val } });
  const vol      = pc.volume    || {};
  const freq     = pc.frequency || {};
  const volType  = vol.type  || 'triangular';
  const freqType = freq.type || 'fixed';
  const epy      = eventsPerYear(freq);
  const handleEnable = checked => { onChange(route, { ...pc, enabled: checked }); if (checked) setOpen(true); };
  return (
    <div className={`rounded-lg border ${pc.enabled ? 'border-wpBlue-200 bg-white' : 'border-gray-200 bg-gray-50'} overflow-hidden`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 ${advanced && pc.enabled ? 'cursor-pointer' : ''} select-none`} onClick={() => advanced && pc.enabled && setOpen(o => !o)}>
        <input type="checkbox" checked={!!pc.enabled} onChange={e => handleEnable(e.target.checked)} onClick={e => e.stopPropagation()} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
        <span className={`font-medium text-sm flex-1 ${pc.enabled ? 'text-wpBlue' : 'text-gray-500'}`}>{ROUTE_LABELS[route]}</span>
        {advanced && pc.enabled && (open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />)}
      </div>
      {/* Standard mode: simplified controls */}
      {!advanced && pc.enabled && (
        <div className="px-4 pb-3 border-t border-gray-100 pt-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-28 flex-shrink-0">Events / year</span>
            <input type="number" min={0} max={36500} step={1}
              value={Math.round(epy * 10) / 10}
              onChange={e => onChange(route, { ...pc, frequency: withEventsPerYear(freq, e.target.value) })}
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
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Volume (mL)</p>
            {isDrinking ? (
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
                  <select value={volType} onChange={e => onChange(route, { ...pc, volume: { type: e.target.value } })} className="rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500">
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
                  <select value={freqType} onChange={e => onChange(route, { ...pc, frequency: { type: e.target.value } })} className="rounded border border-gray-300 px-2 py-1 text-sm focus:ring-wpBlue-500 focus:border-wpBlue-500">
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
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!pc.use_treatment} onChange={e => set('use_treatment', e.target.checked)} className="rounded border-gray-300 text-wpBlue-600 focus:ring-wpBlue-500" />
                  <span className="text-gray-700">Apply treatment raster</span>
                </label>
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
  const absent  = legend.filter(e => !e.present && e.code >= 5); // show absent treatment codes too
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

  // Build code→color map from legend for the raster layer
  const codeColors = legend
    ? Object.fromEntries(legend.map(e => [e.code, e.color]))
    : DEFAULT_CODE_COLORS;

  if (failed) {
    return <p className="text-sm text-gray-500">No treatment raster found for this case study.</p>;
  }
  return (
    <div className="space-y-1">
      <MapContainer center={[0, 0]} zoom={2} style={{ height: 400, width: '100%', borderRadius: 8 }}>
        <TileLayer url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png" attribution="&copy; CARTO &copy; OSM" />
        <TreatmentRasterLayer tifUrl={tifUrl} codeColors={codeColors} />
        <TileLayer url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png" attribution="" zIndex={650} pane="overlayPane" />
      </MapContainer>
      <p className="text-xs text-gray-400">
        Treatment raster wired into the drinking-water pathway. Log-reduction values are sampled per treatment step at run time.
      </p>
      <TreatmentLegend legend={legend} />
    </div>
  );
}

// ── Aggregate re-run status line (mirrors standard scenario execution) ───────
function RerunStatus({ status, progress }) {
  if (status === 'running') {
    return (
      <div className="flex items-center gap-1.5 text-blue-700 text-xs">
        <RefreshCw size={13} className="animate-spin" />
        {progress
          ? `Running QMRA — ${progress.done}/${progress.total} scenario${progress.total !== 1 ? 's' : ''} done`
          : 'Running QMRA…'}
      </div>
    );
  }
  if (status === 'success') {
    const n = progress?.success ?? progress?.total ?? 0;
    return (
      <div className="flex items-center gap-1.5 text-green-600 text-xs">
        <CheckCircle size={13} /> Done — {n} scenario{n !== 1 ? 's' : ''} completed.
      </div>
    );
  }
  if (status === 'partial') {
    const err = progress?.error ?? 0;
    const ok  = progress?.success ?? 0;
    return (
      <div className="flex items-center gap-1.5 text-orange-600 text-xs">
        <AlertTriangle size={13} /> Completed with {err} error{err !== 1 ? 's' : ''} ({ok} succeeded).
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-1.5 text-red-600 text-xs">
        <AlertTriangle size={13} /> Failed to run QMRA.
      </div>
    );
  }
  return null;
}

// Main component
export default function QmraCaseStudyPanel({ caseStudyId, scenarios = [] }) {
  const [config, setConfig]                     = useState(DEFAULT_CONFIG);
  const [treatmentAvailable, setTreatmentAvail] = useState(false);
  const [loading, setLoading]                   = useState(true);
  const [saveOk, setSaveOk]                     = useState(false);
  const [rerunStatus, setRerunStatus]           = useState('idle');
  const [rerunInfo, setRerunInfo]               = useState(null);
  const [rerunProgress, setRerunProgress]       = useState(null); // { total, done, success, error }
  const [advanced, setAdvanced]                 = useState(false);
  const isFirstLoad   = useRef(true);
  const autoSaveTimer = useRef(null);
  const pollRef       = useRef(null);

  // Stop polling on unmount.
  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => {
    if (!caseStudyId) return;
    isFirstLoad.current = true;
    setLoading(true);
    axios.get(`/api/case-studies/${caseStudyId}/qmra/config`)
      .then(({ data }) => {
        setTreatmentAvail(!!data.treatment_available);
        setConfig({
          mci:       data.mci       ?? 1000,
          model:     data.model     ?? 'bp',
          quantiles: data.quantiles ?? [0.025, 0.5, 0.975],
          bp_params: data.bp_params ?? PATHOGEN_BP_DEFAULTS,
          pathways:  data.pathways  ?? DEFAULT_PATHWAYS,
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [caseStudyId]);

  useEffect(() => {
    if (loading) return;
    if (isFirstLoad.current) { isFirstLoad.current = false; return; }
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      if (!caseStudyId) return;
      try {
        await axios.put(`/api/case-studies/${caseStudyId}/qmra/config`, config);
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 1500);
      } catch (_) {}
    }, 600);
    return () => clearTimeout(autoSaveTimer.current);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePathwayChange = useCallback((route, pc) => {
    setConfig(prev => ({ ...prev, pathways: { ...prev.pathways, [route]: pc } }));
  }, []);

  const handleResetDefaults = useCallback(() => {
    setConfig(DEFAULT_CONFIG);
  }, []);

  const handleRerunAll = useCallback(async () => {
    if (!caseStudyId) return;
    clearInterval(pollRef.current);
    setRerunStatus('running'); setRerunInfo(null); setRerunProgress(null);

    let runs = [];
    try {
      const { data } = await axios.post(`/api/case-studies/${caseStudyId}/qmra/rerun-all`);
      setRerunInfo(data);
      runs = data.runs || [];
    } catch (_) {
      setRerunStatus('error');
      return;
    }

    if (!runs.length) {
      setRerunStatus('success');
      setRerunProgress({ total: 0, done: 0, success: 0, error: 0 });
      return;
    }

    setRerunProgress({ total: runs.length, done: 0, success: 0, error: 0 });
    const statuses = {};
    const isTerminal = s => ['success', 'error', 'timeout'].includes(s);

    pollRef.current = setInterval(async () => {
      await Promise.all(runs.map(async ({ run_id }) => {
        if (isTerminal(statuses[run_id])) return;
        try {
          const { data } = await axios.get(`/api/qmra/run-status/${run_id}`);
          statuses[run_id] = data.status;
        } catch (_) {
          statuses[run_id] = 'error';
        }
      }));

      const vals    = runs.map(r => statuses[r.run_id]);
      const done    = vals.filter(isTerminal).length;
      const success = vals.filter(s => s === 'success').length;
      const error   = vals.filter(s => s === 'error' || s === 'timeout').length;
      setRerunProgress({ total: runs.length, done, success, error });

      if (done >= runs.length) {
        clearInterval(pollRef.current);
        setRerunStatus(error > 0 ? (success > 0 ? 'partial' : 'error') : 'success');
      }
    }, 2000);
  }, [caseStudyId]);

  const hasHydrology     = scenarios.length > 0;
  const pathways          = config.pathways || DEFAULT_PATHWAYS;
  const detectedPathogen  = scenarios.find(s => s.pathogen)?.pathogen?.toLowerCase() || null;
  if (!caseStudyId) return null;

  return (
    <div className="bg-wpWhite-100 rounded-b-xl h-full overflow-y-auto p-6">

      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <img src={RiskIcon} alt="Risk" className="w-8 h-8 flex-shrink-0" />
        <h3 className="text-lg font-semibold text-wpBlue flex-1">QMRA settings</h3>
        {saveOk && <span className="flex items-center gap-1 text-green-600 text-xs"><CheckCircle size={12} /> Saved</span>}
        {loading && <RefreshCw size={14} className="animate-spin text-gray-400" />}
        <button
          onClick={handleResetDefaults}
          title="Reset all settings to defaults"
          className="px-2.5 py-1.5 rounded-lg border text-xs font-medium text-gray-600 border-gray-300 bg-white hover:bg-gray-50 transition-colors"
        >
          Reset to defaults
        </button>
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
        <button
          onClick={() => setAdvanced(v => !v)}
          title={advanced ? 'Switch to standard view' : 'Switch to advanced view'}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
            advanced ? 'bg-wpBlue text-white border-wpBlue' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          }`}
        >
          <SlidersHorizontal size={13} />
          {advanced ? 'Advanced' : 'Standard'}
        </button>
      </div>

      {/* ── Instructions (always visible) ── */}
      <div className="bg-wpBlue/5 rounded-xl border border-wpBlue/10 p-4 text-sm text-gray-700 space-y-2 mb-5">
        <p className="font-semibold text-wpBlue">How to use</p>
        <p>Enable the <strong>exposure pathways</strong> relevant to your case study and click <strong>Re-run risk</strong> to generate health-risk rasters for all scenarios with concentration outputs.</p>
        <p>Use <strong>Advanced</strong> mode (top-right) to configure model parameters, dose-response defaults, and the full volume and frequency distributions for each pathway.</p>
      </div>

      {/* ── Standard mode: compact single-column layout ── */}
      {!advanced && (
        <div className="space-y-4">
          {/* Pathways */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Exposure pathways</h4>
            {ROUTE_ORDER.map(route => (
              <PathwayCard key={route} route={route} pc={pathways[route] || DEFAULT_PATHWAYS[route]}
                onChange={handlePathwayChange} treatmentAvailable={treatmentAvailable} advanced={false} />
            ))}
          </div>
          {/* Run */}
          <div className="border-t border-gray-100 pt-3 space-y-2">
            <button onClick={handleRerunAll} disabled={rerunStatus === 'running' || !hasHydrology}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-wpBlue text-white text-sm font-semibold hover:bg-wpBlue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              {rerunStatus === 'running' ? <><RefreshCw size={14} className="animate-spin" /> Running&hellip;</> : <><Play size={14} /> Re-run risk (all scenarios)</>}
            </button>
            {!hasHydrology && <p className="text-xs text-gray-400">No scenarios with concentration outputs found. Run the GloWPa model first.</p>}
            <RerunStatus status={rerunStatus} progress={rerunProgress} />
          </div>
        </div>
      )}

      {/* Two-column grid (advanced) */}
      {advanced && <div className="grid grid-cols-[380px_1fr] gap-6 items-start">

        {/* ── Left column: settings + instructions + re-run ── */}
        <div className="space-y-4">

          {/* Global settings */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4 text-sm">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Global settings</h4>
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

          {/* Pathogen dose-response defaults */}
          <BpParamsCard pathogen={detectedPathogen} config={config} setConfig={setConfig} />

          {/* Re-run */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3 text-sm">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Run</h4>
            <p className="text-xs text-gray-500">Re-run QMRA for every scenario in this case study that has concentration outputs, using the configuration above.</p>
            <button onClick={handleRerunAll} disabled={rerunStatus === 'running' || !hasHydrology}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-wpBlue text-white text-sm font-semibold hover:bg-wpBlue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              {rerunStatus === 'running' ? <><RefreshCw size={14} className="animate-spin" /> Running&hellip;</> : <><Play size={14} /> Re-run risk (all scenarios)</>}
            </button>
            {!hasHydrology && <p className="text-xs text-gray-400">No scenarios with concentration outputs found. Run the GloWPa model first.</p>}
            <RerunStatus status={rerunStatus} progress={rerunProgress} />
          </div>

        </div>{/* end left column */}

        {/* ── Right column: exposure pathways ── */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Exposure pathways</h4>
          {ROUTE_ORDER.map(route => (
            <PathwayCard key={route} route={route} pc={pathways[route] || DEFAULT_PATHWAYS[route]}
              onChange={handlePathwayChange} treatmentAvailable={treatmentAvailable} advanced={true} />
          ))}
        </div>

      </div>}{/* end advanced grid */}
    </div>
  );
}