# SPX GAMMA ANALYZER - QUICK START

## 🚀 Inizia Subito

### Apri il Browser

La pagina è disponibile a:

```
http://localhost:3000/spx-gamma-v2
```

Se il dev server non è in esecuzione, avvialo:

```bash
cd frontend
npm run dev
```

---

## 📊 Cosa Vedi

### Layout (Replica Cattura16.JPG)

```
┌─────────────────────────────────────────────────────────────────┐
│ [Controls] Timeframe | ATM Range | Expiration | Pause/Resume    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ ┌────────────── PRICE CHART (70% height) ─────────────────────┐ │
│ │                                                               │ │
│ │  Candlestick SPX                     [Right Side Labels:]    │ │
│ │  + Gamma Levels (lines)                SPOT: 6688            │ │
│ │  + Grid                                LONG: 6685            │ │
│ │  + Crosshair on hover                  CALL: 6685            │ │
│ │  + Tooltip                             PUT: 6668             │ │
│ │                                        SHORT: 6670           │ │
│ │                                                               │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌────────────── GEX CHART (30% height) ──────────────────────┐ │
│ │                                                               │ │
│ │  GEX Bars (positive/negative)          [Right Side Labels:]  │ │
│ │  + Candlestick overlay                 (Price axis synced)  │ │
│ │  + Gamma Levels (same lines)                                 │ │
│ │  + Zero line                                                 │ │
│ │  + Synchronized crosshair                                    │ │
│ │                                                               │ │
│ └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ [STATUS BAR - Real-time Metrics]                                │
│ SPOT | ATM | LONG G | SHORT G | CALL G | PUT G | ATM IV | ...  │
│ CALL IV | PUT IV | IV SPREAD | GAMMA PRESS | VOL PRESS | REGIME│
│ DATA: SIMULATED                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎮 Controlli

### Timeframe
- **1m**: Default (1-minute candlesticks)
- **5m**: 5-minute aggregation (futura)
- **15m**: 15-minute aggregation (futura)

### ATM Range
- **±1**: 1 strike intorno ATM
- **±2**: 2 strike intorno ATM
- **±3**: 3 strike intorno ATM (default)
- **±5**: 5 strike intorno ATM

### Expiration
- **0DTE**: 0 days to expiration (default, current)
- **1DTE**: 1 day to expiration
- **Weekly**: Weekly options
- **Monthly**: Monthly options

### Play/Pause
- **Pause**: Ferma l'aggiornamento dati
- **Resume**: Riprendi aggiornamento

---

## 👆 Interazione

### Mouse Over Charts
Quando passi il mouse sopra uno dei chart:

1. **Crosshair** verticale appare in ENTRAMBI i chart (sincronizzato)
2. **Tooltip** appare mostrando:
   - Timestamp
   - OHLC (se su price chart)
   - Spot price
   - Gamma levels (con distanza)
   - IV metrics
   - Pressures e regime

3. I due chart rimangono sincronizzati temporalmente

### Colori Gamma Levels

| Colore | Significato |
|--------|-------------|
| 🔵 Cyan | Major Long Gamma (stabile) |
| 🟣 Viola | Major Short Gamma (espansiva) |
| 🟢 Verde | Call Gamma |
| 🔴 Rosso | Put Gamma |

### Candlestick Colors

| Colore | Significato |
|--------|-------------|
| 🔵 Cyan | Up candle (close > open) |
| ⚫ Grey | Down candle (close < open) |

---

## 📈 Leggere le Metriche (Status Bar)

### Posizione

**SPOT**: Prezzo corrente SPX  
**ATM**: Strike at-the-money più vicino

### Distanza da Gamma Levels

Esempio nel tooltip:

```
LONG GAMMA: 6680.46
Distance: +0.53  ← Spot è +0.53 sopra Long Gamma
```

Interpretazione:
- **Positivo**: Spot è SOPRA il livello
- **Negativo**: Spot è SOTTO il livello

### Gamma Pressure (-100 a +100)

```
GAMMA PRESSURE: +45
```

Significato:
- **+100**: Forte pressione rialzista/espansiva
- **+45**: Pressione media rialzista
- **0**: Neutrale
- **-45**: Pressione media ribassista
- **-100**: Forte pressione ribassista/espansiva

⚠️ **Importante**: Non confondere con bullish/bearish!  
Un valore positivo può significare anche "il prezzo sta trovando supporto ai livelli positivi".

### Volatility Pressure (-100 a +100)

```
VOLATILITY PRESSURE: -75
```

Significato:
- **+100**: Forte IV expansion
- **0**: Neutrale/Flat IV
- **-100**: Forte IV compression

### IV Spread

```
IV SPREAD: +1.5%
```

Significato:
- **Positivo**: Put IV > Call IV (domanda Put)
- **Negativo**: Call IV > Put IV (domanda Call)
- Maggiore il valore, maggiore lo skew

### Market Regime

Valori possibili (la riga sotto):

```
REGIME: GAMMA_STABLE       ← Verde, stabile
REGIME: GAMMA_EXPANSION    ← Giallo/Arancio, espansiva
REGIME: PUT_DEMAND         ← Rosso, domanda Put
REGIME: BREAKOUT_RISK      ← Arancio, rischio breakout
```

---

## 📊 Interpretar i Grafici

### Price Chart (Top)

**Cosa significa il layout:**

```
Quando la linea CYAN (Long Gamma) è SOTTO lo SPOT:
→ Il prezzo è SOPRA il livello stabile
→ Se cade, trova supporto a Cyan

