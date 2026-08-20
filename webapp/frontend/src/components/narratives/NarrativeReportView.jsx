/**
 * NarrativeReportView.jsx
 * =======================
 *
 * Top-level view for `/narratives/:csSlug`. Lists the reports stored with the
 * case study, creates new ones from a scenario selection, and hosts the editor.
 */

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { FileText, Plus, Trash2, RefreshCw, Database } from 'lucide-react';

import ReportSetupPanel from './ReportSetupPanel';
import ReportEditor from './ReportEditor';

/** Every state of this view sits on the same white sheet. */
const Card = ({ children }) => (
  <div className="p-6 font-inter">
    <div className="max-w-5xl mx-auto bg-wpWhite-100 border border-wpBlue-100 rounded-lg shadow-sm p-6">
      {children}
    </div>
  </div>
);

const NarrativeReportView = ({ caseStudyId }) => {
  const [reports, setReports] = useState([]);
  const [activeReport, setActiveReport] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadReports = useCallback(async () => {
    if (!caseStudyId) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`/api/case-studies/${caseStudyId}/reports`);
      setReports(data.reports || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load reports');
    } finally {
      setLoading(false);
    }
  }, [caseStudyId]);

  useEffect(() => {
    setActiveReport(null);
    setCreating(false);
    loadReports();
  }, [loadReports]);

  const openReport = async (reportId) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`/api/case-studies/${caseStudyId}/reports/${reportId}`);
      setActiveReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open report');
    } finally {
      setLoading(false);
    }
  };

  const deleteReport = async (reportId) => {
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    try {
      await axios.delete(`/api/case-studies/${caseStudyId}/reports/${reportId}`);
      if (activeReport?.report_id === reportId) setActiveReport(null);
      loadReports();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete report');
    }
  };

  if (!caseStudyId) {
    return (
      <Card>
        <div className="p-8 text-center text-wpGray-500">
          Select a case study to build a narrative report.
        </div>
      </Card>
    );
  }

  if (activeReport) {
    return (
      <Card>
        <ReportEditor
          caseStudyId={caseStudyId}
          report={activeReport}
          onReportChange={setActiveReport}
          onClose={() => { setActiveReport(null); loadReports(); }}
        />
      </Card>
    );
  }

  if (creating) {
    return (
      <Card>
        <ReportSetupPanel
          caseStudyId={caseStudyId}
          onCancel={() => setCreating(false)}
          onCreated={(report) => { setCreating(false); setActiveReport(report); }}
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-outfit font-semibold text-wpBlue">Narrative reports</h2>
          <p className="text-sm text-wpGray-500">
            Generate a written report from the scenarios of this case study, edit the text, and export it as PDF.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadReports}
            className="p-2 text-wpGray-500 hover:text-wpBlue rounded-lg hover:bg-wpGray-100"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 px-4 py-2 bg-wpBlue text-white text-sm font-medium rounded-lg hover:opacity-90"
          >
            <Plus size={16} />
            New report
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      {loading && <div className="text-sm text-wpGray-500">Loading…</div>}

      {!loading && reports.length === 0 && (
        <div className="border border-dashed border-wpGray-300 rounded-xl p-10 text-center">
          <FileText size={32} className="mx-auto text-wpGray-300 mb-3" />
          <p className="text-sm text-wpGray-500 mb-4">No reports yet for this case study.</p>
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-wpBlue text-white text-sm font-medium rounded-lg hover:opacity-90"
          >
            Create the first report
          </button>
        </div>
      )}

      <div className="space-y-2">
        {reports.map((report) => (
          <div
            key={report.report_id}
            className="flex items-center justify-between border border-wpGray-200 rounded-lg px-4 py-3 hover:border-wpBlue transition-colors"
          >
            <button className="text-left flex-1" onClick={() => openReport(report.report_id)}>
              <div className="text-sm font-medium text-wpBlue">{report.title}</div>
              <div className="text-xs text-wpGray-500">
                {report.scenario_ids.length} scenario{report.scenario_ids.length === 1 ? '' : 's'}
                {' · '}{report.section_count} sections
                {report.updated_at ? ` · updated ${report.updated_at.slice(0, 10)}` : ''}
              </div>
            </button>
            <button
              onClick={() => window.open(
                `/api/case-studies/${caseStudyId}/reports/${report.report_id}/appendix.pdf`,
                '_blank', 'noopener',
              )}
              className="p-2 text-wpGray-400 hover:text-wpBlue rounded-lg hover:bg-wpGray-100"
              title="Download model input data (appendix PDF)"
            >
              <Database size={16} />
            </button>
            <button
              onClick={() => deleteReport(report.report_id)}
              className="p-2 text-wpGray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
              title="Delete report"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default NarrativeReportView;
