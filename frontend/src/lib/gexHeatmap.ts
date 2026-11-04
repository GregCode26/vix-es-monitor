/**
 * Mappa di calore del GEX per strike nel tempo, per /gex.
 *
 * Prima ogni strike era una linea spezzata in tratti di due minuti, e ogni
 * tratto prendeva colore e spessore dal valore alla sua fine: il muro
 * cambiava a scatti, e crescita e calo si leggevano solo come una linea che
 * ingrassa o dimagrisce di qualche pixel. Qui invece:
 *
 *  - la serie (una fotografia ogni ~2 minuti) si ricampiona su una griglia
 *    regolare interpolando linearmente, e l'immagine si disegna con lo
 *    smoothing del browser: fra un istante e l'altro il colore sfuma;
 *  - la scala di colore e' continua e sale anche di luminosita' (scuro ->
 *    saturo -> chiaro), quindi un muro che cresce si vede schiarire;
 *  - la modalita' "variazione" colora invece quanto |GEX| e' cambiato negli
 *    ultimi N minuti: ciano quando il muro si rafforza, arancio quando si
 *    scioglie, nero quando sta fermo.
 *
 * Un'immagine sola, disegnata con drawImage: con ~77 strike per ~1000 colonne
 * sarebbero decine di migliaia di rettangoli con gradiente a ogni pan.
 */

/**
 * - `termico`: stile Bookmap, una sola scala calda su |GEX| (il segno lo dice
 *   la colonna del profilo a destra, come il COB di Bookmap);
 * - `livello`: verde il gamma positivo, rosa il negativo;
 * - `variazione`: quanto |GEX| e' cambiato negli ultimi minuti.
 */
export type ModoMappa = 'termico' | 'livello' | 'variazione';

export interface FotogrammaMappa {
  /** Millisecondi sull'asse del grafico. */
  t: number;
  /** Valori nell'ordine di `strikes`. */
  valori: number[];
}

export interface MappaGex {
  immagine: HTMLCanvasElement;
  /** Centro della prima e dell'ultima colonna, in ms. */
  t0: number;
  t1: number;
  passoT: number;
  /** Strike della riga in alto e in basso. */
  kAlto: number;
  kBasso: number;
  passoK: number;
  /** Il valore a cui la scala arriva in fondo (M$), per la legenda. */
  fondo: number;
  /** Il profilo dell'ultima colonna, per la colonna stile COB. */
  ultimo: { strike: number; valore: number }[];
  /** Per il tooltip: valore e variazione interpolati in un punto. */
  leggi: (t: number, strike: number) => { strike: number; valore: number; delta: number } | null;
}

/** Passo della griglia nel tempo. */
const PASSO_T_MS = 30_000;
/** Righe d'immagine per strike: lo smoothing sfuma solo i bordi fra uno strike e l'altro. */
const RIGHE_PER_STRIKE = 6;
/** Due fotografie piu' distanti di cosi' non si uniscono: in mezzo il poller era fermo. */
const BUCO_MS = 10 * 60_000;

type Tappa = [number, number, number, number];

/** Gamma positivo: dal verde petrolio al verde, fino al giallo chiaro. */
const SCALA_POS: Tappa[] = [
  [0.0, 8, 40, 44], [0.3, 13, 128, 120], [0.6, 52, 211, 153], [0.85, 190, 242, 100], [1.0, 254, 249, 195],
];
/** Gamma negativo: dal vinaccia al rosa acceso, fino al pesca chiaro. */
const SCALA_NEG: Tappa[] = [
  [0.0, 52, 10, 36], [0.3, 157, 23, 77], [0.6, 244, 63, 94], [0.85, 251, 146, 120], [1.0, 255, 228, 214],
];
/**
 * La scala di Bookmap: dal blu notte al blu, ciano, giallo, arancio, rosso,
 * e bianco in cima. Un muro che cresce "scalda".
 */
const SCALA_TERMICA: Tappa[] = [
  [0.0, 12, 22, 48], [0.18, 22, 60, 130], [0.36, 30, 125, 200], [0.5, 70, 185, 215],
  [0.64, 215, 205, 85], [0.78, 238, 140, 45], [0.9, 222, 72, 38], [1.0, 255, 236, 220],
];
/** Muro che si rafforza. */
const SCALA_SU: Tappa[] = [
  [0.0, 8, 30, 60], [0.35, 3, 105, 161], [0.7, 34, 211, 238], [1.0, 236, 254, 255],
];
/** Muro che si indebolisce. */
const SCALA_GIU: Tappa[] = [
  [0.0, 60, 20, 8], [0.35, 194, 65, 12], [0.7, 251, 146, 60], [1.0, 255, 237, 213],
];

