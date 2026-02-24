# SSP Multi-Step Wizard Implementation

## Overview
The SSP Scenario Dialog has been converted from a single-step form to a 2-step wizard for better user experience.

## Structure

### Step 1: Basic Information
- **Scenario Name** (required, text input)
- **SSP Scenario** (required, dropdown: SSP1-5)
- **Pathogen** (required, radio buttons: Rotavirus / Cryptosporidium)
- **Target Year** (required, radio buttons: 2030 / 2050 / 2100)

Navigation: **Cancel** | **Next →**

### Step 2: Configuration
- **Data Projection Method** (required, radio buttons)
  - **Pull ISIMIP projections**: Automatically fetch data from ISIMIP database
  - **Custom assumptions**: Manually define custom modifiers

#### Custom Modifiers (shown when "Custom assumptions" selected)
- Add/remove modifiers with **Plus/Minus** buttons
- Each modifier includes:
  - **Type**: Dropdown with 7 options
    - Population Growth
    - Urbanization Rate
    - GDP per Capita
    - Water Access
    - Sanitation Access
    - Treatment Coverage
    - Climate Factor
  - **Value**: Numeric input (step 0.01)
  - **Min**: Numeric input
  - **Max**: Numeric input

#### ISIMIP Loading Effect
When "Pull ISIMIP projections" is selected and form is submitted:
- Shows animated spinner
- Displays message: "Pulling ISIMIP projections..."
- 2-second mock delay before creating scenario

Navigation: **← Back** | **Cancel** | **Create Scenario**

## State Management

### Step State
```javascript
const [step, setStep] = useState(1);
```

### Navigation Functions
- `handleNext()`: Validates Step 1 required fields, advances to Step 2
- `handleBack()`: Returns to Step 1
- `handleReset()`: Resets form data and returns to Step 1

## Validation

### Step 1 Validation
All fields are required before advancing:
- Scenario name (non-empty string)
- SSP scenario (SSP1-5 selected)
- Pathogen (Rotavirus or Cryptosporidium)
- Year (2030, 2050, or 2100)

Alert shown if any field is missing.

### Step 2 Validation
- Projection method required (ISIMIP or Custom)
- Custom modifiers optional

## User Flow

1. User clicks "+ Create SSP Scenario" button
2. **Step 1** dialog opens with basic information fields
3. User fills required fields and clicks "Next"
4. Validation occurs; if successful, **Step 2** appears
5. User selects projection method:
   - **ISIMIP**: No additional input needed
   - **Custom**: Can add/configure modifiers
6. User clicks "Create Scenario"
7. If ISIMIP selected, loading indicator shows for 2 seconds
8. Scenario is created and dialog closes

## Benefits

✅ **Better UX**: Splits complex form into logical sections
✅ **Progressive Disclosure**: Shows modifiers only when "Custom assumptions" selected
✅ **Clear Navigation**: Chevron icons (←/→) indicate multi-step flow
✅ **Validation**: Step 1 validated before advancing
✅ **Flexibility**: Users can go back to edit Step 1 from Step 2

## Technical Details

- **Icons Used**: `ChevronLeft`, `ChevronRight`, `Plus`, `Minus` from lucide-react
- **Conditional Rendering**: `{step === 1 && (...)}` and `{step === 2 && (...)}`
- **Fragment Wrapping**: Each step wrapped in `<>...</>` for proper JSX structure
- **Button States**: Navigation buttons disabled during ISIMIP loading
- **Form Structure**: Single `<form>` element contains both steps

## Testing Checklist

- [ ] Step 1 validation prevents advancing with empty fields
- [ ] "Next" button advances to Step 2
- [ ] "Back" button returns to Step 1
- [ ] Cancel button works from both steps
- [ ] ISIMIP loading effect shows for 2 seconds
- [ ] Custom modifiers can be added/removed
- [ ] Create Scenario button submits form from Step 2
- [ ] Dialog resets to Step 1 when reopened
- [ ] All form data persists when navigating between steps

## Future Enhancements

- [ ] Add step progress indicator (e.g., "Step 1 of 2")
- [ ] Implement actual ISIMIP API integration
- [ ] Add modifier presets for common scenarios
- [ ] Save draft scenarios between sessions
