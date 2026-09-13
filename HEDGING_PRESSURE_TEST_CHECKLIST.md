# Hedging Pressure Feature - Test Checklist

## Pre-Launch Verification

### 1. Code Build & Dependencies
- [ ] Run `npm install` in `frontend/` directory
- [ ] Run `npm run build` to check TypeScript compilation
- [ ] Verify no missing imports in:
  - `frontend/src/lib/vanna.ts`
  - `frontend/src/lib/hedgingPressure.ts`
  - `frontend/src/lib/hedgingPressureConfig.ts`
  - `frontend/src/app/api/hedging-pressure/route.ts`
  - `frontend/src/app/hedging-pressure/page.tsx`

### 2. Poller Extension
- [ ] Verify `execution/tws_volumes_poller.py` has been updated with delta/vega collection
- [ ] Check that snapshot JSON structure includes `delta` and `vega` fields
- [ ] Run poller locally and check generated JSON file:
  ```bash
  python execution/tws_volumes_poller.py
  # Check frontend/data/volumes/YYYY-MM-DD.json
  # Should have:
  # volumes: [{ strike: X, calls: Y, puts: Z, gamma: A, delta: B, vega: C, ... }]
  ```

### 3. API Route Testing
- [ ] Start frontend dev server: `npm run dev`
- [ ] Test `/api/hedging-pressure` endpoint:
  ```bash
  curl http://localhost:3000/api/hedging-pressure
  # Should return JSON with:
  # - date, time, spot, atmIv, spotDelta, ivChange
  # - profile: [{ strike, gex, vanna, gammaPressure, vannaPressure, totalPressure, normalizedPressure, proximity }]
  # - riskZones: [{ strike, riskLevel, reason, pressure }]
  # - pressureHistory: [{ time, strike, gammaPressure, vannaPressure, totalPressure }]
  ```
- [ ] Verify no 503 errors (should return 503 if no volume data available)
- [ ] Check for NaN or Infinity in response

### 4. Frontend Page Navigation
- [ ] Open `http://localhost:3000/hedging-pressure`
- [ ] Page should load without console errors
- [ ] Check browser console (F12) for errors
- [ ] Verify page title: "Hedging Pressure & Acceleration"
- [ ] Verify initial loading spinner appears if no data yet

### 5. User Interface
- [ ] Tab selector visible: "Profile", "Time Series", "Heatmap"
- [ ] "Debug" button visible in header
- [ ] Navigation buttons visible: "GEX Profile", "Market Monitor"
- [ ] Metrics row visible: Spot, ATM IV, Spot Δ, IV Δ, Risk Zones
- [ ] Error message area (initially hidden)

### 6. Chart Rendering (Profile Mode)
- [ ] Click on "Profile" tab
- [ ] Chart should render as horizontal bars
- [ ] Bars extend left (red, bearish) and right (blue, bullish)
- [ ] Spot price line (cyan dotted) should be visible
- [ ] ATM strike line (purple dashed) should be visible
- [ ] Hover over bars shows tooltip with strike and pressure details
- [ ] Chart is not blank or showing error

### 7. Chart Rendering (Time Series Mode)
- [ ] Click on "Time Series" tab
- [ ] Chart should render with time on X-axis, pressure on Y-axis
- [ ] Lines for top 5 strikes by pressure should appear
- [ ] Colors should differentiate pressure direction (blue for positive, red for negative)
- [ ] Hover shows time and pressure value
- [ ] Chart is not blank

### 8. Chart Rendering (Heatmap Mode)
- [ ] Click on "Heatmap" tab
- [ ] Heatmap should render with strikes on Y-axis, time on X-axis
- [ ] Color gradient from red (bearish) through gray to blue (bullish)
- [ ] Visual map legend on the right
- [ ] Hover shows strike, time, and pressure value
- [ ] Chart is not blank

### 9. Debug Panel
- [ ] Click "Debug" button
- [ ] Debug panel expands below chart
- [ ] Shows fields:
  - Date
  - Spot
  - ATM Strike
  - ATM IV
  - Spot Delta
  - IV Change
  - Total Strikes
  - Risk Zones Found
- [ ] Risk zones listed with details
- [ ] Click "Hide Debug" collapses panel

### 10. Real-Time Updates
- [ ] Wait 15+ seconds
- [ ] Chart should update with new data
- [ ] "LIVE" badge should update timestamp
- [ ] No console errors
- [ ] No page lag or freezing

### 11. Navigation Between Pages
- [ ] Click "GEX Profile" button → navigates to `/spx-gamma`
- [ ] From `spx-gamma`, click "Hedging Pressure" button → navigates to `/hedging-pressure`
- [ ] Click "Market Monitor" button → navigates to `/market`
- [ ] All navigation works smoothly

