'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { Lato, Vertical } from '../api/verticali/route';
import { leggiRefLines, leggiVisibilita } from '@/lib/refLines';

const REFRESH_MS = 10000;
const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
const VIOLA = '#a855f7';
/** Finche' alle 15:35 non c'e' lo straddle i range non esistono: si richiedono ogni minuto. */
const RANGE_RETRY_MS = 60_000;

/**
 * I range OB come li dà /api/market (`range.ob`): in prezzi ES, cioè SPX delle
 * 15:35 +- straddle + basis. Qui si riportano in SPX togliendo quella basis.
 * Chiave e nome non coincidono per R1/R2 (vedi CLAUDE.md): r2 = R1, r1 = R2.
 */
const RANGE_OB = [
  ['r3Up', '#10b981', 'R3↑'],
  ['r1Up', '#3b82f6', 'R2↑'],
  ['r2Up', '#06b6d4', 'R1↑'],
  ['r2Down', '#f97316', 'R1↓'],
  ['r1Down', '#ef4444', 'R2↓'],
  ['r3Down', '#facc15', 'R3↓'],
] as const;

/** Un livello da segnare in tabella, in prezzi SPX. */
interface Livello {
  etichetta: string;
  colore: string;
  valore: number;
}

/** Livelli finti per la simulazione: straddle di 28 punti attorno a 7648, VWAP poco sotto. */
function livelliSimulati(): { vwap: number; range: Livello[] } {
  const base = 7648;
  const straddle = 28;
  const molt: Record<string, number> = { r1: 1, r2: 1 / Math.sqrt(3), r3: Math.sqrt(3) };
  return {
    vwap: 7645.6,
    range: RANGE_OB.map(([k, colore, etichetta]) => ({
      etichetta: `${etichetta} OB`,
      colore,
      valore: base + (k.endsWith('Up') ? 1 : -1) * straddle * molt[k.slice(0, 2)],
    })),
  };
}

interface Risposta {
  local: boolean;
  sim?: boolean;
  time?: string;
  spot?: number | null;
  expiry?: string;
  verticali: Vertical[];
}

/** Uno dei quattro vertical di una coppia di strike, con il prezzo al naturale. */
interface Scelta {
  nome: string;
  k1: number;
  k2: number;
  prezzo: number;
  costo: number;
  distanza: number;
}

const dollari = (punti: number) => `${Math.round(punti * 100)} $`;

/** Il piu' economico da eseguire; a parita' di costo il piu' vicino allo spot. */
function migliore(scelte: Scelta[]): Scelta | null {
  let best: Scelta | null = null;
  for (const s of scelte) {
    if (!best || s.costo < best.costo - 1e-9 || (Math.abs(s.costo - best.costo) < 1e-9 && s.distanza < best.distanza)) best = s;
  }
  return best;
}

function Selettore<T extends string>({ titolo, valore, opzioni, onChange }: {
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
            className={`px-2 py-0.5 rounded font-bold ${valore === v ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-white'}`}
          >
            {etichetta}
          </button>
        ))}
      </div>
    </div>
  );
}

function Scheda({ titolo, sottotitolo, prezzo, scelta, colore }: {
  titolo: string;
  sottotitolo: string;
  prezzo: 'debito' | 'credito';
  scelta: Scelta | null;
  colore: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#111216] p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wider">{titolo}</div>
      <div className="text-[11px] text-slate-600 mb-2">{sottotitolo}</div>
      {scelta ? (
        <>
          <div className="text-xl font-bold" style={{ color: colore }}>
            {scelta.nome} {scelta.k1}/{scelta.k2}
          </div>
          <div className="text-sm text-slate-400 tabular-nums mt-1">
            {prezzo} {scelta.prezzo.toFixed(2)} · costo{' '}
            <span className="text-white">{dollari(scelta.costo)}</span> a contratto ({((scelta.costo / 5) * 100).toFixed(1)}% dell&apos;ampiezza)
          </div>
        </>
      ) : (
        <div className="text-sm text-slate-600">—</div>
      )}
    </div>
  );
}

