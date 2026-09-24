"use client";

import React, { useEffect, useRef } from "react";
import { CandleData } from "@/types/gamma";
import { MARGINE_SINISTRO, MARGINE_DESTRO } from "./assiCondivisi";
import styles from "./VolflowChartPanel.module.css";

/** Una lettura del flusso, da -100 (put) a +100 (call), col suo istante. */
export interface PuntoVolflow {
  timestamp: number;
  value: number;
}

interface VolflowChartPanelProps {
  candles: CandleData[];
  volflow?: number; // Valore corrente, da -100 a +100
  volflowHistory?: PuntoVolflow[];
  /** Raggruppamento delle barre: e' il selettore TIMEFRAME in alto. */
  timeframe?: "1m" | "5m" | "15m";
  crosshairX?: number;
  timeZoom?: { start: number; end: number } | null;
  onTimeZoomChange?: (zoom: { start: number; end: number } | null) => void;
  volflowZoom?: { min: number; max: number } | null;
  onVolflowZoomChange?: (zoom: { min: number; max: number } | null) => void;
}

/**
 * Sotto questo valore assoluto la barra resta neutra.
 *
 * Misurato sulle cinque sessioni con i volumi: senza banda il colore cambia
 * 17.8 volte l'ora anche raggruppando al minuto, a 10 scende a 9.4 (un cambio
 * ogni sei minuti e mezzo) lasciando colorate tre barre su cinque. A 20 si
 * arriva a 5.6 l'ora ma due terzi delle barre restano gialle.
 */
const BANDA_NEUTRA = 10;

/** Quanto dura una barra, per ogni posizione del selettore TIMEFRAME. */
const DURATA_INTERVALLO: Record<string, number> = {
  "1m": 60000,
  "5m": 300000,
  "15m": 900000,
};

const COLORS = {
  background: "#0a0e27",
  grid: "#1a1f35",
  text: "#b0b8cc",
  bullish: "#00ff00",
  bearish: "#ff3333",
  neutral: "#ffaa00",
  zero: "#666666",
};

