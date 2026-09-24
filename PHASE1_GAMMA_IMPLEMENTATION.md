# SPX GAMMA & VOLATILITY ANALYZER - PHASE 1 IMPLEMENTATION

## 📊 Completamento FASE 1

La **FASE 1** è stata completata con successo. La pagina è funzionante con:

✅ Replica visiva fedele di Cattura16.JPG  
✅ Layout dark theme professionale  
✅ Price Chart con candlestick  
✅ GEX Chart sincronizzato  
✅ Livelli Gamma dinamici (Long/Short/Call/Put)  
✅ Mock data realistici  
✅ Tooltip interattivo  
✅ Crosshair sincronizzato  
✅ Status bar con metriche  
✅ Control panel  

---

## 🗂️ ARCHITETTURA DELLA SOLUZIONE

### Directory Structure

```
frontend/src/
├── app/spx-gamma-v2/
│   ├── page.tsx                 # Main page component
│   └── page.module.css          # Page styling
│
├── components/spx-gamma-v2/
│   ├── PriceChart.tsx           # Candlestick chart
│   ├── PriceChart.module.css
│   ├── GexChart.tsx             # GEX bars chart
│   ├── GexChart.module.css
│   ├── StatusBar.tsx            # Metrics display
│   ├── StatusBar.module.css
│   ├── ControlPanel.tsx         # Controls (timeframe, ATM range, etc)
│   ├── ControlPanel.module.css
│   ├── Tooltip.tsx              # Detailed tooltip on hover
│   └── Tooltip.module.css
│
├── data/
│   └── mockProvider.ts          # Mock data generator with realistic simulations
│
└── types/
    └── gamma.ts                 # TypeScript interfaces and enums
```

---

## 📐 COMPONENTI PRINCIPALI

### 1. **PriceChart.tsx**
- Canvas-based rendering per performance
- Candlestick con colori: Cyan (up), Grey (down)
- Gamma level lines:
  - **Cyan**: Major Long Gamma
  - **Violet**: Major Short Gamma
  - **Green**: Call Gamma
  - **Red**: Put Gamma
  - **White dashed**: Spot
- Grid sottile con label prezzo
- Crosshair sincronizzato
- Right sidebar con label

**Proprietà principali:**
- `candles: CandleData[]` - 1-min candlestick data
- `spot: number` - Current spot price
- `longGamma, shortGamma, callGamma, putGamma: number` - Gamma levels
- `onCrosshairMove: (x, y, timestamp?) => void` - Crosshair callback
- `crosshairX?: number` - Crosshair position

---

### 2. **GexChart.tsx**
- Canvas-based rendering
- Candlestick sincronizzati con Price Chart
- GEX bars: positive (cyan), negative (grey)
- Zero line prominente
- Gamma level overlays
- Right price axis sincronizzato
- Asse Y GEX a sinistra ($M)

**Proprietà principali:**
- `gexBars: GexBar[]` - GEX data per strike
- Stessi gamma levels di Price Chart
- `crosshairX?: number` - Crosshair position

---

### 3. **StatusBar.tsx**
- Inline metrics display
- Monospace font
- Colori per regime detection
- Sezioni separate per:
  - Spot e ATM
  - Gamma levels (Long, Short, Call, Put) con distanza
  - IV metrics (ATM, Call, Put, Spread)
  - Pressure indicators (Gamma, Volatility)
  - Market Regime
  - Data source indicator (SIMULATED)

---

### 4. **ControlPanel.tsx**
- Timeframe selector: 1m, 5m, 15m
- ATM Range: ±1, ±2, ±3, ±5 strikes
- Expiration: 0DTE, 1DTE, Weekly, Monthly
- Pause/Resume button
- Styled button groups

---

### 5. **Tooltip.tsx**
- Fixed position relative to cursor
- Multi-section layout:
  - Time
  - OHLC (se disponibile)
  - Gamma levels
  - IV metrics
  - Pressures e regime
- Formatted numbers (2 decimals per prezzo, %)
- Colori per Put/Call IV spread

---

### 6. **MockDataProvider.ts**
Generatore di dati realistici che simula:

**Price Movement:**
- Random walk con mean reversion
- Trend direction con occasional reversals
- Realistic volatility regimes: quiet, expanding, compressing
- Put demand bias dynamics

**Options Chain:**
- ±3 strikes attorno all'ATM (default, configurabile)
- IV smile modeling (Put IV > Call IV)
- Gamma peak vicino ATM
- Realistic open interest distribution
- Black-Scholes delta approximation

**GEX Calculation:**
Formula standard: `GEX = Gamma × OI × Multiplier × Spot² × 0.01`
- Call gamma positivo
- Put gamma negativo
- GEX aggregato per strike

**Gamma Metrics:**
- Major Long Gamma: massimo GEX positivo
- Major Short Gamma: massimo GEX negativo
- Call/Put Gamma: picchi separati
- Gamma Pressure: -100 a +100 based on:
  - Distanza da Long/Short Gamma
  - Trend direction
  - Volatility regime

