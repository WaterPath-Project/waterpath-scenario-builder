import React, { useState, useEffect } from 'react';
import { Save, Edit3, Trash2, FileText, Calendar } from 'lucide-react';
import useScenarioStore from '../store/scenarioStore';

const ScenarioDetailView = ({ scenarioId, selectedCaseStudy }) => {
  const { 
    scenarios, 
    tempScenarios, 
    updateTempScenario, 
    updateScenario,
    deleteTempScenario, 
    saveScenario 
  } = useScenarioStore();
  
  // Find the scenario (either temp or persistent)
  const scenario = [...scenarios, ...tempScenarios].find(s => s.id === scenarioId);
  
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(scenario?.isTemp || false);
  
  // Local form state to handle changes
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    ssp: '',
    year: '',
    additional_notes: ''
  });

  // Update form data when scenario changes
  useEffect(() => {
    if (scenario) {
      setFormData({
        name: scenario.name || '',
        description: scenario.description || '',
        ssp: scenario.ssp || '',
        year: scenario.year || '',
        additional_notes: scenario.additional_notes || ''
      });
    }
  }, [scenario]);

  if (!scenario) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center text-gray-500">
          <FileText className="mx-auto mb-4 text-gray-300" size={48} />
          <p>Scenario not found</p>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    if (scenario.isTemp) {
      setIsSaving(true);
      try {
        await saveScenario(scenario.id, formData);
        setIsEditing(false);
      } catch (error) {
        alert('Failed to save scenario: ' + error.message);
      } finally {
        setIsSaving(false);
      }
    } else {
      // Update existing persistent scenario
      setIsSaving(true);
      try {
        await updateScenario(scenario.id, formData);
        setIsEditing(false);
      } catch (error) {
        alert('Failed to update scenario: ' + error.message);
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete "${formData.name || scenario.name}"?`)) {
      deleteTempScenario(scenario.id);
    }
  };

  const handleFieldUpdate = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
    
    // For temp scenarios, also update the store immediately for live updates
    if (scenario.isTemp) {
      updateTempScenario(scenario.id, { [field]: value });
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <FileText className="text-wpBlue-500" size={24} />
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {formData.name || scenario.name || 'Untitled Scenario'}
            </h2>
            <p className="text-sm text-gray-500">
              {scenario.isTemp ? 'Temporary scenario (not saved)' : 'Saved scenario'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          {!isEditing ? (
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center space-x-1 px-3 py-1 text-sm text-wpBlue-600 hover:text-wpBlue-700 hover:bg-wpBlue-50 rounded transition-colors"
            >
              <Edit3 size={16} />
              <span>Edit</span>
            </button>
          ) : (
            <div className="flex items-center space-x-2">
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center space-x-1 px-3 py-1 text-sm bg-wpBlue-500 text-white hover:bg-wpBlue-600 disabled:opacity-50 rounded transition-colors"
              >
                <Save size={16} />
                <span>{isSaving ? 'Saving...' : 'Save'}</span>
              </button>
              <button
                onClick={() => {
                  setIsEditing(false);
                  // Reset form data to original values
                  setFormData({
                    name: scenario.name || '',
                    description: scenario.description || '',
                    ssp: scenario.ssp || '',
                    year: scenario.year || '',
                    additional_notes: scenario.additional_notes || ''
                  });
                }}
                className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
          
          {scenario.isTemp && (
            <button
              onClick={handleDelete}
              className="flex items-center space-x-1 px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
            >
              <Trash2 size={16} />
              <span>Delete</span>
            </button>
          )}
        </div>
      </div>

      {/* Scenario Details */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              {isEditing ? (
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleFieldUpdate('name', e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
                  placeholder="Enter scenario name"
                />
              ) : (
                <p className="text-gray-900">{formData.name || 'Untitled'}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              {isEditing ? (
                <textarea
                  value={formData.description}
                  onChange={(e) => handleFieldUpdate('description', e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
                  rows={3}
                  placeholder="Enter scenario description"
                />
              ) : (
                <p className="text-gray-900">{formData.description || 'No description'}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SSP (Shared Socioeconomic Pathway)
                </label>
                {isEditing ? (
                  <select
                    value={formData.ssp}
                    onChange={(e) => handleFieldUpdate('ssp', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
                  >
                    <option value="">Select SSP</option>
                    <option value="SSP1">SSP1 - Sustainability</option>
                    <option value="SSP2">SSP2 - Middle of the Road</option>
                    <option value="SSP3">SSP3 - Regional Rivalry</option>
                    <option value="SSP4">SSP4 - Inequality</option>
                    <option value="SSP5">SSP5 - Fossil-fueled Development</option>
                  </select>
                ) : (
                  <p className="text-gray-900">{formData.ssp || 'Not specified'}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Year
                </label>
                {isEditing ? (
                  <select
                    value={formData.year}
                    onChange={(e) => handleFieldUpdate('year', parseInt(e.target.value))}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
                  >
                    <option value="">Select Year</option>
                    <option value="2025">2025</option>
                    <option value="2030">2030</option>
                    <option value="2050">2050</option>
                    <option value="2100">2100</option>
                  </select>
                ) : (
                  <p className="text-gray-900">{formData.year || 'Not specified'}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Additional Notes
              </label>
              {isEditing ? (
                <textarea
                  value={formData.additional_notes}
                  onChange={(e) => handleFieldUpdate('additional_notes', e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
                  rows={2}
                  placeholder="Additional notes or comments"
                />
              ) : (
                <p className="text-gray-900">{formData.additional_notes || 'No additional notes'}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <label className="block text-gray-500 mb-1">
                  <Calendar size={16} className="inline mr-1" />
                  Created
                </label>
                <p className="text-gray-900">
                  {scenario.created_at ? new Date(scenario.created_at).toLocaleDateString() : 'Not available'}
                </p>
              </div>
              <div>
                <label className="block text-gray-500 mb-1">
                  <Calendar size={16} className="inline mr-1" />
                  Updated
                </label>
                <p className="text-gray-900">
                  {scenario.updated_at ? new Date(scenario.updated_at).toLocaleDateString() : 'Not available'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Data Section */}
      {scenario.data && scenario.data.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">Scenario Data</h3>
            <p className="text-sm text-gray-500">
              {scenario.data.length} data points
            </p>
          </div>
          <div className="p-4 max-h-64 overflow-y-auto">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {Object.keys(scenario.data[0] || {}).map(key => (
                      <th key={key} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {scenario.data.slice(0, 10).map((row, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      {Object.values(row).map((value, cellIdx) => (
                        <td key={cellIdx} className="px-3 py-2 text-gray-900">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {scenario.data.length > 10 && (
                <div className="p-2 text-center text-sm text-gray-500">
                  ... and {scenario.data.length - 10} more rows
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScenarioDetailView;
