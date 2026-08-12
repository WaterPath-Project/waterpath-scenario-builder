import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import HumanPopulationIcon from '../../assets/icons/human_population.svg';
import ConcentrationsIcon from '../../assets/icons/concentrations.svg';
import SanitationIcon from '../../assets/icons/sanitation.svg';
import WastewaterTreatmentIcon from '../../assets/icons/wastewater_treatment.svg';
import LivestockPopulationIcon from '../../assets/icons/livestock_population.svg';
import ProductionSystemsIcon from '../../assets/icons/production_systems.svg';
import useCaseStudyBySlug from '../hooks/useCaseStudyBySlug';

// ── Helpers (mirrors ResultsView.jsx) ────────────────────────────────────────

function computeDeltaPct(base, value) {
  if (base === null || base === undefined || value === null || value === undefined) return null;
  const b = Number(base);
  const v = Number(value);
  if (!Number.isFinite(b) || !Number.isFinite(v)) return null;
  if (Math.abs(b) < 1e-9) return Math.abs(v) < 1e-9 ? 0 : null;
  return ((v - b) / Math.abs(b)) * 100;
}

function formatMetricValue(value, valueFormat) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const v = Number(value);
  if (valueFormat === 'percent') return `${v.toFixed(1)}%`;
  if (valueFormat === 'hdi') return v.toFixed(3);
  if (valueFormat === 'integer') return Math.round(v).toLocaleString();
  return v.toFixed(2);
}

