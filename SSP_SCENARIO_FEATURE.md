# SSP-Based Scenario Creation Feature

## Overview
This document describes the new SSP (Shared Socioeconomic Pathway) scenario creation dialog that has been added to the waterpath-scenario-builder application.

## Changes Made

### 1. New Component: SSPScenarioDialog
**File:** `webapp/frontend/src/components/SSPScenarioDialog.jsx`

A new dialog component that allows users to define SSP-based scenarios with the following fields:

#### Input Fields:
- **Scenario Name** (required text input)
  - User-defined name for the scenario
  
- **SSP Scenario** (dropdown selection)
  - SSP1 - Sustainability
  - SSP2 - Middle of the Road
  - SSP3 - Regional Rivalry
  - SSP4 - Inequality
  - SSP5 - Fossil-fueled Development

- **Waterborne Pathogen** (dropdown selection)
  - Rotavirus
  - Cryptosporidium

- **Year** (dropdown selection)
  - 2030
  - 2050
  - 2100

- **Data Projection Method** (radio buttons)
  - **Pull ISIMIP projections**: 
    - Automatically fetch data from ISIMIP database based on SSP scenario and year
    - Shows a loading indicator: "Pulling ISIMIP projections..." with spinner
    - 2-second simulated loading delay (can be replaced with actual API call)
  - **Custom assumptions**: 
    - Manually define custom assumptions for the scenario
    - Displays custom modifiers section when selected

#### Custom Modifiers (when "Custom assumptions" is selected):

Users can add multiple modifiers with the following options:

**Modifier Types:**
- Population growth rate
- Migration rate
- Sewer annual change
- Wastewater treatment annual change
- Livestock: Cattle growth rate
- Livestock: Poultry growth rate
- Livestock: Pig growth rate

**For each modifier:**
- **Type**: Dropdown to select the modifier type
- **Value**: Numerical input (positive or negative, decimal allowed)
- **Min**: Minimum value constraint
- **Max**: Maximum value constraint
- **Remove button**: Minus icon to remove the modifier

**Controls:**
- Plus icon button to add new modifiers
- Minus icon button on each modifier to remove it
- Empty state message when no modifiers are added

#### Features:
- Form validation (scenario name is required)
- Clean, modern UI with Tailwind CSS styling
- Descriptive text for each projection method option
- Cancel/Create action buttons (disabled during ISIMIP loading)
- Form resets on close or successful submission
- **ISIMIP Loading Effect**: Shows animated spinner and "Pulling ISIMIP projections..." message
- **Dynamic Modifiers**: Add/remove custom modifiers with intuitive UI
- **Disabled state**: Buttons are disabled during ISIMIP data loading

### 2. Updated Component: App.jsx
**File:** `webapp/frontend/src/App.jsx`

#### Changes:
1. **Import added**: `import SSPScenarioDialog from './components/SSPScenarioDialog';`

2. **New state variable**: 
   ```javascript
   const [isSSPDialogOpen, setIsSSPDialogOpen] = useState(false);
   ```

3. **Modified function**: `handleCreateNewScenario()`
   - Now opens the SSP dialog instead of directly creating a scenario
   
4. **New function**: `handleSSPScenarioSubmit(formData)`
   - Handles form submission from the SSP dialog
   - Creates a new temp scenario with SSP-specific data
   - Closes the dialog after submission

5. **Dialog component added to JSX**:
   ```jsx
   <SSPScenarioDialog
     isOpen={isSSPDialogOpen}
     onClose={() => setIsSSPDialogOpen(false)}
     onSubmit={handleSSPScenarioSubmit}
   />
   ```

### 3. Updated Store: scenarioStore.js
**File:** `webapp/frontend/src/store/scenarioStore.js`

#### Changes:
Modified the `createTempScenario` function to accept optional SSP data:

