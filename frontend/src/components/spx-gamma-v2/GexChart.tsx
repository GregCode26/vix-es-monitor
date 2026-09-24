"use client";

import React, { useEffect, useRef } from "react";
import { GexBar } from "@/types/gamma";
import styles from "./GexChart.module.css";

interface GexChartProps {
  gexBars: GexBar[];
  spot: number;
  longGamma: number;
  shortGamma: number;
  callGamma: number;
  putGamma: number;
  crosshairX?: number;
  volflow?: number; // VOLFLOW 0-100 value
  gexZoom?: { min: number; max: number } | null;
  onGexZoomChange?: (zoom: { min: number; max: number } | null) => void;
  timeZoom?: { start: number; end: number } | null;
  onTimeZoomChange?: (zoom: { start: number; end: number } | null) => void;
}

const COLORS = {
  background: "#0a0e27",
  grid: "#1a1f35",
  text: "#b0b8cc",
  gexUp: "#00d4ff",
  gexDown: "#888888",
  longGamma: "#00ffff",
  shortGamma: "#aa00ff",
  callGamma: "#00ff00",
  putGamma: "#ff3333",
  zero: "#666666",
};

export const GexChart: React.FC<GexChartProps> = ({
  gexBars,
  spot,
  longGamma,
  shortGamma,
  callGamma,
  putGamma,
  crosshairX,
  volflow = 50,
  gexZoom: externalGexZoom = null,
  onGexZoomChange,
  timeZoom: externalTimeZoom = null,
  onTimeZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [localGexZoom, setLocalGexZoom] = React.useState<{ min: number; max: number } | null>(null);
  const [localTimeZoom, setLocalTimeZoom] = React.useState<{ start: number; end: number } | null>(null);

  const gexZoom = externalGexZoom ?? localGexZoom;
  const timeZoom = externalTimeZoom ?? localTimeZoom;

  const setGexZoom = (zoom: { min: number; max: number } | null) => {
    if (onGexZoomChange) {
      onGexZoomChange(zoom);
    } else {
      setLocalGexZoom(zoom);
    }
  };

  const setTimeZoomLocal = (zoom: { start: number; end: number } | null) => {
    if (onTimeZoomChange) {
      onTimeZoomChange(zoom);
    } else {
      setLocalTimeZoom(zoom);
    }
  };

  console.log("[GexChart] Rendering with volflow:", volflow);

  // Calculate GEX bounds
  const gexBounds = React.useMemo(() => {
    // Use manual zoom if set
    if (gexZoom) {
      return gexZoom;
    }

    if (gexBars.length === 0) return { min: -2000, max: 2000 };

    const values = gexBars.map((bar) => bar.gex);
    const minGex = Math.min(...values, 0);
    const maxGex = Math.max(...values, 0);
    const range = Math.max(Math.abs(minGex), Math.abs(maxGex));

    return { min: -range * 1.2, max: range * 1.2 };
  }, [gexBars, gexZoom]);

  // Calculate price bounds (same as price chart)
  const priceBounds = React.useMemo(() => {
    const spotMin = spot - 50;
    const spotMax = spot + 50;
    return { min: spotMin, max: spotMax };
  }, [spot]);

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

    // Layout constants
    const leftMargin = 60;
    const rightMargin = 140;
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

    // Horizontal grid lines for GEX
    const gexStep = (gexBounds.max - gexBounds.min) / 8;
    for (let i = 0; i <= 8; i++) {
      const gex = gexBounds.min + gexStep * i;
      const y = topMargin + chartHeight - ((gex - gexBounds.min) / (gexBounds.max - gexBounds.min)) * chartHeight;

      ctx.beginPath();
      ctx.moveTo(leftMargin, y);
      ctx.lineTo(width - rightMargin, y);
      ctx.stroke();

      // GEX labels
      ctx.fillStyle = COLORS.text;
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      const label = gex > 0 ? `+${Math.round(gex)}` : `${Math.round(gex)}`;
      ctx.fillText(label, width - rightMargin + 5, y + 4);
    }

    // Zero line (more prominent)
    const zeroY = topMargin + chartHeight - ((0 - gexBounds.min) / (gexBounds.max - gexBounds.min)) * chartHeight;
    ctx.strokeStyle = COLORS.zero;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(leftMargin, zeroY);
    ctx.lineTo(width - rightMargin, zeroY);
    ctx.stroke();

    // Price to Y coordinate (right axis)
    const priceToY = (price: number): number => {
      return topMargin + chartHeight - ((price - priceBounds.min) / (priceBounds.max - priceBounds.min)) * chartHeight;
    };

    // GEX to Y coordinate
    const gexToY = (gex: number): number => {
      return topMargin + chartHeight - ((gex - gexBounds.min) / (gexBounds.max - gexBounds.min)) * chartHeight;
    };

    // Draw gamma level lines
    const drawLevelLine = (price: number, color: string, label: string) => {
      const y = priceToY(price);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(leftMargin, y);
      ctx.lineTo(width - rightMargin, y);
      ctx.stroke();

      // Label on right
      ctx.fillStyle = color;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, width - rightMargin + 10, y + 3);
    };

    ctx.setLineDash([]);

    // Draw levels
    if (callGamma) drawLevelLine(callGamma, COLORS.callGamma, "CALL");
    if (longGamma) drawLevelLine(longGamma, COLORS.longGamma, "LONG");
    if (shortGamma) drawLevelLine(shortGamma, COLORS.shortGamma, "SHORT");
    if (putGamma) drawLevelLine(putGamma, COLORS.putGamma, "PUT");

    // Senza barre si scrive perche' mancano, invece di lasciare una griglia
    // vuota che sembra un GEX piatto: il profilo per strike sta in
    // /api/volumes, che questa pagina non interroga.
    if (gexBars.length === 0) {
      ctx.fillStyle = "#666666";
      ctx.font = "11px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText("GEX non disponibile da /api/market", leftMargin + chartWidth / 2, topMargin + chartHeight / 2);
      ctx.textAlign = "left";
    }

    // Draw GEX bars (simplified - direct rendering)
    if (gexBars.length > 0) {
      const barPixelWidth = Math.max(3, chartWidth / Math.max(20, gexBars.length));
      const barBodyWidth = Math.max(1.5, barPixelWidth - 1);
      const zeroY = gexToY(0);

      // Draw each bar
      for (let i = 0; i < gexBars.length; i++) {
        const bar = gexBars[i];
        const x = leftMargin + (i / gexBars.length) * chartWidth + barPixelWidth / 2;
        const gex = bar.gex;

        // Skip if GEX is too small
        if (Math.abs(gex) < 0.1) continue;

        const barValueY = gexToY(gex);
        const barY1 = Math.min(zeroY, barValueY);
        const barHeight = Math.max(1, Math.abs(barValueY - zeroY));

        // Draw bar
        ctx.fillStyle = gex >= 0 ? COLORS.gexUp : COLORS.gexDown;
        ctx.fillRect(x - barBodyWidth / 2, barY1, barBodyWidth, barHeight);

        // Bar border
        ctx.strokeStyle = gex >= 0 ? COLORS.gexUp : COLORS.gexDown;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(x - barBodyWidth / 2, barY1, barBodyWidth, barHeight);
      }
    }

    // Draw VOLFLOW indicator bar (inside chart, far right) - only if valid
    if (volflow !== undefined && volflow >= 0 && volflow <= 100) {
      const volflowBarX = width - rightMargin - 30; // Inside chart, near right edge
      const volflowBarWidth = 18;
      const volflowZeroY = topMargin + chartHeight / 2; // Center at 50
      const maxBarHeight = chartHeight / 3; // Limit to 1/3 of chart height

      // VOLFLOW to Y coordinate (centered at 50, max ±33% of chart height)
      const normalizedValue = (volflow - 50) / 50; // -1 to +1
      const volflowValueY = volflowZeroY - normalizedValue * maxBarHeight;
      const volflowBarHeight = Math.max(2, Math.abs(volflowValueY - volflowZeroY));
      const volflowBarTop = Math.min(volflowZeroY, volflowValueY);
      const volflowColor = volflow > 50 ? "#00ff00" : volflow < 50 ? "#ff3333" : "#ffaa00";

      // Draw VOLFLOW bar with strong visibility
      ctx.fillStyle = volflowColor;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(volflowBarX, volflowBarTop, volflowBarWidth, volflowBarHeight);
      ctx.globalAlpha = 1;

      // VOLFLOW bar border - thicker for visibility
      ctx.strokeStyle = volflowColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(volflowBarX, volflowBarTop, volflowBarWidth, volflowBarHeight);

      // VOLFLOW value label - larger, more visible
      ctx.fillStyle = volflowColor;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(volflow.toFixed(0), volflowBarX + volflowBarWidth / 2, volflowZeroY + 16);

      // VOLFLOW label
      ctx.fillStyle = volflowColor;
      ctx.font = "bold 9px monospace";
      ctx.fillText("VF", volflowBarX + volflowBarWidth / 2, volflowZeroY - 14);

      console.log("[GexChart] VOLFLOW bar drawn:", { volflow, x: volflowBarX, y: volflowBarTop, height: volflowBarHeight });
    }

    // Draw crosshair if provided
    if (crosshairX !== undefined && crosshairX > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(crosshairX, topMargin);
      ctx.lineTo(crosshairX, topMargin + chartHeight);
      ctx.stroke();
    }

    // Left axis label
    ctx.fillStyle = COLORS.text;
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("GEX ($M)", 20, height - bottomMargin + 20);

    // Right axis price labels (synchronized with price chart)
    const priceStep = (priceBounds.max - priceBounds.min) / 10;
    for (let i = 0; i <= 10; i++) {
      const price = priceBounds.min + priceStep * i;
      const y = priceToY(price);

      ctx.fillStyle = COLORS.text;
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(price.toFixed(0), width - rightMargin + 5, y + 3);
    }

  }, [gexBars, gexBounds, priceBounds, spot, longGamma, shortGamma, callGamma, putGamma, crosshairX, gexZoom]);

  const handleWheel = React.useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();

      if (e.ctrlKey) {
        // Ctrl+Wheel = zoom time (X axis)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;

        if (timeZoom) {
          const range = timeZoom.end - timeZoom.start;
          const center = (timeZoom.start + timeZoom.end) / 2;
          const newRange = range * zoomFactor;
          setTimeZoomLocal({
            start: center - newRange / 2,
            end: center + newRange / 2,
          });
        }
      } else {
        // Regular Wheel = zoom GEX (Y axis)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;

        if (gexZoom) {
          const range = gexZoom.max - gexZoom.min;
          const center = (gexZoom.min + gexZoom.max) / 2;
          const newRange = range * zoomFactor;
          setGexZoom({
            min: center - newRange / 2,
            max: center + newRange / 2,
          });
        } else {
          // Start with current bounds
          const range = gexBounds.max - gexBounds.min;
          const center = (gexBounds.min + gexBounds.max) / 2;
          const newRange = range / zoomFactor;
          setGexZoom({
            min: center - newRange / 2,
            max: center + newRange / 2,
          });
        }
      }
    },
    [gexZoom, timeZoom, gexBounds]
  );

  return (
    <div ref={containerRef} className={styles.gexChart} onWheel={handleWheel}>
      <canvas
        ref={canvasRef}
        style={{
          cursor: "crosshair",
          display: "block",
        }}
      />
    </div>
  );
};
