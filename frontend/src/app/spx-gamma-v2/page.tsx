"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { MockDataProvider } from "@/data/mockProvider";
import { RealDataProvider } from "@/data/realDataProvider";
import { VolumiProvider } from "@/data/volumiProvider";
import { PriceChart } from "@/components/spx-gamma-v2/PriceChart";
import { GexChart } from "@/components/spx-gamma-v2/GexChart";
import { StatusBar } from "@/components/spx-gamma-v2/StatusBar";
import { ControlPanel } from "@/components/spx-gamma-v2/ControlPanel";
import { Tooltip } from "@/components/spx-gamma-v2/Tooltip";
import { VolflowIndicator } from "@/components/spx-gamma-v2/VolflowIndicator";
import { VolflowPanel } from "@/components/spx-gamma-v2/VolflowPanel";
import { VolflowChartPanel } from "@/components/spx-gamma-v2/VolflowChartPanel";
import { EmptyPanel } from "@/components/spx-gamma-v2/EmptyPanel";
import { InfoModal } from "@/components/spx-gamma-v2/InfoModal";
import { VolflowEngine } from "@/engines/volflowEngine";
import { AnalysisSnapshot, CandleData } from "@/types/gamma";
import type { PuntoVolflow } from "@/components/spx-gamma-v2/VolflowChartPanel";
import styles from "./page.module.css";