```javascript
createTempScenario: (caseStudyId, sspData = null) => {
  // Creates scenario with SSP-specific fields if provided:
  // - name: from sspData.scenarioName
  // - ssp: from sspData.sspScenario (formatted as SSP1, SSP2, etc.)
  // - year: from sspData.year
  // - pathogen: from sspData.pathogen
  // - projectionMethod: from sspData.projectionMethod
  // - sspScenario: from sspData.sspScenario
}
```

## User Flow

### Basic Flow:
1. User clicks the "New Scenario" button (must have a case study selected)
2. SSP Scenario Dialog opens with form fields
3. User fills in:
   - Scenario name
   - Selects SSP scenario (1-5)
   - Selects waterborne pathogen (Rotavirus/Cryptosporidium)
   - Selects target year (2030/2050/2100)
   - Chooses data projection method

### ISIMIP Projection Flow:
4a. If "Pull ISIMIP projections" is selected:
   - User clicks "Create Scenario"
   - Loading indicator appears: "Pulling ISIMIP projections..."
   - Spinner animation shows for ~2 seconds
   - Buttons are disabled during loading
   - After loading, scenario is created and dialog closes

### Custom Assumptions Flow:
4b. If "Custom assumptions" is selected:
   - Custom modifiers section appears
   - User clicks "Add Modifier" button (+ icon)
   - For each modifier, user:
     - Selects modifier type from dropdown
     - Enters value (can be positive or negative)
     - Sets min/max constraints
     - Can remove modifier using - icon
   - User can add multiple modifiers
   - Clicks "Create Scenario" to submit

5. A new temp scenario is generated with all SSP metadata and modifiers
6. User is automatically switched to the new scenario tab

## Data Structure

When a scenario is created through the SSP dialog, it includes the following metadata:

```javascript
{
  id: 'temp-{timestamp}',
  name: '{user-provided name}',
  description: '',
  ssp: 'SSP{1-5}',
  year: {2030|2050|2100},
  case_study_id: '{selected case study id}',
  pathogen: 'Rotavirus' | 'Cryptosporidium',
  projectionMethod: 'isimip' | 'custom',
  sspScenario: '1' | '2' | '3' | '4' | '5',
  modifiers: [
    // Only present if projectionMethod is 'custom'
    {
      id: {timestamp},
      type: 'population_growth' | 'migration_rate' | 'sewer_annual_change' | 
            'wastewater_treatment_change' | 'cattle_growth' | 'poultry_growth' | 'pig_growth',
      value: {number},
      min: {number},
      max: {number}
    },
    // ... more modifiers
  ],
  isTemp: true,
  isEditing: true,
  created_at: '{ISO timestamp}',
  updated_at: '{ISO timestamp}',
  data: []
}
```

## Future Enhancements

Potential areas for future development:

1. **ISIMIP Integration**: 
   - Replace mock loading with actual ISIMIP API calls
   - Fetch real climate and socioeconomic projection data
   - Handle API errors and retry logic
   
2. **Additional Pathogens**: Add more waterborne pathogen options

3. **Custom Year Input**: Allow users to input custom years beyond the predefined options

4. **Validation**: 
   - Validate min/max ranges for modifiers
   - Ensure value is within min/max bounds
   - Add field-level error messages
   
5. **SSP Information**: Add tooltips or info buttons with detailed SSP scenario descriptions

6. **Template Loading**: Pre-populate scenario data based on SSP and year selection

7. **Progress Indicator**: Show detailed progress when fetching ISIMIP data (e.g., "Fetching population data...", "Fetching climate data...")

8. **Modifier Presets**: 
   - Save custom modifier combinations as templates
   - Load commonly used modifier sets
   
9. **Modifier Validation**:
   - Validate that min < max
   - Show warnings for extreme values
   - Suggest typical ranges for each modifier type

10. **Export/Import Modifiers**: Allow users to export and import modifier configurations as JSON

## Technical Notes

- The dialog uses the existing `Dialog` component from `components/Dialog.jsx` which is built on Radix UI
- Form state is managed locally within the SSPScenarioDialog component
- The dialog integrates seamlessly with the existing Zustand store for scenario management
- All styling follows the existing Tailwind CSS design system used in the app
