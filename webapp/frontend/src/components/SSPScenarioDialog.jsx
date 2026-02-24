import React, { useState } from 'react';
import { Plus, Minus, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './Dialog';

const SSPScenarioDialog = ({ isOpen, onClose, onSubmit }) => {
  const [step, setStep] = useState(1); // 1: Basic Info, 2: Configuration
  const [formData, setFormData] = useState({
    scenarioName: '',
    sspScenario: '1',
    pathogen: 'Rotavirus',
    year: '2030',
    projectionMethod: 'isimip',
    modifiers: []
  });

  const [errors, setErrors] = useState({});
  const [isLoadingISIMIP, setIsLoadingISIMIP] = useState(false);

  console.log('SSPScenarioDialog render - isOpen:', isOpen, 'step:', step);

  const sspOptions = [
    { value: '1', label: 'SSP1 - Sustainability' },
    { value: '2', label: 'SSP2 - Middle of the Road' },
    { value: '3', label: 'SSP3 - Regional Rivalry' },
    { value: '4', label: 'SSP4 - Inequality' },
    { value: '5', label: 'SSP5 - Fossil-fueled Development' }
  ];

  const pathogenOptions = [
    { value: 'Rotavirus', label: 'Rotavirus' },
    { value: 'Cryptosporidium', label: 'Cryptosporidium' }
  ];

  const yearOptions = [
    { value: '2030', label: '2030' },
    { value: '2050', label: '2050' },
    { value: '2100', label: '2100' }
  ];

  const projectionMethodOptions = [
    { value: 'isimip', label: 'Pull ISIMIP projections' },
    { value: 'custom', label: 'Custom assumptions' }
  ];

  const modifierOptions = [
    { value: 'population_growth', label: 'Population growth rate' },
    { value: 'migration_rate', label: 'Migration rate' },
    { value: 'hdi_development', label: 'Human Development Index (HDI) development' },
    { value: 'sewer_annual_change', label: 'Sewer coverage annual change' },
    { value: 'wastewater_treatment_change', label: 'Wastewater treatment annual change' },
    { value: 'cattle_growth', label: 'Livestock: Cattle growth rate' },
    { value: 'poultry_growth', label: 'Livestock: Poultry growth rate' },
    { value: 'pork_growth', label: 'Livestock: Pork growth rate' }
  ];

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // Clear error for this field if it exists
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: ''
      }));
    }
  };

  const handleAddModifier = () => {
    const newModifier = {
      id: Date.now(),
      type: 'population_growth',
      value: 0,
      min: 0,
      max: 100
    };
    setFormData(prev => ({
      ...prev,
      modifiers: [...prev.modifiers, newModifier]
    }));
  };

  const handleRemoveModifier = (id) => {
    setFormData(prev => ({
      ...prev,
      modifiers: prev.modifiers.filter(m => m.id !== id)
    }));
  };

  const handleModifierChange = (id, field, value) => {
    setFormData(prev => ({
      ...prev,
      modifiers: prev.modifiers.map(m =>
        m.id === id ? { ...m, [field]: value } : m
      )
    }));
  };

  const validateForm = () => {
    const newErrors = {};
    
    if (!formData.scenarioName.trim()) {
      newErrors.scenarioName = 'Scenario name is required';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validateForm()) {
      if (formData.projectionMethod === 'isimip') {
        setIsLoadingISIMIP(true);
        setStep(2);
        setTimeout(() => {
          setIsLoadingISIMIP(false);
        }, 2000);
      } else {
        setStep(2);
      }
    }
  };

  const handleBack = () => {
    setStep(1);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (validateForm()) {
      // If ISIMIP is selected, show loading effect
      if (formData.projectionMethod === 'isimip') {
        setIsLoadingISIMIP(true);
        // Simulate ISIMIP data fetch
        setTimeout(() => {
          setIsLoadingISIMIP(false);
          onSubmit(formData);
          handleReset();
        }, 2000); // 2 second loading simulation
      } else {
        // Custom assumptions - submit immediately
        onSubmit(formData);
        handleReset();
      }
    }
  };

  const handleReset = () => {
    // Reset form
    setFormData({
      scenarioName: '',
      sspScenario: '1',
      pathogen: 'Rotavirus',
      year: '2030',
      projectionMethod: 'isimip',
      modifiers: []
    });
    setErrors({});
    setIsLoadingISIMIP(false);
    setStep(1); // Reset to first step
  };

  const handleCancel = () => {
    handleReset();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Create New SSP-Based Scenario {step === 2 && '- Configuration'}
          </DialogTitle>
          <DialogDescription>
            {step === 1 
              ? 'Define basic scenario information (Step 1 of 2)'
              : 'Configure data projection method and modifiers (Step 2 of 2)'
            }
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 mt-4">
          {/* Step 1: Basic Information */}
          {step === 1 && (
            <>
              {/* Scenario Name */}
              <div>
                <label htmlFor="scenarioName" className="block text-sm font-medium text-gray-700 mb-2">
                  Scenario Name *
                </label>
                <input
                  type="text"
                  id="scenarioName"
                  name="scenarioName"
                  value={formData.scenarioName}
                  onChange={handleInputChange}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.scenarioName ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder="Enter scenario name"
                />
                {errors.scenarioName && (
                  <p className="mt-1 text-sm text-red-600">{errors.scenarioName}</p>
                )}
              </div>

              {/* SSP Scenario */}
              <div>
                <label htmlFor="sspScenario" className="block text-sm font-medium text-gray-700 mb-2">
                  SSP Scenario *
                </label>
                <select
                  id="sspScenario"
                  name="sspScenario"
                  value={formData.sspScenario}
                  onChange={handleInputChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {sspOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Pathogen */}
              <div>
                <label htmlFor="pathogen" className="block text-sm font-medium text-gray-700 mb-2">
                  Waterborne Pathogen *
                </label>
                <select
                  id="pathogen"
                  name="pathogen"
                  value={formData.pathogen}
                  onChange={handleInputChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {pathogenOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Year */}
              <div>
                <label htmlFor="year" className="block text-sm font-medium text-gray-700 mb-2">
                  Year *
                </label>
                <select
                  id="year"
                  name="year"
                  value={formData.year}
                  onChange={handleInputChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {yearOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Data Projection Method */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Data Projection Method *
            </label>
            <div className="space-y-3">
              {projectionMethodOptions.map(option => (
                <label
                  key={option.value}
                  className="flex items-start p-4 border border-gray-300 rounded-md cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <input
                    type="radio"
                    name="projectionMethod"
                    value={option.value}
                    checked={formData.projectionMethod === option.value}
                    onChange={handleInputChange}
                    className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="ml-3">
                    <span className="block text-sm font-medium text-gray-900">
                      {option.label}
                    </span>
                    {option.value === 'isimip' && (
                      <span className="block text-xs text-gray-500 mt-1">
                        Automatically fetch data from ISIMIP database based on SSP scenario and year
                      </span>
                    )}
                    {option.value === 'custom' && (
                      <span className="block text-xs text-gray-500 mt-1">
                        Manually define custom assumptions for the scenario
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

              {/* Step 1 Navigation */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </>
          )}

          {/* Step 2: Configuration */}
          {step === 2 && (
            <>

          {/* Custom Modifiers - Only show when Custom assumptions is selected */}
          {formData.projectionMethod === 'custom' && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-gray-700">
                  Custom Modifiers
                </label>
                <button
                  type="button"
                  onClick={handleAddModifier}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
                >
                  <Plus size={16} />
                  Add Modifier
                </button>
              </div>

              {formData.modifiers.length === 0 ? (
                <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-md border-2 border-dashed border-gray-300">
                  <p className="text-sm">No modifiers added yet</p>
                  <p className="text-xs mt-1">Click "Add Modifier" to add custom assumptions</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                  {formData.modifiers.map((modifier) => (
                    <div key={modifier.id} className="p-4 bg-gray-50 rounded-md border border-gray-200">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 space-y-3">
                          {/* Modifier Type Dropdown */}
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              Modifier Type
                            </label>
                            <select
                              value={modifier.type}
                              onChange={(e) => handleModifierChange(modifier.id, 'type', e.target.value)}
                              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              {modifierOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Value, Min, Max in a row */}
                          <div className="grid grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">
                                Rate of change
                              </label>
                              <input
                                type="number"
                                step="0.01"
                                value={modifier.value}
                                onChange={(e) => handleModifierChange(modifier.id, 'value', parseFloat(e.target.value) || 0)}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="0.00"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">
                                Min
                              </label>
                              <input
                                type="number"
                                step="0.01"
                                value={modifier.min}
                                onChange={(e) => handleModifierChange(modifier.id, 'min', parseFloat(e.target.value) || 0)}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Min"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">
                                Max
                              </label>
                              <input
                                type="number"
                                step="0.01"
                                value={modifier.max}
                                onChange={(e) => handleModifierChange(modifier.id, 'max', parseFloat(e.target.value) || 0)}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Max"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Remove Button */}
                        <button
                          type="button"
                          onClick={() => handleRemoveModifier(modifier.id)}
                          className="mt-6 p-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
                          title="Remove modifier"
                        >
                          <Minus size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ISIMIP Loading Indicator */}
          {isLoadingISIMIP && (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
              <div className="flex items-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                <span className="text-sm font-medium text-blue-900">
                  Pulling ISIMIP projections...
                </span>
              </div>
            </div>
          )}

          {/* Step 2 Navigation Buttons */}
          <div className="flex items-center justify-between pt-4 border-t">
            <button
              type="button"
              onClick={handleBack}
              disabled={isLoadingISIMIP}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
              Back
            </button>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleCancel}
                disabled={isLoadingISIMIP}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoadingISIMIP}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoadingISIMIP ? 'Loading...' : 'Create Scenario'}
              </button>
            </div>
          </div>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default SSPScenarioDialog;
