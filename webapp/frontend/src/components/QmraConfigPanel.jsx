// QMRA configuration panel — Standard / Advanced two-view layout.
//
// Standard view: per-pathway enable toggle, events/year, boiling (when valid).
// Advanced view: adds volume distributions, frequency distributions, global
//   settings (MCI, model), and dose-response (Beta-Poisson) parameter tables.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import {
  Play, RefreshCw, CheckCircle, AlertTriangle,
  ChevronDown, ChevronUp, SlidersHorizontal, Settings2,
} from 'lucide-react';

// ─── Route metadata ───────────────────────────────────────────────────────────
const ROUTE_LABELS = {
  drinking:        'Drinking water',
  swimming:        'Swimming / bathing',
  flooding:        'Flooding',
  open_drain:      'Open drain contact',
  playing:         'Children playing',
  washing_clothes: 'Washing clothes',
};
const ALL_ROUTES = Object.keys(ROUTE_LABELS);

// Which routes support a boiling option
const BOILING_ROUTES = new Set(['drinking']);
// Which routes support treatment
const TREATMENT_ROUTES = new Set(['drinking']);

// ─── Default config (mirrors backend DEFAULT_QMRA_CONFIG) ─────────────────────
const DEFAULT_CONFIG = {
  mci:       1000,
  model:     'bp',
  quantiles: [0.025, 0.5, 0.975],
  bp_params: {
    cryptosporidium: { muw: -1.323, muz: -0.206, varw: 0.294, varz: 1.054, cov: -0.0625 },
    rotavirus:       { muw:  0.571, muz: -5.093, varw: 0.677, varz: 28.180, cov: -2.728  },
  },
  pathways: {
    drinking:        { enabled: true,  volume: { type: 'poisson',    lambda: 3.49, glass: 250 }, frequency: { type: 'fixed',   value: 365  }, boiling: false, use_treatment: false },
    swimming:        { enabled: false, volume: { type: 'triangular', min: 20,  mode: 35,  max: 50  }, frequency: { type: 'nbinom',  size: 0.4, prob: 0.11 } },
    flooding:        { enabled: false, volume: { type: 'triangular', min: 10,  mode: 100, max: 300 }, frequency: { type: 'poisson', lambda: 1   } },
    open_drain:      { enabled: false, volume: { type: 'triangular', min: 0.5, mode: 3,   max: 20  }, frequency: { type: 'poisson', lambda: 200 } },
    playing:         { enabled: false, volume: { type: 'triangular', min: 1,   mode: 10,  max: 50  }, frequency: { type: 'poisson', lambda: 30  } },
    washing_clothes: { enabled: false, volume: { type: 'triangular', min: 0.1, mode: 1,   max: 5   }, frequency: { type: 'poisson', lambda: 200 } },
  },
};

const POLL_MS = 2000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Effective events/year from a frequency config. */
function eventsPerYear(freq) {
  if (!freq) return 365;
  if (freq.type === 'fixed')   return freq.value  ?? 365;
  if (freq.type === 'poisson') return freq.lambda ?? 1;
  if (freq.type === 'nbinom' && freq.size != null && freq.prob != null)
    return (freq.size * (1 - freq.prob)) / freq.prob;
  return 365;
}

/** Update events/year in a frequency config, preserving distribution type. */
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

