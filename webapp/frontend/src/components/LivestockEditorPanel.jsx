import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { RotateCcw, Save, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import AreaSelector from './AreaSelector';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from './Dialog';
import useScenarioStore from '../store/scenarioStore';
import { MapContainer, TileLayer, useMap, GeoJSON as LeafletGeoJSON } from 'react-leaflet';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import parseGeoraster from 'georaster';
import proj4 from 'proj4';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Required by georaster-layer-for-leaflet to reproject TIFs not in WGS84
window.proj4 = proj4;

import AssesIcon from '../../assets/icons/asses.svg';
import CamelsIcon from '../../assets/icons/camels.svg';
import BuffaloesIcon from '../../assets/icons/buffaloes.svg';
import CattleIcon from '../../assets/icons/cattle.svg';
import DairyIcon from '../../assets/icons/dairy.svg';
import GoatsIcon from '../../assets/icons/goats.svg';
import HorsesIcon from '../../assets/icons/horses.svg';
import MeatIcon from '../../assets/icons/meat.svg';
import MulesIcon from '../../assets/icons/mules.svg';
import PigsIcon from '../../assets/icons/pigs.svg';
import PoultryIcon from '../../assets/icons/poultry.svg';
import SheepIcon from '../../assets/icons/sheep.svg';
import LivestockEmissionsIcon from '../../assets/icons/livestock_emissions.svg';

const ICONS = {
  asses: AssesIcon,
  donkeys: AssesIcon,
  camels: CamelsIcon,
  cattle: CattleIcon,
  chickens: PoultryIcon,
  ducks: PoultryIcon,
  goats: GoatsIcon,
  horses: HorsesIcon,
  mules: MulesIcon,
  pigs: PigsIcon,
  poultry: PoultryIcon,
  sheep: SheepIcon,
  buffaloes: BuffaloesIcon,
  dairy: DairyIcon,
  meat: MeatIcon,
};

// isodata_<animal>.csv field labels — based on Vermeulen 2017 / GloWPa source
const LIVESTOCK_POP_LABELS = {
  frac_young: 'Fraction < 3 months',
  prev_young: 'Prevalence young',
  prev_adult: 'Prevalence adult',
  excr_young: 'Excretion young [ooc/g]',
  excr_adult: 'Excretion adult [ooc/g]',
  excr_day: 'Excretion /head/day [ooc]',
  mass_young: 'Body mass young [kg]',
  mass_adult: 'Body mass adult [kg]',
  manure_per_mass: 'Manure / body mass [kg/kg]',
};

// manure_management.csv: column format = SYSTEM_animal (last _ token = animal)
const MANURE_SYSTEM_LABELS = {
  PP:   'Pasture / Range / Paddock',
  DS:   'Daily spread on land',
  SS:   'Solid storage',
  DL:   'Dry lot storage',
  LS:   'Liquid / slurry storage',
  UAL:  'Uncovered anaerobic lagoon',
  AD:   'Anaerobic digester',
  BF:   'Burned for fuel',
  O:    'Other systems',
  Pl1:  'Pig storage < 1 month',
  Ph1:  'Pig storage > 1 month',
  SSDL: 'Solid storage & dry lot',
};

// manure_fractions.csv: column format = animal_fXY
// f + sink (g=grazing, o=other) + system (i=intensive, e=extensive), from Vermeulen 2017
const MANURE_FRAC_LABELS = {
  fgi: 'Grazing, intensive',
  fge: 'Grazing, extensive',
  foi: 'Other, intensive',
  foe: 'Other, extensive',
};

// Animals excluded from Livestock Population and Production Systems views by default
const EXCLUDED_BY_DEFAULT = new Set(['poultry', 'meat', 'dairy']);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function asText(v) { return v == null ? '' : String(v); }

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function fmtInt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return Math.round(v).toLocaleString();
}

function animalLabel(k) {
  const m = {
    asses: 'Asses', donkeys: 'Donkeys', camels: 'Camels', cattle: 'Cattle',
    buffaloes: 'Buffaloes', chickens: 'Chickens', ducks: 'Ducks', goats: 'Goats',
    horses: 'Horses', mules: 'Mules', pigs: 'Pigs', poultry: 'Poultry',
    sheep: 'Sheep', dairy: 'Dairy', meat: 'Meat',
  };
  return m[k] || titleCase(k);
}

function rowsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function isValidNumber(s) {
  const t = String(s ?? '').trim();
  if (t === '') return false;
  const v = parseFloat(t);
  return !isNaN(v) && isFinite(v);
}

function csvFieldnamesForSave(rows, visibleFieldnames) {
  if (!rows.length) return visibleFieldnames;
  const all = Object.keys(rows[0]);
  const hidden = ['iso', 'gid', 'subarea'];
  return [...hidden.filter((h) => all.includes(h)), ...visibleFieldnames.filter((f) => f !== 'area_name')];
}

// ---------------------------------------------------------------------------
// StepperInput
// ---------------------------------------------------------------------------
function StepperInput({ value, onChange, step = 1, min, max, percent = false, decimals, inputClassName }) {
  const [raw, setRaw] = useState(asText(value));
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const valid = raw === '' || isValidNumber(raw);

  useEffect(() => {
    setRaw(asText(value));
    setEditing(false);
  }, [value]);

  const toDisplay = (r) => {
    if (r === '') return percent ? '0.0' : '0';
    if (!isValidNumber(r)) return r;
    const n = parseFloat(r);
    if (percent) return (n * 100).toFixed(1);
    if (decimals != null) return n.toFixed(decimals);
    return r;
  };

  const commit = (text) => {
    setEditing(false);
    const n = parseFloat(text);
    if (!isNaN(n)) {
      let newRaw = percent ? n / 100 : n;
      if (min != null) newRaw = Math.max(min, newRaw);
      if (max != null) newRaw = Math.min(max, newRaw);
      newRaw = Math.round(newRaw * 1e9) / 1e9;
      const s = String(newRaw);
      setRaw(s);
      onChange(s);
    }
  };

  const nudge = (delta) => {
    setEditing(false);
    const base = raw === '' ? 0 : parseFloat(raw);
    const next = isNaN(base) ? 0 : Math.round((base + delta) * 1e9) / 1e9;
    let clamped = next;
    if (min != null) clamped = Math.max(min, clamped);
    if (max != null) clamped = Math.min(max, clamped);
    const s = String(clamped);
    setRaw(s);
    onChange(s);
  };

  const displayLabel = toDisplay(raw) + (percent ? '%' : '');

  return (
    <div className="flex items-center gap-0.5 text-xs">
      <button type="button" onClick={() => nudge(-step)}
        className="px-1 py-1 text-gray-400 hover:text-wpBlue hover:bg-gray-50 rounded select-none" tabIndex={-1}>−</button>
      {editing ? (
        <input
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.target.value);
            if (e.key === 'Escape') setEditing(false);
          }}
          className={`${inputClassName ?? 'w-14'} px-1 py-0.5 text-center border border-wpBlue-300 rounded focus:outline-none focus:ring-1 focus:ring-wpBlue-400 ${valid ? 'text-gray-800' : 'text-red-500'}`}
        />
      ) : (
        <span
          className={`${inputClassName ?? 'w-14'} px-1 py-0.5 text-center tabular-nums cursor-text hover:bg-gray-100 rounded select-none ${valid ? 'text-gray-800' : 'text-red-500'}`}
          title="Click to type a value"
          onClick={() => { setEditText(toDisplay(raw)); setEditing(true); }}
        >
          {displayLabel}
        </span>
      )}
      <button type="button" onClick={() => nudge(+step)}
        className="px-1 py-1 text-gray-400 hover:text-wpBlue hover:bg-gray-50 rounded select-none" tabIndex={-1}>+</button>
    </div>
  );
}

// AreaSelector is imported from ./AreaSelector (shared component)

