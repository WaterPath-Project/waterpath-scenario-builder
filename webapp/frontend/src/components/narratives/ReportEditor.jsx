/**
 * ReportEditor.jsx
 * ================
 *
 * Step 2 of the narratives flow: review the generated sections, edit them,
 * regenerate them, and export the report as PDF.
 */

import React, { useMemo, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, Download, Eye, Loader2, RefreshCw, Save } from 'lucide-react';

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
    (report.scenarios || []).forEach((s) => { map[s.id] = s.name; });
    return map;
  }, [report.scenarios]);

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
          label: section.scenario_id ? (scenarioNames[section.scenario_id] || 'Scenario') : 'Front matter',
          sections: [],
        };
        out.push(current);
      }
      current.sections.push(section);
    });
    return out;
  }, [report.sections, scenarioNames]);

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

  const includedCount = (report.sections || []).filter((s) => s.include !== false).length;

  return (
    <div className="max-w-4xl mx-auto">
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

      {groups.map((group) => (
        <section key={group.key} className="mb-8">
          <h3 className="text-sm font-outfit font-semibold text-wpGray-500 uppercase tracking-wide mb-3 pb-1 border-b border-wpGray-200">
            {group.label}
          </h3>
          {group.sections.map((section) => (
            <SectionEditor key={section.id} section={section} onChange={updateSection} />
          ))}
        </section>
      ))}
    </div>
  );
};

export default ReportEditor;
