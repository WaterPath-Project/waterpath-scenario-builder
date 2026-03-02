import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import useScenarioStore from '../store/scenarioStore';
import {
  CheckCircle,
  XCircle,
  MinusCircle,
  Play,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Loader2,
  ScrollText,
  BarChart2,
} from 'lucide-react';

// ─── Small helpers ────────────────────────────────────────────────────────────

const capitalizeFirst = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : '';

const PILL_CLASSES = {
  pathogen: 'bg-purple-100 text-purple-700',
  ssp:      'bg-blue-100  text-blue-700',
  year:     'bg-amber-100 text-amber-700',
};

const REQUIRED_FILES = ['isodata.csv', 'isoraster.tif', 'poprural.tif', 'popurban.tif'];
const OPTIONAL_FILES = ['treatment.csv'];

function FileRow({ name, status, note }) {
  if (status === 'present') {
    return (
      <div className="flex items-center gap-2 text-sm text-green-700">
        <CheckCircle size={14} className="flex-shrink-0" />
        <span>{name}</span>
        {note && <span className="text-xs text-gray-400 ml-1">{note}</span>}
      </div>
    );
  }
  if (status === 'missing') {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600">
        <XCircle size={14} className="flex-shrink-0" />
        <span>{name}</span>
      </div>
    );
  }
  // optional / present-optional
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400">
      <MinusCircle size={14} className="flex-shrink-0" />
      <span>{name}</span>
      {note && <span className="text-xs text-gray-400 ml-1">{note}</span>}
    </div>
  );
}

