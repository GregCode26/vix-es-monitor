'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Chart as ChartJS, registerables, type ChartDataset, type Scale } from 'chart.js';

ChartJS.register(...registerables);

interface TidePoint {
  time: string;
  spx: number | null;
  ncp: number;
  npp: number;
  netVol: number;
}

const REFRESH_MS = 10000;
/** Le due aree del grafico partono dallo stesso x solo se gli assi laterali hanno la stessa larghezza. */
const LARGHEZZA_ASSE = 64;

const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
const ARANCIO = '#f97316';
const VIOLA = '#a855f7';

/** Una fotografia del profilo cumulato, valori nell'ordine di `strikes` (vedi /api/gex). */
interface SerieFrame {
  time: string;
  gex: number[];
  gexOi: number[];
}

interface ProfileRow {
  strike: number;
  gex: number;
  gexOi: number;
}

interface LivelliRange {
  basis: number;
  straddle: number;
  r1Up: number;
  r1Down: number;
}

type Straddle = 'nessuna' | 'cono' | 'breakeven';

/** Passo con cui /api/gex campiona la serie del profilo: il client la allunga allo stesso ritmo. */
const SERIE_STEP_SEC = 120;
/** Le "fette" del confronto: 10, 20 e 30 minuti fa. */
const FETTA_SEC = 600;
/** Ora (italiana) del breakeven dello straddle: quella del range OB, cioe' le 9:35 di New York. */
const ORA_STRADDLE = '15:35:00';
const CHIUSURA = '22:00:00';

function secondi(hhmmss: string): number {
  const [h, m, sec] = hhmmss.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
}

/** L'ultima fotografia non piu' recente di `limite` secondi. */
function frameAl(serie: SerieFrame[], limite: number): SerieFrame | null {
  for (let i = serie.length - 1; i >= 0; i--) if (secondi(serie[i].time) <= limite) return serie[i];
  return null;
}

