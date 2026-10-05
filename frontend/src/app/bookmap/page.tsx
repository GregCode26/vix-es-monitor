'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Chart as ChartJS, registerables, type Scale, type ScriptableContext } from 'chart.js';
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
  /** OFI del secondo per livello dal migliore (contratti, + = acquisto); null prima dell'add-on che lo calcola. */
  ofi: number[] | null;
  /** Baricentro della liquidita' bid e ask, in tick dal mid. */
  cB: number | null;
  cA: number | null;
  /** Contratti medi sul migliore bid/ask e per livello sui due lati; quota del secondo con spread a un tick. */
  q1B: number | null;
  q1A: number | null;
  qm: number | null;
  sp1: number | null;
  /** Stop scattati e assorbimenti del secondo, [prezzo, contratti, verso, 'HH:MM:SS']; null prima dell'add-on che li cerca. */
  stop: [number, number, number, string][] | null;
  abs: [number, number, number, string][] | null;
  /** Contatori per verificare il rilevamento degli stop: trade, trade con ID aggressore, esecuzioni, esecuzioni con piu' aggressori. */
  diag: { tr: number; id: number; ex: number; multi: number } | null;
}

/** Uno stop scattato o un assorbimento, sull'asse del tempo del grafico. */
interface Evento {
  x: number;
  prezzo: number;
  contratti: number;
  /** Stop: +1 in acquisto (scattati salendo), -1 in vendita. Assorbimento: +1 compratori che assorbono, -1 venditori. */
  verso: number;
}

/** Quanto a lungo la linea di uno stop resta sul grafico dopo che e' scattato, in secondi. */
const STOP_DURATA_SEC = 600;
const ARANCIO_STOP = '#fb923c';
const FUCSIA_STOP = '#e879f9';
type MinStop = '1' | '5' | '10' | '25';
type MinAss = '30' | '60' | '100' | '200';

