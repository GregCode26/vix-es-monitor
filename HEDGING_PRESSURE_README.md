# Hedging Pressure & Acceleration Analysis

## Overview

The Hedging Pressure feature estimates where and how strongly dealer hedging activity might accelerate or decelerate market movements at different strike prices. It combines:

- **Gamma Exposure (GEX)** — existing market maker positioning from options gamma
- **Vanna** — volatility-delta interaction showing hedging pressure from IV changes
- **Proximity Weighting** — dynamic scaling to focus on strikes near ATM
- **Real-time Updates** — 15-second polling aligned with GEX data

## How It Works

### The Model

```
Total Hedging Pressure = Gamma Pressure + Vanna Pressure

Where:
  Gamma Pressure  = GEX × ΔSpot × ProximityWeight
  Vanna Pressure  = Vanna × ΔIV × ProximityWeight
  ProximityWeight = exp(-Distance / Scale)
```

### Gamma Component
Represents hedging pressure from spot price movement.

- **Positive GEX + Positive ΔSpot** → Dealer adds hedges (long more upside)
- **Negative GEX + Positive ΔSpot** → Dealer reduces hedges (short more upside)
- **Positive pressure** → Dealer hedging supports the move (smears gamma)
- **Negative pressure** → Dealer hedging against the move (resists gamma)

### Vanna Component
Represents hedging pressure from IV (volatility) changes.

Calculated from IBKR modelGreeks (delta, vega) using Black-Scholes:
```
Vanna ≈ -Vega × d2 / IV
```

Where IV changes, dealer delta exposures shift and require rehedging.

- **Positive Vanna + Rising IV** → Dealer adds upside hedges
- **Negative Vanna + Rising IV** → Dealer adds downside hedges

### Proximity Weighting

Strikes far from current spot are scaled down exponentially.

```
ProximityWeight = exp(-|Strike - Spot| / Scale)

Scale = Spot × 1% × IV_Adjustment
```

**Why?** When spot moves far, previously distant strikes become relevant. Until then, they contribute less to immediate hedging pressure.

### Normalization

Raw pressures are normalized to **[-100, 100]** using rolling z-score:

```
NormalizedPressure = (zScore / 3) × 100, clipped to [-100, 100]
```

Uses a 20-snapshot rolling window (~3.3 minutes at 10-second intervals).

**Why?** Makes pressures comparable across different market regimes (calm vs volatile).

## Visualization Modes

### Profile Mode (Default)
Horizontal bar chart: strikes on Y-axis, hedging pressure on X-axis.

- **Right bars (blue)** = Bullish pressure (upside hedging)
- **Left bars (red)** = Bearish pressure (downside hedging)
- **Cyan dotted line** = Current spot price
- **Purple dashed line** = ATM strike
- **Bar length** = Magnitude of normalized pressure

**Use case:** Quickly identify pressure zones and acceleration potential.

### Time Series Mode
Line chart: Time on X-axis, pressure on Y-axis for top 5 strikes.

- Separate lines per strike (color coded)
- Shows how pressure evolves during session
- Break into gamma component (visual indicator)

**Use case:** Monitor pressure trends for specific strikes, spot reversals, pressure building.

### Heatmap Mode
2D visualization: Strikes × Time, color = pressure magnitude.

- Red (cold) = strong bearish pressure
- Blue (hot) = strong bullish pressure
- Gray = neutral
- Visual map legend on right

**Use case:** Spot pressure zones evolving intraday, identify "stacking" effects where multiple strikes have aligned pressure.

## Reading the Data

### Key Metrics (Top Bar)
- **Spot** — Current S&P 500 index price
- **ATM IV** — Weighted implied volatility near the money
- **Spot Δ** — Price change since session open
- **IV Δ** — IV change in basis points
- **Risk Zones** — Number of high/medium pressure strikes identified

### Profile Details (Hover Tooltip)
- **Strike** — Option strike price
- **Pressure** — Normalized hedging pressure [-100, 100]
- **Gamma** — Gamma pressure component
- **Vanna Proxy** — Vanna pressure component
- **GEX** — Raw gamma exposure in $M per 1%
- **Proximity** — Weight [0, 1], higher = closer to ATM

### Debug Mode
Expand "Debug" button to see:

- Calculated GEX, Vanna, IV, spot movement
- Actual risk zones with reasons
- Calculated values for verification

## Interpreting Signals

### High Bullish Pressure (right side, blue, positive)
Potential upside acceleration if:
- Gamma + Vanna aligned (both positive)
- Proximity > 70% (close to ATM)
- Increasing magnitude over time (in time series)

**Dealer behavior:** Adding upside hedges as spot rises → positive feedback loop.

### High Bearish Pressure (left side, red, negative)
Potential downside acceleration if:
- Gamma + Vanna aligned (both negative)
- Proximity > 70% (close to ATM)
- Increasing magnitude (in time series)

**Dealer behavior:** Adding downside hedges as spot falls → negative feedback loop.

### Opposing Gamma/Vanna
If gamma pressure is +30 but vanna pressure is -40:
- Gamma hedges support a move
- Volatility hedges resist it
- Net effect depends on which is larger AND how fast each driver changes

**Trade implication:** Mixed signals require monitoring which one dominates.