Quando la linea VIOLA (Short Gamma) è SOPRA lo SPOT:
→ Il prezzo è SOTTO il livello espansivo
→ Se sale, trova resistenza a Viola
```

### GEX Chart (Bottom)

**Lettura:**

```
Barre BLU (positive) SOPRA zero:
→ Cumulative long gamma exposure
→ Tende a stabilizzare il prezzo UP

Barre GREY (negative) SOTTO zero:
→ Cumulative short gamma exposure
→ Tende ad accelerare movimento DOWN

Zero line:
→ Breakeven tra long e short
```

**Esempio:**

```
Se GEX è +1000M a 6690:
→ Hanno short 1000M in long gamma a 6690
→ Se il prezzo sale verso 6690, il gamma accelera
→ Se il prezzo cala da 6690, il gamma stabilizza

Se GEX è -800M a 6670:
→ Hanno short 800M in short gamma a 6670
→ Se il prezzo scende verso 6670, il gamma accelera
→ Se il prezzo sale da 6670, il gamma stabilizza
```

---

## 🔄 Dinamica Prezzo + Gamma + IV

### Scenario 1: Gamma Acceleration Up

```
Price movimento: 6680 → 6685 (+5)
Spot crosses LONG GAMMA ✓
GEX è positivo (+) a 6685
Gamma Pressure: +60 ← forte
Regime: UPSIDE PRESSURE

Interpretazione:
Il prezzo accelera verso l'alto
trovando gamma lungo il percorso.
Tende a mantenersi in zona 6680-6690.
```

### Scenario 2: Volatility Expansion

```
IV ATM: 14.5% → 18.2% (+3.7%)
Put IV > Call IV significativamente
Volatility Pressure: +85 ← expansion
Gamma Pressure: -30 ← compressing

Interpretazione:
La volatilità sta espandendosi.
C'è domanda Put relativa.
Il prezzo potrebbe accelerare in una direzione.
```

### Scenario 3: Gamma Compression Zone

```
Spot: 6680
Long Gamma: 6679
Short Gamma: 6681
Gamma Pressure: +5 ← vicino a zero

