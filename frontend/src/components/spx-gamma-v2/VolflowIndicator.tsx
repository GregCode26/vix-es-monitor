"use client";

import React, { useRef, useEffect } from "react";
import { VolflowOutput } from "@/engines/volflowEngine";
import styles from "./VolflowIndicator.module.css";

interface VolflowIndicatorProps {
  volflow: VolflowOutput;
  showDebug?: boolean;
}

const COLORS = {
  background: "#0a0e27",
  grid: "#1a1f35",
  text: "#b0b8cc",
  up: "#00ff00",
  down: "#ff3333",
  neutral: "#ffaa00",
  line50: "#666666",
};

const ZONES = [
  { min: 90, max: 100, label: "EXTREME UP", color: "#00ff00" },
  { min: 80, max: 90, label: "STRONG UP", color: "#00dd00" },
  { min: 65, max: 80, label: "UP", color: "#00bb00" },
  { min: 55, max: 65, label: "SLIGHT UP", color: "#00aa00" },
  { min: 45, max: 55, label: "NEUTRAL", color: "#ffaa00" },
  { min: 35, max: 45, label: "SLIGHT DOWN", color: "#ff8800" },
  { min: 20, max: 35, label: "DOWN", color: "#ff5555" },
  { min: 10, max: 20, label: "STRONG DOWN", color: "#ff3333" },
  { min: 0, max: 10, label: "EXTREME DOWN", color: "#ff0000" },
];

export const VolflowIndicator: React.FC<VolflowIndicatorProps> = ({
  volflow,
  showDebug = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Get zone info
  const getZone = (value: number) => {
    return ZONES.find((z) => value >= z.min && value <= z.max) || ZONES[4];
  };

  const zone = getZone(volflow.volflow);

  // Draw indicator
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // Layout
    const leftMargin = 40;
    const rightMargin = 60;
    const topMargin = 20;
    const bottomMargin = 40;
    const chartWidth = width - leftMargin - rightMargin;
    const chartHeight = height - topMargin - bottomMargin;

    // Fill background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);

    // Vertical scale lines (0-100)
    for (let i = 0; i <= 10; i++) {
      const value = i * 10;
      const y = topMargin + chartHeight - (value / 100) * chartHeight;

      ctx.beginPath();
      ctx.moveTo(leftMargin, y);
      ctx.lineTo(width - rightMargin, y);
      ctx.stroke();

      // Value labels
      ctx.fillStyle = COLORS.text;
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      ctx.fillText(value.toString(), leftMargin - 5, y + 4);
    }

    ctx.setLineDash([]);

    // Draw center line (50) prominently
    const centerY = topMargin + chartHeight / 2;
    ctx.strokeStyle = COLORS.line50;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(leftMargin, centerY);
    ctx.lineTo(width - rightMargin, centerY);
    ctx.stroke();

    ctx.setLineDash([]);

    // Draw VOLFLOW bar (from 50 to current value)
    const barX = leftMargin + chartWidth / 2 - 15; // Bar width = 30px
    const barWidth = 30;
    const barValue = volflow.volflow;

    const barStart50Y = centerY;
    const barValueY = topMargin + chartHeight - (barValue / 100) * chartHeight;

    // Determine color and direction
    const barColor = barValue > 50 ? COLORS.up : barValue < 50 ? COLORS.down : COLORS.neutral;
    const barHeight = Math.abs(barValueY - barStart50Y);

    // Draw bar
    ctx.fillStyle = barColor;
    const barTopY = Math.min(barStart50Y, barValueY);
    ctx.fillRect(barX, barTopY, barWidth, barHeight);

    // Bar outline
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barTopY, barWidth, barHeight);

    // Draw value text on bar
    ctx.fillStyle = "#000000";
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.fillText(barValue.toFixed(1), barX + barWidth / 2, barStart50Y - 5);

    // Right side label
    ctx.fillStyle = zone.color;
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(zone.label, width - rightMargin + 10, centerY - 10);
    ctx.fillText(`(${barValue.toFixed(1)})`, width - rightMargin + 10, centerY + 5);

  }, [volflow]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>VOLFLOW 0-100</div>

      <div className={styles.chartContainer}>
        <canvas ref={canvasRef} />
      </div>

      {showDebug && (
        <div className={styles.debugPanel}>
          <div className={styles.debugTitle}>DEBUG INFO</div>
          <div className={styles.debugGrid}>
            <div className={styles.debugRow}>
              <span>VOLFLOW:</span>
              <span className={styles.value}>{volflow.volflow.toFixed(2)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>RAW:</span>
              <span className={styles.value}>{volflow.raw.toFixed(3)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>CALL PRESSURE:</span>
              <span className={styles.value}>{volflow.callPressure.toFixed(3)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>PUT PRESSURE:</span>
              <span className={styles.value}>{volflow.putPressure.toFixed(3)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>IV PRESSURE:</span>
              <span className={styles.value}>{volflow.ivPressure.toFixed(3)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>GAMMA PRESSURE:</span>
              <span className={styles.value}>{volflow.gammaPressure.toFixed(3)}</span>
            </div>
            <div className={styles.debugRow}>
              <span>CONFIDENCE:</span>
              <span className={styles.value}>{volflow.confidence}%</span>
            </div>
            <div className={styles.debugRow}>
              <span>ZONE:</span>
              <span className={styles.value} style={{ color: zone.color }}>
                {zone.label}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
