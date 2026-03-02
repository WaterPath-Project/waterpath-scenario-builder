import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import axios from 'axios';

// ─── Field definitions ────────────────────────────────────────────────────────

export const SLIDER_FIELDS = [
  'flushSewer', 'flushSeptic', 'flushPit', 'flushOpen', 'flushUnknown',
  'pitSlab', 'pitNoSlab', 'compostingToilet', 'bucketLatrine', 'containerBased',
  'hangingToilet', 'openDefecation', 'other',
];

export const BOOLEAN_FIELDS = [
  'onsiteDumpedland', 'pitAdditive', 'urine', 'twinPits',
  'coverBury', 'isWatertight', 'hasLeach',
];

export const INTEGER_FIELDS = ['emptyFrequency'];

const FIELD_LABELS = {
  flushSewer:        'Flush to sewer',
  flushSeptic:       'Flush to septic',
  flushPit:          'Flush to pit',
  flushOpen:         'Flush to open',
  flushUnknown:      'Flush (unknown)',
  pitSlab:           'Pit with slab',
  pitNoSlab:         'Pit without slab',
  compostingToilet:  'Composting toilet',
  bucketLatrine:     'Bucket latrine',
  containerBased:    'Container-based',
  hangingToilet:     'Hanging toilet',
  openDefecation:    'Open defecation',
  other:             'Other',
  onsiteDumpedland:  'Dumped on land (onsite)',
  emptyFrequency:    'Empty frequency (×/yr)',
  pitAdditive:       'Pit additive',
  urine:             'Urine diversion',
  twinPits:          'Twin pits',
  coverBury:         'Cover / bury',
  isWatertight:      'Watertight container',
  hasLeach:          'Leach field',
};

const SUFFIXES = ['_urb', '_rur'];
const SUFFIX_LABELS = { _urb: 'Urban', _rur: 'Rural' };

// ─── Pure constraint helper ───────────────────────────────────────────────────

/**
 * Adjust one slider in a group that must always sum to 1.0.
 * The slider immediately following the changed one compensates for the delta.
 * Both sliders are clamped to [0, 1]; if the compensator hits its bound,
 * the changed slider is limited accordingly.
 *
 * @param {number[]} values   Current array of fractions (should sum to 1.0)
 * @param {number}   index    Index of the slider being changed
 * @param {number}   newVal   Desired value for that slider (unclamped)
 * @returns {number[]}        New array with sum == 1.0 (values rounded to 3 dp)
 */
export function adjustSlider(values, index, newVal) {
  const n = values.length;
  if (n < 2) return values;

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const clamp = (v) => Math.min(1, Math.max(0, v));

  const desired = r3(clamp(newVal));
  const delta = desired - values[index];
  if (Math.abs(delta) < 1e-9) return values;

  const compIdx = (index + 1) % n;
  const compRaw = values[compIdx] - delta;

  const next = [...values];

  if (compRaw < 0) {
    // Compensator would go negative — limit the change to what the compensator can give
    next[index] = r3(values[index] + values[compIdx]);
    next[compIdx] = 0;
  } else if (compRaw > 1) {
    // Compensator would exceed 1 — limit the change
    next[index] = r3(values[index] - (compRaw - 1));
    next[compIdx] = 1;
  } else {
    next[index] = desired;
    next[compIdx] = r3(compRaw);
  }

  return next;
}

// ─── SanitationSliderGroup ────────────────────────────────────────────────────
// Pure presentational component. Receives an array of { field, value, label }
// and calls onSliderChange(index, newValue) when a slider moves.

const SliderRow = ({ label, value, index, onChange }) => {
  const pct = (v) => `${(v * 100).toFixed(1)} %`;
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(index, Math.min(100, Math.max(0, n)) / 100);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-xs text-gray-600 w-32 flex-shrink-0 truncate" title={label}>{label}</span>
      <input
        type="range"
        min={0} max={1} step={0.001}
        value={value}
        onChange={(e) => onChange(index, parseFloat(e.target.value))}
        className="flex-1 h-1.5 accent-wpBlue cursor-pointer"
      />
      {editing ? (
        <input
          type="number"
          min={0} max={100} step={0.1}
          value={inputVal}
          autoFocus
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.target.value);
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-16 text-right text-xs border border-wpBlue-300 rounded px-1 py-0.5"
        />
      ) : (
        <span
          className="w-16 text-right text-xs tabular-nums text-wpBlue font-medium cursor-text hover:bg-gray-100 rounded px-1 py-0.5"
          title="Click to type"
          onClick={() => { setInputVal((value * 100).toFixed(1)); setEditing(true); }}
        >
          {pct(value)}
        </span>
      )}
    </div>
  );
};

