import React, { useState, useEffect } from 'react';
import { Calendar, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './Dialog';
import useConfigStore from '../store/configStore';

const ScenarioMetadataDialog = ({ isOpen, onClose, scenario, onSave, requirePathogen = false }) => {
  const { pathogenOptions } = useConfigStore();
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    ssp: '',
    pathogen: '',
    year: '',
    additional_notes: ''
  });
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState({});

  // Update form data when scenario changes
  useEffect(() => {
    if (scenario) {
      const isBaseline = String(scenario.is_baseline).toLowerCase() === 'true';
      setFormData({
        name: scenario.name || '',
        description: scenario.description || scenario.notes || '',
        ssp: scenario.ssp || '',
        pathogen: scenario.pathogen || '',
        year: scenario.year || (isBaseline ? '2025' : ''),
        additional_notes: scenario.additional_notes || ''
      });
    }
  }, [scenario]);

  const handleChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
    // Clear error for this field
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const validateForm = () => {
    const newErrors = {};
    
    if (!formData.name || formData.name.trim() === '') {
      newErrors.name = 'Scenario name is required';
    }

    if (requirePathogen && !formData.pathogen) {
      newErrors.pathogen = 'Pathogen is required to run the model';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      return;
    }

    setIsSaving(true);
    try {
      await onSave(formData);
      onClose();
    } catch (error) {
      setErrors({ submit: error.message || 'Failed to save scenario metadata' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setErrors({});
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{requirePathogen ? 'Baseline Setup Required' : 'Edit Scenario Metadata'}</DialogTitle>
          <DialogDescription>
            {requirePathogen
              ? `Before working with "${scenario?.name || 'this scenario'}" please specify its pathogen.`
              : `Update the metadata for "${scenario?.name || 'this scenario'}"`}
          </DialogDescription>
        </DialogHeader>

        {requirePathogen && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 shrink-0" size={16} />
            <p>
              The <strong>baseline scenario</strong> does not have a pathogen specified.
              A pathogen is required to generate the model configuration and run the
              analytics. Please select one below.
            </p>
          </div>
        )}

        <div className="space-y-6 py-4">
          {/* Scenario Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Scenario Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              className={`w-full p-2 border rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent ${
                errors.name ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter scenario name"
            />
            {errors.name && (
              <p className="text-red-500 text-sm mt-1">{errors.name}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
              rows={3}
              placeholder="Enter scenario description"
            />
          </div>

          {/* SSP, Pathogen and Year */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                SSP (Shared Socioeconomic Pathway)
              </label>
              <select
                value={formData.ssp}
                onChange={(e) => handleChange('ssp', e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
              >
                <option value="">Select SSP</option>
                <option value="SSP1">SSP1 - Sustainability</option>
                <option value="SSP2">SSP2 - Middle of the Road</option>
                <option value="SSP3">SSP3 - Regional Rivalry</option>
                <option value="SSP4">SSP4 - Inequality</option>
                <option value="SSP5">SSP5 - Fossil-fueled Development</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Pathogen
                {requirePathogen && <span className="text-red-500 ml-1">*</span>}
              </label>
              <select
                value={formData.pathogen}
                onChange={(e) => handleChange('pathogen', e.target.value)}
                className={`w-full p-2 border rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent ${
                  errors.pathogen
                    ? 'border-red-500 ring-2 ring-red-300'
                    : requirePathogen && !formData.pathogen
                      ? 'border-amber-400 ring-2 ring-amber-200'
                      : 'border-gray-300'
                }`}
              >
                <option value="">Select Pathogen</option>
                {pathogenOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {errors.pathogen && (
                <p className="text-red-500 text-sm mt-1">{errors.pathogen}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Year
              </label>
              <select
                value={formData.year}
                onChange={(e) => handleChange('year', e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
              >
                <option value="">Select Year</option>
                <option value="2025">2025</option>
                <option value="2030">2030</option>
                <option value="2050">2050</option>
                <option value="2100">2100</option>
              </select>
            </div>
          </div>

          {/* Additional Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Additional Notes
            </label>
            <textarea
              value={formData.additional_notes}
              onChange={(e) => handleChange('additional_notes', e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
              rows={2}
              placeholder="Additional notes or comments"
            />
          </div>

          {/* Timestamps */}
          {scenario && (
            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200">
              <div>
                <label className="block text-sm text-gray-500 mb-1">
                  <Calendar size={16} className="inline mr-1" />
                  Created
                </label>
                <p className="text-sm text-gray-900">
                  {scenario.created_at ? new Date(scenario.created_at).toLocaleString() : 'Not available'}
                </p>
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">
                  <Calendar size={16} className="inline mr-1" />
                  Updated
                </label>
                <p className="text-sm text-gray-900">
                  {scenario.updated_at ? new Date(scenario.updated_at).toLocaleString() : 'Not available'}
                </p>
              </div>
            </div>
          )}

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-red-600 text-sm">{errors.submit}</p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium bg-wpGreen text-wpBlue hover:bg-wpGreen-800 disabled:opacity-50 rounded-lg transition-colors"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ScenarioMetadataDialog;
