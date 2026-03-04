import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { RotateCcw, Save, ChevronDown, ChevronRight, ChevronUp, AlertTriangle, TableProperties } from 'lucide-react';
import axios from 'axios';
import DataGridView from './DataGridView';

// ─── Color palette ────────────────────────────────────────────────────────────

const COLORS = {
  safelyManaged:  '#2E7D32',   // dark green
  basic:          '#51B453',   // medium green
  improved:       '#3F9842',   // midpoint of safelyManaged & basic (combined header)
  unimproved:     '#FFDA46',   // yellow  — needs dark text
  openDefecation: '#FFC000',   // amber   — needs dark text   // yellow  — needs dark text
  notContributing:'rgb(107 114 128)',   // gray    — for tech mix fields that don't contribute to the ladder (e.g. flushOpen)
};

const BG = {
  improved:       '#f1f8f1',
  unimproved:     '#fffef0',
  openDefecation: '#fff9e6',
};

// Tolerance for "sums to 1"
const SUM_TOL = 0.005;

// ─── Field groupings ──────────────────────────────────────────────────────────

// Improved technology mix (contributes to Basic + portion to Safely Managed)
const IMPROVED_FIELDS = [
  'flushSewer', 'flushSeptic', 'flushPit', 'pitSlab', 'compostingToilet', 'containerBased',
];

// Treatment fractions (determine what share of improved is Safely Managed)
const TREATMENT_FIELDS = ['sewageTreated', 'fecalSludgeTreated'];

// Unimproved facility technologies
const UNIMPROVED_FIELDS = [
  'pitNoSlab', 'bucketLatrine', 'hangingToilet', 'flushOpen', 'flushUnknown', 'other',
];

// Open defecation
const OD_FIELDS = ['openDefecation'];

// All technology mix fields (should sum to 1)
const TECH_FIELDS = [...IMPROVED_FIELDS, ...UNIMPROVED_FIELDS, ...OD_FIELDS];

// Additional boolean / integer fields (shown below ladder)
const BOOLEAN_FIELDS = [
  'onsiteDumpedland', 'pitAdditive', 'urine', 'twinPits', 'coverBury', 'isWatertight', 'hasLeach',
];
const INTEGER_FIELDS = ['emptyFrequency'];

const ALL_FIELDS = [...TECH_FIELDS, ...TREATMENT_FIELDS, ...BOOLEAN_FIELDS, ...INTEGER_FIELDS];

const FIELD_LABELS = {
  flushSewer:           'Flush to sewer',
  flushSeptic:          'Flush to septic',
  flushPit:             'Flush to pit',
  flushOpen:            'Flush to open',
  flushUnknown:         'Flush (unknown)',
  pitSlab:              'Pit with slab',
  pitNoSlab:            'Pit without slab',
  compostingToilet:     'Composting toilet',
  bucketLatrine:        'Bucket latrine',
  containerBased:       'Container-based',
  hangingToilet:        'Hanging toilet',
  openDefecation:       'Open defecation',
  other:                'Other',
  sewageTreated:        'Sewage treated (fraction)',
  fecalSludgeTreated:   'Fecal sludge treated (fraction)',
  onsiteDumpedland:     'Dumped on land (onsite)',
  emptyFrequency:       'Empty frequency (×/yr)',
  pitAdditive:          'Pit additive',
  urine:                'Urine diversion',
  twinPits:             'Twin pits',
  coverBury:            'Cover / bury',
  isWatertight:         'Watertight container',
  hasLeach:             'Leach field',
};

const SUFFIXES = ['_urb', '_rur'];
const SUFFIX_LABELS = { _urb: 'Urban', _rur: 'Rural' };

// Columns shown in the raw data view
const RAW_ID_COLS = ['subarea', 'fraction_urban_pop'];
const RAW_SANITATION_COLS = [
  ...RAW_ID_COLS,
  ...ALL_FIELDS.flatMap((f) => SUFFIXES.map((s) => `${f}${s}`)),
];

// ─── Ladder computation (mirrors ladder.py) ───────────────────────────────────

