/**
 * ReportEditor.jsx
 * ================
 *
 * Step 2 of the narratives flow: review the generated sections, edit them,
 * regenerate them, and export the report as PDF.
 */

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Eye, Loader2, RefreshCw, Save } from 'lucide-react';

import { formatMetricValue, isMetricApplicableForScenario } from '../driverMetricUtils';
import RegenerateDialog from './RegenerateDialog';
import SectionEditor from './SectionEditor';

const ReportEditor = ({ caseStudyId, report, onReportChange, onClose }) => {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const base = `/api/case-studies/${caseStudyId}/reports/${report.report_id}`;

  const scenarioNames = useMemo(() => {
    const map = {};
    if (report.baseline?.id) map[report.baseline.id] = report.baseline.name || 'Baseline';
    (report.scenarios || []).forEach((s) => { map[s.id] = s.name; });
    return map;
  }, [report.baseline, report.scenarios]);

  // Sections arrive in report order; group them so each scenario reads as a
  // chapter, matching the generated PDF.
  const groups = useMemo(() => {
    const ordered = [...(report.sections || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const out = [];
    let current = null;
    ordered.forEach((section) => {
      const key = section.scenario_id || '__front__';
      if (!current || current.key !== key) {
        current = {
          key,
          label: section.scenario_id ? (scenarioNames[section.scenario_id] || 'Scenario') : 'Report overview',
          sections: [],
        };
        out.push(current);
      }
      current.sections.push(section);
    });
    return out;
  }, [report.sections, scenarioNames]);

  const browserItems = useMemo(() => {
    const sections = new Map((report.sections || []).map((section) => [section.id, section]));
    const items = (report.figures || []).map((figure) => {
      const section = sections.get(figure.section_id);
      const scenarioName = scenarioNames[section?.scenario_id];
      const title = section?.title || figure.caption || 'Map';
      return {
        id: `figure-${figure.id}`,
        type: 'figure',
        title: scenarioName ? `${scenarioName}: ${title}` : title,
        figure,
      };
    });

    const snapshot = report.table_snapshot || {};
    const metricsByDriver = new Map();
    (snapshot.metrics || []).forEach((metric) => {
      if (!metricsByDriver.has(metric.driver)) metricsByDriver.set(metric.driver, []);
      metricsByDriver.get(metric.driver).push(metric);
    });
    metricsByDriver.forEach((metrics, driver) => {
      items.push({ id: `table-${driver}`, type: 'table', title: driver, metrics, snapshot });
    });
    return items;
  }, [report.figures, report.sections, report.table_snapshot, scenarioNames]);

  const [activeBrowserIndex, setActiveBrowserIndex] = useState(0);
  useEffect(() => setActiveBrowserIndex(0), [report.report_id]);
  const activeBrowserItem = browserItems[activeBrowserIndex] || null;

  const changeBrowserItem = (nextIndex) => {
    const count = browserItems.length;
    if (count) setActiveBrowserIndex((nextIndex + count) % count);
  };

  const updateSection = (updated) => {
    onReportChange({
      ...report,
      sections: report.sections.map((s) => (s.id === updated.id ? updated : s)),
    });
    setDirty(true);
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await axios.put(base, {
        title: report.title,
        subtitle: report.subtitle,
        sections: report.sections.map((s) => ({
          id: s.id,
          title: s.title,
          include: s.include,
          edited_md: s.edited_md ?? null,
        })),
      });
      onReportChange(data);
      setDirty(false);
      setNotice('Saved');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the report');
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async (payload) => {
    setShowRegenerate(false);
    setRegenerating(true);
    setError(null);
    try {
      const { data } = await axios.post(`${base}/regenerate`, payload);
      onReportChange(data);
      setDirty(false);
      setNotice(payload.overwrite_edited ? 'Regenerated, edits discarded' : 'Regenerated, edits kept');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not regenerate the report');
    } finally {
      setRegenerating(false);
    }
  };

  const openPreview = () => window.open(`${base}/preview`, '_blank', 'noopener');
  const downloadPdf = () => window.open(`${base}/pdf`, '_blank', 'noopener');
  const downloadSummaryCsv = () => window.open(`${base}/summary.csv`, '_blank', 'noopener');

  const includedCount = (report.sections || []).filter((s) => s.include !== false).length;

  return (
    <div className="w-full">
      <button
        onClick={() => {
          if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
          onClose();
        }}
        className="flex items-center gap-1 text-sm text-wpGray-500 hover:text-wpBlue mb-4"
      >
        <ArrowLeft size={14} /> Back to reports
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex-1">
          <input
            value={report.title || ''}
            onChange={(e) => { onReportChange({ ...report, title: e.target.value }); setDirty(true); }}
            maxLength={200}
            className="w-full text-xl font-outfit font-semibold text-wpBlue bg-transparent border-b border-transparent hover:border-wpGray-300 focus:border-wpBlue focus:outline-none py-1"
          />
          <div className="text-xs text-wpGray-500 mt-1">
            {includedCount} of {(report.sections || []).length} sections included
            {' · '}risk quantile {report.quantile}
            {dirty && <span className="text-amber-700"> · unsaved changes</span>}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowRegenerate(true)}
            disabled={regenerating}
            className="flex items-center gap-2 px-3 py-2 text-sm text-wpGray-600 border border-wpGray-300 rounded-lg hover:border-wpBlue hover:text-wpBlue disabled:opacity-40"
            title="Rebuild the text from the current scenario data"
          >
            {regenerating ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Regenerate
          </button>
          <button
            onClick={openPreview}
            className="flex items-center gap-2 px-3 py-2 text-sm text-wpGray-600 border border-wpGray-300 rounded-lg hover:border-wpBlue hover:text-wpBlue"
          >
            <Eye size={15} /> Preview
          </button>
          <button
            onClick={downloadPdf}
            className="flex items-center gap-2 px-3 py-2 text-sm text-wpGray-600 border border-wpGray-300 rounded-lg hover:border-wpBlue hover:text-wpBlue"
          >
            <Download size={15} /> PDF
          </button>
          <button
            onClick={downloadSummaryCsv}
            className="flex items-center gap-2 px-3 py-2 text-sm text-wpGray-600 border border-wpGray-300 rounded-lg hover:border-wpBlue hover:text-wpBlue"
            title="Download the driver and model-results summary table"
          >
            <Download size={15} /> Summary CSV
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-wpBlue text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            Save
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
          {notice}
        </div>
      )}

      {showRegenerate && (
        <RegenerateDialog
          sections={report.sections || []}
          quantile={report.quantile}
          onCancel={() => setShowRegenerate(false)}
          onConfirm={regenerate}
        />
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)]">
        <div className="min-w-0">
          {groups.map((group) => (
            <section key={group.key} className="mb-8">
              <div className="mb-4 flex items-center gap-4">
                <h3 className="shrink-0 font-outfit text-lg font-semibold text-wpBlue">
                  {group.label}
                </h3>
                <div className="h-0.5 flex-1 bg-wpBlue-100" />
              </div>
              {group.sections.map((section) => (
                <div key={section.id}>
                  <SectionEditor section={section} onChange={updateSection} />
                </div>
              ))}
            </section>
          ))}
        </div>

        <aside className="xl:sticky xl:top-0 overflow-hidden rounded-lg border border-wpGray-200 bg-white">
          <div className="flex items-center gap-2 border-b border-wpGray-200 bg-wpGray-100 px-3 py-2">
            <button
              onClick={() => changeBrowserItem(activeBrowserIndex - 1)}
              disabled={browserItems.length < 2}
              className="p-1.5 text-wpGray-500 hover:text-wpBlue disabled:opacity-30"
              title="Previous map or table"
            >
              <ChevronLeft size={17} />
            </button>
            <select
              value={activeBrowserIndex}
              onChange={(event) => setActiveBrowserIndex(Number(event.target.value))}
              className="min-w-0 flex-1 rounded-md border border-wpGray-200 bg-white px-2 py-1.5 text-sm font-medium text-wpBlue focus:border-wpBlue focus:outline-none"
              aria-label="Browse maps and reference tables"
            >
              {browserItems.map((item, index) => (
                <option key={item.id} value={index}>
                  {item.type === 'figure' ? 'Map' : 'Reference table'}: {item.title}
                </option>
              ))}
            </select>
            <span className="whitespace-nowrap text-xs text-wpGray-500">
              {browserItems.length ? activeBrowserIndex + 1 : 0}/{browserItems.length}
            </span>
            <button
              onClick={() => changeBrowserItem(activeBrowserIndex + 1)}
              disabled={browserItems.length < 2}
              className="p-1.5 text-wpGray-500 hover:text-wpBlue disabled:opacity-30"
              title="Next map or table"
            >
              <ChevronRight size={17} />
            </button>
          </div>

          <div className="max-h-[68vh] overflow-auto">
            {activeBrowserItem?.type === 'figure' ? (
              <>
                <div className="relative bg-white">
                  <img
                    key={activeBrowserItem.figure.id}
                    src={`${base}/figures/${activeBrowserItem.figure.id}`}
                    alt={activeBrowserItem.figure.caption || 'Report figure'}
                    className="block w-full object-contain"
                    style={{ opacity: activeBrowserItem.figure.opacity ?? 1 }}
                  />
                  {activeBrowserItem.figure.outline?.paths?.length > 0 && (
                    <svg
                      viewBox={activeBrowserItem.figure.outline.view_box}
                      preserveAspectRatio="none"
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      {activeBrowserItem.figure.outline.paths.map((path, index) => (
                        <path
                          key={index}
                          d={path}
                          fill="none"
                          stroke="#1e293b"
                          strokeWidth="1.25"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    </svg>
                  )}
                </div>
                {activeBrowserItem.figure.legend && (
                  <FigureLegend legend={activeBrowserItem.figure.legend} />
                )}
                {activeBrowserItem.figure.caption && (
                  <p className="border-t border-wpGray-200 px-4 py-3 text-xs text-wpGray-500">
                    {activeBrowserItem.figure.caption}
                  </p>
                )}
              </>
            ) : activeBrowserItem?.type === 'table' ? (
              <ReferenceTable item={activeBrowserItem} />
            ) : (
              <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-wpGray-400">
                This report has no maps or reference tables.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

const FigureLegend = ({ legend }) => (
  <div className="border-t border-wpGray-200 px-5 pb-3 pt-3">
    <div className="h-3 rounded-sm" style={{ background: legend.gradient }} />
    <div className="relative h-5">
      {(legend.ticks || []).map((tick, index) => (
        <span
          key={`${tick.pos}-${index}`}
          className="absolute top-1 -translate-x-1/2 whitespace-nowrap text-[10px] text-wpGray-500 first:translate-x-0 last:-translate-x-full"
          style={{ left: `${tick.pos * 100}%` }}
        >
          {tick.power !== undefined
            ? (tick.power === 0 ? '1' : <>10<sup>{tick.power}</sup></>)
            : <>{tick.mantissa}{tick.exponent !== null && tick.exponent !== undefined && (
              <>×10<sup>{tick.exponent}</sup></>
            )}</>}
        </span>
      ))}
    </div>
    <p className="text-xs text-wpBlue-900">
      {legend.label || `${legend.unit}${legend.log_scale ? ', logarithmic colour scale' : ''}`}
    </p>
  </div>
);

const ReferenceTable = ({ item }) => {
  const baseline = item.snapshot.baseline || {};
  const scenarios = item.snapshot.scenarios || [];
  const columns = [baseline, ...scenarios];

  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 bg-wpGray-100 text-wpBlue">
        <tr>
          <th className="px-3 py-2 text-left font-semibold">{item.title}</th>
          {columns.map((column, index) => (
            <th key={column.id || index} className="px-3 py-2 text-right font-semibold">
              {column.name || (index ? 'Scenario' : 'Baseline')}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {item.metrics.map((metric) => (
          <tr key={metric.key} className="border-t border-wpGray-200 odd:bg-white even:bg-wpGray-100/40">
            <td className="px-3 py-2 text-wpGray-600">{metric.label}</td>
            {columns.map((column, index) => {
              const applicable = index === 0 || isMetricApplicableForScenario(metric.key, column);
              const value = applicable ? formatMetricValue(column.metrics?.[metric.key], metric.value_format) : 'n/a';
              return <td key={column.id || index} className="whitespace-nowrap px-3 py-2 text-right text-wpGray-700">{value}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default ReportEditor;
