import React from 'react';
import { Home, X, ChartColumn } from 'lucide-react';
import useScenarioStore from '../store/scenarioStore';

const ScenarioTabBar = () => {
  const { tabs, activeTab, setActiveTab, deleteTempScenario } = useScenarioStore();

  const handleTabClick = (tabId) => {
    setActiveTab(tabId);
  };

  const handleCloseTab = (e, tabId) => {
    e.stopPropagation();
    // Only temp scenarios can be closed
    const tab = tabs.find(t => t.id === tabId);
    if (tab?.isTemp) {
      deleteTempScenario(tabId);
    }
  };

  if (tabs.length <= 1) {
    return null; // Don't show tab bar if only main tab
  }

  return (
    <div className="bg-gray-100 border-t border-gray-200">
      <div className="flex overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabClick(tab.id)}
            className={`
              flex items-center gap-2 px-4 py-2 text-sm font-medium border-r border-gray-200
              whitespace-nowrap flex-shrink-0 relative group
              ${activeTab === tab.id 
                ? 'bg-white text-wpBlue-600 border-b-2 border-wpBlue-500 -mb-px' 
                : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800'
              }
              ${tab.isTemp ? 'italic' : ''}
            `}
          >
            {/* Tab icon */}
            {tab.type === 'main' ? (
              <Home size={16} />
            ) : (
              <ChartColumn size={16} className={
                tab.isTemp ? 'text-yellow-400' : 'text-wpBlue-400'
              } />
            )}
            
            {/* Tab name */}
            <span className="max-w-[120px] truncate">
              {tab.name}
            </span>
            
            {/* Close button for temp scenarios */}
            {tab.isTemp && (
              <button
                onClick={(e) => handleCloseTab(e, tab.id)}
                className="ml-1 p-0.5 rounded hover:bg-red-100 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Close tab"
              >
                <X size={12} className="text-red-500" />
              </button>
            )}

            {/* Unsaved indicator */}
            {tab.isTemp && (
              <div className="absolute top-1 right-1 w-2 h-2 bg-orange-400 rounded-full" />
            )}
          </button>
        ))}
        
        {/* Spacer to fill remaining space */}
        <div className="flex-1 bg-gray-50 border-r border-gray-200" />
      </div>
    </div>
  );
};

export default ScenarioTabBar;
