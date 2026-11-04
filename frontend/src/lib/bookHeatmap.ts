/**
 * Heatmap della liquidita' di ES per /bookmap, nello stile di Bookmap.
 *
 * Prima ogni ordine limit sopra soglia era un segmento a colore fisso (verde
 * bid, rosso ask) con l'opacita' presa dal massimo dei contratti del tratto:
 * un muro che cresceva o si assottigliava restava dello stesso colore per
 * tutto il segmento, e compariva o spariva di colpo alla soglia. Qui invece
 * ogni colonna di pixel e' la media dei contratti di quel livello nei secondi
 * che copre, colorata sulla scala termica (blu poco, giallo-arancio tanto,
 * bianco il massimo): un muro che si costruisce si vede "scaldare", uno che
 * si scioglie raffreddarsi, e una leggera sfumatura fra colonne vicine toglie
 * gli scalini. Come in Bookmap la mappa non distingue bid e ask (il prezzo
 * li separa da solo); il lato lo dice la colonna del book a destra.
 *
 * L'immagine e' grande quanto l'area del grafico e si rifa' solo quando
 * cambiano vista, dati o impostazioni: il mirino ridisegna il grafico a ogni
 * movimento del mouse.
 */

import { coloreTermico } from './gexHeatmap';

export interface CampioneBook {
  book: { b: [number, number][]; a: [number, number][] } | null;
}

export interface VistaMappa {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  larghezza: number;
  altezza: number;
}

export interface MappaBook {
  chiave: string;
  immagine: HTMLCanvasElement;
  /** Prezzo del bordo alto e basso dell'immagine. */
  prezzoAlto: number;
  prezzoBasso: number;
  /** Contratti a cui la scala arriva in fondo. */
  fondo: number;
}

/** Al massimo tante righe d'immagine: oltre, piu' tick finiscono nella stessa riga (si prende il massimo). */
const RIGHE_MAX = 1200;
/** Un campione vale per la colonna se dista dal suo centro meno di cosi' (secondi): oltre e' un buco. */
const BUCO_SEC = 1.5;

/** Primo indice con xs[i] >= v. */
function primoDa(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Costruisce (o restituisce dalla cache) l'immagine della vista.
 * `soglia`: sotto questi contratti il livello sfuma verso il trasparente
 * (da meta' soglia a soglia), invece di sparire di colpo.
 * `contrasto`: >1 il colore pieno arriva prima, i livelli piccoli escono.
 */
export function mappaBook(
  pts: CampioneBook[],
  xs: number[],
  vista: VistaMappa,
  tick: number,
  soglia: number,
  contrasto: number,
  cache: MappaBook | null,
): MappaBook | null {
  if (typeof document === 'undefined' || pts.length === 0) return null;
  const { xMin, xMax, yMin, yMax } = vista;
  const C = Math.max(1, Math.min(2000, Math.round(vista.larghezza)));
  if (!(xMax > xMin) || !(yMax > yMin)) return null;

  const chiave = [xMin, xMax, yMin, yMax, C, Math.round(vista.altezza), pts.length, xs[xs.length - 1], soglia, contrasto].join('|');
  if (cache && cache.chiave === chiave) return cache;

  const livAlto = Math.ceil(yMax / tick);
  const livBasso = Math.floor(yMin / tick);
  const livelli = livAlto - livBasso + 1;
  const tickPerRiga = Math.max(1, Math.ceil(livelli / RIGHE_MAX));
  const R = Math.ceil(livelli / tickPerRiga);

  const dt = (xMax - xMin) / C;
  const somma = new Float32Array(C * R);
  const presente = new Uint8Array(C);
  const riga = new Float32Array(R);

  for (let c = 0; c < C; c++) {
    const t0 = xMin + c * dt;
    const t1 = t0 + dt;
    let i0 = primoDa(xs, t0);
    let i1 = primoDa(xs, t1);
    if (i1 <= i0) {
      // Colonna piu' stretta di un secondo: il campione piu' vicino al centro.
      const centro = (t0 + t1) / 2;
      let migliore = -1;
      for (const j of [i0 - 1, i0]) {
        if (j >= 0 && j < xs.length && Math.abs(xs[j] - centro) <= BUCO_SEC && (migliore < 0 || Math.abs(xs[j] - centro) < Math.abs(xs[migliore] - centro))) migliore = j;
      }
      if (migliore < 0) continue;
      i0 = migliore;
      i1 = migliore + 1;
    }
    let quanti = 0;
    for (let i = i0; i < i1; i++) {
      const book = pts[i].book;
      if (!book) continue;
      quanti++;
      riga.fill(0);
      for (const lato of [book.b, book.a]) {
        for (const [prezzo, contratti] of lato) {
          const r = Math.floor((livAlto - Math.round(prezzo / tick)) / tickPerRiga);
          if (r < 0 || r >= R) continue;
          if (contratti > riga[r]) riga[r] = contratti;
        }
      }
      for (let r = 0; r < R; r++) if (riga[r] > 0) somma[r * C + c] += riga[r];
    }
    if (quanti === 0) continue;
    presente[c] = 1;
    for (let r = 0; r < R; r++) somma[r * C + c] /= quanti;
  }

  // Sfumatura leggera fra colonne vicine (1-2-1, due passate), mai attraverso
  // un buco: toglie gli scalini senza spostare i muri.
  const tmp = new Float32Array(C);
  for (let passata = 0; passata < 2; passata++) {
    for (let r = 0; r < R; r++) {
      const base = r * C;
      for (let c = 0; c < C; c++) {
        if (!presente[c]) { tmp[c] = 0; continue; }
        const sx = c > 0 && presente[c - 1] ? somma[base + c - 1] : somma[base + c];
        const dx = c < C - 1 && presente[c + 1] ? somma[base + c + 1] : somma[base + c];
        tmp[c] = (sx + 2 * somma[base + c] + dx) / 4;
      }
      somma.set(tmp, base);
    }
  }

  // Fondo scala sui livelli visibili, come l'auto-regolazione di Bookmap: il
  // 99esimo percentile, cosi' un solo muro enorme non spegne tutto il resto.
  const campioni: number[] = [];
  for (let k = 0; k < somma.length; k += 3) if (somma[k] > 0) campioni.push(somma[k]);
  campioni.sort((a, b) => a - b);
  let fondo = campioni.length > 0 ? campioni[Math.floor(0.99 * (campioni.length - 1))] : 1;
  fondo = Math.max(soglia, fondo) / Math.max(0.05, contrasto);

  const immagine = cache?.immagine ?? document.createElement('canvas');
  immagine.width = C;
  immagine.height = R;
  const ctx = immagine.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(C, R);
  const mezza = soglia / 2;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const v = somma[r * C + c];
      if (!(v > mezza)) continue;
      // Lineare, non radice: nel book quasi tutti i livelli stanno fra la
      // soglia e il fondo scala, e con la radice diventavano tutti gialli;
      // cosi' il book normale resta blu-ciano e i muri escono in arancio.
      const [cr, cg, cb, ca] = coloreTermico(Math.min(1, v / fondo));
      // Da meta' soglia a soglia l'opacita' sale: niente accensioni di colpo.
      const rampa = Math.min(1, (v - mezza) / Math.max(1, soglia - mezza));
      const p = (r * C + c) * 4;
      img.data[p] = cr;
      img.data[p + 1] = cg;
      img.data[p + 2] = cb;
      img.data[p + 3] = Math.round(ca * rampa);
    }
  }
  ctx.putImageData(img, 0, 0);

  return {
    chiave,
    immagine,
    prezzoAlto: (livAlto + 0.5) * tick,
    prezzoBasso: (livAlto - R * tickPerRiga + 0.5) * tick,
    fondo,
  };
}

