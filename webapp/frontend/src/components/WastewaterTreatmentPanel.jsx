import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
import { Plus, Save, RotateCcw, Trash2, TableProperties, ChevronUp, ChevronDown } from 'lucide-react';
import axios from 'axios';
import { adjustSlider } from './SanitationPanel';
import DataGridView from './DataGridView';
import useConfigStore from '../store/configStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const FRACTION_FIELDS = [
  'FractionPrimarytreatment',
  'FractionSecondarytreatment',
  'FractionTertiarytreatment',
];

const FRACTION_LABELS = ['Primary treatment', 'Secondary treatment', 'Tertiary treatment'];

const TREATMENT_TYPES = ['Primary', 'Secondary', 'Tertiary'];

const TYPE_COLORS = {
  Primary:   '#FFE597',  // wpBrown-500
  Secondary: '#9AE0A5',  // wpGreen-900
  Tertiary:  '#62B27D',  // wpGreen-800
};

// Ordered to match FRACTION_FIELDS / FRACTION_LABELS
const FRACTION_COLORS = [
  TYPE_COLORS.Primary,
  TYPE_COLORS.Secondary,
  TYPE_COLORS.Tertiary,
];

const MAP_W = 500;
const MAP_H = 380;

// ─── Geo helpers ──────────────────────────────────────────────────────────────

