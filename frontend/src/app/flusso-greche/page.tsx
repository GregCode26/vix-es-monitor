'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { RigaGreche, RiferimentoMaxChange } from '../api/flusso-greche/route';

/**
 * Pagina di prova (19/11/2026): la specifica "Comp/Vend + greche" dell'utente su SPX 0DTE, disegnata
 * come i suoi screenshot (candele, profilo DEX a sinistra, Gamma a destra, Major Short/Long Gamma).
 * I dati e le differenze dalla specifica sono descritti in `api/flusso-greche/route.ts`. Nessuna verifica
 * di valore operativo: e' una vista, non un segnale.
 */

const REFRESH_MS = 15000;
const VERDE = '#22c55e';
const VIOLA = '#a855f7';
const AZZURRO = '#22d3ee';
const ARANCIO = '#f97316';
const BLU = '#3b82f6';

/** mm = ES che il MM ha comprato (+) / venduto (−) nel minuto: mmFlusso nuovi scambi, mmGreche prezzo/tempo/vol. */
type Candela = { t: string; o: number; h: number; l: number; c: number; mm?: number; mmFlusso?: number; mmGreche?: number };
type ColoreCandele = 'totale' | 'greche' | 'flusso' | 'prezzo';
type Risposta = {
  date: string; time: string; spot: number; T: number; inizioLr: string | null;
  righe: RigaGreche[]; riferimenti: RiferimentoMaxChange[]; candele: Candela[]; error?: string;
};

type Greca = 'gamma' | 'delta' | 'vanna' | 'charm' | 'none';
type ModoGexp = 'netto' | 'taglia';
type Misura = 'azione' | 'dex' | 'gammaNetto' | 'gexp' | 'profileNetto' | 'vex' | 'chex' | 'imbCall' | 'imbPut';

const NOMI: Record<Misura, string> = {
  azione: 'AZIONE MM (ES)',
  dex: 'DEX $MM',
  gammaNetto: 'GAMMA $MM',
  gexp: 'GEX PROFILE $MM',
  profileNetto: 'PROFILE NETTO',
  vex: '−VANNA EX $MM',
  chex: 'CHARM EX $MM/ora',
  imbCall: 'IMB CALL (contratti)',
  imbPut: 'IMB PUT (contratti)',
};

interface Calcolo {
  strike: number;
  imbCall: number; imbPut: number;
  gammaNetto: number; deltaNetto: number; gexp: number; profileNetto: number;
  dex: number; vex: number; chex: number;
  /** ES che il MM compra (+) o vende (−) se SPX arriva a questo strike nello scenario scelto. */
  azione: number;
  callDominant: boolean;
}

function calcola(r: Risposta, greca: Greca, modo: ModoGexp): Calcolo[] {
  const S = r.spot;
  const gexK = S * S * 0.01 * 100, dexK = S * 100, vexK = S * 0.01 * 100, chexK = S * 100;
  return r.righe.map((x) => {
    const ic = x.cb - x.cs, ip = x.pb - x.ps;
    const gexpNetto = (ic - ip) * x.gamma * gexK / 1e6;
    const gexpTaglia = (Math.abs(ic) - Math.abs(ip)) * x.gamma * gexK / 1e6;
    const gexp = modo === 'netto' ? gexpNetto : gexpTaglia;
    // Profile Netto secondo il selettore greca. Vanna e charm sono uguali per call e put (una sola IV per strike).
    const profileNetto = greca === 'gamma' ? gexp
      : greca === 'delta' ? ic * x.deltaC - ip * Math.abs(x.deltaP)
      : greca === 'vanna' ? (ic - ip) * x.vanna
      : greca === 'charm' ? (ic - ip) * x.charm
      : ic - ip;
    return {
      strike: x.strike,
      imbCall: ic, imbPut: ip,
      gammaNetto: (ic + ip) * x.gamma * gexK / 1e6,
      deltaNetto: (ic * x.deltaC + ip * x.deltaP) * dexK / 1e6,
      gexp,
      profileNetto,
      dex: ic * x.deltaC + ip * x.deltaP,
      vex: (ic + ip) * x.vanna * vexK,
      chex: (ic + ip) * x.charm * chexK / (365 * 24),
      callDominant: x.cb + x.cs >= x.pb + x.ps,
      azione: 0,
    };
  });
}