**Volatility Metrics:**
- ATM IV, Call IV, Put IV
- IV Spread (Put - Call)
- IV Momentum (Δ IV / Δt)

**Market Regime Detection:**
Automatico basato su:
- Gamma Pressure magnitude
- Volatility regime
- Put/Call IV imbalance

---

## 🎨 DESIGN & COLORS

### Palette

| Elemento | Colore | Hex | Uso |
|----------|--------|-----|-----|
| Background | Quasi nero | #0a0e27 | Sfondo principale |
| Grid | Grigio scuro | #1a1f35 | Griglia sottile |
| Text | Grigio chiaro | #b0b8cc | Testi principali |
| Candlestick Up | Cyan | #00d4ff | Candle rialzista |
| Candlestick Down | Grigio | #555555 | Candle ribassista |
| Long Gamma | Cyan | #00ffff | Livello stabile |
| Short Gamma | Viola | #aa00ff | Livello espansiva |
| Call Gamma | Verde | #00ff00 | Call side |
| Put Gamma | Rosso | #ff3333 | Put side |
| Spot | Bianco | #ffffff | Prezzo corrente |
| GEX Up | Cyan | #00d4ff | GEX positivo |
| GEX Down | Grigio | #555555 | GEX negativo |

### Typography
- Font: Courier New / monospace
- Size: 11-12px per default, 10px per labels
- Weight: 400 normal, 700 bold

---

## 💾 DATA FLOW

### Sequenza inizializzazione

1. **Provider** creato in useEffect
2. **Initial snapshots** generati (20 candlestick)
3. **State** settato con primo snapshot
4. **Charts** renderizzati

### Update Loop

```
Each 1 second (configurable via timeframe):
  generateSnapshot(previousSnapshot)
    → random price movement
    → update volatilityRegime
    → generate options chain
    → calculate GEX
    → detect gamma levels
    → calculate metrics
    → update state
  → re-render charts
```

### Snapshot Structure

```typescript
{
  timestamp: number
  marketSnapshot: {
    timestamp, spot, atmStrike, date
  }
  optionsChain: OptionChain[]
  gammaMetrics: {
    spot, atm, majorLongGamma, majorShortGamma,
    callGamma, putGamma, totalGex, gammaPressure,
    gammaMomentum, volatilityPressure, regime
  }
  volatilityMetrics: {
    atmIv, callIv, putIv, ivSpread, ivMomentum
  }
  priceCandles: CandleData[]
  gexBars: GexBar[]
}
```

---

## 🔧 FORMULE E CALCOLI

### GEX (Gamma Exposure)

```typescript
GEX = Gamma × Open_Interest × Multiplier × Spot² × 0.01

Multiplier = 100 (per SPX)

Call GEX = +gamma_c × oi_c × mult × spot² × 0.01
Put GEX = -gamma_p × oi_p × mult × spot² × 0.01
Total GEX per strike = Call GEX + Put GEX
```

### Gamma Pressure (Proprietario)

```typescript
distToLong = spot - majorLongGamma
distToShort = spot - majorShortGamma

pressure = (-distToLong * 10 + distToShort * 8) 
         × (1 + volatility * 5)
         × trendDirectionBias

normalized = max(-100, min(100, pressure / 10))
```

Interpretazione:
- **+100**: Strong upside/expansive pressure
- **0**: Neutral
- **-100**: Strong downside/expansive pressure

### Volatility Pressure

```typescript
basePressure = regime_based_value
  + (putIv - callIv) × 20

normalized = clamped to [-100, 100]
```

### Regime Detection

- **GAMMA_STABLE**: `|gammaPressure| < 60 && putIv ≈ callIv`
- **UPSIDE_PRESSURE**: `gammaPressure > 60`
- **DOWNSIDE_PRESSURE**: `gammaPressure < -60`
- **VOLATILITY_EXPANSION**: `|volatilityPressure| > 70 && expanding`
- **VOLATILITY_COMPRESSION**: `|volatilityPressure| > 70 && compressing`
- **PUT_DEMAND**: `putIv > callIv + 1`

---

## 📍 SINCRONIZZAZIONE CHARTS

I due chart (Price e GEX) sono **perfettamente sincronizzati** temporalmente:

1. **Timeline sincronizzato**: stesso periodo X (candlestick timeline)
2. **Crosshair sincronizzato**: move on one → move on both
3. **Zoom/Pan**: gestito nel parent component per future expansion
4. **Gamma level lines**: stesse linee in entrambi i chart

**Implementazione:**
- State centrale nel component principale
- Passa stesso `crosshairX` a entrambi i chart
- `onCrosshairMove` callback aggiorna sia tooltip che position

---

## 🎯 PRIMO PASSO POST-FASE 1

