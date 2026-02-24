# SSP Scenario Dialog - Testing Guide

## Changes Made

### Backend Changes (app.py)

1. **Updated `create_scenario` endpoint** to handle new SSP fields:
   - `pathogen`: Stores the selected waterborne pathogen
   - `projectionMethod`: Stores whether to use ISIMIP or custom projections

2. **Updated `load_scenarios_from_metadata_csv`** to load SSP fields:
   - Now loads `pathogen` and `projectionMethod` from the CSV

3. **Updated scenario_metadata.csv structure**:
   - Added columns: `pathogen`, `projection_method`

### Frontend Changes

1. **New Component**: `SSPScenarioDialog.jsx`
   - Form with all SSP scenario fields
   - Validation for required fields
   - Clean UI with radio buttons for projection method

2. **Updated App.jsx**:
   - Added state: `isSSPDialogOpen`
   - Modified `handleCreateNewScenario` to open dialog
   - Added `handleSSPScenarioSubmit` to process form
   - Dialog rendered at component root level

3. **Updated scenarioStore.js**:
   - `createTempScenario` now accepts optional SSP data
   - Stores SSP fields in temp scenario

## Testing Steps

### 1. Start the Application

```powershell
cd c:\Users\user\source\waterpath-scenario-builder
.\start-dev.bat
```

### 2. Open Browser
Navigate to: http://localhost:3000

### 3. Check Browser Console
Open Developer Tools (F12) and check the Console tab for any errors.

### 4. Select a Case Study
- You should see "dhaka_input_d1ee5195" in the case study dropdown
- Select it from the header

### 5. Test the Dialog

**Step 1**: Click the "New Scenario" button
- Check console for: "Opening SSP dialog..."
- The dialog should appear with a dark overlay

**Step 2**: Fill in the form
- Scenario Name: "Test SSP Scenario"
- SSP Scenario: Select any (default is SSP1)
- Pathogen: Select any (default is Rotavirus)
- Year: Select any (default is 2030)
- Projection Method: Select either option

**Step 3**: Click "Create Scenario"
- Check console for: "SSP form submitted: {...}"
- Dialog should close
- New scenario tab should appear
- Check console for: "Created new SSP-based temp scenario: ..."

### 6. Verify Scenario Data
Check that the new scenario contains:
- The name you entered
- SSP formatted as "SSP1", "SSP2", etc.
- The selected year
- The selected pathogen
- The selected projection method

## Troubleshooting

### Dialog doesn't appear

1. **Check console for errors**
   - Look for import errors with @radix-ui/react-dialog
   - Look for React errors

2. **Check network tab**
   - Ensure the frontend is loading properly
   - Check for 404s on component files

3. **Verify dependencies**
   ```powershell
   cd webapp\frontend
   npm list @radix-ui/react-dialog
   ```
   Should show version ^1.1.15

4. **Rebuild the frontend**
   ```powershell
   cd webapp\frontend
   npm install
   npm run build
   ```

### Dialog appears but form doesn't work

1. **Check console logs**
   - Should see "SSPScenarioDialog render - isOpen: true"
   - Check for form validation errors

2. **Check state updates**
   - Console should show state changes as you type

### Scenario doesn't save to backend

1. **Check backend logs**
   - Look for errors in the terminal running the backend

2. **Check the data folder**
   ```powershell
   ls data\dhaka_input_d1ee5195\config\scenario_metadata.csv
   ```
   
3. **Verify CSV format**
   - New scenarios should have pathogen and projection_method columns

## Expected Behavior

When working correctly:
1. Click "New Scenario" → Dialog opens
2. Fill form → All fields are editable
3. Click "Create Scenario" → Dialog closes, new tab appears
4. The temp scenario should have all SSP metadata
5. When saved (if you implement save), it should persist to scenario_metadata.csv

## Next Steps

After confirming the dialog works:

1. **Implement ISIMIP Integration**
   - When "Pull ISIMIP projections" is selected
   - Fetch data from ISIMIP API based on SSP, year, and pathogen

2. **Custom Assumptions Form**
   - When "Custom assumptions" is selected
   - Show additional fields for manual data entry

3. **Save to Backend**
   - Ensure temp scenarios can be saved with all SSP metadata
   - Verify CSV files are created correctly

4. **Backend Processing**
   - Process pathogen and projection method
   - Apply appropriate data transformations
