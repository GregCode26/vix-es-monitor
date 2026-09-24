"use client";

import React, { useEffect, useRef, useCallback } from "react";
import { CandleData } from "@/types/gamma";
import { MARGINE_SINISTRO, MARGINE_DESTRO } from "./assiCondivisi";
import styles from "./PriceChart.module.css";

interface PriceChartProps {
  candles: CandleData[];
  gexBars: Array<{ timestamp: number; gex: number }>;
  spot: number;
  longGamma: number;
  shortGamma: number;
  callGamma: number;
  putGamma: number;
  onCrosshairMove: (x: number, y: number, timestamp?: number) => void;
  crosshairX?: number;
  priceZoom?: { min: number; max: number } | null;
  onPriceZoomChange?: (zoom: { min: number; max: number } | null) => void;
  timeZoom?: { start: number; end: number } | null;
  onTimeZoomChange?: (zoom: { start: number; end: number } | null) => void;
}

const COLORS = {
  background: "#0a0e27",
  grid: "#1a1f35",
  text: "#b0b8cc",
  candleUp: "#00d4ff",
  candleDown: "#555555",
  longGamma: "#00ffff",
  shortGamma: "#aa00ff",
  callGamma: "#00ff00",
  putGamma: "#ff3333",
  spot: "#ffffff",
};

