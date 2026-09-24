'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Chart as ChartJS, registerables, type Scale } from 'chart.js';
import type { ZoomPluginOptions } from 'chartjs-plugin-zoom/types/options';
import { leggiRefLines, leggiVisibilita, REF_LINES_KEY, REF_LINES_VIS_KEY } from '@/lib/refLines';

ChartJS.register(...registerables);

interface BookmapPoint {
  time: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  buy: number;
  sell: number;
  delta: number;
  cvd: number;
  bidLiq: number;
  askLiq: number;
  levels: number;
  alias: string;
  /** Contratti limit aggiunti/tolti nel secondo, primi 5 livelli per lato; null prima dell'add-on che li conta. */
  addB: number | null;
  remB: number | null;
  addA: number | null;
  remA: number | null;
  /** Ordini limit per livello, [prezzo, contratti]; null nei campioni di prima che l'add-on li mandasse. */
  book: { b: [number, number][]; a: [number, number][] } | null;
}

/** Un ordine limit rimasto allo stesso prezzo per un tratto di tempo: una linea orizzontale. */
interface Segmento {
  da: number;
  a: number;
  prezzo: number;
  contratti: number;
  bid: boolean;
}

const REFRESH_MS = 2000;
/** Tre ore a un campione al secondo, come MAX_INIZIALI in /api/bookmap. */
const MAX_PUNTI = 10800;
/** Oltre questo ritardo dell'ultimo campione, Bookmap (o l'add-on) si considera fermo. */
const FERMO_DOPO_SEC = 15;
/** I due grafici partono dallo stesso x solo se gli assi laterali hanno la stessa larghezza. */
const LARGHEZZA_ASSE = 64;
/** Spazio a destra dell'ultimo campione quando la vista segue i dati. */
const MARGINE_DESTRO_SEC = 10;

const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
const VIOLA = '#a855f7';

type Finestra = '15' | '60' | '180';
/**
 * I dodici livelli R1/R2/R3 del Range Calc di /market, gia' in prezzi ES:
 * stessi colori e stesso tratto del grafico principale (mattina tratteggiata,
 * Opening Bell continua). Qui non si calcolano, si leggono.
 */
const RANGE_ES = (['', 'Ob'] as const).flatMap((suffisso) =>
  ([
    ['r1Down', '#ef4444', 'R1↓'],
    ['r2Down', '#f97316', 'R2↓'],
    ['r3Down', '#facc15', 'R3↓'],
    ['r1Up', '#3b82f6', 'R1↑'],
    ['r2Up', '#06b6d4', 'R2↑'],
    ['r3Up', '#10b981', 'R3↑'],
  ] as const).map(([chiave, colore, etichetta]) => ({
    key: `${chiave}${suffisso}`,
    colore,
    etichetta: `${etichetta}${suffisso ? ' OB' : ''}`,
    tratteggio: suffisso ? [] : [6, 3],
  })),
);

/** Da quanti contratti in su un livello del book diventa una linea: il cursore va da SOGLIA_MIN a SOGLIA_MAX. */
const SOGLIA_MIN = 50;
const SOGLIA_MAX = 200;
/** Tick di ES: lo spessore di una linea e' un livello di prezzo. */
const TICK = 0.25;
/** Due campioni del book piu' distanti di cosi' (secondi) spezzano la linea. */
const BUCO_MAX_SEC = 3;

/** Media mobile della liquidita': '1' = nessuna media, il dato secondo per secondo. */
type MediaLiq = '1' | '10' | '30' | '60';

/** Media sugli ultimi `finestraSec` secondi; i NaN non contano e restano buchi. */
function mediaMobile(xs: number[], valori: number[], finestraSec: number): number[] {
  if (finestraSec <= 1) return valori;
  const out: number[] = [];
  let j = 0;
  let somma = 0;
  let n = 0;
  for (let i = 0; i < valori.length; i++) {
    if (Number.isFinite(valori[i])) {
      somma += valori[i];
      n++;
    }
    while (xs[j] <= xs[i] - finestraSec) {
      if (Number.isFinite(valori[j])) {
        somma -= valori[j];
        n--;
      }
      j++;
    }
    out.push(n > 0 && Number.isFinite(valori[i]) ? somma / n : NaN);
  }
  return out;
}

/** Su quanti secondi si sommano aggiunte e rimozioni: secondo per secondo e' solo rumore. */
type FinestraFlusso = '10' | '30' | '60';
/** Tolti = cancellati + eseguiti (quello che sparisce dal book), oppure solo i cancellati. */
type Tolti = 'cancellati' | 'tutti';
/**
 * Come si guarda il flusso. Le quattro linee grezze sono della stessa
 * grandezza e si sovrappongono: da sole non dicono chi prevale.
 * - pressione: (bid aggiunti − tolti) − (ask aggiunti − tolti), un solo segnale
 * - lato: il netto dei bid e quello degli ask, ognuno attorno allo zero
 * - dettaglio: le quattro somme grezze
 */
type VistaFlusso = 'pressione' | 'lato' | 'dettaglio';

/** Netto per lato e pressione, dalle somme mobili. */
function nettiFlusso(fl: SerieFlusso) {
  const bid = fl.addB.map((v, i) => v - fl.remB[i]);
  const ask = fl.addA.map((v, i) => v - fl.remA[i]);
  return { bid, ask, pressione: bid.map((v, i) => v - ask[i]) };
}

interface SerieFlusso {
  addB: number[];
  remB: number[];
  addA: number[];
  remA: number[];
}

/**
 * Somme mobili sugli ultimi `finestraSec` secondi dei contratti limit aggiunti
 * e tolti nei primi livelli. Con `soloCancellati` ai tolti si sottrae
 * l'eseguito: un venditore aggressivo consuma i bid (`sell`), un compratore
 * gli ask (`buy`). Si sottrae sulla finestra e non secondo per secondo, perche'
 * trade e aggiornamento del book possono cadere in due secondi diversi.
 */
function flussoMobile(pts: BookmapPoint[], xs: number[], finestraSec: number, soloCancellati: boolean): SerieFlusso {
  const out: SerieFlusso = { addB: [], remB: [], addA: [], remA: [] };
  const ok = (p: BookmapPoint) => p.addB != null && p.remB != null && p.addA != null && p.remA != null;
  let j = 0;
  let aB = 0, rB = 0, aA = 0, rA = 0, compra = 0, vende = 0, n = 0;
  const somma = (p: BookmapPoint, segno: 1 | -1) => {
    aB += segno * p.addB!;
    rB += segno * p.remB!;
    aA += segno * p.addA!;
    rA += segno * p.remA!;
    compra += segno * p.buy;
    vende += segno * p.sell;
    n += segno;
  };
  for (let i = 0; i < pts.length; i++) {
    if (ok(pts[i])) somma(pts[i], 1);
    while (xs[j] <= xs[i] - finestraSec) {
      if (ok(pts[j])) somma(pts[j], -1);
      j++;
    }
    if (!ok(pts[i]) || n === 0) {
      out.addB.push(NaN);
      out.remB.push(NaN);
      out.addA.push(NaN);
      out.remA.push(NaN);
      continue;
    }
    out.addB.push(aB);
    out.addA.push(aA);
    out.remB.push(soloCancellati ? Math.max(0, rB - vende) : rB);
    out.remA.push(soloCancellati ? Math.max(0, rA - compra) : rA);
  }
  return out;
}