/** Valore disegnato di una misura: DEX in $MM (Delta Netto), VEX/CHEX in $MM come i totali. */
function valore(c: Calcolo, m: Misura): number {
  switch (m) {
    case 'azione': return c.azione;
    case 'dex': return c.deltaNetto;
    case 'gammaNetto': return c.gammaNetto;
    case 'gexp': return c.gexp;
    case 'profileNetto': return c.profileNetto;
    case 'vex': return c.vex / 1e6;
    case 'chex': return c.chex / 1e6;
    case 'imbCall': return c.imbCall;
    case 'imbPut': return c.imbPut;
  }
}

/**
 * Cosa fa il market maker su ES per la barra di quello strike (controparte dei clienti, segno opposto).
 *  - Gamma Netto: copertura quando il prezzo VA verso lo strike. MM delta cambia di −gammaNetto·dS, la copertura
 *    e' +gammaNetto·dS: sopra lo spot (prezzo che sale) BUY se gammaNetto > 0 (MM short gamma), sotto lo spot
 *    (prezzo che scende) BUY se gammaNetto < 0 (MM long gamma compra i ribassi). Strike ATM: entrambi i versi.
 *  - DEX: i clienti net long delta -> il MM e' short delta e si copre comprando ES (BUY), e viceversa.
 *  - Charm: cosa fa il MM nella prossima ora a prezzo fermo, solo per il tempo che passa.
 * Le altre misure non hanno etichetta.
 */
function azioneMm(m: Misura, c: Calcolo, spot: number): { testo: string; buy: boolean } | null {
  if (m === 'azione') {
    if (c.azione === 0) return null;
    return { testo: c.azione > 0 ? 'BUY' : 'SELL', buy: c.azione > 0 };
  }
  if (m === 'dex') {
    if (c.deltaNetto === 0) return null;
    return { testo: c.deltaNetto > 0 ? 'BUY' : 'SELL', buy: c.deltaNetto > 0 };
  }
  if (m === 'chex') {
    // charm della route = variazione del delta per anno che passa (phi(d1)*d2/2T, call e put uguali): il delta dei
    // clienti cambia di chex all'ora, quello del MM di -chex, e la copertura e' +chex: positivo = il MM compra ES.
    if (c.chex === 0) return null;
    return { testo: c.chex > 0 ? 'BUY' : 'SELL', buy: c.chex > 0 };
  }
  if (m === 'gammaNetto') {
    const g = c.gammaNetto;
    if (g === 0) return null;
    if (Math.abs(c.strike - spot) < 2.5) return g > 0 ? { testo: 'BUY↑ SELL↓', buy: true } : { testo: 'SELL↑ BUY↓', buy: false };
    const buy = g * (c.strike - spot) > 0;
    return { testo: buy ? 'BUY' : 'SELL', buy };
  }
  return null;
}

/** Normale cumulata (erf di Abramowitz-Stegun 7.1.26, errore ~1e-7). */
function ncdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Terzo profilo "Azione MM": gamma, charm e vanna sommati in un'unica unita', gli ES da comprare/vendere.
 * Le greche non si sommano direttamente (gamma per punto, charm per ora, vanna per punto di vol), quindi si
 * rivaluta: per ogni prezzo P, il delta Black-Scholes di ogni strike a (P, T - dt, IV + dVol) meno quello di
 * adesso (spot, T, IV), per lo sbilancio netto dei clienti (call + put, delta put = delta call - 1). Il delta
 * dei clienti che sale = il MM che deve comprare ES. Contratti SPX x 100 / 50 = ES (x2), basis ignorata.
 * IV per strike quella ricavata dalla route (sticky strike); dove manca (delta 0/1) quella dello strike vicino.
 * dtMin < 0 = scadenza (valore intrinseco). Il DEX non entra: e' la copertura gia' fatta, non da fare.
 */
function azioniScenario(r: Risposta, prezzi: number[], dtMin: number, dVol: number): number[] {
  const righe = r.righe;
  const sig = righe.map((x, i) => {
    if (x.iv) return x.iv;
    let best: number | null = null, d = Infinity;
    righe.forEach((y, j) => { if (y.iv && Math.abs(j - i) < d) { d = Math.abs(j - i); best = y.iv; } });
    return best;
  });
  const T1 = dtMin < 0 ? 0 : Math.max(0, r.T - dtMin * 60 / (365 * 86400));
  const dC = (P: number, K: number, s: number | null, T: number) => {
    if (!s || T <= 0) return P > K ? 1 : P < K ? 0 : 0.5;
    const sr = s * Math.sqrt(T);
    return ncdf((Math.log(P / K) + 0.5 * sr * sr) / sr);
  };
  const base = righe.map((x, i) => dC(r.spot, x.strike, sig[i], r.T));
  return prezzi.map((P) => {
    let es = 0;
    righe.forEach((x, i) => {
      const netto = (x.cb - x.cs) + (x.pb - x.ps);
      if (!netto) return;
      const s0 = sig[i];
      const s1 = s0 ? Math.max(0.01, s0 + dVol / 100) : null;
      es += netto * (dC(P, x.strike, s1, T1) - base[i]);
    });
    return es * 2;
  });
}

