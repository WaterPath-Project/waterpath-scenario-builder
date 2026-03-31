import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, GeoJSON as LeafletGeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import { ArrowLeft, TrendingUp, Calendar, ChartColumn } from 'lucide-react';
import SSPScenarioDialog from './SSPScenarioDialog';

// ─── Layout constants ─────────────────────────────────────────────────────────
const FLOW_LABEL_W   = 160;          // wider to fit inline description text
const FLOW_CONTENT_L = FLOW_LABEL_W + 8;
const FLOW_CONTENT_R = 990;
const FLOW_ROW_H     = 110;          // taller rows to hold description text
const FLOW_HEADER_H  = 44;
const FLOW_YEAR_X    = { 2030: 400, 2050: 630, 2100: 880 };
const FLOW_ALL_SSPS  = ['1', '2', '3', '4', '5'];
const FLOW_YEARS     = [2030, 2050, 2100];
const flowRowY = (rowIdx) => FLOW_HEADER_H + rowIdx * FLOW_ROW_H + FLOW_ROW_H / 2;

// ─── Color palette ────────────────────────────────────────────────────────────
const BASELINE_STOP_COLOR = '#0B4159'; // wpBlue
const SSP_FLOW_COLOR      = '#096890'; // wpBlue.300 — same for all SSP tracks