### 12. Edge Cases & Robustness
- [ ] No volume data yet:
  - [ ] Page shows loading spinner initially
  - [ ] After timeout, shows "Unable to load hedging pressure data"
  - [ ] No console errors
- [ ] Extreme spot movement:
  - [ ] Pressure values remain in [-100, 100]
  - [ ] No NaN or Infinity in charts
- [ ] Zero IV change:
  - [ ] Vanna component = 0
  - [ ] Only gamma pressure shows
  - [ ] Charts still render
- [ ] All strikes identical pressure:
  - [ ] Normalized pressure = 0 for all
  - [ ] Charts flat but still render
  - [ ] No errors

## Data Quality Verification

### 13. Vanna Calculation
In debug panel or dev tools console:
```javascript
// Open hedging-pressure page
// In console, check API response structure
fetch('/api/hedging-pressure')
  .then(r => r.json())
  .then(data => {
    console.log('Profile sample:', data.profile[0]);
    console.log('Pressure range:', [
      Math.min(...data.profile.map(p => p.totalPressure)),
      Math.max(...data.profile.map(p => p.totalPressure))
    ]);
    console.log('Risk zones:', data.riskZones.length);
  });
```

- [ ] All values are finite (no NaN, Infinity, null where shouldn't be)
- [ ] `totalPressure` = `gammaPressure` + `vannaPressure` (spot-check calculations)
- [ ] `normalizedPressure` in [-100, 100] range
- [ ] `proximity` in [0, 1] range for all strikes
- [ ] At least some strikes have non-zero `vanna` (if IV poller is working)

### 14. Temporal Consistency
- [ ] Spot price from API matches spot line on chart
- [ ] Spot Delta value matches spot movement since session start
- [ ] IV Change sign matches actual IV trend
- [ ] Time series chart shows progression over session

## Performance & Optimization

### 15. Performance Checks
- [ ] Page load time < 2 seconds
- [ ] Chart updates < 500ms
- [ ] No memory leaks (check DevTools → Memory tab)
- [ ] No excessive console warnings

### 16. Mobile Responsiveness (Optional)
- [ ] Resize browser to mobile width (< 768px)
- [ ] Layout adapts (single column)
- [ ] Charts remain readable
- [ ] Buttons remain clickable

## Configuration Validation

### 17. Parameter Verification
In `frontend/src/lib/hedgingPressureConfig.ts`:
- [ ] All config values have comments explaining their purpose
- [ ] `validateConfig()` function runs without warnings
- [ ] Range values are sensible:
  - [ ] `BASE_SCALE_PERCENT` between 0.5% and 2% of spot
  - [ ] `IV_NORMALIZATION` around 15-35%
  - [ ] `NORMALIZATION_WINDOW` between 10 and 60
  - [ ] `ZSCORE_BOUNDS` between 2 and 4

## Known Limitations & Future Work

- [ ] Storico della pressione è limitato agli ultimi 1000 punti per performance
- [ ] Heatmap può essere lento con 37 strike × 600 punti (22,200 celle)
- [ ] Vanna è approssimata con formula Black-Scholes, non dal vero delta hedging osservato
- [ ] Proximity scale non tiene conto di volatility smile
- [ ] Acceleration score è un proxy, non misura reale della accelerazione

## Sign-Off

- [ ] All tests passed
- [ ] No critical errors
- [ ] Feature ready for production use
- [ ] Date tested: _______________
- [ ] Tested by: _______________

---

## Troubleshooting Guide

### "Unable to load hedging pressure data"
**Likely causes:**
1. Poller not running → start `execution/tws_volumes_poller.py`
2. No volume data yet → wait for poller to collect 1+ snapshot
3. API error → check `localhost:3000` API endpoint directly
4. Wrong date → file is for yesterday, check today's date

### Charts not rendering
**Likely causes:**
1. echarts-for-react not installed → run `npm install echarts echarts-for-react`
2. TypeScript compilation error → check `npm run build` output
3. API returned empty data → check volume snapshots in data directory

### Wrong pressure values
**Likely causes:**
1. Delta/Vega not in snapshots → poller not collecting them
2. Vanna calculation failed → check for extreme spot/strike/IV
3. Normalization broken → check NORMALIZATION_WINDOW config
4. GEX values unexpected → check original `/api/gex` endpoint

### Performance lag
**Likely causes:**
1. Too many strikes in heatmap → limit to top 20 strikes
2. History too long → decrease `pressureHistory.slice(-1000)` limit
3. Browser dev tools open → close and retry
4. Old data still cached → hard refresh (Ctrl+Shift+R)

