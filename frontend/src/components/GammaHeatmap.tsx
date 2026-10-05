'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Mappa di calore del gamma dei market maker, sul modello di quella di
 * SpotGamma: prezzo in verticale, tempo in orizzontale, e il colore e' il GEX
 * che c'e' a quel prezzo in quel momento (viola positivo, cremisi negativo,
 * scuro dove non c'e' niente). A sinistra il profilo di adesso per strike,
 * sulla stessa scala dei prezzi; a destra la barra dei colori in $.
 *
 * Il campo e' continuo, non una casella per strike: il GEX di ogni strike si
 * spalma con un kernel gaussiano largo SIGMA_STRIKE volte il passo fra gli
 * strike, e nel tempo si interpola fra una fotografia del profilo e la
 * successiva (una ogni due minuti). Normalizzato perche' dentro la catena il
 * valore resti quello "per strike" -- la barra dei colori si legge come le
 * barre a sinistra -- e fuori dalla catena sfumi a zero invece di prolungare
 * l'ultimo strike.
 *
 * Differenza dalla foto: SpotGamma proietta la mappa anche nel futuro,
 * rivalutando le opzioni a spot e scadenze diverse. Qui c'e' solo quello che
 * e' successo: il gamma misurato da IBKR, fotografia per fotografia.
 *
 * Canvas a mano e non Chart.js: servono un'immagine interpolata, le curve di
 * livello e un pannello laterale allineato sui prezzi, e Chart.js non fa
 * nessuna delle tre.
 */

export interface FotografiaGamma {
  time: string;
  gex: number[];
  gexOi: number[];
  /** GEX dei dealer dal flusso Lee-Ready; assente nelle risposte di prima che la route lo calcolasse. */
  gexLr?: number[];
}

/** Call comprate, call vendute, put comprate, put vendute (Lee-Ready, oggi). */
export type ContiLr = [number, number, number, number];

interface Props {
  /** Gli strike della serie, in ordine crescente; i valori delle fotografie seguono questo ordine. */
  strikes: number[];
  serie: FotografiaGamma[];
  base: 'gex' | 'gexOi' | 'gexLr';
  /**
   * Da quando esistono i conti Lee-Ready ('HH:MM:SS'): con quella base la
   * mappa parte da li', perche' prima il GEX dei dealer vale zero in quanto
   * non misurato, non perche' lo sia.
   */
  inizioLr?: string | null;
  /** I conti Lee-Ready di oggi per strike, per il riquadro sotto il mouse. */
  conti?: Map<number, ContiLr>;
  /** Il profilo di adesso sulla base scelta, in M$: il pannello di sinistra. */
  profilo: { strike: number; gex: number }[];
  /** Lo spot SPX a cui IBKR ha valutato il gamma, 'HH:MM:SS' in ora italiana. */
  spot: { time: string; price: number }[];
  /**
   * L'SPX cash da /api/market, ogni ~16 s: la linea del prezzo. Piu' fitto
   * dello spot del gamma (30 s, e spesso ripetuto), ma esiste solo da
   * quando apre il cash: prima di allora la linea usa `spot`.
   */
  spx?: { time: string; price: number }[];
  /** Minuti da mostrare fino all'ultimo dato, o tutta la sessione. */
  finestraMin: number | 'all';
}

/** Larghezza del kernel, in passi fra strike: abbastanza da fondere strike vicini in una macchia, non da cancellarli. */
const SIGMA_STRIKE = 1.6;
/** Compressione del colore: |v|^GAMMA_COLORE, perche' i livelli medi non spariscano accanto ai muri. */
const GAMMA_COLORE = 0.7;
/** Curve di livello, nello spazio del colore (0 = zero, 1 = massimo di sessione), oltre alla curva dello zero. */
const LIVELLI_CURVE = [0.4, 0.7];
/** La curva dello zero si traccia solo dove attorno c'e' almeno questo: altrove sarebbe rumore. */
const ZERO_MIN = 0.04;
/** Una fotografia col GEX totale sotto questa frazione della precedente e' un azzeramento del volume. */
const AZZERAMENTO = 0.2;

/**
 * In LIVE l'ultimo dato sta a questa distanza dal bordo destro (~1 cm a 96
 * dpi), come in /bookmap: il prezzo di adesso resta sempre in vista.
 */