/** Tutti gli eventi della sessione in memoria, sopra la dimensione scelta. */
function eventiDi(pts: BookmapPoint[], campo: 'stop' | 'abs', minimo: number): Evento[] {
  const out: Evento[] = [];
  for (const p of pts) {
    for (const [prezzo, contratti, verso, t] of p[campo] ?? []) {
      if (contratti >= minimo) out.push({ x: secondi(t), prezzo, contratti, verso });
    }
  }
  return out;
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
/**
 * Spazio a destra dell'ultimo campione quando la vista segue i dati, in pixel
 * (~1 cm a 96 dpi) e non in secondi: 10 secondi su una finestra di un'ora
 * erano 4 pixel, e il prezzo di adesso finiva schiacciato sul bordo.
 */
const MARGINE_DESTRO_PX = 38;

const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
const VIOLA = '#a855f7';

type Finestra = '15' | '60' | '180';
/**
 * I sei livelli R1/R2/R3 dell'Opening Bell, gia' in prezzi ES (SPX +- straddle
 * SPX delle 15:35 + basis ES-SPX di quel momento): stessi colori del grafico
 * principale. Quelli del mattino non si disegnano: questa pagina e' sul
 * pomeriggio americano. Qui non si calcolano, si leggono.
 */
const RANGE_ES = ([
  ['r1Down', '#ef4444', 'R1↓'],
  ['r2Down', '#f97316', 'R2↓'],
  ['r3Down', '#facc15', 'R3↓'],
  ['r1Up', '#3b82f6', 'R1↑'],
  ['r2Up', '#06b6d4', 'R2↑'],
  ['r3Up', '#10b981', 'R3↑'],
] as const).map(([chiave, colore, etichetta]) => ({
  key: `${chiave}Ob`,
  colore,
  etichetta: `${etichetta} OB`,
  tratteggio: [] as number[],
}));

/** Ogni quanto richiedere i range al server finche' quelli delle 15:35 non ci sono. */
const RANGE_RETRY_MS = 60_000;

/** Da quanti contratti in su un livello del book diventa una linea: il cursore va da SOGLIA_MIN a SOGLIA_MAX. */
const SOGLIA_MIN = 50;
const SOGLIA_MAX = 200;
/** Tick di ES: lo spessore di una linea e' un livello di prezzo. */
const TICK = 0.25;
/** Due campioni del book piu' distanti di cosi' (secondi) spezzano la linea. */
const BUCO_MAX_SEC = 3;

/**
 * Ordini limit piu' brevi di cosi' (secondi) non diventano linee. Il "muro di
 * liquidita'" che compare e sparisce non e' un muro: oltre il 90% degli ordini
 * degli algoritmi viene cancellato entro pochi secondi.
 */
type DurataMin = '0' | '5' | '15' | '60';

/** Finestra del grafico del book: media (asimmetria, sbilancio) o somma (OFI); '1' = il dato secondo per secondo. */
type MediaLiq = '1' | '10' | '30' | '60';

/**
 * Cosa mostra il grafico del book.
 * - mlofi: Order Flow Imbalance multilivello, come cambia il book (la pressione vera)
 * - asimmetria: dove sta la liquidita' dei due lati rispetto al mid
 * - ofiPct: lo stesso MLOFI su scala fissa ±100, come percentile di sessione
 * - statico: bid contro ask esposti, lo sbilancio di prima (fuorviante da solo)
 */
type VistaBook = 'mlofi' | 'ofiPct' | 'asimmetria' | 'statico';
/** Oltre questo valore di OFI % la pressione e' estrema rispetto alla sessione: le linee tratteggiate. */
const ZONA_ESTREMA = 80;
/** Sotto questi campioni (5 minuti) il percentile non ha ancora una sessione con cui confrontarsi. */
const MIN_CAMPIONI_PCT = 300;

/**
 * MLOFI come percentile di sessione, da −100 a +100: il modulo di ogni valore
 * confrontato con i moduli di tutti quelli PRIMA di lui (cosi' lo storico
 * mostra quello che si sarebbe visto live, senza guardare avanti), con il
 * segno rimesso. +85 = pressione in acquisto piu' forte dell'85% delle
 * letture della sessione. Sul modulo e non sul valore: con un percentile
 * semplice lo zero finirebbe sulla mediana, che in una giornata in trend non
 * e' zero, e un flusso in acquisto sotto la mediana risulterebbe rosso.
 */
function ofiPercentile(valori: number[]): number[] {
  const ordinati: number[] = [];
  const primoMaggiore = (x: number, compreso: boolean) => {
    let lo = 0;
    let hi = ordinati.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ordinati[m] < x || (compreso && ordinati[m] === x)) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return valori.map((v) => {
    if (!Number.isFinite(v)) return NaN;
    const a = Math.abs(v);
    const n = ordinati.length;
    const sotto = primoMaggiore(a, false);
    const finoA = primoMaggiore(a, true);
    ordinati.splice(finoA, 0, a);
    if (n < MIN_CAMPIONI_PCT) return NaN;
    // I pari contano a meta': un valore uguale a tutti gli altri sta a 50.
    return Math.sign(v) * ((sotto + (finoA - sotto) / 2) / n) * 100;
  });
}
/** Quanti livelli sommare nell'OFI: 1 e' l'OFI classico del solo migliore. L'add-on ne manda 15. */
type LivelliOfi = '1' | '5' | '10' | '15';
const LIVELLI_OFI_MAX = 15;
/** Sotto questa finestra (secondi) le schede della lettura sarebbero solo rumore. */
const LETTURA_MIN_SEC = 10;
/** Regime e profondita' si giudicano sull'ultimo minuto. */
const REGIME_SEC = 60;

/**
 * OFI di un campione sui primi `n` livelli (contratti) e la coda media con cui
 * normalizzarlo: quella del migliore per l'OFI a un livello, la media per
 * livello dei primi 15 per il multilivello. Null nei campioni senza OFI.
 */
function ofiPunto(p: BookmapPoint, n: number): { e: number; q: number } | null {
  if (!p.ofi) return null;
  const q = n === 1 ? (p.q1B != null && p.q1A != null ? (p.q1B + p.q1A) / 2 : null) : p.qm;
  if (q == null || q <= 0) return null;
  let e = 0;
  for (let m = 0; m < n && m < p.ofi.length; m++) e += p.ofi[m];
  return { e, q };
}

/**
 * MLOFI sugli ultimi `finestraSec` secondi, in code medie: la somma dell'OFI
 * dei primi `n` livelli divisa per `n` volte la coda media della finestra
 * (come l'OFI integrato di Cont, Cucuringu e Zhang con pesi uguali). Cosi'
 * +2 vuol dire "e' entrata pressione in acquisto per due code intere", con lo
 * stesso significato a un livello o a quindici, di giorno o di notte.
 */
function mlofiMobile(pts: BookmapPoint[], xs: number[], finestraSec: number, n: number): number[] {
  const valori = pts.map((p) => ofiPunto(p, n));
  const out: number[] = [];
  let j = 0;
  let sommaE = 0;
  let sommaQ = 0;
  let k = 0;
  for (let i = 0; i < pts.length; i++) {
    const v = valori[i];
    if (v) {
      sommaE += v.e;
      sommaQ += v.q;
      k++;
    }
    while (xs[j] <= xs[i] - finestraSec) {
      const w = valori[j];
      if (w) {
        sommaE -= w.e;
        sommaQ -= w.q;
        k--;
      }
      j++;
    }
    out.push(v && k > 0 ? sommaE / (n * (sommaQ / k)) : NaN);
  }
  return out;
}

/**
 * Asimmetria del book, dai baricentri gia' mediati: (ask − bid) / (ask + bid).
 * Positiva quando la liquidita' ask sta piu' lontana dal mid di quella bid (il
 * lato ask si ritira), negativa quando e' il bid ad allontanarsi: e' la
 * quotazione asimmetrica del market maker di Avellaneda e Stoikov, che con un
 * inventario lungo avvicina l'ask e allontana il bid.
 */
function asimmetria(cB: number, cA: number): number {
  return cA + cB > 0 ? ((cA - cB) / (cA + cB)) * 100 : NaN;
}

function mediana(valori: number[]): number | null {
  if (valori.length === 0) return null;
  const s = [...valori].sort((a, b) => a - b);
  const meta = Math.floor(s.length / 2);
  return s.length % 2 ? s[meta] : (s[meta - 1] + s[meta]) / 2;
}

function media(valori: (number | null)[]): number | null {
  const finiti = valori.filter((v): v is number => v != null && Number.isFinite(v));
  return finiti.length > 0 ? finiti.reduce((a, b) => a + b, 0) / finiti.length : null;
}

/** Le risposte alle domande con cui il video chiude, sugli ultimi campioni. */
interface Lettura {
  /** Quota del tempo con spread a un tick e coda media sul migliore, ultimo minuto. */
  sp1: number | null;
  q1: number | null;
  /** Coda media per livello nell'ultimo minuto e la sua mediana di sessione. */
  qm: number | null;
  qmMediana: number | null;
  cB: number | null;
  cA: number | null;
  asim: number | null;
  /** MLOFI della finestra, in code medie. */
  mlofi: number | null;
  /** |somma| / somma dei moduli dell'OFI secondo per secondo: 1 = sempre dalla stessa parte, 0 = avanti e indietro. */
  persistenza: number | null;
  /** Quota degli ordini aggiunti nei primi 5 livelli poi cancellati (non eseguiti). */
  fugaci: number | null;
  /** OFI di ciascun livello nella finestra, in code medie. */
  livelli: (number | null)[];
  finestraSec: number;
  /** Il MLOFI di adesso come percentile di sessione (OFI %); null nei primi minuti. */
  forza: number | null;
}

function lettura(pts: BookmapPoint[], finestraSec: number, n: number, qmMediana: number | null, forza: number | null): Lettura | null {
  if (pts.length === 0) return null;
  const fine = secondi(pts[pts.length - 1].time);
  const ultimi = (sec: number) => {
    const out: BookmapPoint[] = [];
    for (let i = pts.length - 1; i >= 0 && secondi(pts[i].time) > fine - sec; i--) out.push(pts[i]);
    return out;
  };
  const minuto = ultimi(REGIME_SEC);
  const fin = ultimi(finestraSec);

  const q1 = media(minuto.map((p) => (p.q1B != null && p.q1A != null ? (p.q1B + p.q1A) / 2 : null)));
  const cB = media(fin.map((p) => p.cB));
  const cA = media(fin.map((p) => p.cA));

  const conOfi = fin.map((p) => ofiPunto(p, n)).filter((v): v is { e: number; q: number } => !!v);
  let mlofi: number | null = null;
  let persistenza: number | null = null;
  const qMedia = media(fin.map((p) => p.qm));
  if (conOfi.length > 0) {
    const somma = conOfi.reduce((a, v) => a + v.e, 0);
    const moduli = conOfi.reduce((a, v) => a + Math.abs(v.e), 0);
    const q = conOfi.reduce((a, v) => a + v.q, 0) / conOfi.length;
    mlofi = somma / (n * q);
    persistenza = moduli > 0 ? Math.abs(somma) / moduli : null;
  }
  const livelli = Array.from({ length: LIVELLI_OFI_MAX }, (_, m) => {
    const conLivello = fin.filter((p) => p.ofi && p.ofi.length > m);
    if (conLivello.length === 0 || !qMedia) return null;
    return conLivello.reduce((a, p) => a + p.ofi![m], 0) / qMedia;
  });

  const conFlusso = fin.filter((p) => p.addB != null && p.remB != null && p.addA != null && p.remA != null);
  let fugaci: number | null = null;
  if (conFlusso.length > 0) {
    const s = (f: (p: BookmapPoint) => number) => conFlusso.reduce((a, p) => a + f(p), 0);
    const aggiunti = s((p) => p.addB! + p.addA!);
    // Tolti meno eseguiti: i venditori aggressivi consumano i bid, i compratori gli ask.
    const cancellati = Math.max(0, s((p) => p.remB!) - s((p) => p.sell)) + Math.max(0, s((p) => p.remA!) - s((p) => p.buy));
    fugaci = aggiunti > 0 ? cancellati / aggiunti : null;
  }

  return {
    sp1: media(minuto.map((p) => p.sp1)),
    q1,
    qm: media(minuto.map((p) => p.qm)),
    qmMediana,
    cB,
    cA,
    asim: cB != null && cA != null ? asimmetria(cB, cA) : null,
    mlofi,
    persistenza,
    fugaci,
    livelli,
    finestraSec,
    forza,
  };
}

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
 * - rotazione: quanta parte degli ordini aggiunti viene poi cancellata invece
 *   che eseguita, per lato. Vicino al 100% la liquidita' e' fugace: ordini
 *   messi per saggiare il book, non per essere eseguiti.
 */
type VistaFlusso = 'pressione' | 'lato' | 'dettaglio' | 'rotazione';

/** Cancellati / aggiunti in %, per lato; NaN dove non si e' aggiunto niente. */
function rotazione(fl: SerieFlusso) {
  const quota = (tolti: number[], aggiunti: number[]) => tolti.map((v, i) => (aggiunti[i] > 0 ? (v / aggiunti[i]) * 100 : NaN));
  return { bid: quota(fl.remB, fl.addB), ask: quota(fl.remA, fl.addA) };
}

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
 * Quelli rimasti meno di `durataMin` secondi si scartano: sono gli ordini
 * fugaci, che fanno sembrare un muro quello che un attimo dopo non c'e' piu'.
 * Uno ancora aperto compare quando ha superato la durata.
 */
function segmentiBook(pts: BookmapPoint[], xs: number[], soglia: number, durataMin: number): Segmento[] {
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
  // Un campione vale un secondo: una linea da..a copre a − da + 1 secondi.
  return [...chiusi, ...aperti.values()].filter((s) => s.a - s.da + 1 >= durataMin);
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

/** Un valore dell'asse del book: l'OFI in code medie, asimmetria e sbilancio in %. */
function valoreBook(v: number, vista: VistaBook) {
  if (vista === 'mlofi') return `${v > 0 ? '+' : ''}${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)}`;
  if (vista === 'ofiPct') return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  return `${Math.round(v)}%`;
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
  const [vistaBook, setVistaBook] = useState<VistaBook>('mlofi');
  const [livelliOfi, setLivelliOfi] = useState<LivelliOfi>('10');
  const [durataMin, setDurataMin] = useState<DurataMin>('5');
  const [mostraStop, setMostraStop] = useState(true);
  const [mostraAss, setMostraAss] = useState(true);
  const [minStop, setMinStop] = useState<MinStop>('5');
  const [minAss, setMinAss] = useState<MinAss>('60');

  /** L'ultimo OFI %, calcolato in `applica` insieme alla linea. */
  const [ofiPctOra, setOfiPctOra] = useState<number | null>(null);

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
  const vistaBookRef = useRef<VistaBook>('mlofi');
  const livelliOfiRef = useRef<LivelliOfi>('10');
  const durataMinRef = useRef<DurataMin>('5');
  const mostraStopRef = useRef(true);
  const mostraAssRef = useRef(true);
  const minStopRef = useRef<MinStop>('5');
  const minAssRef = useRef<MinAss>('60');
  /** Stop e assorbimenti da disegnare, gia' filtrati per dimensione. */
  const eventiRef = useRef<{ stop: Evento[]; abs: Evento[] }>({ stop: [], abs: [] });
  const segmentiRef = useRef<Segmento[]>([]);
  /** Secondi visibili scelti con la rotella in LIVE; null = quelli della finestra selezionata. */
  const ampiezzaRef = useRef<number | null>(null);
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
    const vistaBook = vistaBookRef.current;
    const mlofi = mlofiMobile(pts, xs, w, Number(livelliOfiRef.current));
    cl.data.datasets[3].data = xs.map((x, i) => ({ x, y: mlofi[i] }));
    const cBM = mediaMobile(xs, pts.map((p) => p.cB ?? NaN), w);
    const cAM = mediaMobile(xs, pts.map((p) => p.cA ?? NaN), w);
    const asimM = cBM.map((v, i) => asimmetria(v, cAM[i]));
    cl.data.datasets[4].data = xs.map((x, i) => ({ x, y: asimM[i] }));
    // Il percentile costa un ordinamento della sessione: solo quando lo si guarda.
    const ofiPct = vistaBook === 'ofiPct' ? ofiPercentile(mlofi) : [];
    cl.data.datasets[5].data = ofiPct.map((y, i) => ({ x: xs[i], y }));
    const ultimoPct = ofiPct.length > 0 ? ofiPct[ofiPct.length - 1] : NaN;
    setOfiPctOra(Number.isFinite(ultimoPct) ? ultimoPct : null);
    const bidAsk = mostraBidAskRef.current && vistaBook === 'statico';
    cl.data.datasets[0].hidden = vistaBook !== 'statico';
    cl.data.datasets[1].hidden = !bidAsk;
    cl.data.datasets[2].hidden = !bidAsk;
    cl.data.datasets[3].hidden = vistaBook !== 'mlofi';
    cl.data.datasets[4].hidden = vistaBook !== 'asimmetria';
    cl.data.datasets[5].hidden = vistaBook !== 'ofiPct';
    const asseLiq = cl.options.scales!.yLiq!;
    asseLiq.ticks!.display = bidAsk;
    const fl = flussoMobile(pts, xs, Number(finestraFlussoRef.current), toltiRef.current === 'cancellati');
    // La rotazione ha senso solo sui cancellati: un ordine eseguito non e' fugace.
    const rot = rotazione(toltiRef.current === 'cancellati' ? fl : flussoMobile(pts, xs, Number(finestraFlussoRef.current), true));
    cf.data.datasets[7].data = xs.map((x, i) => ({ x, y: rot.bid[i] }));
    cf.data.datasets[8].data = xs.map((x, i) => ({ x, y: rot.ask[i] }));
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
    cf.data.datasets[7].hidden = vista !== 'rotazione';
    cf.data.datasets[8].hidden = vista !== 'rotazione';

    let da: number;
    let a: number;
    if (!b.x && xs.length > 0) {
      // L'ultimo campione cade MARGINE_DESTRO_PX prima del bordo destro
      // dell'area del grafico, qualunque sia la finestra e la larghezza.
      const ampiezza = ampiezzaRef.current ?? Number(finestraRef.current) * 60;
      const larghezza = cp.chartArea ? cp.chartArea.right - cp.chartArea.left : cp.width - 2 * LARGHEZZA_ASSE;
      const margine = larghezza > MARGINE_DESTRO_PX * 2 ? (ampiezza * MARGINE_DESTRO_PX) / larghezza : 0;
      a = xs[xs.length - 1] + margine;
      da = a - ampiezza;
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
    segmentiRef.current = mostraOrdiniRef.current ? segmentiBook(pts, xs, sogliaRef.current, Number(durataMinRef.current)) : [];
    eventiRef.current = {
      stop: mostraStopRef.current ? eventiDi(pts, 'stop', Number(minStopRef.current)) : [],
      abs: mostraAssRef.current ? eventiDi(pts, 'abs', Number(minAssRef.current)) : [],
    };

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
      // Il segnale della vista scelta: tutti e tre vivono attorno allo zero.
      const segnale = vistaBook === 'mlofi' ? mlofi : vistaBook === 'asimmetria' ? asimM : sbilM;
      let massimoSbil = 0;
      xs.forEach((x, i) => {
        if (x < da || x > a) return;
        valoriLiq.push(bidM[i], askM[i]);
        if (Number.isFinite(segnale[i])) massimoSbil = Math.max(massimoSbil, Math.abs(segnale[i]));
      });
      const rl = estremi(valoriLiq, 0.1);
      sl.yLiq!.min = rl?.min;
      sl.yLiq!.max = rl?.max;
      // Simmetrico attorno allo zero, stretto su quello che si vede: con -100/+100
      // fissi uno sbilancio del 20% era una riga piatta. L'OFI e' in code medie,
      // numeri piccoli: niente arrotondamento a 5.
      // L'OFI % invece e' fisso: e' il senso della vista, un +80 e' sempre un +80.
      const semi =
        vistaBook === 'ofiPct'
          ? 100
          : vistaBook === 'mlofi'
            ? Math.max(0.5, Math.ceil(massimoSbil * 1.15 * 2) / 2)
            : Math.max(5, Math.ceil((massimoSbil * 1.15) / 5) * 5);
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
        else if (vista === 'rotazione') valori.push(rot.bid[i], rot.ask[i]);
        else valori.push(netti.pressione[i]);
      });
      const asse = cf.options.scales!.yFlusso!;
      if (vista === 'rotazione') {
        // Da 0 ad almeno 100%: la riga del 100% ("tutto cancellato") deve restare in vista.
        asse.min = 0;
        asse.max = Math.max(100, Math.ceil((estremi(valori, 0.05)?.max ?? 100) / 10) * 10);
      } else if (vista === 'dettaglio') {
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
    ampiezzaRef.current = null;
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
          // In LIVE la rotella sul grafico non sgancia il tempo: cambia solo
          // quanto tempo si vede, e il prezzo di adesso resta a MARGINE_DESTRO_PX
          // dal bordo. Prima la bloccava, e bastava un giro di rotella (anche
          // solo per scorrere la pagina) perche' il prezzo uscisse a destra.
          // Il tempo si sgancia solo trascinando, per guardare indietro.
          onZoomStart: ({ chart, point }) => {
            const area = chart.chartArea;
            const suAsseY = point.x != null && (point.x < area.left || point.x > area.right);
            if (suAsseY) impostaBlocco({ ...bloccoRef.current, [quale(chart as ChartJS)]: true });
            return true;
          },
          onZoomComplete: ({ chart }) => {
            const x = chart.scales.x;
            if (!bloccoRef.current.x && x) ampiezzaRef.current = Math.max(30, x.max - x.min);
            allinea(chart as ChartJS);
          },
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

      /**
       * Stop e assorbimenti, sopra la linea del prezzo.
       * - Stop: linea orizzontale al prezzo dove sono scattati, per
       *   STOP_DURATA_SEC da quel momento; arancio in acquisto (scattati
       *   salendo), fucsia in vendita; piu' spessa con piu' contratti.
       * - Assorbimento: una palla, verde se i compratori passivi hanno
       *   assorbito le vendite, rossa se i venditori hanno assorbito gli
       *   acquisti; l'area e' proporzionale ai contratti.
       * Col mouse sopra, il riquadro con prezzo, contratti e ora.
       */
      const eventiPlugin = {
        id: 'eventi',
        afterDatasetsDraw: (chart: ChartJS) => {
          const { stop, abs } = eventiRef.current;
          const sx = chart.scales.x;
          const sy = chart.scales.yPrezzo;
          if ((stop.length === 0 && abs.length === 0) || !sx || !sy) return;
          const { ctx, chartArea: a } = chart;
          const m = mirinoRef.current?.sorgente === chart ? mirinoRef.current : null;
          const mx = m ? sx.getPixelForValue(m.sec) : null;
          let sotto: { testo: string; x: number; y: number } | null = null;
          ctx.save();
          ctx.beginPath();
          ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
          ctx.clip();

          ctx.font = 'bold 9px Arial';
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'left';
          for (const e of stop) {
            const x1 = sx.getPixelForValue(e.x);
            const x2 = sx.getPixelForValue(e.x + STOP_DURATA_SEC);
            if (x2 < a.left || x1 > a.right) continue;
            const y = sy.getPixelForValue(e.prezzo);
            if (y < a.top || y > a.bottom) continue;
            const colore = e.verso > 0 ? ARANCIO_STOP : FUCSIA_STOP;
            ctx.strokeStyle = colore;
            ctx.lineWidth = Math.min(4, 1.5 + Math.sqrt(e.contratti) / 4);
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.stroke();
            ctx.fillStyle = colore;
            ctx.fillText(`${e.verso > 0 ? '▲' : '▼'} STOP ${e.contratti}`, x1 + 2, y - 2);
            if (m && mx != null && mx >= x1 - 4 && mx <= x2 && Math.abs(m.y - y) <= 5) {
              sotto = {
                testo: `Stop ${e.verso > 0 ? 'in acquisto' : 'in vendita'}: ${e.contratti} ct a ${e.prezzo.toFixed(2)} · ${orario(e.x)}`,
                x: x1,
                y,
              };
            }
          }

          for (const e of abs) {
            const x = sx.getPixelForValue(e.x);
            const y = sy.getPixelForValue(e.prezzo);
            if (x < a.left - 20 || x > a.right + 20 || y < a.top - 20 || y > a.bottom + 20) continue;
            const r = Math.min(20, Math.max(4, Math.sqrt(e.contratti) * 0.9));
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = e.verso > 0 ? 'rgba(52, 211, 153, 0.55)' : 'rgba(244, 63, 94, 0.55)';
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.stroke();
            if (m && mx != null && Math.hypot(mx - x, m.y - y) <= r + 2) {
              sotto = {
                testo: `Assorbimento: ${e.contratti} ct a ${e.prezzo.toFixed(2)}, ${
                  e.verso > 0 ? 'compratori assorbono le vendite' : 'venditori assorbono gli acquisti'
                } · ${orario(e.x)}`,
                x,
                y: y - r,
              };
            }
          }
          ctx.restore();

          if (sotto) {
            ctx.save();
            ctx.font = '11px Arial';
            const w = ctx.measureText(sotto.testo).width + 12;
            let bx = sotto.x + 8;
            if (bx + w > a.right) bx = a.right - w;
            const by = Math.max(a.top, sotto.y - 26);
            ctx.fillStyle = 'rgba(15, 17, 26, 0.95)';
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
            ctx.fillRect(bx, by, w, 20);
            ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 19);
            ctx.fillStyle = '#e2e8f0';
            ctx.textBaseline = 'middle';
            ctx.fillText(sotto.testo, bx + 6, by + 10);
            ctx.restore();
          }
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
                scala.id === 'yPrezzo'
                  ? v.toFixed(2)
                  : scala.id === 'ySbil'
                    ? valoreBook(v, vistaBookRef.current)
                    : scala.id === 'yFlusso' && vistaFlussoRef.current === 'rotazione'
                      ? `${Math.round(v)}%`
                      : compatto(v);
              etichetta(testo, (scala.left + scala.right) / 2, m.y, scala.right - scala.left);
            }
          }
          ctx.restore();
        },
      };

      chartPrezzo.current = new ChartJS(prezzoRef.current, {
        type: 'line',
        plugins: [ordini, range, eventiPlugin, mirino],
        data: {
          datasets: [
            {
              label: 'ES',
              data: [],
              yAxisID: 'yPrezzo',
              borderColor: GIALLO,
              borderWidth: 1.4,
              // Solo l'ultimo campione ha il pallino: il prezzo di adesso.
              pointRadius: (ctx: ScriptableContext<'line'>) => (ctx.dataIndex === ctx.dataset.data.length - 1 ? 3.5 : 0),
              pointBackgroundColor: GIALLO,
              pointBorderWidth: 0,
              tension: 0,
            },
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

      /**
       * Le zone estreme dell'OFI %: fondo appena colorato oltre ±ZONA_ESTREMA
       * e la linea tratteggiata sul confine. Sotto le linee dei dati.
       */
      const zoneEstreme = {
        id: 'zoneEstreme',
        beforeDatasetsDraw: (chart: ChartJS) => {
          const sy = chart.scales.ySbil;
          if (vistaBookRef.current !== 'ofiPct' || !sy) return;
          const { ctx, chartArea: a } = chart;
          ctx.save();
          ctx.beginPath();
          ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
          ctx.clip();
          for (const [livello, colore, bordo] of [
            [ZONA_ESTREMA, 'rgba(52, 211, 153, 0.07)', sy.getPixelForValue(100)],
            [-ZONA_ESTREMA, 'rgba(244, 63, 94, 0.07)', sy.getPixelForValue(-100)],
          ] as const) {
            const y = sy.getPixelForValue(livello);
            ctx.fillStyle = colore;
            ctx.fillRect(a.left, Math.min(y, bordo), a.right - a.left, Math.abs(bordo - y));
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = livello > 0 ? 'rgba(52, 211, 153, 0.6)' : 'rgba(244, 63, 94, 0.6)';
            ctx.moveTo(a.left, y);
            ctx.lineTo(a.right, y);
            ctx.stroke();
          }
          ctx.restore();
        },
      };

      chartLiquidita.current = new ChartJS(liquiditaRef.current, {
        type: 'line',
        plugins: [zoneEstreme, mirino],
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
            // Le altre due viste usano lo stesso asse sinistro, con la stessa lettura: sopra verde, sotto rosso.
            {
              label: 'MLOFI',
              data: [],
              yAxisID: 'ySbil',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
              fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.28)', below: 'rgba(244, 63, 94, 0.28)' },
              segment: { borderColor: (ctx) => ((ctx.p1.parsed.y ?? 0) >= 0 ? VERDE : ROSSO) },
            },
            {
              label: 'Asimmetria %',
              data: [],
              yAxisID: 'ySbil',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
              fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.28)', below: 'rgba(244, 63, 94, 0.28)' },
              segment: { borderColor: (ctx) => ((ctx.p1.parsed.y ?? 0) >= 0 ? VERDE : ROSSO) },
            },
            {
              label: 'OFI %',
              data: [],
              yAxisID: 'ySbil',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
              fill: { target: 'origin', above: 'rgba(52, 211, 153, 0.28)', below: 'rgba(244, 63, 94, 0.28)' },
              segment: { borderColor: (ctx) => ((ctx.p1.parsed.y ?? 0) >= 0 ? VERDE : ROSSO) },
            },
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
              ticks: { color: '#94a3b8', callback: (v) => valoreBook(Number(v), vistaBookRef.current) },
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
            { label: 'Bid cancellati %', data: [], yAxisID: 'yFlusso', borderColor: VERDE, borderWidth: 1.6, pointRadius: 0, tension: 0.2 },
            { label: 'Ask cancellati %', data: [], yAxisID: 'yFlusso', borderColor: ROSSO, borderWidth: 1.6, pointRadius: 0, tension: 0.2 },
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
              // Marcata la riga di riferimento: lo zero, o il 100% ("tutto cancellato") nella rotazione.
              grid: {
                color: (ctx) =>
                  ctx.tick.value === (vistaFlussoRef.current === 'rotazione' ? 100 : 0)
                    ? 'rgba(255, 255, 255, 0.35)'
                    : 'rgba(255, 255, 255, 0.05)',
              },
              ticks: {
                color: '#94a3b8',
                callback: (v) => (vistaFlussoRef.current === 'rotazione' ? `${Math.round(Number(v))}%` : compatto(Number(v))),
              },
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
      ? segmentiBook(pts, pts.map((p) => secondi(p.time)), sogliaRef.current, Number(durataMinRef.current))
      : [];
    chartPrezzo.current?.draw();
  };

  // I livelli vengono dal server (/api/market?history=true, campo `range.ob`),
  // calcolati sugli stessi dati del poller che usa il pannello Range di
  // /market: prima si leggevano solo dal localStorage che scrive /market, e
  // se quella pagina non era stata aperta oggi in questo browser le linee
  // non c'erano. Il localStorage resta piu' forte (modifiche fatte a mano nel
  // pannello, come in /gex) e decide la visibilita'; si rilegge quando cambia
  // in un'altra scheda e quando si torna qui.
  useEffect(() => {
    try {
      if (localStorage.getItem('bookmap_range') === 'off') {
        mostraRangeRef.current = false;
        setMostraRange(false);
      }
    } catch {
      // niente preferenza salvata
    }
    let dalServer: Record<string, string> = {};
    let fermo = false;
    const rileggi = () => {
      const valori = { ...dalServer, ...Object.fromEntries(Object.entries(leggiRefLines() ?? {}).filter(([, v]) => v)) };
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
    // Prima delle 15:35 il server non ha ancora range.ob: si riprova ogni
    // minuto e ci si ferma appena arriva (lo storico pesa ~400 KB, inutile
    // riscaricarlo per livelli che per il resto della giornata non cambiano).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const chiediAlServer = async () => {
      let trovati = false;
      try {
        const res = await fetch('/api/market?history=true', { cache: 'no-store' });
        if (res.ok) {
          const ob = (await res.json())?.range?.ob as Record<string, number> | null | undefined;
          if (ob && !fermo) {
            dalServer = Object.fromEntries(RANGE_ES.flatMap((r) => {
              const v = ob[r.key.replace(/Ob$/, '')];
              return typeof v === 'number' && Number.isFinite(v) ? [[r.key, v.toFixed(2)]] : [];
            }));
            trovati = true;
            rileggi();
          }
        }
      } catch (e) {
        console.error('Range fetch failed:', e);
      }
      if (!trovati && !fermo) timer = setTimeout(chiediAlServer, RANGE_RETRY_MS);
    };
    chiediAlServer();
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
      fermo = true;
      if (timer) clearTimeout(timer);
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
      if (v === 'pressione' || v === 'lato' || v === 'dettaglio' || v === 'rotazione') {
        vistaFlussoRef.current = v;
        setVistaFlusso(v);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  // Vista del book, livelli dell'OFI e durata minima delle linee si ricordano come la vista del flusso.
  useEffect(() => {
    try {
      const v = localStorage.getItem('bookmap_vista_book');
      if (v === 'mlofi' || v === 'ofiPct' || v === 'asimmetria' || v === 'statico') {
        vistaBookRef.current = v;
        setVistaBook(v);
      }
      const l = localStorage.getItem('bookmap_livelli_ofi');
      if (l === '1' || l === '5' || l === '10' || l === '15') {
        livelliOfiRef.current = l;
        setLivelliOfi(l);
      }
      const d = localStorage.getItem('bookmap_durata_min');
      if (d === '0' || d === '5' || d === '15' || d === '60') {
        durataMinRef.current = d;
        setDurataMin(d);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  const salva = (chiave: string, valore: string) => {
    try {
      localStorage.setItem(chiave, valore);
    } catch {
      // la preferenza vale solo per questa visita
    }
  };

  const cambiaVistaBook = (v: VistaBook) => {
    vistaBookRef.current = v;
    setVistaBook(v);
    salva('bookmap_vista_book', v);
    applica();
  };

  const cambiaLivelliOfi = (v: LivelliOfi) => {
    livelliOfiRef.current = v;
    setLivelliOfi(v);
    salva('bookmap_livelli_ofi', v);
    applica();
  };

  const cambiaDurataMin = (v: DurataMin) => {
    durataMinRef.current = v;
    setDurataMin(v);
    salva('bookmap_durata_min', v);
    rifaiOrdini();
  };

  // Stop e assorbimenti: accesi o spenti e la dimensione minima, ricordati nel browser.
  useEffect(() => {
    try {
      if (localStorage.getItem('bookmap_stop') === 'off') {
        mostraStopRef.current = false;
        setMostraStop(false);
      }
      if (localStorage.getItem('bookmap_ass') === 'off') {
        mostraAssRef.current = false;
        setMostraAss(false);
      }
      const ms = localStorage.getItem('bookmap_min_stop');
      if (ms === '1' || ms === '5' || ms === '10' || ms === '25') {
        minStopRef.current = ms;
        setMinStop(ms);
      }
      const ma = localStorage.getItem('bookmap_min_ass');
      if (ma === '30' || ma === '60' || ma === '100' || ma === '200') {
        minAssRef.current = ma;
        setMinAss(ma);
      }
    } catch {
      // niente preferenza salvata
    }
  }, []);

  const cambiaMostraStop = () => {
    mostraStopRef.current = !mostraStopRef.current;
    setMostraStop(mostraStopRef.current);
    salva('bookmap_stop', mostraStopRef.current ? 'on' : 'off');
    applica();
  };

  const cambiaMostraAss = () => {
    mostraAssRef.current = !mostraAssRef.current;
    setMostraAss(mostraAssRef.current);
    salva('bookmap_ass', mostraAssRef.current ? 'on' : 'off');
    applica();
  };

  const cambiaMinStop = (v: MinStop) => {
    minStopRef.current = v;
    setMinStop(v);
    salva('bookmap_min_stop', v);
    applica();
  };

  const cambiaMinAss = (v: MinAss) => {
    minAssRef.current = v;
    setMinAss(v);
    salva('bookmap_min_ass', v);
    applica();
  };

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

  // Il metro per "book pieno" o "sottile": la coda media per livello tipica della sessione in memoria.
  const qmMediana = useMemo(() => mediana(points.flatMap((p) => (p.qm != null ? [p.qm] : []))), [points]);

  // La forza della pressione di adesso rispetto alla sessione, sulla stessa
  // finestra e sugli stessi livelli della lettura: un modulo del MLOFI in
  // code dipende da Somma e Livelli, e nessuna soglia fissa vale per tutte
  // le combinazioni (0,5 code, la prima scelta, non scattava mai: a 30 s la
  // mediana su ES e' ~7).
  const finestraLettura = Math.max(LETTURA_MIN_SEC, Number(mediaLiq));
  const forzaOra = useMemo(() => {
    const serie = ofiPercentile(mlofiMobile(points, points.map((p) => secondi(p.time)), finestraLettura, Number(livelliOfi)));
    const v = serie[serie.length - 1];
    return v != null && Number.isFinite(v) ? v : null;
  }, [points, finestraLettura, livelliOfi]);

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
  const rotazioneOra = rotazione(tolti === 'cancellati' ? flussoOra : flussoMobile(coda, coda.map((p) => secondi(p.time)), Number(finestraFlusso), true));
  const ultimaRotazione = (k: 'bid' | 'ask') => {
    const v = rotazioneOra[k][rotazioneOra[k].length - 1];
    return v == null || Number.isNaN(v) ? null : v;
  };
  const conOfi = corrente?.ofi != null;
  const conEventi = corrente?.stop != null;
  // L'ultimo minuto di contatori: dice se il feed permette di riconoscere gli stop.
  const diagMinuto = coda.slice(-60).reduce(
    (t, p) => (p.diag ? { tr: t.tr + p.diag.tr, id: t.id + p.diag.id, ex: t.ex + p.diag.ex, multi: t.multi + p.diag.multi } : t),
    { tr: 0, id: 0, ex: 0, multi: 0 },
  );
  const quotaId = diagMinuto.tr > 0 ? diagMinuto.id / diagMinuto.tr : null;
  const contaOggi = (campo: 'stop' | 'abs', minimo: number) =>
    points.reduce((n, p) => n + (p[campo] ?? []).filter((e) => e[1] >= minimo).length, 0);
  const nLivelli = Number(livelliOfi);
  const letto = lettura(coda, finestraLettura, nLivelli, qmMediana, forzaOra);

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
            <div
              className={mostraOrdini ? '' : 'opacity-40 pointer-events-none'}
              title="Nascondi gli ordini rimasti nel book meno di cosi': quelli fugaci, messi e tolti per saggiare il book, sembrano muri e non lo sono"
            >
              <Selettore
                titolo="Durata min"
                valore={durataMin}
                opzioni={[['0', 'Tutti'], ['5', '5 s'], ['15', '15 s'], ['60', '60 s']]}
                onChange={cambiaDurataMin}
              />
            </div>
            <div className="flex items-center gap-2" title="Ordini stop scattati: linee orizzontali al prezzo dove sono scattati (arancio in acquisto, fucsia in vendita)">
              <button
                onClick={cambiaMostraStop}
                className={`px-2 py-0.5 rounded-lg font-bold border flex items-center gap-1.5 ${
                  mostraStop ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
              >
                <span className="inline-block w-4 border-t-2" style={{ borderColor: mostraStop ? ARANCIO_STOP : '#475569' }} />
                Stop {mostraStop ? 'ON' : 'OFF'}
              </button>
              <div className={mostraStop ? '' : 'opacity-40 pointer-events-none'}>
                <Selettore titolo="≥" valore={minStop} opzioni={[['1', '1'], ['5', '5'], ['10', '10'], ['25', '25']]} onChange={cambiaMinStop} />
              </div>
            </div>
            <div className="flex items-center gap-2" title="Assorbimenti: palle verdi se i compratori assorbono le vendite, rosse se i venditori assorbono gli acquisti; grandezza = contratti">
              <button
                onClick={cambiaMostraAss}
                className={`px-2 py-0.5 rounded-lg font-bold border flex items-center gap-1.5 ${
                  mostraAss ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
              >
                <span className="inline-block w-2.5 h-2.5 rounded-full border border-white/80" style={{ backgroundColor: mostraAss ? VERDE : '#475569' }} />
                Assorbimenti {mostraAss ? 'ON' : 'OFF'}
              </button>
              <div className={mostraAss ? '' : 'opacity-40 pointer-events-none'}>
                <Selettore titolo="≥" valore={minAss} opzioni={[['30', '30'], ['60', '60'], ['100', '100'], ['200', '200']]} onChange={cambiaMinAss} />
              </div>
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
                  ? "Range Opening Bell non ancora disponibili: arrivano dopo le 15:35"
                  : mostraRange
                    ? "Nascondi i range ES dell'Opening Bell"
                    : "Mostra i range ES dell'Opening Bell"
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

          {caricato && points.length > 0 && <LetturaBook letto={conOfi ? letto : null} livelli={nLivelli} />}

          <div className="flex flex-wrap items-baseline justify-between gap-x-4 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Prezzo e CVD</div>
            {caricato && points.length > 0 && (
              <div className="text-[11px] text-slate-500 tabular-nums">
                {!conEventi ? (
                  <span className="text-amber-200/80">
                    Stop e assorbimenti: l&apos;add-on in Bookmap e&apos; la versione di prima. Copia execution/bookmap_addon.py in C:\Bookmap\Python\, ricostruiscilo e riattivalo.
                  </span>
                ) : (
                  <>
                    Oggi: <span style={{ color: ARANCIO_STOP }}>{contaOggi('stop', Number(minStop))} stop</span> ·{' '}
                    <span style={{ color: VERDE }}>{contaOggi('abs', Number(minAss))} assorbimenti</span>
                    {' · '}
                    <span
                      title="Gli stop si riconoscono solo se il feed manda l'ID dell'ordine aggressore: quando scattano, compaiono come aggressori diversi nella stessa esecuzione"
                      className={quotaId === 0 ? 'text-amber-300' : ''}
                    >
                      feed (ultimo minuto): {quotaId == null ? '—' : `${Math.round(quotaId * 100)}% trade con ID aggressore`}, {diagMinuto.multi}/{diagMinuto.ex} esecuzioni con piu&apos; aggressori
                      {quotaId === 0 && ' — senza ID gli stop non si possono riconoscere'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="relative h-[340px] md:h-[400px]">
            <canvas ref={prezzoRef} className="cursor-crosshair" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mt-4 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              {vistaBook === 'mlofi'
                ? `Order Flow Imbalance ${nLivelli === 1 ? 'al migliore (OFI)' : `multilivello (MLOFI) · primi ${nLivelli} livelli`} · ${
                    mediaLiq === '1' ? 'secondo per secondo' : `somma ultimi ${mediaLiq} s`
                  } · in code medie · sopra zero pressione in acquisto, sotto in vendita`
                : vistaBook === 'ofiPct'
                  ? `OFI % · ${nLivelli === 1 ? 'OFI al migliore' : `MLOFI ${nLivelli} livelli`}, ${
                      mediaLiq === '1' ? 'secondo per secondo' : `somma ${mediaLiq} s`
                    }, come percentile di sessione · oltre ±${ZONA_ESTREMA} pressione estrema: non vuol dire che stia per finire`
                : vistaBook === 'asimmetria'
                  ? `Asimmetria del book · baricentro della liquidita' dal mid, 15 livelli · sopra zero l'ask si allontana, sotto e' il bid ad allontanarsi`
                  : `Sbilancio statico della liquidita' esposta · ${corrente?.levels ?? 10} livelli per lato · sopra zero piu' bid · da solo inganna: la liquidita' va e viene`}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              {vistaBook === 'mlofi' && <Netto testo={nLivelli === 1 ? 'OFI' : 'MLOFI'} valore={letto?.mlofi ?? null} decimali={1} />}
              {vistaBook === 'ofiPct' && (
                <span
                  title={
                    ofiPctOra == null
                      ? `Servono almeno ${MIN_CAMPIONI_PCT / 60} minuti di OFI in sessione per un percentile`
                      : 'Pressione di adesso rispetto a quelle della sessione, col segno: +80 = in acquisto, piu\' forte dell\'80% delle letture'
                  }
                >
                  <Netto testo="OFI %" valore={ofiPctOra} />
                </span>
              )}
              <Selettore
                titolo="Vista"
                valore={vistaBook}
                opzioni={[['mlofi', 'OFI'], ['ofiPct', 'OFI %'], ['asimmetria', 'Asimmetria'], ['statico', 'Statico']]}
                onChange={cambiaVistaBook}
              />
              {(vistaBook === 'mlofi' || vistaBook === 'ofiPct') && (
                <Selettore
                  titolo="Livelli"
                  valore={livelliOfi}
                  opzioni={[['1', '1'], ['5', '5'], ['10', '10'], ['15', '15']]}
                  onChange={cambiaLivelliOfi}
                />
              )}
              <Selettore
                titolo={vistaBook === 'mlofi' || vistaBook === 'ofiPct' ? 'Somma' : 'Media'}
                valore={mediaLiq}
                opzioni={[['1', vistaBook === 'mlofi' || vistaBook === 'ofiPct' ? '1 s' : 'Off'], ['10', '10 s'], ['30', '30 s'], ['60', '60 s']]}
                onChange={cambiaMediaLiq}
              />
              {vistaBook === 'statico' && (
                <button
                  onClick={cambiaBidAsk}
                  className={`px-2 py-0.5 rounded-lg font-bold border ${
                    mostraBidAsk ? 'bg-slate-800 border-slate-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'
                  }`}
                  title="Le due linee della liquidita' bid e ask, sull'asse destro"
                >
                  Bid/Ask {mostraBidAsk ? 'ON' : 'OFF'}
                </button>
              )}
            </div>
          </div>
          {caricato && points.length > 0 && !conOfi && vistaBook !== 'statico' && (
            <div className="mb-1 text-xs text-amber-200/80">
              Nessun dato: l&apos;add-on in Bookmap non calcola ancora OFI e asimmetria. Copia execution/bookmap_addon.py in C:\Bookmap\Python\, ricostruiscilo dal code editor e riattivalo.
            </div>
          )}
          <div className="relative h-[220px] md:h-[260px]">
            <canvas ref={liquiditaRef} className="cursor-crosshair" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mt-4 mb-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              {vistaFlusso === 'pressione'
                ? "Pressione degli ordini limit · sopra zero bid che si accumulano o ask ritirati, sotto il contrario"
                : vistaFlusso === 'lato'
                  ? "Netto per lato (aggiunti − tolti) · sopra zero il lato si riempie, sotto si svuota"
                  : vistaFlusso === 'rotazione'
                    ? "Rotazione · quota degli ordini aggiunti poi cancellati, non eseguiti · vicino al 100% la liquidita' e' fugace"
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
                {vistaFlusso === 'rotazione' && (
                  <>
                    <Legenda colore={VERDE} testo="Bid" valore={ultimaRotazione('bid')} unita="%" />
                    <Legenda colore={ROSSO} testo="Ask" valore={ultimaRotazione('ask')} unita="%" />
                  </>
                )}
              </span>
              <Selettore
                titolo="Vista"
                valore={vistaFlusso}
                opzioni={[['pressione', 'Pressione'], ['lato', 'Per lato'], ['dettaglio', 'Dettaglio'], ['rotazione', 'Rotazione']]}
                onChange={cambiaVistaFlusso}
              />
              <Selettore
                titolo="Somma"
                valore={finestraFlusso}
                opzioni={[['10', '10 s'], ['30', '30 s'], ['60', '60 s']]}
                onChange={cambiaFinestraFlusso}
              />
              {vistaFlusso !== 'rotazione' && (
                <Selettore
                  titolo="Tolti"
                  valore={tolti}
                  opzioni={[['cancellati', 'Solo cancellati'], ['tutti', 'Cancellati + eseguiti']]}
                  onChange={cambiaTolti}
                />
              )}
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
  unita = '',
}: {
  colore: string;
  testo: string;
  valore: number | null;
  tratteggio?: boolean;
  segno?: boolean;
  unita?: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-slate-400">
      <span className={`inline-block w-4 border-t-2 ${tratteggio ? 'border-dashed' : ''}`} style={{ borderColor: colore }} />
      {testo}{' '}
      <span className="text-white">
        {segno && valore != null && valore > 0 ? '+' : ''}
        {compatto(valore)}
        {valore != null ? unita : ''}
      </span>
    </span>
  );
}

/** Il valore della pressione, colorato come la curva: verde sopra zero, rosso sotto. */
function Netto({ testo, valore, decimali = 0 }: { testo: string; valore: number | null; decimali?: number }) {
  const colore = valore == null ? undefined : valore >= 0 ? VERDE : ROSSO;
  return (
    <span className="flex items-center gap-1.5 text-slate-400">
      {testo}{' '}
      <span style={{ color: colore }} className={valore == null ? 'text-white' : ''}>
        {valore != null && valore > 0 ? '+' : ''}
        {compatto(valore, decimali)}
      </span>
    </span>
  );
}

/*
 * Soglie della lettura. Sono indicative, scelte a occhio per ES e non tarate
 * su dati: servono a dare un nome a quello che i numeri gia' dicono.
 */
/** Spread a un tick almeno per questa quota del tempo = large tick. */
const SOGLIA_LARGE_TICK = 0.9;
/** Coda per livello sotto/sopra questa frazione della mediana di sessione = book sottile/pieno. */
const SOGLIA_SOTTILE = 0.75;
const SOGLIA_PIENO = 1.25;
/** Asimmetria oltre questa percentuale = un lato si sta ritirando. */
// Tarata sulla prima ora di dati veri (30/09/2026): su ES l'asimmetria stava
// fra −2,7 e +6,6 (5° e 95° percentile), e ±15 non scattava mai. Da
// ricontrollare con piu' sessioni.
const SOGLIA_ASIMMETRIA = 5;
/** OFI % sotto questo modulo = pressione debole: meno forte di meta' delle letture della sessione. */
const SOGLIA_FORZA = 50;
/** Persistenza sotto la prima = pressione non confermata, sopra la seconda = continua. */
const PERSISTENZA_BASSA = 0.15;
const PERSISTENZA_ALTA = 0.35;
/** Oltre questa quota di cancellati sugli aggiunti la liquidita' e' fugace. */
const SOGLIA_FUGACI = 0.9;
const AMBRA = '#fbbf24';
const NEUTRO = '#94a3b8';

function Scheda({ titolo, verdetto, colore, dettaglio, spiegazione }: {
  titolo: string;
  verdetto: string;
  colore: string;
  dettaglio: string;
  spiegazione: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2" title={spiegazione}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{titolo}</div>
      <div className="text-sm font-bold" style={{ color: colore }}>{verdetto}</div>
      <div className="text-[11px] text-slate-400 tabular-nums">{dettaglio}</div>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const uno = (v: number | null, segno = false) => (v == null ? '—' : `${segno && v > 0 ? '+' : ''}${v.toFixed(1)}`);

/**
 * Le quattro domande con cui il video chiude, piu' l'OFI livello per livello:
 * che regime e' (large o small tick), se il book e' pieno o vuoto, se lo
 * sbilanciamento viene da un lato che si ritira, e se la pressione e' vera
 * (MLOFI persistente) o sono solo ordini che compaiono e spariscono.
 */
function LetturaBook({ letto, livelli }: { letto: Lettura | null; livelli: number }) {
  if (!letto) {
    return (
      <div className="mb-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-500">
        Lettura del book: servono OFI, baricentri e code, che l&apos;add-on in Bookmap non manda ancora. Copia execution/bookmap_addon.py in
        C:\Bookmap\Python\, ricostruiscilo dal code editor e riattivalo.
      </div>
    );
  }
  const l = letto;

  const large = l.sp1 != null && l.sp1 >= SOGLIA_LARGE_TICK;
  const regime = l.sp1 == null
    ? { verdetto: '—', colore: NEUTRO }
    : large
      ? { verdetto: 'Large tick', colore: NEUTRO }
      : { verdetto: 'Small tick', colore: AMBRA };

  const rapporto = l.qm != null && l.qmMediana ? l.qm / l.qmMediana : null;
  const profondita = rapporto == null
    ? { verdetto: '—', colore: NEUTRO }
    : rapporto <= SOGLIA_SOTTILE
      ? { verdetto: 'Sottile', colore: AMBRA }
      : rapporto >= SOGLIA_PIENO
        ? { verdetto: 'Pieno', colore: NEUTRO }
        : { verdetto: 'Normale', colore: NEUTRO };

  const asim = l.asim == null || !Number.isFinite(l.asim)
    ? { verdetto: '—', colore: NEUTRO }
    : l.asim <= -SOGLIA_ASIMMETRIA
      ? { verdetto: 'Il bid si allontana', colore: ROSSO }
      : l.asim >= SOGLIA_ASIMMETRIA
        ? { verdetto: "L'ask si allontana", colore: VERDE }
        : { verdetto: 'Simmetrico', colore: NEUTRO };

  let pressione = { verdetto: '—', colore: NEUTRO };
  if (l.persistenza != null && l.mlofi != null) {
    const lato = l.mlofi > 0 ? 'acquisto' : 'vendita';
    const colore = l.mlofi > 0 ? VERDE : ROSSO;
    if (l.persistenza < PERSISTENZA_BASSA) pressione = { verdetto: 'Non confermata', colore: AMBRA };
    else if (l.forza != null && Math.abs(l.forza) < SOGLIA_FORZA) pressione = { verdetto: 'Debole', colore: NEUTRO };
    else if (l.persistenza >= PERSISTENZA_ALTA) pressione = { verdetto: `In ${lato}, continua`, colore };
    else pressione = { verdetto: `In ${lato}, a strappi`, colore };
  }
  const fugace = l.fugaci != null && l.fugaci >= SOGLIA_FUGACI;

  const massimo = l.livelli.reduce<number>((m, v) => (v != null ? Math.max(m, Math.abs(v)) : m), 0) || 1;

  return (
    <div className="mb-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
        Lettura del book · ultimi {l.finestraSec} s (regime e profondita&apos;: ultimo minuto) · soglie indicative, a titolo di studio
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Scheda
          titolo="Regime"
          verdetto={regime.verdetto}
          colore={regime.colore}
          dettaglio={`spread 1 tick ${pct(l.sp1)} · best ${l.q1 == null ? '—' : Math.round(l.q1)} ct`}
          spiegazione={
            large
              ? "Spread schiacciato a un tick e code spesse: non si puo' migliorare il prezzo, la gara e' sulla priorita' temporale (FIFO). Book stabile, vale la lettura multilivello."
              : "Spread spesso oltre un tick: gli algoritmi si scavalcano di un tick alla volta (undercutting). Book instabile e volatile: le letture da large tick non valgono."
          }
        />
        <Scheda
          titolo="Profondita'"
          verdetto={profondita.verdetto}
          colore={profondita.colore}
          dettaglio={`${l.qm == null ? '—' : Math.round(l.qm)} ct/livello · mediana ${l.qmMediana == null ? '—' : Math.round(l.qmMediana)}`}
          spiegazione="Contratti medi per livello nei primi 15, contro la mediana della sessione. Un book che si assottiglia (10-14 contratti invece di 100-300) e' un mercato instabile: il prezzo attraversa i livelli piu' facilmente."
        />
        <Scheda
          titolo="Asimmetria"
          verdetto={asim.verdetto}
          colore={asim.colore}
          dettaglio={`baricentro bid ${uno(l.cB)} · ask ${uno(l.cA)} tick`}
          spiegazione="Distanza media dal mid della liquidita' di ciascun lato. Nel modello di Avellaneda e Stoikov il market maker con un inventario lungo sposta in basso il suo prezzo di riserva: avvicina l'ask per scaricare e allontana il bid per non comprare ancora. Bid che si allontana = sotto c'e' meno liquidita' ad assorbire (rosso); il caso opposto e' il market maker corto (verde)."
        />
        <Scheda
          titolo={livelli === 1 ? 'Pressione (OFI)' : `Pressione (MLOFI ${livelli})`}
          verdetto={pressione.verdetto}
          colore={pressione.colore}
          dettaglio={`${uno(l.mlofi, true)} code · forza ${l.forza == null ? '—' : `${l.forza > 0 ? '+' : ''}${Math.round(l.forza)}`} · persistenza ${pct(l.persistenza)} · fugaci ${pct(l.fugaci)}${fugace ? ' !' : ''}`}
          spiegazione={`MLOFI: come cambia il book (inserimenti, cancellazioni, eseguiti), non quanto ce n'e'. Forza = OFI %, il MLOFI rispetto alla sessione (sotto ±50 la pressione e' debole). Persistenza = |somma| / somma dei moduli dell'OFI secondo per secondo: bassa vuol dire che la pressione va avanti e indietro (100, 60, 300, 70...), ordini che vengono aggiunti e tolti. Fugaci = ordini aggiunti nei primi 5 livelli poi cancellati invece che eseguiti${fugace ? ': oltre il 90%, liquidita\' che non va presa per un muro' : ''}.`}
        />
        <div
          className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 col-span-2 md:col-span-1"
          title="OFI di ciascun livello nella finestra, in code medie: dove sta entrando o uscendo la pressione. Barre piene = livelli sommati nel MLOFI."
        >
          <div className="text-[10px] uppercase tracking-wide text-slate-500">OFI per livello</div>
          <div className="flex items-stretch gap-[2px] h-12 mt-1">
            {l.livelli.map((v, m) => {
              const alto = v == null ? 0 : (Math.abs(v) / massimo) * 50;
              return (
                <div key={m} className="relative flex-1" style={{ opacity: m < livelli ? 1 : 0.3 }} title={`L${m + 1}: ${uno(v, true)} code`}>
                  <div className="absolute left-0 right-0 top-1/2 border-t border-slate-700" />
                  {v != null && (
                    <div
                      className="absolute left-0 right-0"
                      style={{
                        backgroundColor: v >= 0 ? VERDE : ROSSO,
                        height: `${alto}%`,
                        ...(v >= 0 ? { bottom: '50%' } : { top: '50%' }),
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[9px] text-slate-600 tabular-nums">
            <span>L1</span>
            <span>L{LIVELLI_OFI_MAX}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** (bid − ask) / (bid + ask): +100% tutto bid, −100% tutto ask. */
function sbilancio(p: BookmapPoint): number | null {
  const tot = p.bidLiq + p.askLiq;
  return tot > 0 ? ((p.bidLiq - p.askLiq) / tot) * 100 : null;
}