/** Normalise a raw API config to the new per-pathway structure. */
function normaliseConfig(raw) {
  if (!raw) return DEFAULT_CONFIG;
  // New format already has pathways
  if (raw.pathways) {
    return {
      mci:       raw.mci       ?? DEFAULT_CONFIG.mci,
      model:     raw.model     ?? DEFAULT_CONFIG.model,
      quantiles: raw.quantiles ?? DEFAULT_CONFIG.quantiles,
      bp_params: raw.bp_params ?? DEFAULT_CONFIG.bp_params,
      pathways: Object.fromEntries(
        ALL_ROUTES.map(r => [r, { ...DEFAULT_CONFIG.pathways[r], ...(raw.pathways[r] || {}) }])
      ),
    };
  }
  // Old flat format migration: { routes, model, mci, include_boiling, use_treatment }
  const base = { ...DEFAULT_CONFIG };
  if (raw.model) base.model = raw.model;
  if (raw.mci)   base.mci   = raw.mci;
  const enabledRoutes = raw.routes || ['drinking'];
  const pathways = {};
  for (const r of ALL_ROUTES) {
    pathways[r] = { ...DEFAULT_CONFIG.pathways[r], enabled: enabledRoutes.includes(r) };
    if (r === 'drinking') {
      pathways[r].boiling       = raw.include_boiling ?? false;
      pathways[r].use_treatment = raw.use_treatment   ?? false;
    }
  }
  return { ...base, pathways };
}

// ─── Small shared inputs ──────────────────────────────────────────────────────
function NumInput({ value, onChange, min, max, step = 1, className = '', disabled = false }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className={`rounded border border-gray-300 px-2 py-1 text-xs focus:ring-1 focus:ring-wpBlue focus:border-wpBlue disabled:opacity-40 ${className}`}
    />
  );
}

