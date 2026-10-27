'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { Blocco, Lato, Vertical } from '../api/verticali/route';
import { leggiRefLines, leggiVisibilita } from '@/lib/refLines';
import { oraRomaDaNy } from '@/lib/orarioNy';

const REFRESH_MS = 10000;
const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GIALLO = '#facc15';
const VIOLA = '#a855f7';
/** Finche' alle 15:35 non c'e' lo straddle i range non esistono: si richiedono ogni minuto. */
const RANGE_RETRY_MS = 60_000;
/** Quanti blocchi mostrare nella lista, dal piu' recente. */
const BLOCCHI_IN_LISTA = 15;

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
  /** Se il rilevamento dei vertical sui singoli trade e' attivo. */
  rilevamento?: boolean;
  blocchi?: Blocco[];
}

type Soglia = '100' | '250' | '500' | '1000';

/** Il nome del vertical dal lato e dal verso: comprare la call e' un bull call, venderla un bear call. */
function nomeBlocco(b: Blocco): string {
  if (b.verso === 'incerto') return b.lato === 'C' ? 'Call vertical' : 'Put vertical';
  if (b.lato === 'C') return b.verso === 'comprato' ? 'Bull call' : 'Bear call';
  return b.verso === 'comprato' ? 'Bear put' : 'Bull put';
}

/** Rialzista o ribassista: bull call e bull put salgono, bear put e bear call scendono. */
function coloreBlocco(b: Blocco): string {
  if (b.verso === 'incerto') return '#94a3b8';
  return (b.lato === 'C') === (b.verso === 'comprato') ? VERDE : ROSSO;
}

const migliaia = (n: number) => n.toLocaleString('it-IT');

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

/** Mid e contratti di vertical eseguiti oggi su un lato, comprati in verde e venduti in rosso. */
function CellaLato({ l, grossi }: { l: Lato | null; grossi: number }) {
  if (!l) return <td colSpan={3} className="px-2 py-1 text-center text-slate-700 border-l border-slate-800">—</td>;
  return (
    <>
      <td className="px-2 py-1 text-right text-white border-l border-slate-800">{l.mid.toFixed(2)}</td>
      <td className="px-2 py-1 text-right" style={{ color: l.vol?.comprati ? VERDE : undefined }}>
        {l.vol ? migliaia(l.vol.comprati) : '—'}
      </td>
      <td className="px-2 py-1 text-right" style={{ color: l.vol?.venduti ? ROSSO : undefined }}>
        {l.vol ? migliaia(l.vol.venduti) : '—'}
        {grossi > 0 && (
          <span className="ml-1.5 px-1 rounded bg-amber-400 text-black text-[10px] font-bold" title="Blocchi sopra la soglia">
            ×{grossi}
          </span>
        )}
      </td>
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
  const [soglia, setSoglia] = useState<Soglia>('1000');
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

  // I blocchi sopra la soglia: la lista dal piu' recente, e quanti per vertical e lato.
  const { grossi, perVertical } = useMemo(() => {
    const min = Number(soglia);
    const tutti = (dati?.blocchi ?? []).filter((b) => b.size >= min).sort((a, b) => (a.t < b.t ? 1 : -1));
    const conta = new Map<string, number>();
    for (const b of tutti) conta.set(`${b.k1}${b.lato}`, (conta.get(`${b.k1}${b.lato}`) ?? 0) + 1);
    return { grossi: tutti, perVertical: conta };
  }, [dati, soglia]);

  if (!autorizzato) return null;

  return (
    <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Operatività</h1>
            <p className="text-xs text-slate-500">
              SPX 0DTE · vertical da 5 punti: mid e contratti eseguiti · solo locale
              {dati?.time && <> · quotazioni delle {dati.time}{dati.expiry && <>, scadenza {dati.expiry}</>}</>}
              {spot != null && <> · SPX {spot.toFixed(2)}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSim((v) => !v)}
              title="Catena e blocchi finti, per vedere la pagina a mercato chiuso"
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
            Dati simulati: catena Black-Scholes a 3 ore dalla scadenza, IV 19%, spot che oscilla attorno a 7648, blocchi di vertical, VWAP e range OB (straddle di 28 punti) inventati. Non sono dati di mercato.
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
            <div className="rounded-xl border border-slate-800 bg-[#111216] p-3 md:p-4 mb-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
                <div>
                  <div className="text-slate-500 uppercase tracking-wider">Blocchi di vertical</div>
                  <div className="text-[11px] text-slate-600">le due gambe nello stesso istante, stessa size; verso dal prezzo fra credito e debito</div>
                </div>
                <Selettore
                  titolo="Almeno"
                  valore={soglia}
                  opzioni={[['100', '100'], ['250', '250'], ['500', '500'], ['1000', '1000']]}
                  onChange={setSoglia}
                />
              </div>
              {!dati?.rilevamento ? (
                <div className="text-sm text-slate-600 py-2">Rilevamento dei vertical non ancora attivo: per ora ci sono solo i prezzi.</div>
              ) : grossi.length === 0 ? (
                <div className="text-sm text-slate-600 py-2">Nessun vertical da {migliaia(Number(soglia))} contratti o più, oggi.</div>
              ) : (
                <table className="w-full text-xs tabular-nums">
                  <tbody>
                    {grossi.slice(0, BLOCCHI_IN_LISTA).map((b, i) => (
                      <tr key={`${b.t}-${b.k1}-${b.lato}-${i}`} className="border-t border-slate-800/60">
                        <td className="px-2 py-1 text-slate-500">{b.t}</td>
                        <td className="px-2 py-1 font-bold" style={{ color: coloreBlocco(b) }}>{nomeBlocco(b)}</td>
                        <td className="px-2 py-1 text-white font-semibold">{b.k1}/{b.k2}</td>
                        <td className="px-2 py-1 text-right text-white font-bold">{migliaia(b.size)}</td>
                        <td className="px-2 py-1 text-right text-slate-400">a {b.prezzo.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#111216] p-3 md:p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-xs tabular-nums">
                {marcatori.length === 0 ? (
                  <span className="text-slate-600">VWAP e range OB non ancora disponibili (i range arrivano dopo le {oraRomaDaNy('09:35').slice(0, 5)})</span>
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
                      <th className="px-2 py-1 text-center border-l border-slate-800" colSpan={3}>Call vertical</th>
                      <th className="px-2 py-1 text-center border-l border-slate-800" colSpan={3}>Put vertical</th>
                    </tr>
                    <tr className="text-slate-600">
                      {['Mid', 'Comprati', 'Venduti', 'Mid', 'Comprati', 'Venduti'].map((t, i) => (
                        <th key={i} className={`px-2 py-1 text-right ${i % 3 === 0 ? 'border-l border-slate-800' : ''}`}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...righe].reverse().map((v) => {
                      const centro = (v.k1 + v.k2) / 2 - (spot ?? 0);
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
                          <CellaLato l={v.call} grossi={perVertical.get(`${v.k1}C`) ?? 0} />
                          <CellaLato l={v.put} grossi={perVertical.get(`${v.k1}P`) ?? 0} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-600 mt-2">
                Mid = mid della gamba cara meno mid dell&apos;altra. Comprati/venduti = contratti di vertical eseguiti oggi su
                quelle due gambe: vicino al debito comprati (bull call, bear put), vicino al credito venduti (bear call, bull put).
                ×N = blocchi sopra la soglia.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