/** -114.000.000 -> "-114M", 950.000 -> "950K", -1.024.000 -> "-1.0M". */
function compatto(v: number | null | undefined, decimaliM = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(decimaliM)}M`;
  if (a >= 1e3) return `${Math.round(v / 1e3)}K`;
  return `${Math.round(v)}`;
}

const fissaLarghezza = (s: Scale) => { s.width = LARGHEZZA_ASSE; };
/** Anche in altezza: profilo e premi devono avere l'area del grafico alla stessa quota. */
const ALTEZZA_ASSE_X = 24;
const fissaAltezza = (s: Scale) => { s.height = ALTEZZA_ASSE_X; };

/** Linea tratteggiata del prezzo corrente sul profilo, con l'etichetta a destra. */
const lineaSpot = {
  id: 'lineaSpot',
  afterDatasetsDraw(chart: ChartJS) {
    const spot = (chart.options.plugins as { lineaSpot?: { valore: number | null } }).lineaSpot?.valore;
    const y = chart.scales.y;
    if (spot == null || !y || spot < y.min || spot > y.max) return;
    const py = y.getPixelForValue(spot);
    const { left, right } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.9)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ROSSO;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(spot.toFixed(2), right, py - 4);
    ctx.restore();
  },
};

function Selettore<T extends string>({ titolo, valore, opzioni, onChange }: {
  titolo: string;
  valore: T;
  opzioni: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-slate-500">{titolo}</span>
      <div className="flex rounded-md overflow-hidden border border-slate-700">
        {opzioni.map(([v, etichetta]) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`px-2 py-0.5 ${valore === v ? 'bg-slate-700 text-white' : 'bg-slate-900 text-slate-400 hover:text-white'}`}
          >
            {etichetta}
          </button>
        ))}
      </div>
    </div>
  );
}
const lineaZero = (ctx: { tick?: { value: number } }) =>
  ctx.tick?.value === 0 ? 'rgba(148, 163, 184, 0.45)' : 'rgba(255, 255, 255, 0.04)';

export default function MarketTidePage() {
  const router = useRouter();
  const [autorizzato, setAutorizzato] = useState(false);
  const [points, setPoints] = useState<TidePoint[]>([]);
  const [caricato, setCaricato] = useState(false);
  const [indiceHover, setIndiceHover] = useState<number | null>(null);
  const [guidaAperta, setGuidaAperta] = useState(true);
  const [guidaGammaAperta, setGuidaGammaAperta] = useState(false);

  const [strikes, setStrikes] = useState<number[]>([]);
  const [serie, setSerie] = useState<SerieFrame[]>([]);
  const [profilo, setProfilo] = useState<ProfileRow[]>([]);
  const [spotGamma, setSpotGamma] = useState<{ time: string; price: number } | null>(null);
  const [base, setBase] = useState<'volume' | 'oi'>('volume');
  const [sogliaPct, setSogliaPct] = useState(25);
  const [semiAmpiezza, setSemiAmpiezza] = useState('60');
  const [straddle, setStraddle] = useState<Straddle>('breakeven');
  const [rangeOb, setRangeOb] = useState<LivelliRange | null>(null);

  const premiRef = useRef<HTMLCanvasElement | null>(null);
  const volumeRef = useRef<HTMLCanvasElement | null>(null);
  const chartPremi = useRef<ChartJS | null>(null);
  const chartVolume = useRef<ChartJS | null>(null);
  const profiloRef = useRef<HTMLCanvasElement | null>(null);
  const chartProfilo = useRef<ChartJS | null>(null);
  const ultimoGex = useRef<string | null>(null);
  const giornoGex = useRef<string | null>(null);
  const strikesRef = useRef<number[]>([]);
  const ultimoTempo = useRef<string | null>(null);
  const giorno = useRef<string | null>(null);

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
    else setAutorizzato(true);
  }, [router]);

  // Incrementale come le altre pagine: la prima volta tutta la giornata, poi
  // solo i punti dopo l'ultimo gia' in memoria.
  useEffect(() => {
    if (!autorizzato) return;
    const carica = async () => {
      try {
        const since = ultimoTempo.current;
        const res = await fetch(since ? `/api/market-tide?since=${since}` : '/api/market-tide', { cache: 'no-store' });
        if (!res.ok) return;
        const json: { date: string; points: TidePoint[] } = await res.json();
        if (giorno.current && json.date !== giorno.current) {
          giorno.current = json.date;
          ultimoTempo.current = null;
          setPoints([]);
          return;
        }
        giorno.current = json.date;
        if (json.points.length > 0) {
          ultimoTempo.current = json.points[json.points.length - 1].time;
          setPoints((prec) => (since ? [...prec, ...json.points] : json.points));
        }
      } catch (e) {
        console.error('Market tide fetch failed:', e);
      } finally {
        setCaricato(true);
      }
    };
    carica();
    const id = setInterval(carica, REFRESH_MS);
    return () => clearInterval(id);
  }, [autorizzato]);

  useEffect(() => {
    strikesRef.current = strikes;
  }, [strikes]);

  // Il profilo gamma, incrementale come la pagina GEX. Il caricamento intero
  // porta `strikes` e la serie; poi con `since` arriva solo il profilo di
  // adesso, e la serie la allunga il client una fotografia ogni due minuti.
  // Senza `since`, con Supabase attivo, ogni giro riscaricherebbe la sessione.
  useEffect(() => {
    if (!autorizzato) return;
    const carica = async () => {
      try {
        const since = ultimoGex.current;
        const q = new URLSearchParams({ flow: '0' });
        if (since) q.set('since', since);
        const res = await fetch(`/api/gex?${q}`, { cache: 'no-store' });
        if (!res.ok) return; // 503 = nessun gamma ancora, normale la mattina
        const json = await res.json();
        if (giornoGex.current && json.date !== giornoGex.current) {
          giornoGex.current = json.date;
          ultimoGex.current = null;
          setStrikes([]);
          setSerie([]);
          setProfilo([]);
          return;
        }
        giornoGex.current = json.date;
        if (json.lastTime) ultimoGex.current = json.lastTime;

        const spotIn: { time: string; price: number }[] = json.spot ?? [];
        const ultimoSpot = spotIn[spotIn.length - 1] ?? null;
        if (ultimoSpot) setSpotGamma(ultimoSpot);

        const profiloIn: ProfileRow[] = json.profile ?? [];
        if (profiloIn.length > 0) setProfilo(profiloIn);

        if (!since) {
          if (Array.isArray(json.strikes)) setStrikes(json.strikes);
          if (Array.isArray(json.serie)) setSerie(json.serie);
        } else if (ultimoSpot && profiloIn.length > 0) {
          setSerie((prec) => {
            const ultima = prec[prec.length - 1];
            if (ultima && secondi(ultimoSpot.time) - secondi(ultima.time) < SERIE_STEP_SEC) return prec;
            const ks = strikesRef.current;
            if (ks.length === 0) return prec;
            const mappa = new Map(profiloIn.map((r) => [r.strike, r]));
            return [...prec, {
              time: ultimoSpot.time,
              gex: ks.map((k) => Math.round(mappa.get(k)?.gex ?? 0)),
              gexOi: ks.map((k) => Math.round(mappa.get(k)?.gexOi ?? 0)),
            }];
          });
        }
      } catch (e) {
        console.error('Gamma fetch failed:', e);
      }
    };
    carica();
    const id = setInterval(carica, 30000);
    return () => clearInterval(id);
  }, [autorizzato]);

  // Lo straddle delle 15:35 lo calcola gia' /api/market (range OB). Si
  // chiede finche' non c'e', poi e' fisso per la giornata.
  useEffect(() => {
    if (!autorizzato || rangeOb) return;
    const carica = async () => {
      try {
        const res = await fetch('/api/market?history=true', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        if (json.range?.ob) setRangeOb(json.range.ob);
      } catch (e) {
        console.error('Range fetch failed:', e);
      }
    };
    carica();
    const id = setInterval(carica, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [autorizzato, rangeOb]);

  // I grafici si creano una volta; i dati si aggiornano in modo imperativo.
  useEffect(() => {
    if (!autorizzato || !premiRef.current || !volumeRef.current || !profiloRef.current) return;

    const asseX = {
      grid: { color: 'rgba(255, 255, 255, 0.04)' },
      ticks: {
        color: '#64748b',
        maxRotation: 0,
        autoSkipPadding: 30,
      },
    };

    chartPremi.current = new ChartJS(premiRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'SPX', data: [], yAxisID: 'ySpx', borderColor: GIALLO, borderWidth: 1.2, pointRadius: 0, tension: 0.2 },
          { label: 'Net Put Premium', data: [], yAxisID: 'yPremi', borderColor: ROSSO, borderWidth: 2.2, pointRadius: 0, tension: 0.2 },
          { label: 'Net Call Premium', data: [], yAxisID: 'yPremi', borderColor: VERDE, borderWidth: 2.2, pointRadius: 0, tension: 0.2 },
          { label: 'Straddle up', data: [], yAxisID: 'ySpx', borderColor: 'rgba(203, 213, 225, 0.6)', borderWidth: 1.2, borderDash: [6, 4], pointRadius: 0 },
          { label: 'Straddle down', data: [], yAxisID: 'ySpx', borderColor: 'rgba(203, 213, 225, 0.6)', borderWidth: 1.2, borderDash: [6, 4], pointRadius: 0 },
        ],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { ...asseX, afterFit: fissaAltezza, ticks: { ...asseX.ticks, display: false } },
          ySpx: {
            position: 'left',
            afterFit: fissaLarghezza,
            grid: { display: false },
            ticks: { color: '#94a3b8' },
          },
          yPremi: {
            position: 'right',
            afterFit: fissaLarghezza,
            grid: { color: lineaZero },
            ticks: { color: '#94a3b8', callback: (v) => compatto(Number(v)) },
          },
        },
      },
    });

    chartVolume.current = new ChartJS(volumeRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Net Volume',
          data: [],
          yAxisID: 'yVol',
          borderColor: 'rgba(148, 163, 184, 0.6)',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.2,
          fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.75)', below: 'rgba(244, 63, 94, 0.85)' },
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: asseX,
          // Asse muto a sinistra: tiene l'area allineata a quella dei premi.
          yVuoto: { position: 'left', afterFit: fissaLarghezza, grid: { display: false }, ticks: { display: false }, border: { display: false } },
          yVol: {
            position: 'right',
            afterFit: fissaLarghezza,
            grid: { color: lineaZero },
            ticks: { color: '#94a3b8', callback: (v) => compatto(Number(v), 1) },
          },
        },
      },
    });

    chartProfilo.current = new ChartJS(profiloRef.current, {
      type: 'bar',
      data: {
        datasets: [
          // `order` basso = disegnato sopra: i pallini stanno sopra le barre.
          { type: 'scatter', label: '30 min fa', data: [], pointRadius: 3, backgroundColor: 'rgba(148, 163, 184, 0.35)', order: 1 },
          { type: 'scatter', label: '20 min fa', data: [], pointRadius: 3, backgroundColor: 'rgba(148, 163, 184, 0.6)', order: 1 },
          { type: 'scatter', label: '10 min fa', data: [], pointRadius: 3.5, backgroundColor: '#f8fafc', order: 0 },
          { type: 'bar', label: 'Adesso', data: [], backgroundColor: [], categoryPercentage: 0.9, barPercentage: 0.85, order: 2 },
        ],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `Strike ${items[0]?.parsed.y ?? ''}`,
              label: (item) => `${item.dataset.label}: ${compatto(item.parsed.x)} $M`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            afterFit: fissaAltezza,
            grid: { color: lineaZero },
            ticks: { color: '#64748b', maxTicksLimit: 4, callback: (v) => compatto(Number(v)) },
          },
          y: {
            type: 'linear',
            position: 'left',
            afterFit: fissaLarghezza,
            grid: { color: 'rgba(255, 255, 255, 0.04)' },
            ticks: { color: '#94a3b8', stepSize: 10 },
          },
        },
      },
      plugins: [lineaSpot],
    });

    // Il cursore su uno dei due grafici guida l'intestazione e la linea
    // verticale su entrambi, come nell'originale.
    const canvases = [premiRef.current, volumeRef.current];
    const charts = [chartPremi.current, chartVolume.current];
    const muovi = (i: number) => (evt: MouseEvent) => {
      const el = charts[i].getElementsAtEventForMode(evt, 'index', { intersect: false }, false)[0];
      setIndiceHover(el ? el.index : null);
    };
    const esci = () => setIndiceHover(null);
    const handlers = canvases.map((c, i) => {
      const h = muovi(i);
      c.addEventListener('mousemove', h);
      c.addEventListener('mouseleave', esci);
      return h;
    });

    return () => {
      canvases.forEach((c, i) => {
        c.removeEventListener('mousemove', handlers[i]);
        c.removeEventListener('mouseleave', esci);
      });
      chartPremi.current?.destroy();
      chartVolume.current?.destroy();
      chartProfilo.current?.destroy();
      chartPremi.current = null;
      chartVolume.current = null;
      chartProfilo.current = null;
    };
  }, [autorizzato]);

  /** SPX in termini di cash: i livelli del range sono in ES, si toglie la base. */
  const breakeven = useMemo(() => {
    if (!rangeOb) return null;
    const up = rangeOb.r1Up - rangeOb.basis;
    const down = rangeOb.r1Down - rangeOb.basis;
    return { up, down, spot: (up + down) / 2 };
  }, [rangeOb]);

  /**
   * La scala dei prezzi, una sola per il profilo e per la linea dell'SPX: cosi'
   * uno strike sta alla stessa altezza del prezzo che lo tocca. Copre il
   * percorso dell'SPX e almeno `semiAmpiezza` punti attorno all'ultimo prezzo,
   * piu' i breakeven quando si mostrano.
   */
  const scalaPrezzi = useMemo(() => {
    const valori: number[] = [];
    for (const p of points) if (p.spx != null) valori.push(p.spx);
    const ultimo = spotGamma?.price ?? valori[valori.length - 1];
    if (ultimo == null) return null;
    const semi = Number(semiAmpiezza);
    valori.push(ultimo - semi, ultimo + semi);
    if (breakeven && straddle !== 'nessuna') valori.push(breakeven.up, breakeven.down);
    const min = valori.reduce((a, b) => Math.min(a, b));
    const max = valori.reduce((a, b) => Math.max(a, b));
    return { min: Math.floor((min - 5) / 5) * 5, max: Math.ceil((max + 5) / 5) * 5 };
  }, [points, spotGamma, semiAmpiezza, breakeven, straddle]);

  useEffect(() => {
    const cp = chartPremi.current;
    const cv = chartVolume.current;
    if (!cp || !cv) return;
    const labels = points.map((p) => p.time.slice(0, 5));
    cp.data.labels = labels;
    (cp.data.datasets[0] as ChartDataset<'line'>).data = points.map((p) => p.spx);
    (cp.data.datasets[1] as ChartDataset<'line'>).data = points.map((p) => p.npp);
    (cp.data.datasets[2] as ChartDataset<'line'>).data = points.map((p) => p.ncp);
    cv.data.labels = labels;
    (cv.data.datasets[0] as ChartDataset<'line'>).data = points.map((p) => p.netVol);

    // Straddle: il cono parte dal prezzo delle 15:35 e arriva ai breakeven
    // alla chiusura; i breakeven sono le stesse due quote, piatte.
    const livello = (verso: 'up' | 'down') => points.map((p) => {
      if (!breakeven || straddle === 'nessuna' || p.time < ORA_STRADDLE) return null;
      const arrivo = breakeven[verso];
      if (straddle === 'breakeven') return arrivo;
      const quota = (secondi(p.time) - secondi(ORA_STRADDLE)) / (secondi(CHIUSURA) - secondi(ORA_STRADDLE));
      return breakeven.spot + (arrivo - breakeven.spot) * Math.min(1, quota);
    });
    (cp.data.datasets[3] as ChartDataset<'line'>).data = livello('up');
    (cp.data.datasets[4] as ChartDataset<'line'>).data = livello('down');

    const ySpx = cp.options.scales?.ySpx;
    if (ySpx && scalaPrezzi) {
      ySpx.min = scalaPrezzi.min;
      ySpx.max = scalaPrezzi.max;
    }
    cp.update('none');
    cv.update('none');
  }, [points, breakeven, straddle, scalaPrezzi]);

  // Il profilo gamma: barre di adesso, pallini delle fette precedenti.
  useEffect(() => {
    const c = chartProfilo.current;
    if (!c) return;
    const chiave = base === 'oi' ? 'gexOi' : 'gex';
    const mappa = new Map(profilo.map((r) => [r.strike, r[chiave]]));
    const ks = strikes.length > 0 ? strikes : profilo.map((r) => r.strike);
    const adesso = spotGamma ? secondi(spotGamma.time) : null;
    const fetta = (n: number) => {
      if (adesso == null) return null;
      const f = frameAl(serie, adesso - n * FETTA_SEC);
      return f ? f[chiave] : null;
    };
    const f10 = fetta(1);
    const f20 = fetta(2);
    const f30 = fetta(3);
    const massimo = ks.reduce((m, k) => Math.max(m, Math.abs(mappa.get(k) ?? 0)), 0);
    const soglia = massimo * (sogliaPct / 100);

    // Arancio: il segno e' cambiato rispetto a 10 minuti fa. Viola: e' cambiato
    // il valore, oltre la soglia. Altrimenti verde positivo, rosso negativo.
    const colori = ks.map((k, i) => {
      const v = mappa.get(k) ?? 0;
      const prima = f10?.[i];
      if (prima != null && prima !== 0 && v !== 0 && Math.sign(prima) !== Math.sign(v)) return ARANCIO;
      if (prima != null && soglia > 0 && Math.abs(v - prima) >= soglia) return VIOLA;
      return v >= 0 ? VERDE : ROSSO;
    });
    const pallini = (f: number[] | null) => (f ? ks.map((k, i) => ({ x: f[i] ?? 0, y: k })) : []);

    c.data.datasets[0].data = pallini(f30);
    c.data.datasets[1].data = pallini(f20);
    c.data.datasets[2].data = pallini(f10);
    c.data.datasets[3].data = ks.map((k) => ({ x: mappa.get(k) ?? 0, y: k }));
    (c.data.datasets[3] as ChartDataset<'bar'>).backgroundColor = colori;
    (c.options.plugins as { lineaSpot?: { valore: number | null } }).lineaSpot = { valore: spotGamma?.price ?? null };
    const y = c.options.scales?.y;
    if (y && scalaPrezzi) {
      y.min = scalaPrezzi.min;
      y.max = scalaPrezzi.max;
    }
    c.update('none');
  }, [profilo, serie, strikes, base, sogliaPct, spotGamma, scalaPrezzi]);

  // Linea verticale del cursore, disegnata su entrambi i grafici.
  useEffect(() => {
    for (const c of [chartPremi.current, chartVolume.current]) {
      if (!c) continue;
      const attivi = indiceHover == null ? [] : c.data.datasets.map((_, datasetIndex) => ({ datasetIndex, index: indiceHover }));
      c.setActiveElements(attivi);
      c.update('none');
    }
  }, [indiceHover]);

  if (!autorizzato) return null;

  const corrente = indiceHover != null ? points[indiceHover] : points[points.length - 1];

  return (
    <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Market Tide</h1>
            <p className="text-xs text-slate-500">SPX 0DTE · premio e volume netti, lato ask meno lato bid · solo locale</p>
          </div>
          <button
            onClick={() => router.push('/market')}
            className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            ← CHART
          </button>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111216] p-3 md:p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm font-semibold mb-2 tabular-nums">
            <span className="text-white">{corrente?.time.slice(0, 5) ?? '--:--'}</span>
            <span className="text-slate-400">SPX: <span className="text-white">{corrente?.spx?.toFixed(2) ?? '—'}</span> <span style={{ color: GIALLO }}>●</span></span>
            <span className="text-slate-400">Vol: <span className="text-white">{compatto(corrente?.netVol, 1)}</span> <span style={{ color: (corrente?.netVol ?? 0) >= 0 ? VERDE : ROSSO }}>●</span></span>
            <span className="text-slate-400">NPP: <span className="text-white">{compatto(corrente?.npp)}</span> <span style={{ color: ROSSO }}>●</span></span>
            <span className="text-slate-400">NCP: <span className="text-white">{compatto(corrente?.ncp)}</span> <span style={{ color: VERDE }}>●</span></span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2 text-xs">
            <Selettore
              titolo="Gamma"
              valore={base}
              opzioni={[['volume', 'Volume'], ['oi', 'Open Int.']]}
              onChange={setBase}
            />
            <Selettore
              titolo="Straddle"
              valore={straddle}
              opzioni={[['nessuna', 'Nessuna'], ['cono', 'Cono'], ['breakeven', 'Breakeven']]}
              onChange={setStraddle}
            />
            <Selettore
              titolo="Scala"
              valore={semiAmpiezza}
              opzioni={[['30', '±30'], ['60', '±60'], ['100', '±100']]}
              onChange={setSemiAmpiezza}
            />
            <label className="flex items-center gap-1.5 text-slate-400" title="Barra viola: variazione rispetto a 10 minuti fa oltre questa quota della barra piu' grande">
              Soglia viola
              <input
                type="number"
                min={5}
                max={100}
                step={5}
                value={sogliaPct}
                onChange={(e) => setSogliaPct(Math.max(1, Number(e.target.value) || 25))}
                className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-200"
              />
              %
            </label>
            {straddle !== 'nessuna' && !breakeven && (
              <span className="text-slate-500">straddle disponibile dopo le 15:35</span>
            )}
          </div>

          <div className="flex text-xs font-semibold text-slate-300 mt-1">
            <div className="w-[240px] md:w-[300px] shrink-0">Gamma per strike ($M)</div>
            <div>Net Premiums</div>
          </div>
          <div className="flex h-[380px] md:h-[480px]">
            <div className="relative w-[240px] md:w-[300px] shrink-0">
              <canvas ref={profiloRef} />
            </div>
            <div className="relative flex-1 min-w-0">
              <canvas ref={premiRef} />
            {caricato && points.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-slate-500 px-6">
                Nessun dato di oggi. Il tide lo calcola il poller dei volumi (13:30–22:00) e parte dal suo ultimo riavvio;
                su Vercel non c&apos;è, perché il dato resta nel file locale.
              </div>
            )}
            </div>
          </div>
          <div className="flex text-xs font-semibold text-slate-300 mt-2">
            <div className="w-[240px] md:w-[300px] shrink-0" />
            <div>Net Volume</div>
          </div>
          <div className="flex h-[150px] md:h-[180px]">
            <div className="w-[240px] md:w-[300px] shrink-0" />
            <div className="relative flex-1 min-w-0">
              <canvas ref={volumeRef} />
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-800 bg-[#111216]">
          <button
            onClick={() => setGuidaAperta((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-bold text-white"
          >
            Guida al Market Tide giornaliero
            <span className="text-slate-500">{guidaAperta ? '−' : '+'}</span>
          </button>
          {guidaAperta && (
            <div className="px-4 pb-4 text-sm leading-relaxed text-slate-400 space-y-3 max-w-[900px]">
              <p>
                Questo indicatore mostra il premio e il volume aggregati delle opzioni scambiate nella giornata. I valori
                si ottengono prendendo il controvalore delle opzioni eseguite all&apos;ask o vicino all&apos;ask e
                sottraendo quello delle opzioni eseguite al bid o vicino al bid.
              </p>
              <p>
                Se ci sono $15.000 di call eseguite all&apos;ask e $10.000 di call eseguite al bid, il premio aggregato
                delle call è $15.000 − $10.000 = <span className="text-white">$5.000</span>.
              </p>
              <p>
                Se ci sono $10.000 di put eseguite all&apos;ask e $20.000 di put eseguite al bid, il premio aggregato delle
                put è $10.000 − $20.000 = <span className="text-white">−$10.000</span>.
              </p>
              <p>
                Più call comprate all&apos;ask si possono leggere come un segnale rialzista, più put comprate all&apos;ask
                come un segnale ribassista.
              </p>
              <p>
                Se le due linee sono vicine, il sentiment rialzista e quello ribassista più o meno si equivalgono. Se non
                si muovono in parallelo, vuol dire che il sentiment sul mercato delle opzioni sta diventando sempre più
                rialzista o sempre più ribassista.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <div className="font-semibold text-emerald-400 mb-1">Sempre più rialzista se</div>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>il premio aggregato delle call sale più velocemente;</li>
                    <li>il premio aggregato delle put scende più velocemente.</li>
                  </ol>
                </div>
                <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                  <div className="font-semibold text-rose-400 mb-1">Sempre più ribassista se</div>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>il premio aggregato delle call scende più velocemente;</li>
                    <li>il premio aggregato delle put sale più velocemente.</li>
                  </ol>
                </div>
              </div>
              <p>
                Il volume è il volume aggregato delle call (calcolato come il premio delle call) meno il volume aggregato
                delle put.
              </p>
              <p>
                Per esempio: se all&apos;ask sono state eseguite 10.000 call in più che al bid, e 5.000 put in più all&apos;ask
                che al bid, il volume aggregato è 10.000 − 5.000 = <span className="text-white">5.000</span>, cioè 5.000
                contratti rialzisti in più di quelli ribassisti. Però non tutte le opzioni hanno lo stesso prezzo, quindi il
                volume va sempre letto insieme al premio.
              </p>
              <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-400">
                <div className="font-semibold text-slate-300 mb-1">Come è calcolato qui</div>
                Non è tutto il mercato come su Unusual Whales: è la catena SPX 0DTE che segue il poller dei volumi (37 strike
                attorno all&apos;ATM, call e put). IBKR non manda ogni trade con il suo lato, quindi quando il volume di un
                contratto sale i contratti in più si attribuiscono confrontando l&apos;ultimo prezzo con bid e ask di quel
                momento: oltre il 60% dello spread verso l&apos;ask contano come comprati, sotto il 40% come venduti, in mezzo
                non contano. Premio = contratti × prezzo × 100. I contratti scambiati mentre il poller è fermo restano fuori.
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-slate-800 bg-[#111216]">
          <button
            onClick={() => setGuidaGammaAperta((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-bold text-white"
          >
            Guida al profilo gamma
            <span className="text-slate-500">{guidaGammaAperta ? '−' : '+'}</span>
          </button>
          {guidaGammaAperta && (
            <div className="px-4 pb-4 text-sm leading-relaxed text-slate-400 space-y-3 max-w-[900px]">
              <h3 className="font-semibold text-slate-200">Cosa rappresentano le barre del gamma?</h3>
              <p>
                Ogni barra del profilo rappresenta l&apos;esposizione gamma netta dei Market Maker su quello strike.
              </p>
              <p>
                Se è negativa (<span style={{ color: ROSSO }}>rossa</span>, verso sinistra) i Market Maker sono net short
                gamma su quello strike; se è positiva (<span style={{ color: VERDE }}>verde</span>, verso destra) sono net
                long gamma.
              </p>
              <p>
                Una barra <span style={{ color: ARANCIO }}>arancione</span> indica che il gamma ha cambiato segno, da
                positivo a negativo o viceversa, rispetto alla fetta di 10 minuti prima.
              </p>
              <p>
                Una barra <span style={{ color: VIOLA }}>viola</span> indica che, rispetto alla fetta di 10 minuti prima, il
                gamma è salito o sceso oltre la soglia impostata (&quot;Soglia viola&quot;).
              </p>

              <h3 className="font-semibold text-slate-200 pt-1">Cosa rappresentano i pallini?</h3>
              <p>
                Ogni pallino è il valore della barra in una fetta precedente: quello bianco è di 10 minuti fa, quelli grigi
                di 20 e 30 minuti fa. Così si vede a colpo d&apos;occhio come cambia l&apos;esposizione netta dei Market
                Maker durante la giornata.
              </p>

              <h3 className="font-semibold text-slate-200 pt-1">Cosa rappresentano le linee dello straddle?</h3>
              <p>
                All&apos;apertura si calcola il prezzo teorico dello straddle SPX 0DTE (la call e la put ATM più vicine) e
                se ne ricavano i prezzi di breakeven, che si possono mostrare in tre modi:
              </p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li><span className="text-slate-200">Nessuna</span>: nessuna linea dello straddle;</li>
                <li><span className="text-slate-200">Cono</span>: linee diagonali dal prezzo e dall&apos;ora del calcolo fino ai breakeven alla chiusura;</li>
                <li><span className="text-slate-200">Breakeven</span>: linee orizzontali ai prezzi di breakeven.</li>
              </ul>

              <h3 className="font-semibold text-slate-200 pt-1">Gamma netto negativo</h3>
              <p>
                Gamma netto negativo vuol dire che i Market Maker sono net short di opzioni su quello strike. Questo{' '}
                <span className="text-white">non</span> significa che le loro controparti, che d&apos;ora in poi chiamiamo
                &quot;clienti&quot;, siano rialziste o ribassiste. Vale la pena rileggerlo un paio di volte, perché è il
                concetto fondamentale.
              </p>
              <p>
                Se i clienti sono compratori netti di opzioni, i Market Maker ne sono venditori netti. Che siano put o call
                non conta.
              </p>
              <p>
                Se un cliente compra una put da un Market Maker, siccome il gamma di una put comprata è positivo, il cliente
                ha una posizione a gamma positivo. Il Market Maker ha venduto quella put, quindi ha una posizione a gamma
                negativo. Anche il gamma di una call comprata è positivo, quindi un cliente che compra una call da un Market
                Maker gli lascia la stessa posizione a gamma negativo.
              </p>
              <p>
                In sintesi: se i clienti comprano opzioni (put o call), il Market Maker dall&apos;altra parte ha
                un&apos;esposizione gamma negativa.
              </p>

              <h3 className="font-semibold text-slate-200 pt-1">Gamma netto positivo</h3>
              <p>
                Gamma netto positivo vuol dire che i Market Maker sono net long di opzioni su quello strike. Come nel caso
                negativo, non indica se i clienti siano rialzisti o ribassisti. Anche qui put o call non contano: quando i
                clienti vendono put, o vendono call, il Market Maker si ritrova con gamma positivo.
              </p>

              <h3 className="font-semibold text-slate-200 pt-1">Una nota sulla moneyness</h3>
              <p>Su SPX (e SPXW) si scambia soprattutto out of the money (OTM).</p>

              <h3 className="font-semibold text-slate-200 pt-1">Il profilo non si muove?</h3>
              <p>
                L&apos;indice SPX è calcolato solo durante la sessione cash, dalle 15:30 alle 22:00 italiane. Le opzioni SPX
                si scambiano anche di notte, ma con volumi minimi rispetto alla sessione cash, quindi le barre difficilmente
                cambiano in modo visibile.
              </p>

              <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-400">
                <div className="font-semibold text-slate-300 mb-1">Come è calcolato qui</div>
                Non è il posizionamento verificato dei Market Maker che Unusual Whales ottiene dalle borse. Il gamma arriva
                dai modelGreeks IBKR sulla catena SPX 0DTE (37 strike) ed è lo stesso di /spx-gamma: il segno usa la
                convenzione classica &quot;dealer lunghi di call, corti di put&quot; (call positive, put negative), che è
                un&apos;ipotesi e non un dato osservato. &quot;Volume&quot; pesa il gamma sui contratti scambiati oggi,
                &quot;Open Int.&quot; sull&apos;open interest della chiusura precedente. Le fette sono le fotografie del
                profilo prese ogni 2 minuti; lo straddle è quello del Range Calc alle 15:35 italiane (9:35 a New York), non
                alle 9:31.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
