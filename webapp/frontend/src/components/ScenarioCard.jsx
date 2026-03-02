import React, { useState, useRef, useEffect } from 'react';
import { BarChart3, Edit, Save, X, Trash2 } from 'lucide-react';
import useScenarioStore from '../store/scenarioStore';

const ScenarioCard = ({ scenario, selectedCaseStudy }) => {
  const [isEditing, setIsEditing] = useState(scenario.isEditing || false);
  const [scenarioName, setScenarioName] = useState(scenario.name);
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const nameInputRef = useRef(null);

  const { 
    updateTempScenario, 
    deleteTempScenario, 
    saveScenario, 
    deleteScenario,
    setEditingScenario,
    setActiveTab 
  } = useScenarioStore();

  useEffect(() => {
    if (isEditing && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    if (scenario.isTemp) {
      setIsEditing(true);
      setEditingScenario(scenario.id);
    }
  };

  const handleSaveName = () => {
    if (scenario.isTemp) {
      updateTempScenario(scenario.id, { name: scenarioName });
    }
    setIsEditing(false);
    setEditingScenario(null);
  };

  const handleCancelEdit = () => {
    setScenarioName(scenario.name);
    setIsEditing(false);
    setEditingScenario(null);
  };

  const handleDelete = async () => {
    try {
      await deleteScenario(scenario.id);
      setShowDeleteConfirm(false);
    } catch (error) {
      alert('Failed to delete scenario: ' + error.message);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = () => {
    handleDelete();
  };

  const handleDeleteCancel = () => {
    setShowDeleteConfirm(false);
  };

  const handleSaveScenario = async () => {
    setIsSaving(true);
    try {
      await saveScenario(scenario.id);
    } catch (error) {
      alert('Failed to save scenario: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCardClick = () => {
    // Switch to the scenario's tab for detailed view
    setActiveTab(scenario.id);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div 
      className={`p-4 rounded-lg border transition-all duration-200 cursor-pointer bg-wpWhite-100 ${
        scenario.isTemp 
          ? 'bg-gradient-to-r from-yellow-50 to-orange-50 border-orange-200 hover:shadow-md' 
          : 'bg-gradient-to-r from-wpBlue-50 to-wpGreen-50 border-gray-200 hover:shadow-md'
      }`}
      onClick={handleCardClick}
    >
      {/* Header with name and actions */}
      <div className="flex items-center justify-between mb-2">
        {isEditing ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              ref={nameInputRef}
              type="text"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              onKeyDown={handleKeyPress}
              onBlur={handleSaveName}
              className="text-lg font-medium bg-white border border-gray-300 rounded px-2 py-1 flex-1 focus:ring-2 focus:ring-wpBlue-500 focus:border-transparent"
              placeholder="Scenario name"
            />
            <button
              onClick={handleSaveName}
              className="p-1 text-green-600 hover:bg-green-100 rounded"
              title="Save name"
            >
              <Save size={16} />
            </button>
            <button
              onClick={handleCancelEdit}
              className="p-1 text-gray-600 hover:bg-gray-100 rounded"
              title="Cancel"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-1">
            <h4 className={`text-lg font-medium ${
              scenario.isTemp ? 'text-orange-800' : 'text-wpBlue-800'
            }`}>
              {scenario.name}
            </h4>
            {scenario.isTemp && (
              <span className="text-xs px-2 py-1 bg-yellow-200 text-yellow-800 rounded-full">
                Unsaved
              </span>
            )}
          </div>
        )}
        
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {scenario.isTemp ? (
            <>
              {!isEditing && (
                <button
                  onClick={handleStartEdit}
                  className="p-1 text-orange-600 hover:bg-orange-100 rounded"
                  title="Edit name"
                >
                  <Edit size={16} />
                </button>
              )}
              <button
                onClick={handleSaveScenario}
                disabled={isSaving}
                className="p-1 text-green-600 hover:bg-green-100 rounded disabled:opacity-50"
                title="Save scenario"
              >
                <Save size={16} />
              </button>
              <button
                onClick={handleDeleteClick}
                className="p-1 text-red-600 hover:bg-red-100 rounded"
                title="Delete scenario"
              >
                <Trash2 size={16} />
              </button>
            </>
          ) : (
            <BarChart3 className="text-wpBlue-400" size={24} />
          )}
        </div>
      </div>

      {/* Scenario details */}
      <div className="space-y-2">
        <p className={`font-semibold text-xl ${
          scenario.isTemp ? 'text-orange-600' : 'text-wpBlue-600'
        }`}>
          {scenario.description || scenario.value || 'No description'}
        </p>
        

        {/* Show SSP, Pathogen and Year if available */}
        {(scenario.ssp || scenario.year || scenario.pathogen || scenario.is_baseline) && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
            {scenario.is_baseline && (
              <span className="bg-gray-100 text-gray-700 px-2 py-1 rounded text-xs font-medium">
                Baseline
              </span>
            )}
            {scenario.ssp && (
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs">
                {scenario.ssp}
              </span>
            )}
            {scenario.pathogen && (
              <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded text-xs">
                {scenario.pathogen}
              </span>
            )}
            {scenario.year && (
              <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs">
                {scenario.year}
              </span>
            )}
          </div>
        )}
        
        <div className="flex items-center text-sm text-gray-500">
          <span>Updated: </span>
          <span className="ml-1">
            {new Date(scenario.updated_at || Date.now()).toLocaleDateString()}
          </span>
        </div>

        {scenario.isTemp && (
          <div className="mt-3 p-2 bg-yellow-100 border border-yellow-300 rounded text-sm">
            <p className="text-yellow-800">
              <strong>Draft:</strong> This scenario is stored in your browser. 
              Click Save to persist it to the server and create the CSV file.
            </p>
          </div>
        )}

        {isSaving && (
          <div className="mt-3 flex items-center gap-2 text-sm text-green-600">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600"></div>
            <span>Saving scenario...</span>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-lg p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-2 text-gray-900">
              Delete Scenario
            </h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to delete "{scenario.name}"? This action cannot be undone and will permanently remove the scenario folder and all its data.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleDeleteCancel}
                className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-white bg-red-600 hover:bg-red-700 rounded"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScenarioCard;