export const SanitationSliderGroup = ({ title, fields, values, labels, onSliderChange }) => {
  const total = values.reduce((s, v) => s + v, 0);
  const totalOk = Math.abs(total - 1) < 0.005;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between mb-1">
        <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</h5>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${totalOk ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
          Σ = {(total * 100).toFixed(1)} %
        </span>
      </div>
      {fields.map((field, i) => (
        <SliderRow
          key={field}
          label={labels[field] ?? field}
          value={values[i]}
          index={i}
          onChange={onSliderChange}
        />
      ))}
    </div>
  );
};

// ─── BooleanField & IntegerField ──────────────────────────────────────────────

const BooleanField = ({ label, value, onChange }) => (
  <label className="flex items-center gap-2 cursor-pointer group">
    <input
      type="checkbox"
      checked={!!value}
      onChange={(e) => onChange(e.target.checked ? 1 : 0)}
      className="w-4 h-4 rounded border-gray-300 text-wpBlue accent-wpBlue cursor-pointer"
    />
    <span className="text-xs text-gray-700 group-hover:text-wpBlue">{label}</span>
  </label>
);

const IntegerField = ({ label, value, onChange }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs text-gray-700 flex-1">{label}</span>
    <input
      type="number"
      min={1} step={1}
      value={value ?? 1}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= 1) onChange(n);
      }}
      className="w-16 text-right text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-wpBlue-400"
    />
  </div>
);

// ─── Helper: parse a row into editing state ───────────────────────────────────

function parseRow(row) {
  const out = {};
  [...SLIDER_FIELDS, ...BOOLEAN_FIELDS, ...INTEGER_FIELDS].forEach((f) => {
    SUFFIXES.forEach((sfx) => {
      const key = `${f}${sfx}`;
      if (key in row) {
        const raw = row[key];
        if (INTEGER_FIELDS.includes(f)) {
          out[key] = parseInt(raw, 10) || 1;
        } else if (BOOLEAN_FIELDS.includes(f)) {
          out[key] = raw === '' || raw == null ? 0 : parseInt(raw, 10) || 0;
        } else {
          // slider fraction
          out[key] = parseFloat(raw) || 0;
        }
      }
    });
  });
  return out;
}

function serializeRow(base, editedValues) {
  return { ...base, ...editedValues };
}

// ─── SanitationPanelInner ─────────────────────────────────────────────────────