Quando siete pronti per collegare i dati reali:

### 1. Creare un data adapter

```typescript
// frontend/src/data/realDataProvider.ts
class RealDataProvider {
  async getMarketData(date: string): Promise<MarketSnapshot>
  async getOptionsChain(strike: number): Promise<OptionChain[]>
  async subscribeToLiveData(): Promise<void>
}
```

### 2. Switchare il provider

```typescript
// page.tsx
const provider = process.env.NEXT_PUBLIC_USE_MOCK === 'true'
  ? new MockDataProvider()
  : new RealDataProvider();
```

### 3. Collegare IBKR

Le API sono già strutturate per accettare dati da IBKR via:
- API route `/api/market`
- API route `/api/iv-monitor`
- Python pollers (esistenti)

---

## 🚀 ACCESSIBILITÀ

La pagina è accessibile a:

```
http://localhost:3000/spx-gamma-v2
```

Il dev server rimane acceso per testare in tempo reale.

---

## ✅ PROSSIMI STEP (Secondo il vostro brief)

### FASE 2: Gamma Momentum & Migration
- [ ] Track gamma level changes over time
- [ ] Calculate migration speed (pts/min)
- [ ] Display on chart con arrow/indicator

### FASE 3: Gamma Momentum avanzato
- [ ] GEX momentum calculation
- [ ] Display rising/falling/neutral state

### FASE 4: IV Dynamics avanzato
- [ ] Put/Call IV skew visualization
- [ ] IV smile rendering
- [ ] IV percentile ranking

### FASE 5: Signals & Events
- [ ] Level crossing detection
- [ ] Gamma acceleration events
- [ ] Alert system

### FASE 6: Volatility Pressure avanzato
- [ ] IV term structure
- [ ] Volatility regime changes
- [ ] Compression/expansion scoring

### FASE 7: Market Regime advanced
- [ ] Regime persistence scoring
- [ ] Regime transition probabilities
- [ ] Historical regime distribution

### FASE 8: Real Data Integration
- [ ] IBKR connection
- [ ] Live options data
- [ ] Live price feed

### FASE 9: Historical Playback
- [ ] Date selector
- [ ] Backtest mode
- [ ] Data archival

---

## 📝 NOTE IMPORTANTI

### Performance
- Canvas rendering evita DOM thrashing
- Max 100 candlestick in memoria
- Max 100 GEX bar in memoria
- Update ogni 1 secondo (configurable)

### Data Integrity
- **SIMULATED** clearly marked in UI
- Mock provider separato da visualization
- No data mixing con real providers

### Type Safety
- Full TypeScript coverage
- Clear interfaces per ogni data type
- Enum per Market Regime

### Modularity
- Ogni componente è indipendente
- Facile da testare
- Facile da staccare/ricollegare

---

## 🐛 Known Limitations (FASE 1)

1. **No historical data**: Solo current day
2. **No level crossing events**: Richiede FASE 5
3. **No IV term structure**: Richiede FASE 4+
4. **No Gamma migration tracking**: Richiede FASE 2
5. **No data persistence**: Solo in-memory
6. **No alert system**: Richiede FASE 5
7. **ATM Range fixed**: Deve essere dinamico in FASE 4+

---

## 📞 Quick Reference

### Launch Dev Server
```bash
cd frontend && npm run dev
```

### Build for Production
```bash
cd frontend && npm run build && npm start
```

### Files to Edit for Mock Data
```
frontend/src/data/mockProvider.ts
  - Adjust price ranges
  - Modify volatility regimes
  - Change IV curves
  - Alter gamma distributions
```

### Files to Add for Real Data
```
frontend/src/data/realDataProvider.ts (new)
frontend/src/lib/ibkr-adapter.ts (new)
frontend/src/app/api/gamma/route.ts (new)
```

---

## 🎓 Understanding the Charts

### Price Chart (Top)
- **X-axis**: Time (UTC-4)
- **Y-axis (Left)**: Convexity/Overflow (deprecated from image, can be removed)
- **Y-axis (Right)**: SPX Price
- **Candlesticks**: 1-min OHLC
- **Lines**: Gamma level projections

### GEX Chart (Bottom)
- **X-axis**: Time (synchronized)
- **Y-axis (Left)**: GEX in $M
- **Y-axis (Right)**: SPX Price (reference)
- **Bars**: GEX per strike (colored by sign)
- **Lines**: Same gamma levels as above

### Status Bar
Real-time metrics dashboard with:
- Position (Spot vs Gamma levels)
- Greeks aggregates
- Pressure scores
- Market regime

---

## ✨ CONCLUSIONE FASE 1

La struttura è **production-ready** per mockups e può essere collegata ai dati reali senza rifactoring principale.

Tutti i componenti sono indipendenti, testabili, e ben documentati.

**Next Action**: Aprire il browser su `http://localhost:3000/spx-gamma-v2` per visualizzare il risultato.