/** Larghezza della colonna del book a destra, in pixel. */
export const LARGHEZZA_COB = 92;

/**
 * La colonna del book di adesso, come il COB di Bookmap: dentro l'area del
 * grafico, sul bordo destro, una barra per livello lunga in proporzione ai
 * contratti, verde i bid e rossa gli ask, col numero quando la riga e'
 * abbastanza alta da leggerlo.
 */
export function disegnaCob(
  ctx: CanvasRenderingContext2D,
  area: { left: number; right: number; top: number; bottom: number },
  yPixel: (prezzo: number) => number,
  tick: number,
  ultimo: CampioneBook | undefined,
): void {
  const book = ultimo?.book;
  const x0 = area.right - LARGHEZZA_COB;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, area.top, LARGHEZZA_COB, area.bottom - area.top);
  ctx.clip();
  ctx.fillStyle = 'rgba(16, 19, 26, 0.92)';
  ctx.fillRect(x0, area.top, LARGHEZZA_COB, area.bottom - area.top);
  ctx.strokeStyle = '#1e293b';
  ctx.beginPath();
  ctx.moveTo(x0 + 0.5, area.top);
  ctx.lineTo(x0 + 0.5, area.bottom);
  ctx.stroke();

  if (book) {
    const tutti = [...book.b.map(([p, c]) => ({ p, c, bid: true })), ...book.a.map(([p, c]) => ({ p, c, bid: false }))];
    const massimo = tutti.reduce((m, l) => Math.max(m, l.c), 0);
    const h = Math.max(1, Math.abs(yPixel(0) - yPixel(tick)) - 1);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const l of tutti) {
      const y = yPixel(l.p);
      if (y < area.top - h || y > area.bottom + h || massimo <= 0) continue;
      const lungo = Math.max(1, Math.sqrt(l.c / massimo) * (LARGHEZZA_COB - 6));
      ctx.fillStyle = l.bid ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(x0 + 3, y - h / 2, lungo, h);
      if (h >= 10) {
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(String(Math.round(l.c)), x0 + 6, y);
      }
    }
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('COB', x0 + 6, area.top + 3);
  ctx.restore();
}
