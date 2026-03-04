import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Edit3, Trash2, BarChart3, Play, RefreshCw, Loader2, ScrollText, BarChart2, CheckCircle, AlertTriangle } from 'lucide-react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import useScenarioStore from '../store/scenarioStore';
import DataGridView from './DataGridView';
import ScenarioMetadataDialog from './ScenarioMetadataDialog';
import PopulationPanel from './PopulationPanel';
import SanitationLadderPanel from './SanitationLadderPanel';
import WastewaterTreatmentPanel from './WastewaterTreatmentPanel';

// Import category icons
import HumanEmissionsIcon from '../../assets/icons/human_emissions.svg';
import LivestockEmissionsIcon from '../../assets/icons/livestock_emissions.svg';
import ConcentrationsIcon from '../../assets/icons/concentrations.svg';
import RiskIcon from '../../assets/icons/risk.svg';

// Import subcategory icons
import HumanPopulationIcon from '../../assets/icons/human_population.svg';
import SanitationIcon from '../../assets/icons/sanitation.svg';
import WastewaterTreatmentIcon from '../../assets/icons/wastewater_treatment.svg';
import LivestockPopulationIcon from '../../assets/icons/livestock_population.svg';
import ManureManagementIcon from '../../assets/icons/manure_management.svg';
import ProductionSystemsIcon from '../../assets/icons/production_systems.svg';
import FlowIcon from '../../assets/icons/flow.svg';
import DischargeIcon from '../../assets/icons/discharge.svg';
import RunoffIcon from '../../assets/icons/runoff.svg';
import RiverParametersIcon from '../../assets/icons/river_parameters.svg';
import ExposureDataIcon from '../../assets/icons/exposure_data.svg';
import PathogenPropertiesIcon from '../../assets/icons/pathogen_properties.svg';

// Run status pill config
const RUN_STATUS_CFG = {
  pending: { label: 'Queued',   cls: 'bg-yellow-100 text-yellow-700' },
  running: { label: 'Running\u2026', cls: 'bg-blue-100 text-blue-700' },
  success: { label: 'Done \u2713',   cls: 'bg-green-100 text-green-700' },
  error:   { label: 'Error',    cls: 'bg-red-100 text-red-700' },
  timeout: { label: 'Timeout',  cls: 'bg-orange-100 text-orange-700' },
};

// URL slug from scenario name
const toSlug = (name) => encodeURIComponent(name ?? '');

// Define categories and subcategories
const CATEGORIES = [
  {
    id: 'human-emissions',
    label: 'Human Emissions',
    icon: HumanEmissionsIcon,
    subcategories: [
      { id: 'population', label: 'Population', icon: HumanPopulationIcon },
      { id: 'sanitation', label: 'Sanitation', icon: SanitationIcon },
      { id: 'wastewater-treatment', label: 'Wastewater Treatment', icon: WastewaterTreatmentIcon },
    ]
  },
  {
    id: 'livestock-emissions',
    label: 'Livestock Emissions',
    icon: LivestockEmissionsIcon,
    subcategories: [
      { id: 'livestock-population', label: 'Livestock Population', icon: LivestockPopulationIcon },
      { id: 'manure-management', label: 'Manure Management', icon: ManureManagementIcon },
      { id: 'production-systems', label: 'Production Systems', icon: ProductionSystemsIcon },
    ]
  },
  {
    id: 'concentrations',
    label: 'Concentrations',
    icon: ConcentrationsIcon,
    subcategories: [
      { id: 'flow', label: 'Flow', icon: FlowIcon },
      { id: 'discharge', label: 'Discharge', icon: DischargeIcon },
      { id: 'runoff', label: 'Runoff', icon: RunoffIcon },
      { id: 'river-parameters', label: 'River Parameters', icon: RiverParametersIcon },
    ]
  },
  {
    id: 'risk',
    label: 'Risk',
    icon: RiskIcon,
    subcategories: [
      { id: 'exposure-data', label: 'Exposure Data', icon: ExposureDataIcon },
      { id: 'pathogen-properties', label: 'Pathogen Properties', icon: PathogenPropertiesIcon },
    ]
  }
];