/**
 * Le linee degli ordini limit: per ogni livello sopra soglia, i secondi
 * consecutivi in cui resta nel book diventano un solo segmento. Cosi' si
 * disegnano poche migliaia di rettangoli invece di uno per livello per secondo.
 */
function segmentiBook(pts: BookmapPoint[], xs: number[], soglia: number): Segmento[] {
  const chiusi: Segmento[] = [];
  const aperti = new Map<string, Segmento>();
  for (let i = 0; i < pts.length; i++) {
    const book = pts[i].book;
    if (!book) continue;
    const x = xs[i];
    const visti = new Set<string>();
    for (const [bid, righe] of [[true, book.b], [false, book.a]] as const) {
      for (const [prezzo, contratti] of righe) {
        if (contratti < soglia) continue;
        const k = `${bid ? 'b' : 'a'}${prezzo}`;
        visti.add(k);
        const seg = aperti.get(k);
        if (seg && x - seg.a <= BUCO_MAX_SEC) {
          seg.a = x;
          seg.contratti = Math.max(seg.contratti, contratti);
        } else {
          if (seg) chiusi.push(seg);
          aperti.set(k, { da: x, a: x, prezzo, contratti, bid });
        }
      }
    }
    for (const [k, seg] of aperti) {
      if (!visti.has(k)) {
        chiusi.push(seg);
        aperti.delete(k);
      }
    }
  }
  return [...chiusi, ...aperti.values()];
}

/**
 * Cosa ha fissato l'utente con zoom o trascinamento. Finche' un asse e' libero
 * la pagina lo ricalcola a ogni aggiornamento (il tempo segue l'ultimo
 * campione, i valori si adattano a quello che si vede); fissato, lo si lascia
 * dov'e' finche' non si torna in LIVE.
 */
interface Blocco {
  x: boolean;
  sopra: boolean;
  sotto: boolean;
  flusso: boolean;
}
const LIBERO: Blocco = { x: false, sopra: false, sotto: false, flusso: false };

function secondi(hhmmss: string) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function orario(sec: number, conSecondi = true) {
  const s = Math.max(0, Math.round(sec));
  const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return conSecondi ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

function compatto(v: number | null | undefined, decimali = 0) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(decimali);
}

function fissaLarghezza(scale: Scale) {
  scale.width = LARGHEZZA_ASSE;
}

/** Minimo e massimo con un po' d'aria, oppure null se non c'e' niente da mostrare. */
function estremi(valori: number[], aria = 0.08): { min: number; max: number } | null {
  const finiti = valori.filter((v) => Number.isFinite(v));
  if (finiti.length === 0) return null;
  let min = finiti.reduce((a, b) => Math.min(a, b));
  let max = finiti.reduce((a, b) => Math.max(a, b));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * aria;
  return { min: min - pad, max: max + pad };
}