export default function SpxGammaPage() {
  const providerRef = useRef<MockDataProvider | RealDataProvider | null>(null);
  const volflowEngineRef = useRef<VolflowEngine | null>(null);
  const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
  const [symbol, setSymbol] = useState<"SPX" | "ES">("ES"); // Default to ES for real data
  // I dati veri sono il default: il mock resta a un clic di distanza nel
  // pannello, ma non e' piu' quello che vedi aprendo la pagina.
  const [dataSource, setDataSource] = useState<"MOCK" | "REAL">("REAL");
  const [timeframe, setTimeframe] = useState<"1m" | "5m" | "15m">("1m");
  const [atmRange, setAtmRange] = useState<1 | 2 | 3 | 5>(3);
  const [expiration, setExpiration] = useState<"0DTE" | "1DTE" | "Weekly" | "Monthly">("0DTE");
  const [isPaused, setIsPaused] = useState(false);
  const [crosshairX, setCrosshairX] = useState<number | undefined>(undefined);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [showTooltip, setShowTooltip] = useState(false);
  const [hoveredCandle, setHoveredCandle] = useState<CandleData | undefined>(undefined);
  const [showVolflowDebug, setShowVolflowDebug] = useState(false);
  const [priceZoom, setPriceZoom] = useState<{ min: number; max: number } | null>(null);
  const [gexZoom, setGexZoom] = useState<{ min: number; max: number } | null>(null);
  const [timeZoom, setTimeZoom] = useState<{ start: number; end: number } | null>(null);
  const [volflowZoom, setVolflowZoom] = useState<{ min: number; max: number } | null>(null);
  // Ogni lettura porta con se' il proprio istante: senza, il pannello sotto
  // disegnava le barre su un asse tutto suo (vedi VolflowChartPanel).
  const [volflowHistory, setVolflowHistory] = useState<PuntoVolflow[]>([]);
  const [mostraSpiegazione, setMostraSpiegazione] = useState(false);
  /** Valore corrente del flusso, da -100 (put) a +100 (call). */
  const [flussoCorrente, setFlussoCorrente] = useState(0);
  /**
   * Il pannello in basso vive sui volumi realmente scambiati, non sui premi
   * ATM: e' l'unica sorgente di questo progetto risultata legata al movimento
   * successivo del prezzo (+0.18 a un minuto, positiva in 5 sessioni su 5),
   * mentre ogni costruzione sui premi dava zero.
   */
  const volumiRef = useRef<VolumiProvider | null>(null);
  /** Perche' non c'e' ancora niente da mostrare, se non c'e'. */
  const [avviso, setAvviso] = useState<string | null>(null);
  /** Timestamp dell'ultimo punto di mercato gia' dato al motore VOLFLOW. */
  const ultimoTsVolflow = useRef<number>(0);
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize provider and VOLFLOW engine
  useEffect(() => {
    const initProvider = async () => {
      volflowEngineRef.current = new VolflowEngine(2.3, 3.0);

      if (dataSource === "REAL") {
        // Use real data from IBKR via API
        const realProvider = new RealDataProvider();
        await realProvider.initialize();
        providerRef.current = realProvider;

        // La sessione dei volumi si ripercorre tutta al primo giro: il motore
        // arriva al presente con la finestra di z-score gia' piena, e il
        // riquadro in basso copre lo stesso tratto di tempo del grafico dei
        // prezzi invece di ripartire vuoto a ogni ricaricamento.
        const volumi = new VolumiProvider();
        volumiRef.current = volumi;
        const puntiFlusso = await volumi.nuoviPunti();
        if (puntiFlusso.length > 0) {
          setVolflowHistory(puntiFlusso.map((p) => ({ timestamp: p.timestamp, value: p.valore })).slice(-720));
          setFlussoCorrente(puntiFlusso[puntiFlusso.length - 1].valore);
        }

        const snap = await realProvider.generateSnapshot();
        if (snap) setSnapshot(snap);
      } else {
        // Use mock data
        const mockProvider = new MockDataProvider(14, 50);
        providerRef.current = mockProvider;

        let snap = mockProvider.generateSnapshot();
        for (let i = 0; i < 19; i++) {
          snap = mockProvider.generateSnapshot(snap);
        }

        if (snap.atmCall && snap.atmPut) {
          const volflowOutput = volflowEngineRef.current.calculate({
            callPrice: snap.atmCall.price,
            putPrice: snap.atmPut.price,
            callIv: snap.atmCall.iv,
            putIv: snap.atmPut.iv,
            callGamma: snap.atmCall.gamma,
            putGamma: snap.atmPut.gamma,
            timestamp: snap.timestamp,
          });
          setFlussoCorrente((volflowOutput.volflow - 50) * 2);
        }
        setSnapshot(snap);
      }
    };

    initProvider();
  }, [symbol, dataSource]);

  // Update loop
  useEffect(() => {
    if (!providerRef.current) return;

    const update = async () => {
      if (isPaused) return;

      let newSnapshot: AnalysisSnapshot | null | undefined;

      if (dataSource === "REAL" && providerRef.current instanceof RealDataProvider) {
        newSnapshot = await (providerRef.current as RealDataProvider).generateSnapshot();
      } else if (providerRef.current instanceof MockDataProvider) {
        newSnapshot = (providerRef.current as MockDataProvider).generateSnapshot(snapshot || undefined);
      }

      if (!newSnapshot && providerRef.current instanceof RealDataProvider) {
        setAvviso(providerRef.current.ultimoAvviso);
      }

      if (newSnapshot) {
        setAvviso(null);
        setSnapshot(newSnapshot);

        if (dataSource === "REAL" && volumiRef.current) {
          // Incrementale con ?since=: ~2 KB a giro invece della sessione
          // intera, che e' quello che mandava in rosso il piano Supabase.
          const nuovi = await volumiRef.current.nuoviPunti();
          if (nuovi.length > 0) {
            setFlussoCorrente(nuovi[nuovi.length - 1].valore);
            setVolflowHistory((prev) =>
              [...prev, ...nuovi.map((p) => ({ timestamp: p.timestamp, value: p.valore }))].slice(-720),
            );
          }
        } else if (newSnapshot.atmCall && newSnapshot.atmPut && volflowEngineRef.current) {
          // Solo per i dati finti, che non hanno una catena da cui leggere il
          // flusso: il vecchio motore, riportato sulla scala con segno.
          const tsNuovo = newSnapshot.timestamp !== ultimoTsVolflow.current;
          if (tsNuovo) {
            ultimoTsVolflow.current = newSnapshot.timestamp;
            const output = volflowEngineRef.current.calculate({
              callPrice: newSnapshot.atmCall.price,
              putPrice: newSnapshot.atmPut.price,
              callIv: newSnapshot.atmCall.iv,
              putIv: newSnapshot.atmPut.iv,
              callGamma: newSnapshot.atmCall.gamma,
              putGamma: newSnapshot.atmPut.gamma,
              timestamp: newSnapshot.timestamp,
            });
            const segnato = (output.volflow - 50) * 2;
            setFlussoCorrente(segnato);
            const ts = newSnapshot.timestamp;
            setVolflowHistory((prev) => [...prev, { timestamp: ts, value: segnato }].slice(-720));
          }
        }
      }
    };

    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current);
    }

    updateIntervalRef.current = setInterval(update, 5000);

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
      }
    };
  }, [isPaused, snapshot, dataSource]);

  const handleCrosshairMove = useCallback(
    (x: number, y: number, timestamp?: number) => {
      setCrosshairX(x);
      // Tooltip disabled - only show crosshair
      setShowTooltip(false);

      // Find candle at this timestamp
      if (timestamp && snapshot) {
        const candle = snapshot.priceCandles.find((c) => c.timestamp === timestamp);
        setHoveredCandle(candle);
      }
    },
    [snapshot]
  );

  if (!snapshot) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          {avviso ? `In attesa di dati - ${avviso}` : "Initializing..."}
        </div>
      </div>
    );
  }

  const metrics = snapshot.gammaMetrics;
  const volatilityMetrics = snapshot.volatilityMetrics;

  return (
    <div className={styles.container}>
      <ControlPanel
        symbol={symbol}
        onSymbolChange={setSymbol}
        dataSource={dataSource}
        onDataSourceChange={setDataSource}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        atmRange={atmRange}
        onAtmRangeChange={setAtmRange}
        expiration={expiration}
        onExpirationChange={setExpiration}
        isPaused={isPaused}
        onPauseToggle={() => setIsPaused(!isPaused)}
        onInfo={() => setMostraSpiegazione(true)}
        onResetZoom={() => {
          setPriceZoom(null);
          setGexZoom(null);
          setTimeZoom(null);
          setVolflowZoom(null);
        }}
      />

      <div className={styles.mainLayout}>
        <div className={styles.leftColumn}>
          <div className={styles.priceChartContainer}>
            <PriceChart
              candles={snapshot.priceCandles}
              gexBars={snapshot.gexBars}
              spot={metrics.spot}
              longGamma={metrics.majorLongGamma}
              shortGamma={metrics.majorShortGamma}
              callGamma={metrics.callGamma}
              putGamma={metrics.putGamma}
              onCrosshairMove={handleCrosshairMove}
              crosshairX={crosshairX}
              priceZoom={priceZoom}
              onPriceZoomChange={setPriceZoom}
              timeZoom={timeZoom}
              onTimeZoomChange={setTimeZoom}
            />
          </div>
          <VolflowChartPanel
            candles={snapshot.priceCandles}
            volflow={flussoCorrente}
            volflowHistory={volflowHistory}
            timeframe={timeframe}
            crosshairX={crosshairX}
            timeZoom={timeZoom}
            onTimeZoomChange={setTimeZoom}
            volflowZoom={volflowZoom}
            onVolflowZoomChange={setVolflowZoom}
          />
        </div>

        <div className={styles.rightColumn}>
          <div className={styles.gexChartContainer}>
            <GexChart
              gexBars={snapshot.gexBars}
              spot={metrics.spot}
              longGamma={metrics.majorLongGamma}
              shortGamma={metrics.majorShortGamma}
              callGamma={metrics.callGamma}
              putGamma={metrics.putGamma}
              crosshairX={crosshairX}
              volflow={flussoCorrente}
              gexZoom={gexZoom}
              onGexZoomChange={setGexZoom}
              timeZoom={timeZoom}
              onTimeZoomChange={setTimeZoom}
            />
          </div>
          <VolflowPanel volflow={flussoCorrente / 2 + 50} />
          <EmptyPanel title="Sub Panel" />
        </div>
      </div>

      <StatusBar
        metrics={metrics}
        volatilityMetrics={volatilityMetrics}
        dataSource={dataSource}
      />

      <InfoModal aperto={mostraSpiegazione} onChiudi={() => setMostraSpiegazione(false)} />

      <Tooltip
        x={tooltipPos.x}
        y={tooltipPos.y}
        candle={hoveredCandle}
        metrics={metrics}
        volatilityMetrics={volatilityMetrics}
        visible={showTooltip}
      />
    </div>
  );
}
