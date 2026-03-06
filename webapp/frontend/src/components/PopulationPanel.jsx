import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Users, ChevronDown, ChevronUp, TableProperties, Info, Plus, Minus, RotateCcw, Save } from 'lucide-react';
import axios from 'axios';
import DataGridView from './DataGridView';

// helpers
const fmt = (n, decimals = 0) =>
  n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: decimals });

const pct = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : `${(n * 100).toFixed(1)} %`;
};

const FRACTION_STEP = 0.001;
const fmt3 = (v) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(3));

// StatCard — optionally shows −/+ buttons flanking the value
const StatCard = ({ label, value, sub, onDecrement, onIncrement }) => (
  <div className="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-col gap-1 shadow-sm">
    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
    <div className="flex items-center gap-2">
      {onDecrement && (
        <button onClick={onDecrement} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-wpBlue transition-colors" title="Decrease">
          <Minus size={14} />
        </button>
      )}
      <span className="text-2xl font-bold text-wpBlue">{value}</span>
      {onIncrement && (
        <button onClick={onIncrement} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-wpBlue transition-colors" title="Increase">
          <Plus size={14} />
        </button>
      )}
    </div>
    {sub && <span className="text-xs text-gray-400">{sub}</span>}
  </div>
);

// Stepper
const Stepper = ({ value, onChange, step, min, max, format }) => {
  const [inputVal, setInputVal] = useState(null);

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(Math.min(Math.max(n, min ?? -Infinity), max ?? Infinity));
    setInputVal(null);
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onChange(Math.max((parseFloat(value) || 0) - step, min ?? -Infinity))}
        className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-wpBlue transition-colors"
      >
        <Minus size={12} />
      </button>
      {inputVal !== null ? (
        <input
          className="w-24 text-center text-sm border border-wpBlue-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-wpBlue-400"
          value={inputVal}
          autoFocus
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.target.value);
            if (e.key === 'Escape') setInputVal(null);
          }}
        />
      ) : (
        <span
          className="w-24 text-center text-sm tabular-nums cursor-text select-none hover:bg-gray-100 rounded px-1 py-0.5"
          title="Click to type a value"
          onClick={() => setInputVal(String(value))}
        >
          {format(value)}
        </span>
      )}
      <button
        onClick={() => onChange(Math.min((parseFloat(value) || 0) + step, max ?? Infinity))}
        className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-wpBlue transition-colors"
      >
        <Plus size={12} />
      </button>
    </div>
  );
};

const RAW_COLS = ['subarea', 'population', 'fraction_urban_pop', 'fraction_pop_under5', 'hdi'];

