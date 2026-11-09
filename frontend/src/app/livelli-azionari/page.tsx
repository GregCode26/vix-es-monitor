'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * LIVELLI AZIONARI: si scrive un ticker e IBKR da' lo straddle ATM sulle 3
 * scadenze piu' vicine. Ogni calcolo lascia una riga, salvata in locale, che
 * resta finche' non la si toglie. Pagina non collegata dalle altre.
 */

interface Scadenza {
    scadenza: string; dte: number; errore?: string;
    strike?: number; call?: number | null; put?: number | null;
    fonteCall?: string; fontePut?: string; tipoDati?: string;
    straddle?: number; pct?: number; breakevenGiu?: number; breakevenSu?: number;
    livelli?: OpzioniLivello[];
}
/**
 * Put allo strike piu' vicino al livello inferiore, call al superiore (righe da
 * 09/11/2026). Prezzo = bid, 0 se non quotato; le righe salvate prima avevano il mid.
 */
interface OpzioniLivello {
    nome: string; strikePut: number; put: number | null; fontePut: string;
    strikeCall: number; call: number | null; fonteCall: string;
}

/** Strike e bid di una gamba; grigio se il bid e' 0, giallo sulle righe vecchie (mid/last/close). */
function Gamba({ strike, lato, prezzo, fonte }: { strike: number; lato: 'P' | 'C'; prezzo: number | null; fonte: string }) {
    const vecchia = fonte !== 'bid';
    const classe = vecchia ? 'text-amber-400' : prezzo ? 'text-slate-200' : 'text-slate-500';
    const titolo = vecchia ? `riga vecchia, prezzo: ${fonte} (Ricalcola per il bid)` : prezzo ? 'bid' : 'bid non quotato';
    return (
        <span className={classe} title={titolo}>
            {strike}{lato} {num(prezzo)}
        </span>
    );
}
interface Riga {
    id: string; ticker: string; ora: string; spot: number;
    fonteSpot: string; tipoDatiSpot: string; scadenze: Scadenza[];
}

const num = (v: number | null | undefined) => v == null ? 'n.d.' :
    v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBreve = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const oraIt = (iso: string) => new Date(iso).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Cosa c'e' di diverso da un mid live, da dire accanto al numero. */
function avvisi(tipo: string | undefined, ...fonti: (string | undefined)[]) {
    const out = new Set<string>();
    if (tipo && tipo !== 'live') out.add(tipo);
    fonti.forEach(f => { if (f && f !== 'mid') out.add(f); });
    return [...out].join(' · ');
}

/**
 * Livelli attorno allo spot, con le formule di R1/R2/R3 del Range Calc di
 * /market e lo stesso ordine per distanza: lo straddle e' L2.
 */
const LIVELLI = [
    { nome: 'L1', molt: 1 / Math.sqrt(3) },
    { nome: 'L2', molt: 1 },
    { nome: 'L3', molt: Math.sqrt(3) },
];

function CellaScadenza({ s, spot }: { s: Scadenza; spot: number }) {
    const avviso = avvisi(s.tipoDati, s.fonteCall, s.fontePut);
    const straddle = s.straddle;
    return (
        <td className="px-4 py-3 border-l border-slate-800 align-top whitespace-nowrap">
            <div className="text-xs text-slate-400">
                {dataBreve(s.scadenza)} · {s.dte} gg{s.strike != null && <> · Strike {s.strike}</>}
            </div>
            {s.errore ? (
                <div className="text-xs text-red-400 mt-1">{s.errore}</div>
            ) : (
                <>
                    <div className="mt-1">
                        <span className="text-lg font-bold text-white tabular-nums">{num(s.straddle)}</span>
                        <span className="ml-2 text-sm text-cyan-400 tabular-nums">{num(s.pct)}%</span>
                    </div>
                    <div className="text-xs text-slate-400 tabular-nums">C {num(s.call)} + P {num(s.put)}</div>
                    <div className="text-xs text-slate-400 tabular-nums">Breakeven {num(s.breakevenGiu)} / {num(s.breakevenSu)}</div>
                    {straddle != null && (
                        <div className="mt-1.5 text-xs tabular-nums">
                            {LIVELLI.map(({ nome, molt }) => (
                                <div key={nome} className="text-slate-300">
                                    <span className="inline-block w-6 font-bold text-cyan-400">{nome}</span>
                                    {num(spot - straddle * molt)} / {num(spot + straddle * molt)}
                                    <span className="ml-1.5 text-slate-500">±{num(straddle * molt)}</span>
                                    <span className="ml-1.5 text-cyan-400">±{num(s.pct! * molt)}%</span>
                                    {(() => {
                                        const o = s.livelli?.find(l => l.nome === nome);
                                        return o && (
                                            <span className="ml-2">
                                                <Gamba strike={o.strikePut} lato="P" prezzo={o.put} fonte={o.fontePut} />
                                                <span className="text-slate-500"> / </span>
                                                <Gamba strike={o.strikeCall} lato="C" prezzo={o.call} fonte={o.fonteCall} />
                                            </span>
                                        );
                                    })()}
                                </div>
                            ))}
                            {!s.livelli && (
                                <div className="mt-0.5 text-amber-400">Riga calcolata prima dei prezzi put/call sui livelli: premi Ricalcola</div>
                            )}
                        </div>
                    )}
                    {avviso && <div className="text-xs text-amber-400 mt-0.5">{avviso}</div>}
                </>
            )}
        </td>
    );
}