function computeLadder(vals, sfx) {
  const v = (name) => parseFloat(vals[`${name}${sfx}`] || 0) || 0;

  const flushSewer        = v('flushSewer');
  const flushSeptic       = v('flushSeptic');
  const flushPit          = v('flushPit');
  const pitSlab           = v('pitSlab');
  const compostingToilet  = v('compostingToilet');
  const containerBased    = v('containerBased');

  const improvedTotal = flushSewer + flushSeptic + flushPit + pitSlab + compostingToilet + containerBased;

  const sewageTreated       = v('sewageTreated');
  const fecalSludgeTreated  = v('fecalSludgeTreated');

  const safelyManagedSewer  = flushSewer * sewageTreated;
  const onsiteImproved      = flushSeptic + flushPit + pitSlab + compostingToilet + containerBased;
  const safelyManagedOnsite = onsiteImproved * fecalSludgeTreated;
  const safelyManaged       = safelyManagedSewer + safelyManagedOnsite;

  const basic = improvedTotal - safelyManaged;

  const unimproved = (
    v('pitNoSlab') + v('bucketLatrine') + v('hangingToilet') +
    v('flushOpen') + v('flushUnknown') + v('other')
  );

  const openDefecation = v('openDefecation');

  const techTotal = improvedTotal + unimproved + openDefecation;

  return { safelyManaged, basic, unimproved, openDefecation, improvedTotal, techTotal };
}

// ─── Parse / Serialize helpers ────────────────────────────────────────────────

function parseRow(row) {
  const out = {};
  ALL_FIELDS.forEach((f) => {
    SUFFIXES.forEach((sfx) => {
      const key = `${f}${sfx}`;
      if (!(key in row)) return;
      const raw = row[key];
      if (INTEGER_FIELDS.includes(f)) {
        out[key] = parseInt(raw, 10) || 1;
      } else if (BOOLEAN_FIELDS.includes(f)) {
        out[key] = raw === '' || raw == null ? 0 : parseFloat(raw) || 0;
      } else {
        out[key] = parseFloat(raw) || 0;
      }
    });
  });
  return out;
}

function serializeRow(base, editedValues) {
  return { ...base, ...editedValues };
}

// ─── LadderBar ────────────────────────────────────────────────────────────────

