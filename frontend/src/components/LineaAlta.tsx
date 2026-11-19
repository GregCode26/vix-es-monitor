'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Chart as ChartJS, LineController, LineElement, PointElement, LinearScale, Tooltip, Legend,
  ScatterController, type ChartConfiguration,
} from 'chart.js';
import { chiaveOggi } from '@/lib/giornoRichiesto';

/**
 * Pagina di verifica (12/11/2026) di un'ipotesi dell'utente sulla Serie Temporale di /hedging-pressure:
 * la linea piu' in alto (pressione massima fra i top strike); strike SOPRA l'ATM -> la linea che sale
 * anticipa ES che sale, SOTTO l'ATM -> al contrario. Segnale = segno(variazione su K min) x lato.
 *
 * Nella route la pressione e' gex x (spot - spot di apertura) x vicinanza: la linea contiene il prezzo.
 * Per questo il riquadro confronta sempre con il semplice momentum di ES sugli stessi K minuti.
 * Lo studio su piu' giorni e' `execution/studio_linea_alta.py`.
 */

ChartJS.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, ScatterController);

/**
 * Ogni 10 s, il passo del poller volumi (dal 19/11/2026; era 60 s). Il grafico usa ogni snapshot, la
 * tabella resta al minuto come lo studio. La parte di sessione prima dell'apertura della pagina resta
 * al minuto: la route manda la storia campionata cosi'.
 */
const REFRESH_MS = 10_000;
const ORIZZONTI = [1, 3, 5, 10];
const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
/**
 * La linea di ES cambia colore quando cambia lo strike della linea piu' alta: un colore per strike
 * (in ordine di strike nel giorno), senza il verde e il rosso della linea della pressione.
 */
const COLORI_STRIKE = ['#facc15', '#60a5fa', '#f472b6', '#22d3ee', '#fb923c', '#a78bfa', '#e2e8f0', '#a3e635', '#fde68a', '#2563eb', '#e879f9', '#14b8a6'];

/** Dove cambia lo strike: dati per le etichette disegnate sopra ES. */
type Cambio = { x: number; y: number; da: number; a: number; colore: string };

type Punto = { time: string; strike: number; totalPressure: number };
type RispostaHp = { date: string; storia?: Punto[]; pressureHistory?: Punto[]; error?: string };
type PuntoMkt = { time: string; esf: number | null; spx: number | null };

const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const hhmm = (minuti: number) => `${String(Math.floor(minuti / 60)).padStart(2, '0')}:${String(Math.round(minuti % 60)).padStart(2, '0')}`;
const segno = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Il valore della serie (ordinata per secondi) piu' vicino a t, entro `tol` secondi. */
function valoreA(serie: [number, number][], t: number, tol = 45): number | null {
  let lo = 0, hi = serie.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (serie[m][0] < t) lo = m + 1; else hi = m; }
  let migliore: [number, number] | null = null;
  for (const k of [lo - 1, lo]) {
    const p = serie[k];
    if (p && Math.abs(p[0] - t) <= tol && (!migliore || Math.abs(p[0] - t) < Math.abs(migliore[0] - t))) migliore = p;
  }
  return migliore ? migliore[1] : null;
}

/** Apertura e chiusura del cash (9:30-16:00 NY) in secondi dell'ora di Roma di quel giorno. */
function finestraCash(giorno: string): [number, number] {
  const scarto = (tz: string, d: Date) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000;
  };
  const [y, m, d] = giorno.split('-').map(Number);
  const mezzogiorno = new Date(Date.UTC(y, m - 1, d, 12));
  const diff = scarto('Europe/Rome', mezzogiorno) - scarto('America/New_York', mezzogiorno);
  return [(9 * 60 + 30 + diff) * 60, (16 * 60 + diff) * 60];
}

interface Minuto { t: number; strike: number; p: number; lato: 1 | -1; es: number }
interface Evento { t: number; seg: number; mom: number; lato: number; fut: Record<number, number> }

function statistica(xs: number[]) {
  if (xs.length === 0) return null;
  const media = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, giusti: xs.filter((x) => x > 0).length / xs.length, media };
}

