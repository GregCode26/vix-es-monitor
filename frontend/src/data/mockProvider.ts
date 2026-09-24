import {
  AnalysisSnapshot,
  CandleData,
  GammaLevel,
  GexBar,
  MarketRegime,
  OptionChain,
} from "@/types/gamma";

const MOCK_START_SPOT = 6680;
const MOCK_ATM_RANGE = 3; // ±3 strikes
const MOCK_STRIKE_SIZE = 5; // 5-point strikes
const MULTIPLIER = 100;

export class MockDataProvider {
  private currentSpot: number = MOCK_START_SPOT;
  private currentTime: number;
  private trendDirection: number = 1;
  private volatilityRegime: "quiet" | "expanding" | "compressing" = "quiet";
  private putDemandBias: number = 0;
  private baseIv: number = 14.5;

  constructor(startTimeHours: number = 14, startTimeMinutes: number = 50) {
    const now = new Date();
    now.setHours(startTimeHours, startTimeMinutes, 0, 0);
    this.currentTime = now.getTime();
  }

  /**
   * Generate realistic options chain for ±N strikes around ATM
   */
  private generateOptionsChain(spot: number, range: number = MOCK_ATM_RANGE): OptionChain[] {
    const atm = Math.round(spot / MOCK_STRIKE_SIZE) * MOCK_STRIKE_SIZE;
    const chain: OptionChain[] = [];

    // Generate strikes around ATM
    for (let i = -range; i <= range; i++) {
      const strike = atm + i * MOCK_STRIKE_SIZE;
      const distanceFromAtm = Math.abs(strike - spot);
      const distanceMultiplier = 1 + (distanceFromAtm / spot) * 2;

      // Simulate realistic IV smile
      const callIv = this.baseIv * (1 + Math.pow(distanceFromAtm / MOCK_STRIKE_SIZE / 2, 1.5) * 0.15);
      const putIv = this.baseIv * (1 + Math.pow(distanceFromAtm / MOCK_STRIKE_SIZE / 2, 1.5) * 0.18);

      // Simulate gamma peak near ATM, declining away
      const callGamma = (1 / (1 + Math.pow(distanceFromAtm / 2, 2))) * (0.008 * (1 + Math.random() * 0.1));
      const putGamma = (1 / (1 + Math.pow(distanceFromAtm / 2, 2))) * (0.008 * (1 + Math.random() * 0.1));

      const callOi = Math.max(100, 10000 * Math.exp(-Math.pow(distanceMultiplier, 2) / 2));
      const putOi = Math.max(100, 12000 * Math.exp(-Math.pow(distanceMultiplier, 2) / 2) * (1 + this.putDemandBias * 0.3));

      chain.push({
        strike,
        call: {
          bid: strike + Math.random() * 0.1,
          ask: strike + Math.random() * 0.1 + 0.05,
          mid: strike,
          volume: Math.floor(Math.random() * 500),
          openInterest: callOi,
          iv: callIv,
          greeks: {
            delta: this.blackScholesCallDelta(spot, strike, 0.01, callIv),
            gamma: callGamma,
            vega: 0.05,
            theta: -0.003,
          },
        },
        put: {
          bid: strike - Math.random() * 0.1,
          ask: strike - Math.random() * 0.1 - 0.05,
          mid: strike,
          volume: Math.floor(Math.random() * 500),
          openInterest: putOi,
          iv: putIv,
          greeks: {
            delta: this.blackScholesCallDelta(spot, strike, 0.01, putIv) - 1,
            gamma: putGamma,
            vega: 0.05,
            theta: -0.002,
          },
        },
      });
    }

    return chain;
  }

  /**
   * Simplified Black-Scholes delta calculation
   */
  private blackScholesCallDelta(S: number, K: number, T: number, sigma: number): number {
    const d1 = (Math.log(S / K) + sigma * sigma * T / 2) / (sigma * Math.sqrt(T));
    return this.cumulativeNormalDistribution(d1);
  }

  /**
   * Cumulative normal distribution approximation
   */
  private cumulativeNormalDistribution(x: number): number {
    return 0.5 * (1 + this.erf(x / Math.sqrt(2)));
  }