const LadderBar = ({ ladder }) => {
  const total = ladder.techTotal > 0 ? ladder.techTotal : 1;

  const segments = [
    { key: 'openDefecation', label: 'Open Defecation', value: ladder.openDefecation, color: COLORS.openDefecation, darkText: true  },
    { key: 'unimproved',     label: 'Unimproved',      value: ladder.unimproved,     color: COLORS.unimproved,     darkText: true  },
    { key: 'basic',          label: 'Basic',           value: ladder.basic,          color: COLORS.basic,          darkText: false },
    { key: 'safelyManaged',  label: 'Safely Managed',  value: ladder.safelyManaged,  color: COLORS.safelyManaged,  darkText: false },
  ];

  return (
    <div className="mb-4 py-12">
      <div className="flex h-14 rounded-xl overflow-hidden shadow-sm">
        {segments.map(({ key, label, value, color, darkText }) => {
          const pct = Math.max(0, (value / total) * 100);
          if (pct < 0.05) return null;
          return (
            <div
              key={key}
              style={{ width: `${pct.toFixed(2)}%`, backgroundColor: color }}
              className="transition-all duration-300 flex font-lg items-center justify-center overflow-hidden"
              title={`${label}: ${pct.toFixed(1)}%`}
            >
              {pct > 7 && (
                <span className={`text-lg font-semibold px-1 truncate select-none ${darkText ? 'text-gray-900' : 'text-white'}`}>
                  {pct.toFixed(0)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {[...segments].reverse().map(({ key, label, value, color }) => {
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm flex-shrink-0 border border-black/10" style={{ backgroundColor: color }} />
              <span className="text-xs text-gray-600">
                {label}:&nbsp;<strong>{pct.toFixed(1)}%</strong>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── IndependentSliderRow ─────────────────────────────────────────────────────

const IndependentSliderRow = ({ label, value, fieldKey, onChange, accentColor, darkAccent = false }) => {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(fieldKey, Math.min(1, Math.max(0, n / 100)));
    setEditing(false);
  };

  // For dark-background sections (unimproved/OD) keep the percentage text gray
  // so it doesn't clash with the yellow/amber background colors.
  const displayColor = darkAccent ? '#6b7280' : accentColor;

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-xs text-gray-700 w-44 flex-shrink-0 truncate" title={label}>
        {label}
      </span>
      <input
        type="range"
        min={0} max={1} step={0.001}
        value={value}
        onChange={(e) => onChange(fieldKey, parseFloat(e.target.value))}
        style={{ '--thumb-color': accentColor, '--fill-pct': `${(value * 100).toFixed(2)}%` }}
        className={`flex-1 cursor-pointer accent-thumb border border-[${accentColor}] rounded-xl`}
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
          className="w-16 text-right text-xs border rounded px-1 py-0.5 focus:outline-none"
          style={{ borderColor: accentColor }}
        />
      ) : (
        <span
          className="w-16 text-right text-xs tabular-nums font-medium cursor-text hover:bg-black/5 rounded px-1 py-0.5"
          style={{ color: displayColor }}
          title="Click to type a value"
          onClick={() => { setInputVal((value * 100).toFixed(1)); setEditing(true); }}
        >
          {(value * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
};

// ─── VerticalSliderColumn ────────────────────────────────────────────────────

// ─── SyncedTwoColumns ────────────────────────────────────────────────────────
// Measures the left column height with ResizeObserver and applies the same
// explicit pixel height to the right column so vertical sliders can fill it.

const SyncedTwoColumns = ({ leftContent, rightContent, borderColor }) => {
  const leftRef = useRef(null);
  const [leftH, setLeftH] = useState(null);

  useEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el) setLeftH(el.offsetHeight);
    });
    ro.observe(el);
    setLeftH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex gap-4 mt-3">
      <div className="w-3/4 min-w-0" ref={leftRef}>{leftContent}</div>
      <div
        className="w-1/4 flex flex-col border-l pl-4 items-center py-10"
        style={{ borderColor, maxHeight: '440px', overflow: 'hidden' }}
      >{rightContent}</div>
    </div>
  );
};

// ─── VerticalSliderColumn ────────────────────────────────────────────────────

const VerticalSliderColumn = ({ label, value, fieldKey, onChange, accentColor }) => {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(fieldKey, Math.min(1, Math.max(0, n / 100)));
    setEditing(false);
  };

  return (
    <div className="flex flex-col items-center gap-1 flex-1">
      <span className="text-[12px] pt-4 font-semibold text-gray-600 text-center leading-tight w-full break-words px-1">{label}</span>
      <div className="flex-1 flex items-stretch justify-center min-h-0">
        <input
          type="range"
          min={0} max={1} step={0.001}
          value={value}
          onChange={(e) => onChange(fieldKey, parseFloat(e.target.value))}
          style={{
            writingMode: 'vertical-lr',
            direction: 'rtl',
            width: 28,
            height: '100%',
            cursor: 'pointer',
            accentColor,
          }}
        />
      </div>
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
          className="w-14 text-center text-xs border rounded px-1 py-0.5 focus:outline-none"
          style={{ borderColor: accentColor }}
        />
      ) : (
        <span
          className="text-xs tabular-nums font-medium cursor-text hover:bg-black/5 rounded px-1 py-0.5"
          style={{ color: accentColor }}
          title="Click to type a value"
          onClick={() => { setInputVal((value * 100).toFixed(1)); setEditing(true); }}
        >
          {(value * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
};

// ─── CollapsibleSection ───────────────────────────────────────────────────────

const CollapsibleSection = ({ headerColor, darkHeaderText, label, badgeContent, children, initialOpen, hasError }) => {
  const [open, setOpen] = useState(initialOpen);
  const textClass    = darkHeaderText ? 'text-gray-900' : 'text-white';
  const chevronClass = darkHeaderText ? 'text-gray-700' : 'text-white/80';

  return (
    <div className="rounded-xl overflow-hidden" style={hasError ? { outline: '2px solid #ef4444' } : {}} >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left"
        style={{ backgroundColor: headerColor }}
      >
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown size={14} className={`${chevronClass} flex-shrink-0`} />
            : <ChevronRight size={14} className={`${chevronClass} flex-shrink-0`} />
          }
          <span className={`text-sm font-bold ${textClass}`}>{label}</span>
        </div>
        <div className="flex items-center gap-2">{badgeContent}</div>
      </button>
      {open && <div>{children}</div>}
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
      className="w-4 h-4 rounded border-gray-300 cursor-pointer"
      style={{ accentColor: COLORS.safelyManaged }}
    />
    <span className="text-xs text-gray-700 group-hover:text-gray-900">{label}</span>
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
      className="w-16 text-right text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none"
    />
  </div>
);

// ─── Persisted selection state (module-level) ─────────────────────────────────
// Keeps the last-used area selection so switching between scenarios restores it.
let _persistedIndices = null;     // Set<number> | null
let _persistedMulti   = false;

// ─── SanitationLadderInner ────────────────────────────────────────────────────

const SanitationLadderInner = ({ scenario, initialRows, fieldnames, onDirtyChange }) => {
  // Default to all areas selected; restore persisted selection if available (clamped to row count).
  const [selectedIndices, setSelectedIndices] = useState(() => {
    if (_persistedIndices && _persistedIndices.size > 0) {
      const valid = new Set([..._persistedIndices].filter(i => i < initialRows.length));
      if (valid.size > 0) return valid;
    }
    return new Set(initialRows.map((_, i) => i));
  });
  const [multiSelectMode, setMultiSelectMode] = useState(
    () => _persistedMulti || initialRows.length > 1
  );

  // Persist whenever selection changes so it survives scenario switches.
  useEffect(() => { _persistedIndices = selectedIndices; }, [selectedIndices]);
  useEffect(() => { _persistedMulti   = multiSelectMode; }, [multiSelectMode]);

  const [localValues, setLocalValues] = useState(() => initialRows.map(parseRow));

  const savedRef  = useRef(initialRows.map(parseRow));
  const [isDirty,  setIsDirty]  = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeSfxTab, setActiveSfxTab] = useState('_urb');
  const [showFullData, setShowFullData] = useState(false);

  // Which suffixes have unsaved changes (for orange dot on tab)
  const dirtySuffixes = useMemo(() => {
    const dirty = new Set();
    SUFFIXES.forEach((sfx) => {
      const hasDirty = localValues.some((vals, i) => {
        const saved = savedRef.current[i];
        return Object.keys(vals).some((k) => k.endsWith(sfx) && vals[k] !== saved[k]);
      });
      if (hasDirty) dirty.add(sfx);
    });
    return dirty;
  }, [localValues]);

  const markDirty = useCallback((nextValues) => {
    const dirty = nextValues.some((vals, i) => {
      const saved = savedRef.current[i];
      return Object.keys(vals).some((k) => vals[k] !== saved[k]);
    });
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  // Per-area dirty flags
  const areaIsDirty = useMemo(() =>
    localValues.map((vals, i) => {
      const saved = savedRef.current[i];
      return Object.keys(vals).some((k) => vals[k] !== saved[k]);
    })
  , [localValues]);

  // updateField: applies the same value to all indices in the provided array
  const updateField = useCallback((indices, key, value) => {
    setLocalValues((prev) => {
      const idxSet = new Set(indices);
      const next = prev.map((v, i) => idxSet.has(i) ? { ...v, [key]: value } : v);
      markDirty(next);
      return next;
    });
  }, [markDirty]);

  // updateFieldProportional: scales each area proportionally so that the new average equals
  // newAvg, while preserving relative differences among areas.
  // oldAvg is computed fresh from `prev` inside the updater to avoid stale-closure bugs.
  const updateFieldProportional = useCallback((indices, key, newAvg) => {
    setLocalValues((prev) => {
      // Compute current average from the latest state
      const oldAvg = indices.length > 0
        ? indices.reduce((s, i) => s + (parseFloat(prev[i]?.[key]) || 0), 0) / indices.length
        : 0;
      const next = prev.map((v, i) => {
        if (!indices.includes(i)) return v;
        const oldVal = parseFloat(v[key]) || 0;
        const scaled = oldAvg > 0.001
          ? Math.min(1, Math.max(0, oldVal * (newAvg / oldAvg)))
          : newAvg;
        return { ...v, [key]: scaled };
      });
      markDirty(next);
      return next;
    });
  }, [markDirty]);

  const handleReset = useCallback(() => {
    setLocalValues(savedRef.current.map((v) => ({ ...v })));
    setIsDirty(false);
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  // Selection helpers
  const selectAll = useCallback(() => {
    setMultiSelectMode(true); // All always enables multi-select mode
    setSelectedIndices((prev) => {
      // If already all selected, collapse back to first area
      if (prev.size === initialRows.length) return new Set([0]);
      return new Set(initialRows.map((_, i) => i));
    });
  }, [initialRows]);

  const handleAreaClick = useCallback((i) => {
    if (!multiSelectMode) {
      // Single-select mode: clicking any pill selects only that area
      setSelectedIndices(new Set([i]));
      return;
    }
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i) && next.size > 1) next.delete(i);
      else next.add(i);
      return next;
    });
  }, [multiSelectMode]);

  // ── Validate that every active suffix in every row sums to 1 ───────────────
  const techViolations = useMemo(() => {
    const violations = [];
    localValues.forEach((vals, rowIdx) => {
      const row      = initialRows[rowIdx];
      const label    = row.subarea || row.iso || `Area ${rowIdx + 1}`;
      const urbFrac  = parseFloat(row.fraction_urban_pop) || 0;
      SUFFIXES.forEach((sfx) => {
        if (sfx === '_urb' && urbFrac <= 0) return;
        if (sfx === '_rur' && urbFrac >= 1) return;
        const { techTotal } = computeLadder(vals, sfx);
        if (Math.abs(techTotal - 1) > SUM_TOL) {
          violations.push({ label, sfx, total: techTotal });
        }
      });
    });
    return violations;
  }, [localValues, initialRows]);

  const canSave = techViolations.length === 0;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
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
  }, [canSave, localValues, initialRows, scenario.id, onDirtyChange]);

  const selectedArr  = useMemo(() => Array.from(selectedIndices).sort((a, b) => a - b), [selectedIndices]);
  const isAllSelected = selectedArr.length === initialRows.length;

  // ── Raw data
  // Derive raw columns from what's actually present in the first row (preserves CSV order from
  // RAW_SANITATION_COLS, no dependency on the API fieldnames array being populated correctly).
  const rawFieldnames = useMemo(() => {
    if (!initialRows.length) return [];
    const presentKeys = new Set(Object.keys(initialRows[0]));
    const cols = RAW_SANITATION_COLS.filter((c) => presentKeys.has(c));
    console.log('[SanitationLadderPanel] rawFieldnames:', cols.length, 'presentKeys sample:', [...presentKeys].slice(0, 5));
    return cols;
  }, [initialRows]);
  const rawData = useMemo(
    () =>
      initialRows.map((row, i) => {
        const out = {};
        rawFieldnames.forEach((col) => {
          if (RAW_ID_COLS.includes(col)) {
            out[col] = row[col] ?? '';
          } else {
            const v = localValues[i]?.[col];
            out[col] = v != null ? String(v) : '';
          }
        });
        return out;
      }),
    [initialRows, localValues, rawFieldnames]
  );

  // Display values: average across selected rows; for suffixed fields only include rows that
  // support that suffix (urban rows for _urb keys, non-100%-urban rows for _rur keys).
  const displayVals = useMemo(() => {
    if (selectedArr.length === 1) return localValues[selectedArr[0]];
    const base = localValues[selectedArr[0]];
    const out  = {};
    Object.keys(base).forEach((key) => {
      const keySfx = SUFFIXES.find((s) => key.endsWith(s));
      if (keySfx) {
        const pool = selectedArr.filter((i) => {
          const uf = parseFloat(initialRows[i].fraction_urban_pop) || 0;
          return keySfx === '_urb' ? uf > 0 : uf < 1;
        });
        out[key] = pool.length
          ? pool.reduce((s, i) => s + (parseFloat(localValues[i][key]) || 0), 0) / pool.length
          : 0;
      } else {
        const sum = selectedArr.reduce((s, i) => s + (parseFloat(localValues[i][key]) || 0), 0);
        out[key]  = sum / selectedArr.length;
      }
    });
    return out;
  }, [selectedArr, localValues, initialRows]);

  // Representative row for suffix/label lookup
  const repRow = initialRows[selectedArr[0]];
  if (!repRow || !displayVals) return null;

  const areaLabel = isAllSelected
    ? 'All Areas'
    : selectedArr.length > 1
      ? `${selectedArr.length} areas selected`
      : (repRow.subarea || repRow.iso || `Area ${selectedArr[0] + 1}`);

  // Show a suffix if at least one selected row uses it
  const activeSfx = SUFFIXES.filter((sfx) =>
    selectedArr.some((i) => {
      const uf = parseFloat(initialRows[i].fraction_urban_pop) || 0;
      return sfx === '_urb' ? uf > 0 : uf < 1;
    })
  );

  // Indices to write to when a slider changes
  const editIndices = selectedArr;
  // Resolved suffix tab — falls back to first active suffix if current tab is not available
  const resolvedTab = activeSfx.includes(activeSfxTab) ? activeSfxTab : (activeSfx[0] ?? '_urb');

  return (
    <div className="space-y-4">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1 flex-1">

          {/* All pill */}
          <button
            onClick={selectAll}
            className={`relative px-3 py-1 text-xs rounded-full font-medium transition-colors border ${
              isAllSelected
                ? 'text-white border-transparent'
                : 'bg-white-100 text-gray-500 border-gray-300 hover:bg-gray-200'
            }`}
            style={isAllSelected ? { backgroundColor: '#0B4159' } : {}}
            title="Select all areas (shows averages)"
          >
            All
          </button>

          {/* Multi-select toggle — sits right after All */}
          <button
            onClick={() => {
              setMultiSelectMode((v) => {
                if (v) {
                  setSelectedIndices((prev) => new Set([Array.from(prev).sort((a, b) => a - b)[0] ?? 0]));
                }
                return !v;
              });
            }}
            className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors border ${
              multiSelectMode
                ? 'bg-wpBlue/10 text-wpBlue border-wpBlue/40'
                : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-100'
            }`}
          >
            {multiSelectMode ? 'Single select' : 'Select multiple…'}
          </button>

          {/* Per-area pills */}
          {initialRows.map((r, i) => {
            const lbl          = r.subarea || r.iso || `Area ${i + 1}`;
            const hasViolation = techViolations.some((v) => v.label === lbl);
            const dirty        = areaIsDirty[i];
            const isSelected   = selectedIndices.has(i);
            return (
              <button
                key={i}
                onClick={() => handleAreaClick(i)}
                className={`relative px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  isSelected ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={isSelected ? { backgroundColor: '#0B4159' } : {}}
                title={isSelected ? 'Click to deselect' : 'Click to select'}
              >
                {lbl}
                {/* Yellow dot — area has unsaved changes */}
                {dirty && !hasViolation && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white"
                    style={{ backgroundColor: COLORS.unimproved }}
                    title="Unsaved changes"
                  />
                )}
                {/* Red dot — tech mix doesn't sum to 100% */}
                {hasViolation && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 border border-white" title="Tech mix ≠ 100%" />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isDirty && (
            <>
              <span className="w-2 h-2 rounded-full bg-orange-400" title="Unsaved changes" />
              <button
                onClick={handleReset}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
              >
                <RotateCcw size={12} /> Reset
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !canSave}
                title={!canSave ? 'Fix technology mix totals before saving' : ''}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: canSave ? '#8DD0A4' : '#9ca3af', color: canSave ? '#0B4159' : 'white' }}
              >
                <Save size={12} /> {isSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Validation banner ─────────────────────────────────────────────── */}
      {isDirty && !canSave && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-red-700">
            <span className="font-semibold">Cannot save — technology mix must sum to 100%</span>
            <ul className="mt-0.5 list-disc list-inside space-y-0.5">
              {techViolations.map((v, i) => (
                <li key={i}>
                  {v.label} ({SUFFIX_LABELS[v.sfx]}): currently&nbsp;
                  <strong>{(v.total * 100).toFixed(1)}%</strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── Urban / Rural ─────────────────────────────────────────────────── */}
      <div>
        {activeSfx.filter((sfx) => activeSfx.length === 1 || sfx === resolvedTab).map((sfx) => {
          const ladder     = computeLadder(displayVals, sfx);
          const makeChange = (key, value) => {
            // Only write to rows that support the suffix in this key
            const keySfx = SUFFIXES.find((s) => key.endsWith(s));
            const targets = keySfx
              ? editIndices.filter((i) => {
                  const uf = parseFloat(initialRows[i].fraction_urban_pop) || 0;
                  return keySfx === '_urb' ? uf > 0 : uf < 1;
                })
              : editIndices;
            if (multiSelectMode && targets.length > 1) {
              // Proportional scaling: preserve relative differences, move average to new value
              updateFieldProportional(targets, key, value);
            } else {
              updateField(targets, key, value);
            }
          };
          const techOk = Math.abs(ladder.techTotal - 1) <= SUM_TOL;

          return (
            <div key={sfx} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {/* Card header — area name + Urban/Rural tab switcher */}
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h4 className="text-sm font-semibold text-gray-700 truncate">
                    {areaLabel}
                  </h4>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="flex gap-0.5 p-0.5 bg-gray-200 rounded-lg">
                    {SUFFIXES.map((s) => {
                      const isDisabled = !activeSfx.includes(s);
                      return (
                        <button
                          key={s}
                          onClick={() => !isDisabled && setActiveSfxTab(s)}
                          disabled={isDisabled}
                          className={`relative flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                            isDisabled
                              ? 'text-gray-300 cursor-not-allowed'
                              : s === resolvedTab
                                ? 'bg-white shadow-sm text-wpBlue'
                                : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          {SUFFIX_LABELS[s]}
                          {!isDisabled && dirtySuffixes.has(s) && (
                            <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <span
                    className="text-xs font-outfit font-semibold px-1.5 py-0.5 rounded"
                    style={techOk
                      ? { color: COLORS.safelyManaged, backgroundColor: BG.improved }
                      : { color: '#b91c1c', backgroundColor: '#fef2f2' }
                    }
                  >
                    Σ = {(ladder.techTotal * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="px-4 py-4 space-y-3">
                {/* Stacked bar */}
                <LadderBar ladder={ladder} />

                {/* ── 1. Improved Facilities (Safely Managed + Basic) ──────── */}
                <CollapsibleSection
                  headerColor={COLORS.improved}
                  darkHeaderText={false}
                  label="Improved Facilities"
                  initialOpen={ladder.improvedTotal > 0.001 || selectedArr.length > 1}
                  hasError={!techOk}
                  badgeContent={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/70 hidden sm:inline">SM:</span>
                      <span className="text-xs font-outfit font-bold text-white">
                        {(ladder.safelyManaged * 100).toFixed(1)}%
                      </span>
                      <span className="text-white/40 text-xs">|</span>
                      <span className="text-xs text-white/70 hidden sm:inline">Basic:</span>
                      <span className="text-xs font-outfit font-bold text-white">
                        {(ladder.basic * 100).toFixed(1)}%
                      </span>
                    </div>
                  }
                >
                  <div className="px-4 py-3" style={{ backgroundColor: BG.improved }}>
                    {/* SM / Basic summary cards */}
                    <div className="flex gap-3 mb-3">
                      <div className="flex-1 rounded px-3 py-1.5 text-center"
                        style={{ backgroundColor: COLORS.safelyManaged + '20', border: `1px solid ${COLORS.safelyManaged}44` }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.safelyManaged }}>
                          Safely Managed
                        </div>
                        <div className="text-lg font-bold tabular-nums" style={{ color: COLORS.safelyManaged }}>
                          {(ladder.safelyManaged * 100).toFixed(1)}%
                        </div>
                        <div className="text-[10px] text-gray-400 italic">(sewer × treated) + (onsite × treated)</div>
                      </div>
                      <div className="flex-1 rounded px-3 py-1.5 text-center"
                        style={{ backgroundColor: COLORS.basic + '20', border: `1px solid ${COLORS.basic}44` }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.basic }}>
                          Basic
                        </div>
                        <div className="text-lg font-bold tabular-nums" style={{ color: COLORS.basic }}>
                          {(ladder.basic * 100).toFixed(1)}%
                        </div>
                        <div className="text-[10px] text-gray-400 italic">improved − safely managed</div>
                      </div>
                    </div>

                    {/* Two-column layout: left = mix + management, right = treatment */}
                    <SyncedTwoColumns
                      borderColor={COLORS.safelyManaged + '33'}
                      leftContent={
                        <>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                            Technology mix
                          </p>
                          {IMPROVED_FIELDS.map((f) => {
                            const key = `${f}${sfx}`;
                            if (!(key in displayVals)) return null;
                            return (
                              <IndependentSliderRow
                                key={key}
                                label={FIELD_LABELS[f]}
                                value={displayVals[key] ?? 0}
                                fieldKey={key}
                                accentColor={COLORS.safelyManaged}
                                onChange={makeChange}
                              />
                            );
                          })}
                          <div className="mt-3 pt-3 border-t" style={{ borderColor: COLORS.safelyManaged + '33' }}>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                              Management options
                            </p>
                            <div className="pt-1">
                              {BOOLEAN_FIELDS.map((f) => {
                                const key = `${f}${sfx}`;
                                if (!(key in displayVals)) return null;
                                return (
                                  <IndependentSliderRow
                                    key={key}
                                    label={FIELD_LABELS[f]}
                                    value={displayVals[key] ?? 0}
                                    fieldKey={key}
                                    accentColor={COLORS.notContributing}
                                    onChange={makeChange}
                                  />
                                );
                              })}
                            </div>
                            {`emptyFrequency${sfx}` in displayVals && (
                              <div className="pt-2 mt-1 border-t border-gray-100">
                                <IntegerField
                                  label={FIELD_LABELS.emptyFrequency}
                                  value={displayVals[`emptyFrequency${sfx}`]}
                                  onChange={(v) => updateField(editIndices, `emptyFrequency${sfx}`, v)}
                                />
                              </div>
                            )}
                          </div>
                        </>
                      }
                      rightContent={
                        <>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 text-center">
                            Treatment fractions
                          </p>
                          <div className="flex gap-2 justify-center flex-1 min-h-0">
                            {TREATMENT_FIELDS.map((f) => {
                              const key = `${f}${sfx}`;
                              if (!(key in displayVals)) return null;
                              return (
                                <VerticalSliderColumn
                                  key={key}
                                  label={FIELD_LABELS[f].replace(' (fraction)', '')}
                                  value={displayVals[key] ?? 0}
                                  fieldKey={key}
                                  accentColor={COLORS.safelyManaged}
                                  onChange={makeChange}
                                />
                              );
                            })}
                          </div>
                        </>
                      }
                    />
                  </div>
                </CollapsibleSection>

                {/* ── 2 & 3. Unimproved + Open Defecation (same row) ────────── */}
                <div className="flex gap-2">
                  {/* Unimproved */}
                  <div className="flex-1 min-w-0">
                <CollapsibleSection
                  headerColor={COLORS.unimproved}
                  darkHeaderText={true}
                  label="Unimproved"
                  initialOpen={ladder.unimproved > 0.001}
                  hasError={!techOk}
                  badgeContent={
                    <span className="text-sm font-outfit font-bold text-gray-900">
                      {(ladder.unimproved * 100).toFixed(1)}%
                    </span>
                  }
                >
                  <div className="px-4 py-3 space-y-0" style={{ backgroundColor: BG.unimproved }}>
                    <p className="text-xs text-gray-500 italic mb-2">
                      Pit without slab, open drainage, hanging toilet, bucket latrine or other.
                    </p>
                    {UNIMPROVED_FIELDS.map((f) => {
                      const key = `${f}${sfx}`;
                      if (!(key in displayVals)) return null;
                      return (
                        <IndependentSliderRow
                          key={key}
                          label={FIELD_LABELS[f]}
                          value={displayVals[key] ?? 0}
                          fieldKey={key}
                          accentColor={COLORS.unimproved}
                          darkAccent={true}
                          onChange={makeChange}
                        />
                      );
                    })}
                    {UNIMPROVED_FIELDS.filter((f) => `${f}${sfx}` in displayVals).length > 1 && (
                      <div className="flex justify-end mt-1 pt-1 border-t border-gray-200">
                        <span className="text-xs tabular-nums text-gray-600">
                          Σ = {(UNIMPROVED_FIELDS.reduce((s, f) => s + (displayVals[`${f}${sfx}`] ?? 0), 0) * 100).toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
                  </div>

                  {/* Open Defecation */}
                  <div className="flex-1 min-w-0">
                <CollapsibleSection
                  headerColor={COLORS.openDefecation}
                  darkHeaderText={true}
                  label="Open Defecation"
                  initialOpen={ladder.openDefecation > 0.001}
                  hasError={!techOk}
                  badgeContent={
                    <span className="text-sm font-outfit font-bold text-gray-900">
                      {(ladder.openDefecation * 100).toFixed(1)}%
                    </span>
                  }
                >
                  <div className="px-4 py-3 space-y-0" style={{ backgroundColor: BG.openDefecation }}>
                    <p className="text-xs text-gray-500 italic mb-2">
                      Defecation in fields, water bodies, or other open spaces.
                    </p>
                    {OD_FIELDS.map((f) => {
                      const key = `${f}${sfx}`;
                      if (!(key in displayVals)) return null;
                      return (
                        <IndependentSliderRow
                          key={key}
                          label={FIELD_LABELS[f]}
                          value={displayVals[key] ?? 0}
                          fieldKey={key}
                          accentColor={COLORS.openDefecation}
                          darkAccent={true}
                          onChange={makeChange}
                        />
                      );
                    })}
                  </div>
                </CollapsibleSection>
                  </div>
                </div>

              </div>
            </div>
          );
        })}
      </div>

      {/* ── Raw data view ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowFullData((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <TableProperties size={16} className="text-gray-400" />
              <span>Raw data ({rawFieldnames.length} columns, {initialRows.length} row{initialRows.length !== 1 ? 's' : ''})</span>
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

// ─── Outer wrapper ────────────────────────────────────────────────────────────

const SanitationLadderPanel = ({ scenario, onDirtyChange }) => {
  const [fetchState, setFetchState] = useState({ status: 'loading', rows: [], fieldnames: [] });

  useEffect(() => {
    let cancelled = false;
    setFetchState({ status: 'loading', rows: [], fieldnames: [] });

    if (scenario?.isTemp) {
      const rows = scenario?.data?.data ?? [];
      const fieldnames = scenario?.data?.fieldnames ?? [];
      setFetchState({ status: 'done', rows, fieldnames });
      return;
    }

    axios
      .get(`/api/scenarios/${scenario.id}/isodata`)
      .then((r) => {
        if (!cancelled) setFetchState({ status: 'done', rows: r.data.data ?? [], fieldnames: r.data.fieldnames ?? [] });
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
        <div className="animate-spin rounded-full h-6 w-6 border-b-2" style={{ borderColor: COLORS.safelyManaged }} />
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
    <SanitationLadderInner
      key={scenario.id}
      scenario={scenario}
      initialRows={fetchState.rows}
      fieldnames={fetchState.fieldnames}
      onDirtyChange={onDirtyChange}
    />
  );
};

export default SanitationLadderPanel;