function campiona(scala: Tappa[], q: number): [number, number, number] {
  if (q <= scala[0][0]) return [scala[0][1], scala[0][2], scala[0][3]];
  for (let i = 1; i < scala.length; i++) {
    if (q <= scala[i][0]) {
      const a = scala[i - 1];
      const b = scala[i];
      const f = (q - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  const u = scala[scala.length - 1];
  return [u[1], u[2], u[3]];
}

/**
 * Colore e opacita' di una cella. L'opacita' sale con la quota (piu' in
 * fretta all'inizio), cosi' i valori piccoli si confondono col fondo invece di
 * accendersi di colpo sopra una soglia.
 */
function colore(scala: Tappa[], q: number): [number, number, number, number] {
  const c = campiona(scala, q);
  const alfa = Math.min(1, Math.pow(q, 0.6) * 1.15);
  return [c[0], c[1], c[2], Math.round(alfa * 255)];
}

/** La scala termica di Bookmap per una quota 0..1, [r, g, b, alfa 0..255]: la usa anche /bookmap. */
export function coloreTermico(q: number): [number, number, number, number] {
  return colore(SCALA_TERMICA, q);
}

/** Gradiente CSS di una scala, per la legenda. */
export function gradienteCss(modo: ModoMappa, verso: 'pos' | 'neg'): string {
  const scala = modo === 'termico' ? SCALA_TERMICA
    : modo === 'livello' ? (verso === 'pos' ? SCALA_POS : SCALA_NEG) : (verso === 'pos' ? SCALA_SU : SCALA_GIU);
  const tappe = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1].map((q) => {
    const [r, g, b, a] = colore(scala, q);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(2)}) ${q * 100}%`;
  });
  return `linear-gradient(to right, ${tappe.join(', ')})`;
}

function percentile(valori: number[], p: number): number {
  if (valori.length === 0) return 0;
  const ord = [...valori].sort((a, b) => a - b);
  return ord[Math.min(ord.length - 1, Math.floor(p * (ord.length - 1)))];
}

/**
 * Costruisce l'immagine. `lookbackMin` serve solo alla variazione.
 * Restituisce null se non c'e' niente da disegnare.
 */
export function costruisciMappa(
  strikes: number[],
  fotogrammi: FotogrammaMappa[],
  modo: ModoMappa,
  lookbackMin: number,
  /**
   * Contrasto, come lo slider di Bookmap: 2 vuol dire che il colore pieno
   * arriva gia' a meta' del fondo scala (i muri piccoli si vedono meglio, i
   * grandi saturano), 0,5 il contrario.
   */
  contrasto = 1,
): MappaGex | null {
  if (typeof document === 'undefined' || strikes.length === 0 || fotogrammi.length === 0) return null;
  const fot = [...fotogrammi].sort((a, b) => a.t - b.t);

  // Strike ordinati dall'alto e passo della griglia: il piu' piccolo scarto.
  const ordine = strikes.map((k, i) => ({ k, i })).sort((a, b) => b.k - a.k);
  let passoK = Infinity;
  for (let j = 1; j < ordine.length; j++) {
    const d = ordine[j - 1].k - ordine[j].k;
    if (d > 0 && d < passoK) passoK = d;
  }
  if (!isFinite(passoK)) passoK = 5;
  const kAlto = ordine[0].k;
  const kBasso = ordine[ordine.length - 1].k;
  const nIndici = Math.round((kAlto - kBasso) / passoK) + 1;

  const t0 = fot[0].t;
  const t1 = fot[fot.length - 1].t;
  const nCol = Math.max(1, Math.round((t1 - t0) / PASSO_T_MS) + 1);

  // Valori ricampionati: [strike originale][colonna], NaN dove c'e' un buco.
  const griglia: Float64Array[] = strikes.map(() => new Float64Array(nCol).fill(NaN));
  let s = 0;
  for (let c = 0; c < nCol; c++) {
    const t = t0 + c * PASSO_T_MS;
    while (s < fot.length - 2 && fot[s + 1].t < t) s++;
    const a = fot[s];
    const b = fot[Math.min(s + 1, fot.length - 1)];
    let f: number;
    if (b.t === a.t) f = 0;
    else if (b.t - a.t > BUCO_MS) {
      // Nel buco si tiene il valore solo vicino ai due bordi.
      if (t - a.t <= PASSO_T_MS) f = 0;
      else if (b.t - t <= PASSO_T_MS) f = 1;
      else continue;
    } else f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    for (let i = 0; i < strikes.length; i++) {
      const va = a.valori[i] ?? 0;
      const vb = b.valori[i] ?? 0;
      griglia[i][c] = va + (vb - va) * f;
    }
  }

  // Variazione di |GEX| sul lookback.
  const passi = Math.max(1, Math.round((lookbackMin * 60_000) / PASSO_T_MS));
  const delta: Float64Array[] = griglia.map((riga) => {
    const out = new Float64Array(nCol).fill(NaN);
    for (let c = 0; c < nCol; c++) {
      const ora = riga[c];
      if (isNaN(ora)) continue;
      let prima = NaN;
      for (let d = Math.max(0, c - passi); d < c && isNaN(prima); d++) prima = riga[d];
      out[c] = isNaN(prima) ? 0 : Math.abs(ora) - Math.abs(prima);
    }
    // Media mobile su meta' lookback: la differenza grezza cambia segno da un
    // campione all'altro e disegnava tagli netti ciano/arancio. Mediata,
    // passa per lo zero (cioe' per il nero) prima di girare.
    const finestra = Math.max(2, Math.round(passi / 2));
    const liscia = new Float64Array(nCol).fill(NaN);
    let somma = 0;
    let quanti = 0;
    for (let c = 0; c < nCol; c++) {
      if (!isNaN(out[c])) { somma += out[c]; quanti++; }
      const via = c - finestra;
      if (via >= 0 && !isNaN(out[via])) { somma -= out[via]; quanti--; }
      if (!isNaN(out[c]) && quanti > 0) liscia[c] = somma / quanti;
    }
    return liscia;
  });

  // Fondo scala. Per il livello il massimo della sessione: tutta la storia sta
  // sullo stesso metro, quindi un muro che raddoppia si vede raddoppiare. Per
  // la variazione il 98esimo percentile: un solo salto (l'apertura, un
  // ricentro) altrimenti spegnerebbe tutto il resto.
  let fondo = 0;
  if (modo !== 'variazione') {
    for (const riga of griglia) for (const v of riga) if (!isNaN(v) && Math.abs(v) > fondo) fondo = Math.abs(v);
  } else {
    const campioni: number[] = [];
    for (const riga of delta) for (let c = 0; c < riga.length; c += 2) if (!isNaN(riga[c]) && riga[c] !== 0) campioni.push(Math.abs(riga[c]));
    fondo = percentile(campioni, 0.98);
  }
  if (!(fondo > 0)) fondo = 1;
  fondo /= Math.max(0.05, contrasto);

  const larghezza = nCol;
  const altezza = nIndici * RIGHE_PER_STRIKE;
  const immagine = document.createElement('canvas');
  immagine.width = larghezza;
  immagine.height = altezza;
  const ctx = immagine.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(larghezza, altezza);

  for (const { k, i } of ordine) {
    const j = Math.round((kAlto - k) / passoK);
    for (let c = 0; c < nCol; c++) {
      let rgba: [number, number, number, number];
      if (modo === 'termico') {
        const v = griglia[i][c];
        if (isNaN(v) || v === 0) continue;
        rgba = colore(SCALA_TERMICA, Math.min(1, Math.sqrt(Math.abs(v) / fondo)));
      } else if (modo === 'livello') {
        const v = griglia[i][c];
        if (isNaN(v) || v === 0) continue;
        const q = Math.min(1, Math.sqrt(Math.abs(v) / fondo));
        rgba = colore(v > 0 ? SCALA_POS : SCALA_NEG, q);
      } else {
        const d = delta[i][c];
        if (isNaN(d) || d === 0) continue;
        // Lineare e non radice: con la radice anche variazioni minime
        // prendevano colore, e il grafico era un tappeto di ciano e arancio.
        const q = Math.min(1, Math.abs(d) / fondo);
        rgba = colore(d > 0 ? SCALA_SU : SCALA_GIU, q);
      }
      for (let r = 0; r < RIGHE_PER_STRIKE; r++) {
        const p = ((j * RIGHE_PER_STRIKE + r) * larghezza + c) * 4;
        img.data[p] = rgba[0];
        img.data[p + 1] = rgba[1];
        img.data[p + 2] = rgba[2];
        img.data[p + 3] = rgba[3];
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const leggi = (t: number, strike: number) => {
    const c = Math.round((t - t0) / PASSO_T_MS);
    if (c < 0 || c >= nCol) return null;
    let migliore = -1;
    let dist = Infinity;
    for (let i = 0; i < strikes.length; i++) {
      const d = Math.abs(strikes[i] - strike);
      if (d < dist) { dist = d; migliore = i; }
    }
    if (migliore < 0 || dist > passoK) return null;
    const valore = griglia[migliore][c];
    if (isNaN(valore)) return null;
    return { strike: strikes[migliore], valore, delta: delta[migliore][c] };
  };

  // Ultima colonna con un valore, strike per strike.
  const ultimo = strikes.map((strike, i) => {
    let valore = 0;
    for (let c = nCol - 1; c >= 0; c--) if (!isNaN(griglia[i][c])) { valore = griglia[i][c]; break; }
    return { strike, valore };
  });

  return { immagine, t0, t1, passoT: PASSO_T_MS, kAlto, kBasso, passoK, fondo, ultimo, leggi };
}

/**
 * Disegna la mappa nell'area del grafico, sotto i dataset. Gli assi sono
 * quelli di /gex: `xTime` e `y`.
 */
export function disegnaMappa(
  chart: { ctx: CanvasRenderingContext2D; chartArea: { left: number; right: number; top: number; bottom: number }; scales: Record<string, { getPixelForValue: (v: number) => number }> },
  mappa: MappaGex,
): void {
  const x = chart.scales.xTime;
  const y = chart.scales.y;
  const area = chart.chartArea;
  if (!x || !y || !area) return;

  // L'immagine copre mezzo passo oltre il centro della prima e dell'ultima
  // colonna (riga), cosi' ogni cella sta centrata sul suo istante (strike).
  const xa = x.getPixelForValue(mappa.t0 - mappa.passoT / 2);
  const xb = x.getPixelForValue(mappa.t1 + mappa.passoT / 2);
  const ya = y.getPixelForValue(mappa.kAlto + mappa.passoK / 2);
  const yb = y.getPixelForValue(mappa.kBasso - mappa.passoK / 2);
  if (![xa, xb, ya, yb].every(isFinite)) return;

  const ctx = chart.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mappa.immagine, xa, ya, xb - xa, yb - ya);
  ctx.restore();
}

/** Larghezza della colonna del profilo, in pixel, a destra della scala. */
export const LARGHEZZA_COLONNA = 96;

/**
 * La colonna stile COB di Bookmap, a destra della scala degli strike: il
 * profilo di adesso, una barra per strike, verde GEX+ e rossa GEX-, lunga in
 * proporzione al muro piu' grande del momento, con il valore in Bn quando la
 * riga e' abbastanza alta da leggerlo.
 */
export function disegnaColonna(
  chart: { ctx: CanvasRenderingContext2D; width: number; chartArea: { top: number; bottom: number }; scales: Record<string, { getPixelForValue: (v: number) => number }> },
  mappa: MappaGex,
): void {
  const y = chart.scales.y;
  if (!y) return;
  const ctx = chart.ctx;
  const x0 = chart.width - LARGHEZZA_COLONNA;
  const top = chart.chartArea.top;
  const bottom = chart.chartArea.bottom;
  const massimo = mappa.ultimo.reduce((m, r) => Math.max(m, Math.abs(r.valore)), 0);
  const altezza = Math.abs(y.getPixelForValue(mappa.kBasso) - y.getPixelForValue(mappa.kBasso + mappa.passoK));

  ctx.save();
  ctx.fillStyle = '#10131a';
  ctx.fillRect(x0, top, LARGHEZZA_COLONNA, bottom - top);
  ctx.strokeStyle = '#1e293b';
  ctx.beginPath();
  ctx.moveTo(x0 + 0.5, top);
  ctx.lineTo(x0 + 0.5, bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(x0, top, LARGHEZZA_COLONNA, bottom - top);
  ctx.clip();

  if (massimo > 0) {
    const h = Math.max(1, altezza - 1);
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const { strike, valore } of mappa.ultimo) {
      // Sotto i 50 M$ (o l'1% del muro piu' grande) e' rumore: niente
      // barra e niente "0.0" ripetuto su mezza colonna.
      if (Math.abs(valore) < Math.max(50, massimo * 0.01)) continue;
      const yc = y.getPixelForValue(strike);
      if (yc < top - h || yc > bottom + h) continue;
      const q = Math.sqrt(Math.abs(valore) / massimo);
      const lungo = Math.max(1, q * (LARGHEZZA_COLONNA - 6));
      ctx.fillStyle = valore > 0 ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(x0 + 3, yc - h / 2, lungo, h);
      if (h >= 10) {
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText((Math.abs(valore) / 1000).toFixed(1), x0 + 6, yc);
      }
    }
  }
  ctx.restore();
  // Il titolo sotto la colonna, all'altezza delle ore: dentro copriva la
  // prima riga, sopra usciva dal canvas.
  ctx.save();
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('GEX ora (Bn)', x0 + 6, bottom + 6);
  ctx.restore();
}
