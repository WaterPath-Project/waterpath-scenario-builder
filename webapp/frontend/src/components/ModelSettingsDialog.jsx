import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './Dialog';
import Spinner from './loading/Spinner';

export default function ModelSettingsDialog({ isOpen, onClose, caseStudyId }) {
  const [values, setValues] = useState({
    threshold_discharge: '1',
    runoff_fraction: '0.025',
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !caseStudyId) return;
    let cancelled = false;
    setValues({
      threshold_discharge: '1',
      runoff_fraction: '0.025',
    });
    setLoading(true);
    setError('');
    axios.get(`/api/case-studies/${caseStudyId}/model-settings`)
      .then(({ data }) => {
        if (!cancelled) {
          setValues({
            threshold_discharge: String(data.threshold_discharge),
            runoff_fraction: String(data.runoff_fraction),
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, caseStudyId]);

  const handleChange = (event) => {
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const thresholdDischarge = Number(values.threshold_discharge);
    const runoffFraction = Number(values.runoff_fraction);
    if (!Number.isFinite(thresholdDischarge) || thresholdDischarge < 0) {
      setError('Threshold discharge must be a number greater than or equal to 0.');
      return;
    }
    if (!Number.isFinite(runoffFraction) || runoffFraction < 0 || runoffFraction > 1) {
      setError('Runoff fraction must be a number between 0 and 1.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await axios.put(`/api/case-studies/${caseStudyId}/model-settings`, {
        threshold_discharge: thresholdDischarge,
        runoff_fraction: runoffFraction,
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Model settings</DialogTitle>
          <DialogDescription>
            These settings apply to every scenario in this case study.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size={24} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Threshold discharge</span>
              <input
                type="number"
                name="threshold_discharge"
                value={values.threshold_discharge}
                onChange={handleChange}
                min="0"
                step="any"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-wpBlue focus:outline-none focus:ring-1 focus:ring-wpBlue"
              />
              <span className="mt-1 block text-xs text-gray-400">YAML key: threshold_discharge</span>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Runoff fraction</span>
              <input
                type="number"
                name="runoff_fraction"
                value={values.runoff_fraction}
                onChange={handleChange}
                min="0"
                max="1"
                step="any"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-wpBlue focus:outline-none focus:ring-1 focus:ring-wpBlue"
              />
              <span className="mt-1 block text-xs text-gray-400">YAML key: runoff_fraction (0 to 1)</span>
            </label>

            {error && (
              <p role="alert" className="text-sm text-red-600">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !caseStudyId}
                className="flex items-center gap-2 rounded-lg bg-wpBlue px-4 py-2 text-sm font-semibold text-white hover:bg-wpBlue/90 disabled:opacity-40"
              >
                {saving && <Spinner size={15} />}
                Save settings
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
