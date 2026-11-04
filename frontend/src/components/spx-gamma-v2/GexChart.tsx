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
  /**
   * ES - SPX: gli strike sono SPX, l'asse dei prezzi e' quello del grafico a
   * sinistra (ES). Zero se la base non c'e' ancora.
   */
  basis?: number;
  /** Messaggio al posto delle barre quando il profilo non c'e'. */
  avviso?: string | null;
  volflow?: number; // flusso 0-100, 50 = neutro
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
  basis = 0,
  avviso = null,
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

  // Il riquadro e' il profilo per strike: asse verticale = prezzo (lo stesso
  // intorno dello spot del grafico a sinistra), asse orizzontale = GEX.
  const priceBounds = React.useMemo(() => ({ min: spot - 50, max: spot + 50 }), [spot]);

  const gexBounds = React.useMemo(() => {
    if (gexZoom) return gexZoom;
    const visibili = gexBars.filter((b) => {
      const y = b.strike + basis;
      return y >= priceBounds.min && y <= priceBounds.max;
    });
    if (visibili.length === 0) return { min: -1, max: 1 };
    const massimo = Math.max(...visibili.map((b) => Math.abs(b.gex)), 1e-6);
    return { min: -massimo * 1.15, max: massimo * 1.15 };
  }, [gexBars, gexZoom, basis, priceBounds]);

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

    const leftMargin = 60;
    const rightMargin = 140;
    const topMargin = 20;
    const bottomMargin = 40;
    const chartWidth = width - leftMargin - rightMargin;
    const chartHeight = height - topMargin - bottomMargin;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    const priceToY = (price: number): number =>
      topMargin + chartHeight - ((price - priceBounds.min) / (priceBounds.max - priceBounds.min)) * chartHeight;
    const gexToX = (gex: number): number =>
      leftMargin + ((gex - gexBounds.min) / (gexBounds.max - gexBounds.min)) * chartWidth;

    // Griglia verticale sui valori di GEX, etichette in basso.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const gex = gexBounds.min + ((gexBounds.max - gexBounds.min) * i) / 4;
      const x = gexToX(gex);
      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, topMargin + chartHeight);
      ctx.stroke();
      const testo = Math.abs(gex) >= 100 ? gex.toFixed(0) : gex.toFixed(1);
      ctx.fillText(gex > 0 ? `+${testo}` : testo, x, height - bottomMargin + 14);
    }
    ctx.setLineDash([]);

    const zeroX = gexToX(0);
    ctx.strokeStyle = COLORS.zero;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(zeroX, topMargin);
    ctx.lineTo(zeroX, topMargin + chartHeight);
    ctx.stroke();

    // Barre: una per strike, alta quattro quinti della distanza fra strike.
    const pxPerPunto = chartHeight / (priceBounds.max - priceBounds.min);
    const altezzaBarra = Math.max(2, 5 * pxPerPunto * 0.8);
    let disegnate = 0;
    for (const bar of gexBars) {
      const prezzo = bar.strike + basis;
      if (prezzo < priceBounds.min || prezzo > priceBounds.max) continue;
      const y = priceToY(prezzo);
      const x = gexToX(bar.gex);
      ctx.fillStyle = bar.gex >= 0 ? COLORS.gexUp : COLORS.gexDown;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(Math.min(x, zeroX), y - altezzaBarra / 2, Math.max(1, Math.abs(x - zeroX)), altezzaBarra);
      ctx.globalAlpha = 1;
      disegnate++;
      // Strike SPX a sinistra, uno ogni due per non sovrapporli.
      if (bar.strike % 10 === 0) {
        ctx.fillStyle = COLORS.text;
        ctx.font = "9px monospace";
        ctx.textAlign = "right";
        ctx.fillText(String(bar.strike), leftMargin - 4, y + 3);
      }
    }

    if (disegnate === 0) {
      ctx.fillStyle = "#666666";
      ctx.font = "11px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText(avviso ?? "Profilo GEX non ancora disponibile", leftMargin + chartWidth / 2, topMargin + chartHeight / 2);
    }

    const drawLevelLine = (price: number, color: string, label: string) => {
      if (price < priceBounds.min || price > priceBounds.max) return;
      const y = priceToY(price);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(leftMargin, y);
      ctx.lineTo(width - rightMargin, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, width - rightMargin + 44, y + 3);
    };
    if (callGamma) drawLevelLine(callGamma, COLORS.callGamma, "CALL");
    if (longGamma) drawLevelLine(longGamma, COLORS.longGamma, "LONG");
    if (shortGamma) drawLevelLine(shortGamma, COLORS.shortGamma, "SHORT");
    if (putGamma) drawLevelLine(putGamma, COLORS.putGamma, "PUT");

    // Spot
    const spotY = priceToY(spot);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(leftMargin, spotY);
    ctx.lineTo(width - rightMargin, spotY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Barra del flusso corrente (0-100, 50 = neutro), sul bordo destro.
    if (volflow !== undefined && volflow >= 0 && volflow <= 100) {
      const volflowBarX = width - rightMargin - 30;
      const volflowBarWidth = 18;
      const volflowZeroY = topMargin + chartHeight / 2;
      const maxBarHeight = chartHeight / 3;
      const normalizedValue = (volflow - 50) / 50;
      const volflowValueY = volflowZeroY - normalizedValue * maxBarHeight;
      const volflowBarHeight = Math.max(2, Math.abs(volflowValueY - volflowZeroY));
      const volflowBarTop = Math.min(volflowZeroY, volflowValueY);
      const volflowColor = volflow > 55 ? "#00ff00" : volflow < 45 ? "#ff3333" : "#ffaa00";

      ctx.fillStyle = volflowColor;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(volflowBarX, volflowBarTop, volflowBarWidth, volflowBarHeight);
      ctx.globalAlpha = 1;
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.fillText("FG", volflowBarX + volflowBarWidth / 2, volflowZeroY - maxBarHeight - 6);
    }

    if (crosshairX !== undefined && crosshairX > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(crosshairX, topMargin);
      ctx.lineTo(crosshairX, topMargin + chartHeight);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = COLORS.text;
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("GEX OI ($M)", leftMargin + chartWidth / 2, height - 8);

    // Prezzi a destra (ES), sull'intorno dello spot.
    for (let i = 0; i <= 10; i++) {
      const price = priceBounds.min + ((priceBounds.max - priceBounds.min) * i) / 10;
      ctx.fillStyle = COLORS.text;
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(price.toFixed(0), width - rightMargin + 5, priceToY(price) + 3);
    }
  }, [gexBars, gexBounds, priceBounds, spot, basis, avviso, longGamma, shortGamma, callGamma, putGamma, crosshairX, volflow]);

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
        // Rotella = zoom sull'asse del GEX (orizzontale)
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