function getBbox(geodata) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function walk(c) {
    if (!c) return;
    if (typeof c[0] === 'number') {
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    } else {
      c.forEach(walk);
    }
  }
  (geodata?.features ?? []).forEach(f => walk(f.geometry?.coordinates));
  if (!isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

function computeProjConfig(geodata) {
  const bb = getBbox(geodata);
  if (!bb) return null; // signal "no geodata"
  const [minLon, minLat, maxLon, maxLat] = bb;
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const lonSpan = Math.max(maxLon - minLon, 0.01);
  const latSpan = Math.max(maxLat - minLat, 0.01);
  const scaleX = (MAP_W * 180) / (lonSpan * Math.PI);
  const scaleY = (MAP_H * 180) / (latSpan * Math.PI);
  // Use a low scale factor so the shapefile sits in a wide contextual area
  return { center, scale: Math.min(scaleX, scaleY) * 0.8 };
}

// Fallback: compute projConfig from the WWTP marker coordinates themselves
function computeProjConfigFromMarkers(markers) {
  if (!markers.length) return { center: [0, 0], scale: 200 };
  const lons = markers.map(r => parseFloat(r.lon));
  const lats = markers.map(r => parseFloat(r.lat));
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const pad = 0.05; // add 5% padding around markers
  const lonSpan = Math.max(maxLon - minLon, 0.01) * (1 + pad * 2);
  const latSpan = Math.max(maxLat - minLat, 0.01) * (1 + pad * 2);
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const scaleX = (MAP_W * 180) / (lonSpan * Math.PI);
  const scaleY = (MAP_H * 180) / (latSpan * Math.PI);
  return { center, scale: Math.min(scaleX, scaleY) * 0.8 };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const FractionSlider = ({ label, value, onChange, color }) => {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(Math.min(100, Math.max(0, n)) / 100);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 w-44 flex-shrink-0">
        <span className="text-xs text-gray-600">{label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-thumb cursor-pointer"
        style={{ '--thumb-color': color, '--fill-pct': `${(value * 100).toFixed(2)}%` }}
      />
      {editing ? (
        <input
          type="number"
          min={0} max={100} step={0.1}
          value={inputVal}
          autoFocus
          onChange={e => setInputVal(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit(e.target.value);
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-16 text-right text-xs border border-wpBlue-300 rounded px-1 py-0.5"
        />
      ) : (
        <span
          className="w-16 text-right text-xs tabular-nums font-medium cursor-text hover:bg-gray-100 rounded px-1 py-0.5"
          style={{ color }}
          title="Click to type a value"
          onClick={() => { setInputVal((value * 100).toFixed(1)); setEditing(true); }}
        >
          {(value * 100).toFixed(1)} %
        </span>
      )}
    </div>
  );
};

// ─── Inner panel (receives already-loaded data) ───────────────────────────────

const WastewaterTreatmentPanelInner = ({ scenario, initialWwtp, initialFractions, isoRows = [], isoFieldnames = [], onDirtyChange }) => {
  const { pathogens } = useConfigStore();

  // Derive the isodata column for the scenario's selected pathogen type.
  // e.g. scenario.pathogen="rotavirusss" → pathogen_type="Virus" → "fEmitted_inEffluent_after_treatment_virus"
  const emittedField = useMemo(() => {
    if (!scenario.pathogen || !pathogens.length) return null;
    const match = pathogens.find(
      p => p.name.toLowerCase() === scenario.pathogen.toLowerCase()
    );
    if (!match?.pathogen_type) return null;
    return `fEmitted_inEffluent_after_treatment_${match.pathogen_type.toLowerCase()}`;
  }, [scenario.pathogen, pathogens]);

  const initialMode = initialWwtp.length > 0 ? 'facilities' : 'fractions';
  const [mode, setMode] = useState(initialMode);
  const [wwtp, setWwtp] = useState(initialWwtp);
  const [fractions, setFractions] = useState(initialFractions);
  const [geodata, setGeodata] = useState(null);
  const [projConfig, setProjConfig] = useState({ center: [0, 0], scale: 200 });
  const [geoLoading, setGeoLoading] = useState(true);
  const [geoError, setGeoError] = useState(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showRawData, setShowRawData] = useState(false);

  const savedWwtpRef = useRef(initialWwtp);
  const savedFractionsRef = useRef(initialFractions);
  const savedModeRef = useRef(initialMode);

  // Fetch geodata on mount; projConfig falls back to WWTP coords if geodata is unavailable
  useEffect(() => {
    axios.get(`/api/scenarios/${scenario.id}/geodata`)
      .then(r => {
        setGeodata(r.data);
        const cfg = computeProjConfig(r.data);
        // cfg is null when geodata has no features — fall back to WWTP coords
        setProjConfig(cfg ?? computeProjConfigFromMarkers(initialWwtp));
      })
      .catch(e => {
        setGeoError(e.response?.data?.error || e.message);
        // Still compute a sensible projConfig from WWTP coord
        setProjConfig(computeProjConfigFromMarkers(initialWwtp));
      })
      .finally(() => setGeoLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id]);

  const markDirty = useCallback((newWwtp, newFractions, newMode) => {
    const dirty =
      newMode !== savedModeRef.current ||
      JSON.stringify(newWwtp) !== JSON.stringify(savedWwtpRef.current) ||
      JSON.stringify(newFractions) !== JSON.stringify(savedFractionsRef.current);
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  const handleModeSwitch = (newMode) => {
    setMode(newMode);
    markDirty(wwtp, fractions, newMode);
  };

  const handleFractionChange = (idx, val) => {
    const next = fractions.map((v, i) => i === idx ? Math.round(val * 1000) / 1000 : v);
    setFractions(next);
    markDirty(wwtp, next, mode);
  };

  const handleWwtpChange = (rowIdx, field, value) => {
    const next = wwtp.map((r, i) => i === rowIdx ? { ...r, [field]: value } : r);
    setWwtp(next);
    markDirty(next, fractions, mode);
  };

  const handleAddRow = () => {
    const next = [...wwtp, { lon: '', lat: '', capacity: '', treatment_type: 'Primary' }];
    setWwtp(next);
    markDirty(next, fractions, mode);
  };

  const handleDeleteRow = (idx) => {
    const next = wwtp.filter((_, i) => i !== idx);
    setWwtp(next);
    markDirty(next, fractions, mode);
  };

  const handleReset = () => {
    setMode(savedModeRef.current);
    setWwtp(savedWwtpRef.current);
    setFractions(savedFractionsRef.current);
    setIsDirty(false);
    onDirtyChange?.(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // ── Compute fEmitted constants (match prepare.R / _r_iso_csv_to_rds_snippet) ──
      // fEmitted = Fraction_type * (liquid  -  liquid * removal)
      // Primary:   virus  0.97*(1-0.75)=0.2425   protozoa 0.85*(1-0.50)=0.425
      // Secondary: virus  0.50*(1-0.95)=0.025    protozoa 0.20*(1-0.90)=0.02
      // Tertiary:  virus  0.40*(1-0.99)=0.004    protozoa 0.25*(1-0.92)=0.02
      let FP, FS, FT;
      if (mode === 'fractions') {
        [FP, FS, FT] = fractions;
      } else {
        // Capacity-weighted effective fractions from WWTP point facilities
        const totalCap = wwtp.reduce((a, r) => a + (parseFloat(r.capacity) || 0), 0);
        FP = 0; FS = 0; FT = 0;
        if (totalCap > 0) {
          wwtp.forEach(r => {
            const c = (parseFloat(r.capacity) || 0) / totalCap;
            if (r.treatment_type === 'Primary')        FP += c;
            else if (r.treatment_type === 'Secondary') FS += c;
            else if (r.treatment_type === 'Tertiary')  FT += c;
          });
        } else {
          FP = 1; // default: all primary
        }
      }
      const fEmittedVirus    = FP * 0.2425 + FS * 0.025 + FT * 0.004;
      const fEmittedProtozoa = FP * 0.425  + FS * 0.02  + FT * 0.02;
      const fEmittedFields = {
        fEmitted_inEffluent_after_treatment_virus:    parseFloat(fEmittedVirus.toFixed(6)),
        fEmitted_inEffluent_after_treatment_protozoa: parseFloat(fEmittedProtozoa.toFixed(6)),
      };

      if (mode === 'fractions') {
        // Save fraction sliders + fEmitted → isodata.csv; clear treatment.csv
        const fractionPayload = {
          ...Object.fromEntries(FRACTION_FIELDS.map((key, i) => [key, fractions[i]])),
          ...fEmittedFields,
        };
        await axios.put(`/api/scenarios/${scenario.id}/treatment-fractions`, { fractions: fractionPayload });
        await axios.put(`/api/scenarios/${scenario.id}/treatment`, { rows: [] });
      } else {
        // Save WWTP facilities → treatment.csv; zero fraction columns but store fEmitted
        await axios.put(`/api/scenarios/${scenario.id}/treatment`, { rows: wwtp });
        const zeroPayload = {
          ...Object.fromEntries(FRACTION_FIELDS.map(k => [k, 0])),
          ...fEmittedFields,
        };
        await axios.put(`/api/scenarios/${scenario.id}/treatment-fractions`, { fractions: zeroPayload });
      }
      savedModeRef.current = mode;
      savedWwtpRef.current = wwtp;
      savedFractionsRef.current = fractions;
      setIsDirty(false);
      onDirtyChange?.(false);
    } catch (e) {
      alert('Failed to save: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsSaving(false);
    }
  };

  // Only markers with valid numeric coordinates
  const validMarkers = useMemo(
    () => wwtp.filter(r => r.lon !== '' && r.lat !== '' && !isNaN(parseFloat(r.lon)) && !isNaN(parseFloat(r.lat))),
    [wwtp]
  );

  const fractionSum = fractions.reduce((a, b) => a + b, 0);
  const canSave = true;

  // ── Raw data view ────────────────────────────────────────────────────────────
  const subareaKey = useMemo(
    () => isoFieldnames.includes('subarea') ? 'subarea' : null,
    [isoFieldnames]
  );

  const rawFieldnames = useMemo(() => {
    if (mode === 'fractions') {
      return [...(subareaKey ? [subareaKey] : []), ...FRACTION_FIELDS];
    }
    return ['lon', 'lat', 'capacity', 'treatment_type'];
  }, [mode, subareaKey]);

  const rawData = useMemo(() => {
    if (mode === 'fractions') {
      return isoRows.map(row => {
        const out = {};
        if (subareaKey) out[subareaKey] = row[subareaKey] ?? '';
        FRACTION_FIELDS.forEach((field, i) => { out[field] = fractions[i]; });
        return out;
      });
    }
    return wwtp.map(row => ({
      lon:            row.lon,
      lat:            row.lat,
      capacity:       row.capacity,
      treatment_type: row.treatment_type,
    }));
  }, [mode, isoRows, fractions, subareaKey, wwtp]);

  return (
    <div className="space-y-5">

      {/* Mode toggle + Save/Reset */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-wpBlue">I have data on:</span>
        <div className="flex gap-0.5 p-0.5 bg-gray-200 rounded-lg">
          {[{id:'fractions',label:'Treatment fractions'},{id:'facilities',label:'WWTP locations'}].map(opt => (
            <button
              key={opt.id}
              onClick={() => handleModeSwitch(opt.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                mode === opt.id ? 'bg-white shadow-sm text-wpBlue' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Treatment Efficiency Fractions */}
      {mode === 'fractions' && (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <h4 className="text-sm font-semibold text-wpBlue">Treatment Efficiency Fractions</h4>
          {isDirty && <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" title="Unsaved changes" />}
          <span className="ml-auto text-xs font-mono text-gray-400 px-1.5 py-0.5">
            Σ = {(fractionSum * 100).toFixed(1)}%
          </span>
          {isDirty && (
            <>
              <button onClick={handleReset} className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded transition-colors">
                <RotateCcw size={12} /> Reset
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-wpGreen hover:bg-wpGreen-600 rounded transition-colors disabled:opacity-50"
              >
                <Save size={12} /> {isSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
        <div className="px-5 py-4 space-y-3">
          {FRACTION_LABELS.map((label, i) => (
            <FractionSlider key={i} label={label} value={fractions[i]} color={FRACTION_COLORS[i]} onChange={val => handleFractionChange(i, val)} />
          ))}

        </div>
      </div>
      )}

      {/* Map + Table */}
      {mode === 'facilities' && (
      <div className="grid grid-cols-2 gap-5">

        {/* Map */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <h4 className="text-sm font-semibold text-wpBlue">Facility locations</h4>
            <span className="text-xs text-gray-400 ml-1">({validMarkers.length} plotted)</span>
          </div>

          <div className="bg-gray-50 relative flex-shrink-0" style={{ height: MAP_H }}>
            {geoLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-wpBlue" />
              </div>
            ) : (
              <>
                {geoError && (
                  <p className="absolute top-2 left-0 right-0 text-center text-xs text-amber-500 px-2 z-10">
                    Case study boundary unavailable — showing marker positions only
                  </p>
                )}
                <ComposableMap
                  projection="geoMercator"
                  width={MAP_W}
                  height={MAP_H}
                  projectionConfig={projConfig}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                >
                  {/* Plain background — world atlas is useless at city scale */}
                  <rect x={0} y={0} width={MAP_W} height={MAP_H} fill="#dde8f0" />
                  {geodata && geodata.features?.length > 0 && (
                    <Geographies geography={geodata}>
                      {({ geographies }) =>
                        geographies.map(geo => {
                          const label =
                            geo.properties?.subarea ??
                            geo.properties?.Area ??
                            geo.properties?.NAME ??
                            geo.properties?.name ??
                            Object.values(geo.properties ?? {})[0] ??
                            '';
                          return (
                            <Geography
                              key={geo.rsmKey}
                              geography={geo}
                              fill="#d1fae5"
                              stroke="#6ee7b7"
                              strokeWidth={1}
                              style={{
                                default: { outline: 'none' },
                                hover:   { fill: '#a7f3d0', outline: 'none' },
                                pressed: { outline: 'none' },
                              }}
                            >
                              {label ? <title>{label}</title> : null}
                            </Geography>
                          );
                        })
                      }
                    </Geographies>
                  )}

                  {validMarkers.map((r, i) => (
                    <Marker key={i} coordinates={[parseFloat(r.lon), parseFloat(r.lat)]}>
                      <circle
                        r={7}
                        fill={TYPE_COLORS[r.treatment_type] || '#6b7280'}
                        stroke="white"
                        strokeWidth={1.5}
                      />
                    </Marker>
                  ))}
                </ComposableMap>
              </>
            )}
          </div>

          {/* Legend */}
          <div className="px-4 py-2 border-t border-gray-100 flex flex-wrap gap-4">
            {TREATMENT_TYPES.map(t => (
              <div key={t} className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: TYPE_COLORS[t] }} />
                <span className="text-xs text-gray-600">{t}</span>
              </div>
            ))}
          </div>
        </div>

        {/* WWTP Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <h4 className="text-sm font-semibold text-wpBlue">Wastewater Treatment Plants</h4>
            {isDirty && <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" title="Unsaved changes" />}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={handleAddRow}
                className="flex items-center gap-1 px-2 py-1 text-xs text-wpBlue border border-wpBlue-200 hover:bg-blue-50 rounded transition-colors"
              >
                <Plus size={12} /> Add WWTP
              </button>
              {isDirty && (
                <>
                  <button onClick={handleReset} className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded transition-colors">
                    <RotateCcw size={12} /> Reset
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-wpGreen hover:bg-wpGreen-600 rounded transition-colors disabled:opacity-50"
                  >
                    <Save size={12} /> {isSaving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
          </div>

          {wwtp.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 py-12 text-gray-400 gap-2">
              <span className="text-sm">No WWTPs defined</span>
              <span className="text-xs">Click "Add WWTP" to add a facility</span>
            </div>
          ) : (
            <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide sticky top-0">
                    <th className="px-3 py-2 text-left font-medium">Lon</th>
                    <th className="px-3 py-2 text-left font-medium">Lat</th>
                    <th className="px-3 py-2 text-left font-medium">Capacity</th>
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {wwtp.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50 transition-colors">
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="0.0001"
                          value={row.lon}
                          onChange={e => handleWwtpChange(i, 'lon', e.target.value)}
                          className="w-24 border border-gray-200 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-wpBlue-400"
                          placeholder="0.0000"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="0.0001"
                          value={row.lat}
                          onChange={e => handleWwtpChange(i, 'lat', e.target.value)}
                          className="w-24 border border-gray-200 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-wpBlue-400"
                          placeholder="0.0000"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={row.capacity}
                          onChange={e => handleWwtpChange(i, 'capacity', e.target.value)}
                          className="w-20 border border-gray-200 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-wpBlue-400"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={row.treatment_type}
                          onChange={e => handleWwtpChange(i, 'treatment_type', e.target.value)}
                          className="border border-gray-200 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-wpBlue-400 bg-white"
                        >
                          {TREATMENT_TYPES.map(t => (
                            <option key={t} value={t}>
                              {t.charAt(0).toUpperCase() + t.slice(1)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleDeleteRow(i)}
                          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Delete row"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-500 leading-relaxed">
            <strong className="text-gray-600">Note:</strong> WWTPs do not need to be located within the case
            study area boundaries. Facilities outside the region can still serve the selected subareas. Use
            the coordinates, capacity and treatment type fields above to specify each facility.
          </div>
        </div>
      </div>
      )}

      {/* Raw data view */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowRawData(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <TableProperties size={16} className="text-gray-400" />
            <span>Raw data ({rawFieldnames.length} column{rawFieldnames.length !== 1 ? 's' : ''}, {rawData.length} row{rawData.length !== 1 ? 's' : ''})</span>
          </div>
          {showRawData ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showRawData && (
          <div className="border-t border-gray-100 p-2 overflow-auto max-h-96">
            {rawData.length > 0
              ? <DataGridView data={rawData} fieldnames={rawFieldnames} readOnly />
              : <p className="text-xs text-gray-400 px-3 py-4 text-center">No data to display.</p>
            }
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Outer wrapper: fetches data then renders inner panel ─────────────────────

const WastewaterTreatmentPanel = ({ scenario, onDirtyChange }) => {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    Promise.all([
      axios.get(`/api/scenarios/${scenario.id}/treatment`),
      axios.get(`/api/scenarios/${scenario.id}/isodata`),
    ])
      .then(([treatRes, isoRes]) => {
        if (cancelled) return;

        // Detect whether treatment.csv is a fraction CSV (has FractionPrimarytreatment)
        // vs. a WWTP locations CSV (has lon/lat). A fraction CSV must NOT be treated
        // as WWTP facility rows — doing so would incorrectly enable 'facilities' mode.
        const treatFieldnames = treatRes.data.fieldnames ?? [];
        const isFractionsCsv = treatFieldnames.includes('FractionPrimarytreatment');

        const wwtp = isFractionsCsv
          ? []   // fractions CSV → no WWTP facilities → 'fractions' mode
          : (treatRes.data.data ?? []).map(r => ({
              lon:            r.lon            ?? '',
              lat:            r.lat            ?? '',
              capacity:       r.capacity       ?? '',
              treatment_type: r.treatment_type || 'Primary',
            }));

        // Fractions: prefer isodata.csv (already migrated), then fall back to treatment.csv rows
        const firstRow = isoRes.data.data?.[0] ?? {};
        const isoFractions = FRACTION_FIELDS.map(k =>
          firstRow[k] !== undefined ? parseFloat(firstRow[k]) || 0 : 0
        );
        const isoSum = isoFractions.reduce((a, b) => a + b, 0);

        let normFractions;
        if (isoSum > 0.001) {
          normFractions = isoFractions.map(v => Math.round(v * 1000) / 1000);
        } else if (isFractionsCsv && treatRes.data.data?.length > 0) {
          // Average per-country/area fractions from the imported treatment.csv
          const treatRows = treatRes.data.data;
          const avg = FRACTION_FIELDS.map(k => {
            const vals = treatRows.map(r => parseFloat(r[k]) || 0);
            return vals.reduce((a, b) => a + b, 0) / vals.length;
          });
          const avgSum = avg.reduce((a, b) => a + b, 0);
          normFractions = avgSum > 0.001 ? avg.map(v => Math.round(v * 1000) / 1000) : [1, 0, 0];
        } else {
          normFractions = [1, 0, 0];
        }

        setState({ status: 'done', wwtp, fractions: normFractions, isoRows: isoRes.data.data ?? [], isoFieldnames: isoRes.data.fieldnames ?? [] });
      })
      .catch(e => {
        if (!cancelled) setState({ status: 'error', error: e.response?.data?.error || e.message });
      });

    return () => { cancelled = true; };
  }, [scenario?.id]);

  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-wpBlue" />
        <span className="text-sm">Loading wastewater data…</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-red-400 gap-3">
        <p className="text-sm">Failed to load data: {state.error}</p>
      </div>
    );
  }

  return (
    <WastewaterTreatmentPanelInner
      key={scenario.id}
      scenario={scenario}
      initialWwtp={state.wwtp}
      initialFractions={state.fractions}
      isoRows={state.isoRows ?? []}
      isoFieldnames={state.isoFieldnames ?? []}
      onDirtyChange={onDirtyChange}
    />
  );
};

export default WastewaterTreatmentPanel;
