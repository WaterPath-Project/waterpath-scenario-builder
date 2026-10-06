/**
 * NarrativeReportView.jsx
 * =======================
 *
 * Top-level view for `/narratives/:csSlug`. Lists the reports stored with the
 * case study, creates new ones from a scenario selection, and hosts the editor.
 */

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { FileText, Plus, Trash2, RefreshCw } from 'lucide-react';

import ReportSetupPanel from './ReportSetupPanel';
import ReportEditor from './ReportEditor';
import { LoadingState } from '../loading/Spinner';

/** Every state of this view sits on the same white sheet. */
const Card = ({ children }) => (
  <div className="p-6 font-inter">
    <div className="w-full max-w-[1600px] mx-auto bg-wpWhite-100 border border-wpBlue-100 rounded-lg shadow-sm p-6">
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

  return (
    <div className="flex h-full flex-col overflow-hidden font-inter">
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-wpWhite-200 bg-wpWhite px-6 py-4">
        <div>
          <h2 className="text-md font-outfit font-semibold text-wpBlue">Narrative reports</h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={activeReport?.report_id || ''}
            onChange={(event) => {
              setCreating(false);
              if (event.target.value) openReport(event.target.value);
              else setActiveReport(null);
            }}
            disabled={loading || reports.length === 0}
            className="min-w-56 max-w-80 rounded-lg border border-wpGray-300 bg-wpGray-200 px-3 py-2 text-sm text-wpBlue focus:border-wpBlue focus:outline-none focus:ring-2 focus:ring-wpBlue/20 disabled:bg-wpGray-50 disabled:text-wpGray-400 font-semibold"
            aria-label="Select report"
          >
            <option value="">{reports.length ? 'Select a report' : 'No reports yet'}</option>
            {reports.map((report) => (
              <option key={report.report_id} value={report.report_id}>{report.title}</option>
            ))}
          </select>
          <button
            onClick={loadReports}
            className="p-2 text-wpGray-500 hover:text-wpBlue rounded-lg hover:bg-wpGray-100"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => { setActiveReport(null); setCreating(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-wpCypress text-white text-sm font-medium rounded-lg hover:opacity-90"
          >
            <Plus size={16} />
            New report
          </button>
          {activeReport && (
            <button
              onClick={() => deleteReport(activeReport.report_id)}
              className="p-2 text-wpGray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
              title="Delete selected report"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <Card>
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      {loading && <LoadingState label="Loading reports…" />}

      {!loading && !activeReport && !creating && reports.length === 0 && (
        <div className="border border-dashed border-wpGray-300 rounded-xl p-10 text-center">
          <FileText size={32} className="mx-auto text-wpGray-300 mb-3" />
          <p className="text-sm text-wpGray-500 mb-4">No reports yet for this case study.</p>
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-wpCypress text-white text-sm font-medium rounded-lg hover:opacity-90"
          >
            Create the first report
          </button>
        </div>
      )}

      {creating && (
        <ReportSetupPanel
          caseStudyId={caseStudyId}
          onCancel={() => setCreating(false)}
          onCreated={(report) => { setCreating(false); setActiveReport(report); loadReports(); }}
        />
      )}

      {activeReport && !creating && (
        <ReportEditor
          caseStudyId={caseStudyId}
          report={activeReport}
          onReportChange={setActiveReport}
          onClose={() => { setActiveReport(null); loadReports(); }}
        />
      )}

      {!loading && !activeReport && !creating && reports.length > 0 && (
        <div className="py-16 text-center text-sm text-wpGray-500">
          Select a report above or create a new one.
        </div>
      )}
        </Card>
      </div>
    </div>
  );
};

export default NarrativeReportView;