/** `incorporata`: dentro /hedging-pressure (vista "Linea Alta"), senza i bottoni di navigazione. */
export default function LineaAlta({ incorporata = false }: { incorporata?: boolean }) {
  const router = useRouter();
  const autorizzato = useSyncExternalStore(() => () => {}, () => localStorage.getItem('market_auth') === 'true', () => false);
  const [giorno, setGiorno] = useState(() => chiaveOggi());
  const [k, setK] = useState(2);
  // `hp`: l'ultimo valore di ogni minuto (tabella e frecce, come lo studio); `hp10`: ogni snapshot (grafico).
  const [hp, setHp] = useState<Map<number, Map<number, number>>>(new Map());
  const [hp10, setHp10] = useState<Map<number, Map<number, number>>>(new Map());
  const [mkt, setMkt] = useState<PuntoMkt[]>([]);
  const [errore, setErrore] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const grafico = useRef<ChartJS | null>(null);
  const [pronto, setPronto] = useState(false);
  const cambi = useRef<Cambio[]>([]);
  /** Posizione del mouse sul grafico, in pixel, per il mirino. */
  const mirino = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
  }, [router]);

  // Dati: la storia della pressione e di ES una volta, poi per oggi ogni 10 s l'ultimo minuto di
  // pressione (gli ultimi snapshot a 10 s) e l'ultimo punto di ES, senza riscaricare la giornata.
  useEffect(() => {
    let vivo = true;
    const oggi = giorno === chiaveOggi();
    const q = oggi ? '' : `&date=${giorno}`;
    const perStrike = new Map<number, Map<number, number>>();
    const perStrike10 = new Map<number, Map<number, number>>();
    const metti = (mappa: Map<number, Map<number, number>>, strike: number, t: number, v: number) => {
      if (!mappa.has(strike)) mappa.set(strike, new Map());
      mappa.get(strike)!.set(t, v);
    };
    const unisci = (punti: Punto[]) => {
      for (const p of punti) {
        const s = sec(p.time);
        metti(perStrike, p.strike, Math.floor(s / 60) * 60, p.totalPressure); // l'ultimo valore del minuto
        metti(perStrike10, p.strike, s, p.totalPressure);
      }
      setHp(new Map(perStrike));
      setHp10(new Map(perStrike10));
    };
    const carica = async (conStoria: boolean) => {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`/api/hedging-pressure?${conStoria ? 'storia=1' : ''}${q}`),
          fetch(conStoria ? `/api/market?history=true${q}` : '/api/market'),
        ]);
        const j1: RispostaHp = await r1.json();
        const j2 = await r2.json();
        if (!vivo) return;
        if (!r1.ok) { setErrore(j1.error ?? `hedging-pressure ${r1.status}`); return; }
        setErrore(null);
        unisci([...(j1.storia ?? []), ...(j1.pressureHistory ?? [])]);
        if (conStoria) setMkt((j2.history ?? []) as PuntoMkt[]);
        else if (r2.ok && j2.sourceTime) {
          const nuovo: PuntoMkt = { time: j2.sourceTime, esf: j2.esf ?? null, spx: j2.spx ?? null };
          setMkt((prec) => (prec.length && prec[prec.length - 1].time >= nuovo.time ? prec : [...prec, nuovo]));
        }
      } catch (e) {
        if (vivo) setErrore(e instanceof Error ? e.message : 'errore');
      }
    };
    setHp(new Map());
    setHp10(new Map());
    setMkt([]);
    carica(true);
    const id = oggi ? setInterval(() => carica(false), REFRESH_MS) : null;
    return () => { vivo = false; if (id) clearInterval(id); };
  }, [giorno]);

  // Lo strike con la pressione piu' alta a ogni istante di `mappa`, il suo lato rispetto a SPX, ES.
  // Al minuto (`hp`) per la tabella e le frecce, a ogni snapshot (`hp10`) per il grafico.
  const { eventi, punti, es } = useMemo(() => {
    const es: [number, number][] = mkt.filter((p) => p.esf).map((p) => [sec(p.time), p.esf!] as [number, number]).sort((a, b) => a[0] - b[0]);
    const spx: [number, number][] = mkt.filter((p) => p.spx).map((p) => [sec(p.time), p.spx!] as [number, number]).sort((a, b) => a[0] - b[0]);
    const [apre, chiude] = finestraCash(giorno);
    const lineaAlta = (mappa: Map<number, Map<number, number>>): Minuto[] => {
      const tempi = [...new Set([...mappa.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
      const out: Minuto[] = [];
      for (const t of tempi) {
        if (t < apre || t > chiude) continue;
        let alto: number | null = null, pAlto = -Infinity;
        for (const [strike, m] of mappa) {
          const v = m.get(t);
          if (v != null && v > pAlto) { pAlto = v; alto = strike; }
        }
        const s0 = valoreA(spx, t), e0 = valoreA(es, t);
        if (alto == null || s0 == null || e0 == null) continue;
        out.push({ t, strike: alto, p: pAlto, lato: alto > s0 ? 1 : -1, es: e0 });
      }
      return out;
    };
    const minuti = lineaAlta(hp);
    const punti = lineaAlta(hp10);
    const eventi: Evento[] = [];
    for (const { t, strike: alto, p: pAlto, lato, es: e0 } of minuti) {
      if (t < apre + 5 * 60 || t > chiude - 10 * 60) continue;
      const prima = hp.get(alto)!.get(t - k * 60);
      const ep = valoreA(es, t - k * 60);
      if (prima == null || ep == null || pAlto === prima) continue;
      const fut: Record<number, number> = {};
      for (const h of ORIZZONTI) { const eh = valoreA(es, t + h * 60); if (eh != null) fut[h] = eh - e0; }
      eventi.push({ t, seg: segno(pAlto - prima) * lato, mom: segno(e0 - ep), lato, fut });
    }
    return { eventi, punti, es };
  }, [hp, hp10, mkt, giorno, k]);

  const tabella = useMemo(() => {
    const righe: { nome: string; per: (ReturnType<typeof statistica>)[] }[] = [];
    const conMom = eventi.filter((e) => e.mom !== 0);
    const gruppi: [string, Evento[], (e: Evento) => number][] = [
      ['Regola (tutti i minuti)', eventi, (e) => e.seg],
      ['  linea sopra l\'ATM', eventi.filter((e) => e.lato > 0), (e) => e.seg],
      ['  linea sotto l\'ATM', eventi.filter((e) => e.lato < 0), (e) => e.seg],
      ['Solo momentum ES (confronto)', conMom, (e) => e.mom],
      ['Regola quando discorda dal momentum', conMom.filter((e) => e.seg !== e.mom), (e) => e.seg],
    ];
    for (const [nome, evs, dir] of gruppi) {
      righe.push({ nome, per: ORIZZONTI.map((h) => statistica(evs.filter((e) => h in e.fut).map((e) => dir(e) * e.fut[h]))) });
    }
    const concorda = conMom.length ? conMom.filter((e) => e.seg === e.mom).length / conMom.length : null;
    return { righe, concorda };
  }, [eventi]);

  // Grafico: creato una volta, poi aggiornato senza toccare lo zoom.
  useEffect(() => {
    if (!canvas.current || grafico.current) return;
    let annullato = false;
    (async () => {
      const zoom = (await import('chartjs-plugin-zoom')).default;
      ChartJS.register(zoom);
      if (annullato || !canvas.current) return;
      const config: ChartConfiguration<'line'> = {
        type: 'line',
        data: { datasets: [] },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: {
            x: { type: 'linear', ticks: { color: '#94a3b8', callback: (v) => hhmm(Number(v)) }, grid: { color: 'rgba(51,65,85,0.25)' } },
            y: { position: 'left', title: { display: true, text: 'Pressione linea piu\' alta', color: '#cbd5e1' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.25)' } },
            es: { position: 'right', title: { display: true, text: 'ES (colore = strike della linea piu alta)', color: '#cbd5e1' }, ticks: { color: '#cbd5e1' }, grid: { display: false } },
          },
          plugins: {
            legend: { display: false },
            // Niente riquadro dei valori: bastano il mirino e i valori sugli assi.
            tooltip: { enabled: false },
            zoom: {
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
              pan: { enabled: true, mode: 'x' },
            },
          },
        },
      };
      // Le etichette dei cambi di strike sopra ES; saltate se troppo vicine alla precedente.
      config.plugins = [{
        id: 'etichetteStrike',
        afterDatasetsDraw: (chart) => {
          const sx = chart.scales.x, sy = chart.scales.es;
          // Con "Cambio strike" (dataset 4) spento dalla legenda spariscono anche le etichette.
          if (!sx || !sy || chart.data.datasets.length < 5 || !chart.isDatasetVisible(4)) return;
          const c = chart.ctx;
          c.save();
          c.font = 'bold 10px sans-serif';
          c.textAlign = 'center';
          let ultimaX = -Infinity;
          for (const k of cambi.current) {
            const px = sx.getPixelForValue(k.x), py = sy.getPixelForValue(k.y);
            if (px < chart.chartArea.left || px > chart.chartArea.right || px - ultimaX < 38) continue;
            ultimaX = px;
            c.fillStyle = k.colore;
            c.fillText(`${k.a}`, px, Math.max(chart.chartArea.top + 10, py - 10));
          }
          c.restore();
        },
      }, {
        // Mirino a croce sotto il mouse, con i valori scritti sugli assi: orario in basso,
        // pressione a sinistra, ES a destra (come /iv-monitor).
        id: 'mirino',
        afterEvent: (chart, args) => {
          const e = args.event, a = chart.chartArea;
          const dentro = e.type !== 'mouseout' && e.x != null && e.y != null && e.x >= a.left && e.x <= a.right && e.y >= a.top && e.y <= a.bottom;
          const prima = mirino.current;
          mirino.current = dentro ? { x: e.x!, y: e.y! } : null;
          if (dentro || prima) args.changed = true;
        },
        afterDraw: (chart) => {
          const m = mirino.current;
          const { ctx, chartArea: a, scales } = chart;
          if (!m || !scales.x) return;
          ctx.save();
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(m.x, a.top); ctx.lineTo(m.x, a.bottom);
          ctx.moveTo(a.left, m.y); ctx.lineTo(a.right, m.y);
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
          const larghezza = (testo: string) => ctx.measureText(testo).width + 8;
          const minuti = scales.x.getValueForPixel(m.x);
          if (minuti != null) {
            const s = Math.round(minuti * 60);
            etichetta(`${hhmm(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`, m.x, a.bottom + 9);
          }
          const p = scales.y?.getValueForPixel(m.y);
          if (p != null) { const t = p.toFixed(1); etichetta(t, Math.max(a.left - larghezza(t) / 2, larghezza(t) / 2), m.y); }
          const v = scales.es?.getValueForPixel(m.y);
          if (v != null) { const t = v.toFixed(2); etichetta(t, a.right + larghezza(t) / 2, m.y); }
          ctx.restore();
        },
      }];
      grafico.current = new ChartJS(canvas.current, config);
      setPronto(true);
    })();
    return () => { annullato = true; };
  }, [autorizzato]);

  useEffect(() => () => { grafico.current?.destroy(); grafico.current = null; }, []);

  useEffect(() => {
    const ch = grafico.current;
    if (!ch) return;
    const x = (t: number) => t / 60;
    // Linea, colori e cambi di strike a ogni snapshot (`punti`); le frecce restano quelle al minuto.
    const lati = punti.map((m) => m.lato);
    const strikeDelGiorno = [...new Set(punti.map((m) => m.strike))].sort((a, b) => a - b);
    const coloreDi = (k?: number) => k == null ? GIALLO : COLORI_STRIKE[strikeDelGiorno.indexOf(k) % COLORI_STRIKE.length];
    const lista: Cambio[] = [];
    for (let i = 1; i < punti.length; i++) {
      if (punti[i].strike !== punti[i - 1].strike) {
        lista.push({ x: x(punti[i].t), y: punti[i].es, da: punti[i - 1].strike, a: punti[i].strike, colore: coloreDi(punti[i].strike) });
      }
    }
    cambi.current = lista;
    // Frecce: dove il segnale cambia verso (stessa regola dello studio), sulla linea di ES.
    const su: { x: number; y: number }[] = [], giu: { x: number; y: number }[] = [];
    let prec = 0;
    for (const e of eventi) {
      if (e.seg !== prec) {
        const y = valoreA(es, e.t);
        if (y != null) (e.seg > 0 ? su : giu).push({ x: x(e.t), y });
      }
      prec = e.seg;
    }
    // Le serie spente dalla legenda restano spente: i dataset nuovi a ogni giro (10 s) creano meta
    // nuovi e Chart.js le riaccenderebbe. Stesso ordine a ogni giro, quindi si riconoscono dall'indice.
    const nascoste = ch.data.datasets.map((_, i) => !ch.isDatasetVisible(i));
    ch.data.datasets = ([
      {
        label: 'Linea piu\' alta (verde = strike sopra ATM, rosso = sotto)',
        data: punti.map((m) => ({ x: x(m.t), y: m.p, strike: m.strike, lato: m.lato })),
        yAxisID: 'y', borderWidth: 1.5, pointRadius: 0, borderColor: VERDE,
        segment: { borderColor: (c) => (lati[c.p1DataIndex] > 0 ? VERDE : ROSSO) },
      },
      {
        label: 'ES (colore = strike)',
        data: punti.map((m) => ({ x: x(m.t), y: m.es, strike: m.strike })),
        yAxisID: 'es', borderColor: GIALLO, borderWidth: 1.6, pointRadius: 0,
        segment: { borderColor: (c) => coloreDi(punti[c.p1DataIndex]?.strike) },
      },
      { label: `Segnale su (${k} min)`, data: su, yAxisID: 'es', showLine: false, pointStyle: 'triangle', pointRadius: 5, backgroundColor: VERDE, borderColor: VERDE },
      { label: `Segnale giu' (${k} min)`, data: giu, yAxisID: 'es', showLine: false, pointStyle: 'triangle', rotation: 180, pointRadius: 5, backgroundColor: ROSSO, borderColor: ROSSO },
      {
        label: 'Cambio strike', data: lista, yAxisID: 'es', showLine: false, pointRadius: 3.5,
        backgroundColor: lista.map((q) => q.colore), borderColor: '#0c0d10', borderWidth: 1,
      },
    ] as ChartConfiguration<'line'>['data']['datasets']).map((d, i) => ({ ...d, hidden: nascoste[i] ?? false }));
    ch.update('none');
  }, [punti, es, eventi, k, pronto]);

  if (!autorizzato) return null;

  const cella = (s: ReturnType<typeof statistica>, i: number) => s == null ? <td key={i} className="px-2 text-slate-600">-</td> : (
    <td key={i} className={`px-2 tabular-nums ${s.media > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
      {(s.giusti * 100).toFixed(0)}% · {s.media >= 0 ? '+' : ''}{s.media.toFixed(2)} <span className="text-slate-500">({s.n})</span>
    </td>
  );

  return (
    <div className={`${incorporata ? '' : 'min-h-screen p-4'} bg-[#0c0d10] text-slate-200 space-y-3`}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Linea piu&apos; alta vs ES <span className="text-xs text-amber-400 font-normal">(verifica)</span></h1>
        <input type="date" value={giorno} max={chiaveOggi()} onChange={(e) => e.target.value && setGiorno(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" />
        <label className="text-xs text-slate-400">Variazione su
          <select value={k} onChange={(e) => setK(Number(e.target.value))} className="ml-1 bg-slate-800 border border-slate-700 rounded px-1 py-1">
            {[1, 2, 5].map((v) => <option key={v} value={v}>{v} min</option>)}
          </select>
        </label>
        <button onClick={() => grafico.current?.resetZoom()} className="px-3 py-1 text-xs bg-slate-800 border border-slate-700 rounded">Reset zoom</button>
        {!incorporata && <button onClick={() => router.push('/hedging-pressure')} className="px-3 py-1 text-xs bg-slate-800 border border-slate-700 rounded">MARKET MAKER</button>}
        {!incorporata && <button onClick={() => router.push('/market')} className="px-3 py-1 text-xs bg-slate-800 border border-slate-700 rounded">MARKET</button>}
        {errore && <span className="text-xs text-rose-400">{errore}</span>}
      </div>

      <div className="h-[55vh] bg-slate-900/60 rounded border border-slate-800 p-2"><canvas ref={canvas} style={{ cursor: 'crosshair' }} /></div>

      <div className="bg-slate-900/60 rounded border border-slate-800 p-3 text-xs space-y-2 overflow-x-auto">
        <div className="text-slate-400">
          Ogni minuto del cash (9:35-15:50 NY): segnale = segno della variazione della linea su {k} min × (+1 se lo strike e&apos; sopra SPX, −1 se sotto).
          Celle: % di volte in cui ES va nel verso del segnale · punti medi ES nel verso del segnale (n. minuti).
          {tabella.concorda != null && <> Oggi il segnale coincide con il movimento di ES degli stessi {k} min nel <b className="text-slate-200">{(tabella.concorda * 100).toFixed(0)}%</b> dei casi.</>}
        </div>
        <table className="min-w-[640px]">
          <thead><tr className="text-slate-500"><th className="text-left pr-4 font-normal">Giorno selezionato</th>{ORIZZONTI.map((h) => <th key={h} className="px-2 font-normal text-left">ES a {h} min</th>)}</tr></thead>
          <tbody>{tabella.righe.map((r) => <tr key={r.nome}><td className="pr-4 whitespace-pre text-slate-300">{r.nome}</td>{r.per.map((s, i) => cella(s, i))}</tr>)}</tbody>
        </table>
        <div className="text-slate-400 border-t border-slate-800 pt-2">
          <b className="text-slate-200">31 sedute (15/09-11/11/2026, `execution/studio_linea_alta.py`), variazione su 2 min:</b> ES nel verso del segnale il 49% delle volte
          a 5 min, +0.20 pt di media; il solo momentum di ES dà lo stesso (50%, +0.19). Il segnale coincide con il movimento appena fatto da ES nel 66% dei casi
          (71% su 5 min): la pressione della route è gex × (spot − apertura) × vicinanza, quindi la linea contiene il prezzo. Quando NON coincide con il momentum: +0.02 pt a 5 min.
          Ingresso a ogni cambio di segnale, uscita a 5 min, 0.25 pt di costo: −166 pt, 15 giorni positivi su 31.
        </div>
      </div>
    </div>
  );
}