// ---------------------------------------------------------------------------
// RawDataView — collapsible raw CSV table
// ---------------------------------------------------------------------------
function RawDataView({ rows, fieldnames }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-gray-200">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-gray-50 text-xs text-gray-500 hover:bg-gray-100">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Raw data ({rows.length} rows × {fieldnames.length} columns)
      </button>
      {open && (
        <div className="overflow-auto max-h-64">
          <table className="w-full text-xs font-mono">
            <thead className="bg-gray-50 sticky top-0">
              <tr>{fieldnames.map((f) => (
                <th key={f} className="px-2 py-1 text-left text-gray-500 whitespace-nowrap border-b border-gray-200">{f}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row, i) => (
                <tr key={i}>{fieldnames.map((f) => (
                  <td key={f} className="px-2 py-1 whitespace-nowrap text-gray-600">{asText(row[f])}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SaveResetBar
// ---------------------------------------------------------------------------
function SaveResetBar({ title, hint, isDirty, isSaving, onSave, onReset, validationErrors = [], rightSlot }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
      <p className="text-sm font-semibold text-wpBlue">{title}</p>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
      {validationErrors.length > 0 && (
        <span className="text-xs text-red-500 ml-1">{validationErrors[0]}{validationErrors.length > 1 ? ` (+${validationErrors.length - 1} more)` : ''}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {rightSlot}
        {isDirty && (
          <>
            <button onClick={onReset}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">
              <RotateCcw size={12} /> Reset
            </button>
            <button onClick={onSave} disabled={isSaving || validationErrors.length > 0}
              className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-wpGreen hover:bg-wpGreen-600 rounded disabled:opacity-50">
              <Save size={12} /> {isSaving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function LoadingState({ label }) {
  return (
    <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
      <Loader2 size={20} className="animate-spin" />
      <span className="text-sm">Loading {label}…</span>
    </div>
  );
}

function ErrorState({ label, error }) {
  return (
    <div className="bg-white rounded-lg border border-red-100 p-6 text-sm text-red-500">
      Failed to load {label}: {error}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AreaOverlay — fetches scenario geodata and renders area borders + labels
// ---------------------------------------------------------------------------
function AreaOverlay({ scenarioId }) {
  const map = useMap();
  const [geojson, setGeojson] = useState(null);

  useEffect(() => {
    axios.get(`/api/scenarios/${scenarioId}/geodata`)
      .then(r => setGeojson(r.data))
      .catch(() => {});
  }, [scenarioId]);

  useEffect(() => {
    if (!geojson?.features?.length || !map) return;
    try {
      const bounds = L.geoJSON(geojson).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
    } catch (_) {}
  }, [geojson, map]);

  if (!geojson?.features?.length) return null;

  const areaStyle = () => ({
    fill: false,
    fillOpacity: 0,
    color: '#1e293b',
    weight: 1.5,
    opacity: 0.75,
  });

  return (
    <LeafletGeoJSON
      key={scenarioId}
      data={geojson}
      style={areaStyle}
    />
  );
}

// ---------------------------------------------------------------------------
// HeadsRasterLayer — child of MapContainer; uses useMap() to load TIF layers
// ---------------------------------------------------------------------------
function HeadsRasterLayer({ tifUrl }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!tifUrl || !map) return;
    let cancelled = false;

    (async () => {
      try {
        const ab = await fetch(tifUrl).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;

        const nd = gr.noDataValue;
        const maxVal = gr.maxs?.[0] || 1;

        const newLayer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.85,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: ([v]) => {
            if (v == null || v === nd || v <= 0) return null;
            const norm = Math.min(1, v / maxVal);
            const r = Math.round(255 * (1 - norm));
            const g = Math.round(100 + 155 * (1 - norm));
            return `rgba(255,${g},${r},0.85)`;
          },
        });

        if (layerRef.current) { try { map.removeLayer(layerRef.current); } catch (_) {} }
        newLayer.addTo(map);
        layerRef.current = newLayer;

        try {
          const bounds = newLayer.getBounds();
          if (bounds?.isValid?.()) map.fitBounds(bounds, { padding: [16, 16] });
        } catch (_) {}
      } catch (_) {}
    })();

    return () => {
      cancelled = true;
      if (layerRef.current) {
        try { map.removeLayer(layerRef.current); } catch (_) {}
        layerRef.current = null;
      }
    };
  }, [tifUrl, map]);

  return null;
}

// ---------------------------------------------------------------------------
// AnimalHeadsMap — species selector + MapContainer
// ---------------------------------------------------------------------------
function AnimalHeadsMap({ scenarioId, animals }) {
  const safeAnimals = animals || [];
  const [selectedAnimal, setSelectedAnimal] = useState(() => safeAnimals[0] || '');

  // Sync when animals list arrives/changes after initial mount
  useEffect(() => {
    if (safeAnimals.length > 0 && !safeAnimals.includes(selectedAnimal)) {
      setSelectedAnimal(safeAnimals[0]);
    }
  }, [safeAnimals.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const tifUrl = selectedAnimal
    ? `/api/scenarios/${scenarioId}/livestock-tif/${selectedAnimal}_heads.tif`
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-gray-700">Animal species:</label>
        <select
          value={selectedAnimal}
          onChange={e => setSelectedAnimal(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-xs"
        >
          {safeAnimals.map(animal => (
            <option key={animal} value={animal}>{animalLabel(animal)}</option>
          ))}
        </select>
      </div>
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{ height: 380, width: '100%', borderRadius: 8 }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
          attribution='&copy; CARTO &copy; OSM'
        />
        <HeadsRasterLayer key={selectedAnimal} tifUrl={tifUrl} />
        <AreaOverlay scenarioId={scenarioId} />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
          attribution=''
          zIndex={650}
          pane="overlayPane"
        />
      </MapContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PopRasterLayer — renders isoraster / popurban / poprural TIFs with a
// log-scale blue gradient suited to population density values
// ---------------------------------------------------------------------------
function PopRasterLayer({ tifUrl, mode }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!tifUrl || !map) return;
    let cancelled = false;

    (async () => {
      try {
        const ab = await fetch(tifUrl).then(r => r.arrayBuffer());
        const gr = await parseGeoraster(ab);
        if (cancelled) return;

        const nd = gr.noDataValue;

        const colorFn = mode === 'domain'
          ? ([v]) => {
              if (v == null || v === nd || v <= 0) return null;
              return 'rgba(11,65,89,0.35)';
            }
          : ([v]) => {
              if (v == null || v === nd || v <= 0) return null;
              const norm = Math.min(1, Math.log10(Math.max(1, v)) / 5);
              const r = Math.round(230 * (1 - norm));
              const g = Math.round(240 * (1 - norm) + 50 * norm);
              const b = Math.round(255 * (1 - norm * 0.3) + 107 * norm * 0.3);
              return `rgba(${r},${g},${b},0.82)`;
            };

        const newLayer = new GeoRasterLayer({
          georaster: gr,
          opacity: 1,
          resolution: 256,
          caching: false,
          pixelValuesToColorFn: colorFn,
        });

        if (layerRef.current) { try { map.removeLayer(layerRef.current); } catch (_) {} }
        newLayer.addTo(map);
        layerRef.current = newLayer;

        try {
          const bounds = newLayer.getBounds();
          if (bounds?.isValid?.()) map.fitBounds(bounds, { padding: [16, 16] });
        } catch (_) {}
      } catch (_) {}
    })();

    return () => {
      cancelled = true;
      if (layerRef.current) {
        try { map.removeLayer(layerRef.current); } catch (_) {}
        layerRef.current = null;
      }
    };
  }, [tifUrl, map, mode]);

  return null;
}

const POP_LAYERS = [
  { id: 'isoraster', label: 'Analysis domain', hint: 'Grid cells included in the model' },
  { id: 'popurban',  label: 'Urban population', hint: 'Urban population per cell' },
  { id: 'poprural', label: 'Rural population', hint: 'Rural population per cell' },
];

// ---------------------------------------------------------------------------
// PopulationMap — shows urban population raster with area overlay.
// The layer switcher is intentionally hidden; only the urban raster is shown.
// ---------------------------------------------------------------------------
export function PopulationMap({ scenarioId }) {
  const tifUrl = `/api/scenarios/${scenarioId}/input-raster/popurban.tif`;

  return (
    <div className="space-y-2">
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{ height: 420, width: '100%', borderRadius: 8 }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
          attribution='&copy; CARTO &copy; OSM'
        />
        <PopRasterLayer key="popurban" tifUrl={tifUrl} mode="population" />
        <AreaOverlay scenarioId={scenarioId} />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
          attribution=''
          zIndex={650}
          pane="overlayPane"
        />
      </MapContainer>
      <p className="text-xs text-gray-400">Urban population per cell</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeadsSummaryDialogContent — standalone dialog body with per-scenario selector
// ---------------------------------------------------------------------------
function HeadsSummaryDialogContent({ activeScenario }) {
  const [animals, setAnimals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    axios.get(`/api/scenarios/${activeScenario.id}/livestock-heads-by-area`)
      .then((res) => {
        if (res.data && !res.data.error) {
          const totals = res.data.totals_by_animal || {};
          const sorted = (res.data.animals || []).sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
          setAnimals(sorted);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeScenario.id]);

  if (loading) return <LoadingState label="heads data" />;
  if (!animals.length) return <p className="text-sm text-gray-500">No heads raster data available for this scenario.</p>;

  return <AnimalHeadsMap scenarioId={activeScenario.id} animals={animals} />;
}

// ---------------------------------------------------------------------------
// LivestockPopulationEditor
// Rows = animals, columns = isodata fields (frac_young, prev_*, excr_*, mass_*, manure_per_mass)
// ---------------------------------------------------------------------------
function LivestockPopulationEditor({ scenario, onDirtyChange, onSaved, onHeadCountsChange }) {
  const clonePopulationRows = useCallback((arr) => (
    (arr || []).map((r) => ({
      ...r,
      areaRows: Array.isArray(r.areaRows) ? r.areaRows.map((ar) => ({ ...ar })) : [],
    }))
  ), []);

  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [areaLabels, setAreaLabels] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [fieldnames, setFieldnames] = useState([]);    // editable field columns
  const [rawFieldnames, setRawFieldnames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  // animals with non-zero TIF grid sum: null = not yet loaded, {} = none found
  const [availableAnimals, setAvailableAnimals] = useState(null);
  const [headsSummary, setHeadsSummary] = useState({
    status: 'loading',
    error: '',
    areas: [],
    animals: [],
    byArea: {},
    totalsByAnimal: {},
  });
  const savedRowsRef = useRef([]);
  const [headCounts, setHeadCounts] = useState({});
  const savedHeadCountsRef = useRef({});
  const onDirtyChangeRef = useRef(onDirtyChange);

  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    setHeadsSummary({ status: 'loading', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} });
    try {
      const [r, availRes, headsRes] = await Promise.all([
        axios.get(`/api/scenarios/${scenario.id}/livestock-population`),
        axios.get(`/api/scenarios/${scenario.id}/livestock-available-animals`).catch(() => null),
        axios.get(`/api/scenarios/${scenario.id}/livestock-heads-by-area`).catch(() => null),
      ]);
      const available = availRes?.data?.animals ?? null;
      setAvailableAnimals(available);

      if (headsRes?.data && !headsRes.data.error) {
        const totals = headsRes.data.totals_by_animal || {};
        setHeadsSummary({
          status: 'done',
          error: '',
          areas: headsRes.data.areas || [],
          animals: headsRes.data.animals || [],
          byArea: headsRes.data.by_area || {},
          totalsByAnimal: totals,
        });
        setHeadCounts(totals);
        savedHeadCountsRef.current = { ...totals };
      } else {
        setHeadsSummary({ status: 'unavailable', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} });
      }

      const allFields = r.data?.fieldnames || [];
      // `animal` is injected by the backend separately — not in fieldnames
      const nextRows = (r.data?.data || []).map((row) => {
        const out = { animal: row.animal };
        allFields.forEach((f) => { out[f] = asText(row[f]); });
        out.areaRows = Array.isArray(row.areaRows)
          ? row.areaRows.map((ar) => {
              const one = {};
              allFields.forEach((f) => { one[f] = asText(ar?.[f]); });
              return one;
            })
          : [];
        return out;
      });
      // editable columns: exclude identifier columns
      const editFields = allFields.filter((f) => !['iso', 'gid', 'subarea', 'animal'].includes(f));
      savedRowsRef.current = clonePopulationRows(nextRows);
      setRows(clonePopulationRows(nextRows));
      setAreaLabels(Array.isArray(r.data?.areas) ? r.data.areas : []);
      setSelectedIndices(new Set());
      setFieldnames(editFields);
      setRawFieldnames(['animal', ...allFields]);
      onDirtyChangeRef.current?.(false);
      setStatus('done');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStatus('error');
    }
  }, [scenario.id, clonePopulationRows]);

  useEffect(() => { load(); }, [load]);

  // Notify parent whenever headCounts change (so sibling tabs can hide zero-count animals).
  const onHeadCountsChangeRef = useRef(onHeadCountsChange);
  useEffect(() => { onHeadCountsChangeRef.current = onHeadCountsChange; }, [onHeadCountsChange]);
  useEffect(() => { onHeadCountsChangeRef.current?.(headCounts); }, [headCounts]);

  const headCountsDirty = useMemo(() => {
    if (headsSummary.status !== 'done') return false;
    const saved = savedHeadCountsRef.current;
    return Object.keys(headCounts).some(
      (k) => Math.round(headCounts[k] || 0) !== Math.round(saved[k] || 0),
    );
  }, [headCounts, headsSummary.status]);

  const isDirty = useMemo(() => !rowsEqual(rows, savedRowsRef.current) || headCountsDirty, [rows, headCountsDirty]);
  useEffect(() => { onDirtyChangeRef.current?.(isDirty); }, [isDirty]);

  // Step sizes per field
  const stepFor = (f) => {
    if (['frac_young', 'prev_young', 'prev_adult'].includes(f)) return 0.001; // 0.1 pp in raw fraction units
    if (f === 'manure_per_mass') return 0.1;
    if (['mass_young', 'mass_adult'].includes(f)) return 1;
    return 1; // excr_young, excr_adult, excr_day
  };

  // Poultry (chickens/ducks) use excr_day but NOT excr_young/adult/mass/manure_per_mass
  const POULTRY_ANIMALS = ['chickens', 'ducks'];
  const NON_POULTRY_FIELDS = new Set(['excr_young', 'excr_adult', 'mass_young', 'mass_adult', 'manure_per_mass']);
  const POULTRY_ONLY_FIELDS = new Set(['excr_day']);

  const validationErrors = useMemo(() => {
    const errs = [];
    rows.forEach((row) => {
      const isPoultry = POULTRY_ANIMALS.includes((row.animal || '').toLowerCase());
      const areaRows = Array.isArray(row.areaRows) && row.areaRows.length ? row.areaRows : [row];
      areaRows.forEach((ar, ai) => {
        fieldnames.forEach((f) => {
          const isNA = (isPoultry && NON_POULTRY_FIELDS.has(f)) || (!isPoultry && POULTRY_ONLY_FIELDS.has(f));
          if (isNA) return;
          const v = ar[f];
          if (v !== '' && !isValidNumber(v)) {
            const area = areaLabels[ai] || `Area ${ai + 1}`;
            errs.push(`${row.animal || '?'} (${area}): invalid value in "${LIVESTOCK_POP_LABELS[f] || f}"`);
          }
        });
      });
    });
    return errs;
  }, [rows, fieldnames, areaLabels]);

  const effectiveAreaLabels = useMemo(() => {
    if (areaLabels.length > 0) return areaLabels;
    const first = rows[0];
    if (first?.areaRows?.length) {
      return first.areaRows.map((ar, i) => ar.subarea || ar.iso || ar.gid || `Area ${i + 1}`);
    }
    return [];
  }, [areaLabels, rows]);

  const areaCount = useMemo(() => {
    const first = rows[0];
    return Array.isArray(first?.areaRows) ? first.areaRows.length : 0;
  }, [rows]);

  const selectedAreaIndices = useMemo(() => {
    if (!areaCount) return [0];
    if (selectedIndices.size === 0) return Array.from({ length: areaCount }, (_, i) => i);
    return [...selectedIndices].filter((i) => i >= 0 && i < areaCount).sort((a, b) => a - b);
  }, [selectedIndices, areaCount]);

  const getDisplayValue = useCallback((row, field) => {
    const areaRows = Array.isArray(row.areaRows) ? row.areaRows : null;
    if (!areaRows || areaRows.length === 0) return row[field];
    const pool = selectedAreaIndices.map((i) => areaRows[i]).filter(Boolean);
    if (!pool.length) return row[field];
    if (pool.length === 1) return asText(pool[0][field]);
    const nums = pool.map((ar) => parseFloat(ar[field])).filter((v) => !isNaN(v));
    if (nums.length === pool.length) {
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return String(Math.round(avg * 1e9) / 1e9);
    }
    return asText(pool[0][field]);
  }, [selectedAreaIndices]);

  const updateFieldForSelectedAreas = useCallback((rowIdx, field, value) => {
    setRows((prev) => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      const areaRows = Array.isArray(r.areaRows) ? r.areaRows : null;
      if (!areaRows || areaRows.length === 0) {
        return { ...r, [field]: value };
      }
      const targetSet = new Set(selectedAreaIndices);
      const nextAreaRows = areaRows.map((ar, ai) => (
        targetSet.has(ai) ? { ...ar, [field]: value } : ar
      ));
      return {
        ...r,
        areaRows: nextAreaRows,
        [field]: asText(nextAreaRows[0]?.[field] ?? r[field]),
      };
    }));
  }, [selectedAreaIndices]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await axios.put(`/api/scenarios/${scenario.id}/livestock-population`, { rows });
      savedRowsRef.current = clonePopulationRows(rows);
      if (headCountsDirty) {
        await axios.put(`/api/scenarios/${scenario.id}/livestock-headcount`, { counts: headCounts });
        savedHeadCountsRef.current = { ...headCounts };
      }
      onDirtyChangeRef.current?.(false);
      onSaved?.();
    } catch (e) {
      alert('Failed to save: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setRows(clonePopulationRows(savedRowsRef.current));
    setHeadCounts({ ...savedHeadCountsRef.current });
    onDirtyChangeRef.current?.(false);
  };

  // Filter to animals that have heads > 0 in the study area.
  // headsSummary.animals is the backend-provided list of animals with non-zero heads.
  // If that data is not yet available, fall back to showing everything.
  const headsAnimalSet = useMemo(() => {
    if (headsSummary.status !== 'done' || !headsSummary.animals?.length) return null;
    return new Set(headsSummary.animals);
  }, [headsSummary.status, headsSummary.animals]);

  const visibleRows = useMemo(() => {
    let result = headsAnimalSet ? rows.filter(row => headsAnimalSet.has(row.animal)) : rows;
    result = result.filter(row => !EXCLUDED_BY_DEFAULT.has(row.animal));
    if (headsSummary.status === 'done') {
      result = result.filter(row => Math.round(headCounts[row.animal] || 0) > 0);
    }
    return result;
  }, [rows, headsAnimalSet, headCounts, headsSummary.status]);

  // All hooks must be called before any early returns (Rules of Hooks).

  if (status === 'loading') return <LoadingState label="livestock population data" />;
  if (status === 'error') return <ErrorState label="livestock population data" error={error} />;
  if (!rows.length) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6 text-sm text-gray-500">
        No <span className="font-mono">animals/isodata_*.csv</span> files found.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <SaveResetBar
        title="Livestock Population"
        hint="Source: Vermeulen 2017 / GloWPa isodata"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onReset={handleReset}
        validationErrors={validationErrors}
        rightSlot={
          <>
            {headsSummary.status === 'done' && (headsSummary.areas?.length || 0) > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <button className="flex items-center gap-1 px-3 py-1.5 text-xs text-wpBlue border border-wpBlue/40 rounded hover:bg-wpBlue/5 transition font-medium">
                    View animal distribution
                  </button>
                </DialogTrigger>
                <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Animal distribution</DialogTitle>
                  </DialogHeader>
                  <HeadsSummaryDialogContent activeScenario={scenario} />
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      />

      {effectiveAreaLabels.length > 1 && (
        <div className="px-3 py-2 border-b border-gray-100">
          <AreaSelector
            labels={effectiveAreaLabels}
            selectedIndices={selectedIndices}
            onChange={setSelectedIndices}
          />
        </div>
      )}

      <div className="overflow-auto p-3">
        <table className="text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-500 tracking-wide text-xs">
              <th className="px-3 py-2 text-left font-medium sticky left-0 bg-gray-50 z-10 whitespace-nowrap">Animal</th>
              {headsSummary.status === 'done' && (
                <th className="px-2 py-2 text-left font-medium whitespace-nowrap">Head count</th>
              )}
              {fieldnames.map((f) => (
                <th key={f} className="px-2 py-2 text-left font-medium whitespace-nowrap" title={f}>
                  {LIVESTOCK_POP_LABELS[f] || titleCase(f)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visibleRows.map((row, idx) => {
              const icon = ICONS[row.animal] || LivestockEmissionsIcon;
              const rowIdx = rows.indexOf(row);  // use original index for updates
              return (
                <tr key={row.animal || idx} className="hover:bg-gray-50">
                  <td className="px-3 py-2 sticky left-0 bg-white z-10 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <img src={icon} alt={row.animal} className="w-4 h-4" />
                      <span className="capitalize font-semibold text-wpBlue">{row.animal}</span>
                    </div>
                  </td>
                  {headsSummary.status === 'done' && (
                    <td className="px-1 py-1">
                      <StepperInput
                        value={Math.round(headCounts[row.animal] ?? 0)}
                        onChange={(v) => setHeadCounts((prev) => ({ ...prev, [row.animal]: Math.round(parseFloat(v) || 0) }))}
                        step={1000}
                        min={0}
                        inputClassName="w-24"
                      />
                    </td>
                  )}
                  {fieldnames.map((f) => {
                    const isPoultry = POULTRY_ANIMALS.includes((row.animal || '').toLowerCase());
                    const isNA = (isPoultry && NON_POULTRY_FIELDS.has(f)) || (!isPoultry && POULTRY_ONLY_FIELDS.has(f));
                    if (isNA) {
                      return (
                        <td key={f} className="px-1 py-1 text-center text-gray-300 text-xs">−</td>
                      );
                    }
                    return (
                      <td key={f} className="px-1 py-1">
                        <StepperInput
                          value={getDisplayValue(row, f)}
                          onChange={(v) => updateFieldForSelectedAreas(rowIdx, f, v)}
                          step={stepFor(f)}
                          min={0}
                          max={['frac_young', 'prev_young', 'prev_adult'].includes(f) ? 1 : undefined}
                          percent={['frac_young', 'prev_young', 'prev_adult'].includes(f)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <RawDataView rows={rows} fieldnames={rawFieldnames} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManureManagementEditor
// CSV column format: SYSTEM_animal  (last _ token = animal)
// Layout: columns = animals, rows = management systems, area name = group header
// ---------------------------------------------------------------------------
function ManureManagementEditor({ scenario, onDirtyChange, onSaved, animalsWithHeads }) {
  const filename = 'manure_management.csv';
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [fieldnames, setFieldnames] = useState([]);
  const [rawFieldnames, setRawFieldnames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const savedRowsRef = useRef([]);
  const onDirtyChangeRef = useRef(onDirtyChange);

  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const [csvRes, isoRes] = await Promise.all([
        axios.get(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`),
        axios.get(`/api/scenarios/${scenario.id}/isodata`).catch(() => ({ data: { data: [] } })),
      ]);
      const areaMap = {};
      (isoRes?.data?.data || []).forEach((r) => {
        const key = asText(r.iso || r.gid);
        if (key) areaMap[key] = r.subarea || r.NAME_3 || r.NAME_2 || r.NAME_1 || r.NAME_0 || key;
      });
      const allFields = csvRes.data?.fieldnames || [];
      const nextRows = (csvRes.data?.data || []).map((row) => {
        const out = {};
        allFields.forEach((f) => { out[f] = asText(row[f]); });
        const areaKey = asText(row.iso || row.gid);
        out.area_name = areaMap[areaKey] || row.subarea || row.gid || row.iso || areaKey;
        return out;
      });
      const editFields = allFields.filter((f) => !['iso', 'gid', 'subarea'].includes(f));
      savedRowsRef.current = nextRows;
      setRows(nextRows);
      setFieldnames(editFields);
      setRawFieldnames(allFields);
      onDirtyChangeRef.current?.(false);
      setStatus('done');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStatus('error');
    }
  }, [scenario.id]);

  useEffect(() => { load(); }, [load]);

  const isDirty = useMemo(() => !rowsEqual(rows, savedRowsRef.current), [rows]);
  useEffect(() => { onDirtyChangeRef.current?.(isDirty); }, [isDirty]);

  // Parse columns into: animals list, systems list, colMap[animal][system]=colName
  const { animals, allSystems, colMap } = useMemo(() => {
    const animalMap = new Map();  // animal -> Map<system, colName>
    const systemSet = new Set();
    fieldnames.filter((f) => f !== 'area_name').forEach((f) => {
      const parts = f.split('_');
      const animal = parts[parts.length - 1];
      const system = parts.slice(0, -1).join('_');
      if (!animalMap.has(animal)) animalMap.set(animal, new Map());
      animalMap.get(animal).set(system, f);
      systemSet.add(system);
    });
    const sysOrder = Object.keys(MANURE_SYSTEM_LABELS);
    const allSystems = [...systemSet].sort((a, b) => {
      const ai = sysOrder.indexOf(a);
      const bi = sysOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const visibleAnimals = (animalsWithHeads
      ? [...animalMap.keys()].filter(a => animalsWithHeads.has(a))
      : [...animalMap.keys()]
    ).filter(a => !EXCLUDED_BY_DEFAULT.has(a));
    return { animals: visibleAnimals, allSystems, colMap: animalMap };
  }, [fieldnames, animalsWithHeads]);

  // Sum errors: Map<`${rowIdx}_${animal}`, sum>
  const sumErrors = useMemo(() => {
    const m = new Map();
    rows.forEach((row, ri) => {
      animals.forEach((animal) => {
        const cols = [...(colMap.get(animal)?.values() || [])];
        const vals = cols.map((c) => parseFloat(row[c])).filter((v) => !isNaN(v));
        if (!vals.length) return;
        const sum = vals.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.01) m.set(`${ri}_${animal}`, sum);
      });
    });
    return m;
  }, [rows, animals, colMap]);

  // Invalid number formats AND sum≠1 both block saving.
  const validationErrors = useMemo(() => {
    const errs = [];
    rows.forEach((row, ri) => {
      const area = row.area_name || row.iso || row.gid || `Row ${ri + 1}`;
      animals.forEach((animal) => {
        const cols = [...(colMap.get(animal)?.values() || [])];
        cols.forEach((col) => {
          if (row[col] !== '' && !isValidNumber(row[col])) {
            errs.push(`${area} / ${animalLabel(animal)}: invalid value`);
          }
        });
        if (sumErrors.has(`${ri}_${animal}`)) {
          const sum = sumErrors.get(`${ri}_${animal}`);
          errs.push(`${area} / ${animalLabel(animal)}: fractions sum to ${(sum * 100).toFixed(1)}% (must be 99–101%)`);
        }
      });
    });
    return errs;
  }, [rows, animals, colMap, sumErrors]);

  // Averaged row for "All" mode display
  const avgRow = useMemo(() => {
    if (rows.length <= 1) return rows[0] || {};
    const sums = {};
    rows.forEach((row) => {
      animals.forEach((animal) => {
        colMap.get(animal)?.forEach((col) => {
          const v = parseFloat(row[col]);
          if (!isNaN(v)) sums[col] = (sums[col] || 0) + v;
        });
      });
    });
    const avg = {};
    Object.keys(sums).forEach((k) => { avg[k] = sums[k] / rows.length; });
    return avg;
  }, [rows, animals, colMap]);

  // Sum-not-1 checks on the averaged row
  const avgSumErrors = useMemo(() => {
    if (rows.length <= 1) return new Map();
    const m = new Map();
    animals.forEach((animal) => {
      const cols = [...(colMap.get(animal)?.values() || [])];
      const vals = cols.map((c) => { const v = avgRow[c]; return typeof v === 'number' ? v : parseFloat(String(v)); }).filter((v) => !isNaN(v));
      if (!vals.length) return;
      const sum = vals.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.01) m.set(`_${animal}`, sum);
    });
    return m;
  }, [rows, avgRow, animals, colMap]);

  // Cell change: single row or delta-distribute across all rows in "All" mode
  const handleCellChange = useCallback((ri, col, v) => {
    if (ri !== -1) {
      setRows((prev) => prev.map((r, i) => i === ri ? { ...r, [col]: v } : r));
    } else {
      const avgVal = typeof avgRow[col] === 'number' ? avgRow[col] : parseFloat(String(avgRow[col])) || 0;
      const newVal = parseFloat(v) || 0;
      const delta = newVal - avgVal;
      setRows((prev) => prev.map((r) => {
        const cur = parseFloat(r[col]) || 0;
        const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 1e9) / 1e9));
        return { ...r, [col]: String(next) };
      }));
    }
  }, [avgRow]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const payloadRows = rows.map((r) => { const o = { ...r }; delete o.area_name; return o; });
      await axios.put(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`, {
        rows: payloadRows,
        fieldnames: csvFieldnamesForSave(rows, fieldnames),
      });
      savedRowsRef.current = rows.map((r) => ({ ...r }));
      onDirtyChangeRef.current?.(false);
      onSaved?.();
    } catch (e) {
      alert(`Failed to save: ` + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setRows(savedRowsRef.current.map((r) => ({ ...r })));
    onDirtyChangeRef.current?.(false);
  };

  if (status === 'loading') return <LoadingState label={filename} />;
  if (status === 'error') return <ErrorState label={filename} error={error} />;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <SaveResetBar
        title="Animal shares per system"
        hint="Shares per system per animal (%)"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onReset={handleReset}
        validationErrors={validationErrors}
      />
      {rows.length > 1 && (
        <div className="px-3 py-2 border-b border-gray-100">
          <AreaSelector labels={rows.map((r, i) => r.area_name || r.iso || r.gid || `Area ${i + 1}`)} selectedIndices={selectedIndices} onChange={setSelectedIndices} />
        </div>
      )}
      <div className="overflow-auto p-3">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap sticky left-0 bg-gray-50 z-10">System</th>
              {animals.map((animal) => {
                const icon = ICONS[animal] || LivestockEmissionsIcon;
                return (
                  <th key={animal} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[90px]">
                    <div className="flex items-center justify-center gap-1">
                      <img src={icon} alt={animal} className="w-3 h-3" />
                      <span className="normal-case">{animalLabel(animal)}</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {selectedIndices.size === 0 && rows.length > 1 ? (
              /* "All" mode — show one averaged section */
              <React.Fragment>
                <tr className="bg-blue-50">
                  <td colSpan={animals.length + 1} className="px-3 py-1.5 text-xs font-semibold text-wpBlue">
                    All areas (average)
                  </td>
                </tr>
                {allSystems.map((system) => (
                  <tr key={system} className="hover:bg-gray-50 border-t border-gray-100">
                    <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap sticky left-0 bg-white z-10">
                      {MANURE_SYSTEM_LABELS[system] || system}
                    </td>
                    {animals.map((animal) => {
                      const col = colMap.get(animal)?.get(system);
                      const hasSumWarn = avgSumErrors.has(`_${animal}`);
                      if (!col) return <td key={animal} className="px-2 py-1.5 text-center text-gray-300">—</td>;
                      return (
                        <td key={animal} className={`px-1 py-1 ${hasSumWarn ? 'bg-amber-50' : ''}`}>
                          <StepperInput
                            value={String(avgRow[col] ?? 0)}
                            onChange={(v) => handleCellChange(-1, col, v)}
                            step={0.001} min={0} max={1} percent={true}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ) : (
              rows.map((row, ri) => {
                if (selectedIndices.size > 0 && !selectedIndices.has(ri)) return null;
                return (
                  <React.Fragment key={ri}>
                    {rows.length > 1 && (
                      <tr className="bg-blue-50">
                        <td colSpan={animals.length + 1} className="px-3 py-1.5 text-xs font-semibold text-wpBlue">
                          {row.area_name || row.iso || row.gid}
                        </td>
                      </tr>
                    )}
                    {allSystems.map((system) => (
                      <tr key={system} className="hover:bg-gray-50 border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap sticky left-0 bg-white z-10">
                          {MANURE_SYSTEM_LABELS[system] || system}
                        </td>
                        {animals.map((animal) => {
                          const col = colMap.get(animal)?.get(system);
                          const hasSumWarn = sumErrors.has(`${ri}_${animal}`);
                          if (!col) return <td key={animal} className="px-2 py-1.5 text-center text-gray-300">—</td>;
                          return (
                            <td key={animal} className={`px-1 py-1 ${hasSumWarn ? 'bg-amber-50' : ''}`}>
                              <StepperInput
                                value={row[col]}
                                onChange={(v) => handleCellChange(ri, col, v)}
                                step={0.001} min={0} max={1} percent={true}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <RawDataView rows={rows} fieldnames={rawFieldnames} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupedCsvEditor — animal_SUFFIX column format
// Used for manure_fractions.csv (fgi/fge/foi/foe)
// Layout: columns = animals, rows = suffix types, area name = group header
// ---------------------------------------------------------------------------
function GroupedCsvEditor({ scenario, filename, title, hint, suffixLabels, checkSum, onDirtyChange, onSaved, animalsWithHeads }) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [fieldnames, setFieldnames] = useState([]);
  const [rawFieldnames, setRawFieldnames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const savedRowsRef = useRef([]);
  const onDirtyChangeRef = useRef(onDirtyChange);

  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const [csvRes, isoRes] = await Promise.all([
        axios.get(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`),
        axios.get(`/api/scenarios/${scenario.id}/isodata`).catch(() => ({ data: { data: [] } })),
      ]);
      const areaMap = {};
      (isoRes?.data?.data || []).forEach((r) => {
        const key = asText(r.iso || r.gid);
        if (key) areaMap[key] = r.subarea || r.NAME_3 || r.NAME_2 || r.NAME_1 || r.NAME_0 || key;
      });
      const allFields = csvRes.data?.fieldnames || [];
      const nextRows = (csvRes.data?.data || []).map((row) => {
        const out = {};
        allFields.forEach((f) => { out[f] = asText(row[f]); });
        const areaKey = asText(row.iso || row.gid);
        out.area_name = areaMap[areaKey] || row.subarea || row.gid || row.iso || areaKey;
        return out;
      });
      const editFields = allFields.filter((f) => !['iso', 'gid', 'subarea'].includes(f));
      savedRowsRef.current = nextRows;
      setRows(nextRows);
      setFieldnames(editFields);
      setRawFieldnames(allFields);
      onDirtyChangeRef.current?.(false);
      setStatus('done');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStatus('error');
    }
  }, [scenario.id, filename]);

  useEffect(() => { load(); }, [load]);

  const isDirty = useMemo(() => !rowsEqual(rows, savedRowsRef.current), [rows]);
  useEffect(() => { onDirtyChangeRef.current?.(isDirty); }, [isDirty]);

  // Parse columns: animal_SUFFIX → Map<animal, Map<suffix, colName>>
  const { animals, suffixOrder, colMap } = useMemo(() => {
    const suffixes = Object.keys(suffixLabels);
    const animalMap = new Map();
    fieldnames.filter((f) => f !== 'area_name').forEach((f) => {
      const suffix = suffixes.find((s) => f.endsWith(`_${s}`));
      if (!suffix) return;
      const animal = f.slice(0, -(suffix.length + 1));
      if (!animalMap.has(animal)) animalMap.set(animal, new Map());
      animalMap.get(animal).set(suffix, f);
    });
    const visibleAnimals = (animalsWithHeads
      ? [...animalMap.keys()].filter(a => animalsWithHeads.has(a))
      : [...animalMap.keys()]
    ).filter(a => !EXCLUDED_BY_DEFAULT.has(a));
    return { animals: visibleAnimals, suffixOrder: suffixes, colMap: animalMap };
  }, [fieldnames, suffixLabels, animalsWithHeads]);

  // Sum errors per area row × animal (only when checkSum=true)
  const sumErrors = useMemo(() => {
    if (!checkSum) return new Map();
    const m = new Map();
    rows.forEach((row, ri) => {
      animals.forEach((animal) => {
        const cols = [...(colMap.get(animal)?.values() || [])];
        const vals = cols.map((c) => parseFloat(row[c])).filter((v) => !isNaN(v));
        if (!vals.length) return;
        const sum = vals.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.01) m.set(`${ri}_${animal}`, sum);
      });
    });
    return m;
  }, [rows, animals, colMap, checkSum]);

  const validationErrors = useMemo(() => {
    const errs = [];
    rows.forEach((row, ri) => {
      const area = row.area_name || row.iso || row.gid || `Row ${ri + 1}`;
      animals.forEach((animal) => {
        const cols = [...(colMap.get(animal)?.values() || [])];
        cols.forEach((col) => {
          if (row[col] !== '' && !isValidNumber(row[col])) {
            errs.push(`${area} / ${animalLabel(animal)}: invalid value`);
          }
        });
        // sum≠1 warnings are non-blocking
      });
    });
    return errs;
  }, [rows, animals, colMap]);

  // Averaged row for "All" mode display
  const avgRow = useMemo(() => {
    if (rows.length <= 1) return rows[0] || {};
    const sums = {};
    rows.forEach((row) => {
      animals.forEach((animal) => {
        colMap.get(animal)?.forEach((col) => {
          const v = parseFloat(row[col]);
          if (!isNaN(v)) sums[col] = (sums[col] || 0) + v;
        });
      });
    });
    const avg = {};
    Object.keys(sums).forEach((k) => { avg[k] = sums[k] / rows.length; });
    return avg;
  }, [rows, animals, colMap]);

  // Sum-not-1 checks on the averaged row
  const avgSumErrors = useMemo(() => {
    if (!checkSum || rows.length <= 1) return new Map();
    const m = new Map();
    animals.forEach((animal) => {
      const cols = [...(colMap.get(animal)?.values() || [])];
      const vals = cols.map((c) => { const v = avgRow[c]; return typeof v === 'number' ? v : parseFloat(String(v)); }).filter((v) => !isNaN(v));
      if (!vals.length) return;
      const sum = vals.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.01) m.set(`_${animal}`, sum);
    });
    return m;
  }, [rows, avgRow, animals, colMap, checkSum]);

  // Cell change: single row or delta-distribute across all rows in "All" mode
  const handleCellChange = useCallback((ri, col, v) => {
    if (ri !== -1) {
      setRows((prev) => prev.map((r, i) => i === ri ? { ...r, [col]: v } : r));
    } else {
      const avgVal = typeof avgRow[col] === 'number' ? avgRow[col] : parseFloat(String(avgRow[col])) || 0;
      const newVal = parseFloat(v) || 0;
      const delta = newVal - avgVal;
      setRows((prev) => prev.map((r) => {
        const cur = parseFloat(r[col]) || 0;
        const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 1e9) / 1e9));
        return { ...r, [col]: String(next) };
      }));
    }
  }, [avgRow]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const payloadRows = rows.map((r) => { const o = { ...r }; delete o.area_name; return o; });
      await axios.put(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`, {
        rows: payloadRows,
        fieldnames: csvFieldnamesForSave(rows, fieldnames),
      });
      savedRowsRef.current = rows.map((r) => ({ ...r }));
      onDirtyChangeRef.current?.(false);
      onSaved?.();
    } catch (e) {
      alert(`Failed to save: ` + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setRows(savedRowsRef.current.map((r) => ({ ...r })));
    onDirtyChangeRef.current?.(false);
  };

  if (status === 'loading') return <LoadingState label={filename} />;
  if (status === 'error') return <ErrorState label={filename} error={error} />;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <SaveResetBar
        title={title}
        hint={hint}
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onReset={handleReset}
        validationErrors={validationErrors}
      />
      {rows.length > 1 && (
        <div className="px-3 py-2 border-b border-gray-100">
          <AreaSelector labels={rows.map((r, i) => r.area_name || r.iso || r.gid || `Area ${i + 1}`)} selectedIndices={selectedIndices} onChange={setSelectedIndices} />
        </div>
      )}
      <div className="overflow-auto p-3">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap sticky left-0 bg-gray-50 z-10">
                {checkSum ? 'System' : 'Fraction'}
              </th>
              {animals.map((animal) => {
                const icon = ICONS[animal] || LivestockEmissionsIcon;
                return (
                  <th key={animal} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[90px]">
                    <div className="flex items-center justify-center gap-1">
                      <img src={icon} alt={animal} className="w-3 h-3" />
                      <span className="normal-case">{animalLabel(animal)}</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {selectedIndices.size === 0 && rows.length > 1 ? (
              /* "All" mode — show one averaged section */
              <React.Fragment>
                <tr className="bg-blue-50">
                  <td colSpan={animals.length + 1} className="px-3 py-1.5 text-xs font-semibold text-wpBlue">
                    All areas (average)
                  </td>
                </tr>
                {suffixOrder.map((suffix) => (
                  <tr key={suffix} className="hover:bg-gray-50 border-t border-gray-100">
                    <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap sticky left-0 bg-white z-10">
                      {suffixLabels[suffix] || suffix}
                    </td>
                    {animals.map((animal) => {
                      const col = colMap.get(animal)?.get(suffix);
                      const hasSumWarn = avgSumErrors.has(`_${animal}`);
                      if (!col) return <td key={animal} className="px-2 py-1.5 text-center text-gray-300">—</td>;
                      return (
                        <td key={animal} className={`px-1 py-1 ${hasSumWarn ? 'bg-amber-50' : ''}`}>
                          <StepperInput
                            value={String(avgRow[col] ?? 0)}
                            onChange={(v) => handleCellChange(-1, col, v)}
                            step={0.001} min={0} max={1} percent={true}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ) : (
              rows.map((row, ri) => {
                if (selectedIndices.size > 0 && !selectedIndices.has(ri)) return null;
                return (
                  <React.Fragment key={ri}>
                    {rows.length > 1 && (
                      <tr className="bg-blue-50">
                        <td colSpan={animals.length + 1} className="px-3 py-1.5 text-xs font-semibold text-wpBlue">
                          {row.area_name || row.iso || row.gid}
                        </td>
                      </tr>
                    )}
                    {suffixOrder.map((suffix) => (
                      <tr key={suffix} className="hover:bg-gray-50 border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap sticky left-0 bg-white z-10">
                          {suffixLabels[suffix] || suffix}
                        </td>
                        {animals.map((animal) => {
                          const col = colMap.get(animal)?.get(suffix);
                          const hasSumWarn = sumErrors.has(`${ri}_${animal}`);
                          if (!col) return <td key={animal} className="px-2 py-1.5 text-center text-gray-300">—</td>;
                          return (
                            <td key={animal} className={`px-1 py-1 ${hasSumWarn ? 'bg-amber-50' : ''}`}>
                              <StepperInput
                                value={row[col]}
                                onChange={(v) => handleCellChange(ri, col, v)}
                                step={0.001} min={0} max={1} percent={true}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <RawDataView rows={rows} fieldnames={rawFieldnames} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnimalIntensiveSlider — single row showing intensive/extensive split for one animal
// ---------------------------------------------------------------------------
function AnimalIntensiveSlider({ animal, intensiveFrac, onChange }) {
  const icon = ICONS[animal] || LivestockEmissionsIcon;
  const pctInt = (intensiveFrac * 100).toFixed(1);
  const pctExt = ((1 - intensiveFrac) * 100).toFixed(1);

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-1.5 w-28 shrink-0">
        <img src={icon} alt={animal} className="w-4 h-4" />
        <span className="text-xs font-semibold text-wpBlue capitalize">{animalLabel(animal)}</span>
      </div>
      <span className="text-xs text-gray-400 w-20 text-right shrink-0">{pctExt}% Ext.</span>
      <input
        type="range" min={0} max={1} step={0.001}
        value={intensiveFrac}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1" style={{ accentColor: '#0B4159' }}
      />
      <span className="text-xs text-gray-400 w-20 shrink-0">{pctInt}% Int.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProductionSystemsEditor — slider-based intensive/extensive split editor
// ---------------------------------------------------------------------------
function ProductionSystemsEditor({ scenario, onDirtyChange, onSaved, animalsWithHeads }) {
  const filename = 'production_systems.csv';
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [fieldnames, setFieldnames] = useState([]);
  const [rawFieldnames, setRawFieldnames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const savedRowsRef = useRef([]);
  const onDirtyChangeRef = useRef(onDirtyChange);

  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const [csvRes, isoRes] = await Promise.all([
        axios.get(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`),
        axios.get(`/api/scenarios/${scenario.id}/isodata`).catch(() => ({ data: { data: [] } })),
      ]);
      const areaMap = {};
      (isoRes?.data?.data || []).forEach((r) => {
        const key = asText(r.iso || r.gid);
        if (key) areaMap[key] = r.subarea || r.NAME_3 || r.NAME_2 || r.NAME_1 || r.NAME_0 || key;
      });
      const allFields = csvRes.data?.fieldnames || [];
      const nextRows = (csvRes.data?.data || []).map((row) => {
        const out = {};
        allFields.forEach((f) => { out[f] = asText(row[f]); });
        const areaKey = asText(row.iso || row.gid);
        out.area_name = areaMap[areaKey] || row.subarea || row.gid || row.iso || areaKey;
        return out;
      });
      const editFields = allFields.filter((f) => !['iso', 'gid', 'subarea'].includes(f));
      savedRowsRef.current = nextRows;
      setRows(nextRows);
      setFieldnames(editFields);
      setRawFieldnames(allFields);
      onDirtyChangeRef.current?.(false);
      setStatus('done');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStatus('error');
    }
  }, [scenario.id]);

  useEffect(() => { load(); }, [load]);

  const isDirty = useMemo(() => !rowsEqual(rows, savedRowsRef.current), [rows]);
  useEffect(() => { onDirtyChangeRef.current?.(isDirty); }, [isDirty]);

  // Parse animal_i / animal_e column pairs
  const { animals, colMap } = useMemo(() => {
    const animalMap = new Map();
    fieldnames.filter((f) => f !== 'area_name').forEach((f) => {
      if (f.endsWith('_i')) {
        const animal = f.slice(0, -2);
        if (!animalMap.has(animal)) animalMap.set(animal, {});
        animalMap.get(animal).i = f;
      } else if (f.endsWith('_e')) {
        const animal = f.slice(0, -2);
        if (!animalMap.has(animal)) animalMap.set(animal, {});
        animalMap.get(animal).e = f;
      }
    });
    const visibleAnimals = (animalsWithHeads
      ? [...animalMap.keys()].filter(a => animalsWithHeads.has(a))
      : [...animalMap.keys()]
    ).filter(a => !EXCLUDED_BY_DEFAULT.has(a));
    return { animals: visibleAnimals, colMap: animalMap };
  }, [fieldnames, animalsWithHeads]);

  const validationErrors = useMemo(() => {
    const errs = [];
    rows.forEach((row, ri) => {
      const area = row.area_name || row.iso || row.gid || `Row ${ri + 1}`;
      animals.forEach((animal) => {
        const { i: iCol, e: eCol } = colMap.get(animal) || {};
        if (iCol && row[iCol] !== '' && !isValidNumber(row[iCol])) {
          errs.push(`${area} / ${animalLabel(animal)}: invalid intensive value`);
        }
        if (eCol && row[eCol] !== '' && !isValidNumber(row[eCol])) {
          errs.push(`${area} / ${animalLabel(animal)}: invalid extensive value`);
        }
      });
    });
    return errs;
  }, [rows, animals, colMap]);

  // Average intensive fraction per animal (for "All" mode)
  const avgFracs = useMemo(() => {
    if (rows.length <= 1) return {};
    const result = {};
    animals.forEach((animal) => {
      const { i: iCol } = colMap.get(animal) || {};
      if (!iCol) return;
      const vals = rows.map((r) => parseFloat(r[iCol])).filter((v) => !isNaN(v));
      result[animal] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    return result;
  }, [rows, animals, colMap]);

  const handleSliderChange = useCallback((rowIdx, animal, newIntensiveFrac) => {
    const { i: iCol, e: eCol } = colMap.get(animal) || {};
    if (!iCol || !eCol) return;
    const iVal = String(Math.round(newIntensiveFrac * 1e6) / 1e6);
    const eVal = String(Math.round((1 - newIntensiveFrac) * 1e6) / 1e6);
    if (rowIdx === -1) {
      // "All" mode: set absolute value for every row
      setRows((prev) => prev.map((r) => ({ ...r, [iCol]: iVal, [eCol]: eVal })));
    } else {
      setRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, [iCol]: iVal, [eCol]: eVal } : r));
    }
  }, [colMap]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const payloadRows = rows.map((r) => { const o = { ...r }; delete o.area_name; return o; });
      await axios.put(`/api/scenarios/${scenario.id}/livestock-csv/${filename}`, {
        rows: payloadRows,
        fieldnames: csvFieldnamesForSave(rows, fieldnames),
      });
      savedRowsRef.current = rows.map((r) => ({ ...r }));
      onDirtyChangeRef.current?.(false);
      onSaved?.();
    } catch (e) {
      alert(`Failed to save: ` + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setRows(savedRowsRef.current.map((r) => ({ ...r })));
    onDirtyChangeRef.current?.(false);
  };

  if (status === 'loading') return <LoadingState label={filename} />;
  if (status === 'error') return <ErrorState label={filename} error={error} />;

  const visibleIndices = selectedIndices.size === 0 ? rows.map((_, i) => i) : [...selectedIndices];

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <SaveResetBar
        title="Production Systems"
        hint="Share of animals in intensive vs. extensive systems"
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onReset={handleReset}
        validationErrors={validationErrors}
        rightSlot={null}
      />
      {rows.length > 1 && (
        <div className="px-3 py-2 border-b border-gray-100">
          <AreaSelector labels={rows.map((r, i) => r.area_name || r.iso || r.gid || `Area ${i + 1}`)} selectedIndices={selectedIndices} onChange={setSelectedIndices} />
        </div>
      )}
      <div className="p-4 space-y-6">
        {selectedIndices.size === 0 && rows.length > 1 ? (
          /* "All" mode — show averaged sliders; editing sets absolute value to all rows */
          <div>
            <p className="text-xs font-semibold text-wpBlue mb-3">All areas (average)</p>
            <div>
              {animals.map((animal) => {
                const { i: iCol } = colMap.get(animal) || {};
                if (!iCol) return null;
                return (
                  <AnimalIntensiveSlider
                    key={animal}
                    animal={animal}
                    intensiveFrac={avgFracs[animal] ?? 0}
                    onChange={(v) => handleSliderChange(-1, animal, v)}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          visibleIndices.map((ri) => {
            const row = rows[ri];
            return (
              <div key={ri}>
                {rows.length > 1 && (
                  <p className="text-xs font-semibold text-wpBlue mb-3">
                    {row.area_name || row.iso || row.gid || `Area ${ri + 1}`}
                  </p>
                )}
                <div>
                  {animals.map((animal) => {
                    const { i: iCol } = colMap.get(animal) || {};
                    if (!iCol) return null;
                    const intensiveFrac = parseFloat(row[iCol]) || 0;
                    return (
                      <AnimalIntensiveSlider
                        key={animal}
                        animal={animal}
                        intensiveFrac={intensiveFrac}
                        onChange={(v) => handleSliderChange(ri, animal, v)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
      <RawDataView rows={rows} fieldnames={rawFieldnames} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LivestockEditorPanel — main export
// ---------------------------------------------------------------------------
export default function LivestockEditorPanel({ scenario, subcategoryId, onDirtyChange, onSaved }) {
  // Fetch once to know which animals have heads > 0 (used by manure / production-systems tabs).
  const [animalsWithHeads, setAnimalsWithHeads] = useState(null);
  // Live head counts forwarded from LivestockPopulationEditor (includes unsaved edits).
  const [headCounts, setHeadCounts] = useState(null);

  useEffect(() => {
    axios.get(`/api/scenarios/${scenario.id}/livestock-heads-by-area`)
      .then((r) => {
        const list = r.data?.animals;
        setAnimalsWithHeads(list?.length ? new Set(list) : null);
      })
      .catch(() => setAnimalsWithHeads(null));
  }, [scenario.id]);

  // Effective set = API-sourced × user-edited head counts (hide zero-count animals live).
  const effectiveAnimalsWithHeads = useMemo(() => {
    if (headCounts && Object.keys(headCounts).length > 0) {
      const nonZero = new Set(
        Object.keys(headCounts).filter((a) => Math.round(headCounts[a] || 0) > 0)
      );
      if (animalsWithHeads) {
        return new Set([...animalsWithHeads].filter((a) => nonZero.has(a)));
      }
      return nonZero;
    }
    return animalsWithHeads;
  }, [animalsWithHeads, headCounts]);

  if (subcategoryId === 'livestock-population') {
    return (
      <LivestockPopulationEditor
        scenario={scenario}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
        onHeadCountsChange={setHeadCounts}
      />
    );
  }

  if (subcategoryId === 'manure-management') {
    return (
      <div className="space-y-4">
        <ManureManagementEditor
          scenario={scenario}
          onDirtyChange={onDirtyChange}
          onSaved={onSaved}
          animalsWithHeads={effectiveAnimalsWithHeads}
        />
        <GroupedCsvEditor
          scenario={scenario}
          filename="manure_fractions.csv"
          title="Manure by land type and system"
          hint="Fraction of manure by land type (grazing/other) × system (intensive/extensive)"
          suffixLabels={MANURE_FRAC_LABELS}
          checkSum={false}
          onDirtyChange={onDirtyChange}
          onSaved={onSaved}
          animalsWithHeads={effectiveAnimalsWithHeads}
        />
      </div>
    );
  }

  if (subcategoryId === 'production-systems') {
    return (
      <ProductionSystemsEditor
        scenario={scenario}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
        animalsWithHeads={effectiveAnimalsWithHeads}
      />
    );
  }

  return null;
}
