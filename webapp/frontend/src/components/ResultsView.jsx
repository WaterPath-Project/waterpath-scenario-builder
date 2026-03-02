import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON as LeafletGeoJSON, ImageOverlay, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import { RefreshCw, BarChart2, AlertTriangle, X, Droplets, Trees } from 'lucide-react';

// Category icons (same as ScenarioDetailView)
import HumanEmissionsIcon from '../../assets/icons/human_emissions.svg';
import LivestockEmissionsIcon from '../../assets/icons/livestock_emissions.svg';
import ConcentrationsIcon from '../../assets/icons/concentrations.svg';
import RiskIcon from '../../assets/icons/risk.svg';
import useSettingsStore from '../store/settingsStore';

// Fix Leaflet default icon path issue in Vite
delete L.Icon.Default.prototype._getIconUrl;

// ─── Constants ────────────────────────────────────────────────────────────────
const LOG_MIN = 0;
const LOG_MAX = 18;
const TILE_URL          = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const TILE_LABELS_URL   = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';

const RESULT_CATEGORIES = [
  { id: 'human-emissions',    label: 'Human Emissions',    icon: HumanEmissionsIcon },
  { id: 'livestock-emissions', label: 'Livestock Emissions', icon: LivestockEmissionsIcon },
  { id: 'concentrations',     label: 'Concentrations',     icon: ConcentrationsIcon },
  { id: 'risk',               label: 'Risk',               icon: RiskIcon },
];
const TILE_ATTR = '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';

// Per-source colors matching the sanitation ladder palette in /scenarios
const SOURCE_COLORS = {
  // Improved – safely managed → basic (green shades)
  flushSewer:       '#2E7D32',
  flushSeptic:      '#388E3C',
  flushPit:         '#43A047',
  pitSlab:          '#66BB6A',
  compostingToilet: '#81C784',
  containerBased:   '#A5D6A7',
  // Unimproved (yellow/amber shades)
  pitNoSlab:        '#FFDA46',
  bucketLatrine:    '#FFB300',
  hangingToilet:    '#FF8F00',
  flushOpen:        '#FF6F00',
  flushUnknown:     '#FDD835',
  other:            '#D4E157',
  // Open defecation
  openDefecation:   '#FFC000',
};

// YlOrRd stops: [0–1 normalized, [R, G, B]]
const YLORRD_STOPS = [
  [0,    [255, 255, 204]],
  [0.25, [254, 217, 142]],
  [0.5,  [253, 141,  60]],
  [0.75, [227,  26,  28]],
  [1.0,  [128,   0,  38]],
];

function lerp(a, b, t) { return a + (b - a) * t; }

