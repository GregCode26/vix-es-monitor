'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Chart as ChartJS, registerables, type Plugin } from 'chart.js';
import { Line } from 'react-chartjs-2';
import Link from 'next/link';
import type { ZoomPluginOptions } from 'chartjs-plugin-zoom/types/options';
import styles from './page.module.css';

ChartJS.register(...registerables);

/**
 * Tetto agli snapshot tenuti in memoria: una sessione intera a uno ogni
 * cinque secondi sono ~6.100 punti, piu' di quanti un grafico largo un
 * migliaio di pixel possa distinguere.
 */
const MAX_SNAPSHOT = 4000;

interface IVSnapshot {
  time: string;
  timestamp: number;
  esPrice: number | null;
  atmStrike: number;
  // Old (all nearby) - backward compat
  weightedPutIV: number | null;
  weightedCallIV: number | null;
  putIVChangePct: number | null;
  callIVChangePct: number | null;
  // New: ATM only
  putAtmIV?: number | null;
  callAtmIV?: number | null;
  putAtmIVChangePct?: number | null;
  callAtmIVChangePct?: number | null;
  // New: WING (OTM) - PRIMARY SIGNAL
  putWingIV?: number | null;
  callWingIV?: number | null;
  putWingIVChangePct?: number | null;
  callWingIVChangePct?: number | null;
  // New: SKEW
  putSkew?: number | null;
  callSkew?: number | null;
  putSkewChangePct?: number | null;
  callSkewChangePct?: number | null;
  // Differentials
  volDifferentialPct?: number | null;
  ivDifferentialPct: number | null;
  putsData?: Array<{ strike: number; bid?: number; ask?: number; mid?: number; iv?: number | null }>;
  callsData?: Array<{ strike: number; bid?: number; ask?: number; mid?: number; iv?: number | null }>;
}

/** Un punto di /api/market: ES e SPX allo stesso istante. */
interface PuntoEs {
  time: string;
  esf: number | null;
  spx: number | null;
}

/** Scale con lo zoom fissato a mano: 'x' vale per i due grafici, le y per grafico ('main.y', 'main.yEs', 'diff.y'). */
type Scale = Record<string, { min: number; max: number }>;

const secondi = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

interface ChartPoint {
  time: string;
  /** ES dal poller del mercato; dove manca, SPX + la base ES-SPX piu' vicina. */
  es: number | null;
  // Primary: WING IV changes
  putWingChange: number | null;
  callWingChange: number | null;
  // Secondary: ATM IV changes
  putAtmChange: number | null;
  callAtmChange: number | null;
  // Skew
  putSkewChange: number | null;
  callSkewChange: number | null;
  // Differentials
  volDifferential: number | null;
  // Raw IV values for reference
  putWingIV: number | null;
  callWingIV: number | null;
  putAtmIV: number | null;
  callAtmIV: number | null;
}

