import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import HumanPopulationIcon from '../../assets/icons/human_population.svg';
import SanitationIcon from '../../assets/icons/sanitation.svg';
import WastewaterTreatmentIcon from '../../assets/icons/wastewater_treatment.svg';
import LivestockPopulationIcon from '../../assets/icons/livestock_population.svg';
import ProductionSystemsIcon from '../../assets/icons/production_systems.svg';

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

function isMetricApplicableForScenario(metricKey, scenario) {
  if (!scenario || !isWastewaterMetric(metricKey)) return true;
  const mode = scenario.wwtp_mode;
  if (mode === 'point' && isShareMetric(metricKey)) return false;
  if (mode === 'area'  && isPointOnlyMetric(metricKey)) return false;
  return true;
}

const DRIVER_META = {
  Population:               { icon: HumanPopulationIcon,      label: 'Population' },
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
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [viewMode, setViewMode] = useState('delta'); // 'delta' | 'values'

  useEffect(() => {
    if (!caseStudyId) { setData(null); return; }
    setLoading(true);
    setError('');
    axios.get(`/api/case-studies/${caseStudyId}/driver-comparison`)
      .then(({ data }) => setData(data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load driver comparison'))
      .finally(() => setLoading(false));
  }, [caseStudyId]);

  const scenarios    = data?.scenarios    || [];
  const metrics      = data?.metrics      || [];
  const baselineId   = data?.baseline_scenario_id || null;
  const baselineScenario = scenarios.find(s => s.id === baselineId) || null;
  const baselineMetrics  = baselineScenario?.metrics || {};

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
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 min-w-[170px] text-xs uppercase tracking-wide text-gray-500">Category</th>
                  <th className="text-left px-3 py-2 min-w-[260px] text-xs uppercase tracking-wide text-gray-500">Metric</th>
                  {scenarios.map(sc => (
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
                  return group.rows.map((metric, idx) => (
                    <tr key={metric.key} className="border-b border-gray-100 last:border-b-0">
                      {idx === 0 && (
                        <td rowSpan={group.rows.length} className="px-3 py-2 text-gray-700 align-top border-r border-gray-100 bg-wpWhite">
                          <div className="flex items-center gap-2 pt-1">
                            {meta?.icon && <img src={meta.icon} alt={meta.label} className="w-6 h-6" />}
                            <span className="text-xs uppercase tracking-wide text-gray-600 font-semibold">{meta?.label || group.driver}</span>
                          </div>
                        </td>
                      )}
                      <td className="px-3 py-2 text-gray-700 font-inter">{metric.label}</td>
                      {scenarios.map(sc => {
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
        )}
      </div>
    </div>
  );
}