### Pressure Fading (time series)
If bars shrink over time:
- Dealer hedges are clearing out
- Gamma/vanna exposure is dropping
- Potential for snap-back if pressure suddenly reverses

## Configuration

All parameters are tunable in `frontend/src/lib/hedgingPressureConfig.ts`:

| Parameter | Default | Effect |
|-----------|---------|--------|
| `BASE_SCALE_PERCENT` | 0.01 | Width of ATM focus zone (1% = ~1 SD intraday) |
| `IV_NORMALIZATION` | 25 | IV level treating as "normal"; affects scale width |
| `NORMALIZATION_WINDOW` | 20 | Rolling window for z-score (snapshots) |
| `ZSCORE_BOUNDS` | 3.0 | Outlier clipping threshold for normalization |
| `HIGH_PRESSURE_THRESHOLD` | 50 | Threshold for flagging "high" risk zones |

**Tuning guidance:**
- Lower `BASE_SCALE_PERCENT` → tighter focus, higher weights near ATM
- Higher `NORMALIZATION_WINDOW` → smoother signal, less reactive
- Higher `ZSCORE_BOUNDS` → less clipping, more range in [-100, 100]

## Data Sources

### Real-time (per snapshot, ~10 sec interval)
- **Gamma** — IBKR modelGreeks (existing)
- **Delta** — IBKR modelGreeks (newly collected)
- **Vega** — IBKR modelGreeks (newly collected)
- **Spot Price** — IBKR underlying price
- **IV** — Weighted PUT/CALL ATM IV from IV poller

### Historical
- Volume snapshots in `frontend/data/volumes/YYYY-MM-DD.json` (local)
- IV snapshots in `frontend/data/iv-monitor/YYYY-MM-DD.json` (local)
- Optional Supabase tables: `volumes_snapshots`, `iv_snapshots`

## Known Limitations

1. **Vanna is approximated** — Uses Black-Scholes formula with IBKR vega, not true delta rehedge observations
2. **Proximity scale is simplified** — Assumes constant expected move (no volatility smile)
3. **No directional bias included** — Assumes calls = dealer long, puts = dealer short (standard heuristic)
4. **No portfolio effects** — Treats each strike independently, ignores cross-strike correlations
5. **IV-only dynamics** — Does not model skew or term structure changes

## Technical Details

### Vanna Calculation
```typescript
d2 = [ln(S/K) - 0.5σ²T] / (σ√T)
Vanna ≈ -Vega × d2 / σ
```

Scaled to millions of $ like GEX for comparison.

### Proximity Weight
```typescript
distance = |Strike - Spot|
scale = Spot × 0.01 × IV_Adjustment
weight = exp(-distance / scale)
```

Minimum scale = 0.5 to prevent over-concentration.

### Normalization
```typescript
For each strike:
  window = last N pressures
  mean = average(window)
  stdDev = sqrt(variance(window))
  zScore = (pressure - mean) / stdDev
  normalized = clip(zScore / 3, -100, 100)
```

Robust to outliers via z-score clipping at ±3σ.

## Files Modified/Created

### New Files
- `frontend/src/lib/vanna.ts` — Vanna calculation
- `frontend/src/lib/hedgingPressure.ts` — Pressure model
- `frontend/src/lib/hedgingPressureConfig.ts` — Configurable parameters
- `frontend/src/app/api/hedging-pressure/route.ts` — API endpoint
- `frontend/src/app/hedging-pressure/page.tsx` — UI component
- `HEDGING_PRESSURE_TEST_CHECKLIST.md` — Testing guide
- `HEDGING_PRESSURE_README.md` — This file

### Modified Files
- `execution/tws_volumes_poller.py` — Collects delta/vega from IBKR
- `frontend/src/app/api/gex/route.ts` — Extended StrikeRow interface
- `frontend/src/app/spx-gamma/page.tsx` — Added navigation button

## Performance Considerations

- **API response time:** ~200-500ms (calculates over all 37 strikes, 600+ snapshots)
- **Chart rendering:** ~300ms per mode switch
- **Real-time updates:** Every 15s, aligned with GEX polling
- **Memory:** ~5-10MB for pressure history (1000-point limit per strike)

For sessions > 8 hours, consider archiving pressure history or sampling.

## Troubleshooting

**Q: All bars are zero (flat pressure)**
- A: Spot hasn't moved much, or IV is static. This is normal in calm markets.

**Q: Pressure values jump around wildly**
- A: Reduce NORMALIZATION_WINDOW (defaults to 20), or increase ZSCORE_BOUNDS.

**Q: Vanna component is always null/zero**
- A: Poller not collecting vega → check `frontend/data/volumes/YYYY-MM-DD.json` for vega field.

**Q: Charts not updating**
- A: Check browser network tab, ensure API is returning new data each 15s.

## Future Enhancements

1. **Live dealer positioning** — If hedge rebalancing data becomes available
2. **Volatility smile** — Account for OTM IV levels, not just ATM
3. **Multi-leg effects** — Spreads, butterflies, etc.
4. **Temporal decay** — Weight recent snapshots more heavily
5. **Cross-asset hedging** — Consider ES futures, VIX futures hedge ratios
6. **User alerts** — Notify when pressure exceeds threshold or changes sharply
7. **Backtesting** — Correlate pressure with realized intraday acceleration