function lerpHex(c1, c2, t) {
  const p = (c, s) => parseInt(c.slice(s, s + 2), 16);
  const r = Math.round(p(c1, 1) + (p(c2, 1) - p(c1, 1)) * t);
  const g = Math.round(p(c1, 3) + (p(c2, 3) - p(c1, 3)) * t);
  const b = Math.round(p(c1, 5) + (p(c2, 5) - p(c1, 5)) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Parameterized interpolator: scale is a sorted array of { ratio, color }
function emissionColorFromRatio(ratio, scale) {
  if (ratio == null || !scale?.length) return '#d1d5db';
  const t = Math.max(scale[0].ratio, Math.min(ratio, scale[scale.length - 1].ratio));
  for (let i = 0; i < scale.length - 1; i++) {
    if (t <= scale[i + 1].ratio) {
      const span = scale[i + 1].ratio - scale[i].ratio;
      const frac = span === 0 ? 0 : (t - scale[i].ratio) / span;
      return lerpHex(scale[i].color, scale[i + 1].color, frac);
    }
  }
  return scale[scale.length - 1].color;
}

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

// ─── SSP metadata ─────────────────────────────────────────────────────────────
// Short descriptions rendered inside the SVG label column
const SSP_INLINE_DESCRIPTIONS = {
  '1': 'Sustainability: advanced sanitation, rapid wastewater treatment, low population growth.',
  '2': 'Middle of the road: uneven development, partial sanitation improvements.',
  '3': 'Regional rivalry: high population growth, limited sanitation, high open defecation.',
  '4': 'Inequality: high urbanization, rural gaps in access to treatment.',
  '5': 'Fossil-fuelled development: better city sanitation, intensive livestock production.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sumIsoTotals(isoTotals) {
  if (!isoTotals) return null;
  const vals = Object.values(isoTotals);
  if (vals.length === 0) return null;
  const total = vals.reduce((s, v) => s + (Number(v) || 0), 0);
  return total > 0 ? total : null;
}

// ─── Map: auto-fit to GeoJSON bounds ─────────────────────────────────────────
function FitBoundsToData({ geojson }) {
  const map = useMap();
  useEffect(() => {
    if (!geojson) return;
    try {
      const layer = L.geoJSON(geojson);
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
    } catch { /* invalid geometry — silently ignore */ }
  }, [geojson, map]);
  return null;
}

// ─── ScenarioFlowDiagram ─────────────────────────────────────────────────────
function ScenarioFlowDiagram({ scenarios, emissionTotals, colorScale, onCreateScenario, onRunScenario, runningScenarios, onNavigateScenario }) {
  const baseline = useMemo(
    () => scenarios.find(s => String(s.is_baseline).toLowerCase() === 'true'),
    [scenarios]
  );
  const baselinePathogen = baseline?.pathogen || '';

  const baselineTotal = useMemo(() => {
    if (!baseline?.has_outputs) return null;
    return emissionTotals[baseline.id] ?? null;
  }, [baseline, emissionTotals]);

  const numRows  = 1 + FLOW_ALL_SSPS.length;
  const svgH     = FLOW_HEADER_H + numRows * FLOW_ROW_H + 20;
  const baselineY = flowRowY(0);

  // Continuous diverging color for a run stop
  const stopColor = useCallback((sc) => {
    if (!sc?.has_outputs) return null;
    const total = emissionTotals?.[sc.id];
    if (total == null) return '#d1d5db';
    if (String(sc.is_baseline).toLowerCase() === 'true') return BASELINE_STOP_COLOR;
    if (baselineTotal == null) return SSP_FLOW_COLOR;
    return emissionColorFromRatio(total / baselineTotal, colorScale);
  }, [emissionTotals, baselineTotal, colorScale]);

  const stopMap = useMemo(() => {
    const m = {};
    FLOW_ALL_SSPS.forEach(k => { m[k] = {}; });
    scenarios.forEach(s => {
      if (String(s.is_baseline).toLowerCase() === 'true') return;
      const k  = String(s.ssp || '').replace(/^ssp/i, '');
      const yr = Number(s.year);
      if (k && FLOW_YEARS.includes(yr) && m[k]) m[k][yr] = s;
    });
    return m;
  }, [scenarios]);

  const sspMeta = useMemo(() => FLOW_ALL_SSPS.map((k, rowIdx) => {
    const sspRowIdx  = rowIdx + 1;
    const sspY       = flowRowY(sspRowIdx);
    const stops      = stopMap[k] || {};
    const runYears   = FLOW_YEARS.filter(yr => stops[yr]?.has_outputs);
    const firstRunYr = runYears[0] ?? null;
    const arcEndX    = firstRunYr ? FLOW_YEAR_X[firstRunYr] : null;
    const arcStartX  = firstRunYr ? Math.max(FLOW_CONTENT_L + 20, arcEndX - 160) : null;
    return { k, sspRowIdx, sspY, stops, runYears, firstRunYr, arcStartX, arcEndX };
  }), [stopMap]);

  const baselineEndX = useMemo(() => {
    const starts = sspMeta.map(m => m.arcStartX).filter(x => x !== null);
    return starts.length > 0 ? Math.max(...starts) : FLOW_CONTENT_R;
  }, [sspMeta]);

  return (
    <svg
      viewBox={`0 0 1000 ${svgH}`}
      width="100%"
      style={{ display: 'block', overflow: 'visible' }}
      aria-label="Scenario pathway flow diagram"
    >
      <defs>
        {/* Arc gradients: baseline color → first stop emission color */}
        {sspMeta.map(({ k, sspY, stops, runYears, arcStartX, arcEndX }) => {
          if (!arcEndX) return null;
          const arcEndColor = stopColor(stops[runYears[0]]) || SSP_FLOW_COLOR;
          return (
            <linearGradient key={`arc-${k}`} id={`arc-grad-cs-${k}`} gradientUnits="userSpaceOnUse"
              x1={arcStartX} y1={baselineY} x2={arcEndX} y2={sspY}>
              <stop offset="0%" stopColor={BASELINE_STOP_COLOR} />
              <stop offset="100%" stopColor={arcEndColor} />
            </linearGradient>
          );
        })}
        {/* Segment gradients: between consecutive run stops on same SSP row */}
        {sspMeta.map(({ k, sspY, stops, runYears }) =>
          runYears.slice(0, -1).map((yr, i) => {
            const nextYr = runYears[i + 1];
            const c1 = stopColor(stops[yr])     || SSP_FLOW_COLOR;
            const c2 = stopColor(stops[nextYr]) || SSP_FLOW_COLOR;
            return (
              <linearGradient key={`seg-${k}-${yr}`} id={`seg-grad-cs-${k}-${yr}`}
                gradientUnits="userSpaceOnUse"
                x1={FLOW_YEAR_X[yr]} y1={sspY} x2={FLOW_YEAR_X[nextYr]} y2={sspY}>
                <stop offset="0%" stopColor={c1} />
                <stop offset="100%" stopColor={c2} />
              </linearGradient>
            );
          })
        )}
      </defs>

      {/* Alternating row bands */}
      {Array.from({ length: numRows }, (_, i) => (
        <rect key={i} x={0} y={FLOW_HEADER_H + i * FLOW_ROW_H}
          width={1000} height={FLOW_ROW_H}
          fill={i % 2 === 0 ? '#f8fafc' : '#f1f5f9'} />
      ))}

      {/* Year guide lines + column headers */}
      {FLOW_YEARS.map(yr => (
        <g key={yr}>
          <line x1={FLOW_YEAR_X[yr]} y1={FLOW_HEADER_H - 8} x2={FLOW_YEAR_X[yr]} y2={svgH - 4}
            stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
          <text x={FLOW_YEAR_X[yr]} y={24} textAnchor="middle"
            fontSize="12" fontWeight="700" fill="#475569"
            fontFamily="Inter, sans-serif" letterSpacing="0.05em">
            {yr}
          </text>
        </g>
      ))}

      {/* ── Baseline row ── */}
      <text x={FLOW_LABEL_W - 6} y={baselineY + 4} textAnchor="end"
        fontSize="11" fontWeight="700" fill={BASELINE_STOP_COLOR}
        fontFamily="Inter, sans-serif" letterSpacing="0.08em">
        BASELINE
      </text>
      <line x1={FLOW_CONTENT_L} y1={baselineY} x2={baselineEndX} y2={baselineY}
        stroke={BASELINE_STOP_COLOR} strokeWidth="3" strokeLinecap="round" />

      {/* ── SSP rows ── */}
      {sspMeta.map(({ k, sspRowIdx, sspY, stops, runYears, arcStartX, arcEndX }) => {
        const rowTopY    = FLOW_HEADER_H + sspRowIdx * FLOW_ROW_H;
        const cp1x       = arcStartX ? arcStartX + (arcEndX - arcStartX) * 0.45 : 0;
        const cp2x       = arcEndX   ? arcEndX   - (arcEndX - arcStartX) * 0.30 : 0;
        const unrunYears = FLOW_YEARS.filter(yr => stops[yr] && !stops[yr].has_outputs);
        const emptyYears = FLOW_YEARS.filter(yr => !stops[yr]);

        return (
          <g key={k}>
            {/* SSP label + inline description via foreignObject */}
            <foreignObject x={4} y={rowTopY + 4} width={FLOW_LABEL_W - 8} height={FLOW_ROW_H - 8}>
              <div
                // eslint-disable-next-line react/no-unknown-property
                xmlns="http://www.w3.org/1999/xhtml"
                style={{
                  height: '100%',
                  overflow: 'hidden',
                  fontFamily: 'Inter, sans-serif',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, color: SSP_FLOW_COLOR, letterSpacing: '0.07em' }}>
                  SSP{k}
                </div>
                <div style={{ fontSize: 8, lineHeight: 1.4, color: '#64748b' }}>
                  {SSP_INLINE_DESCRIPTIONS[k]}
                </div>
              </div>
            </foreignObject>

            {/* Dashed track across full row (background guide) */}
            <line x1={FLOW_CONTENT_L + 20} y1={sspY} x2={FLOW_CONTENT_R} y2={sspY}
              stroke={SSP_FLOW_COLOR} strokeWidth="1.5" strokeDasharray="6 4" opacity="0.25"
              strokeLinecap="round" />

            {/* S-curve arc from baseline → first run stop */}
            {arcEndX && (
              <path
                d={`M ${arcStartX},${baselineY} C ${cp1x},${baselineY} ${cp2x},${sspY} ${arcEndX},${sspY}`}
                fill="none" stroke={`url(#arc-grad-cs-${k})`} strokeWidth="3" strokeLinecap="round"
              />
            )}

            {/* Solid segments between consecutive run stops — emission gradient */}
            {runYears.length >= 2 && runYears.slice(0, -1).map((yr, i) => (
              <line key={yr}
                x1={FLOW_YEAR_X[yr]} y1={sspY}
                x2={FLOW_YEAR_X[runYears[i + 1]]} y2={sspY}
                stroke={`url(#seg-grad-cs-${k}-${yr})`} strokeWidth="3" strokeLinecap="round"
              />
            ))}

            {/* Empty slot circles — click to create */}
            {emptyYears.map(yr => (
              <g key={yr} style={{ cursor: 'pointer' }}
                onClick={() => onCreateScenario?.({ sspScenario: k, year: String(yr), pathogen: baselinePathogen })}>
                <circle cx={FLOW_YEAR_X[yr]} cy={sspY} r={11}
                  fill="white" stroke={SSP_FLOW_COLOR} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.65" />
                <text x={FLOW_YEAR_X[yr]} y={sspY + 4} textAnchor="middle"
                  fontSize="13" fill={SSP_FLOW_COLOR} fontFamily="Inter, sans-serif" opacity="0.65">
                  +
                </text>
              </g>
            ))}

            {/* Unrun scenario circles — play button or spinner */}
            {unrunYears.map(yr => {
              const sc        = stops[yr];
              const isRunning = !!runningScenarios?.[sc.id];
              const cx        = FLOW_YEAR_X[yr];
              return (
                <g key={yr}
                  style={{ cursor: isRunning ? 'default' : 'pointer' }}
                  onClick={() => !isRunning && onRunScenario?.(sc.id)}
                  title={isRunning ? 'Running…' : 'Click to run this scenario'}>
                  {isRunning ? (
                    <>
                      <circle cx={cx} cy={sspY} r={11} fill="white" stroke={SSP_FLOW_COLOR} strokeWidth="1.5" />
                      <path d={`M ${cx},${sspY - 8} A 8,8 0 0 1 ${cx + 8},${sspY}`}
                        fill="none" stroke={SSP_FLOW_COLOR} strokeWidth="2.5" strokeLinecap="round">
                        <animateTransform attributeName="transform" type="rotate"
                          from={`0 ${cx} ${sspY}`} to={`360 ${cx} ${sspY}`}
                          dur="1s" repeatCount="indefinite" />
                      </path>
                    </>
                  ) : (
                    <>
                      <circle cx={cx} cy={sspY} r={11} fill="white" stroke={SSP_FLOW_COLOR} strokeWidth="1.5" opacity="0.85" />
                      <polygon points={`${cx - 3},${sspY - 5} ${cx - 3},${sspY + 5} ${cx + 6},${sspY}`}
                        fill={SSP_FLOW_COLOR} opacity="0.85" />
                    </>
                  )}
                </g>
              );
            })}

            {/* Run stop circles — colored by emission relative to baseline */}
            {runYears.map(yr => {
              const sc   = stops[yr];
              const fill = stopColor(sc) || SSP_FLOW_COLOR;
              const cx   = FLOW_YEAR_X[yr];
              return (
                <g key={yr}
                  style={{ cursor: onNavigateScenario ? 'pointer' : 'default' }}
                  onDoubleClick={() => onNavigateScenario?.(sc)}
                  title={onNavigateScenario ? 'Double-click to open scenario editor' : undefined}>
                  <circle cx={cx} cy={sspY} r={8} fill={fill} />
                  <circle cx={cx} cy={sspY} r={3.5} fill="white" />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ─── CaseStudyPage ────────────────────────────────────────────────────────────
export default function CaseStudyPage({ csId, csSlug, onGoToAnalytics }) {
  const navigate = useNavigate();

  const [metadata,         setMetadata]         = useState(null);
  const [scenarios,        setScenarios]        = useState([]);
  const [scenariosVersion, setScenariosVersion] = useState(0);
  const [geodata,          setGeodata]          = useState(null);
  const [emissionTotals,   setEmissionTotals]   = useState({});
  const [runningScenarios, setRunningScenarios] = useState({});
  const [sspDialogOpen,    setSspDialogOpen]    = useState(false);
  const [pendingSSPData,   setPendingSSPData]   = useState(null);

  // Load case study metadata (datapackage.json)
  useEffect(() => {
    if (!csId) return;
    axios.get(`/api/case-studies/${csId}/datapackage`)
      .then(({ data }) => setMetadata(data))
      .catch(() => setMetadata(null));
  }, [csId]);

  // Load scenario list (re-runs when scenariosVersion changes)
  useEffect(() => {
    if (!csId) return;
    axios.get(`/api/case-studies/${csId}/analytics`)
      .then(({ data }) => setScenarios(data.scenarios || []))
      .catch(() => setScenarios([]));
  }, [csId, scenariosVersion]);

  // Load baseline geodata for the map
  useEffect(() => {
    const baseline = scenarios.find(s => String(s.is_baseline).toLowerCase() === 'true');
    if (!baseline?.id) return;
    axios.get(`/api/scenarios/${baseline.id}/geodata`)
      .then(({ data }) => setGeodata(data))
      .catch(() => setGeodata(null));
  }, [scenarios]);

  // Fetch surface-water emission totals for all completed scenarios
  useEffect(() => {
    const toFetch = scenarios.filter(s => s.has_outputs);
    toFetch.forEach(s => {
      if (emissionTotals[s.id] !== undefined) return;
      setEmissionTotals(prev => ({ ...prev, [s.id]: null })); // mark in-flight
      axios.get(`/api/scenarios/${s.id}/output-files`)
        .then(({ data }) => {
          const files     = data.files || [];
          const waterFile = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.csv'));
          if (!waterFile) return null;
          return axios.get(`/api/scenarios/${s.id}/output-csv-data/${waterFile}`);
        })
        .then(res => {
          if (!res) return;
          setEmissionTotals(prev => ({ ...prev, [s.id]: sumIsoTotals(res.data?.iso_totals) }));
        })
        .catch(() => { /* leave as null — will show gray */ });
    });
  }, [scenarios]); // eslint-disable-line

  // Launch a scenario model run from the flow diagram play button
  const handleFlowRun = useCallback(async (scenarioId) => {
    if (runningScenarios[scenarioId]) return;
    setRunningScenarios(prev => ({ ...prev, [scenarioId]: { runId: null, status: 'pending' } }));
    try {
      const { data } = await axios.post(`/api/scenarios/${scenarioId}/run-model`);
      setRunningScenarios(prev => ({ ...prev, [scenarioId]: { runId: data.run_id, status: 'running' } }));
    } catch {
      setRunningScenarios(prev => { const n = { ...prev }; delete n[scenarioId]; return n; });
    }
  }, [runningScenarios]);

  // Poll active run statuses every 2 s
  useEffect(() => {
    const running = Object.entries(runningScenarios).filter(([, v]) => v.runId);
    if (running.length === 0) return;
    const pollId = setInterval(async () => {
      for (const [scenarioId, { runId }] of running) {
        try {
          const { data } = await axios.get(`/api/run-status/${runId}`);
          if (['success', 'error', 'timeout'].includes(data.status)) {
            setRunningScenarios(prev => { const n = { ...prev }; delete n[scenarioId]; return n; });
            if (data.status === 'success') setScenariosVersion(v => v + 1);
          }
        } catch { /* transient — ignore */ }
      }
    }, 2000);
    return () => clearInterval(pollId);
  }, [runningScenarios]);

  // Handle scenario creation from SSPScenarioDialog
  const handleSSPSubmit = useCallback(async (formData) => {
    await axios.post('/api/scenarios', {
      name:             formData.scenarioName,
      description:      '',
      ssp:              `SSP${formData.sspScenario}`,
      year:             parseInt(formData.year),
      pathogen:         formData.pathogen,
      projectionMethod: formData.projectionMethod,
      case_study_id:    csId,
      notes:            '',
      data:             [],
    });
    setSspDialogOpen(false);
    setPendingSSPData(null);
    setScenariosVersion(v => v + 1); // triggers scenario list reload
  }, [csId]);

  // Derived
  const baseline = useMemo(
    () => scenarios.find(s => String(s.is_baseline).toLowerCase() === 'true'),
    [scenarios]
  );
  const scenarioCount = scenarios.filter(s => String(s.is_baseline).toLowerCase() !== 'true').length;
  const runCount      = scenarios.filter(s => s.has_outputs).length;

  // Dynamic emission color scale — adapts to the actual ratio range in this case study
  const { colorScale, legendGradient } = useMemo(() => {
    const baselineTotal = baseline?.has_outputs ? (emissionTotals[baseline.id] ?? null) : null;
    const fallbackScale = [
      { ratio: 0,   color: '#6DF69C' },
      { ratio: 0.5, color: '#8DD0A4' },
      { ratio: 1.0, color: '#0B4159' },
      { ratio: 1.5, color: '#9EB65B' },
      { ratio: 2.0, color: '#FFE597' },
      { ratio: 3.0, color: '#BDA457' },
    ];
    const fallbackGradient = 'linear-gradient(to right, #6DF69C, #8DD0A4, #0B4159, #9EB65B, #FFE597, #BDA457)';
    if (!baselineTotal) return { colorScale: fallbackScale, legendGradient: fallbackGradient };

    const ratios = scenarios
      .filter(s => String(s.is_baseline).toLowerCase() !== 'true' && s.has_outputs)
      .map(s => emissionTotals[s.id])
      .filter(t => t != null)
      .map(t => t / baselineTotal);
    if (ratios.length === 0) return { colorScale: fallbackScale, legendGradient: fallbackGradient };

    const minRatio = Math.min(...ratios, 1.0);
    const maxRatio = Math.max(...ratios, 1.0);

    const stops = [];
    if (minRatio < 1.0) {
      stops.push({ ratio: minRatio, color: '#6DF69C' }); // wpGreen-700 — best
      stops.push({ ratio: minRatio + (1.0 - minRatio) * 0.5, color: '#8DD0A4' }); // wpGreen
    }
    stops.push({ ratio: 1.0, color: '#0B4159' }); // wpBlue — baseline
    if (maxRatio > 1.0) {
      const w = maxRatio - 1.0;
      stops.push({ ratio: 1.0 + w * 0.33, color: '#9EB65B' }); // wpCypress
      stops.push({ ratio: 1.0 + w * 0.66, color: '#FFE597' }); // wpBrown-500
      stops.push({ ratio: maxRatio,        color: '#BDA457' }); // wpBrown-900
    }

    const totalRange = maxRatio - minRatio || 1;
    const gradStops  = stops.map(s => {
      const pct = Math.round(((s.ratio - minRatio) / totalRange) * 100);
      return `${s.color} ${pct}%`;
    });
    return {
      colorScale:     stops,
      legendGradient: `linear-gradient(to right, ${gradStops.join(', ')})`,
    };
  }, [scenarios, emissionTotals, baseline]);

  const title       = metadata?.title || metadata?.name || '—';
  const description = metadata?.description;
  const version     = metadata?.version;
  const created     = metadata?.created
    ? new Date(metadata.created).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <div className="flex flex-col min-h-full bg-wpGray-200">

      {/* ── Header bar ── */}
      <div className="flex items-center gap-3 px-6 py-3 bg-wpWhite-100 border-b border-gray-200 sticky top-0 z-10">
        <button
          onClick={() => navigate('/case-studies')}
          className="flex items-center gap-1.5 text-sm font-medium text-wpBlue hover:text-wpBlue-300 transition-colors"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <span className="text-gray-300 select-none">|</span>
        <h1 className="text-base font-semibold text-wpBlue font-inter flex-1 truncate">{title}</h1>
        {csSlug && (
          <button
            onClick={() => navigate(`/scenarios/${csSlug}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-wpBlue border border-wpBlue-300 rounded-lg bg-wpWhite-100 hover:bg-wpBlue-100 transition-colors"
          >
            <ChartColumn size={13} /> Scenario Editor
          </button>
        )}
        {onGoToAnalytics && (
          <button
            onClick={() => onGoToAnalytics(csId)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-wpBlue border border-wpBrown rounded-lg bg-wpWhite-100 hover:bg-wpBrown-100 transition-colors"
          >
            <TrendingUp size={13} /> Analytics
          </button>
        )}
      </div>

      {/* ── Hero: map + metadata ── */}
      <div className="grid grid-cols-2 gap-6 px-6 pt-6 pb-4">

        {/* Map panel */}
        <div className="rounded-xl overflow-hidden border border-gray-200 bg-white" style={{ height: 280 }}>
          {geodata ? (
            <MapContainer
              center={[20, 0]} zoom={3}
              style={{ height: '100%', width: '100%' }}
              zoomControl={true}
              scrollWheelZoom={false}
              attributionControl={false}
            >
              <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
              <LeafletGeoJSON
                data={geodata}
                style={{ color: '#0B4159', weight: 1.5, fillColor: '#CAD8E3', fillOpacity: 0.45 }}
              />
              <FitBoundsToData geojson={geodata} />
            </MapContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-gray-300">
              Loading map…
            </div>
          )}
        </div>

        {/* Metadata panel */}
        <div className="flex flex-col gap-4 py-1">
          <div>
            <h2 className="text-2xl font-bold text-wpBlue font-inter leading-tight">{title}</h2>
            {description && (
              <p className="text-sm text-gray-500 mt-2 leading-relaxed">{description}</p>
            )}
          </div>

          {/* Badges */}
          <div className="flex flex-wrap items-center gap-2">
            {baseline?.pathogen && (
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-wpBlue text-white">
                {baseline.pathogen.charAt(0).toUpperCase() + baseline.pathogen.slice(1)}
              </span>
            )}
            {version && (
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-wpGray-100 text-wpBlue border border-gray-200">
                v{version}
              </span>
            )}
            {created && (
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <Calendar size={12} /> {created}
              </span>
            )}
          </div>

          {/* Stats */}
          <div className="flex gap-8 mt-auto">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-0.5">Scenarios</p>
              <p className="text-2xl font-bold text-wpBlue">{scenarioCount}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-0.5">Completed runs</p>
              <p className="text-2xl font-bold text-wpBlue">{runCount}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Pathway section ── */}
      <div className="px-6 pb-8 flex flex-col gap-5">

        {/* Section header + legend */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-md font-semibold text-wpBlue uppercase tracking-wide">Scenario Pathways</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Click <span className="font-semibold">+</span> to add a scenario · Click <span className="font-semibold">▶</span> to run an unexecuted scenario
            </p>
          </div>
          {/* Emission color legend — continuous diverging scale */}
          <div className="flex items-center gap-2 text-xs text-gray-500 flex-shrink-0 pt-0.5">
            <span className="text-[10px] text-gray-400">better</span>
            <div className="w-44 h-2.5 rounded" style={{ background: legendGradient }} />
            <span className="text-[10px] text-gray-400">worse</span>
            <span className="text-[10px] text-gray-300 ml-1">vs baseline</span>
          </div>
        </div>

        {/* Flow SVG card */}
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-4">
          {scenarios.length > 0 ? (
            <ScenarioFlowDiagram
              scenarios={scenarios}
              emissionTotals={emissionTotals}
              colorScale={colorScale}
              onCreateScenario={(prefill) => { setPendingSSPData(prefill); setSspDialogOpen(true); }}
              onRunScenario={handleFlowRun}
              runningScenarios={runningScenarios}
              onNavigateScenario={csSlug ? (sc) => navigate(`/scenarios/${csSlug}/${encodeURIComponent(sc.name)}/human-emissions/population`) : undefined}
            />
          ) : (
            <p className="text-sm text-gray-400 italic py-6 text-center">Loading scenarios…</p>
          )}
        </div>


      </div>

      {/* SSP Scenario creation dialog */}
      <SSPScenarioDialog
        isOpen={sspDialogOpen}
        onClose={() => { setSspDialogOpen(false); setPendingSSPData(null); }}
        onSubmit={handleSSPSubmit}
        defaultPathogen={baseline?.pathogen || ''}
        prefillData={pendingSSPData}
      />
    </div>
  );
}