function argEstremo(righe: Calcolo[], f: (c: Calcolo) => number, verso: 1 | -1): number | null {
  let k: number | null = null, best = 0;
  for (const c of righe) {
    const v = f(c) * verso;
    if (v > best) { best = v; k = c.strike; }
  }
  return k;
}

const fmt = (v: number, d = 0) => {
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toLocaleString('it-IT', { maximumFractionDigits: 0 }) : a.toFixed(d);
  return `${v < 0 ? '−' : v > 0 ? '+' : ''}${s}`;
};
/** Didascalia sopra ogni profilo: a cosa si riferisce e come leggere il segno. */
function didascalia(m: Misura, scenario: string): string {
  switch (m) {
    case 'azione': return `ES che il MM compra/vende se SPX arriva qui ${scenario}`;
    case 'dex': return 'Copertura gia\' fatta dal MM: BUY = ha comprato ES';
    case 'gammaNetto': return 'MM se il prezzo va verso lo strike: + = MM short gamma';
    case 'gexp': return 'Flusso clienti x gamma: + call comprate / put vendute';
    case 'profileNetto': return 'Sbilancio clienti per la greca scelta';
    case 'vex': return 'Delta dei clienti se la vol sale di 1 punto';
    case 'chex': return 'MM nella prossima ora a prezzo fermo (tempo che passa)';
    case 'imbCall': return 'Call comprate − vendute dai clienti';
    case 'imbPut': return 'Put comprate − vendute dai clienti';
  }
}

const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

