import React from 'react';
import { Grid3x3, X, ChartColumn, Plus } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import useScenarioStore from '../store/scenarioStore';

const toSlug = (name) => encodeURIComponent(name ?? '');
const DEFAULT_CATEGORY = 'human-emissions';
const DEFAULT_SUBCATEGORY = 'population';

const ScenarioTabBar = ({ onCreateScenario, caseStudySlug = '', onBeforeTabChange }) => {
  const { tabs, activeTab, setActiveTab, deleteScenario, openMetadataEditor, dirtyScenarioIds } = useScenarioStore();
  const navigate = useNavigate();
  const location = useLocation();

  const handleTabClick = (tabId) => {
    const doNav = () => {
      setActiveTab(tabId);
      if (tabId === 'main') {
        navigate(caseStudySlug ? `/scenarios/${caseStudySlug}` : '/scenarios');
      } else {
        const tab = tabs.find((t) => t.id === tabId);
        if (tab) {
          // Preserve current category/subcategory from the URL so switching
          // between scenario tabs does not reset the active section.
          const urlParts = location.pathname.split('/').filter(Boolean);
          const currentCategory    = urlParts[3] ?? DEFAULT_CATEGORY;
          const currentSubcategory = urlParts[4] ?? DEFAULT_SUBCATEGORY;
          navigate(`/scenarios/${caseStudySlug ? `${caseStudySlug}/` : ''}${toSlug(tab.name)}/${currentCategory}/${currentSubcategory}`);
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
    <div className="mt-8 ml-4 p-2 pb-0">
      <div className="flex overflow-hidden">
        {tabs.map((tab) => (
          <button
            key={tab.id}
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
              <ChartColumn size={16} className={
                tab.isTemp ? 'text-yellow-400' : 'text-wpBlue-400'
              } />
            )}
            
            {/* Tab name */}
            {tab.type !== 'main' && (
            <span className="max-w-[120px] truncate">
              {tab.name}
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
        ))}
        
        {/* Add New Scenario Plus Tab */}
        {onCreateScenario && (
          <button
            onClick={onCreateScenario}
            className="flex items-center justify-center px-4 py-2 text-sm bg-gray-50 text-gray-600 hover:bg-wpGreen hover:text-white transition-colors flex-shrink-0"
            title="Create new scenario"
          >
            <Plus size={16} />
          </button>
        )}
        
        {/* Spacer to fill remaining space */}
        <div className="flex-1 border-r border-gray-200" />
      </div>
    </div>
  );
};

export default ScenarioTabBar;
