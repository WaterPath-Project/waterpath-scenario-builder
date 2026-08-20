/**
 * ReportSetupPanel.jsx
 * ====================
 *
 * Step 1 of the narratives flow: pick the scenarios that the report should
 * describe, name it, and choose the risk quantile used for the QMRA sections.
 */

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, Loader2 } from 'lucide-react';

const QUANTILES = [
  { value: 0.025, label: 'Lower bound (2.5%)' },
  { value: 0.5, label: 'Median (50%)' },
  { value: 0.975, label: 'Upper bound (97.5%)' },
];

const ReportSetupPanel = ({ caseStudyId, onCancel, onCreated }) => {
  const [scenarios, setScenarios] = useState([]);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [quantile, setQuantile] = useState(0.5);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      axios.get(`/api/case-studies/${caseStudyId}/analytics`),
      axios.get(`/api/case-studies/${caseStudyId}/context`),
    ])
      .then(([scenarioRes, contextRes]) => {
        if (cancelled) return;
        setScenarios(scenarioRes.data.scenarios || []);
        setTitle(contextRes.data?.title || contextRes.data?.name || 'Scenario report');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load scenarios');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [caseStudyId]);

  const baseline = useMemo(
    () => scenarios.find((s) => s.is_baseline) || null,
    [scenarios],
  );
  // Only scenarios the model has already been run for can be described: the
  // report's maps and risk sections read from their output folder.
  const comparable = useMemo(
    () => scenarios.filter((s) => !s.is_baseline && s.has_outputs),
    [scenarios],
  );
  const withoutResults = useMemo(
    () => scenarios.filter((s) => !s.is_baseline && !s.has_outputs),
    [scenarios],
  );

  const toggle = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await axios.post(`/api/case-studies/${caseStudyId}/reports`, {
        title,
        subtitle,
        quantile,
        // Preserve the order the scenarios appear in, not the click order.
        scenario_ids: comparable.filter((s) => selected.includes(s.id)).map((s) => s.id),
      });
      onCreated(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate the report');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <button
        onClick={onCancel}
        className="flex items-center gap-1 text-sm text-wpGray-500 hover:text-wpBlue mb-4"
      >
        <ArrowLeft size={14} /> Back to reports
      </button>

      <h2 className="text-xl font-outfit font-semibold text-wpBlue mb-1">New narrative report</h2>
      <p className="text-sm text-wpGray-500 mb-6">
        The report always compares the selected scenarios against the baseline. Only scenarios that
        have model results can be included.
      </p>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      <label className="block text-xs font-medium text-wpGray-500 uppercase tracking-wide mb-1">Title</label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        className="w-full mb-4 px-3 py-2 border border-wpGray-300 rounded-lg text-sm focus:ring-2 focus:ring-wpBlue focus:border-transparent"
      />

      <label className="block text-xs font-medium text-wpGray-500 uppercase tracking-wide mb-1">Subtitle (optional)</label>
      <input
        value={subtitle}
        onChange={(e) => setSubtitle(e.target.value)}
        maxLength={200}
        className="w-full mb-4 px-3 py-2 border border-wpGray-300 rounded-lg text-sm focus:ring-2 focus:ring-wpBlue focus:border-transparent"
      />

      <label className="block text-xs font-medium text-wpGray-500 uppercase tracking-wide mb-1">Risk quantile</label>
      <select
        value={quantile}
        onChange={(e) => setQuantile(Number(e.target.value))}
        className="w-full mb-6 px-3 py-2 border border-wpGray-300 rounded-lg text-sm focus:ring-2 focus:ring-wpBlue focus:border-transparent"
      >
        {QUANTILES.map((q) => (
          <option key={q.value} value={q.value}>{q.label}</option>
        ))}
      </select>

      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-wpGray-500 uppercase tracking-wide">Scenarios</span>
        {comparable.length > 0 && (
          <button
            onClick={() => setSelected(selected.length === comparable.length ? [] : comparable.map((s) => s.id))}
            className="text-xs text-wpBlue hover:underline"
          >
            {selected.length === comparable.length ? 'Clear all' : 'Select all'}
          </button>
        )}
      </div>

      {loading && <div className="text-sm text-wpGray-500">Loading scenarios…</div>}

      {!loading && baseline && (
        <div className="px-3 py-2 mb-2 bg-wpGray-100 border border-wpGray-200 rounded-lg text-sm text-wpGray-600">
          Baseline: <span className="font-medium text-wpBlue">{baseline.name}</span>
        </div>
      )}

      {!loading && comparable.length === 0 && (
        <div className="text-sm text-wpGray-500">
          This case study has no scenarios with model results besides the baseline.
        </div>
      )}

      <div className="space-y-1 mb-6 max-h-80 overflow-y-auto">
        {comparable.map((scenario) => (
          <label
            key={scenario.id}
            className="flex items-center gap-3 px-3 py-2 border border-wpGray-200 rounded-lg cursor-pointer hover:border-wpBlue"
          >
            <input
              type="checkbox"
              checked={selected.includes(scenario.id)}
              onChange={() => toggle(scenario.id)}
              className="accent-wpBlue"
            />
            <span className="text-sm text-wpBlue font-medium">{scenario.name}</span>
            <span className="text-xs text-wpGray-500 ml-auto">
              {[scenario.ssp, scenario.year].filter(Boolean).join(' · ')}
            </span>
          </label>
        ))}
      </div>

      {!loading && withoutResults.length > 0 && (
        <p className="-mt-4 mb-6 text-xs text-wpGray-500">
          {withoutResults.length} scenario{withoutResults.length === 1 ? '' : 's'} not listed because
          the model has not been run for {withoutResults.length === 1 ? 'it' : 'them'} yet.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={submitting || selected.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-wpBlue text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          Generate report
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-wpGray-500 hover:text-wpBlue"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default ReportSetupPanel;