export default function LivelliAzionariPage() {
    const [righe, setRighe] = useState<Riga[]>([]);
    const [locale, setLocale] = useState(true);
    const [ticker, setTicker] = useState('');
    const [inCorso, setInCorso] = useState<string | null>(null);
    const [errore, setErrore] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/straddle-azionario').then(r => r.json()).then(d => {
            setLocale(d.local);
            setRighe(d.righe);
        }).catch(e => setErrore(String(e)));
    }, []);

    async function calcola(simbolo: string) {
        setInCorso(simbolo);
        setErrore(null);
        try {
            const r = await fetch('/api/straddle-azionario', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker: simbolo }),
            });
            const d = await r.json();
            if (!r.ok) setErrore(d.errore ?? `Errore ${r.status}`);
            else {
                setRighe(prima => [d.riga, ...prima]);
                setTicker('');
            }
        } catch (e) {
            setErrore(String(e));
        } finally {
            setInCorso(null);
        }
    }

    async function togli(id: string) {
        const r = await fetch(`/api/straddle-azionario?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (r.ok) setRighe(prima => prima.filter(x => x.id !== id));
        else setErrore(`Riga non tolta: errore ${r.status}`);
    }

    function invia(e: FormEvent) {
        e.preventDefault();
        const simbolo = ticker.trim().toUpperCase();
        if (simbolo) calcola(simbolo);
    }

    const occupato = inCorso !== null;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
            <h1 className="text-xl font-bold tracking-wide">LIVELLI AZIONARI</h1>
            <p className="text-sm text-slate-400 mt-1">Straddle ATM sulle 3 scadenze più vicine, da IBKR (mid di call + put).</p>

            {!locale && <p className="mt-4 text-sm text-amber-400">Funziona solo in locale, con TWS aperto.</p>}

            <form onSubmit={invia} className="mt-4 flex items-center gap-2">
                <input
                    value={ticker}
                    onChange={e => setTicker(e.target.value.toUpperCase())}
                    placeholder="Ticker, es. AAPL"
                    aria-label="Ticker"
                    maxLength={10}
                    autoFocus
                    className="w-44 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm uppercase placeholder:normal-case focus:outline-none focus:border-cyan-500"
                />
                <button
                    type="submit"
                    disabled={occupato || !locale || !ticker.trim()}
                    className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:hover:bg-cyan-700 rounded-lg text-sm font-bold"
                >
                    Calcola
                </button>
                {inCorso && <span className="text-sm text-slate-400">Leggo {inCorso} da IBKR…</span>}
            </form>

            {errore && <p className="mt-3 text-sm text-red-400">{errore}</p>}

            {righe.length === 0 ? (
                <p className="mt-6 text-sm text-slate-500">Nessun calcolo ancora: scrivi un ticker.</p>
            ) : (
                <div className="mt-6 overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="bg-slate-900 text-left text-xs text-slate-400">
                                <th className="px-4 py-2 font-semibold">Ticker</th>
                                <th className="px-4 py-2 font-semibold border-l border-slate-800">1ª scadenza</th>
                                <th className="px-4 py-2 font-semibold border-l border-slate-800">2ª scadenza</th>
                                <th className="px-4 py-2 font-semibold border-l border-slate-800">3ª scadenza</th>
                                <th className="px-4 py-2 border-l border-slate-800"><span className="sr-only">Azioni</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {righe.map(r => {
                                const avviso = avvisi(r.tipoDatiSpot, r.fonteSpot);
                                return (
                                    <tr key={r.id} className="border-t border-slate-800">
                                        <td className="px-4 py-3 align-top whitespace-nowrap">
                                            <div className="text-lg font-bold">{r.ticker}</div>
                                            <div className="text-xs text-slate-300 tabular-nums">Spot {num(r.spot)}</div>
                                            {avviso && <div className="text-xs text-amber-400">{avviso}</div>}
                                            <div className="text-xs text-slate-500 tabular-nums">{oraIt(r.ora)}</div>
                                        </td>
                                        {r.scadenze.map(s => <CellaScadenza key={s.scadenza} s={s} spot={r.spot} />)}
                                        {Array.from({ length: Math.max(0, 3 - r.scadenze.length) }, (_, i) => (
                                            <td key={i} className="border-l border-slate-800" />
                                        ))}
                                        <td className="px-4 py-3 border-l border-slate-800 align-top whitespace-nowrap">
                                            <button
                                                onClick={() => calcola(r.ticker)}
                                                disabled={occupato || !locale}
                                                className="block text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
                                            >
                                                Ricalcola
                                            </button>
                                            <button
                                                onClick={() => togli(r.id)}
                                                className="block mt-2 text-xs text-slate-500 hover:text-red-400"
                                            >
                                                Togli
                                            </button>
                                            <Link
                                                href={`/livelli-azionari/statistica?ticker=${encodeURIComponent(r.ticker)}`}
                                                className="block mt-2 text-xs text-cyan-400 hover:text-cyan-300"
                                            >
                                                Statistica
                                            </Link>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </main>
    );
}
