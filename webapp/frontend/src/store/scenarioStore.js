import { create } from 'zustand';
import axios from 'axios';

const useScenarioStore = create((set, get) => ({
  // State
  scenarios: [],
  tempScenarios: [], // For browser-stored unsaved scenarios
  isCreatingScenario: false,
  editingScenarioId: null,
  activeTab: 'main', // 'main' for overview, or scenario ID for specific scenario
  tabs: [{ id: 'main', name: 'Main', type: 'main', icon: 'Home' }], // Tab list
  metadataEditScenarioId: null, // Scenario ID whose metadata should be edited
  dirtyScenarioIds: {},          // { [scenarioId]: true } — scenarios with unsaved isodata edits

  // Actions
  setScenarios: (scenarios) => set({ scenarios }),
  
  openMetadataEditor: (scenarioId) => set({ metadataEditScenarioId: scenarioId }),
  
  closeMetadataEditor: () => set({ metadataEditScenarioId: null }),

  setScenarioDirty: (scenarioId, isDirty) => {
    set((state) => {
      const next = { ...state.dirtyScenarioIds };
      if (isDirty) next[scenarioId] = true;
      else delete next[scenarioId];
      return { dirtyScenarioIds: next };
    });
  },

  createTempScenario: (caseStudyId, sspData = null) => {
    const newScenario = {
      id: `temp-${Date.now()}`,
      name: sspData ? sspData.scenarioName : 'New Scenario',
      description: '',
      ssp: sspData ? `SSP${sspData.sspScenario}` : '',
      year: sspData ? parseInt(sspData.year) : new Date().getFullYear(),
      case_study_id: caseStudyId,
      additional_notes: '',
      isTemp: true,
      isEditing: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      data: [], // CSV data will be stored here
      // Store SSP-specific data
      ...(sspData && {
        pathogen: sspData.pathogen,
        projectionMethod: sspData.projectionMethod,
        sspScenario: sspData.sspScenario
      })
    };
    
    // Add tab for the new scenario
    const newTab = {
      id: newScenario.id,
      name: newScenario.name,
      type: 'scenario',
      isTemp: true
    };
    
    set((state) => ({
      tempScenarios: [...state.tempScenarios, newScenario],
      tabs: [...state.tabs, newTab],
      activeTab: newScenario.id, // Switch to the new scenario tab
      isCreatingScenario: true
    }));
    
    return newScenario.id;
  },

  updateTempScenario: (scenarioId, updates) => {
    set((state) => ({
      tempScenarios: state.tempScenarios.map(scenario =>
        scenario.id === scenarioId 
          ? { ...scenario, ...updates, updated_at: new Date().toISOString() }
          : scenario
      ),
      // Update tab name if scenario name changed
      tabs: updates.name ? state.tabs.map(tab =>
        tab.id === scenarioId ? { ...tab, name: updates.name } : tab
      ) : state.tabs
    }));
  },

  deleteTempScenario: (scenarioId) => {
    set((state) => {
      const remainingTempScenarios = state.tempScenarios.filter(scenario => scenario.id !== scenarioId);
      const remainingTabs = state.tabs.filter(tab => tab.id !== scenarioId);
      
      return {
        tempScenarios: remainingTempScenarios,
        tabs: remainingTabs,
        activeTab: state.activeTab === scenarioId ? 'main' : state.activeTab,
        isCreatingScenario: remainingTempScenarios.length > 0
      };
    });
  },

  setEditingScenario: (scenarioId) => {
    set({ editingScenarioId: scenarioId });
  },

  saveScenario: async (scenarioId) => {
    const { tempScenarios } = get();
    const scenario = tempScenarios.find(s => s.id === scenarioId);
    
    if (!scenario) {
      throw new Error('Scenario not found');
    }

    try {
      // Prepare the scenario data for saving
      const scenarioData = {
        name:             scenario.name,
        description:      scenario.description,
        ssp:              scenario.ssp,
        year:             scenario.year,
        pathogen:         scenario.pathogen || '',
        projectionMethod: scenario.projectionMethod || '',
        case_study_id:    scenario.case_study_id,
        notes:            scenario.additional_notes || '',
        data:             scenario.data,
      };

      // Save to backend - this will create CSV file and update datapackage.json
      const response = await axios.post('/api/scenarios', scenarioData);
      
      // Remove from temp scenarios and add to persistent scenarios, update tabs
      set((state) => ({
        scenarios: [...state.scenarios, response.data],
        tempScenarios: state.tempScenarios.filter(s => s.id !== scenarioId),
        tabs: state.tabs.map(tab => 
          tab.id === scenarioId 
            ? { ...tab, id: response.data.id, isTemp: false }
            : tab
        ),
        activeTab: response.data.id,
        isCreatingScenario: state.tempScenarios.length <= 1,
        editingScenarioId: null
      }));

      return response.data;
    } catch (error) {
      console.error('Error saving scenario:', error);
      throw error;
    }
  },

  updateScenario: async (scenarioId, updates) => {
    try {
      const response = await axios.put(`/api/scenarios/${scenarioId}`, updates);
      
      set((state) => ({
        scenarios: state.scenarios.map(scenario =>
          scenario.id === scenarioId ? { ...scenario, ...response.data } : scenario
        )
      }));
      
      return response.data;
    } catch (error) {
      console.error('Error updating scenario:', error);
      throw error;
    }
  },

  deleteScenario: async (scenarioId) => {
    const { tempScenarios } = get();
    const isTemp = tempScenarios.find(s => s.id === scenarioId);
    
    if (isTemp) {
      // Handle temp scenario deletion (browser only)
      get().deleteTempScenario(scenarioId);
      return;
    }
    
    try {
      // Delete from backend
      await axios.delete(`/api/scenarios/${scenarioId}`);
      
      // Remove from state and update tabs
      set((state) => {
        const remainingScenarios = state.scenarios.filter(scenario => scenario.id !== scenarioId);
        const remainingTabs = state.tabs.filter(tab => tab.id !== scenarioId);
        
        return {
          scenarios: remainingScenarios,
          tabs: remainingTabs,
          activeTab: state.activeTab === scenarioId ? 'main' : state.activeTab
        };
      });
    } catch (error) {
      console.error('Error deleting scenario:', error);
      throw error;
    }
  },

  // Tab management actions
  setActiveTab: (tabId) => {
    set({ activeTab: tabId });
  },

  setupTabsForCaseStudy: (caseStudyId) => {
    const { scenarios } = get();
    const caseStudyScenarios = scenarios.filter(s => s.case_study_id === caseStudyId);
    
    const scenarioTabs = caseStudyScenarios.map(scenario => ({
      id: scenario.id,
      name: scenario.name,
      type: 'scenario',
      isTemp: false
    }));
    
    set({
      tabs: [
        { id: 'main', name: 'Main', type: 'main', icon: 'Home' },
        ...scenarioTabs
      ],
      activeTab: 'main'
    });
  },

  fetchScenarios: async (caseStudyId = null) => {
    try {
      const url = caseStudyId ? `/api/scenarios?case_study_id=${caseStudyId}` : '/api/scenarios';
      const response = await axios.get(url);
      set({ scenarios: response.data.scenarios || [] });
      
      // Set up tabs for the case study
      if (caseStudyId) {
        get().setupTabsForCaseStudy(caseStudyId);
      }
    } catch (error) {
      console.error('Error fetching scenarios:', error);
      set({ scenarios: [] });
    }
  },

  // Get all scenarios (both temp and persistent) for a case study
  getAllScenarios: (caseStudyId) => {
    const { scenarios, tempScenarios } = get();
    const persistentScenarios = caseStudyId 
      ? scenarios.filter(s => s.case_study_id === caseStudyId)
      : scenarios;
    const tempScenariosForCase = caseStudyId
      ? tempScenarios.filter(s => s.case_study_id === caseStudyId)
      : tempScenarios;
    
    return [...persistentScenarios, ...tempScenariosForCase];
  },

  // Clear temp scenarios when changing case studies
  clearTempScenarios: () => {
    set({
      tempScenarios: [],
      tabs: [{ id: 'main', name: 'Main', type: 'main', icon: 'Home' }],
      activeTab: 'main',
      isCreatingScenario: false,
      editingScenarioId: null
    });
  }
}));

export default useScenarioStore;
