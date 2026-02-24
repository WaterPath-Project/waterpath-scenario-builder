# SSP Dialog - Custom Modifiers & ISIMIP Loading

## New Features Added

### 1. ISIMIP Loading Effect
When users select "Pull ISIMIP projections":
- Click "Create Scenario" triggers a loading state
- Shows animated spinner with message: "Pulling ISIMIP projections..."
- Buttons are disabled during loading
- 2-second simulated delay (replace with actual API call)
- Blue background highlight for loading indicator

### 2. Custom Modifiers System
When users select "Custom assumptions":
- Dynamic modifiers section appears
- Users can add/remove multiple modifiers
- Each modifier has:
  - **Type dropdown**: 7 different modifier types
  - **Value field**: Accepts positive/negative numbers with decimals
  - **Min field**: Minimum constraint
  - **Max field**: Maximum constraint
  - **Remove button**: Red minus icon to delete

## Testing Instructions

### Test 1: ISIMIP Loading
1. Open the dialog
2. Fill in basic fields
3. Keep "Pull ISIMIP projections" selected (default)
4. Click "Create Scenario"
5. **Expected**: 
   - Loading indicator appears
   - Spinner animation shows
   - Message: "Pulling ISIMIP projections..."
   - Buttons are disabled
   - After 2 seconds, dialog closes and scenario is created

### Test 2: Custom Modifiers - Add
1. Open the dialog
2. Fill in basic fields
3. Select "Custom assumptions"
4. **Expected**: Custom modifiers section appears
5. Click "Add Modifier" button (+ icon)
6. **Expected**: New modifier row appears with:
   - Type dropdown (default: Population growth rate)
   - Value field (default: 0)
   - Min field (default: 0)
   - Max field (default: 100)
   - Remove button (- icon)
7. Click "Add Modifier" multiple times
8. **Expected**: Multiple modifier rows appear

### Test 3: Custom Modifiers - Configure
1. Follow steps 1-6 from Test 2
2. Change modifier type from dropdown
3. **Expected**: Dropdown updates to selected type
4. Enter a value (try: 5.5)
5. **Expected**: Value field accepts decimal
6. Enter a negative value (try: -2.5)
7. **Expected**: Negative values are accepted
8. Set min to 10 and max to 20
9. **Expected**: Both fields accept the values

### Test 4: Custom Modifiers - Remove
1. Follow steps 1-7 from Test 2 (add multiple modifiers)
2. Click the minus icon on one modifier
3. **Expected**: That modifier is removed
4. Click minus on all modifiers
5. **Expected**: 
   - All modifiers removed
   - Empty state message appears:
     "No modifiers added yet"
     "Click 'Add Modifier' to add custom assumptions"

### Test 5: Form Submission with Modifiers
1. Open the dialog
2. Fill in all required fields
3. Select "Custom assumptions"
4. Add 2-3 modifiers with different values
5. Click "Create Scenario"
6. **Expected**:
   - Dialog closes immediately (no loading)
   - Scenario is created
   - Check browser console for submitted data
   - modifiers array should be included

### Test 6: Cancel During ISIMIP Loading
1. Open the dialog
2. Fill in basic fields
3. Keep "Pull ISIMIP projections" selected
4. Click "Create Scenario"
5. Try clicking "Cancel" during loading
6. **Expected**: Button is disabled, can't cancel during load

### Test 7: Switch Between Methods
1. Open the dialog
2. Select "Custom assumptions"
3. Add modifiers
4. Switch back to "Pull ISIMIP projections"
5. **Expected**: Modifiers section disappears
6. Switch back to "Custom assumptions"
7. **Expected**: Modifiers section reappears with previous modifiers intact

## Visual Checks

### Dialog Layout
- [ ] Dialog is centered on screen
- [ ] Dark overlay behind dialog
- [ ] Scrollable content if needed
- [ ] Clean spacing between sections

### ISIMIP Loading
- [ ] Blue background (bg-blue-50)
- [ ] Blue border (border-blue-200)
- [ ] Spinner is animated
- [ ] Text is readable (text-blue-900)
- [ ] Loading indicator is prominent

### Custom Modifiers
- [ ] "Add Modifier" button aligned to the right
- [ ] Empty state is centered with dashed border
- [ ] Modifier cards have gray background (bg-gray-50)
- [ ] Inputs are properly aligned in 3-column grid
- [ ] Remove button is red and aligned to the right
- [ ] Labels are small and gray (text-xs)

### Buttons
- [ ] Cancel button is white with gray border
- [ ] Create button is blue
- [ ] Disabled state shows reduced opacity
- [ ] Hover states work (except when disabled)

## Data Verification

After creating a scenario, check the browser console for:

```javascript
// ISIMIP method
{
  scenarioName: "Test Scenario",
  sspScenario: "2",
  pathogen: "Rotavirus",
  year: "2050",
  projectionMethod: "isimip",
  modifiers: []  // Empty for ISIMIP
}

// Custom method with modifiers
{
  scenarioName: "Custom Test",
  sspScenario: "3",
  pathogen: "Cryptosporidium",
  year: "2100",
  projectionMethod: "custom",
  modifiers: [
    {
      id: 1733854123456,
      type: "population_growth",
      value: 2.5,
      min: 0,
      max: 5
    },
    {
      id: 1733854123789,
      type: "migration_rate",
      value: -1.2,
      min: -5,
      max: 5
    }
  ]
}
```

## Known Limitations

1. **No validation on min/max**: Users can set min > max
2. **ISIMIP is simulated**: 2-second timeout, not real API
3. **No duplicate type checking**: Users can add same modifier type multiple times
4. **No value range validation**: Values can exceed min/max bounds

These can be addressed in future iterations.

## Troubleshooting

### Modifiers section doesn't appear
- Ensure "Custom assumptions" radio button is selected
- Check browser console for errors

### Loading doesn't work
- Check browser console for errors
- Verify the setTimeout is working (no JS errors)

### Can't add modifiers
- Check if Plus icon is rendering (lucide-react import)
- Verify button onClick is firing (add console.log)

### Styles look wrong
- Ensure Tailwind CSS is loaded
- Check for CSS conflicts
- Try hard refresh (Ctrl+Shift+R)