function ReadinessPanel({ readiness, pathogen }) {
  if (!readiness) return null;

  return (
    <div className="mt-3 space-y-1">
      {/* Required files */}
      <p className="text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">Required files</p>
      {REQUIRED_FILES.map((f) => (
        <FileRow
          key={f}
          name={f}
          status={readiness.present_files?.includes(f) ? 'present' : 'missing'}
          note={f === 'isodata.csv' ? '→ auto-converted to .RDS' : undefined}
        />
      ))}
      {/* Pathogen — metadata, not a file */}
      <p className="text-xs font-medium text-gray-500 mb-1 mt-2 uppercase tracking-wide">Scenario metadata</p>
      <FileRow
        name={`Pathogen${pathogen ? `: ${pathogen}` : ''}`}
        status={readiness.has_pathogen ? 'present' : 'missing'}
        note={readiness.has_pathogen ? '(from config)' : 'set in scenario settings'}
      />
      {/* Optional */}
      <p className="text-xs font-medium text-gray-500 mb-1 mt-2 uppercase tracking-wide">Optional</p>
      <FileRow
        name="treatment.csv"
        status={readiness.optional_files?.includes('treatment.csv') ? 'present' : 'optional'}
        note={readiness.optional_files?.includes('treatment.csv') ? '→ auto-converted to .RDS' : undefined}
      />
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function RunStatusBadge({ status }) {
  const cfg = {
    idle:    { label: 'Idle',  cls: 'bg-gray-100 text-gray-500' },
    pending: { label: 'Queued',   cls: 'bg-yellow-100 text-yellow-700' },
    running: { label: 'Running…', cls: 'bg-blue-100 text-blue-700' },
    success: { label: 'Done ✓',   cls: 'bg-green-100 text-green-700' },
    error:   { label: 'Error',    cls: 'bg-red-100 text-red-700' },
    timeout: { label: 'Timeout',  cls: 'bg-orange-100 text-orange-700' },
  };
  const { label, cls } = cfg[status] || cfg.idle;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalyticsScenarioCard({ scenario, onRunComplete, onViewResults, isAnyRunning, onRunStart, onRunEnd }) {
  const dirtyScenarioIds = useScenarioStore((state) => state.dirtyScenarioIds);
  const hasDirtyChanges = !!dirtyScenarioIds?.[scenario.id];
  const [showReadiness, setShowReadiness] = useState(false);
  const [runId, setRunId] = useState(null);
  const [runMode, setRunMode] = useState(null);
  const [runStatus, setRunStatus] = useState('idle');
  const [runOutput, setRunOutput] = useState({ stdout: '', stderr: '' });
  const [runLoading, setRunLoading] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const pollRef = useRef(null);

  // Log state
  const [glowpaLog, setGlowpaLog] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const { readiness } = scenario;
  const canRun = readiness?.ready === true;

  // Derived success: either just finished this session, or has prior outputs
  const justSucceeded = runStatus === 'success';
  const hasResults = justSucceeded || !!scenario.has_outputs;

  // ── Poll run status ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`/api/run-status/${runId}`);
        const data = res.data;
        setRunStatus(data.status);
        setRunOutput({ stdout: data.stdout || '', stderr: data.stderr || '' });
        if (['success', 'error', 'timeout'].includes(data.status)) {
          clearInterval(pollRef.current);
          setRunLoading(false);
          onRunEnd?.();
          onRunComplete?.(scenario.id, data.status);
        }
      } catch {
        clearInterval(pollRef.current);
        setRunLoading(false);
        setRunStatus('error');
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [runId]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleRunModel = async () => {
    setRunLoading(true);
    setRunStatus('pending');
    setShowOutput(true);
    onRunStart?.();
    try {
      const res = await axios.post(`/api/scenarios/${scenario.id}/run-model`);
      setRunId(res.data.run_id);
      setRunMode(res.data.mode);
    } catch (err) {
      setRunLoading(false);
      setRunStatus('error');
      setRunOutput({ stdout: '', stderr: err.response?.data?.error || err.message });
      onRunEnd?.();
    }
  };

  const handleFetchLog = async (force = false) => {
    if (glowpaLog && showLog && !force) { setShowLog(false); return; }
    setLogLoading(true);
    try {
      const res = await axios.get(`/api/scenarios/${scenario.id}/glowpa-log?tail=500`);
      setGlowpaLog(res.data);
      setShowLog(true);
    } catch (err) {
      alert('Failed to fetch log: ' + (err.response?.data?.error || err.message));
    } finally {
      setLogLoading(false);
    }
  };

  // ── Derived labels ─────────────────────────────────────────────────────────
  const metaTags = [
    scenario.pathogen && { type: 'pathogen', label: `${capitalizeFirst(scenario.pathogen)}` },
    scenario.ssp      && { type: 'ssp',      label: `${scenario.ssp}` },
    scenario.year     && { type: 'year',     label: String(scenario.year) },
  ].filter(Boolean);

  return (
    <div className={`p-4 rounded-lg border bg-wpWhite-100 transition-all ${
      canRun ? 'border-gray-200 hover:shadow-md' : 'border-orange-200 bg-orange-50/30'
    }`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="font-semibold text-gray-900 truncate">{scenario.name}</h4>
          {metaTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {metaTags.map((t) => (
                <span key={t.label} className={`text-xs font-medium px-1.5 py-0.5 rounded ${PILL_CLASSES[t.type]}`}>
                  {t.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
          {runStatus !== 'idle' && <RunStatusBadge status={runStatus} />}
          {hasDirtyChanges && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 flex items-center gap-1" title="This scenario has unsaved changes — save and re-run to update results">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block" /> Re-run needed
            </span>
          )}
          {hasResults ? (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-wpGreen text-wpBlue-900 flex items-center gap-1">
              <CheckCircle size={11} /> Results ready
            </span>
          ): <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-wpBrown text-wpBlue-900 flex items-center gap-1">
              No results yet
            </span>
          }
          {!canRun && (
            <AlertTriangle size={18} className="text-orange-500" title="Not ready – missing files or pathogen" />
          )}
        </div>
      </div>

      {/* Readiness toggle — only shown when NOT ready */}
      {!canRun && (
        <>
          <button
            className="mt-2 flex items-center gap-1 text-xs text-orange-600 hover:text-orange-800"
            onClick={() => setShowReadiness((v) => !v)}
          >
            {showReadiness ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {readiness?.missing_files?.length
              ? `Missing: ${readiness.missing_files.join(', ')}`
              : !readiness?.has_pathogen
                ? 'Pathogen not set in scenario'
                : 'Missing files or configuration'}
          </button>
          {showReadiness && <ReadinessPanel readiness={readiness} pathogen={scenario.pathogen} />}
        </>
      )}

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          disabled={!canRun || runLoading || isAnyRunning}
          onClick={handleRunModel}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-wpBlue hover:bg-wpBlue-600 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={isAnyRunning && !runLoading ? 'Another scenario is already running' : undefined}
        >
          {runLoading ? (
            <><RefreshCw size={13} className="animate-spin" /> Running…</>
          ) : (
            <><Play size={13} /> Run Model</>
          )}
        </button>

        {hasResults && (
          <button
            onClick={() => onViewResults?.(scenario)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-wpBlue bg-wpGreen hover:bg-wpGreen-800 rounded transition-colors"
          >
            <BarChart2 size={13} /> View Results
          </button>
        )}

        {(runOutput.stdout || runOutput.stderr) && (
          <button
            onClick={() => setShowOutput((v) => !v)}
            className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            {showOutput ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Output
          </button>
        )}

        {/* glowpa.log */}
        <button
          disabled={logLoading}
          onClick={() => handleFetchLog()}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50 transition-colors"
          title="Read glowpa.log from filesystem"
        >
          {logLoading ? <Loader2 size={13} className="animate-spin" /> : <ScrollText size={13} />}
          {showLog ? 'Hide log' : 'Execution log'}
        </button>
      </div>

      {/* Run output */}
      {showOutput && (runOutput.stdout || runOutput.stderr) && (
        <div className="mt-3 space-y-1">
          {runMode && (
            <p className="text-xs text-gray-400">
              Ran via: <span className="font-mono">{runMode === 'exec' ? 'docker exec glowpa-container' : 'docker run (one-shot)'}</span>
            </p>
          )}
          {runOutput.stdout && (
            <pre className="p-3 bg-gray-900 text-gray-200 text-xs rounded overflow-auto max-h-48 whitespace-pre-wrap">
              {runOutput.stdout}
            </pre>
          )}
          {runOutput.stderr && (
            <pre className="p-3 bg-red-950 text-red-300 text-xs rounded overflow-auto max-h-48 whitespace-pre-wrap">
              {runOutput.stderr}
            </pre>
          )}
        </div>
      )}

      {/* glowpa.log */}
      {showLog && glowpaLog && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <ScrollText size={11} />
              <span className="font-mono">{glowpaLog.path}</span>
              {glowpaLog.lines > 0 && (
                <span className="text-gray-300">({glowpaLog.lines} lines total)</span>
              )}
            </p>
            <button
              onClick={() => handleFetchLog(true)}
              className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
              title="Refresh"
            >
              <RefreshCw size={11} /> Refresh
            </button>
          </div>
          {glowpaLog.exists ? (
            <pre className="p-3 bg-gray-900 text-emerald-300 text-xs rounded overflow-auto max-h-64 whitespace-pre-wrap">
              {glowpaLog.content || '(empty)'}
            </pre>
          ) : (
            <p className="text-xs text-gray-400 italic p-2 bg-gray-50 rounded">
              Log file not found — has the model run yet?
            </p>
          )}
        </div>
      )}
    </div>
  );
}