// ─── Inner panel: receives already-parsed rows, manages editing state ────────
const PopulationPanelInner = ({ scenario, initialRows, fieldnames, onDirtyChange, onSaved, assumptions }) => {
  const [showFullData, setShowFullData] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(true);

  const parseRows = (rows) =>
    rows.map((r) => ({
      ...r,
      population: parseFloat(r.population) || 0,
      fraction_urban_pop: parseFloat(r.fraction_urban_pop) || 0,
      fraction_pop_under5: parseFloat(r.fraction_pop_under5) || 0,
      hdi: parseFloat(r.hdi) || 0,
    }));

  const [localRows, setLocalRows] = useState(() => parseRows(initialRows));

  // Tracks the last-saved state so Reset restores to it
  const savedRowsRef = useRef(
    initialRows.map((r) => ({
      population: parseFloat(r.population) || 0,
      fraction_urban_pop: parseFloat(r.fraction_urban_pop) || 0,
      fraction_pop_under5: parseFloat(r.fraction_pop_under5) || 0,
      hdi: parseFloat(r.hdi) || 0,
    }))
  );

  // True when all initial HDI values are the same (enables the shared HDI StatCard)
  const hdiUniform = useMemo(() => {
    if (!initialRows.length) return false;
    const first = parseFloat(initialRows[0].hdi) || 0;
    return initialRows.every((r) => Math.abs((parseFloat(r.hdi) || 0) - first) < 0.0001);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [changedRows, setChangedRows] = useState(() => new Set());

  // 1% of each row's initial population, floored to at least 1
  const initialSteps = useMemo(
    () => initialRows.map((r) => Math.max(1, Math.round((parseFloat(r.population) || 0) * 0.01))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // computed once on mount — component is re-keyed per scenario
  );

  const updateField = useCallback((rowIdx, field, value) => {
    setLocalRows((prev) => {
      const next = prev.map((r, i) => (i === rowIdx ? { ...r, [field]: value } : r));
      const newChanged = new Set();
      next.forEach((r, i) => {
        const s = savedRowsRef.current[i];
        if (
          r.population !== s?.population ||
          r.fraction_urban_pop !== s?.fraction_urban_pop ||
          r.fraction_pop_under5 !== s?.fraction_pop_under5 ||
          r.hdi !== s?.hdi
        ) newChanged.add(i);
      });
      setChangedRows(newChanged);
      const dirty = newChanged.size > 0;
      setIsDirty(dirty);
      onDirtyChange?.(dirty);
      return next;
    });
  }, [onDirtyChange]);

  const handleReset = useCallback(() => {
    setLocalRows((prev) =>
      prev.map((r, i) => ({ ...r, ...savedRowsRef.current[i] }))
    );
    setChangedRows(new Set());
    setIsDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await axios.put(`/api/scenarios/${scenario.id}/isodata`, { rows: localRows });
      savedRowsRef.current = localRows.map((r) => ({
        population: r.population,
        fraction_urban_pop: r.fraction_urban_pop,
        fraction_pop_under5: r.fraction_pop_under5,
        hdi: r.hdi,
      }));
      setChangedRows(new Set());
      setIsDirty(false);
      onDirtyChange?.(false);
      onSaved?.();
    } catch (e) {
      alert('Failed to save: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  }, [localRows, scenario.id, onDirtyChange, onSaved]);

  const markDirty = useCallback((next) => {
    const newChanged = new Set();
    next.forEach((r, i) => {
      const s = savedRowsRef.current[i];
      if (
        r.population !== s?.population ||
        r.fraction_urban_pop !== s?.fraction_urban_pop ||
        r.fraction_pop_under5 !== s?.fraction_pop_under5 ||
        r.hdi !== s?.hdi
      ) newChanged.add(i);
    });
    setChangedRows(newChanged);
    const dirty = newChanged.size > 0;
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  // Adjust all populations by a percentage delta
  const adjustAll = useCallback((pctDelta) => {
    const next = localRows.map((r) => ({ ...r, population: Math.max(0, Math.round(r.population * (1 + pctDelta))) }));
    setLocalRows(next);
    markDirty(next);
  }, [localRows, markDirty]);

  // Adjust a fraction/HDI field across all rows by a fixed delta
  const adjustAllField = useCallback((field, delta, min = 0, max = 1) => {
    const next = localRows.map((r) => ({
      ...r,
      [field]: Math.round(Math.min(max, Math.max(min, (r[field] || 0) + delta)) * 1000) / 1000,
    }));
    setLocalRows(next);
    markDirty(next);
  }, [localRows, markDirty]);

  const stats = useMemo(() => {
    if (!localRows.length) return null;
    const totalPop  = localRows.reduce((s, r) => s + r.population, 0);
    const avgUrban  = localRows.reduce((s, r) => s + r.fraction_urban_pop, 0) / localRows.length;
    const avgUnder5 = localRows.reduce((s, r) => s + r.fraction_pop_under5, 0) / localRows.length;
    const avgHdi    = localRows.reduce((s, r) => s + (r.hdi || 0), 0) / localRows.length;
    return { totalPop, avgUrban, avgUnder5, avgHdi };
  }, [localRows]);

  const rawFieldnames = useMemo(
    () => RAW_COLS.filter((c) => fieldnames.includes(c)),
    [fieldnames]
  );
  const rawData = useMemo(
    () => localRows.map((r) => Object.fromEntries(rawFieldnames.map((c) => [c, r[c]]))),
    [localRows, rawFieldnames]
  );

  if (!localRows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
        <Users size={40} className="text-gray-300" />
        <p className="text-sm">No population data available for this scenario.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {stats && (
        <div className="flex gap-4">
          <StatCard
            label="Total population"
            value={fmt(stats.totalPop)}
            sub={`across ${localRows.length} area${localRows.length !== 1 ? 's' : ''} · ±1% per click`}
            onDecrement={() => adjustAll(-0.01)}
            onIncrement={() => adjustAll(+0.01)}
          />
          <StatCard
            label="Avg. urban population"
            value={pct(stats.avgUrban)}
            sub={`across ${localRows.length} area${localRows.length !== 1 ? 's' : ''} · ±0.1 pp per click`}
            onDecrement={() => adjustAllField('fraction_urban_pop', -0.001)}
            onIncrement={() => adjustAllField('fraction_urban_pop', +0.001)}
          />
          <StatCard
            label="Avg. population under 5"
            value={pct(stats.avgUnder5)}
            sub={`across ${localRows.length} area${localRows.length !== 1 ? 's' : ''} · ±0.1 pp per click`}
            onDecrement={() => adjustAllField('fraction_pop_under5', -0.001)}
            onIncrement={() => adjustAllField('fraction_pop_under5', +0.001)}
          />
          {hdiUniform && (
            <StatCard
              label="HDI (all areas)"
              value={fmt3(stats.avgHdi)}
              sub="Human Development Index · ±0.01 per click"
              onDecrement={() => adjustAllField('hdi', -0.01, 0.001, 0.999)}
              onIncrement={() => adjustAllField('hdi', +0.01, 0.001, 0.999)}
            />
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <h4 className="text-sm font-semibold text-wpBlue">Summary by area</h4>
          <span className="ml-2 text-xs text-gray-400">Click a value or use +/− to edit</span>
          <div className="ml-auto" />
          {isDirty && (
            <>
              <button
                onClick={handleReset}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                title="Reset to last saved values"
              >
                <RotateCcw size={12} />
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-wpGreen hover:bg-wpGreen-600 rounded transition-colors disabled:opacity-50"
                title="Save to isodata.csv"
              >
                <Save size={12} />
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-5 py-3 text-left font-medium">Area</th>
                <th className="px-5 py-3 text-center font-medium">Population</th>
                <th className="px-5 py-3 text-left font-medium w-56">Urban pop.</th>
                <th className="px-5 py-3 text-left font-medium w-56">Under 5</th>
                <th className="px-5 py-3 text-left font-medium w-40">HDI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {localRows.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-800">
                    <div className="flex items-center gap-2">
                      {changedRows.has(i) && (
                        <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" title="Unsaved changes" />
                      )}
                      {row.subarea || row.iso || '—'}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-center">
                      <Stepper value={row.population} step={initialSteps[i]} min={0} format={(v) => fmt(v)} onChange={(v) => updateField(i, 'population', v)} />
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-center">
                      <Stepper value={row.fraction_urban_pop} step={FRACTION_STEP} min={0} max={1} format={pct} onChange={(v) => updateField(i, 'fraction_urban_pop', Math.round(v * 1000) / 1000)} />
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-center">
                      <Stepper value={row.fraction_pop_under5} step={FRACTION_STEP} min={0} max={1} format={pct} onChange={(v) => updateField(i, 'fraction_pop_under5', Math.round(v * 1000) / 1000)} />
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-center">
                      <Stepper value={row.hdi} step={0.001} min={0.001} max={0.999} format={fmt3} onChange={(v) => updateField(i, 'hdi', Math.round(v * 1000) / 1000)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {assumptions && assumptions.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowAssumptions((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Info size={16} className="text-gray-400" />
              <span>Assumptions ({assumptions.length})</span>
            </div>
            {showAssumptions ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showAssumptions && (
            <div className="border-t border-gray-100 px-5 py-3">
              <ul className="space-y-2">
                {assumptions.map(({ key, value }) => (
                  <li key={key} className="text-sm text-gray-600 flex items-start gap-2">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-wpBlue/40 flex-shrink-0" />
                    <span>{value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowFullData((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <TableProperties size={16} className="text-gray-400" />
            <span>Raw data ({rawFieldnames.length} columns, {localRows.length} rows)</span>
          </div>
          {showFullData ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showFullData && (
          <div className="border-t border-gray-100 p-2 overflow-auto max-h-96">
            <DataGridView data={rawData} fieldnames={rawFieldnames} readOnly />
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Outer wrapper: fetches isodata from backend, then renders inner panel ───
// Note: this component is always mounted with key={scenario.id} by its parent,
// so it reliably remounts (and re-fetches) when the selected scenario changes.
const PopulationPanel = ({ scenario, onDirtyChange, onSaved, assumptions }) => {
  const [fetchState, setFetchState] = useState({ status: 'loading', rows: [], fieldnames: [] });

  useEffect(() => {
    let cancelled = false;
    setFetchState({ status: 'loading', rows: [], fieldnames: [] });

    if (scenario?.isTemp) {
      // Temp scenarios carry their data in-memory; no backend call needed
      const rows = scenario?.data?.data ?? [];
      const fieldnames = scenario?.data?.fieldnames ?? [];
      setFetchState({ status: 'done', rows, fieldnames });
      return;
    }

    axios
      .get(`/api/scenarios/${scenario.id}/isodata`)
      .then((r) => {
        if (!cancelled) {
          setFetchState({
            status: 'done',
            rows: r.data.data ?? [],
            fieldnames: r.data.fieldnames ?? [],
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setFetchState({
            status: 'error',
            rows: [],
            fieldnames: [],
            error: e.response?.data?.error || e.message,
          });
        }
      });

    return () => { cancelled = true; };
  }, [scenario?.id]); // re-fetch whenever scenario changes

  if (fetchState.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-wpBlue" />
        <span className="text-sm">Loading population data…</span>
      </div>
    );
  }

  if (fetchState.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-red-400 gap-3">
        <Users size={40} className="text-red-200" />
        <p className="text-sm">Failed to load population data: {fetchState.error}</p>
      </div>
    );
  }

  return (
    <PopulationPanelInner
      key={scenario.id}
      scenario={scenario}
      initialRows={fetchState.rows}
      fieldnames={fetchState.fieldnames}
      onDirtyChange={onDirtyChange}
      onSaved={onSaved}
      assumptions={assumptions}
    />
  );
};

export default PopulationPanel;
