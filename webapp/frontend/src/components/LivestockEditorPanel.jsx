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
  prev_young: 'Prevalence young [%]',
  prev_adult: 'Prevalence adult [%]',
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
function StepperInput({ value, onChange, step = 1, min, max, percent = false, decimals }) {
  // `value` is always the raw stored value (0–1 for percent mode, absolute otherwise).
  // `percent`: display as (value×100).toFixed(1)%, accept typed input as %, store as fraction.
  // `decimals`: format the display value with this many decimal places (non-percent mode).
  // Empty string is treated as valid (absent/zero) — not highlighted red.
  const [raw, setRaw] = useState(asText(value));
  const [editText, setEditText] = useState(null); // null = not actively editing
  const valid = raw === '' || isValidNumber(raw);

  useEffect(() => {
    setRaw(asText(value));
    setEditText(null);
  }, [value]);

  const toDisplay = (r) => {
    if (r === '') return percent ? '0.0' : r;
    if (!isValidNumber(r)) return r;
    const n = parseFloat(r);
    if (percent) return (n * 100).toFixed(1);
    if (decimals != null) return n.toFixed(decimals);
    return r;
  };

  const displayVal = editText !== null ? editText : toDisplay(raw);

  const commitFromDisplay = (text) => {
    setEditText(null);
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
    // else: invalid text → revert (editText cleared above)
  };

  const nudge = (delta) => {
    setEditText(null);
    const base = raw === '' ? 0 : parseFloat(raw);
    const next = isNaN(base) ? 0 : Math.round((base + delta) * 1e9) / 1e9;
    let clamped = next;
    if (min != null) clamped = Math.max(min, clamped);
    if (max != null) clamped = Math.min(max, clamped);
    const s = String(clamped);
    setRaw(s);
    onChange(s);
  };

  return (
    <div className={`flex items-center rounded border text-xs ${valid ? 'border-gray-200' : 'border-red-400'}`}>
      <button type="button" onClick={() => nudge(-step)}
        className="px-1.5 py-1 text-gray-400 hover:text-wpBlue hover:bg-gray-50 rounded-l select-none" tabIndex={-1}>−</button>
      <input
        value={displayVal}
        onChange={(e) => setEditText(e.target.value)}
        onBlur={(e) => commitFromDisplay(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitFromDisplay(e.target.value);
          if (e.key === 'Escape') setEditText(null);
        }}
        className={`w-14 px-1 py-1 text-center bg-transparent outline-none ${valid ? 'text-gray-800' : 'text-red-500'}`}
      />
      {percent && <span className="pr-1 text-gray-400 select-none">%</span>}
      <button type="button" onClick={() => nudge(+step)}
        className="px-1.5 py-1 text-gray-400 hover:text-wpBlue hover:bg-gray-50 rounded-r select-none" tabIndex={-1}>+</button>
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
  const { scenarios, tempScenarios } = useScenarioStore();
  const allScenarios = useMemo(
    () => [...scenarios, ...tempScenarios].filter((s) => !s.isTemp),
    [scenarios, tempScenarios],
  );

  const [selectedScenarioId, setSelectedScenarioId] = useState(activeScenario.id);
  const [selectedAreaIndices, setSelectedAreaIndices] = useState(new Set());
  const [headsData, setHeadsData] = useState({
    status: 'loading', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {},
  });

  useEffect(() => {
    setHeadsData({ status: 'loading', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} });
    setSelectedAreaIndices(new Set());
    axios.get(`/api/scenarios/${selectedScenarioId}/livestock-heads-by-area`)
      .then((res) => {
        if (res.data && !res.data.error) {
          setHeadsData({
            status: 'done',
            error: '',
            areas: res.data.areas || [],
            animals: res.data.animals || [],
            byArea: res.data.by_area || {},
            totalsByAnimal: res.data.totals_by_animal || {},
          });
        } else {
          setHeadsData({ status: 'unavailable', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} });
        }
      })
      .catch(() => setHeadsData({ status: 'unavailable', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} }));
  }, [selectedScenarioId]);

  const selectedAreaIsos = useMemo(() => {
    const areas = headsData.areas || [];
    if (!areas.length) return [];
    if (selectedAreaIndices.size === 0) return areas.map((a) => String(a.iso));
    return [...selectedAreaIndices].sort((a, b) => a - b).map((idx) => areas[idx]).filter(Boolean).map((a) => String(a.iso));
  }, [headsData.areas, selectedAreaIndices]);

  const selectedHeadsByAnimal = useMemo(() => {
    if (headsData.status !== 'done') return {};
    const byAnimal = {};
    selectedAreaIsos.forEach((iso) => {
      const row = headsData.byArea?.[iso] || {};
      Object.entries(row).forEach(([animal, value]) => {
        const n = Number(value);
        if (!isFinite(n)) return;
        byAnimal[animal] = (byAnimal[animal] || 0) + n;
      });
    });
    return byAnimal;
  }, [headsData.status, headsData.byArea, selectedAreaIsos]);

  const headRows = useMemo(() => {
    return (headsData.animals || [])
      .map((animal) => ({ animal, heads: selectedHeadsByAnimal[animal] || 0 }))
      .filter((r) => r.heads > 0)
      .sort((a, b) => b.heads - a.heads);
  }, [headsData.animals, selectedHeadsByAnimal]);

  const totalHeads = useMemo(() => headRows.reduce((sum, r) => sum + r.heads, 0), [headRows]);

  return (
    <>
      {allScenarios.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <label className="text-xs font-semibold text-gray-700 shrink-0">Scenario:</label>
          <select
            value={selectedScenarioId}
            onChange={(e) => setSelectedScenarioId(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-xs flex-1 min-w-0"
          >
            {allScenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.id === activeScenario.id ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {headsData.status === 'loading' ? (
        <LoadingState label="heads data" />
      ) : headsData.status === 'unavailable' ? (
        <p className="text-sm text-gray-500">No heads raster data available for this scenario.</p>
      ) : (
        <div className="flex flex-col md:flex-row gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <span className="text-xs text-gray-500">
                {selectedAreaIndices.size === 0
                  ? `All ${headsData.areas.length} area${headsData.areas.length !== 1 ? 's' : ''}`
                  : `${selectedAreaIndices.size} selected area${selectedAreaIndices.size !== 1 ? 's' : ''}`}
              </span>
            </div>
            {headsData.areas.length > 1 && (
              <AreaSelector
                labels={headsData.areas.map((a, i) => a.label || `Area ${i + 1}`)}
                selectedIndices={selectedAreaIndices}
                onChange={setSelectedAreaIndices}
              />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <div className="bg-white border border-gray-200 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Total heads</p>
                <p className="text-xl font-semibold text-wpBlue">{fmtInt(totalHeads)}</p>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Available species</p>
                <p className="text-xl font-semibold text-wpBlue">{headRows.length}</p>
              </div>
            </div>
            {headRows.length > 0 ? (
              <div className="overflow-auto max-h-56 bg-white rounded-lg border border-gray-200 mt-2">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Animal</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">Heads</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {headRows.map((r) => (
                      <tr key={r.animal}>
                        <td className="px-3 py-1.5 text-gray-700">{animalLabel(r.animal)}</td>
                        <td className="px-3 py-1.5 text-right text-gray-800 tabular-nums">{fmtInt(r.heads)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-gray-500 mt-2">No head counts found for the selected area set.</p>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <AnimalHeadsMap
              scenarioId={selectedScenarioId}
              animals={headsData.animals}
            />
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// LivestockPopulationEditor
// Rows = animals, columns = isodata fields (frac_young, prev_*, excr_*, mass_*, manure_per_mass)
// ---------------------------------------------------------------------------
function LivestockPopulationEditor({ scenario, onDirtyChange, onSaved }) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
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
        setHeadsSummary({
          status: 'done',
          error: '',
          areas: headsRes.data.areas || [],
          animals: headsRes.data.animals || [],
          byArea: headsRes.data.by_area || {},
          totalsByAnimal: headsRes.data.totals_by_animal || {},
        });
      } else {
        setHeadsSummary({ status: 'unavailable', error: '', areas: [], animals: [], byArea: {}, totalsByAnimal: {} });
      }

      const allFields = r.data?.fieldnames || [];
      // `animal` is injected by the backend separately — not in fieldnames
      const nextRows = (r.data?.data || []).map((row) => {
        const out = { animal: row.animal };
        allFields.forEach((f) => { out[f] = asText(row[f]); });
        return out;
      });
      // editable columns: exclude identifier columns
      const editFields = allFields.filter((f) => !['iso', 'gid', 'subarea', 'animal'].includes(f));
      savedRowsRef.current = nextRows;
      setRows(nextRows);
      setFieldnames(editFields);
      setRawFieldnames(['animal', ...allFields]);
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

  // Step sizes per field
  const stepFor = (f) => {
    if (f === 'frac_young') return 0.001;              // 0.1 pp in raw fraction units
    if (['prev_young', 'prev_adult'].includes(f)) return 0.1;
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
      fieldnames.forEach((f) => {
        const isNA = (isPoultry && NON_POULTRY_FIELDS.has(f)) || (!isPoultry && POULTRY_ONLY_FIELDS.has(f));
        if (isNA) return;
        const v = row[f];
        if (v !== '' && !isValidNumber(v)) {
          errs.push(`${row.animal || '?'}: invalid value in "${LIVESTOCK_POP_LABELS[f] || f}"`);
        }
      });
    });
    return errs;
  }, [rows, fieldnames]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await axios.put(`/api/scenarios/${scenario.id}/livestock-population`, { rows });
      savedRowsRef.current = rows.map((r) => ({ ...r }));
      onDirtyChangeRef.current?.(false);
      onSaved?.();
    } catch (e) {
      alert('Failed to save: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setRows(savedRowsRef.current.map((r) => ({ ...r })));
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
    return result.filter(row => !EXCLUDED_BY_DEFAULT.has(row.animal));
  }, [rows, headsAnimalSet]);

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
                    View summary data
                  </button>
                </DialogTrigger>
                <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Animal heads summary (from heads rasters)</DialogTitle>
                  </DialogHeader>
                  <HeadsSummaryDialogContent activeScenario={scenario} />
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      />

      <div className="overflow-auto p-3">
        <table className="text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-500 tracking-wide text-xs">
              <th className="px-3 py-2 text-left font-medium sticky left-0 bg-gray-50 z-10 whitespace-nowrap">Animal</th>
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
                      <span className="capitalize font-medium text-gray-700">{row.animal}</span>
                    </div>
                  </td>
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
                          value={row[f]}
                          onChange={(v) => setRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, [f]: v } : r))}
                          step={stepFor(f)}
                          min={0}
                          max={f === 'frac_young' ? 1 : undefined}
                          percent={f === 'frac_young'}
                          decimals={['prev_young', 'prev_adult'].includes(f) ? 1 : undefined}
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
        title="Manure Management"
        hint="Shares per system per animal (%) — cells highlighted in amber have fractions that don't sum to 100% and will block saving"
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
        <span className="text-xs font-medium text-gray-700 capitalize">{animalLabel(animal)}</span>
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

  useEffect(() => {
    axios.get(`/api/scenarios/${scenario.id}/livestock-heads-by-area`)
      .then((r) => {
        const list = r.data?.animals;
        setAnimalsWithHeads(list?.length ? new Set(list) : null);
      })
      .catch(() => setAnimalsWithHeads(null));
  }, [scenario.id]);

  if (subcategoryId === 'livestock-population') {
    return (
      <LivestockPopulationEditor
        scenario={scenario}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
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
          animalsWithHeads={animalsWithHeads}
        />
        <GroupedCsvEditor
          scenario={scenario}
          filename="manure_fractions.csv"
          title="Manure Fractions"
          hint="Fraction of manure by land type (grazing/other) × system (intensive/extensive)"
          suffixLabels={MANURE_FRAC_LABELS}
          checkSum={false}
          onDirtyChange={onDirtyChange}
          onSaved={onSaved}
          animalsWithHeads={animalsWithHeads}
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
        animalsWithHeads={animalsWithHeads}
      />
    );
  }

  return null;
}
