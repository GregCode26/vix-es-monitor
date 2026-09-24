export interface MarketSnapshot {
  timestamp: number;
  spot: number;
  atmStrike: number;
  date: string;
}

export interface OptionGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export interface OptionChain {
  strike: number;
  call: {
    bid: number;
    ask: number;
    mid: number;
    volume: number;
    openInterest: number;
    iv: number;
    greeks: OptionGreeks;
  };
  put: {
    bid: number;
    ask: number;
    mid: number;
    volume: number;
    openInterest: number;
    iv: number;
    greeks: OptionGreeks;
  };
}

export interface GammaLevel {
  strike: number;
  callGamma: number;
  putGamma: number;
  gex: number;
  concentration: number;
}

export interface GammaMetrics {
  spot: number;
  atm: number;
  majorLongGamma: number;
  majorShortGamma: number;
  callGamma: number;
  putGamma: number;
  totalGex: number;
  gammaPressure: number;
  gammaMomentum: number;
  volatilityPressure: number;
  regime: MarketRegime;
}

export interface VolatilityMetrics {
  atmIv: number;
  callIv: number;
  putIv: number;
  ivSpread: number;
  ivMomentum: number;
}

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface GexBar {
  timestamp: number;
  strike: number;
  gex: number;
  callGex: number;
  putGex: number;
}

export enum MarketRegime {
  GAMMA_STABLE = "GAMMA_STABLE",
  GAMMA_EXPANSION = "GAMMA_EXPANSION",
  VOLATILITY_EXPANSION = "VOLATILITY_EXPANSION",
  VOLATILITY_COMPRESSION = "VOLATILITY_COMPRESSION",
  UPSIDE_PRESSURE = "UPSIDE_PRESSURE",
  DOWNSIDE_PRESSURE = "DOWNSIDE_PRESSURE",
  PUT_DEMAND = "PUT_DEMAND",
  CALL_DEMAND = "CALL_DEMAND",
  BREAKOUT_RISK = "BREAKOUT_RISK",
  MEAN_REVERSION = "MEAN_REVERSION",
}

export interface AnalysisSnapshot {
  timestamp: number;
  marketSnapshot: MarketSnapshot;
  optionsChain: OptionChain[];
  gammaMetrics: GammaMetrics;
  volatilityMetrics: VolatilityMetrics;
  priceCandles: CandleData[];
  gexBars: GexBar[];
  // ATM options data for VOLFLOW
  atmCall?: {
    price: number;
    iv: number;
    gamma: number;
  };
  atmPut?: {
    price: number;
    iv: number;
    gamma: number;
  };
}

export interface HistoricalSnapshot {
  timestamp: number;
  spot: number;
  atm: number;
  longGamma: number;
  shortGamma: number;
  callGamma: number;
  putGamma: number;
  callIv: number;
  putIv: number;
  atmIv: number;
  gex: number;
  gammaPressure: number;
  gammaMomentum: number;
  volatilityPressure: number;
  putCallIVSpread: number;
  regime: MarketRegime;
}