  /**
   * Error function approximation
   */
  private erf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }

  /**
   * Calculate GEX for an options chain
   */
  private calculateGex(chain: OptionChain[], spot: number): Map<number, number> {
    const gexMap = new Map<number, number>();

    chain.forEach((option) => {
      const callGex =
        option.call.greeks.gamma * option.call.openInterest * MULTIPLIER * Math.pow(spot, 2) * 0.01;
      const putGex =
        -option.put.greeks.gamma * option.put.openInterest * MULTIPLIER * Math.pow(spot, 2) * 0.01;

      gexMap.set(option.strike, callGex + putGex);
    });

    return gexMap;
  }

  /**
   * Calculate major gamma levels
   */
  private calculateMajorLevels(chain: OptionChain[], gexMap: Map<number, number>, spot: number) {
    let longGamma = MOCK_START_SPOT;
    let shortGamma = MOCK_START_SPOT - 10;
    let maxLongGex = -Infinity;
    let maxShortGex = Infinity;

    gexMap.forEach((gex, strike) => {
      if (gex > maxLongGex) {
        maxLongGex = gex;
        longGamma = strike;
      }
      if (gex < maxShortGex) {
        maxShortGex = gex;
        shortGamma = strike;
      }
    });

    // Find call/put gamma peaks
    let callGamma = MOCK_START_SPOT + 5;
    let putGamma = MOCK_START_SPOT - 3;
    let maxCallGamma = -Infinity;
    let maxPutGamma = -Infinity;

    chain.forEach((option) => {
      if (option.call.greeks.gamma > maxCallGamma && option.strike > spot) {
        maxCallGamma = option.call.greeks.gamma;
        callGamma = option.strike;
      }
      if (option.put.greeks.gamma > maxPutGamma && option.strike < spot) {
        maxPutGamma = option.put.greeks.gamma;
        putGamma = option.strike;
      }
    });

    return { longGamma, shortGamma, callGamma, putGamma };
  }

  /**
   * Calculate gamma pressure (proprietary indicator)
   */
  private calculateGammaPressure(
    levels: { longGamma: number; shortGamma: number },
    spot: number,
    trendDir: number,
    volatility: number
  ): number {
    const distToLong = spot - levels.longGamma;
    const distToShort = spot - levels.shortGamma;
    const pressureScore =
      (-distToLong * 10 + distToShort * 8) * (1 + volatility * 5) * (trendDir > 0 ? 1.2 : 0.8);

    return Math.max(-100, Math.min(100, pressureScore / 10));
  }

  /**
   * Simulate price movement
   */
  private simulatePrice(): number {
    // Random walk with mean reversion and regime changes
    const randomWalk = (Math.random() - 0.5) * 4;
    const meanReversion = (MOCK_START_SPOT - this.currentSpot) * 0.001;
    const trend = this.trendDirection * 0.5;

    this.currentSpot = Math.max(6650, Math.min(6750, this.currentSpot + randomWalk + meanReversion + trend));

    // Regime changes (every 20 minutes approximately)
    if (Math.random() < 0.02) {
      this.trendDirection *= -1;
    }

    if (Math.random() < 0.01) {
      const nextRegime = ["quiet", "expanding", "compressing"] as const;
      this.volatilityRegime = nextRegime[Math.floor(Math.random() * 3)];
    }

    // Put demand bias
    if (Math.random() < 0.005) {
      this.putDemandBias = (Math.random() - 0.5) * 2;
    }

    return this.currentSpot;
  }

  /**
   * Update base IV based on regime
   */
  private updateVolatility(): void {
    switch (this.volatilityRegime) {
      case "expanding":
        this.baseIv = Math.min(25, this.baseIv + Math.random() * 0.3);
        break;
      case "compressing":
        this.baseIv = Math.max(10, this.baseIv - Math.random() * 0.2);
        break;
      default:
        this.baseIv += (Math.random() - 0.5) * 0.1;
    }
  }

  /**
   * Generate candlestick data
   */
  private generateCandles(
    spot: number,
    previousCandles: CandleData[] = [],
    count: number = 1
  ): CandleData[] {
    const candles = [...previousCandles];

    for (let i = 0; i < count; i++) {
      const timestamp = this.currentTime + i * 60000; // 1-min candles
      const open = i === 0 && candles.length > 0 ? candles[candles.length - 1].close : spot;
      const close = spot + (Math.random() - 0.5) * 2;
      const high = Math.max(open, close) + Math.random() * 1;
      const low = Math.min(open, close) - Math.random() * 1;
      const volume = Math.floor(1000 + Math.random() * 5000);

      candles.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    // Keep only last 100 candles
    return candles.slice(-100);
  }

  /**
   * Generate GEX bars
   */
  private generateGexBars(chain: OptionChain[], spot: number, previousBars: GexBar[] = []): GexBar[] {
    const gexMap = this.calculateGex(chain, spot);
    const bars: GexBar[] = [];

    gexMap.forEach((gex, strike) => {
      const option = chain.find((o) => o.strike === strike);
      if (option) {
        const callGex =
          option.call.greeks.gamma * option.call.openInterest * MULTIPLIER * Math.pow(spot, 2) * 0.01;
        const putGex =
          -option.put.greeks.gamma * option.put.openInterest * MULTIPLIER * Math.pow(spot, 2) * 0.01;

        bars.push({
          timestamp: this.currentTime,
          strike,
          gex,
          callGex,
          putGex,
        });
      }
    });

    const allBars = [...previousBars, ...bars];
    return allBars.slice(-100); // Keep last 100
  }

  /**
   * Main snapshot generation
   */
  generateSnapshot(previousSnapshot?: AnalysisSnapshot): AnalysisSnapshot {
    this.currentTime += 60000; // Advance 1 minute
    this.simulatePrice();
    this.updateVolatility();

    const spot = this.currentSpot;
    const atm = Math.round(spot / MOCK_STRIKE_SIZE) * MOCK_STRIKE_SIZE;

    const chain = this.generateOptionsChain(spot, MOCK_ATM_RANGE);
    const gexMap = this.calculateGex(chain, spot);
    const levels = this.calculateMajorLevels(chain, gexMap, spot);

    // Calculate IV metrics
    const callIv =
      chain.find((c) => c.strike === atm)?.call.iv ||
      chain.find((c) => c.strike > atm)?.call.iv ||
      this.baseIv;
    const putIv =
      chain.find((c) => c.strike === atm)?.put.iv ||
      chain.find((c) => c.strike < atm)?.put.iv ||
      this.baseIv;
    const atmIv = (callIv + putIv) / 2;

    // Calculate previous metrics for momentum
    const prevGammaMetrics = previousSnapshot?.gammaMetrics;
    const prevVolMetrics = previousSnapshot?.volatilityMetrics;
    const gammaMomentum = prevGammaMetrics
      ? (levels.longGamma - prevGammaMetrics.majorLongGamma) * 10
      : 0;
    const ivMomentum = prevVolMetrics ? (atmIv - prevVolMetrics.atmIv) * 100 : 0;

    // Calculate pressures
    const gammaPressure = this.calculateGammaPressure(levels, spot, this.trendDirection, this.baseIv / 15);
    const volatilityPressure =
      (this.volatilityRegime === "expanding"
        ? 50 + Math.random() * 50
        : this.volatilityRegime === "compressing"
          ? -50 - Math.random() * 50
          : -20 + Math.random() * 40) + (putIv - callIv) * 20;

    // Determine regime
    let regime = MarketRegime.GAMMA_STABLE;
    if (Math.abs(gammaPressure) > 60) {
      regime = gammaPressure > 0 ? MarketRegime.UPSIDE_PRESSURE : MarketRegime.DOWNSIDE_PRESSURE;
    }
    if (Math.abs(volatilityPressure) > 70) {
      regime =
        volatilityPressure > 0 ? MarketRegime.VOLATILITY_EXPANSION : MarketRegime.VOLATILITY_COMPRESSION;
    }
    if (putIv > callIv + 1) {
      regime = MarketRegime.PUT_DEMAND;
    }

    const priceCandles = this.generateCandles(
      spot,
      previousSnapshot?.priceCandles || [],
      previousSnapshot ? 1 : 20
    );
    const gexBars = this.generateGexBars(chain, spot, previousSnapshot?.gexBars || []);

    // Extract ATM options (find closest strike if exact match not found)
    const atmOption = chain.find((o) => o.strike === atm) ||
                      chain.reduce((closest, current) => {
                        const closestDist = Math.abs(closest.strike - atm);
                        const currentDist = Math.abs(current.strike - atm);
                        return currentDist < closestDist ? current : closest;
                      }, chain[0]);

    const atmCall = atmOption
      ? {
          price: atmOption.call.mid,
          iv: atmOption.call.iv,
          gamma: atmOption.call.greeks.gamma,
        }
      : { price: callIv, iv: callIv, gamma: 0.008 }; // Fallback

    const atmPut = atmOption
      ? {
          price: atmOption.put.mid,
          iv: atmOption.put.iv,
          gamma: atmOption.put.greeks.gamma,
        }
      : { price: putIv, iv: putIv, gamma: 0.008 }; // Fallback

    return {
      timestamp: this.currentTime,
      marketSnapshot: {
        timestamp: this.currentTime,
        spot,
        atmStrike: atm,
        date: new Date(this.currentTime).toISOString(),
      },
      optionsChain: chain,
      gammaMetrics: {
        spot,
        atm,
        majorLongGamma: levels.longGamma,
        majorShortGamma: levels.shortGamma,
        callGamma: levels.callGamma,
        putGamma: levels.putGamma,
        totalGex: Array.from(gexMap.values()).reduce((a, b) => a + b, 0),
        gammaPressure,
        gammaMomentum,
        volatilityPressure,
        regime,
      },
      volatilityMetrics: {
        atmIv,
        callIv,
        putIv,
        ivSpread: putIv - callIv,
        ivMomentum,
      },
      priceCandles,
      gexBars,
      atmCall,
      atmPut,
    };
  }
}

export function createMockProvider(): MockDataProvider {
  return new MockDataProvider();
}