function Grafico({ dati, righe, sinistra, destra, terza, finestra, conCallPut, conAzioni, scenario, coloreCandele }: {
  dati: Risposta; righe: Calcolo[]; sinistra: Misura; destra: Misura; terza: Misura | 'none'; finestra: number; conCallPut: boolean; conAzioni: boolean; scenario: string; coloreCandele: ColoreCandele;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [larghezza, setLarghezza] = useState(1200);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setLarghezza(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = larghezza, H = 680, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f17'; ctx.fillRect(0, 0, W, H);

    // In alto: nome del profilo, didascalia, scala.
    const TOP = 54, BOT = 26, DESTRA = 90;
    const plotW = W - DESTRA;
    const candele = finestra > 0 ? dati.candele.slice(-finestra) : dati.candele;
    if (righe.length === 0) return;

    // Scala dei prezzi: gli strike seguiti piu' le candele visibili.
    let lo = Math.min(...righe.map((r) => r.strike)), hi = Math.max(...righe.map((r) => r.strike));
    for (const c of candele) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    lo -= 3; hi += 3;
    const y = (p: number) => TOP + (hi - p) / (hi - lo) * (H - TOP - BOT);

    // Griglia orizzontale ogni 10 punti, etichette a destra ogni 50.
    ctx.font = '11px ui-monospace, monospace';
    for (let p = Math.ceil(lo / 10) * 10; p <= hi; p += 10) {
      ctx.strokeStyle = p % 50 === 0 ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.05)';
      ctx.beginPath(); ctx.moveTo(0, y(p)); ctx.lineTo(plotW, y(p)); ctx.stroke();
      if (p % 50 === 0) { ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'left'; ctx.fillText(String(p), plotW + 8, y(p) + 4); }
    }

    // Posizione dei profili: due a 22% e 68% della larghezza con mezza ampiezza 18%; con il terzo 15/47/79% e 12%.
    const zeri = terza === 'none' ? [0.22, 0.68] : [0.15, 0.47, 0.79];
    const mezza = plotW * (terza === 'none' ? 0.18 : 0.12);
    // Ultima candela fissa nello spazio libero fra il profilo centrale e l'ultimo (quello del MM con il terzo
    // acceso): il prezzo scorre verso sinistra come in Bookmap, le candele piu' vecchie escono dal bordo.
    const xUltima = (plotW * zeri[zeri.length - 2] + mezza + plotW * zeri[zeri.length - 1] - mezza) / 2;

    if (candele.length > 0) {
      const passo = xUltima / Math.max(finestra > 0 ? finestra : candele.length, 30);
      const xDi = (i: number) => xUltima - (candele.length - 1 - i) * passo;
      candele.forEach((c, i) => {
        const x = xDi(i);
        if (x < 0) return;
        const su = c.c >= c.o;
        // Colore = cosa ha fatto il MM in quel minuto (verde compra ES, rosso vende; tenue sotto 100 ES);
        // corpo pieno = candela in salita, vuoto = in discesa. Senza dato MM: grigio come prima.
        const mm = coloreCandele === 'totale' ? c.mm : coloreCandele === 'greche' ? c.mmGreche : coloreCandele === 'flusso' ? c.mmFlusso : undefined;
        let col: string;
        if (mm == null) col = su ? '#e5e7eb' : '#6b7280';
        else if (mm === 0) col = '#6b7280';
        else col = Math.abs(mm) >= 100 ? (mm > 0 ? '#22c55e' : '#ef4444') : (mm > 0 ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)');
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
        const yo = y(c.o), yc = y(c.c);
        const bx = x - Math.max(1, passo * 0.3), bw = Math.max(2, passo * 0.6), by = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
        if (mm == null || su) ctx.fillRect(bx, by, bw, bh);
        else { ctx.fillStyle = '#0b0f17'; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, Math.max(1, bh - 1)); }
      });
      // Orari sotto, uno ogni ~100 px.
      ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
      const ogni = Math.max(1, Math.round(100 / passo));
      candele.forEach((c, i) => { const x = xDi(i); if ((candele.length - 1 - i) % ogni === 0 && x > 20) ctx.fillText(c.t, x, H - 8); });
    }
    // Ultimo prezzo: linea puntinata dall'ultima candela all'asse.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(xUltima, y(dati.spot)); ctx.lineTo(plotW, y(dati.spot)); ctx.stroke();
    ctx.setLineDash([]);

    const altezzaBarra = Math.max(3, Math.abs(y(0) - y(5)) * 0.6);
    const profilo = (m: Misura, zeroX: number, colPos: string, colNeg: string) => {
      const valori = righe.map((r) => valore(r, m));
      const max = Math.max(1e-9, ...valori.map(Math.abs));
      ctx.strokeStyle = 'rgba(168,85,247,0.6)';
      ctx.beginPath(); ctx.moveTo(zeroX, TOP); ctx.lineTo(zeroX, H - BOT); ctx.stroke();
      righe.forEach((r, i) => {
        const v = valori[i];
        if (v === 0) return;
        const w = (Math.abs(v) / max) * mezza;
        // Profilo per prezzo (Azione MM): verde = il MM compra ES, rosso = vende, in qualunque pannello stia.
        ctx.fillStyle = m === 'azione' ? (v > 0 ? '#22c55e' : '#ef4444') : v > 0 ? colPos : colNeg;
        const yy = y(r.strike) - altezzaBarra / 2;
        ctx.beginPath();
        ctx.roundRect(v > 0 ? zeroX : zeroX - w, yy, w, altezzaBarra, altezzaBarra / 2);
        ctx.fill();
        // Etichetta BUY/SELL del market maker in fondo alla barra (solo barre >= 5% della piu' grande).
        const az = conAzioni && Math.abs(v) >= 0.05 * max ? azioneMm(m, r, dati.spot) : null;
        if (az) {
          ctx.font = 'bold 10px ui-monospace, monospace';
          ctx.fillStyle = az.buy ? '#22c55e' : '#ef4444';
          ctx.textAlign = v > 0 ? 'left' : 'right';
          ctx.fillText(az.testo, v > 0 ? zeroX + w + 4 : zeroX - w - 4, y(r.strike) + 3.5);
          ctx.font = '11px ui-monospace, monospace';
        }
      });
      // In alto: nome, didascalia, scala -max / 0 / +max.
      ctx.textAlign = 'center';
      ctx.font = 'bold 12px ui-monospace, monospace'; ctx.fillStyle = colPos;
      ctx.fillText(NOMI[m], zeroX, 14, 2 * mezza);
      ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = '#cbd5e1';
      ctx.fillText(didascalia(m, scenario), zeroX, 29, 2 * mezza);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(fmt(-max), zeroX - mezza, 45); ctx.fillText('0.00', zeroX, 45); ctx.fillText(fmt(max), zeroX + mezza, 45);
    };
    profilo(sinistra, plotW * zeri[0], VERDE, VIOLA);
    profilo(destra, plotW * zeri[1], AZZURRO, VIOLA);
    if (terza !== 'none') profilo(terza, plotW * zeri[2], '#eab308', VIOLA);

    // Livelli.
    const livello = (k: number | null, col: string, nome: string) => {
      if (k == null) return;
      ctx.strokeStyle = col; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, y(k)); ctx.lineTo(plotW, y(k)); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      const testo = `${nome} ${k.toFixed(0)}`;
      ctx.font = 'bold 11px ui-monospace, monospace';
      const tw = ctx.measureText(testo).width + 10;
      ctx.fillStyle = col; ctx.fillRect(plotW - tw, y(k) - 8, tw, 16);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(testo, plotW - tw + 5, y(k) + 4);
      ctx.font = '11px ui-monospace, monospace';
    };
    livello(argEstremo(righe, (c) => c.gammaNetto, -1), ARANCIO, 'Major Short Gamma');
    livello(argEstremo(righe, (c) => c.gammaNetto, 1), BLU, 'Major Long Gamma');
    if (conCallPut) {
      livello(argEstremo(righe, (c) => c.gexp, 1), '#16a34a', 'Major Call Gamma');
      livello(argEstremo(righe, (c) => c.gexp, -1), '#dc2626', 'Major Put Gamma');
    }

    // Spot.
    ctx.fillStyle = '#fff'; ctx.fillRect(plotW + 2, y(dati.spot) - 8, DESTRA - 4, 16);
    ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.fillText(dati.spot.toFixed(2), plotW + 6, y(dati.spot) + 4);
  }, [dati, righe, sinistra, destra, terza, finestra, conCallPut, conAzioni, scenario, coloreCandele, larghezza]);

  return <canvas ref={ref} className="block w-full rounded-lg border border-slate-800" />;
}