function formatDeltaValue(delta, deltaMode) {
  if (delta === null || delta === undefined || Number.isNaN(Number(delta))) return '—';
  const v = Number(delta);
  if (deltaMode === 'pp') return `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
  if (deltaMode === 'absolute') return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function computeMetricDelta(base, value, deltaMode) {
  if (base === null || base === undefined || value === null || value === undefined) return null;
  const b = Number(base);
  const v = Number(value);
  if (!Number.isFinite(b) || !Number.isFinite(v)) return null;
  if (deltaMode === 'pp' || deltaMode === 'absolute') return v - b;
  return computeDeltaPct(b, v);
}

function isWastewaterMetric(k) { return k.startsWith('wastewater_'); }
function isShareMetric(k)      { return k.startsWith('wastewater_share_'); }
function isPointOnlyMetric(k)  { return k === 'wastewater_facility_count' || k === 'wastewater_total_capacity'; }

// ── Baseline comparison badge (mirrors CaseStudyPage's emission/risk color logic) ──

function sumIsoTotals(isoTotals) {
  if (!isoTotals) return null;
  const vals = Object.values(isoTotals);
  if (vals.length === 0) return null;
  const total = vals.reduce((s, v) => s + (Number(v) || 0), 0);
  return total > 0 ? total : null;
}

// Priority: risk (if available) > concentration (if available) > emissions.
function getComparisonBadge(scenarioId, baselineId, emissionTotals, concentrationTotals, riskTotals) {
  if (!baselineId || !scenarioId || scenarioId === baselineId) return null;
  const candidates = [
    { kind: 'risk',          value: riskTotals[scenarioId],          base: riskTotals[baselineId] },
    { kind: 'concentration', value: concentrationTotals[scenarioId], base: concentrationTotals[baselineId] },
    { kind: 'emissions',     value: emissionTotals[scenarioId],      base: emissionTotals[baselineId] },
  ];
  for (const { kind, value, base } of candidates) {
    if (value == null || base == null) continue;
    if (Math.abs(base) < 1e-9) continue;
    const pctDiff = ((value - base) / Math.abs(base)) * 100;
    if (Math.abs(pctDiff) < 0.5) return { kind, direction: 'same', label: `Similar ${kind}` };
    const direction = value > base ? 'up' : 'down';
    return { kind, direction, label: `${direction === 'up' ? 'Higher' : 'Lower'} ${kind}` };
  }
  return null;
}

function isMetricApplicableForScenario(metricKey, scenario) {
  if (!scenario || !isWastewaterMetric(metricKey)) return true;
  const mode = scenario.wwtp_mode;
  if (mode === 'point' && isShareMetric(metricKey)) return false;
  if (mode === 'area'  && isPointOnlyMetric(metricKey)) return false;
  return true;
}

const DRIVER_META = {
  Population:               { icon: HumanPopulationIcon,      label: 'Population' },
  Hydrology:                { icon: ConcentrationsIcon,       label: 'Hydrology' },
  Sanitation:               { icon: SanitationIcon,            label: 'Sanitation' },
  'Wastewater treatment':   { icon: WastewaterTreatmentIcon,  label: 'Wastewater treatment' },
  'Livestock population':   { icon: LivestockPopulationIcon,  label: 'Livestock population' },
  'Production systems':     { icon: ProductionSystemsIcon,    label: 'Production systems' },
};

// ── ScenarioSummaryView ───────────────────────────────────────────────────────

/**
 * Full-page driver-change summary view.
 * Mirrors the content of ResultsView's DriverChangeDialog but rendered as a
 * standalone page at /summary.
 *
 * Props:
 *   caseStudyId – string | null
 */
export default function ScenarioSummaryView({ caseStudyId }) {
  const { csSlug } = useParams();
  const { caseStudy: resolvedCaseStudy } = useCaseStudyBySlug(csSlug);
  const effectiveCaseStudyId = resolvedCaseStudy?.id ?? caseStudyId ?? null;

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [viewMode, setViewMode] = useState('delta'); // 'delta' | 'values'
  const [selectedSsp, setSelectedSsp] = useState('all');

  // has_outputs flags (not present on the driver-comparison payload) — fetched
  // separately so we know which scenarios are worth pulling emissions/
  // concentration/risk totals for.
  const [scenarioMetaById,    setScenarioMetaById]    = useState({});
  const [scenarioOutputs,     setScenarioOutputs]     = useState({});
  const [emissionTotals,      setEmissionTotals]      = useState({});
  const [concentrationTotals, setConcentrationTotals]  = useState({});
  const [riskTotals,          setRiskTotals]          = useState({});

  useEffect(() => {
    if (!effectiveCaseStudyId) { setData(null); return; }
    setLoading(true);
    setError('');
    axios.get(`/api/case-studies/${effectiveCaseStudyId}/driver-comparison`)
      .then(({ data }) => setData(data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load driver comparison'))
      .finally(() => setLoading(false));
  }, [effectiveCaseStudyId]);

  useEffect(() => {
    if (!effectiveCaseStudyId) { setScenarioOutputs({}); return; }
    axios.get(`/api/case-studies/${effectiveCaseStudyId}/analytics`)
      .then(({ data }) => {
        const metaMap = {};
        const outputMap = {};
        (data.scenarios || []).forEach(s => {
          metaMap[s.id] = s;
          outputMap[s.id] = !!s.has_outputs;
        });
        setScenarioMetaById(metaMap);
        setScenarioOutputs(outputMap);
      })
      .catch(() => {
        setScenarioMetaById({});
        setScenarioOutputs({});
      });
  }, [effectiveCaseStudyId]);

  const scenarios    = data?.scenarios    || [];
  const metrics      = data?.metrics      || [];
  const baselineId   = data?.baseline_scenario_id || null;
  const baselineScenario = scenarios.find(s => s.id === baselineId) || null;
  const baselineMetrics  = baselineScenario?.metrics || {};

  const sspOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    scenarios.forEach(sc => {
      const ssp = (scenarioMetaById[sc.id]?.ssp || sc.ssp || '').trim();
      if (!ssp || seen.has(ssp)) return;
      seen.add(ssp);
      options.push(ssp);
    });
    return options.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }, [scenarios, scenarioMetaById]);

  const orderedScenarios = useMemo(() => {
    const selected = selectedSsp === 'all' ? null : selectedSsp;
    return scenarios
      .filter(sc => sc.id === baselineId || !selected || (scenarioMetaById[sc.id]?.ssp || sc.ssp || '').trim() === selected)
      .slice()
      .sort((a, b) => {
        if (a.id === baselineId) return -1;
        if (b.id === baselineId) return 1;
        const yearA = Number(scenarioMetaById[a.id]?.year ?? a.year);
        const yearB = Number(scenarioMetaById[b.id]?.year ?? b.year);
        const safeYearA = Number.isFinite(yearA) ? yearA : Number.POSITIVE_INFINITY;
        const safeYearB = Number.isFinite(yearB) ? yearB : Number.POSITIVE_INFINITY;
        if (safeYearA !== safeYearB) return safeYearA - safeYearB;
        return String(scenarioMetaById[a.id]?.name ?? a.name ?? '').localeCompare(
          String(scenarioMetaById[b.id]?.name ?? b.name ?? ''),
          undefined,
          { numeric: true, sensitivity: 'base' }
        );
      });
  }, [scenarios, baselineId, selectedSsp, scenarioMetaById]);

  // Surface-water emission totals (sum across areas), for comparison badges.
  useEffect(() => {
    const toFetch = scenarios.filter(s => scenarioOutputs[s.id] && emissionTotals[s.id] === undefined);
    if (toFetch.length === 0) return;
    toFetch.forEach(s => {
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
        .catch(() => { /* leave as null */ });
    });
  }, [scenarios, scenarioOutputs]); // eslint-disable-line

  // Average annual stream concentration (proxy for drinking-water exposure), for comparison badges.
  useEffect(() => {
    const toFetch = scenarios.filter(s => scenarioOutputs[s.id] && concentrationTotals[s.id] === undefined);
    if (toFetch.length === 0) return;
    toFetch.forEach(s => {
      setConcentrationTotals(prev => ({ ...prev, [s.id]: null })); // mark in-flight
      axios.get(`/api/scenarios/${s.id}/hydrology-monthly-stats?metric=concentration`)
        .then(({ data }) => {
          setConcentrationTotals(prev => ({ ...prev, [s.id]: data?.avg_sum ?? null }));
        })
        .catch(() => { /* leave as null — no hydrology output */ });
    });
  }, [scenarios, scenarioOutputs]); // eslint-disable-line

  // Population-weighted combined QMRA risk, for comparison badges.
  useEffect(() => {
    const toFetch = scenarios.filter(s => scenarioOutputs[s.id] && riskTotals[s.id] === undefined);
    if (toFetch.length === 0) return;
    toFetch.forEach(s => {
      setRiskTotals(prev => ({ ...prev, [s.id]: null })); // mark in-flight
      axios.get(`/api/scenarios/${s.id}/qmra/availability`)
        .then(({ data }) => {
          if (!data.has_qmra_output) return null;
          return axios.get(`/api/scenarios/${s.id}/qmra/stats`);
        })
        .then(res => {
          if (!res) return;
          const val = res.data?.population_weighted?.risk?.combined ?? null;
          if (val != null) setRiskTotals(prev => ({ ...prev, [s.id]: val }));
        })
        .catch(() => { /* leave as null — no QMRA output */ });
    });
  }, [scenarios, scenarioOutputs]); // eslint-disable-line

  const comparisonBadges = useMemo(() => {
    const map = {};
    scenarios.forEach(sc => {
      map[sc.id] = getComparisonBadge(sc.id, baselineId, emissionTotals, concentrationTotals, riskTotals);
    });
    return map;
  }, [scenarios, baselineId, emissionTotals, concentrationTotals, riskTotals]);

  const groupedMetrics = useMemo(() => {
    const groups = [];
    const byDriver = new Map();
    metrics.forEach(m => {
      if (!byDriver.has(m.driver)) {
        const g = { driver: m.driver, rows: [] };
        byDriver.set(m.driver, g);
        groups.push(g);
      }
      byDriver.get(m.driver).rows.push(m);
    });
    return groups;
  }, [metrics]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex-shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-wpBlue font-inter">Summary of changes</h2>
          {baselineScenario && (
            <p className="text-xs text-gray-500 mt-0.5 font-inter">
              Baseline: <span className="font-semibold">{baselineScenario.name}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-gray-500">
            <span className="uppercase tracking-wide">SSP</span>
            <select
              value={selectedSsp}
              onChange={(e) => setSelectedSsp(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-wpBlue shadow-sm focus:border-wpBlue focus:outline-none"
            >
              <option value="all">All SSPs</option>
              {sspOptions.map(ssp => (
                <option key={ssp} value={ssp}>{ssp}</option>
              ))}
            </select>
          </label>
          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs font-semibold">
            <button
              onClick={() => setViewMode('delta')}
              className={`px-3 py-1.5 ${viewMode === 'delta' ? 'bg-wpBlue text-white' : 'bg-white text-wpBlue hover:bg-gray-50'}`}
            >
              Deltas
            </button>
            <button
              onClick={() => setViewMode('values')}
              className={`px-3 py-1.5 ${viewMode === 'values' ? 'bg-wpBlue text-white' : 'bg-white text-wpBlue hover:bg-gray-50'}`}
            >
              Values
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-5">
        {!caseStudyId && (
          <p className="text-sm text-gray-500 italic">Select a case study to view the summary.</p>
        )}
        {caseStudyId && loading && (
          <p className="text-sm text-gray-500 italic">Loading driver comparison…</p>
        )}
        {caseStudyId && !loading && error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        {caseStudyId && !loading && !error && scenarios.length === 0 && (
          <p className="text-sm text-gray-500 italic">No scenarios with outputs available for this case study.</p>
        )}

        {caseStudyId && !loading && !error && scenarios.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="text-sm" style={{ minWidth: '100%' }}>
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 min-w-[170px] text-xs uppercase tracking-wide text-gray-500">Category</th>
                  <th className="text-left px-3 py-2 min-w-[260px] text-xs uppercase tracking-wide text-gray-500">Metric</th>
                  {orderedScenarios.map(sc => {
                    const badge = comparisonBadges[sc.id];
                    const badgeColorCls = badge?.direction === 'up'
                      ? 'bg-red-50 text-red-600'
                      : badge?.direction === 'down'
                        ? 'bg-green-50 text-green-700'
                        : 'bg-gray-100 text-gray-500';
                    const BadgeIcon = badge?.direction === 'up' ? TrendingUp : badge?.direction === 'down' ? TrendingDown : Minus;
                    return (
                      <th key={sc.id} className="text-center px-3 py-2 min-w-[150px]">
                        <div className="font-semibold text-wpBlue leading-tight font-inter">{sc.name}</div>
                        <div className="text-[11px] text-gray-500 mt-0.5 font-inter">
                          {sc.year || '—'}
                          {sc.id === baselineId ? ' · Baseline' : ''}
                        </div>
                        {badge && (
                          <div className={`mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap ${badgeColorCls}`}>
                            <BadgeIcon size={10} /> {badge.label}
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groupedMetrics.map(group => {
                  const meta = DRIVER_META[group.driver] || null;
                  return group.rows.map((metric, idx) => (
                    <tr key={metric.key} className="border-b border-gray-100 last:border-b-0">
                      {idx === 0 && (
                        <td rowSpan={group.rows.length} className="px-3 py-2 text-gray-700 align-top border-r border-gray-100 bg-wpWhite">
                          <div className="flex items-center gap-2 pt-1">
                            {meta?.icon && <img src={meta.icon} alt={meta.label} className="w-8 h-8 shrink-0" />}
                            <span className="text-xs uppercase tracking-wide text-gray-600 font-semibold">{meta?.label || group.driver}</span>
                          </div>
                        </td>
                      )}
                      <td className="px-3 py-2 text-gray-700 font-inter">{metric.label}</td>
                      {orderedScenarios.map(sc => {
                        const applicable = isMetricApplicableForScenario(metric.key, sc);
                        if (!applicable) {
                          return <td key={`${metric.key}-${sc.id}`} className="px-3 py-2 text-center"><span className="text-gray-400">—</span></td>;
                        }
                        const val      = sc.metrics?.[metric.key];
                        const valueStr = formatMetricValue(val, metric.value_format);
                        if (viewMode === 'values' || sc.id === baselineId) {
                          return (
                            <td key={`${metric.key}-${sc.id}`} className="px-3 py-2 text-center">
                              <span className={`font-semibold font-inter ${sc.id === baselineId ? 'text-wpBlue' : 'text-gray-700'}`}>{valueStr}</span>
                            </td>
                          );
                        }
                        const baselineApplicable = isMetricApplicableForScenario(metric.key, baselineScenario);
                        const base  = baselineApplicable ? baselineMetrics?.[metric.key] : null;
                        const delta = computeMetricDelta(base, val, metric.delta_mode || 'relative_pct');
                        const direction = metric.color_direction || 'positive_good';
                        let deltaColor = 'text-gray-700';
                        if (delta !== null && delta !== 0) {
                          if (direction === 'neutral')       deltaColor = 'text-wpBlue';
                          else if (direction === 'positive_good') deltaColor = delta > 0 ? 'text-green-700' : 'text-red-600';
                          else if (direction === 'negative_good') deltaColor = delta > 0 ? 'text-red-600'   : 'text-green-700';
                        }
                        return (
                          <td key={`${metric.key}-${sc.id}`} className="px-3 py-2 text-center">
                            {delta === null ? (
                              <span className="text-gray-400">—</span>
                            ) : (
                              <span className={`font-semibold font-inter ${deltaColor}`}>
                                {formatDeltaValue(delta, metric.delta_mode || 'relative_pct')}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ));
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