Interpretazione:
Siamo in mezzo tra Long e Short.
Il prezzo tende a restare confinato.
Fino a rottura da uno dei due livelli.
```

---

## 💡 Cosa Significano i DATI SIMULATI

### ✅ Realistico

Il mock data genera:
- ✓ Trend realistici
- ✓ Pullback e consolidamenti
- ✓ Gamma level migration
- ✓ IV smile curve
- ✓ Put/Call IV skew
- ✓ Regime changes

### ❌ NON è reale

- ❌ Non è prezzo IBKR
- ❌ Non è opzioni vere
- ❌ Non usare per trading
- ❌ Solo per studiare il layout e la logica

**IMPORTANTE**: Quando colleghiamo IBKR, il sistema cambierà solo il data source, non l'analisi!

---

## 🔧 Come Modificare i Mock Data

Se vuoi cambiare il comportamento del mock:

### Modifica `frontend/src/data/mockProvider.ts`

**Esempio 1: Aumenta volatilità**

```typescript
// Linea ~20
private baseIv: number = 14.5;  // ← Cambia a 20

// Linea ~41 (MOCK_START_SPOT)
const MOCK_START_SPOT = 6680;  // ← Cambia prezzo iniziale
```

**Esempio 2: Rallenta aggiornamenti**

Nel file `page.tsx`:

```typescript
// Linea ~87
updateIntervalRef.current = setInterval(update, 2000);  // ← Cambia 1000 a 2000 (1s → 2s)
```

**Esempio 3: Cambia range gamma**

```typescript
// mockProvider.ts linea ~13
const MOCK_ATM_RANGE = 3;  // ← Cambia a 5 per ±5 strikes
```

---

## ❓ Domande Frequenti

### Q: Dove vedo i dati reali?

**A**: Non ancora! Questa è FASE 1 con mock data. Per i dati reali:
1. Devi collegare IBKR
2. Creare un `RealDataProvider`
3. Aggiornare `page.tsx` per usarlo

Vedi `PHASE1_GAMMA_IMPLEMENTATION.md` per i dettagli.

### Q: Perché i livelli Gamma si muovono?

**A**: É per design! I livelli Gamma migrano nel tempo perché:
- La distribuzione OI cambia
- La IV cambia (gamma è sensibile a IV)
- La posizione relativa spot/strike cambia

Questa è la "Gamma Migration" che misurerai in FASE 2.

### Q: Cosa significa "convexity overflow"?

**A**: È il vecchio nome nel grafico originale per "GEX" o "Gamma Exposure". Nel nostro sistema è semplice "GEX ($M)".

### Q: Posso condividere i dati?

**A**: Sì, sono simulated. Non ci sono dati reali, quindi nessuna preoccupazione di confidenzialità.

### Q: Come collego IBKR?

**A**: La struttura è pronta! Devi:

1. Creare `frontend/src/data/realDataProvider.ts`
2. Implementare stessa interfaccia di `MockDataProvider`
3. Collegare ai tuoi script Python che leggono da IBKR
4. Aggiornare `page.tsx` per usare RealDataProvider

---

## 📞 Prossimi Step

Quando sei pronto:

1. **Apri browser** → `http://localhost:3000/spx-gamma-v2`
2. **Gioca un po'** → Passa il mouse, cambia controlli, osserva dinamiche
3. **Leggi** `PHASE1_GAMMA_IMPLEMENTATION.md` per architettura completa
4. **Decide** se procedere con FASE 2 (Gamma Migration) o collegare IBKR subito
5. **Contattami** se trovi bug o hai domande

---

## 🎯 Checklist Conclusione FASE 1

- ✅ Layout visivo replica Cattura16.JPG
- ✅ Price Chart con candlestick e gamma levels
- ✅ GEX Chart sincronizzato
- ✅ Gamma level detection (Long/Short/Call/Put)
- ✅ Gamma Pressure calculation
- ✅ IV metrics (ATM/Call/Put/Spread)
- ✅ Volatility Pressure
- ✅ Market Regime detection
- ✅ Crosshair sincronizzato
- ✅ Tooltip interattivo
- ✅ Status bar con metriche
- ✅ Mock data realistici
- ✅ Full TypeScript
- ✅ Production-ready code
- ✅ Documentazione completa

**Status**: ✅ FASE 1 COMPLETATA

---

Buon testing! 🚀
