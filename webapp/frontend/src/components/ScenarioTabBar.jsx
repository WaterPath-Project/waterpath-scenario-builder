import React from 'react';
import { Grid3x3, X, ChartColumn, Plus } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import useScenarioStore from '../store/scenarioStore';
import { paths } from '../routes';
const DEFAULT_CATEGORY = 'human-emissions';
const DEFAULT_SUBCATEGORY = 'population';

const ScenarioTabBar = ({ onCreateScenario, caseStudySlug = '', onBeforeTabChange, analyticsScenarios = [] }) => {
  const { tabs, activeTab, setActiveTab, deleteScenario, openMetadataEditor, dirtyScenarioIds, needsRerunIds, scenarioRunStatuses } = useScenarioStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Build a minimal `cs` shape for `paths.*` — we only need `folder_name`.
  const csShape = caseStudySlug ? { folder_name: decodeURIComponent(caseStudySlug) } : null;
  const scenariosWithResults = new Set(
    analyticsScenarios.filter((scenario) => scenario.has_outputs).map((scenario) => scenario.id)
  );

  const handleTabClick = (tabId) => {
    const doNav = () => {
      setActiveTab(tabId);
      if (tabId === 'main') {
        navigate(paths.scenarios(csShape));
      } else {
        const tab = tabs.find((t) => t.id === tabId);
        if (tab) {
          // Preserve current category/subcategory from the URL so switching
          // between scenario tabs does not reset the active section.
          const urlParts = location.pathname.split('/').filter(Boolean);
          const currentCategory    = urlParts[3] ?? DEFAULT_CATEGORY;
          const currentSubcategory = urlParts[4] ?? DEFAULT_SUBCATEGORY;
          navigate(paths.scenario(csShape, tab.name, currentCategory, currentSubcategory));
        }
      }
    };
    if (onBeforeTabChange) {
      onBeforeTabChange(doNav);
    } else {
      doNav();
    }
  };

  const handleTabDoubleClick = (tabId, tabType) => {
    // Only allow editing metadata for scenario tabs, not the main tab
    if (tabType !== 'main') {
      openMetadataEditor(tabId);
    }
  };

  const handleCloseTab = async (e, tabId) => {
    e.stopPropagation();
    // Delete any scenario (temp or saved)
    const tab = tabs.find(t => t.id === tabId);
    if (tab && tab.type !== 'main') {
      if (window.confirm(`Are you sure you want to delete "${tab.name}"?`)) {
        try {
          await deleteScenario(tabId);
        } catch (error) {
          console.error('Error deleting scenario:', error);
          alert('Failed to delete scenario');
        }
      }
    }
  };

  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-2">
      <div className="flex items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <React.Fragment key={tab.id}>
            <button
              onClick={() => handleTabClick(tab.id)}
              onDoubleClick={() => handleTabDoubleClick(tab.id, tab.type)}
              className={`
                ${tab.id=='main' && 'rounded-tl-xl'} flex font-outfit items-center gap-2 px-4 py-2 text-sm font-semibold 
                whitespace-nowrap flex-shrink-0 relative group mr-2 bg-wpGray-200
                ${activeTab === tab.id 
                  ? 'bg-wpWhite-100 text-wpBlue-600 -mb-px' 
                  : 'text-wpBlue hover:bg-gray-100 hover:text-gray-800'
                }
                ${tab.isTemp ? 'italic' : ''}
              `}
            >
              {/* Tab icon */}
              {tab.type === 'main' ? (
                <Grid3x3 size={16} />
              ) : (
                <ChartColumn
                  size={16}
                  className={activeTab === tab.id
                    ? 'text-wpBlue-600'
                    : scenarioRunStatuses?.[tab.id] === 'error'
                      ? 'text-red-500'
                      : needsRerunIds?.[tab.id]
                        ? 'text-orange-500'
                        : scenariosWithResults.has(tab.id)
                          ? 'text-wpGreen'
                          : 'text-wpBlue'}
                />
              )}
              
              {/* Tab name */}
              {tab.type !== 'main' && (
              <span className="max-w-[120px] truncate">
                {tab.name}
                {tab.isBaseline && <span className="ml-0.5 text-wpGreen" title="Baseline scenario">*</span>}
              </span>
              )}
              
              {/* Delete button for scenario tabs (not main) */}
              {tab.type !== 'main' && (
                <button
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="ml-1 p-0.5 rounded hover:bg-red-100 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete scenario"
                >
                  <X size={12} className="text-red-500" />
                </button>
              )}

              {/* Unsaved indicator: temp scenario or has dirty isodata edits */}
              {(tab.isTemp || dirtyScenarioIds?.[tab.id]) && (
                <div className="absolute top-1 right-1 w-2 h-2 bg-orange-400 rounded-full" />
              )}
            </button>
          </React.Fragment>
        ))}
        
        {/* Spacer to fill remaining space */}
        <div className="flex-1" />

        {/* New Scenario button — right-aligned in the tab bar */}
        {onCreateScenario && (
          <button
            onClick={onCreateScenario}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-wpGreen text-wpBlue hover:bg-wpGreen-600 transition-colors flex-shrink-0 my-1 mx-1 rounded-lg"
            title="Create new scenario"
          >
            <Plus size={14} />
            New Scenario
          </button>
        )}
      </div>
    </div>
  );
};

export default ScenarioTabBar;