export const PriceChart: React.FC<PriceChartProps> = ({
  candles,
  gexBars,
  spot,
  longGamma,
  shortGamma,
  callGamma,
  putGamma,
  onCrosshairMove,
  crosshairX,
  priceZoom: externalPriceZoom = null,
  onPriceZoomChange,
  timeZoom: externalTimeZoom = null,
  onTimeZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [chartBounds, setChartBounds] = React.useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  // Use external zoom state if provided, otherwise local state
  const [localPriceZoom, setLocalPriceZoom] = React.useState<{ min: number; max: number } | null>(null);
  const [localTimeZoom, setLocalTimeZoom] = React.useState<{ start: number; end: number } | null>(null);

  const priceZoom = externalPriceZoom ?? localPriceZoom;
  const timeZoom = externalTimeZoom ?? localTimeZoom;

  const setPriceZoom = (zoom: { min: number; max: number } | null) => {
    if (onPriceZoomChange) {
      onPriceZoomChange(zoom);
    } else {
      setLocalPriceZoom(zoom);
    }
  };

  const setTimeZoom = (zoom: { start: number; end: number } | null) => {
    if (onTimeZoomChange) {
      onTimeZoomChange(zoom);
    } else {
      setLocalTimeZoom(zoom);
    }
  };

  // Calculate GEX bounds (left axis)
  const gexBounds = React.useMemo(() => {
    if (gexBars.length === 0) return { min: -3000, max: 8000 };

    const gexValues = gexBars.map((b) => b.gex);
    const minGex = Math.min(...gexValues, 0);
    const maxGex = Math.max(...gexValues, 0);
    const range = Math.max(Math.abs(minGex), Math.abs(maxGex));

    return {
      min: Math.min(minGex, -range * 0.5),
      max: Math.max(maxGex, range * 1.2)
    };
  }, [gexBars]);

  // Calculate price bounds (right axis)
  const priceBounds = React.useMemo(() => {
    // Use manual zoom if set
    if (priceZoom) {
      return priceZoom;
    }

    if (candles.length === 0) return { min: 6650, max: 6750 };

    let minPrice = Math.min(...candles.map((c) => c.low));
    let maxPrice = Math.max(...candles.map((c) => c.high));

    // Ensure minimum range to avoid zero-width bounds
    let range = maxPrice - minPrice;
    if (range < 1) {
      const center = (minPrice + maxPrice) / 2;
      minPrice = center - 50;
      maxPrice = center + 50;
    } else {
      const margin = range * 0.1;
      minPrice -= margin;
      maxPrice += margin;
    }

    return { min: minPrice, max: maxPrice };
  }, [candles, priceZoom]);

  // Draw chart
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
    const leftMargin = MARGINE_SINISTRO;
    const rightMargin = MARGINE_DESTRO;
    const topMargin = 20;
    const bottomMargin = 40;
    const chartWidth = width - leftMargin - rightMargin;
    const chartHeight = height - topMargin - bottomMargin;

    setChartBounds({
      left: leftMargin,
      top: topMargin,
      width: chartWidth,
      height: chartHeight,
    });

    // Fill background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);

    // Price to Y coordinate
    const priceToY = (price: number): number => {
      return topMargin + chartHeight - ((price - priceBounds.min) / (priceBounds.max - priceBounds.min)) * chartHeight;
    };

    // GEX to Y coordinate
    const gexToY = (gex: number): number => {
      return topMargin + chartHeight - ((gex - gexBounds.min) / (gexBounds.max - gexBounds.min)) * chartHeight;
    };

    // Horizontal grid lines
    const gexStep = (gexBounds.max - gexBounds.min) / 10;
    const priceStep = (priceBounds.max - priceBounds.min) / 10;
    for (let i = 0; i <= 10; i++) {
      const gex = gexBounds.min + gexStep * i;
      const price = priceBounds.min + priceStep * i;
      const y = gexToY(gex);

      ctx.beginPath();
      ctx.moveTo(leftMargin, y);
      ctx.lineTo(width - rightMargin, y);
      ctx.stroke();

      // GEX labels (left)
      ctx.fillStyle = COLORS.text;
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      const label = gex > 0 ? `+${Math.round(gex)}` : `${Math.round(gex)}`;
      ctx.fillText(label, leftMargin - 5, y + 4);

      // Price labels (right)
      ctx.textAlign = "left";
      ctx.fillText(price.toFixed(1), width - rightMargin + 5, y + 4);
    }

    // Vertical grid lines
    const candleWidth = chartWidth / Math.max(20, candles.length);
    for (let i = 0; i < candles.length; i += Math.ceil(candles.length / 10)) {
      const x = leftMargin + (i / candles.length) * chartWidth;
      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, topMargin + chartHeight);
      ctx.stroke();
    }

    ctx.setLineDash([]);

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
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, width - rightMargin + 10, y - 5);
      ctx.fillText(price.toFixed(2), width - rightMargin + 10, y + 8);
    };

    ctx.setLineDash([]);

    // Draw levels from back to front
    if (callGamma) drawLevelLine(callGamma, COLORS.callGamma, "CALL");
    if (longGamma) drawLevelLine(longGamma, COLORS.longGamma, "LONG");
    if (shortGamma) drawLevelLine(shortGamma, COLORS.shortGamma, "SHORT");
    if (putGamma) drawLevelLine(putGamma, COLORS.putGamma, "PUT");

    // Draw spot line (most prominent)
    const spotY = priceToY(spot);
    ctx.strokeStyle = COLORS.spot;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(leftMargin, spotY);
    ctx.lineTo(width - rightMargin, spotY);
    ctx.stroke();

    ctx.fillStyle = COLORS.spot;
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "left";
    ctx.fillText("SPOT", width - rightMargin + 10, spotY - 12);
    ctx.fillText(spot.toFixed(2), width - rightMargin + 10, spotY + 1);

    ctx.setLineDash([]);

    // Check if this is price line data (all OHLC equal = point on line)
    const isPriceLine = candles.length > 0 && candles.every((c) => c.open === c.close && c.high === c.low && c.open === c.high);

    console.log("[PriceChart] Candles:", candles.length, "isPriceLine:", isPriceLine, "Sample:", candles[0]);

    if (isPriceLine) {
      // Draw continuous price line
      ctx.strokeStyle = COLORS.spot;
      ctx.lineWidth = 2;
      ctx.beginPath();

      for (let i = 0; i < candles.length; i++) {
        const x = leftMargin + (i / candles.length) * chartWidth;
        const y = priceToY(candles[i].close);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Draw dots at each point
      ctx.fillStyle = COLORS.spot;
      candles.forEach((candle, index) => {
        const x = leftMargin + (index / candles.length) * chartWidth;
        const y = priceToY(candle.close);
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      // Draw candlesticks (original code)
      const candlePixelWidth = Math.max(4, chartWidth / candles.length - 1);
      const candleBodyWidth = Math.max(2, candlePixelWidth - 1);
      const wickWidth = 0.5;

      candles.forEach((candle, index) => {
        const x = leftMargin + (index / candles.length) * chartWidth + candlePixelWidth / 2;
        const open = priceToY(candle.open);
        const close = priceToY(candle.close);
        const high = priceToY(candle.high);
        const low = priceToY(candle.low);

        const isUp = candle.close >= candle.open;
        const color = isUp ? COLORS.candleUp : COLORS.candleDown;

        // Wick (vertical line)
        ctx.strokeStyle = color;
        ctx.lineWidth = wickWidth;
        ctx.beginPath();
        ctx.moveTo(x, high);
        ctx.lineTo(x, low);
        ctx.stroke();

        // Body (rectangle)
        ctx.fillStyle = color;
        const bodyTop = Math.min(open, close);
        const bodyHeight = Math.max(1, Math.abs(open - close));
        ctx.fillRect(x - candleBodyWidth / 2, bodyTop, candleBodyWidth, bodyHeight);

        // Body border for visibility
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x - candleBodyWidth / 2, bodyTop, candleBodyWidth, bodyHeight);
      });
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

    // Draw GEX candlesticks (thin lines above main chart area)
    const gexCandleWidth = chartWidth / candles.length;
    candles.forEach((candle, index) => {
      const x = leftMargin + (index / candles.length) * chartWidth + gexCandleWidth / 2;

      // Find corresponding GEX
      const gexBar = gexBars.find((b) => b.timestamp === candle.timestamp);
      if (!gexBar) return;

      const gexY = gexToY(gexBar.gex);

      // Draw small indicator line
      ctx.strokeStyle = gexBar.gex >= 0 ? COLORS.candleUp : COLORS.candleDown;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, gexToY(0));
      ctx.lineTo(x, gexY);
      ctx.stroke();
    });

    // Left axis label
    ctx.fillStyle = COLORS.text;
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("GEX ($M)", 20, height - bottomMargin + 20);

  }, [candles, spot, longGamma, shortGamma, callGamma, putGamma, priceBounds, crosshairX]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Calculate candle index and snap to it
      const chartX = x - chartBounds.left;
      const candleIndex = Math.floor((chartX / chartBounds.width) * candles.length);

      if (candleIndex >= 0 && candleIndex < candles.length) {
        const snapX = chartBounds.left + (candleIndex / candles.length) * chartBounds.width + chartBounds.width / candles.length / 2;
        onCrosshairMove(snapX, y, candles[candleIndex].timestamp);
      }
    },
    [candles, chartBounds, onCrosshairMove]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();

      if (e.ctrlKey) {
        // Ctrl+Wheel = zoom time (X axis)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8; // Zoom out / Zoom in

        if (timeZoom) {
          const range = timeZoom.end - timeZoom.start;
          const center = (timeZoom.start + timeZoom.end) / 2;
          const newRange = range * zoomFactor;
          setTimeZoom({
            start: center - newRange / 2,
            end: center + newRange / 2,
          });
        } else if (candles.length > 1) {
          const start = candles[0].timestamp;
          const end = candles[candles.length - 1].timestamp;
          const range = end - start;
          const center = (start + end) / 2;
          const newRange = range / zoomFactor;
          setTimeZoom({
            start: center - newRange / 2,
            end: center + newRange / 2,
          });
        }
      } else {
        // Regular Wheel = zoom price (Y axis)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8; // Zoom out / Zoom in

        if (priceZoom) {
          const range = priceZoom.max - priceZoom.min;
          const center = (priceZoom.min + priceZoom.max) / 2;
          const newRange = range * zoomFactor;
          setPriceZoom({
            min: center - newRange / 2,
            max: center + newRange / 2,
          });
        } else {
          // Start with current bounds
          const range = priceBounds.max - priceBounds.min;
          const center = (priceBounds.min + priceBounds.max) / 2;
          const newRange = range / zoomFactor;
          setPriceZoom({
            min: center - newRange / 2,
            max: center + newRange / 2,
          });
        }
      }
    },
    [priceZoom, timeZoom, candles, priceBounds]
  );

  return (
    <div ref={containerRef} className={styles.priceChart} onMouseMove={handleMouseMove} onWheel={handleWheel}>
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