const SanitationPanelInner = ({ scenario, initialRows, onDirtyChange }) => {
  const [activeAreaIdx, setActiveAreaIdx] = useState(0);

  // localValues: array of parsed value objects, one per row
  const [localValues, setLocalValues] = useState(() => initialRows.map(parseRow));

  const savedRef = useRef(initialRows.map(parseRow));
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const markDirty = useCallback((nextValues) => {
    const dirty = nextValues.some((vals, i) => {
      const saved = savedRef.current[i];
      return Object.keys(vals).some((k) => vals[k] !== saved[k]);
    });
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  const updateField = useCallback((rowIdx, field, value) => {
    setLocalValues((prev) => {
      const next = prev.map((v, i) => i === rowIdx ? { ...v, [field]: value } : v);
      markDirty(next);
      return next;
    });
  }, [markDirty]);

  const updateSliders = useCallback((rowIdx, suffix, sliderIdx, newVal) => {
    setLocalValues((prev) => {
      const current = prev[rowIdx];
      const currentArr = SLIDER_FIELDS.map((f) => current[`${f}${suffix}`] ?? 0);
      const nextArr = adjustSlider(currentArr, sliderIdx, newVal);
      const patch = {};
      SLIDER_FIELDS.forEach((f, i) => { patch[`${f}${suffix}`] = nextArr[i]; });
      const next = prev.map((v, i) => i === rowIdx ? { ...v, ...patch } : v);
      markDirty(next);
      return next;
    });
  }, [markDirty]);

  const handleReset = useCallback(() => {
    setLocalValues(savedRef.current.map((v) => ({ ...v })));
    setIsDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      // Merge edited sanitation values back into the full row objects
      const rows = initialRows.map((row, i) => serializeRow(row, localValues[i]));
      await axios.put(`/api/scenarios/${scenario.id}/isodata`, { rows });
      savedRef.current = localValues.map((v) => ({ ...v }));
      setIsDirty(false);
      onDirtyChange?.(false);
    } catch (e) {
      alert('Failed to save: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  }, [localValues, initialRows, scenario.id, onDirtyChange]);

  const row = initialRows[activeAreaIdx];
  const vals = localValues[activeAreaIdx];
  if (!row || !vals) return null;

  const areaLabel = row.subarea || row.iso || `Area ${activeAreaIdx + 1}`;
  const urbanFrac = parseFloat(row.fraction_urban_pop) || 0;
  const activeSuffixes = SUFFIXES.filter((sfx) =>
    sfx === '_urb' ? urbanFrac > 0 : urbanFrac < 1
  );

  return (
    <div className="space-y-4">
      {/* Toolbar: subarea selector + save/reset */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Subarea pills */}
        <div className="flex flex-wrap gap-1 flex-1">
          {initialRows.map((r, i) => (
            <button
              key={i}
              onClick={() => setActiveAreaIdx(i)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                i === activeAreaIdx
                  ? 'bg-wpBlue text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {r.subarea || r.iso || `Area ${i + 1}`}
            </button>
          ))}
        </div>

        {/* Dirty indicator + actions */}
        {isDirty && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-orange-400" title="Unsaved changes" />
            <button
              onClick={handleReset}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            >
              <RotateCcw size={12} /> Reset
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-wpGreen hover:bg-wpGreen-600 rounded transition-colors disabled:opacity-50"
            >
              <Save size={12} /> {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* Main content: Urban | Rural columns */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {activeSuffixes.map((sfx) => {
          const sliderValues = SLIDER_FIELDS.map((f) => vals[`${f}${sfx}`] ?? 0);
          const boolValues   = BOOLEAN_FIELDS.map((f) => vals[`${f}${sfx}`]);
          const freqValue    = vals[`emptyFrequency${sfx}`];
          const hasFreq      = `emptyFrequency${sfx}` in vals;

          return (
            <div key={sfx} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                <h4 className="text-sm font-semibold text-wpBlue">
                  {areaLabel} — {SUFFIX_LABELS[sfx]}
                </h4>
              </div>

              <div className="px-4 py-4 space-y-5">
                {/* Slider group */}
                <SanitationSliderGroup
                  title="Sanitation technology mix"
                  fields={SLIDER_FIELDS}
                  values={sliderValues}
                  labels={FIELD_LABELS}
                  onSliderChange={(idx, val) => updateSliders(activeAreaIdx, sfx, idx, val)}
                />

                {/* Additional options */}
                <div>
                  <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Additional options
                  </h5>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {BOOLEAN_FIELDS.map((f, i) => {
                      const key = `${f}${sfx}`;
                      if (!(key in vals)) return null;
                      return (
                        <BooleanField
                          key={key}
                          label={FIELD_LABELS[f]}
                          value={boolValues[i]}
                          onChange={(v) => updateField(activeAreaIdx, key, v)}
                        />
                      );
                    })}
                    {hasFreq && (
                      <div className="col-span-2 pt-1 border-t border-gray-100 mt-1">
                        <IntegerField
                          label={FIELD_LABELS.emptyFrequency}
                          value={freqValue}
                          onChange={(v) => updateField(activeAreaIdx, `emptyFrequency${sfx}`, v)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Outer wrapper: fetches isodata, then renders inner ──────────────────────

const SanitationPanel = ({ scenario, onDirtyChange }) => {
  const [fetchState, setFetchState] = useState({ status: 'loading', rows: [] });

  useEffect(() => {
    let cancelled = false;
    setFetchState({ status: 'loading', rows: [] });

    if (scenario?.isTemp) {
      const rows = scenario?.data?.data ?? [];
      setFetchState({ status: 'done', rows });
      return;
    }

    axios
      .get(`/api/scenarios/${scenario.id}/isodata`)
      .then((r) => {
        if (!cancelled) setFetchState({ status: 'done', rows: r.data.data ?? [] });
      })
      .catch((e) => {
        if (!cancelled)
          setFetchState({ status: 'error', rows: [], error: e.response?.data?.error || e.message });
      });

    return () => { cancelled = true; };
  }, [scenario?.id]);

  if (fetchState.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-wpBlue" />
        <span className="text-sm">Loading sanitation data…</span>
      </div>
    );
  }

  if (fetchState.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-red-400 gap-2">
        <p className="text-sm">Failed to load sanitation data: {fetchState.error}</p>
      </div>
    );
  }

  if (!fetchState.rows.length) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <p className="text-sm">No sanitation data available for this scenario.</p>
      </div>
    );
  }

  return (
    <SanitationPanelInner
      key={scenario.id}
      scenario={scenario}
      initialRows={fetchState.rows}
      onDirtyChange={onDirtyChange}
    />
  );
};

export default SanitationPanel;