/** Map an emission value → CSS colour using YlOrRd, log₁₀ scale fixed 0–16. */
function emissionColor(value) {
  if (!value || value <= 0) return '#d1d5db';
  const logv = Math.log10(value);
  const norm = Math.max(0, Math.min(1, (logv - LOG_MIN) / (LOG_MAX - LOG_MIN)));
  for (let i = 0; i < YLORRD_STOPS.length - 1; i++) {
    const [t0, c0] = YLORRD_STOPS[i];
    const [t1, c1] = YLORRD_STOPS[i + 1];
    if (norm >= t0 && norm <= t1) {
      const t = (norm - t0) / (t1 - t0);
      return `rgb(${Math.round(lerp(c0[0],c1[0],t))},${Math.round(lerp(c0[1],c1[1],t))},${Math.round(lerp(c0[2],c1[2],t))})`;
    }
  }
  return '#800026';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSourceName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function formatScientific(val) {
  if (!val || val === 0) return '0';
  let exp = Math.floor(Math.log10(Math.abs(val)));
  let coef = Math.round((val / Math.pow(10, exp)) * 10) / 10;
  // Guard against rounding 9.95 → 10.0 overflowing the mantissa
  if (coef >= 10) { coef = 1.0; exp += 1; }
  const coefStr = coef.toFixed(1);
  const supMap = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻' };
  return `${coefStr}×10${String(exp).split('').map(c => supMap[c] || c).join('')}`;
}

// ─── Legend (shared fixed 0–18) ───────────────────────────────────────────────

function Legend() {
  return (
    <div className="mt-2">
      <div className="h-3 rounded" style={{ background: 'linear-gradient(to right,#ffffcc,#fed976,#fd8d3c,#e31a1c,#800026)' }} />
      <div className="flex justify-between mt-0.5">
        {[0, 6, 12, 18].map(v => (
          <span key={v} className="text-xs text-gray-400 font-mono">10<sup>{v}</sup></span>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-1">Log₁₀ scale · viral particles / grid cell / year</p>
    </div>
  );
}

// ─── Sources chart ────────────────────────────────────────────────────────────

function SourcesChart({ ranked }) {
  if (!ranked?.length) return <p className="text-xs text-gray-400 italic">No source data available</p>;
  const top = ranked.slice(0, 8);
  const maxVal = top[0]?.total || 1;
  return (
    <div className="space-y-1.5">
      {top.map((item, i) => (
        <div key={item.source} className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-4 flex-shrink-0">{i + 1}.</span>
          <span className="text-xs text-gray-700 w-36 flex-shrink-0 truncate" title={formatSourceName(item.source)}>
            {formatSourceName(item.source)}
          </span>
          <div className="flex-1 bg-gray-100 rounded-full h-2 min-w-0">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${Math.max(2,(item.total/maxVal)*100).toFixed(1)}%`,
                backgroundColor: SOURCE_COLORS[item.source] || '#6B7280',
              }}
            />
          </div>
          <span className="text-xs text-gray-500 w-20 text-right font-mono">{formatScientific(item.total)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Fit map to GeoJSON bounds ────────────────────────────────────────────────

function FitBounds({ geojson }) {
  const map = useMap();
  useEffect(() => {
    if (!geojson?.features?.length) return;
    try {
      const bounds = L.geoJSON(geojson).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    } catch (_) {}
  }, [geojson, map]);
  return null;
}

// Create a dedicated Leaflet pane for the polygon overlay so it sits above the raster layer.
function CreateBlendPane() {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane('polygonPane')) {
      const pane = map.createPane('polygonPane');
      pane.style.zIndex = '450';
    }
    // Label pane sits above both the raster (400) and polygons (450)
    if (!map.getPane('labelsPane')) {
      const lp = map.createPane('labelsPane');
      lp.style.zIndex = '600';
      lp.style.pointerEvents = 'none';
    }
  }, [map]);
  return null;
}

// ─── Area click dialog ────────────────────────────────────────────────────────

function AreaDialog({ area, waterRows, landRows, onClose }) {
  if (!area) return null;
  const { iso, name } = area;
  const key = String(iso);
  const wRow = waterRows?.[key];
  const lRow = landRows?.[key];

  const renderBreakdown = (row) => {
    if (!row) return <p className="text-xs text-gray-400 italic">No data</p>;
    const entries = Object.entries(row).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);
    if (!entries.length) return <p className="text-xs text-gray-400 italic">All zero</p>;
    return (
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([src, val]) => (
            <tr key={src} className="border-b border-gray-100 last:border-0">
              <td className="py-0.5 pr-2 text-gray-600">{formatSourceName(src)}</td>
              <td className="py-0.5 text-right font-mono text-gray-700">{formatScientific(val)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
          <div>
            <p className="font-semibold text-gray-900">{name}</p>
            <p className="text-xs text-gray-400">Area index: {iso}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-200 transition-colors"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 grid grid-cols-2 gap-5">
          <div>
            <p className="text-xs font-semibold text-wpBlue mb-2 flex items-center gap-1">
              <Droplets size={12} /> Surface Water
            </p>
            {renderBreakdown(wRow)}
          </div>
          <div>
            <p className="text-xs font-semibold text-wpGreen mb-2 flex items-center gap-1">
              <Trees size={12} /> Land
            </p>
            {renderBreakdown(lRow)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Single emission map panel ────────────────────────────────────────────────

function EmissionMap({ title, icon: Icon, geojson, isoTotals, rasterFile, scenarioId, onAreaClick, loading }) {
  const isoTotalsRef = useRef(isoTotals);
  useEffect(() => { isoTotalsRef.current = isoTotals; }, [isoTotals]);
  const onAreaClickRef = useRef(onAreaClick);
  useEffect(() => { onAreaClickRef.current = onAreaClick; }, [onAreaClick]);

  const { heatmapView } = useSettingsStore();
  const heatmapViewRef = useRef(heatmapView);
  useEffect(() => { heatmapViewRef.current = heatmapView; }, [heatmapView]);

  // Fetch TIF raster as PNG + bounds for ImageOverlay
  const [rasterData, setRasterData] = useState(null);
  useEffect(() => {
    if (!scenarioId || !rasterFile) { setRasterData(null); return; }
    axios.get(`/api/scenarios/${scenarioId}/output-raster/${rasterFile}`)
      .then(({ data }) => setRasterData(data))
      .catch(() => setRasterData(null));
  }, [scenarioId, rasterFile]);

  const getStyle = useCallback((feature) => {
    const val = isoTotalsRef.current?.[String(feature.properties.iso)];
    const baseFill = heatmapViewRef.current ? 0.06 : 0;
    return { fillColor: emissionColor(val), fillOpacity: baseFill, color: '#1e293b', weight: 0.6, opacity: 0.5, pane: 'polygonPane' };
  }, [heatmapView]);

  const onEachFeature = useCallback((feature, layer) => {
    const iso = feature.properties.iso;
    const name = feature.properties.NAME_3 || feature.properties.NAME_2 || `Area ${iso}`;
    layer.on('mouseover', () => {
      const val = isoTotalsRef.current?.[String(iso)];
      layer.bindTooltip(`<strong>${name}</strong><br/>${formatScientific(val || 0)} virus eq.`, { sticky: true });
      const hoverFill = heatmapViewRef.current ? 0.3 : 0.12;
      layer.setStyle({ fillOpacity: hoverFill, weight: 1.5, color: '#0f172a', opacity: 0.9, pane: 'polygonPane' });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      const baseFill = heatmapViewRef.current ? 0.06 : 0;
      layer.setStyle({ fillOpacity: baseFill, weight: 0.6, color: '#1e293b', opacity: 0.5, pane: 'polygonPane' });
    });
    layer.on('click', () => {
      onAreaClickRef.current?.({ iso, name });
    });
  }, []);

  // Change key when isoTotals data arrives or heatmapView changes to force style refresh
  const geoKey = `${scenarioId}-${Object.keys(isoTotals || {}).length}-${heatmapView}`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
      <h3 className="font-semibold text-gray-800 flex items-center gap-2">
        {Icon && <Icon size={15} className="text-wpBlue" />}{title}
      </h3>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <RefreshCw size={20} className="animate-spin text-gray-400 mr-2" />
          <span className="text-sm text-gray-400">Loading…</span>
        </div>
      ) : geojson ? (
        <>
          <div className="rounded overflow-hidden border border-gray-100" style={{ height: '300px' }}>
            <MapContainer center={[0, 0]} zoom={2} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
              <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
              <CreateBlendPane />
              {rasterData?.image && rasterData.bounds && (
                <ImageOverlay
                  className={heatmapView ? undefined : 'pixelated-raster'}
                  url={`data:image/png;base64,${rasterData.image}`}
                  bounds={[[rasterData.bounds.south, rasterData.bounds.west], [rasterData.bounds.north, rasterData.bounds.east]]}
                  opacity={0.85}
                  zIndex={400}
                />
              )}
              <LeafletGeoJSON key={geoKey} data={geojson} style={getStyle} onEachFeature={onEachFeature} />
              {/* Labels rendered above both the raster and polygons */}
              <TileLayer url={TILE_LABELS_URL} pane="labelsPane" />
              <FitBounds geojson={geojson} />
            </MapContainer>
          </div>
          <Legend />
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm text-gray-400 p-4 bg-gray-50 rounded">
          <AlertTriangle size={14} /> No geodata available for this scenario.
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ResultsView({ caseStudies, initialCaseStudyId, initialScenarioId, onCaseStudyChange }) {
  const [selectedCsId, setSelectedCsId] = useState(initialCaseStudyId || '');
  const [availableScenarios, setAvailableScenarios] = useState([]);
  const [scenariosLoading, setScenariosLoading] = useState(false);
  const [selectedScId, setSelectedScId] = useState(initialScenarioId || '');
  const [emissionType, setEmissionType] = useState('water'); // 'water' | 'land'
  const [selectedCategory, setSelectedCategory] = useState('human-emissions');

  // Sync when parent passes a new initialCaseStudyId (e.g. user selected on another screen)
  useEffect(() => {
    if (initialCaseStudyId) setSelectedCsId(initialCaseStudyId);
  }, [initialCaseStudyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select when there is exactly one case study and none explicitly provided
  useEffect(() => {
    if (!selectedCsId && !initialCaseStudyId && caseStudies.length === 1) {
      setSelectedCsId(caseStudies[0].id);
    }
  }, [caseStudies]); // eslint-disable-line react-hooks/exhaustive-deps

  const [geojson, setGeojson] = useState(null);
  const [waterEmissions, setWaterEmissions] = useState(null);  // {iso_totals, iso_rows, ranked}
  const [landEmissions, setLandEmissions] = useState(null);
  const [waterSources, setWaterSources] = useState(null);      // human_sources_water ranked
  const [landSources, setLandSources] = useState(null);        // human_sources_land ranked

  const [panelLoading, setPanelLoading] = useState(false);
  const [error, setError] = useState(null);
  const [clickedArea, setClickedArea] = useState(null);
  const [waterTif, setWaterTif] = useState(null);
  const [landTif, setLandTif]   = useState(null);

  // Load scenarios when case study changes
  useEffect(() => {
    if (!selectedCsId) { setAvailableScenarios([]); setSelectedScId(''); return; }
    setScenariosLoading(true);
    axios.get(`/api/case-studies/${selectedCsId}/analytics`)
      .then(({ data }) => {
        const withOutputs = (data.scenarios || []).filter(s => s.has_outputs);
        setAvailableScenarios(withOutputs);
        if (!withOutputs.find(s => s.id === selectedScId)) setSelectedScId(withOutputs[0]?.id || '');
      })
      .catch(() => setAvailableScenarios([]))
      .finally(() => setScenariosLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCsId]);

  useEffect(() => { if (initialCaseStudyId) setSelectedCsId(initialCaseStudyId); }, [initialCaseStudyId]);
  useEffect(() => { if (initialScenarioId)  setSelectedScId(initialScenarioId);  }, [initialScenarioId]);

  // Load output data when scenario changes
  useEffect(() => {
    if (!selectedScId) {
      setGeojson(null); setWaterEmissions(null); setLandEmissions(null);
      setWaterSources(null); setLandSources(null);
      setWaterTif(null); setLandTif(null); return;
    }
    setPanelLoading(true);
    setError(null);
    setClickedArea(null);

    axios.get(`/api/scenarios/${selectedScId}/output-files`)
      .then(({ data }) => {
        const files = data.files || [];
        const waterEmFile  = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.csv'));
        const landEmFile   = files.find(f => f.includes('land_emissions') && f.endsWith('.csv'));
        const waterSrcFile = files.find(f => f.includes('human_sources_water') && f.endsWith('.csv'));
        const landSrcFile  = files.find(f => f.includes('human_sources_land') && f.endsWith('.csv'));
        const waterTifFile = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.tif'));
        const landTifFile  = files.find(f => f.includes('land_emissions') && f.endsWith('.tif'));
        setWaterTif(waterTifFile || null);
        setLandTif(landTifFile || null);
        return Promise.all([
          axios.get(`/api/scenarios/${selectedScId}/geodata`),
          waterEmFile  ? axios.get(`/api/scenarios/${selectedScId}/output-csv-data/${waterEmFile}`)  : Promise.resolve(null),
          landEmFile   ? axios.get(`/api/scenarios/${selectedScId}/output-csv-data/${landEmFile}`)   : Promise.resolve(null),
          waterSrcFile ? axios.get(`/api/scenarios/${selectedScId}/output-csv-data/${waterSrcFile}`) : Promise.resolve(null),
          landSrcFile  ? axios.get(`/api/scenarios/${selectedScId}/output-csv-data/${landSrcFile}`)  : Promise.resolve(null),
        ]);
      })
      .then(([geoRes, wEmRes, lEmRes, wSrcRes, lSrcRes]) => {
        setGeojson(geoRes?.data || null);
        setWaterEmissions(wEmRes?.data || null);
        setLandEmissions(lEmRes?.data || null);
        setWaterSources(wSrcRes?.data || null);
        setLandSources(lSrcRes?.data || null);
      })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setPanelLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScId]);

  const selectedScenario = availableScenarios.find(s => s.id === selectedScId);

  // Derive enabled categories for the selected case study
  const selectedCs = caseStudies.find(c => c.id === selectedCsId);
  const enabledCatIds = selectedCs?.enabled_categories ?? null;
  const isCatEnabled = (id) => !enabledCatIds || enabledCatIds.includes(id);

  return (
    <div className="flex flex-col h-full overflow-auto p-6 pt-0">
      {/* Selectors + toggle */}
      <div className="flex items-center gap-4 my-2 py-6 px-4 flex-shrink-0 flex-wrap rounded-xl bg-wpBrown-200">
        <select
          value={selectedCsId}
          onChange={e => {
            const id = e.target.value;
            setSelectedCsId(id);
            setSelectedScId('');
            if (id) {
              const cs = caseStudies.find(c => c.id === id);
              if (cs) onCaseStudyChange?.(cs);
            }
          }}
          className="px-3 py-3 border text-sm border-wpBrown bg-wpWhite-100 text-wpBlue font-bold font-inter rounded-lg focus:ring-2 focus:ring-wpBlue focus:border-transparent"
        >
          <option value="">Select a case study…</option>
          {caseStudies.map(cs => <option key={cs.id} value={cs.id}>{cs.name}</option>)}
        </select>
        <select
          value={selectedScId}
          onChange={e => setSelectedScId(e.target.value)}
          disabled={!selectedCsId || scenariosLoading}
          className="px-3 py-3 border text-sm border-wpBrown bg-wpWhite-100 text-wpBlue font-bold font-inter rounded-lg focus:ring-2 focus:ring-wpBlue focus:border-transparent disabled:opacity-50"
        >
          <option value="">
            {scenariosLoading ? 'Loading…' : availableScenarios.length === 0 ? 'No completed scenarios' : 'Select a scenario…'}
          </option>
          {availableScenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {selectedScenario && (
          <div className="flex gap-1 flex-wrap">
            {[
              selectedScenario.pathogen && { type: 'pathogen', label: `${selectedScenario.pathogen.charAt(0).toUpperCase() + selectedScenario.pathogen.slice(1)}` },
              selectedScenario.ssp      && { type: 'ssp',      label: `${selectedScenario.ssp}` },
              selectedScenario.year     && { type: 'year',     label: String(selectedScenario.year) },
            ].filter(Boolean).map(t => (
              <span
                key={t.label}
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  t.type === 'pathogen' ? 'bg-purple-100 text-purple-700' :
                  t.type === 'ssp'      ? 'bg-blue-100 text-blue-700' :
                                          'bg-amber-100 text-amber-700'
                }`}
              >{t.label}</span>
            ))}
          </div>
        )}
        {/* Water/Land toggle — always visible, right-aligned */}
        <div className="ml-auto flex items-center gap-0 rounded-xl overflow-hidden bg-wpWhite-100">
          <button
            onClick={() => setEmissionType('water')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors ${
              emissionType === 'water'
                ? 'bg-wpBlue text-white'
                : 'text-wpBlue hover:bg-wpGray-100'
            }`}
          >
            <Droplets size={14} /> Surface Water
          </button>
          <button
            onClick={() => setEmissionType('land')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors ${
              emissionType === 'land'
                ? 'bg-wpGreen text-white'
                : 'text-wpBlue hover:bg-wpGray-100'
            }`}
          >
            <Trees size={14} /> Land
          </button>
        </div>
      </div>
      {/* Category tabs */}
      <div className="flex-shrink-0 pt-0 -mx-6 px-6">
        <div className="flex space-x-2 bg-wpWhite-100 rounded-xl">
          {RESULT_CATEGORIES.map((cat) => {
            const enabled = isCatEnabled(cat.id);
            const active = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                disabled={!enabled}
                onClick={() => { if (enabled) setSelectedCategory(cat.id); }}
                className={`relative flex flex-1 items-center gap-3 px-6 py-3 rounded-xl transition-colors justify-center
                  ${
                    !enabled
                      ? 'bg-gray-100 text-gray-400 opacity-40 cursor-not-allowed'
                      : active
                        ? 'bg-white text-wpBlue shadow-md shadow-wpGray-500/50'
                        : 'bg-gray-100 text-wpBlue hover:bg-gray-200'
                  }`}
              >
                <img src={cat.icon} alt={cat.label} className="w-10 h-10" />
                <span className="font-semibold font-outfit">{cat.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      {/* Empty state */}
      {!selectedScId && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-400">
            <BarChart2 size={48} className="mx-auto mb-3 text-gray-200" />
            <p className="text-lg font-medium text-gray-300">No scenario selected</p>
            <p className="text-sm mt-1">Select a case study and a completed scenario to view results.</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Maps + source charts — human emissions only */}
      {selectedScId && selectedCategory !== 'human-emissions' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-400">
            <BarChart2 size={48} className="mx-auto mb-3 text-gray-200" />
            <p className="text-lg font-medium text-gray-300">Coming soon</p>
            <p className="text-sm mt-1">Results for <span className="font-medium">{RESULT_CATEGORIES.find(c => c.id === selectedCategory)?.label}</span> are not yet available.</p>
          </div>
        </div>
      )}
      {selectedScId && selectedCategory === 'human-emissions' && (
        <div className="space-y-4 mt-2 pb-6">

          {emissionType === 'water' ? (
            <>
              <EmissionMap
                title="Surface Water Emissions"
                icon={Droplets}
                geojson={geojson}
                isoTotals={waterEmissions?.iso_totals}
                rasterFile={waterTif}
                scenarioId={selectedScId}
                onAreaClick={setClickedArea}
                loading={panelLoading}
              />
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1">
                  <BarChart2 size={12} /> Main sources — surface water (global total)
                </p>
                <SourcesChart ranked={waterSources?.ranked} />
              </div>
            </>
          ) : (
            <>
              <EmissionMap
                title="Land Emissions"
                icon={Trees}
                geojson={geojson}
                isoTotals={landEmissions?.iso_totals}
                rasterFile={landTif}
                scenarioId={selectedScId}
                onAreaClick={setClickedArea}
                loading={panelLoading}
              />
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1">
                  <BarChart2 size={12} /> Main sources — land (global total)
                </p>
                <SourcesChart ranked={landSources?.ranked} />
              </div>
            </>
          )}

        </div>
      )}

      {/* Click dialog */}
      {clickedArea && (
        <AreaDialog
          area={clickedArea}
          waterRows={waterEmissions?.iso_rows}
          landRows={landEmissions?.iso_rows}
          onClose={() => setClickedArea(null)}
        />
      )}
    </div>
  );
}