function ToggleChip({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`flex items-center gap-1.5 select-none ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-gray-300 text-wpBlue focus:ring-wpBlue"
      />
      <span className="text-xs text-gray-600">{label}</span>
    </label>
  );
}

function freqLabel(freq) {
  if (!freq) return '';
  if (freq.type === 'fixed')   return 'fixed';
  if (freq.type === 'poisson') return 'Poisson';
  if (freq.type === 'nbinom')  return 'NB';
  return freq.type;
}

// ─── Per-pathway row ──────────────────────────────────────────────────────────
function PathwayRow({ route, pc, onChange, advanced, treatAvailable }) {
  const enabled   = !!pc.enabled;
  const freq      = pc.frequency || { type: 'fixed', value: 365 };
  const vol       = pc.volume    || { type: 'triangular', min: 1, mode: 10, max: 50 };
  const epy       = eventsPerYear(freq);
  const epm       = (epy / 12).toFixed(1);
  const showBoil  = route === 'drinking';
  const showTreat = route === 'drinking' && advanced;

  const setFreq = f => onChange({ ...pc, frequency: f });
  const setVol  = v => onChange({ ...pc, volume:    v });

  return (
    <div className={`rounded-lg border transition-colors ${enabled ? 'border-wpBlue/30 bg-wpBlue/[0.02]' : 'border-gray-200 bg-white'}`}>
      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onChange({ ...pc, enabled: e.target.checked })}
          className="rounded border-gray-300 text-wpBlue focus:ring-wpBlue flex-shrink-0"
        />
        <span className={`text-sm font-medium flex-1 ${enabled ? 'text-wpBlue' : 'text-gray-500'}`}>
          {route === 'drinking' ? 'Drinking water' :
           route === 'swimming' ? 'Swimming / bathing' :
           route === 'flooding' ? 'Flooding' :
           route === 'open_drain' ? 'Open drain contact' :
           route === 'playing' ? 'Children playing' :
           'Washing clothes'}
        </span>
        {enabled && !advanced && (
          <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded tabular-nums">
            {freqLabel(freq)}
          </span>
        )}
      </div>

      {/* ── Body when enabled ── */}
      {enabled && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-gray-100">

          {/* Events/year */}
          <div className="flex items-center gap-2 pt-2">
            <span className="text-xs text-gray-500 w-28 flex-shrink-0">Events / year</span>
            <NumInput
              value={Math.round(epy * 10) / 10}
              min={0}
              max={36500}
              step={1}
              className="w-24"
              onChange={v => setFreq(withEventsPerYear(freq, v))}
            />
            <span className="text-[10px] text-gray-400">= {epm}/mo</span>
          </div>

          {/* Boiling */}
          {showBoil && (
            <ToggleChip
              checked={!!pc.boiling}
              onChange={v => onChange({ ...pc, boiling: v })}
              label="Include boiling behaviour"
            />
          )}

          {/* ── Advanced only ── */}
          {advanced && (
            <>
              {showTreat && (
                <ToggleChip
                  checked={!!pc.use_treatment}
                  disabled={!treatAvailable}
                  onChange={v => onChange({ ...pc, use_treatment: v })}
                  label={treatAvailable ? 'Apply treatment raster' : 'Apply treatment raster (no treatment.tif found)'}
                />
              )}

              {/* Volume */}
              <div className="border-t border-dashed border-gray-200 pt-2 mt-1">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Volume ingested (mL / event)</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={vol.type}
                    onChange={e => {
                      const t = e.target.value;
                      if (t === 'poisson')
                        setVol({ type: 'poisson', lambda: vol.lambda ?? 1, glass: vol.glass ?? 250 });
                      else
                        setVol({ type: 'triangular', min: vol.min ?? 1, mode: vol.mode ?? 10, max: vol.max ?? 50 });
                    }}
                    className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                  >
                    <option value="triangular">Triangular</option>
                    <option value="poisson">Poisson</option>
                  </select>
                  {vol.type === 'triangular' ? (
                    <>
                      <label className="text-[10px] text-gray-500">min</label>
                      <NumInput value={vol.min}  step={0.1} className="w-16" onChange={v => setVol({ ...vol, min:  parseFloat(v) || 0 })} />
                      <label className="text-[10px] text-gray-500">mode</label>
                      <NumInput value={vol.mode} step={0.1} className="w-16" onChange={v => setVol({ ...vol, mode: parseFloat(v) || 0 })} />
                      <label className="text-[10px] text-gray-500">max</label>
                      <NumInput value={vol.max}  step={0.1} className="w-16" onChange={v => setVol({ ...vol, max:  parseFloat(v) || 0 })} />
                    </>
                  ) : (
                    <>
                      <label className="text-[10px] text-gray-500">λ</label>
                      <NumInput value={vol.lambda} step={0.01} className="w-20" onChange={v => setVol({ ...vol, lambda: parseFloat(v) || 0 })} />
                      <label className="text-[10px] text-gray-500">glass (mL)</label>
                      <NumInput value={vol.glass ?? 250} step={10} className="w-20" onChange={v => setVol({ ...vol, glass: parseInt(v, 10) || 250 })} />
                    </>
                  )}
                </div>
              </div>

              {/* Frequency distribution */}
              <div>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Frequency distribution</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={freq.type}
                    onChange={e => {
                      const t = e.target.value;
                      const cur = eventsPerYear(freq);
                      if (t === 'fixed')        setFreq({ type: 'fixed',   value: Math.round(cur) });
                      else if (t === 'poisson') setFreq({ type: 'poisson', lambda: cur });
                      else                      setFreq({ type: 'nbinom',  size: 0.4, prob: 0.11 });
                    }}
                    className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                  >
                    <option value="fixed">Fixed</option>
                    <option value="poisson">Poisson</option>
                    <option value="nbinom">Neg. Binomial</option>
                  </select>
                  {freq.type === 'fixed' && (
                    <>
                      <label className="text-[10px] text-gray-500">value</label>
                      <NumInput value={freq.value ?? 365} step={1} className="w-24"
                        onChange={v => setFreq({ ...freq, value: parseFloat(v) || 0 })} />
                    </>
                  )}
                  {freq.type === 'poisson' && (
                    <>
                      <label className="text-[10px] text-gray-500">λ</label>
                      <NumInput value={freq.lambda ?? 1} step={1} className="w-24"
                        onChange={v => setFreq({ ...freq, lambda: parseFloat(v) || 0 })} />
                    </>
                  )}
                  {freq.type === 'nbinom' && (
                    <>
                      <label className="text-[10px] text-gray-500">size</label>
                      <NumInput value={freq.size ?? 0.4} step={0.01} min={0.001} className="w-20"
                        onChange={v => setFreq({ ...freq, size: parseFloat(v) || 0.4 })} />
                      <label className="text-[10px] text-gray-500">prob</label>
                      <NumInput value={freq.prob ?? 0.11} step={0.01} min={0.001} max={0.999} className="w-20"
                        onChange={v => setFreq({ ...freq, prob: Math.max(0.001, Math.min(0.999, parseFloat(v) || 0.11)) })} />
                      <span className="text-[10px] text-gray-400">
                        mean ≈ {(((freq.size || 0.4) * (1 - (freq.prob || 0.11))) / (freq.prob || 0.11)).toFixed(1)}/yr
                      </span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Beta-Poisson params editor ───────────────────────────────────────────────
const BP_FIELDS = [
  { key: 'muw',  label: 'μw',  step: 0.001  },
  { key: 'muz',  label: 'μz',  step: 0.001  },
  { key: 'varw', label: 'σ²w', step: 0.001  },
  { key: 'varz', label: 'σ²z', step: 0.001  },
  { key: 'cov',  label: 'Cov', step: 0.0001 },
];

function BpParamsEditor({ bpParams, onChange }) {
  return (
    <div className="space-y-3">
      {Object.keys(bpParams || {}).map(pathogen => (
        <div key={pathogen}>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 capitalize">{pathogen}</p>
          <div className="grid grid-cols-5 gap-1.5">
            {BP_FIELDS.map(({ key, label, step }) => (
              <div key={key} className="flex flex-col gap-0.5">
                <label className="text-[10px] text-gray-400 text-center">{label}</label>
                <input
                  type="number"
                  step={step}
                  value={bpParams[pathogen][key] ?? 0}
                  onChange={e => onChange({
                    ...bpParams,
                    [pathogen]: { ...bpParams[pathogen], [key]: parseFloat(e.target.value) || 0 },
                  })}
                  className="text-xs rounded border border-gray-300 px-1.5 py-1 text-center focus:ring-1 focus:ring-wpBlue focus:border-wpBlue"
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────
export default function QmraConfigPanel({ scenarioId, caseStudyId, scenarioInfo, onRunStarted }) {
  const [config, setConfig]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saveOk, setSaveOk]     = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const isFirstLoad = useRef(true);

  const [runStatus, setRunStatus]           = useState('idle');
  const [runError, setRunError]             = useState('');
  const [runLog, setRunLog]                 = useState('');
  const [showLog, setShowLog]               = useState(false);
  const [rerunAllStatus, setRerunAllStatus] = useState('idle');
  const [rerunAllInfo, setRerunAllInfo]     = useState(null);
  const pollRef = useRef(null);

  // ── Load config ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!scenarioId) return;
    isFirstLoad.current = true;
    setLoading(true);
    axios.get(`/api/scenarios/${scenarioId}/qmra/config`)
      .then(({ data }) => setConfig(normaliseConfig(data)))
      .catch(() => setConfig(normaliseConfig(null)))
      .finally(() => setLoading(false));
  }, [scenarioId]);

  // ── Auto-save ────────────────────────────────────────────────────────────────
  const saveTimer = useRef(null);
  useEffect(() => {
    if (loading || !config) return;
    if (isFirstLoad.current) { isFirstLoad.current = false; return; }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!scenarioId) return;
      try {
        await axios.put(`/api/scenarios/${scenarioId}/qmra/config`, config);
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 1500);
      } catch { /* ignore */ }
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Poll ─────────────────────────────────────────────────────────────────────
  const startPolling = useCallback((id) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await axios.get(`/api/qmra/run-status/${id}`);
        setRunStatus(data.status);
        if (data.status === 'success' || data.status === 'error') {
          clearInterval(pollRef.current); pollRef.current = null;
          try {
            const { data: ld } = await axios.get(`/api/scenarios/${scenarioId}/qmra/log`);
            setRunLog(ld.log || '');
          } catch { /* ignore */ }
          if (data.status === 'error') setRunError(data.stderr || 'QMRA run failed.');
        }
      } catch {
        clearInterval(pollRef.current); pollRef.current = null;
        setRunStatus('error'); setRunError('Could not reach server.');
      }
    }, POLL_MS);
  }, [scenarioId]);

  // ── Run ──────────────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    if (!scenarioId || !config) return;
    setRunStatus('queued'); setRunError(''); setRunLog('');
    try {
      const { data } = await axios.post(`/api/scenarios/${scenarioId}/qmra/run`, config);
      setRunStatus(data.status || 'queued');
      startPolling(data.run_id);
      if (onRunStarted) onRunStarted(data.run_id);
    } catch (err) {
      setRunStatus('error');
      setRunError(err?.response?.data?.error || 'Failed to start QMRA run.');
    }
  }, [scenarioId, config, startPolling, onRunStarted]);

  const handleRerunAll = useCallback(async () => {
    if (!caseStudyId) return;
    setRerunAllStatus('running'); setRerunAllInfo(null);
    try {
      const { data } = await axios.post(`/api/case-studies/${caseStudyId}/qmra/rerun-all`);
      setRerunAllStatus('success'); setRerunAllInfo(data);
    } catch { setRerunAllStatus('error'); }
  }, [caseStudyId]);

  const isRunning      = runStatus === 'queued' || runStatus === 'running';
  const hasOutput      = scenarioInfo?.has_qmra_output;
  const treatAvailable = scenarioInfo?.treatment_available ?? false;

  const updatePathway = (route, pc) =>
    setConfig(prev => ({ ...prev, pathways: { ...prev.pathways, [route]: pc } }));

  if (loading) return (
    <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
      <RefreshCw size={16} className="animate-spin mr-2" /> Loading config…
    </div>
  );
  if (!config) return null;

  return (
    <div className="p-4 space-y-5 text-sm">

      {/* ── Header + view toggle ── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-800">Health Risk (QMRA)</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Configure exposure pathways and run a Quantitative Microbial Risk Assessment.
          </p>
        </div>
        <button
          onClick={() => setAdvanced(v => !v)}
          title={advanced ? 'Switch to standard view' : 'Switch to advanced view'}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors flex-shrink-0 ${
            advanced
              ? 'bg-wpBlue text-white border-wpBlue'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          }`}
        >
          <SlidersHorizontal size={13} />
          {advanced ? 'Advanced' : 'Standard'}
        </button>
      </div>

      {/* ── Advanced: Global settings ── */}
      {advanced && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-3">
          <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1.5">
            <Settings2 size={13} /> Global settings
          </h3>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 w-36">Monte Carlo iterations</label>
              <NumInput
                value={config.mci ?? 1000}
                min={100} max={10000} step={100}
                className="w-24"
                onChange={v => setConfig(p => ({ ...p, mci: parseInt(v, 10) || 1000 }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 w-32">Dose-response model</label>
              <div className="flex gap-3">
                {[['bp', 'Beta-Poisson'], ['exp', 'Exponential']].map(([val, lbl]) => (
                  <label key={val} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="dr-model-adv" value={val}
                      checked={config.model === val}
                      onChange={() => setConfig(p => ({ ...p, model: val }))}
                      className="text-wpBlue focus:ring-wpBlue"
                    />
                    <span className="text-xs text-gray-700">{lbl}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Advanced: Dose-response defaults ── */}
      {advanced && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1.5 mb-2">
            <Settings2 size={13} /> Dose-response defaults (Beta-Poisson)
          </h3>
          <BpParamsEditor
            bpParams={config.bp_params ?? {}}
            onChange={bp => setConfig(p => ({ ...p, bp_params: bp }))}
          />
        </section>
      )}

      {/* ── Exposure pathways ── */}
      <section>
        <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
          Exposure pathways
        </h3>
        <div className="space-y-2">
          {ALL_ROUTES.map(route => (
            <PathwayRow
              key={route}
              route={route}
              pc={config.pathways?.[route] ?? DEFAULT_CONFIG.pathways[route]}
              onChange={pc => updatePathway(route, pc)}
              advanced={advanced}
              treatAvailable={treatAvailable}
            />
          ))}
        </div>
      </section>

      {/* ── Standard: model + MCI compact row ── */}
      {!advanced && (
        <section className="flex items-center gap-4 flex-wrap text-xs text-gray-600 border-t border-gray-100 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Model:</span>
            <div className="flex gap-3">
              {[['bp', 'Beta-Poisson'], ['exp', 'Exponential']].map(([val, lbl]) => (
                <label key={val} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="dr-model-std" value={val}
                    checked={config.model === val}
                    onChange={() => setConfig(p => ({ ...p, model: val }))}
                    className="text-wpBlue focus:ring-wpBlue"
                  />
                  <span>{lbl}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Iterations:</span>
            <NumInput value={config.mci ?? 1000} min={100} max={10000} step={100} className="w-20"
              onChange={v => setConfig(p => ({ ...p, mci: parseInt(v, 10) || 1000 }))} />
          </div>
        </section>
      )}

      {/* ── Run button ── */}
      <div className="flex items-center gap-3 flex-wrap border-t border-gray-100 pt-3">
        <button
          onClick={handleRun}
          disabled={isRunning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wpBlue text-white text-xs font-medium hover:bg-wpBlue/90 disabled:opacity-50"
        >
          {isRunning
            ? <><RefreshCw size={13} className="animate-spin" /> Running…</>
            : <><Play size={13} /> Run risk model</>
          }
        </button>
        {saveOk && (
          <span className="flex items-center gap-1 text-green-600 text-xs">
            <CheckCircle size={12} /> Saved
          </span>
        )}
      </div>

      {/* ── Status ── */}
      {runStatus === 'success' && (
        <div className="flex items-center gap-2 text-green-600 text-xs">
          <CheckCircle size={14} /> Risk calculation complete. View results in Analytics.
        </div>
      )}
      {runStatus === 'error' && (
        <div className="flex items-start gap-2 text-red-600 text-xs">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{runError || 'QMRA run failed.'}</span>
        </div>
      )}
      {(runStatus === 'success' || runStatus === 'error') && runLog && (
        <div>
          <button
            onClick={() => setShowLog(v => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            {showLog ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && (
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-50 border border-gray-200 p-2 text-xs text-gray-700 whitespace-pre-wrap">
              {runLog}
            </pre>
          )}
        </div>
      )}

      {/* ── Re-run all scenarios ── */}
      {hasOutput && caseStudyId && (
        <section className="border-t border-gray-100 pt-4">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Re-run all scenarios</h3>
          <p className="text-xs text-gray-500 mb-2">
            Re-estimates risk for every scenario in this case study that has concentration outputs,
            using each scenario's saved QMRA configuration.
          </p>
          <button
            onClick={handleRerunAll}
            disabled={rerunAllStatus === 'running'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {rerunAllStatus === 'running'
              ? <><RefreshCw size={13} className="animate-spin" /> Starting…</>
              : <><RefreshCw size={13} /> Re-run risk (all scenarios)</>
            }
          </button>
          {rerunAllStatus === 'success' && rerunAllInfo && (
            <div className="mt-2 text-green-600 text-xs flex items-center gap-1.5">
              <CheckCircle size={13} /> Started {rerunAllInfo.started} run{rerunAllInfo.started !== 1 ? 's' : ''}.
            </div>
          )}
          {rerunAllStatus === 'error' && (
            <div className="mt-2 text-red-600 text-xs flex items-center gap-1.5">
              <AlertTriangle size={13} /> Failed to start re-run.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