function CellaLato({ l, piuEconomico }: { l: Lato | null; piuEconomico: boolean }) {
  if (!l) return <td colSpan={4} className="px-2 py-1 text-center text-slate-700">—</td>;
  return (
    <>
      <td className="px-2 py-1 text-right">{l.debito.toFixed(2)}</td>
      <td className="px-2 py-1 text-right">{l.credito.toFixed(2)}</td>
      <td className="px-2 py-1 text-right text-slate-500">{l.mid.toFixed(2)}</td>
      <td className={`px-2 py-1 text-right font-bold ${piuEconomico ? 'text-emerald-400' : 'text-slate-400'}`}>{dollari(l.costo)}</td>
    </>
  );
}

export default function OperativitaPage() {
  const router = useRouter();
  // Lato server non c'è localStorage: la pagina resta vuota finché il client non ha controllato.
  const autorizzato = useSyncExternalStore(
    () => () => {},
    () => localStorage.getItem('market_auth') === 'true',
    () => false,
  );
  const [dati, setDati] = useState<Risposta | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [banda, setBanda] = useState<'20' | '30' | '50'>('30');
  // Catena finta dalla route (?sim=1), per vedere la pagina a mercato chiuso.
  const [sim, setSim] = useState(false);
  // Dall'ultima riga di /api/market: VWAP di ES e base ES - SPX del momento.
  const [mercato, setMercato] = useState<{ vwap: number | null; basis: number | null } | null>(null);
  // range.ob di /api/market?history=true, in prezzi ES con la loro basis delle 15:35.
  const [rangeEs, setRangeEs] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
  }, [router]);

  useEffect(() => {
    if (!autorizzato) return;
    let attivo = true;
    const carica = async () => {
      try {
        const r = await fetch(sim ? '/api/verticali?sim=1' : '/api/verticali', { cache: 'no-store' });
        const j = await r.json();
        if (!attivo) return;
        if (!r.ok) {
          setErrore(j.error ?? `HTTP ${r.status}`);
          setDati(null);
          return;
        }
        setErrore(null);
        setDati(j);
      } catch (e) {
        if (attivo) setErrore(String(e));
      }
    };
    carica();
    const id = setInterval(carica, REFRESH_MS);
    return () => {
      attivo = false;
      clearInterval(id);
    };
  }, [autorizzato, sim]);

  useEffect(() => {
    if (!autorizzato || sim) return;
    let attivo = true;
    const carica = async () => {
      try {
        const r = await fetch('/api/market', { cache: 'no-store' });
        if (!r.ok || !attivo) return;
        const j = await r.json();
        const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
        const esf = num(j.esf);
        const spx = num(j.spx);
        setMercato({ vwap: num(j.vwap), basis: esf != null && spx != null ? esf - spx : null });
      } catch (e) {
        console.error('Market fetch failed:', e);
      }
    };
    carica();
    const id = setInterval(carica, REFRESH_MS);
    return () => {
      attivo = false;
      clearInterval(id);
    };
  }, [autorizzato, sim]);

  // Lo storico pesa centinaia di KB: si scarica solo finche' i range non ci
  // sono, poi per il resto della giornata non cambiano (come in /bookmap).
  useEffect(() => {
    if (!autorizzato || sim) return;
    let fermo = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const chiedi = async () => {
      let trovati = false;
      try {
        const r = await fetch('/api/market?history=true', { cache: 'no-store' });
        if (r.ok) {
          const ob = (await r.json())?.range?.ob as Record<string, number> | null | undefined;
          if (ob && !fermo) {
            setRangeEs(ob);
            trovati = true;
          }
        }
      } catch (e) {
        console.error('Range fetch failed:', e);
      }
      if (!trovati && !fermo) timer = setTimeout(chiedi, RANGE_RETRY_MS);
    };
    chiedi();
    return () => {
      fermo = true;
      if (timer) clearTimeout(timer);
    };
  }, [autorizzato, sim]);

  const livelli = useMemo((): { vwap: number | null; range: Livello[] } => {
    if (sim) return livelliSimulati();
    const basisLive = mercato?.basis ?? null;
    const vwap = mercato?.vwap != null && basisLive != null ? mercato.vwap - basisLive : null;
    // Le modifiche fatte a mano nel pannello Range di /market valgono piu' del
    // server, e la visibilita' scelta lì vale anche qui (come in /bookmap).
    const aMano = leggiRefLines() ?? {};
    const vis = leggiVisibilita() ?? {};
    const basis = rangeEs?.basis ?? basisLive;
    const range: Livello[] = [];
    if (basis != null) {
      for (const [k, colore, etichetta] of RANGE_OB) {
        const manuale = parseFloat(aMano[`${k}Ob`] ?? '');
        const es = Number.isFinite(manuale) ? manuale : rangeEs?.[k];
        if (es == null || !Number.isFinite(es) || vis[`${k}Ob`] === false) continue;
        range.push({ etichetta: `${etichetta} OB`, colore, valore: es - basis });
      }
    }
    return { vwap, range };
  }, [sim, mercato, rangeEs]);

  const marcatori = useMemo((): Livello[] => [
    ...(livelli.vwap != null ? [{ etichetta: 'VWAP', colore: VIOLA, valore: livelli.vwap }] : []),
    ...livelli.range,
  ], [livelli]);

  const spot = dati?.spot ?? null;
  // Il vertical ATM e' quello con lo spot fra i due strike; la tabella ne
  // mostra lo stesso numero sopra e sotto, cosi' l'ATM resta al centro.
  const { righe, atm } = useMemo(() => {
    if (!dati || spot == null || dati.verticali.length === 0) return { righe: [], atm: null };
    const vs = dati.verticali;
    let i = vs.findIndex((v) => v.k1 <= spot && spot < v.k2);
    if (i < 0) {
      i = 0;
      vs.forEach((v, j) => {
        if (Math.abs((v.k1 + v.k2) / 2 - spot) < Math.abs((vs[i].k1 + vs[i].k2) / 2 - spot)) i = j;
      });
    }
    const n = Math.min(Number(banda) / 5, i, vs.length - 1 - i);
    return { righe: vs.slice(i - n, i + n + 1), atm: vs[i].k1 };
  }, [dati, spot, banda]);

  const { long, short } = useMemo(() => {
    const debito: Scelta[] = [];
    const credito: Scelta[] = [];
    for (const v of righe) {
      const distanza = Math.abs((v.k1 + v.k2) / 2 - (spot ?? 0));
      if (v.call) {
        debito.push({ nome: 'Bull call', k1: v.k1, k2: v.k2, prezzo: v.call.debito, costo: v.call.costo, distanza });
        credito.push({ nome: 'Bear call', k1: v.k1, k2: v.k2, prezzo: v.call.credito, costo: v.call.costo, distanza });
      }
      if (v.put) {
        debito.push({ nome: 'Bear put', k1: v.k1, k2: v.k2, prezzo: v.put.debito, costo: v.put.costo, distanza });
        credito.push({ nome: 'Bull put', k1: v.k1, k2: v.k2, prezzo: v.put.credito, costo: v.put.costo, distanza });
      }
    }
    return { long: migliore(debito), short: migliore(credito) };
  }, [righe, spot]);

  if (!autorizzato) return null;

  return (
    <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Operatività</h1>
            <p className="text-xs text-slate-500">
              SPX 0DTE · vertical da 5 punti, costo di esecuzione al naturale · solo locale
              {dati?.time && <> · quotazioni delle {dati.time}{dati.expiry && <>, scadenza {dati.expiry}</>}</>}
              {spot != null && <> · SPX {spot.toFixed(2)}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSim((v) => !v)}
              title="Catena finta (Black-Scholes), per vedere la pagina a mercato chiuso"
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border ${sim
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 hover:bg-amber-500/30'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'}`}
            >
              {sim ? '◉' : '◌'} SIMULAZIONE
            </button>
            <button
              onClick={() => router.push('/market')}
              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
            >
              ← CHART
            </button>
          </div>
        </div>

        {sim && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-3 text-xs text-amber-300">
            Dati simulati: catena Black-Scholes a 3 ore dalla scadenza, IV 19%, spot che oscilla attorno a 7648, VWAP e range OB (straddle di 28 punti) inventati. Non sono quotazioni di mercato.
          </div>
        )}

        {dati && !dati.local ? (
          <div className="rounded-xl border border-slate-800 bg-[#111216] p-6 text-sm text-slate-500">
            Le quotazioni arrivano dal poller dei volumi sul PC: questa pagina funziona solo in locale.
          </div>
        ) : errore && !dati ? (
          <div className="rounded-xl border border-slate-800 bg-[#111216] p-6 text-sm text-slate-500">
            {errore}
            <button onClick={() => setSim(true)} className="ml-3 px-2 py-0.5 rounded border border-amber-500/50 text-amber-300 font-bold text-xs hover:bg-amber-500/20">
              Mostra simulazione
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <Scheda titolo="Long più economico" sottotitolo="bull call o bear put" prezzo="debito" scelta={long} colore={VERDE} />
              <Scheda titolo="Short più economico" sottotitolo="bear call o bull put" prezzo="credito" scelta={short} colore={ROSSO} />
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#111216] p-3 md:p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-xs tabular-nums">
                {marcatori.length === 0 ? (
                  <span className="text-slate-600">VWAP e range OB non ancora disponibili (i range arrivano dopo le 15:35)</span>
                ) : (
                  [...marcatori].sort((a, b) => b.valore - a.valore).map((m) => (
                    <span key={m.etichetta} className="text-slate-400">
                      <span style={{ color: m.colore }}>●</span> {m.etichetta}{' '}
                      <span className="text-white font-semibold">{m.valore.toFixed(2)}</span>
                    </span>
                  ))
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
                <Selettore
                  titolo="Attorno all'ATM"
                  valore={banda}
                  opzioni={[['20', '±20'], ['30', '±30'], ['50', '±50']]}
                  onChange={setBanda}
                />
                {errore && <span className="text-amber-400">{errore}</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="px-2 py-1 text-left" rowSpan={2}>Strike</th>
                      <th className="px-2 py-1 text-right" rowSpan={2}>Dallo spot</th>
                      <th className="px-2 py-1 text-center border-l border-slate-800" colSpan={4}>Call · long bull call / short bear call</th>
                      <th className="px-2 py-1 text-center border-l border-slate-800" colSpan={4}>Put · long bear put / short bull put</th>
                    </tr>
                    <tr className="text-slate-600">
                      {['Debito', 'Credito', 'Mid', 'Costo', 'Debito', 'Credito', 'Mid', 'Costo'].map((t, i) => (
                        <th key={i} className={`px-2 py-1 text-right ${i % 4 === 0 ? 'border-l border-slate-800' : ''}`}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...righe].reverse().map((v) => {
                      const centro = (v.k1 + v.k2) / 2 - (spot ?? 0);
                      const callMeno = v.call != null && (v.put == null || v.call.costo < v.put.costo);
                      const putMeno = v.put != null && (v.call == null || v.put.costo < v.call.costo);
                      const isAtm = v.k1 === atm;
                      return (
                        <tr
                          key={v.k1}
                          className={isAtm ? 'border-y-2 border-amber-400 bg-amber-400/10' : 'border-t border-slate-800/60'}
                        >
                          <td className="px-2 py-1 text-white font-semibold">
                            {v.k1}/{v.k2}
                            {isAtm && <span className="ml-2 px-1.5 rounded bg-amber-400 text-black text-[10px] font-bold">ATM</span>}
                            {marcatori
                              .filter((m) => m.valore >= v.k1 && m.valore < v.k2)
                              .map((m) => (
                                <span
                                  key={m.etichetta}
                                  title={`${m.etichetta} ${m.valore.toFixed(2)}`}
                                  className="ml-1.5 px-1.5 rounded text-[10px] font-bold text-black"
                                  style={{ backgroundColor: m.colore }}
                                >
                                  {m.etichetta}
                                </span>
                              ))}
                          </td>
                          <td className="px-2 py-1 text-right" style={{ color: isAtm ? GIALLO : centro >= 0 ? VERDE : ROSSO }}>
                            {isAtm && spot != null ? `SPX ${spot.toFixed(2)}` : `${centro >= 0 ? '+' : ''}${centro.toFixed(1)}`}
                          </td>
                          <CellaLato l={v.call} piuEconomico={callMeno} />
                          <CellaLato l={v.put} piuEconomico={putMeno} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-600 mt-2">
                Costo = metà del bid/ask delle due gambe, a contratto: è uguale per il long e lo short sugli stessi strike.
                In verde il lato più economico fra call e put, che danno la stessa esposizione (bull call = bull put, bear put = bear call).
                Un ordine combo spesso si esegue dentro il naturale: il costo reale può essere più basso.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