const MARGINE_DESTRO_PX = 38;
/** Limiti dello zoom sul tempo con la rotella, in secondi. */
const AMPIEZZA_MIN = 300;
const AMPIEZZA_MAX = 12 * 3600;

/** Default stabile per `spx`: un `[]` nuovo a ogni render rifarebbe la mappa ogni volta. */
const NESSUN_PREZZO: { time: string; price: number }[] = [];

const SFONDO = '#0b0c11';
const TESTO = '#8b93a7';
const VIOLA = '#8b5cf6';
const CREMISI = '#f0145a';

/** Tappe del colore da zero (scuro) al massimo, per i due segni. */
const TAPPE_POS: [number, [number, number, number]][] = [
  [0, [22, 16, 32]],
  [0.3, [36, 25, 78]],
  [0.6, [66, 38, 150]],
  [0.85, [112, 56, 222]],
  [1, [158, 92, 255]],
];
const TAPPE_NEG: [number, [number, number, number]][] = [
  [0, [22, 16, 32]],
  [0.3, [58, 18, 44]],
  [0.6, [126, 20, 66]],
  [0.85, [205, 22, 88]],
  [1, [255, 34, 104]],
];

function colore(v: number, vmax: number): [number, number, number] {
  const t = Math.min(1, Math.pow(Math.abs(v) / vmax, GAMMA_COLORE));
  const tappe = v >= 0 ? TAPPE_POS : TAPPE_NEG;
  for (let i = 1; i < tappe.length; i++) {
    const [t1, c1] = tappe[i];
    if (t <= t1) {
      const [t0, c0] = tappe[i - 1];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return tappe[tappe.length - 1][1];
}

function secondi(hhmmss: string) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function orario(sec: number) {
  const s = Math.round(sec);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** M$ in testo: miliardi sopra i mille, come la barra della foto. */
function dollari(vM: number, decimali = 2) {
  const a = Math.abs(vM);
  const segno = vM > 0 ? '+' : vM < 0 ? '−' : '';
  return a >= 1000 ? `${segno}${(a / 1000).toFixed(decimali)}B` : `${segno}${a.toFixed(0)}M`;
}

/** Passo "tondo" per circa `quanti` intervalli su `ampiezza`. */
function passoTondo(ampiezza: number, quanti: number, passi: number[]) {
  const grezzo = ampiezza / quanti;
  return passi.find((p) => p >= grezzo) ?? passi[passi.length - 1];
}

/** I valori degli strike al secondo `t`, interpolati fra le due fotografie attorno; null fuori dalla serie. */
function valoriA(t: number, secFoto: number[], foto: number[][]): number[] | null {
  const n = secFoto.length;
  if (n === 0 || t < secFoto[0] || t > secFoto[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (secFoto[m] <= t) lo = m;
    else hi = m;
  }
  if (lo === hi || secFoto[hi] === secFoto[lo]) return foto[lo];
  const f = (t - secFoto[lo]) / (secFoto[hi] - secFoto[lo]);
  const a = foto[lo];
  const b = foto[hi];
  return a.map((v, i) => v + (b[i] - v) * f);
}

interface Geometria {
  area: { x: number; y: number; w: number; h: number };
  t0: number;
  t1: number;
  yMin: number;
  yMax: number;
  griglia: Float32Array;
  colonne: number;
  righe: number;
  secFoto: number[];
  foto: number[][];
}

export default function GammaHeatmap({ strikes, serie, base, profilo, spot, spx = NESSUN_PREZZO, finestraMin, inizioLr = null, conti }: Props) {
  const contenitore = useRef<HTMLDivElement | null>(null);
  const tela = useRef<HTMLCanvasElement | null>(null);
  const [dimensioni, setDimensioni] = useState<{ w: number; h: number } | null>(null);
  /** La scala dei prezzi scelta con rotella o trascinamento; null = automatica. */
  const [vistaY, setVistaY] = useState<{ min: number; max: number } | null>(null);
  /**
   * Il tempo, come in /bookmap. `vistaX` null = LIVE: il bordo destro segue
   * l'ultimo dato, e la rotella cambia solo quanto tempo si vede
   * (`ampiezza`, secondi). Trascinando si fissa una finestra (`vistaX`) e la
   * vista smette di seguire, finche' non si torna LIVE.
   */
  const [ampiezza, setAmpiezza] = useState<number | null>(null);
  const [vistaX, setVistaX] = useState<{ t0: number; t1: number } | null>(null);
  const vistaXRef = useRef<{ t0: number; t1: number } | null>(null);
  /** Tutto quello che non cambia muovendo il mouse, gia' disegnato. */
  const strato = useRef<HTMLCanvasElement | null>(null);
  const geo = useRef<Geometria | null>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const trascina = useRef<{ x: number; y: number; t0: number; t1: number; min: number; max: number; mosso: boolean } | null>(null);

  useEffect(() => {
    const el = contenitore.current;
    if (!el) return;
    const ro = new ResizeObserver(([voce]) => {
      const { width, height } = voce.contentRect;
      setDimensioni({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Lo strato fisso piu' il mirino e il riquadro dei valori sotto il mouse. */
  const dipingi = useCallback(() => {
    const c = tela.current;
    const s = strato.current;
    const g = geo.current;
    if (!c || !s) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(s, 0, 0);
    const m = mouse.current;
    if (!g || !m) return;
    const { area } = g;
    if (m.x < area.x || m.x > area.x + area.w || m.y < area.y || m.y > area.y + area.h) return;
    const dpr = c.width / (dimensioni?.w || c.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const t = g.t0 + ((m.x - area.x) / area.w) * (g.t1 - g.t0);
    const prezzo = g.yMax - ((m.y - area.y) / area.h) * (g.yMax - g.yMin);
    const col = Math.min(g.colonne - 1, Math.max(0, Math.floor(((m.x - area.x) / area.w) * g.colonne)));
    const riga = Math.min(g.righe - 1, Math.max(0, Math.floor(((m.y - area.y) / area.h) * g.righe)));
    const campo = g.griglia[riga * g.colonne + col];
    const valori = valoriA(t, g.secFoto, g.foto);
    let vicino: { strike: number; v: number } | null = null;
    if (valori) {
      let migliore = Infinity;
      strikes.forEach((k, i) => {
        if (Math.abs(k - prezzo) < migliore) {
          migliore = Math.abs(k - prezzo);
          vicino = { strike: k, v: valori[i] };
        }
      });
    }

    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.x, area.y);
    ctx.lineTo(m.x, area.y + area.h);
    ctx.moveTo(area.x, m.y);
    ctx.lineTo(area.x + area.w, m.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const righeTesto = [
      `${orario(t)}  ·  ${prezzo.toFixed(0)}`,
      Number.isFinite(campo) ? `Gamma qui: ${dollari(campo)}` : 'Nessun dato a quest\'ora',
    ];
    const v = vicino as { strike: number; v: number } | null;
    if (v) righeTesto.push(`Strike ${v.strike}: ${dollari(v.v)}`);
    const conto = v ? conti?.get(v.strike) : undefined;
    if (conto) {
      // Totali di oggi fino ad adesso, non all'ora sotto il mouse: la serie storica non li porta.
      righeTesto.push(`Oggi call: ${conto[0]} comprate / ${conto[1]} vendute`);
      righeTesto.push(`Oggi put: ${conto[2]} comprate / ${conto[3]} vendute`);
    }
    ctx.font = '11px Arial';
    const larghezza = Math.max(...righeTesto.map((r) => ctx.measureText(r).width)) + 16;
    const altezza = righeTesto.length * 16 + 8;
    let bx = m.x + 12;
    let by = m.y + 12;
    if (bx + larghezza > area.x + area.w) bx = m.x - 12 - larghezza;
    if (by + altezza > area.y + area.h) by = m.y - 12 - altezza;
    ctx.fillStyle = 'rgba(15, 17, 26, 0.92)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.fillRect(bx, by, larghezza, altezza);
    ctx.strokeRect(bx + 0.5, by + 0.5, larghezza - 1, altezza - 1);
    ctx.fillStyle = '#e2e8f0';
    ctx.textBaseline = 'top';
    righeTesto.forEach((r, i) => ctx.fillText(r, bx + 8, by + 6 + i * 16));
    ctx.restore();
  }, [dimensioni, strikes, conti]);

  // Lo strato fisso: si rifa' quando cambiano i dati, la dimensione o la scala dei prezzi.
  useEffect(() => {
    const c = tela.current;
    if (!c || !dimensioni || dimensioni.w < 200 || dimensioni.h < 150) return;
    const dpr = window.devicePixelRatio || 1;
    const W = dimensioni.w;
    const H = dimensioni.h;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    // Nuovo a ogni ricostruzione (ogni 30 s o a ogni zoom): costa poco, e lo
    // strato vecchio resta intatto finche' quello nuovo non e' pronto.
    const s = document.createElement('canvas');
    s.width = c.width;
    s.height = c.height;
    const ctx = s.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = SFONDO;
    ctx.fillRect(0, 0, W, H);
    ctx.font = '11px Arial';

    // ─── Impaginazione ───
    const larghezzaProfilo = Math.min(220, Math.max(120, W * 0.17));
    const assePrezzi = 58;
    const barraColori = 14;
    const etichetteBarra = 52;
    const sopra = 10;
    const sotto = 30;
    const profiloX = 8;
    const area = {
      x: profiloX + larghezzaProfilo + 8 + assePrezzi,
      y: sopra,
      w: 0,
      h: H - sopra - sotto,
    };
    area.w = W - area.x - 12 - barraColori - etichetteBarra;
    if (area.w < 80) return;

    // ─── Dati ───
    const chiave = base;
    let fotoOrdinate = serie
      .map((f) => ({ sec: secondi(f.time), v: f[chiave] ?? [] }))
      .filter((f) => Number.isFinite(f.sec) && f.v.length === strikes.length)
      .sort((a, b) => a.sec - b.sec);
    // Sul volume la sessione comincia all'ultimo azzeramento: IBKR riporta a
    // zero il volume di giornata all'apertura del cash (il 30/09/2026 alle
    // 15:30:30 il totale e' passato da 29.613 a 896 M$), e prima c'e' il
    // volume della notte. Disegnati insieme davano una striscia scura a meta'
    // mappa. L'open interest non si azzera e resta tutto.
    let azzerato: number | null = null;
    if (chiave === 'gex') {
      const totale = (v: number[]) => v.reduce((a, x) => a + Math.abs(x), 0);
      for (let i = fotoOrdinate.length - 1; i > 0; i--) {
        if (totale(fotoOrdinate[i].v) < totale(fotoOrdinate[i - 1].v) * AZZERAMENTO) {
          azzerato = fotoOrdinate[i].sec;
          fotoOrdinate = fotoOrdinate.slice(i);
          break;
        }
      }
    }
    if (chiave === 'gexLr') {
      const da = inizioLr ? secondi(inizioLr) : Infinity;
      fotoOrdinate = fotoOrdinate.filter((f) => f.sec >= da);
      azzerato = Number.isFinite(da) ? da : null;
    }
    const secFoto = fotoOrdinate.map((f) => f.sec);
    const foto = fotoOrdinate.map((f) => f.v);
    const ordina = (serieP: { time: string; price: number }[]) =>
      serieP
        .map((p) => ({ sec: secondi(p.time), price: p.price }))
        .filter((p) => Number.isFinite(p.sec) && p.price > 0)
        .sort((a, b) => a.sec - b.sec);
    // La linea del prezzo: lo spot del gamma fino al primo SPX cash, poi l'SPX.
    const spxOrdinato = ordina(spx);
    const inizioSpx = spxOrdinato[0]?.sec ?? Infinity;
    const spotOrdinato = [...ordina(spot).filter((p) => p.sec < inizioSpx), ...spxOrdinato];

    const ultimo = Math.max(secFoto[secFoto.length - 1] ?? 0, spotOrdinato[spotOrdinato.length - 1]?.sec ?? 0);
    // Dopo un azzeramento anche il prezzo parte da li': la mappa prima e' vuota.
    const primo = azzerato ?? Math.min(secFoto[0] ?? Infinity, spotOrdinato[0]?.sec ?? Infinity);
    if (!Number.isFinite(primo) || ultimo <= primo || strikes.length < 2) {
      ctx.fillStyle = TESTO;
      ctx.textAlign = 'center';
      ctx.fillText(
        chiave === 'gexLr'
          ? "Lee-Ready: ancora nessun conto. Li fa il poller dei volumi da quando e' stato riavviato con la versione nuova."
          : 'In attesa del gamma: il poller dei volumi raccoglie dalle 13:30',
        W / 2,
        H / 2,
      );
      geo.current = null;
      strato.current = s;
      dipingi();
      return;
    }
    let t0: number;
    let t1: number;
    if (vistaX) {
      t0 = vistaX.t0;
      t1 = vistaX.t1;
    } else {
      // LIVE: `durata` secondi di dati e poi MARGINE_DESTRO_PX di vuoto, che
      // in secondi dipende dalla larghezza dell'area.
      const durata = ampiezza ?? (finestraMin === 'all' ? Math.max(AMPIEZZA_MIN, ultimo - primo) : finestraMin * 60);
      const totale = durata / (1 - MARGINE_DESTRO_PX / area.w);
      t1 = ultimo + (totale * MARGINE_DESTRO_PX) / area.w;
      t0 = t1 - totale;
    }

    // Il passo fra strike: la mediana delle distanze, cosi' un buco nella catena non lo falsa.
    const distanze = strikes.slice(1).map((k, i) => k - strikes[i]).sort((a, b) => a - b);
    const passo = distanze[Math.floor(distanze.length / 2)] || 5;
    const sigma = passo * SIGMA_STRIKE;
    const pieno = (sigma * Math.sqrt(2 * Math.PI)) / passo;
    const peso = (distanza: number) => Math.exp(-(distanza * distanza) / (2 * sigma * sigma)) / pieno;

    // Scala dei prezzi: la catena e lo spot visibile, con un margine.
    let yMin: number;
    let yMax: number;
    if (vistaY) {
      yMin = vistaY.min;
      yMax = vistaY.max;
    } else {
      const prezziVisti = spotOrdinato.filter((p) => p.sec >= t0).map((p) => p.price);
      const minPrezzo = prezziVisti.reduce((a, b) => Math.min(a, b), strikes[0]);
      const maxPrezzo = prezziVisti.reduce((a, b) => Math.max(a, b), strikes[strikes.length - 1]);
      const margine = (maxPrezzo - minPrezzo) * 0.04 + passo;
      yMin = minPrezzo - margine;
      yMax = maxPrezzo + margine;
    }
    const yPix = (p: number) => area.y + ((yMax - p) / (yMax - yMin)) * area.h;
    const xPix = (t: number) => area.x + ((t - t0) / (t1 - t0)) * area.w;

    // Il massimo di sessione, calcolato sugli strike di tutte le fotografie:
    // non dipende da zoom e finestra, cosi' lo stesso colore vuol dire sempre
    // lo stesso gamma per tutta la giornata.
    let vmax = 0;
    const pesiStrike = strikes.map((k) => strikes.map((j) => peso(k - j)));
    for (const v of foto) {
      for (let a = 0; a < strikes.length; a++) {
        let somma = 0;
        for (let b = 0; b < strikes.length; b++) somma += pesiStrike[a][b] * v[b];
        vmax = Math.max(vmax, Math.abs(somma));
      }
    }
    if (vmax <= 0) vmax = 1;

    // ─── Il campo ───
    const colonne = Math.max(40, Math.min(420, Math.round(area.w / 2)));
    const righe = Math.max(40, Math.min(320, Math.round(area.h / 2)));
    const griglia = new Float32Array(colonne * righe).fill(NaN);
    const pesiRighe: Float32Array[] = [];
    for (let r = 0; r < righe; r++) {
      const p = yMax - ((r + 0.5) / righe) * (yMax - yMin);
      pesiRighe.push(Float32Array.from(strikes, (k) => peso(p - k)));
    }
    for (let c2 = 0; c2 < colonne; c2++) {
      const t = t0 + ((c2 + 0.5) / colonne) * (t1 - t0);
      const valori = valoriA(t, secFoto, foto);
      if (!valori) continue;
      for (let r = 0; r < righe; r++) {
        const w = pesiRighe[r];
        let somma = 0;
        for (let k = 0; k < valori.length; k++) somma += w[k] * valori[k];
        griglia[r * colonne + c2] = somma;
      }
    }

    // L'immagine a una casella per pixel, poi stirata sull'area con
    // l'interpolazione del browser: e' quella a renderla liscia come la foto.
    const piccola = document.createElement('canvas');
    piccola.width = colonne;
    piccola.height = righe;
    const pctx = piccola.getContext('2d');
    if (pctx) {
      const img = pctx.createImageData(colonne, righe);
      for (let i = 0; i < griglia.length; i++) {
        const v = griglia[i];
        if (!Number.isFinite(v)) {
          img.data[i * 4 + 3] = 0;
          continue;
        }
        const [r, g, b] = colore(v, vmax);
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 255;
      }
      pctx.putImageData(img, 0, 0);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(piccola, area.x, area.y, area.w, area.h);
      ctx.restore();
    }

    // ─── Curve di livello (marching squares sulla griglia) ───
    const cw = area.w / colonne;
    const ch = area.h / righe;
    const curva = (livello: number, minimo: number) => {
      ctx.beginPath();
      for (let r = 0; r < righe - 1; r++) {
        for (let c2 = 0; c2 < colonne - 1; c2++) {
          const a = griglia[r * colonne + c2];
          const b = griglia[r * colonne + c2 + 1];
          const d = griglia[(r + 1) * colonne + c2];
          const e = griglia[(r + 1) * colonne + c2 + 1];
          if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d) || !Number.isFinite(e)) continue;
          if (minimo > 0 && Math.max(Math.abs(a), Math.abs(b), Math.abs(d), Math.abs(e)) < minimo) continue;
          const punti: [number, number][] = [];
          const lato = (v1: number, v2: number, x1: number, y1: number, x2: number, y2: number) => {
            if ((v1 - livello) * (v2 - livello) < 0) {
              const f = (livello - v1) / (v2 - v1);
              punti.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]);
            }
          };
          lato(a, b, c2, r, c2 + 1, r);
          lato(b, e, c2 + 1, r, c2 + 1, r + 1);
          lato(d, e, c2, r + 1, c2 + 1, r + 1);
          lato(a, d, c2, r, c2, r + 1);
          for (let i = 0; i + 1 < punti.length; i += 2) {
            ctx.moveTo(area.x + (punti[i][0] + 0.5) * cw, area.y + (punti[i][1] + 0.5) * ch);
            ctx.lineTo(area.x + (punti[i + 1][0] + 0.5) * cw, area.y + (punti[i + 1][1] + 0.5) * ch);
          }
        }
      }
      ctx.stroke();
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(236, 222, 240, 0.32)';
    for (const f of LIVELLI_CURVE) {
      // `f` e' nello spazio del colore: le curve cadono dove il colore cambia
      // di un tanto, non a frazioni fisse del valore (che col colore
      // compresso finirebbero tutte addosso ai muri).
      const livello = vmax * Math.pow(f, 1 / GAMMA_COLORE);
      curva(livello, 0);
      curva(-livello, 0);
    }
    ctx.strokeStyle = 'rgba(236, 222, 240, 0.45)';
    curva(0, vmax * ZERO_MIN);

    // ─── Prezzo ───
    const spotVisto = spotOrdinato.filter((p) => p.sec >= t0 - 60);
    if (spotVisto.length > 1) {
      ctx.beginPath();
      spotVisto.forEach((p, i) => {
        const x = xPix(p.sec);
        const y = yPix(p.price);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(240, 240, 245, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Il nome in fondo alla linea, come un'etichetta di serie.
      const fine = spotVisto[spotVisto.length - 1];
      ctx.font = 'bold 11px Arial';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fine.sec >= inizioSpx ? 'SPX' : 'SPX (spot IBKR)', xPix(fine.sec) + 6, yPix(fine.price) - 4);
      ctx.font = '11px Arial';
    }
    ctx.restore();

    // Il prezzo di adesso: tratteggiata su tutta l'area e cartellino sull'asse.
    const adesso = spotOrdinato[spotOrdinato.length - 1];
    if (adesso && adesso.price >= yMin && adesso.price <= yMax) {
      const y = yPix(adesso.price);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
      ctx.restore();
    }

    if (azzerato != null) {
      ctx.fillStyle = 'rgba(139, 147, 167, 0.8)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        chiave === 'gexLr'
          ? `Dealer da Lee-Ready dalle ${orario(azzerato)}: solo i contratti classificati da allora, senza le posizioni aperte prima`
          : `Volume dalle ${orario(azzerato)}: IBKR lo azzera all'apertura del cash (per tutta la giornata: Open Interest)`,
        area.x + 8,
        area.y + 6,
      );
    }

    // ─── Asse dei prezzi ───
    const passoY = passoTondo(yMax - yMin, 8, [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]);
    ctx.fillStyle = TESTO;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let p = Math.ceil(yMin / passoY) * passoY; p <= yMax; p += passoY) {
      ctx.fillText(String(p), area.x - 8, yPix(p));
    }
    if (adesso && adesso.price >= yMin && adesso.price <= yMax) {
      const y = yPix(adesso.price);
      const testo = adesso.price.toFixed(2);
      const w = ctx.measureText(testo).width + 8;
      ctx.fillStyle = '#4b5263';
      ctx.fillRect(area.x - w - 4, y - 8, w, 16);
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(testo, area.x - 8, y);
    }

    // ─── Asse del tempo ───
    const passoT = passoTondo(t1 - t0, 8, [300, 600, 900, 1800, 3600, 7200]);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TESTO;
    for (let t = Math.ceil(t0 / passoT) * passoT; t <= t1; t += passoT) {
      ctx.fillText(orario(t), xPix(t), area.y + area.h + 8);
    }

    // ─── GEX by Strike, a sinistra ───
    const centro = profiloX + larghezzaProfilo / 2;
    const massimoBarre = profilo.reduce((m, r) => Math.max(m, Math.abs(r.gex)), 0) || 1;
    const semi = larghezzaProfilo / 2 - 4;
    const spessore = Math.max(2, Math.min(10, (area.h / ((yMax - yMin) / passo)) * 0.7));
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.beginPath();
    ctx.moveTo(centro, area.y);
    ctx.lineTo(centro, area.y + area.h);
    ctx.stroke();
    for (const r of profilo) {
      if (r.strike < yMin || r.strike > yMax || r.gex === 0) continue;
      const lunghezza = (r.gex / massimoBarre) * semi;
      ctx.fillStyle = r.gex > 0 ? VIOLA : CREMISI;
      ctx.fillRect(lunghezza > 0 ? centro : centro + lunghezza, yPix(r.strike) - spessore / 2, Math.max(1, Math.abs(lunghezza)), spessore);
    }
    if (adesso && adesso.price >= yMin && adesso.price <= yMax) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.beginPath();
      ctx.moveTo(profiloX, yPix(adesso.price));
      ctx.lineTo(profiloX + larghezzaProfilo, yPix(adesso.price));
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = TESTO;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText('0', centro, area.y + area.h + 8);
    ctx.textAlign = 'left';
    ctx.fillText(dollari(-massimoBarre, 1), profiloX, area.y + area.h + 8);
    ctx.textAlign = 'right';
    ctx.fillText(dollari(massimoBarre, 1), profiloX + larghezzaProfilo, area.y + area.h + 8);

    // ─── Barra dei colori ───
    const bx = area.x + area.w + 12;
    for (let i = 0; i < area.h; i++) {
      // Lineare nello spazio del colore: in alto +vmax, al centro zero, in basso −vmax.
      const t = 1 - (2 * (i + 0.5)) / area.h;
      const v = Math.sign(t) * vmax * Math.pow(Math.abs(t), 1 / GAMMA_COLORE);
      const [r, g, b] = colore(v, vmax);
      ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      ctx.fillRect(bx, area.y + i, barraColori, 1.5);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TESTO;
    for (const t of [1, 0.66, 0.33, 0, -0.33, -0.66, -1]) {
      const v = Math.sign(t) * vmax * Math.pow(Math.abs(t), 1 / GAMMA_COLORE);
      const y = area.y + ((1 - t) / 2) * area.h;
      ctx.fillText(t === 0 ? '0' : dollari(v, 1), bx + barraColori + 5, y);
    }

    geo.current = { area, t0, t1, yMin, yMax, griglia, colonne, righe, secFoto, foto };
    strato.current = s;
    dipingi();
  }, [strikes, serie, base, profilo, spot, spx, finestraMin, inizioLr, dimensioni, vistaY, vistaX, ampiezza, dipingi]);

  const fissaX = useCallback((v: { t0: number; t1: number } | null) => {
    vistaXRef.current = v;
    setVistaX(v);
  }, []);

  /** Torna a seguire i dati: tempo LIVE con la finestra scelta, prezzi in scala automatica. */
  const tornaLive = useCallback(() => {
    fissaX(null);
    setAmpiezza(null);
    setVistaY(null);
  }, [fissaX]);

  // Rotella come in /bookmap: sulla mappa = tempo, sull'asse dei prezzi (o
  // sul profilo a sinistra) = prezzi. Con un gestore non passivo, altrimenti
  // la pagina scorrerebbe insieme.
  useEffect(() => {
    const c = tela.current;
    if (!c) return;
    const suRotella = (e: WheelEvent) => {
      const g = geo.current;
      if (!g) return;
      const rect = c.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const x = e.clientX - rect.left;
      if (x > g.area.x + g.area.w || y < g.area.y || y > g.area.y + g.area.h) return;
      e.preventDefault();
      const fattore = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (x < g.area.x) {
        const perno = g.yMax - ((y - g.area.y) / g.area.h) * (g.yMax - g.yMin);
        const min = perno - (perno - g.yMin) * fattore;
        const max = perno + (g.yMax - perno) * fattore;
        if (max - min >= 10) setVistaY({ min, max });
        return;
      }
      const totale = g.t1 - g.t0;
      if (!vistaXRef.current) {
        // In LIVE il bordo destro resta sull'ultimo dato: cambia solo quanto si vede.
        const durata = totale * (1 - MARGINE_DESTRO_PX / g.area.w) * fattore;
        setAmpiezza(Math.min(AMPIEZZA_MAX, Math.max(AMPIEZZA_MIN, durata)));
        return;
      }
      // Fuori dal LIVE lo zoom e' attorno al mouse.
      const nuovo = Math.min(AMPIEZZA_MAX, Math.max(AMPIEZZA_MIN, totale * fattore));
      const perno = g.t0 + ((x - g.area.x) / g.area.w) * totale;
      const quota = (perno - g.t0) / totale;
      fissaX({ t0: perno - quota * nuovo, t1: perno + (1 - quota) * nuovo });
    };
    c.addEventListener('wheel', suRotella, { passive: false });
    return () => c.removeEventListener('wheel', suRotella);
  }, [fissaX]);

  const posizione = (e: React.MouseEvent) => {
    const rect = tela.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div ref={contenitore} className="absolute inset-0">
      <canvas
        ref={tela}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const p = posizione(e);
          const g = geo.current;
          const t = trascina.current;
          if (t && g && (t.mosso || Math.abs(p.x - t.x) + Math.abs(p.y - t.y) > 3)) {
            // Trascinare sposta tempo e prezzi insieme, come afferrare il foglio,
            // e sgancia il LIVE: si sta guardando indietro.
            t.mosso = true;
            const perSecondo = (t.t1 - t.t0) / g.area.w;
            const dt = (p.x - t.x) * perSecondo;
            fissaX({ t0: t.t0 - dt, t1: t.t1 - dt });
            const perPrezzo = (t.max - t.min) / g.area.h;
            const dy = (p.y - t.y) * perPrezzo;
            setVistaY({ min: t.min + dy, max: t.max + dy });
          }
          mouse.current = p;
          dipingi();
        }}
        onMouseLeave={() => {
          mouse.current = null;
          trascina.current = null;
          dipingi();
        }}
        onMouseDown={(e) => {
          const g = geo.current;
          if (g) {
            const p = posizione(e);
            trascina.current = { x: p.x, y: p.y, t0: g.t0, t1: g.t1, min: g.yMin, max: g.yMax, mosso: false };
          }
        }}
        onMouseUp={() => (trascina.current = null)}
        onDoubleClick={tornaLive}
      />
      <button
        onClick={tornaLive}
        disabled={!vistaX}
        title={vistaX ? 'Torna a seguire i dati (anche doppio clic sulla mappa)' : 'La mappa segue i dati'}
        className={`absolute top-3 right-24 px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-2 border ${
          vistaX
            ? 'bg-amber-600 border-amber-500 text-white hover:bg-amber-500'
            : 'bg-slate-900/80 border-slate-700 text-emerald-400 cursor-default'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${vistaX ? 'bg-white animate-pulse' : 'bg-emerald-400'}`} />
        {vistaX ? 'RESTORE LIVE VIEW' : 'LIVE'}
      </button>
    </div>
  );
}
