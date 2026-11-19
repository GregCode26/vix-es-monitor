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

type Candela = { t: string; o: number; h: number; l: number; c: number };
type Risposta = {
  date: string; time: string; spot: number; T: number; inizioLr: string | null;
  righe: RigaGreche[]; riferimenti: RiferimentoMaxChange[]; candele: Candela[]; error?: string;
};

type Greca = 'gamma' | 'delta' | 'vanna' | 'charm' | 'none';
type ModoGexp = 'netto' | 'taglia';
type Misura = 'dex' | 'gammaNetto' | 'gexp' | 'profileNetto' | 'vex' | 'chex' | 'imbCall' | 'imbPut';

const NOMI: Record<Misura, string> = {
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
    };
  });
}

/** Valore disegnato di una misura: DEX in $MM (Delta Netto), VEX/CHEX in $MM come i totali. */
function valore(c: Calcolo, m: Misura): number {
  switch (m) {
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
const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

function Grafico({ dati, righe, sinistra, destra, finestra, conCallPut }: {
  dati: Risposta; righe: Calcolo[]; sinistra: Misura; destra: Misura; finestra: number; conCallPut: boolean;
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

    const TOP = 26, BOT = 26, DESTRA = 90;
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

    // Candele lungo tutta la larghezza.
    if (candele.length > 0) {
      const passo = plotW / Math.max(candele.length, 30);
      const x0 = plotW - candele.length * passo;
      candele.forEach((c, i) => {
        const x = x0 + (i + 0.5) * passo;
        const su = c.c >= c.o;
        ctx.strokeStyle = su ? '#e5e7eb' : '#6b7280';
        ctx.fillStyle = su ? '#e5e7eb' : '#6b7280';
        ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
        const yo = y(c.o), yc = y(c.c);
        ctx.fillRect(x - Math.max(1, passo * 0.3), Math.min(yo, yc), Math.max(2, passo * 0.6), Math.max(1, Math.abs(yc - yo)));
      });
      // Orari sotto, uno ogni ~100 px.
      ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
      const ogni = Math.max(1, Math.round(100 / passo));
      candele.forEach((c, i) => { if (i % ogni === 0) ctx.fillText(c.t, x0 + (i + 0.5) * passo, H - 8); });
    }

    // I due profili: zero a 22% e 68% della larghezza, mezza ampiezza 18%.
    const altezzaBarra = Math.max(3, Math.abs(y(0) - y(5)) * 0.6);
    const profilo = (m: Misura, zeroX: number, colPos: string, colNeg: string) => {
      const mezza = plotW * 0.18;
      const valori = righe.map((r) => valore(r, m));
      const max = Math.max(1e-9, ...valori.map(Math.abs));
      ctx.strokeStyle = 'rgba(168,85,247,0.6)';
      ctx.beginPath(); ctx.moveTo(zeroX, TOP); ctx.lineTo(zeroX, H - BOT); ctx.stroke();
      righe.forEach((r, i) => {
        const v = valori[i];
        if (v === 0) return;
        const w = (Math.abs(v) / max) * mezza;
        ctx.fillStyle = v > 0 ? colPos : colNeg;
        const yy = y(r.strike) - altezzaBarra / 2;
        ctx.beginPath();
        ctx.roundRect(v > 0 ? zeroX : zeroX - w, yy, w, altezzaBarra, altezzaBarra / 2);
        ctx.fill();
      });
      // Scala in alto: -max, 0, +max; nome in basso.
      ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
      ctx.fillText(fmt(-max), zeroX - mezza, 14); ctx.fillText('0.00', zeroX, 14); ctx.fillText(fmt(max), zeroX + mezza, 14);
      ctx.textAlign = 'left'; ctx.fillText(NOMI[m], zeroX - mezza, H - BOT - 6);
    };
    profilo(sinistra, plotW * 0.22, VERDE, VIOLA);
    profilo(destra, plotW * 0.68, AZZURRO, VIOLA);

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
  }, [dati, righe, sinistra, destra, finestra, conCallPut, larghezza]);

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
  const [finestra, setFinestra] = useState(120);
  const [conCallPut, setConCallPut] = useState(false);
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

  const righe = useMemo(() => (dati ? calcola(dati, greca, modo) : []), [dati, greca, modo]);

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
        <button onClick={() => router.push('/market')} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">MARKET</button>
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
      </div>

      {errore && <div className="text-amber-400 text-sm">{errore}</div>}

      {dati && (
        <>
          <div className="flex flex-wrap gap-2">
            <Scheda titolo="Aggregate DEX" valore={`${fmt(totali.dexMM, 1)} M$`} sotto={`${fmt(totali.dex)} Δ contratti`} colore={col(totali.dexMM)} />
            <Scheda titolo="Net GEX" valore={`${fmt(totali.gex, 1)} M$`} sotto={`GEX Profile ${modo}, per 1%`} colore={col(totali.gex)} />
            <Scheda titolo="Net −Vanna" valore={`${fmt(totali.vanna, 1)} M$`} sotto="per punto di vol" colore={col(totali.vanna)} />
            <Scheda titolo="Net Charm" valore={`${fmt(totali.charm, 1)} M$/h`} colore={col(totali.charm)} />
            <Scheda titolo="Major Long / Short Gamma" valore={`${totali.longGamma ?? '—'} / ${totali.shortGamma ?? '—'}`} sotto="Gamma Netto" />
            <Scheda titolo="Major Call / Put Gamma" valore={`${totali.callGamma ?? '—'} / ${totali.putGamma ?? '—'}`} sotto="GEX Profile" />
            {maxChange.map((m) => (
              <Scheda key={m.minuti} titolo={`Max Change ${m.minuti}m`}
                valore={m.strike == null ? '—' : `${m.delta >= 0 ? '▲' : '▼'} ${m.strike}`}
                sotto={m.strike == null ? `rif. ${m.time}` : `${fmt(m.delta, 1)} M$ · rif. ${m.time}`}
                colore={m.strike == null ? undefined : col(m.delta)} />
            ))}
          </div>

          <Grafico dati={dati} righe={righe} sinistra={sinistra} destra={destra} finestra={finestra} conCallPut={conCallPut} />

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
