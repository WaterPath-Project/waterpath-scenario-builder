import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import useCaseStudyBySlug from '../hooks/useCaseStudyBySlug';
import {
  formatMetricValue,
  formatDeltaValue,
  computeMetricDelta,
  isMetricApplicableForScenario,
  DRIVER_META,
} from './driverMetricUtils';

// ── Model outcome helpers ────────────────────────────────────────────────────

const RISK_ROUTE_ORDER = ['drinking', 'swimming', 'flooding', 'open_drain', 'playing', 'washing_clothes'];
const RISK_ROUTE_LABELS = {
  drinking: 'Drinking water',
  swimming: 'Swimming',
  flooding: 'Floodwater',
  open_drain: 'Open drains',
  playing: 'Children playing',
  washing_clothes: 'Washing clothes',
};

function sumIsoTotals(isoTotals) {
  if (!isoTotals) return null;
  const vals = Object.values(isoTotals);
  if (vals.length === 0) return null;
  const total = vals.reduce((s, v) => s + (Number(v) || 0), 0);
  return total > 0 ? total : null;
}

function formatRisk(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const percentage = Number(value) * 100;
  if (percentage === 0) return '0%';
  if (Math.abs(percentage) < 0.01) return `${percentage.toExponential(2)}%`;
  return `${percentage.toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
}

function formatScientific(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '0';
  return number.toExponential(2).replace('e+', 'e');
}

function formatOutcomeDelta(baseValue, value, deltaMode) {
  if (baseValue == null || value == null) return null;
  const base = Number(baseValue);
  const current = Number(value);
  if (!Number.isFinite(base) || !Number.isFinite(current)) return null;
  if (deltaMode === 'risk_pp') {
    const percentagePoints = (current - base) * 100;
    return `${percentagePoints >= 0 ? '+' : ''}${percentagePoints.toFixed(2)} pp`;
  }
  const delta = computeMetricDelta(base, current, 'relative_pct');
  return delta == null ? null : formatDeltaValue(delta, 'relative_pct');
}

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
  const tableRef = useRef(null);

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

  // Surface-water and land emission totals (sum across areas).
  useEffect(() => {
    const toFetch = scenarios.filter(s => scenarioOutputs[s.id] && emissionTotals[s.id] === undefined);
    if (toFetch.length === 0) return;
    toFetch.forEach(s => {
      setEmissionTotals(prev => ({ ...prev, [s.id]: null })); // mark in-flight
      axios.get(`/api/scenarios/${s.id}/output-files`)
        .then(({ data }) => {
          const files     = data.files || [];
          const waterFile = files.find(f => f.includes('surface_water_emissions') && f.endsWith('.csv'));
          const landFile  = files.find(f => f.includes('land_emissions') && f.endsWith('.csv'));
          return Promise.all([
            waterFile ? axios.get(`/api/scenarios/${s.id}/output-csv-data/${waterFile}`) : null,
            landFile ? axios.get(`/api/scenarios/${s.id}/output-csv-data/${landFile}`) : null,
          ]);
        })
        .then(([waterRes, landRes]) => {
          setEmissionTotals(prev => ({
            ...prev,
            [s.id]: {
              water: sumIsoTotals(waterRes?.data?.iso_totals),
              land: sumIsoTotals(landRes?.data?.iso_totals),
            },
          }));
        })
        .catch(() => { /* leave as null */ });
    });
  }, [scenarios, scenarioOutputs]); // eslint-disable-line

  // Average annual stream concentration (proxy for drinking-water exposure).
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

  // Population-weighted annual QMRA risk, combined and by exposure pathway.
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
          setRiskTotals(prev => ({
            ...prev,
            [s.id]: res.data?.population_weighted?.risk ?? null,
          }));
        })
        .catch(() => { /* leave as null — no QMRA output */ });
    });
  }, [scenarios, scenarioOutputs]); // eslint-disable-line

  const outcomeRows = useMemo(() => {
    const routeKeys = new Set();
    Object.values(riskTotals).forEach(risks => {
      Object.keys(risks || {}).forEach(key => {
        if (key !== 'combined') routeKeys.add(key);
      });
    });
    const orderedRoutes = [
      ...RISK_ROUTE_ORDER.filter(key => routeKeys.has(key)),
      ...[...routeKeys].filter(key => !RISK_ROUTE_ORDER.includes(key)).sort(),
    ];
    return [
      { key: 'risk-combined', label: 'Annual risk · Combined', value: id => riskTotals[id]?.combined, format: formatRisk, deltaMode: 'risk_pp' },
      ...orderedRoutes.map(route => ({
        key: `risk-${route}`,
        label: `Annual risk · ${RISK_ROUTE_LABELS[route] || route.replaceAll('_', ' ')}`,
        value: id => riskTotals[id]?.[route],
        format: formatRisk,
        deltaMode: 'risk_pp',
      })),
      { key: 'concentration', label: 'Mean annual concentration (particles/L)', value: id => concentrationTotals[id], format: formatScientific, deltaMode: 'relative_pct' },
      { key: 'water-emissions', label: 'Surface-water emissions (particles/year)', value: id => emissionTotals[id]?.water, format: formatScientific, deltaMode: 'relative_pct' },
      { key: 'land-emissions', label: 'Land emissions (particles/year)', value: id => emissionTotals[id]?.land, format: formatScientific, deltaMode: 'relative_pct' },
    ];
  }, [riskTotals, concentrationTotals, emissionTotals]);

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

  const handlePrintTable = () => {
    if (!tableRef.current) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.opener = null;
    printWindow.document.write(`<!doctype html>
      <html><head><title>Summary of changes</title><style>
        @page { size: landscape; margin: 10mm; }
        body { margin: 0; color: #1f2937; font-family: Arial, sans-serif; }
        h1 { margin: 0 0 4px; color: #0B4159; font-size: 18px; }
        p { margin: 0 0 14px; color: #6b7280; font-size: 11px; }
        table { width: 100%; border-collapse: collapse; font-size: 9px; }
        th, td { padding: 5px 6px; border: 1px solid #d1d5db; text-align: center; }
        th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
        thead { background: #EEF2F5; color: #0B4159; }
        img { display: none; }
        .summary-outcomes { border-top: 3px solid #0B4159; background: #f0f7f9; }
        .summary-outcomes > tr:first-child > td:first-child { background: #0B4159; color: white; font-weight: 700; }
      </style></head><body>
      <h1>Summary of changes</h1>
      <p>${baselineScenario ? `Baseline: ${baselineScenario.name}` : ''}</p>
      ${tableRef.current.outerHTML}
      </body></html>`);
    printWindow.document.close();
    printWindow.addEventListener('load', () => {
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    }, { once: true });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex-shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-wpBlue font-inter">Summary of changes</h2>
        
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePrintTable}
            className="inline-flex items-center gap-1.5 rounded-lg bg-wpGreen px-3 py-1.5 text-sm font-semibold text-wpBlue shadow-sm hover:bg-gray-50"
            title="Print summary table"
          >
            <Printer size={14} /> Print table
          </button>
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-500">
            <span className="uppercase tracking-wide">Select SSP:</span>
            <select
              value={selectedSsp}
              onChange={(e) => setSelectedSsp(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-wpBlue shadow-sm focus:border-wpBlue focus:outline-none"
            >
              <option value="all">All SSPs</option>
              {sspOptions.map(ssp => (
                <option key={ssp} value={ssp}>{ssp}</option>
              ))}
            </select>
          </label>
          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm font-semibold">
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
            <table ref={tableRef} className="text-sm" style={{ minWidth: '100%' }}>
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 min-w-[170px] text-sm uppercase tracking-wide text-gray-500">Category</th>
                  <th className="text-left px-3 py-2 min-w-[260px] text-sm uppercase tracking-wide text-gray-500">Metric</th>
                  {orderedScenarios.map(sc => (
                      <th key={sc.id} className="text-center px-3 py-2 min-w-[150px]">
                        <div className="font-semibold text-wpBlue leading-tight font-inter">{sc.name}</div>
                        <div className="text-[11px] text-gray-500 mt-0.5 font-inter">
                          {sc.year || '—'}
                          {sc.id === baselineId ? ' · Baseline' : ''}
                        </div>
                      </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedMetrics.map(group => {
                  const meta = DRIVER_META[group.driver] || null;
                  const neutralDriver = group.driver === 'Hydrology' || group.driver === 'Exposure pathways';
                  return group.rows.map((metric, idx) => (
                    <tr key={metric.key} className="border-b border-gray-100 last:border-b-0">
                      {idx === 0 && (
                        <td rowSpan={group.rows.length} className="px-3 py-2 text-gray-700 align-top border-r border-gray-100 bg-wpWhite">
                          <div className="flex items-center gap-2 pt-1">
                            {meta?.icon && <img src={meta.icon} alt={meta.label} className="w-8 h-8 shrink-0" />}
                            <span className="text-sm uppercase tracking-wide text-gray-600 font-semibold">{meta?.label || group.driver}</span>
                          </div>
                        </td>
                      )}
                      <td className="px-3 py-2 text-gray-700 font-inter">
                        {metric.label}{group.driver === 'Exposure pathways' ? ' (events/year)' : ''}
                      </td>
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
                              <span className={`font-semibold font-inter ${!neutralDriver && sc.id === baselineId ? 'text-wpBlue' : 'text-gray-700'}`}>{valueStr}</span>
                            </td>
                          );
                        }
                        const baselineApplicable = isMetricApplicableForScenario(metric.key, baselineScenario);
                        const base  = baselineApplicable ? baselineMetrics?.[metric.key] : null;
                        const delta = computeMetricDelta(base, val, metric.delta_mode || 'relative_pct');
                        const direction = metric.color_direction || 'positive_good';
                        let deltaColor = 'text-gray-700';
                        if (!neutralDriver && delta !== null && delta !== 0) {
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
              <tbody className="summary-outcomes border-t-4 border-wpGreen bg-wpGreen/5">
                {outcomeRows.map((outcome, index) => (
                  <tr key={outcome.key} className="border-b border-wpGreen/10 last:border-b-0">
                    {index === 0 && (
                      <td rowSpan={outcomeRows.length} className="border-r border-wpGreen/20 bg-wpGreen px-3 py-3 align-top text-white">
                        <div className="pt-1 text-sm text-wpBlue font-bold uppercase tracking-wide">Model results</div>
                      </td>
                    )}
                    <td className="px-3 py-2 font-semibold text-wpBlue font-inter">{outcome.label}</td>
                    {orderedScenarios.map(sc => {
                      const value = outcome.value(sc.id);
                      const showValue = viewMode === 'values' || sc.id === baselineId;
                      const deltaText = showValue
                        ? null
                        : formatOutcomeDelta(outcome.value(baselineId), value, outcome.deltaMode);
                      const deltaNumber = value == null || outcome.value(baselineId) == null
                        ? null
                        : Number(value) - Number(outcome.value(baselineId));
                      const valueText = showValue ? outcome.format(value) : deltaText;
                      const colorClass = showValue || deltaNumber === 0
                        ? 'text-gray-800'
                        : deltaNumber > 0 ? 'text-red-600' : 'text-green-700';
                      return (
                        <td key={`${outcome.key}-${sc.id}`} className="px-3 py-2 text-center">
                          <span className={`font-semibold tabular-nums font-inter ${valueText == null ? 'text-gray-400' : colorClass}`}>
                            {valueText ?? '—'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
