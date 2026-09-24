"use client";

import React, { useEffect, useRef } from "react";
import styles from "./VolflowPanel.module.css";

interface VolflowPanelProps {
  volflow: number; // 0-100
}

const COLORS = {
  background: "#0a0e27",
  grid: "#1a1f35",
  text: "#b0b8cc",
  bearish: "#ff3333",
  neutral: "#ffaa00",
  bullish: "#00ff00",
};

export const VolflowPanel: React.FC<VolflowPanelProps> = ({ volflow }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // clientWidth/Height e' il content box: getBoundingClientRect ci
    // metteva dentro anche il bordo, e il canvas cosi' alto rilanciava il
    // contenitore di 2px a ogni ridisegno (cioe' a ogni movimento del mouse).
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // Layout
    const padding = 20;
    const barHeight = 40;
    const barY = height / 2 - barHeight / 2;

    // Fill background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw background zones
    const zoneWidth = (width - padding * 2) / 3;

    // Bearish zone (0-33)
    ctx.fillStyle = "rgba(255, 51, 51, 0.1)";
    ctx.fillRect(padding, barY, zoneWidth, barHeight);

    // Neutral zone (33-66)
    ctx.fillStyle = "rgba(255, 170, 0, 0.1)";
    ctx.fillRect(padding + zoneWidth, barY, zoneWidth, barHeight);

    // Bullish zone (66-100)
    ctx.fillStyle = "rgba(0, 255, 0, 0.1)";
    ctx.fillRect(padding + zoneWidth * 2, barY, zoneWidth, barHeight);

    // Draw grid lines at 0, 25, 50, 75, 100
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    const barWidth = width - padding * 2;
    for (let i = 0; i <= 4; i++) {
      const x = padding + (i / 4) * barWidth;
      ctx.beginPath();
      ctx.moveTo(x, barY);
      ctx.lineTo(x, barY + barHeight);
      ctx.stroke();

      // Labels
      ctx.fillStyle = COLORS.text;
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText((i * 25).toString(), x, barY + barHeight + 16);
    }

    // Draw filled bar based on VOLFLOW value
    const filledWidth = (volflow / 100) * barWidth;
    const barColor = volflow > 60 ? COLORS.bullish : volflow < 40 ? COLORS.bearish : COLORS.neutral;

    ctx.fillStyle = barColor;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(padding, barY, filledWidth, barHeight);
    ctx.globalAlpha = 1;

    // Draw bar border
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(padding, barY, barWidth, barHeight);

    // Draw indicator needle
    const needleX = padding + (volflow / 100) * barWidth;
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(needleX, barY - 8);
    ctx.lineTo(needleX, barY + barHeight + 8);
    ctx.stroke();

    // Draw value text
    ctx.fillStyle = barColor;
    ctx.font = "bold 32px monospace";
    ctx.textAlign = "center";
    ctx.fillText(volflow.toFixed(1), width / 2, height / 2 + 10);

    // Draw VOLFLOW label
    ctx.fillStyle = COLORS.text;
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.fillText("VOLFLOW", width / 2, height / 2 - 35);

    // Draw zone labels
    ctx.fillStyle = COLORS.bearish;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("BEARISH", padding + zoneWidth / 2, barY - 8);

    ctx.fillStyle = COLORS.neutral;
    ctx.fillText("NEUTRAL", padding + zoneWidth * 1.5, barY - 8);

    ctx.fillStyle = COLORS.bullish;
    ctx.fillText("BULLISH", padding + zoneWidth * 2.5, barY - 8);
  }, [volflow]);

  return (
    <div ref={containerRef} className={styles.volflowPanel}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
        }}
      />
    </div>
  );
};
