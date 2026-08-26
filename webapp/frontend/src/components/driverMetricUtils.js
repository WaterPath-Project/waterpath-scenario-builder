/**
 * driverMetricUtils.js
 * ====================
 *
 * Shared formatting/derivation helpers for driver-comparison metrics
 * (`GET /api/case-studies/<id>/driver-comparison`).
 *
 * Used by ScenarioSummaryView (the /summary table) and the /narratives report
 * builder so that the on-screen table and the generated PDF agree exactly.
 */

import HumanPopulationIcon from '../../assets/icons/human_population.svg';
import ConcentrationsIcon from '../../assets/icons/concentrations.svg';
import SanitationIcon from '../../assets/icons/sanitation.svg';
import WastewaterTreatmentIcon from '../../assets/icons/wastewater_treatment.svg';
import LivestockPopulationIcon from '../../assets/icons/livestock_population.svg';
import ManureManagementIcon from '../../assets/icons/manure_management.svg';
import ProductionSystemsIcon from '../../assets/icons/production_systems.svg';
import RiskIcon from '../../assets/icons/risk.svg';

export function computeDeltaPct(base, value) {
  if (base === null || base === undefined || value === null || value === undefined) return null;
  const b = Number(base);
  const v = Number(value);
  if (!Number.isFinite(b) || !Number.isFinite(v)) return null;
  if (Math.abs(b) < 1e-9) return Math.abs(v) < 1e-9 ? 0 : null;
  return ((v - b) / Math.abs(b)) * 100;
}

export function formatMetricValue(value, valueFormat) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const v = Number(value);
  if (valueFormat === 'percent') return `${v.toFixed(1)}%`;
  if (valueFormat === 'hdi') return v.toFixed(3);
  if (valueFormat === 'integer') return Math.round(v).toLocaleString();
  if (valueFormat === 'probability') return v < 0.001 && v > 0 ? v.toExponential(2) : v.toFixed(4);
  return v.toFixed(2);
}

export function formatDeltaValue(delta, deltaMode) {
  if (delta === null || delta === undefined || Number.isNaN(Number(delta))) return 'n/a';
  const v = Number(delta);
  if (deltaMode === 'pp') return `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
  if (deltaMode === 'absolute') return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export function computeMetricDelta(base, value, deltaMode) {
  if (base === null || base === undefined || value === null || value === undefined) return null;
  const b = Number(base);
  const v = Number(value);
  if (!Number.isFinite(b) || !Number.isFinite(v)) return null;
  if (deltaMode === 'pp' || deltaMode === 'absolute') return v - b;
  return computeDeltaPct(b, v);
}

export function isWastewaterMetric(k) { return k.startsWith('wastewater_'); }
export function isShareMetric(k)      { return k.startsWith('wastewater_share_'); }
export function isPointOnlyMetric(k)  { return k === 'wastewater_facility_count' || k === 'wastewater_total_capacity'; }

export function isMetricApplicableForScenario(metricKey, scenario) {
  if (!scenario || !isWastewaterMetric(metricKey)) return true;
  const mode = scenario.wwtp_mode;
  if (mode === 'point' && isShareMetric(metricKey)) return false;
  if (mode === 'area'  && isPointOnlyMetric(metricKey)) return false;
  return true;
}

export const DRIVER_META = {
  Population:               { icon: HumanPopulationIcon,      label: 'Population' },
  Hydrology:                { icon: ConcentrationsIcon,       label: 'Hydrology' },
  Sanitation:               { icon: SanitationIcon,           label: 'Sanitation' },
  'Wastewater treatment':   { icon: WastewaterTreatmentIcon,  label: 'Wastewater treatment' },
  'Livestock population':   { icon: LivestockPopulationIcon,  label: 'Livestock population' },
  'Manure management':      { icon: ManureManagementIcon,     label: 'Manure management' },
  'Production systems':     { icon: ProductionSystemsIcon,    label: 'Production systems' },
  'Exposure pathways':      { icon: RiskIcon,                  label: 'Exposure pathways' },
  Risk:                     { icon: RiskIcon,                 label: 'Risk' },
};

/**
 * Driver order used by the report builder, mirroring the /scenarios sidebar.
 */
export const DRIVER_ORDER = [
  'Population',
  'Sanitation',
  'Wastewater treatment',
  'Livestock population',
  'Manure management',
  'Production systems',
  'Hydrology',
  'Exposure pathways',
  'Risk',
];