export const VolflowChartPanel: React.FC<VolflowChartPanelProps> = ({
  candles,
  volflow = 0,
  volflowHistory,
  timeframe = "1m",
  crosshairX,
  timeZoom: externalTimeZoom = null,
  onTimeZoomChange,
  volflowZoom: externalVolflowZoom = null,
  onVolflowZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [localTimeZoom, setLocalTimeZoom] = React.useState<{ start: number; end: number } | null>(null);
  const [localVolflowZoom, setLocalVolflowZoom] = React.useState<{ min: number; max: number } | null>(null);

  const timeZoom = externalTimeZoom ?? localTimeZoom;
  const volflowZoom = externalVolflowZoom ?? localVolflowZoom;

  const setTimeZoomLocal = (zoom: { start: number; end: number } | null) => {
    if (onTimeZoomChange) {
      onTimeZoomChange(zoom);
    } else {
      setLocalTimeZoom(zoom);
    }
  };

  const setVolflowZoomLocal = (zoom: { min: number; max: number } | null) => {
    if (onVolflowZoomChange) {
      onVolflowZoomChange(zoom);
    } else {
      setLocalVolflowZoom(zoom);
    }
  };

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
    const leftMargin = MARGINE_SINISTRO;
    const rightMargin = MARGINE_DESTRO;
    const topMargin = 10;
    const bottomMargin = 40;
    const chartWidth = width - leftMargin - rightMargin;
    const intervalloMs = DURATA_INTERVALLO[timeframe] ?? 60000;
    const chartHeight = height - topMargin - bottomMargin;

    // Fill background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);

    // Griglia a +100, 0, -100
    const centerY = topMargin + chartHeight / 2; // flusso nullo
    const maxY = topMargin; // +100, tutto call
    const minY = topMargin + chartHeight; // -100, tutto put

    // Grid lines
    ctx.beginPath();
    ctx.moveTo(leftMargin, maxY);
    ctx.lineTo(width - rightMargin, maxY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(leftMargin, centerY);
    ctx.lineTo(width - rightMargin, centerY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(leftMargin, minY);
    ctx.lineTo(width - rightMargin, minY);
    ctx.stroke();

    // Etichette dell'asse (+100, 0, -100)
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText("+100", leftMargin - 5, maxY + 3);
    ctx.fillText("0", leftMargin - 5, centerY + 3);
    ctx.fillText("-100", leftMargin - 5, minY + 3);

    ctx.setLineDash([]);

    // Draw VOLFLOW bars
    //
    // Una barra per intervallo, non una per lettura.
    //
    // Senza raggruppare, il colore cambia 17.8 volte l'ora; al minuto con la
    // banda neutra si scende a 9.4. Il raggruppamento e' quello del selettore
    // TIMEFRAME in alto.
    //
    // Ogni barra si posa sulle candele del proprio intervallo, con la stessa
    // formula di PriceChart (indice / candles.length): e' cosi' che i due
    // riquadri condividono l'asse dei tempi.
    if (volflowHistory && volflowHistory.length > 0 && candles.length > 0) {
      const indicePerIstante = new Map<number, number>();
      candles.forEach((c, i) => indicePerIstante.set(c.timestamp, i));

      interface Gruppo {
        somma: number;
        quante: number;
        minimo: number;
        massimo: number;
        primoIndice: number;
        ultimoIndice: number;
      }
      const gruppi = new Map<number, Gruppo>();

      volflowHistory.forEach((punto) => {
        const index = indicePerIstante.get(punto.timestamp);
        if (index === undefined) return; // candela gia' uscita dalla finestra
        const chiave = Math.floor(punto.timestamp / intervalloMs);
        const v = Math.max(-100, Math.min(100, punto.value));
        const g = gruppi.get(chiave);
        if (!g) {
          gruppi.set(chiave, { somma: v, quante: 1, minimo: v, massimo: v, primoIndice: index, ultimoIndice: index });
        } else {
          g.somma += v;
          g.quante += 1;
          g.minimo = Math.min(g.minimo, v);
          g.massimo = Math.max(g.massimo, v);
          g.primoIndice = Math.min(g.primoIndice, index);
          g.ultimoIndice = Math.max(g.ultimoIndice, index);
        }
      });

      const xDi = (indice: number) => leftMargin + (indice / candles.length) * chartWidth;
      const perValore = (v: number) => centerY - (v / 100) * (chartHeight / 2);

      const medie: { x: number; y: number }[] = [];

      gruppi.forEach((g) => {
        const media = g.somma / g.quante;

        // Lo zoom verticale scarta quello che finisce fuori finestra.
        if (volflowZoom && (media < volflowZoom.min || media > volflowZoom.max)) return;

        const xSinistra = xDi(g.primoIndice);
        const xDestra = xDi(g.ultimoIndice + 1);
        const larghezza = Math.max(2, xDestra - xSinistra - 1);
        const xCentro = xSinistra + (xDestra - xSinistra) / 2;

        // Banda neutra: sotto i cinque punti dal centro non e' uno
        // sbilanciamento, e' il rumore di fondo della giornata. Colorarlo
        // comunque era meta' dei cambi di colore.
        const scarto = media;
        const colore =
          scarto > BANDA_NEUTRA ? COLORS.bullish : scarto < -BANDA_NEUTRA ? COLORS.bearish : COLORS.neutral;

        const yMedia = perValore(media);
        const altezza = Math.abs(yMedia - centerY);

        ctx.fillStyle = colore;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(xSinistra, Math.min(yMedia, centerY), larghezza, Math.max(1, altezza));
        ctx.globalAlpha = 1;

        ctx.strokeStyle = colore;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(xSinistra, Math.min(yMedia, centerY), larghezza, Math.max(1, altezza));

        // Baffo da minimo a massimo dell'intervallo: dice se il minuto e'
        // stato compatto o se dentro ci si e' contraddetti. Senza, la media
        // di un minuto diviso a meta' e quella di un minuto tutto uguale
        // sarebbero indistinguibili.
        if (g.quante > 1) {
          ctx.strokeStyle = colore;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xCentro, perValore(g.massimo));
          ctx.lineTo(xCentro, perValore(g.minimo));
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        medie.push({ x: xCentro, y: yMedia });
      });

      // Filo che unisce le medie: la direzione si legge prima del colore.
      if (medie.length > 1) {
        medie.sort((a, b) => a.x - b.x);
        ctx.strokeStyle = "#ffffff";
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1;
        ctx.beginPath();
        medie.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Draw time axis labels
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";

    const timeStep = Math.ceil(candles.length / 8); // Show ~8 time labels
    for (let i = 0; i < candles.length; i += timeStep) {
      const candle = candles[i];
      const x = leftMargin + (i / candles.length) * chartWidth;

      // Format time from timestamp
      const date = new Date(candle.timestamp);
      const timeStr = date.toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      ctx.save();
      ctx.translate(x, height - bottomMargin + 20);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = "right";
      ctx.fillText(timeStr, 0, 0);
      ctx.restore();
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
    ctx.fillText("FLUSSO GAMMA", 20, height / 2);
  }, [candles, volflow, volflowHistory, timeframe, crosshairX, timeZoom, volflowZoom]);

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
        // Regular Wheel = zoom VOLFLOW (Y axis)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;

        if (volflowZoom) {
          const range = volflowZoom.max - volflowZoom.min;
          const center = (volflowZoom.min + volflowZoom.max) / 2;
          const newRange = range * zoomFactor;
          setVolflowZoomLocal({
            min: Math.max(0, center - newRange / 2),
            max: Math.min(100, center + newRange / 2),
          });
        } else {
          // Dominio pieno: da -100 a +100
          const center = 0;
          const newRange = 200 / zoomFactor;
          setVolflowZoomLocal({
            min: Math.max(-100, center - newRange / 2),
            max: Math.min(100, center + newRange / 2),
          });
        }
      }
    },
    [timeZoom, volflowZoom]
  );

  return (
    <div ref={containerRef} className={styles.volflowChartPanel} onWheel={handleWheel}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
        }}
      />
    </div>
  );
};