function Selettore<T extends string>({
  titolo,
  valore,
  opzioni,
  onChange,
}: {
  titolo: string;
  valore: T;
  opzioni: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-500">{titolo}</span>
      <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-0.5">
        {opzioni.map(([v, etichetta]) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`px-2 py-0.5 rounded font-bold ${valore === v ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {etichetta}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BookmapPage() {
  const router = useRouter();
  const [autorizzato, setAutorizzato] = useState(false);
  const [points, setPoints] = useState<BookmapPoint[]>([]);
  const [caricato, setCaricato] = useState(false);
  const [errore, setErrore] = useState(false);
  const [soloLocale, setSoloLocale] = useState(false);
  const [finestra, setFinestra] = useState<Finestra>('60');
  const [orologio, setOrologio] = useState(() => new Date());
  const [pronti, setPronti] = useState(false);
  const [blocco, setBlocco] = useState<Blocco>(LIBERO);
  const [mostraCvd, setMostraCvd] = useState(true);
  const [soglia, setSoglia] = useState(SOGLIA_MIN);
  const [mostraOrdini, setMostraOrdini] = useState(true);
  const [mostraRange, setMostraRange] = useState(true);
  const [quantiRange, setQuantiRange] = useState(0);
  const [spessore, setSpessore] = useState(1);
  const [finestraFlusso, setFinestraFlusso] = useState<FinestraFlusso>('30');
  const [mediaLiq, setMediaLiq] = useState<MediaLiq>('30');
  const [mostraBidAsk, setMostraBidAsk] = useState(false);
  const [tolti, setTolti] = useState<Tolti>('cancellati');
  const [vistaFlusso, setVistaFlusso] = useState<VistaFlusso>('pressione');

  const prezzoRef = useRef<HTMLCanvasElement | null>(null);
  const liquiditaRef = useRef<HTMLCanvasElement | null>(null);
  const chartPrezzo = useRef<ChartJS | null>(null);
  const chartLiquidita = useRef<ChartJS | null>(null);
  const flussoRef = useRef<HTMLCanvasElement | null>(null);
  const chartFlusso = useRef<ChartJS | null>(null);
  const ultimoTempo = useRef<string | null>(null);
  const giorno = useRef<string | null>(null);
  // Letti dai callback del plugin di zoom, che nascono una volta sola con i grafici.
  const pointsRef = useRef<BookmapPoint[]>([]);
  const finestraRef = useRef<Finestra>('60');
  const bloccoRef = useRef<Blocco>(LIBERO);
  const mostraCvdRef = useRef(true);
  const sogliaRef = useRef(SOGLIA_MIN);
  const mostraOrdiniRef = useRef(true);
  const mostraRangeRef = useRef(true);
  /** Livelli R1/R2/R3 da disegnare, gia' filtrati per la visibilita' scelta in /market. */
  const rangeRef = useRef<{ valore: number; colore: string; etichetta: string; tratteggio: number[] }[]>([]);
  const spessoreRef = useRef(1);
  const finestraFlussoRef = useRef<FinestraFlusso>('30');
  const mediaLiqRef = useRef<MediaLiq>('30');
  const mostraBidAskRef = useRef(false);
  const toltiRef = useRef<Tolti>('cancellati');
  const vistaFlussoRef = useRef<VistaFlusso>('pressione');
  const segmentiRef = useRef<Segmento[]>([]);
  /** Posizione del mirino: l'orario vale per tutti e due i grafici, l'altezza solo per quello sotto il mouse. */
  const mirinoRef = useRef<{ sec: number; y: number; sorgente: ChartJS } | null>(null);

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
    else setAutorizzato(true);
  }, [router]);

  // Incrementale come le altre pagine: la prima volta le ultime tre ore, poi
  // solo i campioni dopo l'ultimo gia' in memoria.
  useEffect(() => {
    if (!autorizzato) return;
    const carica = async () => {
      try {
        const since = ultimoTempo.current;
        const res = await fetch(since ? `/api/bookmap?since=${since}` : '/api/bookmap', { cache: 'no-store' });
        if (!res.ok) {
          setErrore(true);
          return;
        }
        setErrore(false);
        const json: { date: string; points: BookmapPoint[]; local?: boolean } = await res.json();
        if (json.local === false) setSoloLocale(true);
        if (giorno.current && json.date !== giorno.current) {
          giorno.current = json.date;
          ultimoTempo.current = null;
          setPoints([]);
          return;
        }
        giorno.current = json.date;
        if (json.points.length > 0) {
          ultimoTempo.current = json.points[json.points.length - 1].time;
          setPoints((prec) => (since ? [...prec, ...json.points].slice(-MAX_PUNTI) : json.points));
        }
      } catch (e) {
        console.error('Bookmap fetch failed:', e);
        setErrore(true);
      } finally {
        setCaricato(true);
      }
    };
    carica();
    const id = setInterval(carica, REFRESH_MS);
    return () => clearInterval(id);
  }, [autorizzato]);

  useEffect(() => {
    const id = setInterval(() => setOrologio(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /**
   * Mette i dati nei grafici e ricalcola gli assi che l'utente non ha fissato.
   * Il tempo libero segue l'ultimo campione con la finestra scelta; i valori
   * liberi si adattano ai soli punti visibili, non all'intera sessione (se no
   * dopo tre ore la linea di un quarto d'ora sarebbe piatta).
   */
  const applica = useCallback(() => {
    const cp = chartPrezzo.current;
    const cl = chartLiquidita.current;
    const cf = chartFlusso.current;
    if (!cp || !cl || !cf) return;
    const pts = pointsRef.current;
    const b = bloccoRef.current;

    const xs = pts.map((p) => secondi(p.time));
    cp.data.datasets[0].data = pts.map((p, i) => ({ x: xs[i], y: p.price ?? NaN }));
    cp.data.datasets[1].data = pts.map((p, i) => ({ x: xs[i], y: p.cvd }));
    // Lo sbilancio si calcola sulle medie, non si fa la media dello sbilancio:
    // cosi' pesa di piu' quando il book e' pieno.
    const w = Number(mediaLiqRef.current);
    const bidM = mediaMobile(xs, pts.map((p) => p.bidLiq), w);
    const askM = mediaMobile(xs, pts.map((p) => p.askLiq), w);
    const sbilM = bidM.map((bv, i) => (bv + askM[i] > 0 ? ((bv - askM[i]) / (bv + askM[i])) * 100 : NaN));
    cl.data.datasets[0].data = xs.map((x, i) => ({ x, y: sbilM[i] }));
    cl.data.datasets[1].data = xs.map((x, i) => ({ x, y: bidM[i] }));
    cl.data.datasets[2].data = xs.map((x, i) => ({ x, y: askM[i] }));
    const bidAsk = mostraBidAskRef.current;
    cl.data.datasets[1].hidden = !bidAsk;
    cl.data.datasets[2].hidden = !bidAsk;
    const asseLiq = cl.options.scales!.yLiq!;
    asseLiq.ticks!.display = bidAsk;
    const fl = flussoMobile(pts, xs, Number(finestraFlussoRef.current), toltiRef.current === 'cancellati');
    cf.data.datasets[0].data = xs.map((x, i) => ({ x, y: fl.addB[i] }));
    cf.data.datasets[1].data = xs.map((x, i) => ({ x, y: fl.remB[i] }));
    cf.data.datasets[2].data = xs.map((x, i) => ({ x, y: fl.addA[i] }));
    cf.data.datasets[3].data = xs.map((x, i) => ({ x, y: fl.remA[i] }));
    const netti = nettiFlusso(fl);
    cf.data.datasets[4].data = xs.map((x, i) => ({ x, y: netti.pressione[i] }));
    cf.data.datasets[5].data = xs.map((x, i) => ({ x, y: netti.bid[i] }));
    cf.data.datasets[6].data = xs.map((x, i) => ({ x, y: netti.ask[i] }));
    const vista = vistaFlussoRef.current;
    [0, 1, 2, 3].forEach((k) => (cf.data.datasets[k].hidden = vista !== 'dettaglio'));
    cf.data.datasets[4].hidden = vista !== 'pressione';
    cf.data.datasets[5].hidden = vista !== 'lato';
    cf.data.datasets[6].hidden = vista !== 'lato';

    let da: number;
    let a: number;
    if (!b.x && xs.length > 0) {
      a = xs[xs.length - 1] + MARGINE_DESTRO_SEC;
      da = a - Number(finestraRef.current) * 60;
      for (const c of [cp, cl, cf]) {
        const x = c.options.scales!.x!;
        x.min = da;
        x.max = a;
      }
    } else {
      da = cp.scales.x?.min ?? -Infinity;
      a = cp.scales.x?.max ?? Infinity;
    }

    const visibili = pts.filter((_, i) => xs[i] >= da && xs[i] <= a);
    // CVD spento: linea nascosta, asse destro vuoto ma largo uguale, cosi' i
    // due grafici restano allineati sul tempo.
    segmentiRef.current = mostraOrdiniRef.current ? segmentiBook(pts, xs, sogliaRef.current) : [];

    const cvdAcceso = mostraCvdRef.current;
    cp.data.datasets[1].hidden = !cvdAcceso;
    const asseCvd = cp.options.scales!.yCvd!;
    asseCvd.ticks!.display = cvdAcceso;
    asseCvd.grid!.display = cvdAcceso;

    if (!b.sopra) {
      const sp = cp.options.scales!;
      const prezzi = visibili.map((p) => p.price ?? NaN);
      // Con i range accesi la scala arriva fino al livello piu' vicino sopra e
      // sotto il prezzo: se si fermasse al prezzo non se ne vedrebbe quasi mai
      // uno, se li prendesse tutti e dodici il prezzo diventerebbe una riga.
      const finiti = prezzi.filter((v) => Number.isFinite(v));
      if (mostraRangeRef.current && finiti.length > 0) {
        const basso = Math.min(...finiti);
        const alto = Math.max(...finiti);
        const livelli = rangeRef.current.map((l) => l.valore);
        const sopra = livelli.filter((v) => v > alto);
        const sotto = livelli.filter((v) => v < basso);
        if (sopra.length > 0) prezzi.push(Math.min(...sopra));
        if (sotto.length > 0) prezzi.push(Math.max(...sotto));
      }
      const rp = estremi(prezzi);
      const rc = estremi(visibili.map((p) => p.cvd));
      sp.yPrezzo!.min = rp?.min;
      sp.yPrezzo!.max = rp?.max;
      sp.yCvd!.min = rc?.min;
      sp.yCvd!.max = rc?.max;
    }
    if (!b.sotto) {
      const sl = cl.options.scales!;
      const valoriLiq: number[] = [];
      let massimoSbil = 0;
      xs.forEach((x, i) => {
        if (x < da || x > a) return;
        valoriLiq.push(bidM[i], askM[i]);
        if (Number.isFinite(sbilM[i])) massimoSbil = Math.max(massimoSbil, Math.abs(sbilM[i]));
      });
      const rl = estremi(valoriLiq, 0.1);
      sl.yLiq!.min = rl?.min;
      sl.yLiq!.max = rl?.max;
      // Simmetrico attorno allo zero, stretto su quello che si vede: con -100/+100
      // fissi uno sbilancio del 20% era una riga piatta.
      const semi = Math.max(5, Math.ceil((massimoSbil * 1.15) / 5) * 5);
      sl.ySbil!.min = -semi;
      sl.ySbil!.max = semi;
    }
    if (!b.flusso) {
      const vista = vistaFlussoRef.current;
      const valori: number[] = [];
      xs.forEach((x, i) => {
        if (x < da || x > a) return;
        if (vista === 'dettaglio') valori.push(fl.addB[i], fl.remB[i], fl.addA[i], fl.remA[i]);
        else if (vista === 'lato') valori.push(netti.bid[i], netti.ask[i]);
        else valori.push(netti.pressione[i]);
      });
      const asse = cf.options.scales!.yFlusso!;
      if (vista === 'dettaglio') {
        asse.min = 0;
        asse.max = estremi(valori, 0.1)?.max;
      } else {
        // I netti vivono attorno allo zero: scala simmetrica, cosi' lo zero sta in mezzo.
        const massimo = valori.reduce((m, v) => (Number.isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
        const semi = Math.max(10, Math.ceil(massimo * 1.15));
        asse.min = -semi;
        asse.max = semi;
      }
    }
    cp.update('none');
    cl.update('none');
    cf.update('none');
  }, []);

  const impostaBlocco = useCallback((b: Blocco) => {
    bloccoRef.current = b;
    setBlocco(b);
  }, []);

  /** Torna a seguire i dati: via lo zoom, assi di nuovo calcolati dalla pagina. */
  const tornaLive = useCallback(() => {
    impostaBlocco(LIBERO);
    for (const c of [chartPrezzo.current, chartLiquidita.current, chartFlusso.current]) {
      (c as (ChartJS & { resetZoom?: (mode?: string) => void }) | null)?.resetZoom?.('none');
    }
    applica();
  }, [applica, impostaBlocco]);

  // I grafici si creano una volta; i dati si aggiornano in modo imperativo,
  // cosi' zoom e trascinamento non si perdono a ogni aggiornamento. Il plugin
  // di zoom si importa qui perche' tocca `window` (come in /market).
  useEffect(() => {
    if (!autorizzato) return;
    let annullato = false;

    (async () => {
      const zoomPlugin = (await import('chartjs-plugin-zoom')).default;
      if (annullato || !prezzoRef.current || !liquiditaRef.current || !flussoRef.current) return;
      ChartJS.register(zoomPlugin);

      const quale = (chart: ChartJS): Exclude<keyof Blocco, 'x'> =>
        chart === chartPrezzo.current ? 'sopra' : chart === chartLiquidita.current ? 'sotto' : 'flusso';
      const altri = (chart: ChartJS) =>
        [chartPrezzo.current, chartLiquidita.current, chartFlusso.current].filter((c): c is ChartJS => !!c && c !== chart);

      /** Il tempo e' uno solo: quello che si fa su un grafico vale anche per gli altri. */
      const allinea = (chart: ChartJS) => {
        const x = chart.scales.x;
        if (x) {
          for (const altro of altri(chart)) {
            altro.options.scales!.x!.min = x.min;
            altro.options.scales!.x!.max = x.max;
          }
        }
        applica();
      };

      const zoom: ZoomPluginOptions = {
        // Rotella sul grafico = tempo; rotella sopra un asse Y = solo quell'asse.
        zoom: {
          wheel: { enabled: true, speed: 0.1 },
          mode: 'xy',
          overScaleMode: 'y',
          onZoomStart: ({ chart, point }) => {
            const area = chart.chartArea;
            const suAsseY = point.x != null && (point.x < area.left || point.x > area.right);
            const b = { ...bloccoRef.current };
            if (suAsseY) b[quale(chart as ChartJS)] = true;
            else b.x = true;
            impostaBlocco(b);
            return true;
          },
          onZoomComplete: ({ chart }) => allinea(chart as ChartJS),
        },
        // Trascinare sposta tempo e valori insieme.
        pan: {
          enabled: true,
          mode: 'xy',
          onPanStart: ({ chart }) => {
            impostaBlocco({ ...bloccoRef.current, x: true, [quale(chart as ChartJS)]: true });
            return true;
          },
          onPanComplete: ({ chart }) => allinea(chart as ChartJS),
        },
        limits: { x: { minRange: 30 } },
      };

      const asseX = {
        type: 'linear' as const,
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: {
          color: '#64748b',
          maxRotation: 0,
          autoSkipPadding: 30,
          callback: (v: string | number) => orario(Number(v), false),
        },
      };
      const tooltip = { enabled: false };

      /**
       * Mirino a croce al posto del riquadro dei valori, come in /market: linea
       * verticale su entrambi i grafici allo stesso orario, orizzontale solo
       * dove sta il mouse, e i valori scritti sugli assi.
       */
      /** Le linee degli ordini limit, sotto la linea del prezzo; piu' contratti = piu' accese. */
      const ordini = {
        id: 'ordini',
        beforeDatasetsDraw: (chart: ChartJS) => {
          const segmenti = segmentiRef.current;
          const sx = chart.scales.x;
          const sy = chart.scales.yPrezzo;
          if (segmenti.length === 0 || !sx || !sy) return;
          const s = sogliaRef.current;
          const { ctx, chartArea: a } = chart;
          // Un tick di altezza (almeno 1,5 px), per il moltiplicatore scelto nella pagina.
          const alto = Math.max(1.5, Math.abs(sy.getPixelForValue(0) - sy.getPixelForValue(TICK)) * 0.8) * spessoreRef.current;
          ctx.save();
          ctx.beginPath();
          ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
          ctx.clip();
          for (const seg of segmenti) {
            const x1 = sx.getPixelForValue(seg.da);
            const x2 = sx.getPixelForValue(seg.a + 1);
            if (x2 < a.left || x1 > a.right) continue;
            const y = sy.getPixelForValue(seg.prezzo);
            if (y < a.top - alto || y > a.bottom + alto) continue;
            // da 0,25 alla soglia fino a pieno a 5 volte la soglia
            const alfa = Math.min(1, 0.25 + (0.75 * (seg.contratti - s)) / (s * 4));
            ctx.fillStyle = seg.bid ? `rgba(52, 211, 153, ${alfa})` : `rgba(244, 63, 94, ${alfa})`;
            ctx.fillRect(x1, y - alto / 2, Math.max(1, x2 - x1), alto);
          }
          ctx.restore();
        },
      };

      /** I range ES del grafico principale: linee orizzontali con l'etichetta a destra. */
      const range = {
        id: 'range',
        afterDatasetsDraw: (chart: ChartJS) => {
          const livelli = rangeRef.current;
          const sy = chart.scales.yPrezzo;
          if (!mostraRangeRef.current || livelli.length === 0 || !sy) return;
          const { ctx, chartArea: a } = chart;
          ctx.save();
          ctx.font = 'bold 10px Arial';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'right';
          for (const l of livelli) {
            const y = sy.getPixelForValue(l.valore);
            if (y < a.top || y > a.bottom) continue;
            ctx.beginPath();
            ctx.setLineDash(l.tratteggio);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = l.colore;
            ctx.moveTo(a.left, y);
            ctx.lineTo(a.right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            const testo = `${l.etichetta} ${l.valore.toFixed(2)}`;
            const w = ctx.measureText(testo).width + 8;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
            ctx.fillRect(a.right - w - 4, y - 8, w, 16);
            ctx.fillStyle = l.colore;
            ctx.fillText(testo, a.right - 8, y);
          }
          ctx.restore();
        },
      };

      const mirino = {
        id: 'mirino',
        afterEvent: (chart: ChartJS, args: { event: { type: string; x: number | null; y: number | null }; changed?: boolean }) => {
          const { type, x, y } = args.event;
          const a = chart.chartArea;
          const prima = mirinoRef.current;
          if (type === 'mousemove' && x != null && y != null && x >= a.left && x <= a.right && y >= a.top && y <= a.bottom) {
            mirinoRef.current = { sec: chart.scales.x.getValueForPixel(x) ?? 0, y, sorgente: chart };
          } else if (type === 'mousemove' || type === 'mouseout') {
            if (prima?.sorgente !== chart) return;
            mirinoRef.current = null;
          } else {
            return;
          }
          args.changed = true;
          for (const altro of altri(chart)) altro.draw();
        },
        afterDraw: (chart: ChartJS) => {
          const m = mirinoRef.current;
          if (!m) return;
          const { ctx, chartArea: a } = chart;
          const px = chart.scales.x.getPixelForValue(m.sec);
          if (px < a.left || px > a.right) return;

          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.moveTo(px, a.top);
          ctx.lineTo(px, a.bottom);
          if (m.sorgente === chart) {
            ctx.moveTo(a.left, m.y);
            ctx.lineTo(a.right, m.y);
          }
          ctx.stroke();

          ctx.setLineDash([]);
          ctx.font = '11px Arial';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          const etichetta = (testo: string, cx: number, cy: number, larghezzaMax?: number) => {
            const w = Math.min(ctx.measureText(testo).width + 10, larghezzaMax ?? Infinity);
            ctx.fillStyle = '#2a2e39';
            ctx.fillRect(cx - w / 2, cy - 10, w, 20);
            ctx.fillStyle = '#d1d4dc';
            ctx.fillText(testo, cx, cy, w - 4);
          };

          // L'orario sotto l'asse X, che si vede solo nel grafico in basso.
          if (chart === chartFlusso.current) etichetta(orario(m.sec), px, a.bottom + 10);

          if (m.sorgente === chart) {
            for (const scala of Object.values(chart.scales)) {
              if (scala.axis !== 'y' || scala.id === 'yVuoto') continue;
              const v = scala.getValueForPixel(m.y);
              if (v == null || (scala.id === 'yCvd' && !mostraCvdRef.current) || (scala.id === 'yLiq' && !mostraBidAskRef.current)) continue;
              const testo =
                scala.id === 'yPrezzo' ? v.toFixed(2) : scala.id === 'ySbil' ? `${Math.round(v)}%` : compatto(v);
              etichetta(testo, (scala.left + scala.right) / 2, m.y, scala.right - scala.left);
            }
          }
          ctx.restore();
        },
      };

      chartPrezzo.current = new ChartJS(prezzoRef.current, {
        type: 'line',
        plugins: [ordini, range, mirino],
        data: {
          datasets: [
            { label: 'ES', data: [], yAxisID: 'yPrezzo', borderColor: GIALLO, borderWidth: 1.4, pointRadius: 0, tension: 0 },
            { label: 'CVD', data: [], yAxisID: 'yCvd', borderColor: VIOLA, borderWidth: 2, pointRadius: 0, tension: 0 },
          ],
        },
        options: {
          animation: false,
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: { legend: { display: false }, tooltip, zoom },
          scales: {
            x: { ...asseX, ticks: { ...asseX.ticks, display: false } },
            yPrezzo: { position: 'left', afterFit: fissaLarghezza, grid: { display: false }, ticks: { color: '#94a3b8' } },
            yCvd: {
              position: 'right',
              afterFit: fissaLarghezza,
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#94a3b8', callback: (v) => compatto(Number(v)) },
            },
          },
        },
      });

      chartLiquidita.current = new ChartJS(liquiditaRef.current, {
        type: 'line',
        plugins: [mirino],
        data: {
          datasets: [
            // Il segnale: sopra lo zero verde (piu' bid), sotto rosso (piu' ask).
            {
              label: 'Sbilancio %',
              data: [],
              yAxisID: 'ySbil',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
              fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.28)', below: 'rgba(244, 63, 94, 0.28)' },
              segment: { borderColor: (ctx) => ((ctx.p1.parsed.y ?? 0) >= 0 ? VERDE : ROSSO) },
            },
            // Di contorno, sbiadite e spente di partenza: sovrapposte erano illeggibili.
            { label: 'Bid', data: [], yAxisID: 'yLiq', borderColor: 'rgba(52, 211, 153, 0.5)', borderWidth: 1, pointRadius: 0, tension: 0.2 },
            { label: 'Ask', data: [], yAxisID: 'yLiq', borderColor: 'rgba(244, 63, 94, 0.5)', borderWidth: 1, pointRadius: 0, tension: 0.2 },
          ],
        },
        options: {
          animation: false,
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: { legend: { display: false }, tooltip, zoom },
          scales: {
            x: { ...asseX, ticks: { ...asseX.ticks, display: false } },
            ySbil: {
              position: 'left',
              afterFit: fissaLarghezza,
              min: -100,
              max: 100,
              // La riga dello zero marcata: e' il confine tra bid e ask.
              grid: { color: (ctx) => (ctx.tick.value === 0 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.05)') },
              ticks: { color: '#94a3b8', callback: (v) => `${Math.round(Number(v))}%` },
            },
            yLiq: {
              position: 'right',
              afterFit: fissaLarghezza,
              grid: { display: false },
              ticks: { color: '#94a3b8', display: false, callback: (v) => compatto(Number(v)) },
            },
          },
        },
      });

      chartFlusso.current = new ChartJS(flussoRef.current, {
        type: 'line',
        plugins: [mirino],
        data: {
          datasets: [
            { label: 'Bid aggiunti', data: [], yAxisID: 'yFlusso', borderColor: VERDE, borderWidth: 1.6, pointRadius: 0, tension: 0 },
            { label: 'Bid tolti', data: [], yAxisID: 'yFlusso', borderColor: VERDE, borderWidth: 1.4, borderDash: [5, 3], pointRadius: 0, tension: 0 },
            { label: 'Ask aggiunti', data: [], yAxisID: 'yFlusso', borderColor: ROSSO, borderWidth: 1.6, pointRadius: 0, tension: 0 },
            { label: 'Ask tolti', data: [], yAxisID: 'yFlusso', borderColor: ROSSO, borderWidth: 1.4, borderDash: [5, 3], pointRadius: 0, tension: 0 },
            // Pressione: sopra lo zero verde (bid che si accumulano / ask ritirati), sotto rosso.
            {
              label: 'Pressione',
              data: [],
              yAxisID: 'yFlusso',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
              fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.28)', below: 'rgba(244, 63, 94, 0.28)' },
              segment: { borderColor: (ctx) => ((ctx.p1.parsed.y ?? 0) >= 0 ? VERDE : ROSSO) },
            },
            { label: 'Bid netto', data: [], yAxisID: 'yFlusso', borderColor: VERDE, borderWidth: 1.8, pointRadius: 0, tension: 0.2 },
            { label: 'Ask netto', data: [], yAxisID: 'yFlusso', borderColor: ROSSO, borderWidth: 1.8, pointRadius: 0, tension: 0.2 },
          ],
        },
        options: {
          animation: false,
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: { legend: { display: false }, tooltip, zoom },
          scales: {
            x: asseX,
            yFlusso: {
              position: 'left',
              afterFit: fissaLarghezza,
              grid: { color: (ctx) => (ctx.tick.value === 0 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.05)') },
              ticks: { color: '#94a3b8', callback: (v) => compatto(Number(v)) },
            },
            // Vuoto: c'e' solo perche' l'area del grafico finisca dove finiscono le altre due.
            yVuoto: { position: 'right', afterFit: fissaLarghezza, grid: { display: false }, ticks: { display: false } },
          },
        },
      });

      // Doppio clic su uno dei grafici = torna a seguire i dati.
      prezzoRef.current.ondblclick = tornaLive;
      liquiditaRef.current.ondblclick = tornaLive;
      flussoRef.current.ondblclick = tornaLive;
      setPronti(true);
    })();

    return () => {
      annullato = true;
      chartPrezzo.current?.destroy();
      chartLiquidita.current?.destroy();
      chartFlusso.current?.destroy();
      chartPrezzo.current = null;
      chartLiquidita.current = null;
      chartFlusso.current = null;
      setPronti(false);
    };
  }, [autorizzato, applica, impostaBlocco, tornaLive]);

  useEffect(() => {
    pointsRef.current = points;
    if (pronti) applica();
  }, [points, pronti, applica]);

  // La scelta si ricorda nel browser; se localStorage non c'e' si riparte col CVD acceso.
  useEffect(() => {
    try {
      if (localStorage.getItem('bookmap_cvd') === 'off') {
        mostraCvdRef.current = false;
        setMostraCvd(false);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  useEffect(() => {
    try {
      const salvato = Number(localStorage.getItem('bookmap_spessore'));
      if (salvato >= 0.5 && salvato <= 5) {
        spessoreRef.current = salvato;
        setSpessore(salvato);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  const cambiaSpessore = (v: number) => {
    spessoreRef.current = v;
    setSpessore(v);
    try {
      localStorage.setItem('bookmap_spessore', String(v));
    } catch {
      // la preferenza vale solo per questa visita
    }
    // Basta ridisegnare: i dati non cambiano.
    chartPrezzo.current?.draw();
  };

  useEffect(() => {
    try {
      const salvata = Number(localStorage.getItem('bookmap_soglia'));
      if (salvata >= SOGLIA_MIN && salvata <= SOGLIA_MAX) {
        sogliaRef.current = salvata;
        setSoglia(salvata);
      }
      if (localStorage.getItem('bookmap_ordini') === 'off') {
        mostraOrdiniRef.current = false;
        setMostraOrdini(false);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  /** Solo le linee cambiano: si rifanno i segmenti e si ridisegna, senza ricalcolare il resto a ogni scatto del cursore. */
  const rifaiOrdini = () => {
    const pts = pointsRef.current;
    segmentiRef.current = mostraOrdiniRef.current
      ? segmentiBook(pts, pts.map((p) => secondi(p.time)), sogliaRef.current)
      : [];
    chartPrezzo.current?.draw();
  };

  // I livelli li scrive /market, anche dopo che questa pagina e' aperta: si
  // rileggono quando cambiano in un'altra scheda e quando si torna qui (come /gex).
  useEffect(() => {
    try {
      if (localStorage.getItem('bookmap_range') === 'off') {
        mostraRangeRef.current = false;
        setMostraRange(false);
      }
    } catch {
      // niente preferenza salvata
    }
    const rileggi = () => {
      const valori = leggiRefLines() ?? {};
      const vis = leggiVisibilita() ?? {};
      rangeRef.current = RANGE_ES.flatMap((r) => {
        const v = parseFloat(valori[r.key] ?? '');
        return Number.isFinite(v) && vis[r.key] !== false
          ? [{ valore: v, colore: r.colore, etichetta: r.etichetta, tratteggio: r.tratteggio }]
          : [];
      });
      setQuantiRange(rangeRef.current.length);
      applica();
    };
    rileggi();
    const suStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === REF_LINES_KEY || e.key === REF_LINES_VIS_KEY) rileggi();
    };
    const suRitorno = () => {
      if (!document.hidden) rileggi();
    };
    window.addEventListener('storage', suStorage);
    document.addEventListener('visibilitychange', suRitorno);
    window.addEventListener('focus', rileggi);
    return () => {
      window.removeEventListener('storage', suStorage);
      document.removeEventListener('visibilitychange', suRitorno);
      window.removeEventListener('focus', rileggi);
    };
  }, [applica]);

  const cambiaRange = () => {
    const acceso = !mostraRangeRef.current;
    mostraRangeRef.current = acceso;
    setMostraRange(acceso);
    try {
      localStorage.setItem('bookmap_range', acceso ? 'on' : 'off');
    } catch {
      // la preferenza vale solo per questa visita
    }
    applica();
  };

  const cambiaSoglia = (v: number) => {
    sogliaRef.current = v;
    setSoglia(v);
    try {
      localStorage.setItem('bookmap_soglia', String(v));
    } catch {
      // la preferenza vale solo per questa visita
    }
    rifaiOrdini();
  };

  const cambiaOrdini = () => {
    const acceso = !mostraOrdiniRef.current;
    mostraOrdiniRef.current = acceso;
    setMostraOrdini(acceso);
    try {
      localStorage.setItem('bookmap_ordini', acceso ? 'on' : 'off');
    } catch {
      // la preferenza vale solo per questa visita
    }
    rifaiOrdini();
  };

  const cambiaMediaLiq = (v: MediaLiq) => {
    mediaLiqRef.current = v;
    setMediaLiq(v);
    applica();
  };

  const cambiaBidAsk = () => {
    mostraBidAskRef.current = !mostraBidAskRef.current;
    setMostraBidAsk(mostraBidAskRef.current);
    applica();
  };

  const cambiaFinestraFlusso = (v: FinestraFlusso) => {
    finestraFlussoRef.current = v;
    setFinestraFlusso(v);
    applica();
  };

  const cambiaVistaFlusso = (v: VistaFlusso) => {
    vistaFlussoRef.current = v;
    setVistaFlusso(v);
    try {
      localStorage.setItem('bookmap_vista_flusso', v);
    } catch {
      // la preferenza vale solo per questa visita
    }
    applica();
  };

  useEffect(() => {
    try {
      const v = localStorage.getItem('bookmap_vista_flusso');
      if (v === 'pressione' || v === 'lato' || v === 'dettaglio') {
        vistaFlussoRef.current = v;
        setVistaFlusso(v);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  const cambiaTolti = (v: Tolti) => {
    toltiRef.current = v;
    setTolti(v);
    applica();
  };

  const cambiaCvd = () => {
    const acceso = !mostraCvdRef.current;
    mostraCvdRef.current = acceso;
    setMostraCvd(acceso);
    try {
      localStorage.setItem('bookmap_cvd', acceso ? 'on' : 'off');
    } catch {
      // la preferenza vale solo per questa visita
    }
    applica();
  };

  // Scegliere una finestra vuol dire tornare a seguire i dati con quella ampiezza.
  const cambiaFinestra = (f: Finestra) => {
    finestraRef.current = f;
    setFinestra(f);
    tornaLive();
  };

  const corrente = points[points.length - 1] ?? null;
  const oraLocale = orologio.getHours() * 3600 + orologio.getMinutes() * 60 + orologio.getSeconds();
  const ritardo = corrente ? oraLocale - secondi(corrente.time) : null;
  const fermo = ritardo == null || ritardo > FERMO_DOPO_SEC;
  const sbil = corrente ? sbilancio(corrente) : null;
  const bloccato = blocco.x || blocco.sopra || blocco.sotto || blocco.flusso;
  // I valori di adesso: basta la coda, la somma guarda al massimo un minuto indietro.
  const coda = points.slice(-70);
  const flussoOra = flussoMobile(coda, coda.map((p) => secondi(p.time)), Number(finestraFlusso), tolti === 'cancellati');
  const ultimoFlusso = (k: keyof SerieFlusso) => {
    const v = flussoOra[k][flussoOra[k].length - 1];
    return v == null || Number.isNaN(v) ? null : v;
  };
  const conFlusso = corrente?.addB != null;
  const nettiOra = nettiFlusso(flussoOra);
  const ultimoNetto = (k: 'bid' | 'ask' | 'pressione') => {
    const v = nettiOra[k][nettiOra[k].length - 1];
    return v == null || Number.isNaN(v) ? null : v;
  };

  if (!autorizzato) return null;

  return (
    <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Bookmap · ES</h1>
            <p className="text-xs text-slate-500">
              CVD e liquidita&apos; del book da Bookmap (add-on <code>execution/bookmap_addon.py</code>) · solo locale, a titolo di studio
            </p>
          </div>
          <button
            onClick={() => router.push('/market')}
            className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            ← CHART
          </button>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111216] p-3 md:p-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm font-semibold mb-2 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className={fermo ? 'text-slate-600' : 'text-emerald-400'}>●</span>
              <span className="text-white">{corrente?.time ?? '--:--:--'}</span>
              {corrente && <span className="text-xs text-slate-500 font-normal">{corrente.alias}</span>}
            </span>
            <span className="text-slate-400">ES: <span className="text-white">{corrente?.price?.toFixed(2) ?? '—'}</span> <span style={{ color: GIALLO }}>●</span></span>
            <span className={`text-slate-400 ${mostraCvd ? '' : 'opacity-40'}`}>CVD: <span className="text-white">{compatto(corrente?.cvd)}</span> <span style={{ color: VIOLA }}>●</span></span>
            <span className="text-slate-400">Bid: <span className="text-white">{compatto(corrente?.bidLiq)}</span> <span style={{ color: VERDE }}>●</span></span>
            <span className="text-slate-400">Ask: <span className="text-white">{compatto(corrente?.askLiq)}</span> <span style={{ color: ROSSO }}>●</span></span>
            <span className="text-slate-400">
              Sbilancio:{' '}
              <span style={{ color: sbil == null ? undefined : sbil >= 0 ? VERDE : ROSSO }} className={sbil == null ? 'text-white' : ''}>
                {sbil == null ? '—' : `${sbil >= 0 ? '+' : ''}${sbil.toFixed(0)}%`}
              </span>
            </span>
            {corrente && <span className="text-xs text-slate-500 font-normal">{corrente.levels} livelli per lato</span>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 text-xs">
            <Selettore
              titolo="Finestra"
              valore={finestra}
              opzioni={[['15', '15 min'], ['60', '1 ora'], ['180', '3 ore']]}
              onChange={cambiaFinestra}
            />
            <div className="flex items-center gap-2">
              <span className="text-slate-500">Ordini limit</span>
              <button
                onClick={cambiaOrdini}
                className={`px-2 py-0.5 rounded-lg font-bold border ${
                  mostraOrdini ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
                title={mostraOrdini ? 'Nascondi le linee degli ordini limit' : 'Mostra le linee degli ordini limit'}
              >
                {mostraOrdini ? 'ON' : 'OFF'}
              </button>
              <label className={`flex items-center gap-2 ${mostraOrdini ? '' : 'opacity-40'}`} title="Da quanti contratti in su un livello diventa una linea">
                <input
                  type="range"
                  min={SOGLIA_MIN}
                  max={SOGLIA_MAX}
                  step={10}
                  value={soglia}
                  disabled={!mostraOrdini}
                  onChange={(e) => cambiaSoglia(Number(e.target.value))}
                  className="w-32 accent-slate-400"
                />
                <span className="text-white font-bold tabular-nums w-10">≥{soglia}</span>
              </label>
            </div>
            <label className={`flex items-center gap-2 ${mostraOrdini ? '' : 'opacity-40'}`}>
              <span className="text-slate-500">Spessore</span>
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.5}
                value={spessore}
                disabled={!mostraOrdini}
                onChange={(e) => cambiaSpessore(Number(e.target.value))}
                className="w-24 accent-slate-400"
              />
              <span className="text-white font-bold tabular-nums w-8">{spessore}×</span>
            </label>
            <button
              onClick={cambiaRange}
              disabled={quantiRange === 0}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-2 border ${
                mostraRange && quantiRange > 0 ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
              }`}
              title={
                quantiRange === 0
                  ? "Nessun range di oggi: calcolalo o applicalo nel grafico principale (/market)"
                  : mostraRange
                    ? 'Nascondi i range ES del grafico principale'
                    : 'Mostra i range ES del grafico principale'
              }
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: mostraRange && quantiRange > 0 ? '#3b82f6' : '#475569' }} />
              Range {quantiRange === 0 ? '—' : mostraRange ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={cambiaCvd}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-2 border ${
                mostraCvd ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
              }`}
              title={mostraCvd ? 'Nascondi il CVD' : 'Mostra il CVD'}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: mostraCvd ? VIOLA : '#475569' }} /> CVD {mostraCvd ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={tornaLive}
              disabled={!bloccato}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-2 border ${
                bloccato
                  ? 'bg-amber-600 border-amber-500 text-white hover:bg-amber-500'
                  : 'bg-slate-900 border-slate-700 text-emerald-400 cursor-default'
              }`}
              title={bloccato ? 'Torna a seguire i dati (anche doppio clic sul grafico)' : 'La vista segue i dati'}
            >
              {bloccato ? (
                <>
                  <span className="w-2 h-2 bg-white rounded-full animate-pulse" /> RESTORE LIVE VIEW
                </>
              ) : (
                <>
                  <span className="w-2 h-2 bg-emerald-400 rounded-full" /> LIVE
                </>
              )}
            </button>
            <span className="text-slate-500">
              Rotella sul grafico = zoom sul tempo · rotella su un asse Y = zoom su quell&apos;asse · trascina = sposta · doppio clic = torna live
            </span>
          </div>

          {caricato && (errore || points.length === 0 || fermo) && (
            <div className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/90">
              {soloLocale
                ? 'Questa pagina funziona solo in locale: i dati li manda Bookmap al dashboard sul PC. Aprila da http://localhost:3000/bookmap.'
                : errore
                ? 'La route /api/bookmap non risponde.'
                : points.length === 0
                  ? "Nessun dato oggi. In Bookmap: costruisci execution/bookmap_addon.py dal code editor (runtime: il python.exe di sistema) e attivalo sul grafico di ES."
                  : `Ultimo campione ${ritardo}s fa: Bookmap o l'add-on sono fermi (o il mercato e' chiuso).`}
            </div>
          )}

          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Prezzo e CVD</div>
          <div className="relative h-[340px] md:h-[400px]">
            <canvas ref={prezzoRef} className="cursor-crosshair" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mt-4 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              Sbilancio della liquidita&apos; · {corrente?.levels ?? 10} livelli per lato · sopra zero piu&apos; bid, sotto piu&apos; ask
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <Selettore
                titolo="Media"
                valore={mediaLiq}
                opzioni={[['1', 'Off'], ['10', '10 s'], ['30', '30 s'], ['60', '60 s']]}
                onChange={cambiaMediaLiq}
              />
              <button
                onClick={cambiaBidAsk}
                className={`px-2 py-0.5 rounded-lg font-bold border ${
                  mostraBidAsk ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
                title="Le due linee della liquidita' bid e ask, sull'asse destro"
              >
                Bid/Ask {mostraBidAsk ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          <div className="relative h-[220px] md:h-[260px]">
            <canvas ref={liquiditaRef} className="cursor-crosshair" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mt-4 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              {vistaFlusso === 'pressione'
                ? "Pressione degli ordini limit · sopra zero bid che si accumulano o ask ritirati, sotto il contrario"
                : vistaFlusso === 'lato'
                  ? "Netto per lato (aggiunti − tolti) · sopra zero il lato si riempie, sotto si svuota"
                  : 'Ordini limit aggiunti e tolti'}
              {' '}· primi 5 livelli · ultimi {finestraFlusso} s
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <span className="flex items-center gap-3 tabular-nums font-semibold">
                {vistaFlusso === 'pressione' && <Netto testo="Pressione" valore={ultimoNetto('pressione')} />}
                {vistaFlusso === 'lato' && (
                  <>
                    <Legenda colore={VERDE} testo="Bid netto" valore={ultimoNetto('bid')} segno />
                    <Legenda colore={ROSSO} testo="Ask netto" valore={ultimoNetto('ask')} segno />
                  </>
                )}
                {vistaFlusso === 'dettaglio' && (
                  <>
                    <Legenda colore={VERDE} testo="Bid +" valore={ultimoFlusso('addB')} />
                    <Legenda colore={VERDE} tratteggio testo="Bid −" valore={ultimoFlusso('remB')} />
                    <Legenda colore={ROSSO} testo="Ask +" valore={ultimoFlusso('addA')} />
                    <Legenda colore={ROSSO} tratteggio testo="Ask −" valore={ultimoFlusso('remA')} />
                  </>
                )}
              </span>
              <Selettore
                titolo="Vista"
                valore={vistaFlusso}
                opzioni={[['pressione', 'Pressione'], ['lato', 'Per lato'], ['dettaglio', 'Dettaglio']]}
                onChange={cambiaVistaFlusso}
              />
              <Selettore
                titolo="Somma"
                valore={finestraFlusso}
                opzioni={[['10', '10 s'], ['30', '30 s'], ['60', '60 s']]}
                onChange={cambiaFinestraFlusso}
              />
              <Selettore
                titolo="Tolti"
                valore={tolti}
                opzioni={[['cancellati', 'Solo cancellati'], ['tutti', 'Cancellati + eseguiti']]}
                onChange={cambiaTolti}
              />
            </div>
          </div>
          {caricato && points.length > 0 && !conFlusso && (
            <div className="mb-1 text-xs text-amber-200/80">
              Nessun dato: l&apos;add-on in Bookmap e&apos; ancora la versione di prima. Ricostruiscilo dal code editor e riattivalo.
            </div>
          )}
          <div className="relative h-[200px] md:h-[240px]">
            <canvas ref={flussoRef} className="cursor-crosshair" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Legenda({
  colore,
  testo,
  valore,
  tratteggio = false,
  segno = false,
}: {
  colore: string;
  testo: string;
  valore: number | null;
  tratteggio?: boolean;
  segno?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-slate-400">
      <span className={`inline-block w-4 border-t-2 ${tratteggio ? 'border-dashed' : ''}`} style={{ borderColor: colore }} />
      {testo} <span className="text-white">{segno && valore != null && valore > 0 ? '+' : ''}{compatto(valore)}</span>
    </span>
  );
}

/** Il valore della pressione, colorato come la curva: verde sopra zero, rosso sotto. */
function Netto({ testo, valore }: { testo: string; valore: number | null }) {
  const colore = valore == null ? undefined : valore >= 0 ? VERDE : ROSSO;
  return (
    <span className="flex items-center gap-1.5 text-slate-400">
      {testo}{' '}
      <span style={{ color: colore }} className={valore == null ? 'text-white' : ''}>
        {valore != null && valore > 0 ? '+' : ''}
        {compatto(valore)}
      </span>
    </span>
  );
}

/** (bid − ask) / (bid + ask): +100% tutto bid, −100% tutto ask. */
function sbilancio(p: BookmapPoint): number | null {
  const tot = p.bidLiq + p.askLiq;
  return tot > 0 ? ((p.bidLiq - p.askLiq) / tot) * 100 : null;
}