export default function IVMonitorPage() {
  const [snapshots, setSnapshots] = useState<IVSnapshot[]>([]);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [lookback, setLookback] = useState<'5s' | '30s' | '1m' | '5m'>('1m');
  const [strikeRange, setStrikeRange] = useState<'atm' | '±1' | '±2' | '±3'>('±2');
  const [isLive, setIsLive] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  // Il plugin di zoom tocca `window` al caricamento: si importa nel browser,
  // e i grafici aspettano che sia registrato.
  const [zoomPronto, setZoomPronto] = useState(false);
  // Zoom fissato a mano, per scala (l'asse x e' condiviso dai due grafici,
  // in indici delle etichette). Sta nello stato e torna nelle opzioni a ogni
  // render: altrimenti l'aggiornamento ogni 5 secondi riassegnava le opzioni
  // e azzerava lo zoom.
  const [scale, setScale] = useState<Scale>({});
  // Scala su cui e' cominciato lo zoom o il trascinamento ('x', 'y', 'yEs').
  const scalaAttiva = useRef<string>('x');
  const [esPunti, setEsPunti] = useState<PuntoEs[]>([]);
  // Lo storico ES si scarica una volta sola, poi solo l'ultimo punto.
  const esCaricato = useRef(false);
  const mainChartRef = useRef<ChartJS<'line'> | null>(null);
  const diffChartRef = useRef<ChartJS<'line'> | null>(null);
  /** Posizione del mirino: l'orario vale per tutti e due i grafici, l'altezza solo per quello sotto il mouse. */
  const mirinoRef = useRef<{ indice: number; y: number; sorgente: ChartJS } | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Ultimo snapshot gia' in memoria: la route restituisce solo i successivi.
  const ultimoTempo = useRef<string | null>(null);
  const giornoSessione = useRef<string | null>(null);

  const lookbackSeconds = {
    '5s': 5,
    '30s': 30,
    '1m': 60,
    '5m': 300,
  }[lookback];

  // Fetch IV data from API
  //
  // Incrementale, come /api/volumes e /api/gex. Prima si riscaricava l'intera
  // giornata a ogni giro: uno snapshot pesa ~1,3 KB e ne arriva uno ogni
  // cinque secondi, quindi a fine sessione sono ~8 MB per richiesta, 720
  // richieste l'ora. In locale e' solo spreco, ma quando i dati arrivano da
  // Supabase e' esattamente la voce che consuma l'egress del piano free.
  const fetchIVData = async () => {
    try {
      const since = ultimoTempo.current;
      const url = since ? `/api/iv-monitor?since=${encodeURIComponent(since)}` : '/api/iv-monitor';
      const response = await fetch(url, { cache: 'no-store' });
      const data = await response.json();

      // Cambio di giornata: si riparte da zero, senza `since`.
      if (data.date && giornoSessione.current && data.date !== giornoSessione.current) {
        giornoSessione.current = data.date;
        ultimoTempo.current = null;
        setSnapshots([]);
        setEsPunti([]);
        esCaricato.current = false;
        return;
      }
      if (data.date) giornoSessione.current = data.date;

      // ES: la giornata una volta sola, poi solo l'ultimo punto (pochi
      // byte) a ogni giro, invece di riscaricare lo storico ogni 5 secondi.
      const storico = !esCaricato.current;
      esCaricato.current = true;
      fetch(storico ? '/api/market?history=true' : '/api/market', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          if (!m) {
            if (storico) esCaricato.current = false;
            return;
          }
          if (Array.isArray(m.history)) {
            setEsPunti(m.history.map((p: PuntoEs) => ({ time: p.time, esf: p.esf ?? null, spx: p.spx ?? null })));
          } else if (m.sourceTime && typeof m.esf === 'number') {
            setEsPunti((prec) =>
              prec.length > 0 && prec[prec.length - 1].time >= m.sourceTime
                ? prec
                : [...prec, { time: m.sourceTime, esf: m.esf, spx: m.spx ?? null }],
            );
          }
        })
        .catch(() => {
          if (storico) esCaricato.current = false;
        });

      const arrivati: IVSnapshot[] = data.snapshots || [];
      if (arrivati.length > 0) {
        ultimoTempo.current = arrivati[arrivati.length - 1].time;
        setSnapshots((prec) => (since ? [...prec, ...arrivati].slice(-MAX_SNAPSHOT) : arrivati));
      }
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (error) {
      console.error('Error fetching IV data:', error);
    }
  };

  // Build chart data from snapshots
  //
  // Le variazioni si calcolano qui dai livelli di IV, con il lookback scelto
  // nel selettore. I campi *ChangePct scritti dal poller valevano sempre 0
  // (confrontava ogni valore con se stesso) e il selettore non era collegato
  // a niente: il grafico era una riga piatta.
  useEffect(() => {
    if (snapshots.length === 0) {
      setChartData([]);
      return;
    }

    const variazione = (ora: number | null | undefined, prima: number | null | undefined) =>
      ora != null && prima != null && prima !== 0 ? ((ora - prima) / prima) * 100 : null;
    // Ripiego sull'IV pesata near-ATM per gli snapshot senza le ali.
    const ala = (s: IVSnapshot, lato: 'put' | 'call') =>
      lato === 'put' ? s.putWingIV ?? s.weightedPutIV : s.callWingIV ?? s.weightedCallIV;
    // Oltre questo scarto lo snapshot "di prima" non e' piu' quello giusto (buchi nei dati).
    const tolleranza = lookbackSeconds + 15;

    const conEs = esPunti.filter((p) => typeof p.esf === 'number');
    const conBase = conEs.filter((p) => typeof p.spx === 'number');
    let k = -1;
    let kb = -1;
    const esA = (snap: IVSnapshot): number | null => {
      while (k + 1 < conEs.length && conEs[k + 1].time <= snap.time) k++;
      if (k >= 0 && secondi(snap.time) - secondi(conEs[k].time) <= 30) return conEs[k].esf;
      // Buco nello storico del mercato: SPX dell'IV monitor + la base piu' vicina.
      while (kb + 1 < conBase.length && conBase[kb + 1].time <= snap.time) kb++;
      const b = conBase[Math.max(kb, 0)];
      if (!b || snap.esPrice == null) return null;
      return snap.esPrice + (b.esf! - b.spx!);
    };

    let j = 0;
    const points: ChartPoint[] = snapshots.map((snap) => {
      const obiettivo = snap.timestamp - lookbackSeconds;
      while (j + 1 < snapshots.length && snapshots[j + 1].timestamp <= obiettivo) j++;
      const prima = snapshots[j];
      const valido = prima.timestamp <= obiettivo && snap.timestamp - prima.timestamp <= tolleranza;

      const putWingChange = valido ? variazione(ala(snap, 'put'), ala(prima, 'put')) : null;
      const callWingChange = valido ? variazione(ala(snap, 'call'), ala(prima, 'call')) : null;
      return {
        time: snap.time,
        es: esA(snap),
        putWingChange,
        callWingChange,
        putAtmChange: valido ? variazione(snap.putAtmIV, prima.putAtmIV) : null,
        callAtmChange: valido ? variazione(snap.callAtmIV, prima.callAtmIV) : null,
        putSkewChange: valido ? variazione(snap.putSkew, prima.putSkew) : null,
        callSkewChange: valido ? variazione(snap.callSkew, prima.callSkew) : null,
        volDifferential: putWingChange != null && callWingChange != null ? putWingChange - callWingChange : null,
        putWingIV: ala(snap, 'put') ?? null,
        callWingIV: ala(snap, 'call') ?? null,
        putAtmIV: snap.putAtmIV ?? null,
        callAtmIV: snap.callAtmIV ?? null,
      };
    });

    setChartData(points);
  }, [snapshots, lookbackSeconds, esPunti]);

  useEffect(() => {
    let annullato = false;
    import('chartjs-plugin-zoom').then(({ default: zoomPlugin }) => {
      ChartJS.register(zoomPlugin);
      if (!annullato) setZoomPronto(true);
    });
    return () => {
      annullato = true;
    };
  }, []);

  // Nel grafico: rotella o pinch per lo zoom sul tempo, trascinamento per
  // scorrere. Sopra una scala verticale (IV a sinistra, ES a destra) la
  // rotella allunga o stringe solo quella, il trascinamento la sposta.
  const inizio = (chart: ChartJS, point?: { x?: number | null } | null) => {
    const a = chart.chartArea;
    if (point?.x == null || (point.x >= a.left && point.x <= a.right)) scalaAttiva.current = 'x';
    else scalaAttiva.current = point.x > a.right && chart.scales.yEs ? 'yEs' : 'y';
    return true;
  };
  const salva = ({ chart }: { chart: ChartJS }) => {
    const id = scalaAttiva.current;
    const sc = chart.scales[id];
    if (!sc) return;
    const chiave = id === 'x' ? 'x' : `${(chart as unknown) === mainChartRef.current ? 'main' : 'diff'}.${id}`;
    const valore = id === 'x' ? { min: Math.round(sc.min), max: Math.round(sc.max) } : { min: sc.min, max: sc.max };
    setScale((prec) => ({ ...prec, [chiave]: valore }));
  };
  const opzioniZoom: ZoomPluginOptions = {
    zoom: {
      wheel: { enabled: true, speed: 0.1 },
      pinch: { enabled: true },
      mode: 'xy',
      overScaleMode: 'y',
      onZoomStart: ({ chart, point }) => inizio(chart, point),
      onZoomComplete: salva,
    },
    pan: {
      enabled: true,
      mode: 'xy',
      overScaleMode: 'y',
      onPanStart: ({ chart, point }) => inizio(chart, point),
      onPanComplete: salva,
    },
    limits: { x: { minRange: 6 } },
  };

  /**
   * Mirino a croce al posto del riquadro dei valori, come in /market e
   * /bookmap: linea verticale su entrambi i grafici allo stesso orario,
   * orizzontale solo dove sta il mouse, e i valori scritti sugli assi.
   */
  const mirino = useMemo<Plugin<'line'>>(
    () => ({
      id: 'mirino',
      afterEvent: (chart, args) => {
        const e = args.event;
        const a = chart.chartArea;
        const dentro =
          e.type !== 'mouseout' && e.x != null && e.y != null &&
          e.x >= a.left && e.x <= a.right && e.y >= a.top && e.y <= a.bottom;
        if (dentro) {
          const indice = Math.round(chart.scales.x.getValueForPixel(e.x!) ?? 0);
          mirinoRef.current = { indice, y: e.y!, sorgente: chart as ChartJS };
        } else if (mirinoRef.current?.sorgente === chart) {
          mirinoRef.current = null;
        } else {
          return;
        }
        args.changed = true;
        for (const altro of [mainChartRef.current, diffChartRef.current]) {
          if (altro && (altro as ChartJS) !== (chart as ChartJS)) altro.draw();
        }
      },
      afterDraw: (chart) => {
        const m = mirinoRef.current;
        const sx = chart.scales.x;
        const sy = chart.scales.y;
        if (!m || !sx || !sy) return;
        const { ctx, chartArea: a } = chart;
        const x = sx.getPixelForValue(m.indice);
        if (x < a.left || x > a.right) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.8)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, a.top);
        ctx.lineTo(x, a.bottom);
        const qui = m.sorgente === (chart as ChartJS);
        if (qui) {
          ctx.moveTo(a.left, m.y);
          ctx.lineTo(a.right, m.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const etichetta = (testo: string, cx: number, cy: number) => {
          const w = ctx.measureText(testo).width + 8;
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(cx - w / 2, cy - 8, w, 16);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(testo, cx, cy);
        };
        const orario = chart.data.labels?.[m.indice];
        if (orario != null) etichetta(String(orario), x, a.bottom + 9);
        if (qui) {
          const valore = sy.getValueForPixel(m.y);
          if (valore != null) {
            const testo = `${valore > 0 ? '+' : ''}${valore.toFixed(2)}%`;
            const w = ctx.measureText(testo).width + 8;
            etichetta(testo, Math.max(a.left - w / 2, w / 2), m.y);
          }
          // Sul grafico con la linea ES, il prezzo ES alla stessa altezza sulla scala di destra.
          const valoreEs = chart.scales.yEs?.getValueForPixel(m.y);
          if (valoreEs != null) {
            const testo = valoreEs.toFixed(2);
            const w = ctx.measureText(testo).width + 8;
            etichetta(testo, a.right + w / 2, m.y);
          }
        }
        ctx.restore();
      },
    }),
    [],
  );

  // Poll data every 5 seconds
  useEffect(() => {
    fetchIVData();

    pollIntervalRef.current = setInterval(() => {
      if (isLive) {
        fetchIVData();
      }
    }, 5000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [isLive]);

  const currentSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const ultimoPunto = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  // L'IV arriva in decimale (0.094), le card la mostrano in punti percentuali.
  const inPunti = (iv: number | null | undefined) => (iv != null ? (iv * 100).toFixed(2) : '—');
  const conSegno = (x: number | null | undefined) => (x != null ? (x > 0 ? '+' : '') + x.toFixed(2) : '—');

  return (
    <div className={styles.container}>
      {/* HEADER */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h1>ES 0DTE ATM IMPLIED VOLATILITY</h1>
          <p className={styles.subtitle}>Real-Time Put vs Call IV Change</p>
        </div>
        <div className={styles.headerStatus}>
          <Link href="/market" className={styles.liveButton}>
            ← MARKET
          </Link>
          <div className={styles.liveIndicator}>
            <span className={isLive ? styles.live : styles.paused}>●</span>
            <span className={styles.liveText}>{isLive ? 'LIVE' : 'PAUSED'}</span>
          </div>
          <div className={styles.updateInfo}>
            <div>Last update: {lastUpdate}</div>
            <div>Refresh: {isLive ? '5 sec' : '—'}</div>
          </div>
        </div>
      </header>

      {/* ES PANEL */}
      <section className={styles.esPanel}>
        <div className={styles.panelTitle}>ES FUTURE</div>
        <div className={styles.esData}>
          <div className={styles.dataItem}>
            <span className={styles.label}>ES:</span>
            <span className={styles.value}>{currentSnapshot?.esPrice?.toFixed(2) ?? '—'}</span>
          </div>
          <div className={styles.dataItem}>
            <span className={styles.label}>ATM:</span>
            <span className={styles.value}>{currentSnapshot?.atmStrike?.toFixed(0) ?? '—'}</span>
          </div>
          <div className={styles.dataItem}>
            <span className={styles.label}>Expiry:</span>
            <span className={styles.value}>0DTE (Today)</span>
          </div>
          <div className={styles.dataItem}>
            <span className={styles.label}>Update:</span>
            <span className={styles.value}>{currentSnapshot?.time ?? '—'}</span>
          </div>
        </div>
      </section>

      {/* MAIN CHART - WING IV Changes (PRIMARY SIGNAL) */}
      <section className={styles.chartSection}>
        <div className={styles.chartHeader}>
          <h2>ES 0DTE — WING (OTM) IMPLIED VOLATILITY CHANGE</h2>
          <div className={styles.chartControls}>
            <label>
              Lookback:
              <select value={lookback} onChange={(e) => setLookback(e.target.value as any)}>
                <option value="5s">5 sec</option>
                <option value="30s">30 sec</option>
                <option value="1m">1 min</option>
                <option value="5m">5 min</option>
              </select>
            </label>
            <button
              className={styles.liveButton}
              onClick={() => setIsLive(!isLive)}
            >
              {isLive ? 'PAUSE' : 'RESUME'}
            </button>
            {Object.keys(scale).length > 0 && (
              <button className={styles.liveButton} onClick={() => setScale({})}>
                RESET ZOOM
              </button>
            )}
          </div>
        </div>

        <div className={styles.mainChart} style={{ cursor: 'crosshair' }}>
          {chartData.length > 0 && zoomPronto ? (
            <Line
              ref={mainChartRef}
              plugins={[mirino]}
              data={{
                labels: chartData.map((p) => p.time),
                datasets: [
                  {
                    label: 'PUT WING IV Change %',
                    data: chartData.map((p) => p.putWingChange),
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0.1,
                  },
                  {
                    label: 'CALL WING IV Change %',
                    data: chartData.map((p) => p.callWingChange),
                    borderColor: '#0ea5e9',
                    backgroundColor: 'rgba(14, 165, 233, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0.1,
                  },
                  {
                    label: 'ES',
                    data: chartData.map((p) => p.es),
                    yAxisID: 'yEs',
                    borderColor: '#facc15',
                    backgroundColor: 'rgba(250, 204, 21, 0.1)',
                    borderWidth: 1.5,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  zoom: opzioniZoom,
                  legend: {
                    display: true,
                    position: 'top',
                    labels: {
                      padding: 15,
                      font: { size: 12, weight: 600 },
                      usePointStyle: true,
                    },
                  },
                  tooltip: { enabled: false },
                },
                scales: {
                  x: {
                    display: true,
                    grid: { display: false },
                    ticks: { maxRotation: 0, font: { size: 10 } },
                    min: scale.x?.min,
                    max: scale.x?.max,
                  },
                  y: {
                    display: true,
                    position: 'left',
                    title: { display: true, text: 'IV Change %' },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { font: { size: 10 } },
                    min: scale['main.y']?.min,
                    max: scale['main.y']?.max,
                  },
                  yEs: {
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'ES', color: '#ca8a04' },
                    grid: { display: false },
                    ticks: { font: { size: 10 }, color: '#ca8a04' },
                    min: scale['main.yEs']?.min,
                    max: scale['main.yEs']?.max,
                  },
                },
              }}
            />
          ) : (
            <div className={styles.noData}>No data available</div>
          )}
        </div>
      </section>

      {/* DIFFERENTIAL CHART */}
      <section className={styles.diffChartSection}>
        <div className={styles.chartHeader}>
          <h2>PUT vs CALL IV DIFFERENTIAL</h2>
        </div>
        <div className={styles.diffChart} style={{ cursor: 'crosshair' }}>
          {chartData.length > 0 && zoomPronto ? (
            <Line
              ref={diffChartRef}
              plugins={[mirino]}
              data={{
                labels: chartData.map((p) => p.time),
                datasets: [
                  {
                    label: 'Differential %',
                    data: chartData.map((p) => p.volDifferential),
                    borderColor: '#8b5cf6',
                    backgroundColor: 'rgba(139, 92, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0.1,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  zoom: opzioniZoom,
                  legend: { display: false },
                  tooltip: { enabled: false },
                },
                scales: {
                  x: {
                    display: true,
                    grid: { display: false },
                    ticks: { maxRotation: 0, font: { size: 9 } },
                    min: scale.x?.min,
                    max: scale.x?.max,
                  },
                  y: {
                    display: true,
                    title: { display: true, text: 'Differential %' },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { font: { size: 9 } },
                    min: scale['diff.y']?.min,
                    max: scale['diff.y']?.max,
                  },
                },
              }}
            />
          ) : (
            <div className={styles.noData}>No data</div>
          )}
        </div>
      </section>

      {/* SUMMARY PANEL */}
      <section className={styles.summaryPanel}>
        <div className={styles.summaryTitle}>WING IV (OTM) — PRIMARY SIGNAL</div>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>PUT WING IV</div>
            <div className={styles.summaryValue}>
              {inPunti(ultimoPunto?.putWingIV)}%
            </div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>PUT WING Δ</div>
            <div
              className={`${styles.summaryValue} ${
                (ultimoPunto?.putWingChange ?? 0) > 0
                  ? styles.positive
                  : styles.negative
              }`}
            >
              {conSegno(ultimoPunto?.putWingChange)}
              %
            </div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>CALL WING IV</div>
            <div className={styles.summaryValue}>
              {inPunti(ultimoPunto?.callWingIV)}%
            </div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>CALL WING Δ</div>
            <div
              className={`${styles.summaryValue} ${
                (ultimoPunto?.callWingChange ?? 0) > 0
                  ? styles.positive
                  : styles.negative
              }`}
            >
              {conSegno(ultimoPunto?.callWingChange)}
              %
            </div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>DIFFERENTIAL</div>
            <div
              className={`${styles.summaryValue} ${
                (ultimoPunto?.volDifferential ?? 0) > 0
                  ? styles.positive
                  : styles.negative
              }`}
            >
              {conSegno(ultimoPunto?.volDifferential)}
              %
            </div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryLabel}>LOOKBACK</div>
            <div className={styles.summaryValue}>{lookback}</div>
          </div>
        </div>
      </section>

      {/* STRIKE DETAILS */}
      <section className={styles.strikeDetails}>
        <div className={styles.strikeTitle}>STRIKE DETAILS</div>
        <div className={styles.strikeGrid}>
          <div className={styles.strikeColumn}>
            <h3>PUTS</h3>
            {currentSnapshot?.putsData && currentSnapshot.putsData.length > 0 ? (
              <ul className={styles.strikeList}>
                {currentSnapshot.putsData.map((opt, i) => (
                  <li
                    key={i}
                    className={
                      opt.strike === currentSnapshot.atmStrike
                        ? styles.atmStrike
                        : ''
                    }
                  >
                    <span className={styles.strike}>{opt.strike.toFixed(0)}</span>
                    <span className={styles.iv}>IV: {inPunti(opt.iv)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.noData}>No data</div>
            )}
          </div>
          <div className={styles.strikeColumn}>
            <h3>CALLS</h3>
            {currentSnapshot?.callsData && currentSnapshot.callsData.length > 0 ? (
              <ul className={styles.strikeList}>
                {currentSnapshot.callsData.map((opt, i) => (
                  <li
                    key={i}
                    className={
                      opt.strike === currentSnapshot.atmStrike
                        ? styles.atmStrike
                        : ''
                    }
                  >
                    <span className={styles.strike}>{opt.strike.toFixed(0)}</span>
                    <span className={styles.iv}>IV: {inPunti(opt.iv)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.noData}>No data</div>
            )}
          </div>
        </div>
      </section>

      {/* STATUS */}
      <footer className={styles.footer}>
        <div className={styles.statusBox}>
          <p>
            <strong>Status:</strong> {snapshots.length > 0 ? 'Connected' : 'Waiting for data'} | <strong>Points:</strong> {snapshots.length}
          </p>
        </div>
      </footer>
    </div>
  );
}