const ScenarioDetailView = ({ scenarioId, selectedCaseStudy, caseStudySlug = '', initialCategory, initialSubcategory, onViewResults }) => {
  const { 
    scenarios, 
    tempScenarios, 
    updateTempScenario, 
    updateScenario,
    deleteTempScenario, 
    deleteScenario,
    saveScenario,
    metadataEditScenarioId,
    closeMetadataEditor,
    setScenarioDirty,
    needsRerunIds,
    setNeedsRerun,
  } = useScenarioStore();
  
  const navigate = useNavigate();

  // ── Run model state ────────────────────────────────────────────────────────
  const [scenarioInfo, setScenarioInfo] = useState(null);
  const [runId,     setRunId]     = useState(null);
  const [runMode,   setRunMode]   = useState(null);
  const [runStatus, setRunStatus] = useState('idle');
  const [runLoading, setRunLoading] = useState(false);
  const [runOutput,  setRunOutput]  = useState({ stdout: '', stderr: '' });
  const [showOutput, setShowOutput] = useState(false);
  const [glowpaLog,  setGlowpaLog]  = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [showLog,    setShowLog]    = useState(false);
  const needsRerun = needsRerunIds[scenarioId] ?? false;

  const pollRef = useRef(null);

  const canRun     = scenarioInfo?.readiness?.ready === true;
  const hasResults = runStatus === 'success' || !!scenarioInfo?.has_outputs;

  // Filter categories to those enabled by the case study (null/undefined means all)
  const enabledCategoryIds = selectedCaseStudy?.enabled_categories ?? null;
  const isCategoryEnabled = (id) => !enabledCategoryIds || enabledCategoryIds.includes(id);
  // All categories are shown; only enabled ones are interactive
  const availableCategories = CATEGORIES;

  // Find the scenario (either temp or persistent)
  const scenario = [...scenarios, ...tempScenarios].find(s => s.id === scenarioId);

  const validCat = (id) => CATEGORIES.find((c) => c.id === id && isCategoryEnabled(c.id));
  const validSub = (catId, subId) => CATEGORIES.find((c) => c.id === catId && isCategoryEnabled(c.id))?.subcategories.find((s) => s.id === subId);

  const [isMetadataDialogOpen, setIsMetadataDialogOpen] = useState(false);
  // Default to first *enabled* category
  const firstEnabled = CATEGORIES.find(c => isCategoryEnabled(c.id));
  const [activeCategory,    setActiveCategory]    = useState(() => validCat(initialCategory)                      ? initialCategory    : firstEnabled?.id);
  const [activeSubcategory, setActiveSubcategory] = useState(() => validSub(initialCategory, initialSubcategory)  ? initialSubcategory : firstEnabled?.subcategories[0]?.id);

  // Track which subcategories have unsaved changes
  const [dirtySubcategories, setDirtySubcategories] = useState({});

  const handleSubcatDirtyChange = useCallback((subcategoryId, isDirty) => {
    setDirtySubcategories((prev) => {
      const wasDirty = prev[subcategoryId];
      const next = { ...prev, [subcategoryId]: isDirty };
      const hasAnyDirty = Object.values(next).some(Boolean);
      setScenarioDirty(scenarioId, hasAnyDirty);
      // Transitioning dirty→clean means a save just happened
      if (wasDirty && !isDirty) setNeedsRerun(scenarioId, true);
      return next;
    });
  }, [scenarioId, setScenarioDirty, setNeedsRerun]);

  const isCategoryDirty = (categoryId) => {
    const cat = availableCategories.find((c) => c.id === categoryId);
    return cat?.subcategories.some((sub) => dirtySubcategories[sub.id]) ?? false;
  };

  // Derive overall dirty state
  const isDirty = Object.values(dirtySubcategories).some(Boolean);

  // Warn on browser tab close / hard refresh while dirty
  useEffect(() => {
    const handler = (e) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ── Fetch scenario readiness / has_outputs from analytics API ──────────────
  useEffect(() => {
    if (!selectedCaseStudy?.id || !scenarioId) return;
    axios.get(`/api/case-studies/${selectedCaseStudy.id}/analytics`)
      .then((res) => {
        const found = res.data?.scenarios?.find((s) => s.id === scenarioId);
        setScenarioInfo(found ?? null);
      })
      .catch(() => setScenarioInfo(null));
  }, [selectedCaseStudy?.id, scenarioId]);

  // ── Poll run status ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`/api/run-status/${runId}`);
        const data = res.data;
        setRunStatus(data.status);
        setRunOutput({ stdout: data.stdout || '', stderr: data.stderr || '' });
        if (['success', 'error', 'timeout'].includes(data.status)) {
          clearInterval(pollRef.current);
          setRunLoading(false);
          if (data.status === 'success') setNeedsRerun(scenarioId, false);
          // Refresh scenario info so has_outputs is up to date
          if (selectedCaseStudy?.id) {
            axios.get(`/api/case-studies/${selectedCaseStudy.id}/analytics`)
              .then((r) => {
                const found = r.data?.scenarios?.find((s) => s.id === scenarioId);
                setScenarioInfo(found ?? null);
              })
              .catch(() => {});
          }
        }
      } catch {
        clearInterval(pollRef.current);
        setRunLoading(false);
        setRunStatus('error');
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // ── Run model handler ──────────────────────────────────────────────────────
  const handleRunModel = async () => {
    setRunLoading(true);
    setRunStatus('pending');
    setShowOutput(false);
    setShowLog(false);
    try {
      const res = await axios.post(`/api/scenarios/${scenarioId}/run-model`);
      setRunId(res.data.run_id);
      setRunMode(res.data.mode);
    } catch (err) {
      setRunLoading(false);
      setRunStatus('error');
      setRunOutput({ stdout: '', stderr: err.response?.data?.error || err.message });
    }
  };

  // ── Fetch GloWPa execution log ─────────────────────────────────────────────
  const handleFetchLog = async () => {
    if (glowpaLog && showLog) { setShowLog(false); return; }
    setLogLoading(true);
    try {
      const res = await axios.get(`/api/scenarios/${scenarioId}/glowpa-log?tail=500`);
      setGlowpaLog(res.data);
      setShowLog(true);
      setShowOutput(false);
    } catch (err) {
      alert('Failed to fetch log: ' + (err.response?.data?.error || err.message));
    } finally {
      setLogLoading(false);
    }
  };
  
  // Open dialog when store triggers metadata editing for this scenario
  useEffect(() => {
    if (metadataEditScenarioId === scenarioId) {
      setIsMetadataDialogOpen(true);
      closeMetadataEditor(); // Clear the trigger
    }
  }, [metadataEditScenarioId, scenarioId, closeMetadataEditor]);
  
  // Sync from URL when user navigates via browser back/forward
  useEffect(() => {
    if (initialCategory && validCat(initialCategory)) {
      setActiveCategory(initialCategory);
      if (initialSubcategory && validSub(initialCategory, initialSubcategory)) {
        setActiveSubcategory(initialSubcategory);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCategory, initialSubcategory]);

  if (!scenario) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center text-gray-500">
          <BarChart3 className="mx-auto mb-4 text-gray-300" size={48} />
          <p>Scenario not found</p>
        </div>
      </div>
    );
  }

  const handleMetadataSave = async (formData) => {
    if (scenario.isTemp) {
      // For temp scenarios, update the temp scenario in the store
      updateTempScenario(scenario.id, formData);
    } else {
      // For persistent scenarios, call the update API
      await updateScenario(scenario.id, formData);
    }
  };

  const handleDelete = async () => {
    const confirmMessage = scenario.isTemp 
      ? `Are you sure you want to delete "${scenario.name}"? This temporary scenario will be removed from your browser.`
      : `Are you sure you want to delete "${scenario.name}"? This will permanently remove the scenario and its CSV file from the server.`;
    
    if (window.confirm(confirmMessage)) {
      try {
        await deleteScenario(scenario.id);
      } catch (error) {
        alert('Failed to delete scenario: ' + error.message);
      }
    }
  };



  const currentCategory = availableCategories.find(cat => cat.id === activeCategory);

  return (
    <div className="bg-wpWhite-100 h-full flex flex-col">
      {/* Header with actions */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center space-x-3">
            <BarChart3 className="text-wpBlue" size={24} />
            <div>
              <h2 className="text-xl font-semibold font-outfit text-wpBlue">
                {scenario.name || 'Untitled Scenario'}
              </h2>
              <p className="text-sm font-outfit text-wpBlue">
                {scenario.isTemp
                  ? 'Temporary scenario (not saved)'
                  : runStatus === 'pending' || runStatus === 'running'
                    ? <span className="flex items-center gap-1.5 text-xs" style={{ color: '#18B6A3' }}>
                        <span className="w-2 h-2 rounded-full bg-[#18B6A3] animate-pulse"/>
                        Running model…
                      </span>
                    : runStatus === 'success'
                      ? <span className="flex items-center gap-1.5 text-xs" style={{ color: '#9EB65B' }}>
                          <span className="w-2 h-2 rounded-full bg-[#9EB65B]"/>
                          Saved scenario
                        </span>
                      : runStatus === 'error'
                        ? <span className="flex items-center gap-1.5 text-xs text-red-500">
                            <span className="w-2 h-2 rounded-full bg-red-500"/>
                            Error during model run
                          </span>
                        : needsRerun
                          ? <span className="flex items-center gap-1.5 text-xs text-orange-500">
                            <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse"/>
                            Changed scenario (needs re-run)
                          </span>
                          : <span className="flex items-center gap-1.5 text-xs text-wpBlue">
                            <span className="w-2 h-2 rounded-full bg-wpBlue"/>
                            Saved scenario
                          </span>
                }
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {/* Run model */}
            <button
              onClick={handleRunModel}
              disabled={!canRun || runLoading}
              title={canRun ? 'Run model for this scenario' : 'Scenario is not ready (missing files or pathogen)'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-wpGreen text-wpBlue font-semibold rounded-lg hover:bg-wpGreen/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {runLoading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              <span>Run model</span>
            </button>

            {/* View results */}
            {hasResults && (
              <button
                onClick={() => onViewResults?.({ id: scenarioId, ...scenarioInfo })}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-wpBlue text-white rounded-lg hover:bg-wpBlue/90 transition-colors"
              >
                <BarChart2 size={15} />
                <span>View results</span>
              </button>
            )}

            {/* Execution log */}
            <button
              onClick={handleFetchLog}
              disabled={logLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-40"
            >
              {logLoading ? <Loader2 size={15} className="animate-spin" /> : <ScrollText size={15} />}
              <span>Execution log</span>
            </button>

            <div className="w-px h-5 bg-gray-200 mx-1" />

            {/* Edit metadata */}
            <button
              onClick={() => setIsMetadataDialogOpen(true)}
              className="flex items-center space-x-1 px-3 py-1 text-sm text-wpBlue-600 hover:text-wpBlue-700 hover:bg-wpBlue-50 rounded transition-colors"
            >
              <Edit3 size={16} />
              <span>Edit metadata</span>
            </button>
            <button
              onClick={handleDelete}
              className="flex items-center space-x-1 px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
            >
              <Trash2 size={16} />
              <span>Delete</span>
            </button>
          </div>
        </div>

        {/* Inline run status bar */}
        {runStatus !== 'idle' && (
          <div className="px-6 pb-3 flex items-center gap-3">
            {RUN_STATUS_CFG[runStatus] && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                runStatus === 'running' || runStatus === 'pending'
                  ? 'text-[#18B6A3] bg-[#18B6A3]/10'
                  : runStatus === 'success'
                    ? 'text-[#9EB65B] bg-[#9EB65B]/10'
                    : RUN_STATUS_CFG[runStatus].cls
              }`}>
                {RUN_STATUS_CFG[runStatus].label}
              </span>
            )}
            <button
              onClick={() => setShowOutput((v) => !v)}
              className="ml-auto text-xs text-gray-500 hover:text-gray-700 underline"
            >
              {showOutput ? 'Hide output' : 'Show output'}
            </button>
          </div>
        )}

        {/* Run output console */}
        {showOutput && (runOutput.stdout || runOutput.stderr) && (
          <div className="mx-6 mb-3 bg-gray-900 rounded-lg p-3 text-xs font-outfit text-gray-100 max-h-48 overflow-y-auto">
            <pre className="whitespace-pre-wrap">{runOutput.stdout}{runOutput.stderr}</pre>
          </div>
        )}

        {/* GloWPa execution log */}
        {showLog && glowpaLog && (
          <div className="mx-6 mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-gray-600">GloWPa Execution Log (last 500 lines)</span>
              <button
                onClick={() => setShowLog(false)}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Close
              </button>
            </div>
            <div className="bg-gray-900 rounded-lg p-3 text-xs font-outfit text-gray-100 max-h-48 overflow-y-auto">
              <pre className="whitespace-pre-wrap">
                {typeof glowpaLog === 'string' ? glowpaLog : (glowpaLog.log ?? JSON.stringify(glowpaLog, null, 2))}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Category Tabs */}
      <div className="bg-white flex-shrink-0">
        <div className="px-6">
          <h3 className="font-medium text-wpBlue pt-4 pb-2">Changes per category</h3>
          <div className="flex space-x-2 w-full">
            {CATEGORIES.map((category) => {
              const enabled = isCategoryEnabled(category.id);
              return (
              <button
                key={category.id}
                disabled={!enabled}
                onClick={() => {
                  if (!enabled) return;
                  const cat = CATEGORIES.find((c) => c.id === category.id);
                  const firstSub = cat?.subcategories[0]?.id ?? activeSubcategory;
                  setActiveCategory(category.id);
                  setActiveSubcategory(firstSub);
                  if (scenario?.name) {
                    const prefix = caseStudySlug ? `/scenarios/${caseStudySlug}` : '/scenarios';
                    navigate(`${prefix}/${toSlug(scenario.name)}/${category.id}/${firstSub}`);
                  }
                }}
                className={`
                  relative flex flex-1 items-center gap-3 px-6 py-3 mb-3 rounded-xl transition-colors justify-center
                  ${!enabled
                    ? 'bg-gray-100 text-gray-400 opacity-40 cursor-not-allowed'
                    : activeCategory === category.id
                      ? 'bg-white text-wpBlue hover:bg-gray-50 shadow-md shadow-wpGray-500/50'
                      : 'bg-gray-100 text-wpBlue hover:bg-gray-200'
                  }
                `}
              >
                <img src={category.icon} alt={category.label} className="w-12 h-12" />
                <span className="font-semibold font-outfit">{category.label}</span>
                {enabled && isCategoryDirty(category.id) && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-orange-400" title="Unsaved changes" />
                )}
              </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Split View: Subcategories Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden ">
        {/* Left Sidebar - Subcategories */}
        <div className="w-80 bg-white p-6 overflow-y-auto">
          <h3 className="text-sm font-medium text-wpBlue mb-4">Subcategories</h3>
          <div className="space-y-2">
            {currentCategory?.subcategories.map((subcategory) => (
              <button
                key={subcategory.id}
                onClick={() => {
                  setActiveSubcategory(subcategory.id);
                  if (scenario?.name) {
                    const prefix = caseStudySlug ? `/scenarios/${caseStudySlug}` : '/scenarios';
                    navigate(`${prefix}/${toSlug(scenario.name)}/${activeCategory}/${subcategory.id}`);
                  }
                }}
                className={`
                  w-full flex items-center gap-3 px-4 py-1 rounded-xl transition-colors text-left
                  ${activeSubcategory === subcategory.id
                    ? 'bg-gray-100 text-wpBlue-600'
                    : 'text-gray-700 hover:bg-gray-50'
                  }
                `}
              >
                <img src={subcategory.icon} alt={subcategory.label} className="w-10 h-10" />
                <span className="text-sm font-medium">{subcategory.label}</span>
                {dirtySubcategories[subcategory.id] && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" title="Unsaved changes" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 bg-gray-50 p-6 overflow-y-auto">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {currentCategory?.subcategories.find(sub => sub.id === activeSubcategory)?.label}
          </h3>

          {activeSubcategory === 'population' ? (
            <PopulationPanel
              key={scenario.id}
              scenario={scenario}
              onDirtyChange={(d) => handleSubcatDirtyChange('population', d)}
            />
          ) : activeSubcategory === 'sanitation' ? (
            <SanitationLadderPanel
              key={scenario.id}
              scenario={scenario}
              onDirtyChange={(d) => handleSubcatDirtyChange('sanitation', d)}
            />
          ) : activeSubcategory === 'wastewater-treatment' ? (
            <WastewaterTreatmentPanel
              key={scenario.id}
              scenario={scenario}
              onDirtyChange={(d) => handleSubcatDirtyChange('wastewater-treatment', d)}
            />
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <p className="text-gray-500 text-sm">
                Content for {currentCategory?.subcategories.find(sub => sub.id === activeSubcategory)?.label} will appear here.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Metadata Edit Dialog */}
      <ScenarioMetadataDialog
        isOpen={isMetadataDialogOpen}
        onClose={() => setIsMetadataDialogOpen(false)}
        scenario={scenario}
        onSave={handleMetadataSave}
      />
    </div>
  );
};

export default ScenarioDetailView;
