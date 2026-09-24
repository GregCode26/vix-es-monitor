"use client";

import React from "react";
import { GammaMetrics, VolatilityMetrics, MarketRegime } from "@/types/gamma";
import styles from "./StatusBar.module.css";

interface StatusBarProps {
  metrics: GammaMetrics;
  volatilityMetrics: VolatilityMetrics;
  dataSource?: "MOCK" | "REAL";
}

const REGIME_COLORS: Record<MarketRegime, string> = {
  [MarketRegime.GAMMA_STABLE]: "#00ff00",
  [MarketRegime.GAMMA_EXPANSION]: "#ffaa00",
  [MarketRegime.VOLATILITY_EXPANSION]: "#ff3333",
  [MarketRegime.VOLATILITY_COMPRESSION]: "#0099ff",
  [MarketRegime.UPSIDE_PRESSURE]: "#00ff00",
  [MarketRegime.DOWNSIDE_PRESSURE]: "#ff3333",
  [MarketRegime.PUT_DEMAND]: "#ff3333",
  [MarketRegime.CALL_DEMAND]: "#00ff00",
  [MarketRegime.BREAKOUT_RISK]: "#ffaa00",
  [MarketRegime.MEAN_REVERSION]: "#0099ff",
};

export const StatusBar: React.FC<StatusBarProps> = ({ metrics, volatilityMetrics, dataSource = "MOCK" }) => {
  const regimeColor = REGIME_COLORS[metrics.regime];

  const formatNumber = (num: number, decimals: number = 2): string => {
    return num.toFixed(decimals);
  };

  return (
    <div className={styles.statusBar}>
      <div className={styles.section}>
        <div className={styles.label}>SPOT</div>
        <div className={styles.value}>{formatNumber(metrics.spot, 2)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>ATM</div>
        <div className={styles.value}>{formatNumber(metrics.atm, 0)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>LONG GAMMA</div>
        <div className={styles.value}>{formatNumber(metrics.majorLongGamma, 2)}</div>
        <div className={styles.distance}>
          {formatNumber(metrics.spot - metrics.majorLongGamma, 2)}
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>SHORT GAMMA</div>
        <div className={styles.value}>{formatNumber(metrics.majorShortGamma, 2)}</div>
        <div className={styles.distance}>
          {formatNumber(metrics.spot - metrics.majorShortGamma, 2)}
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>CALL GAMMA</div>
        <div className={styles.value}>{formatNumber(metrics.callGamma, 2)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>PUT GAMMA</div>
        <div className={styles.value}>{formatNumber(metrics.putGamma, 2)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>ATM IV</div>
        <div className={styles.value}>{formatNumber(volatilityMetrics.atmIv, 2)}%</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>CALL IV</div>
        <div className={styles.value}>{formatNumber(volatilityMetrics.callIv, 2)}%</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>PUT IV</div>
        <div className={styles.value}>{formatNumber(volatilityMetrics.putIv, 2)}%</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>IV SPREAD</div>
        <div className={styles.value}>{formatNumber(volatilityMetrics.ivSpread, 2)}%</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>GAMMA PRESSURE</div>
        <div className={styles.value}>{formatNumber(metrics.gammaPressure, 1)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>VOLATILITY PRESSURE</div>
        <div className={styles.value}>{formatNumber(metrics.volatilityPressure, 1)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>REGIME</div>
        <div className={styles.value} style={{ color: regimeColor }}>
          {metrics.regime.replace(/_/g, " ")}
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.label}>DATA</div>
        <div
          className={styles.value}
          style={{ color: dataSource === "REAL" ? "#00ff00" : "#ffaa00" }}
        >
          {dataSource}
        </div>
      </div>
    </div>
  );
};
