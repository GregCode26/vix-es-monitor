"use client";

import React from "react";
import { GammaMetrics, VolatilityMetrics, CandleData } from "@/types/gamma";
import styles from "./Tooltip.module.css";

interface TooltipProps {
  x: number;
  y: number;
  candle?: CandleData;
  metrics: GammaMetrics;
  volatilityMetrics: VolatilityMetrics;
  visible: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  x,
  y,
  candle,
  metrics,
  volatilityMetrics,
  visible,
}) => {
  if (!visible) return null;

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  };

  const formatNumber = (num: number, decimals: number = 2): string => {
    return num.toFixed(decimals);
  };

  return (
    <div
      className={styles.tooltip}
      style={{
        left: `${x + 10}px`,
        top: `${y + 10}px`,
      }}
    >
      {candle && (
        <div className={styles.section}>
          <div className={styles.time}>{formatTime(candle.timestamp)}</div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.row}>
          <span className={styles.label}>SPOT</span>
          <span className={styles.value}>{formatNumber(metrics.spot, 2)}</span>
        </div>
        {candle && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>OPEN</span>
              <span className={styles.value}>{formatNumber(candle.open, 2)}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>HIGH</span>
              <span className={styles.value}>{formatNumber(candle.high, 2)}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>LOW</span>
              <span className={styles.value}>{formatNumber(candle.low, 2)}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>CLOSE</span>
              <span className={styles.value}>{formatNumber(candle.close, 2)}</span>
            </div>
          </>
        )}
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.row}>
          <span className={styles.label}>ATM</span>
          <span className={styles.value}>{formatNumber(metrics.atm, 0)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>LONG GAMMA</span>
          <span className={styles.value}>{formatNumber(metrics.majorLongGamma, 2)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>SHORT GAMMA</span>
          <span className={styles.value}>{formatNumber(metrics.majorShortGamma, 2)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>CALL GAMMA</span>
          <span className={styles.value}>{formatNumber(metrics.callGamma, 2)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>PUT GAMMA</span>
          <span className={styles.value}>{formatNumber(metrics.putGamma, 2)}</span>
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.row}>
          <span className={styles.label}>ATM IV</span>
          <span className={styles.value}>{formatNumber(volatilityMetrics.atmIv, 2)}%</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>CALL IV</span>
          <span className={styles.value}>{formatNumber(volatilityMetrics.callIv, 2)}%</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>PUT IV</span>
          <span className={styles.value}>{formatNumber(volatilityMetrics.putIv, 2)}%</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>IV SPREAD</span>
          <span
            className={styles.value}
            style={{ color: volatilityMetrics.ivSpread > 0 ? "#ff3333" : "#00ff00" }}
          >
            {formatNumber(volatilityMetrics.ivSpread, 2)}%
          </span>
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.section}>
        <div className={styles.row}>
          <span className={styles.label}>GAMMA PRESSURE</span>
          <span
            className={styles.value}
            style={{ color: metrics.gammaPressure > 0 ? "#00ff00" : "#ff3333" }}
          >
            {formatNumber(metrics.gammaPressure, 1)}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>VOLATILITY PRESSURE</span>
          <span
            className={styles.value}
            style={{ color: metrics.volatilityPressure > 0 ? "#ffaa00" : "#00ffff" }}
          >
            {formatNumber(metrics.volatilityPressure, 1)}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>REGIME</span>
          <span className={styles.value} style={{ color: "#ffaa00" }}>
            {metrics.regime.replace(/_/g, " ")}
          </span>
        </div>
      </div>
    </div>
  );
};
