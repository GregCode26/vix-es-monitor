"use client";

import React from "react";
import styles from "./ControlPanel.module.css";

interface ControlPanelProps {
  symbol: "SPX" | "ES";
  onSymbolChange: (symbol: "SPX" | "ES") => void;
  dataSource: "MOCK" | "REAL";
  onDataSourceChange: (source: "MOCK" | "REAL") => void;
  timeframe: "1m" | "5m" | "15m";
  onTimeframeChange: (tf: "1m" | "5m" | "15m") => void;
  atmRange: 1 | 2 | 3 | 5;
  onAtmRangeChange: (range: 1 | 2 | 3 | 5) => void;
  expiration: "0DTE" | "1DTE" | "Weekly" | "Monthly";
  onExpirationChange: (exp: "0DTE" | "1DTE" | "Weekly" | "Monthly") => void;
  isPaused: boolean;
  onPauseToggle: () => void;
  onResetZoom?: () => void;
  onInfo?: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  symbol,
  onSymbolChange,
  dataSource,
  onDataSourceChange,
  timeframe,
  onTimeframeChange,
  atmRange,
  onAtmRangeChange,
  expiration,
  onExpirationChange,
  isPaused,
  onPauseToggle,
  onResetZoom,
  onInfo,
}) => {
  return (
    <div className={styles.controlPanel}>
      <div className={styles.header}>
        <span>
          {symbol} GAMMA &amp; VOLATILITY ANALYZER [{dataSource}]
        </span>
        {onInfo && (
          <button className={styles.info} onClick={onInfo} title="Come si legge questa pagina">
            ? SPIEGAZIONE
          </button>
        )}
      </div>

      <div className={styles.controls}>
        {/* Symbol Selector */}
        <div className={styles.group}>
          <label>Symbol</label>
          <div className={styles.buttons}>
            {(["SPX", "ES"] as const).map((sym) => (
              <button
                key={sym}
                className={`${styles.btn} ${symbol === sym ? styles.active : ""}`}
                onClick={() => onSymbolChange(sym)}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>

        {/* Data Source Selector */}
        <div className={styles.group}>
          <label>Data</label>
          <div className={styles.buttons}>
            {(["MOCK", "REAL"] as const).map((source) => (
              <button
                key={source}
                className={`${styles.btn} ${dataSource === source ? styles.active : ""}`}
                onClick={() => onDataSourceChange(source)}
              >
                {source}
              </button>
            ))}
          </div>
        </div>
        {/* Timeframe */}
        <div className={styles.group}>
          <label>Timeframe</label>
          <div className={styles.buttons}>
            {(["1m", "5m", "15m"] as const).map((tf) => (
              <button
                key={tf}
                className={`${styles.btn} ${timeframe === tf ? styles.active : ""}`}
                onClick={() => onTimeframeChange(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* ATM Range */}
        <div className={styles.group}>
          <label>ATM Range</label>
          <div className={styles.buttons}>
            {([1, 2, 3, 5] as const).map((range) => (
              <button
                key={range}
                className={`${styles.btn} ${atmRange === range ? styles.active : ""}`}
                onClick={() => onAtmRangeChange(range)}
              >
                ±{range}
              </button>
            ))}
          </div>
        </div>

        {/* Expiration */}
        <div className={styles.group}>
          <label>Expiration</label>
          <select
            value={expiration}
            onChange={(e) =>
              onExpirationChange(e.target.value as "0DTE" | "1DTE" | "Weekly" | "Monthly")
            }
            className={styles.select}
          >
            <option value="0DTE">0DTE</option>
            <option value="1DTE">1DTE</option>
            <option value="Weekly">Weekly</option>
            <option value="Monthly">Monthly</option>
          </select>
        </div>

        {/* Pause Control */}
        <div className={styles.group}>
          <button
            className={`${styles.btn} ${styles.pauseBtn} ${isPaused ? styles.paused : ""}`}
            onClick={onPauseToggle}
          >
            {isPaused ? "▶ RESUME" : "⏸ PAUSE"}
          </button>
        </div>

        {/* Reset Zoom Control */}
        <div className={styles.group}>
          <button
            className={`${styles.btn}`}
            onClick={onResetZoom}
            title="Reset zoom to auto (scroll wheel: Y=price, Ctrl+Y=time)"
          >
            🔍 RESET
          </button>
        </div>
      </div>
    </div>
  );
};