function Scheda({ titolo, valore, sotto, colore }: { titolo: string; valore: string; sotto?: string; colore?: string }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2 min-w-[130px]">
      <div className="text-[10px] tracking-wider text-slate-400 uppercase">{titolo}</div>
      <div className="font-mono text-lg font-bold" style={{ color: colore ?? '#e2e8f0' }}>{valore}</div>
      {sotto && <div className="text-[10px] text-slate-500 font-mono">{sotto}</div>}
    </div>
  );
}

export default function FlussoGreche() {
  const router = useRouter();
  const autorizzato = useSyncExternalStore(() => () => {}, () => localStorage.getItem('market_auth') === 'true', () => false);
  const [dati, setDati] = useState<Risposta | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [greca, setGreca] = useState<Greca>('gamma');
  const [modo, setModo] = useState<ModoGexp>('netto');
  const [sinistra, setSinistra] = useState<Misura>('dex');
  const [destra, setDestra] = useState<Misura>('gammaNetto');
  const [terza, setTerza] = useState<Misura | 'none'>('azione');
  const [scDt, setScDt] = useState(30);
  const [scVol, setScVol] = useState(0);
  const [finestra, setFinestra] = useState(120);
  const [conCallPut, setConCallPut] = useState(false);
  const [conAzioni, setConAzioni] = useState(true);
  const [coloreCandele, setColoreCandele] = useState<ColoreCandele>('totale');
  const [giorno, setGiorno] = useState('');

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
  }, [router]);

  useEffect(() => {
    let vivo = true;
    const carica = async () => {
      try {
        const res = await fetch(`/api/flusso-greche${giorno ? `?date=${giorno}` : ''}`, { cache: 'no-store' });
        const j = await res.json();
        if (!vivo) return;
        if (!res.ok || j.error) { setErrore(j.error ?? `HTTP ${res.status}`); return; }
        setDati(j); setErrore(null);
      } catch (e) { if (vivo) setErrore(String(e)); }
    };
    carica();
    const id = giorno ? null : setInterval(carica, REFRESH_MS);
    return () => { vivo = false; if (id) clearInterval(id); };
  }, [giorno]);

  const righe = useMemo(() => {
    if (!dati) return [];
    const base = calcola(dati, greca, modo);
    const az = azioniScenario(dati, base.map((c) => c.strike), scDt, scVol);
    return base.map((c, i) => ({ ...c, azione: az[i] }));
  }, [dati, greca, modo, scDt, scVol]);
  /** ES del MM se SPX resta allo spot per lo scenario (solo tempo e vol). */
  const azioneFermo = useMemo(() => (dati ? azioniScenario(dati, [dati.spot], scDt, scVol)[0] : 0), [dati, scDt, scVol]);

  const totali = useMemo(() => {
    const somma = (f: (c: Calcolo) => number) => righe.reduce((a, c) => a + f(c), 0);
    return {
      dex: somma((c) => c.dex),
      dexMM: somma((c) => c.deltaNetto),
      gex: somma((c) => c.gexp),
      vanna: somma((c) => c.vex) / 1e6,
      charm: somma((c) => c.chex) / 1e6,
      callGamma: argEstremo(righe, (c) => c.gexp, 1),
      putGamma: argEstremo(righe, (c) => c.gexp, -1),
      longGamma: argEstremo(righe, (c) => c.gammaNetto, 1),
      shortGamma: argEstremo(righe, (c) => c.gammaNetto, -1),
    };
  }, [righe]);

  /** Max Change del GEX Profile su 5/10/15 minuti, sugli strike comuni (assente = 0). */
  const maxChange = useMemo(() => {
    if (!dati) return [];
    const ora = new Map(righe.map((c) => [c.strike, c.gexp]));
    return dati.riferimenti.map((rif) => {
      const kRif = Object.keys(rif.gexp).map(Number);
      const kOra = [...ora.keys()];
      if (kRif.length === 0 || kOra.length === 0) return { minuti: rif.minuti, time: rif.time, strike: null as number | null, delta: 0 };
      const lo = Math.max(Math.min(...kOra), Math.min(...kRif)), hi = Math.min(Math.max(...kOra), Math.max(...kRif));
      let strike: number | null = null, delta = 0;
      for (const k of new Set([...kOra, ...kRif])) {
        if (k < lo || k > hi) continue;
        const d = (ora.get(k) ?? 0) - (rif.gexp[String(k)]?.[modo === 'netto' ? 0 : 1] ?? 0);
        if (Math.abs(d) > Math.abs(delta)) { delta = d; strike = k; }
      }
      return { minuti: rif.minuti, time: rif.time, strike, delta };
    });
  }, [dati, righe, modo]);

  if (!autorizzato) return null;

  const sel = 'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs';
  const misure = Object.keys(NOMI) as Misura[];
  const col = (v: number) => (v > 0 ? VERDE : v < 0 ? '#f43f5e' : '#94a3b8');

  return (
    <div className="min-h-screen bg-[#05070c] text-slate-200 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Flusso greche SPX 0DTE <span className="text-amber-400 text-xs font-normal">(in prova)</span></h1>
        <span className="text-xs text-slate-400 font-mono">
          {dati ? `${dati.date} ${dati.time} · SPX ${dati.spot.toFixed(2)} · Comp/Vend Lee-Ready dalle ${dati.inizioLr ?? '?'}` : ''}
        </span>
        <span className="flex-1" />
        <label className="text-xs text-slate-400">Giorno <input type="date" value={giorno} onChange={(e) => setGiorno(e.target.value)} className={sel} /></label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label>Sinistra <select className={sel} value={sinistra} onChange={(e) => setSinistra(e.target.value as Misura)}>{misure.map((m) => <option key={m} value={m}>{NOMI[m]}</option>)}</select></label>
        <label>Destra <select className={sel} value={destra} onChange={(e) => setDestra(e.target.value as Misura)}>{misure.map((m) => <option key={m} value={m}>{NOMI[m]}</option>)}</select></label>
        <label>Terzo <select className={sel} value={terza} onChange={(e) => setTerza(e.target.value as Misura | 'none')}><option value="none">nessuno</option>{misure.map((m) => <option key={m} value={m}>{NOMI[m]}</option>)}</select></label>
        <label>Scenario fra <select className={sel} value={scDt} onChange={(e) => setScDt(Number(e.target.value))}>
          <option value={0}>adesso</option><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option><option value={-1}>scadenza</option>
        </select></label>
        <label>Vol <select className={sel} value={scVol} onChange={(e) => setScVol(Number(e.target.value))}>
          {[-5, -2, 0, 2, 5].map((v) => <option key={v} value={v}>{v > 0 ? `+${v}` : v} punti</option>)}
        </select></label>
        <label>Greca (Profile Netto) <select className={sel} value={greca} onChange={(e) => setGreca(e.target.value as Greca)}>
          <option value="gamma">gamma</option><option value="delta">delta</option><option value="vanna">vanna</option><option value="charm">charm</option><option value="none">none</option>
        </select></label>
        <label>GEX Profile <select className={sel} value={modo} onChange={(e) => setModo(e.target.value as ModoGexp)}>
          <option value="netto">netto</option><option value="taglia">taglia</option>
        </select></label>
        <label>Candele <select className={sel} value={finestra} onChange={(e) => setFinestra(Number(e.target.value))}>
          <option value={60}>60 min</option><option value={120}>120 min</option><option value={240}>240 min</option><option value={0}>tutta la seduta</option>
        </select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={conCallPut} onChange={(e) => setConCallPut(e.target.checked)} /> Major Call/Put Gamma</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={conAzioni} onChange={(e) => setConAzioni(e.target.checked)} /> BUY/SELL market maker</label>
        <label>Colore candele <select className={sel} value={coloreCandele} onChange={(e) => setColoreCandele(e.target.value as ColoreCandele)}>
          <option value="totale">MM totale</option><option value="greche">MM solo prezzo/tempo</option><option value="flusso">MM solo nuovi scambi</option><option value="prezzo">prezzo (su/giù)</option>
        </select></label>
      </div>

      {errore && <div className="text-amber-400 text-sm">{errore}</div>}

      {dati && (
        <>
          <div className="flex flex-wrap gap-2">
            <Scheda titolo="Aggregate DEX" valore={`${fmt(totali.dexMM, 1)} M$`} sotto={`${fmt(totali.dex)} Δ contratti`} colore={col(totali.dexMM)} />
            <Scheda titolo="Net GEX" valore={`${fmt(totali.gex, 1)} M$`} sotto={`GEX Profile ${modo}, per 1%`} colore={col(totali.gex)} />
            <Scheda titolo="Net −Vanna" valore={`${fmt(totali.vanna, 1)} M$`} sotto="per punto di vol" colore={col(totali.vanna)} />
            <Scheda titolo="Azione MM a prezzo fermo"
              valore={`${azioneFermo >= 0 ? 'BUY' : 'SELL'} ${Math.round(Math.abs(azioneFermo))} ES`}
              sotto={`SPX ${dati.spot.toFixed(0)} ${scDt < 0 ? 'fino alla scadenza' : scDt === 0 ? 'adesso' : `fra ${scDt} min`}${scVol ? `, vol ${scVol > 0 ? '+' : ''}${scVol}` : ''}`}
              colore={azioneFermo > 0 ? VERDE : azioneFermo < 0 ? '#ef4444' : undefined} />
            <Scheda titolo="Net Charm" valore={`${fmt(totali.charm, 1)} M$/h`}
              sotto={totali.charm === 0 ? undefined : `MM ${totali.charm > 0 ? 'BUY' : 'SELL'} ~${Math.round(Math.abs(totali.charm) * 1e6 / (50 * dati.spot))} ES/h a prezzo fermo`}
              colore={col(totali.charm)} />
            <Scheda titolo="Major Long / Short Gamma" valore={`${totali.longGamma ?? '—'} / ${totali.shortGamma ?? '—'}`} sotto="Gamma Netto" />
            <Scheda titolo="Major Call / Put Gamma" valore={`${totali.callGamma ?? '—'} / ${totali.putGamma ?? '—'}`} sotto="GEX Profile" />
            {maxChange.map((m) => (
              <Scheda key={m.minuti} titolo={`Max Change ${m.minuti}m`}
                valore={m.strike == null ? '—' : `${m.delta >= 0 ? '▲' : '▼'} ${m.strike}`}
                sotto={m.strike == null ? `rif. ${m.time}` : `${fmt(m.delta, 1)} M$ · rif. ${m.time}`}
                colore={m.strike == null ? undefined : col(m.delta)} />
            ))}
          </div>

          <Grafico dati={dati} righe={righe} sinistra={sinistra} destra={destra} finestra={finestra} terza={terza} conCallPut={conCallPut} conAzioni={conAzioni}
            scenario={`${scDt < 0 ? 'a scadenza' : scDt === 0 ? 'adesso' : `fra ${scDt} min`}${scVol ? `, vol ${scVol > 0 ? '+' : ''}${scVol}` : ''}`}
            coloreCandele={coloreCandele} />

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-400">Tabella per strike</summary>
            <div className="overflow-x-auto mt-2">
              <table className="font-mono w-full">
                <thead className="text-slate-400">
                  <tr>{['Strike', 'Comp C', 'Vend C', 'Imb C', 'Comp P', 'Vend P', 'Imb P', 'Gamma Netto', 'Delta Netto', 'GEXP', 'Profile Netto', 'DEX Δ', '−Vanna $MM', 'Charm $MM/h', 'IV', 'Lato'].map((h) => <th key={h} className="px-2 py-1 text-right">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {[...righe].reverse().map((c) => {
                    const x = dati.righe.find((r) => r.strike === c.strike)!;
                    return (
                      <tr key={c.strike} className={Math.abs(c.strike - dati.spot) < 2.5 ? 'bg-yellow-500/10' : ''}>
                        <td className="px-2 text-right">{c.strike}</td>
                        <td className="px-2 text-right">{x.cb}</td><td className="px-2 text-right">{x.cs}</td>
                        <td className="px-2 text-right" style={{ color: col(c.imbCall) }}>{fmt(c.imbCall)}</td>
                        <td className="px-2 text-right">{x.pb}</td><td className="px-2 text-right">{x.ps}</td>
                        <td className="px-2 text-right" style={{ color: col(c.imbPut) }}>{fmt(c.imbPut)}</td>
                        <td className="px-2 text-right" style={{ color: col(c.gammaNetto) }}>{fmt(c.gammaNetto, 1)}</td>
                        <td className="px-2 text-right" style={{ color: col(c.deltaNetto) }}>{fmt(c.deltaNetto, 1)}</td>
                        <td className="px-2 text-right" style={{ color: col(c.gexp) }}>{fmt(c.gexp, 1)}</td>
                        <td className="px-2 text-right" style={{ color: col(c.profileNetto) }}>{fmt(c.profileNetto, 1)}</td>
                        <td className="px-2 text-right">{fmt(c.dex)}</td>
                        <td className="px-2 text-right">{fmt(c.vex / 1e6, 2)}</td>
                        <td className="px-2 text-right">{fmt(c.chex / 1e6, 2)}</td>
                        <td className="px-2 text-right">{x.iv != null ? (x.iv * 100).toFixed(1) : '—'}</td>
                        <td className="px-2 text-right" style={{ color: c.callDominant ? VERDE : VIOLA }}>{c.callDominant ? 'call' : 'put'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>

          {conAzioni && (
            <p className="text-[11px] text-slate-400 max-w-4xl">
              Candele: <b className="text-green-500">verdi</b> = in quel minuto il MM ha dovuto comprare ES, <b className="text-red-500">rosse</b> = vendere
              (tenui sotto 100 ES; corpo pieno = minuto in salita, vuoto = in discesa). MM totale = variazione del delta dei clienti:
              nuovi scambi (clienti che comprano call → MM compra ES) + prezzo/tempo/vol sulle posizioni già aperte (gamma e charm, il ragionamento del profilo).
              <br />
              <b className="text-green-500">BUY</b> / <b className="text-red-500">SELL</b> = cosa fa il market maker su ES (controparte dei clienti).
              Su GAMMA: cosa fa se il prezzo va verso quello strike (sopra lo spot salendo, sotto scendendo; ATM in entrambi i versi):
              MM short gamma insegue il prezzo, MM long gamma va contro. Su DEX: la copertura che tiene già (clienti long delta → MM compra ES).
              Su CHARM: cosa deve fare nella prossima ora a prezzo fermo, solo per il tempo che passa verso la scadenza
              (opzioni fuori dal denaro che perdono delta, dentro che ne guadagnano).
              Su AZIONE MM: gli ES che il MM compra/vende in totale se SPX arriva a quel prezzo nello scenario scelto (fra N minuti,
              vol ±): gamma + charm + vanna sommati rivalutando le opzioni, non sommando le greche, che hanno unità diverse.
              Solo barre ≥ 5% della più grande. Copertura teorica, non verificata su Bookmap.
            </p>
          )}

          <p className="text-[11px] text-slate-500 max-w-4xl">
            Comp/Vend = conti Lee-Ready del poller dei volumi (trade per trade, quote prima del trade), non la stima a rapporto
            last/bid/ask della specifica: lo storico di bid/ask per contratto non viene salvato. Contano dall&apos;avvio del poller.
            Gamma e delta da IBKR; IV ricavata da delta e gamma, vanna e charm Black-Scholes con r = q = 0, T ≥ 30 s. Solo 0DTE
            (niente modalità 90d). Profile Netto con greca &quot;delta&quot; coincide con il DEX in contratti, perché il delta put è già negativo.
          </p>
        </>
      )}
    </div>
  );
}
