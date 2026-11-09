'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * Statistica di un ticker di /livelli-azionari: movimento % per periodo di
 * scadenza (vedi execution/livelli_statistica.py).
 */

interface Periodo { da: string; a: string; giorni: number; inizio: number; fine: number; pct: number }
interface Risposta {
    ticker: string; mesi: number; quotate: string[]; periodi: Periodo[];
    riepilogo: {
        n: number; mediaAssoluta: number; medianaAssoluta: number; mediaSegno: number;
        su: number; mediaSu: number | null; giu: number; mediaGiu: number | null; massimo: number;
        oltre: { soglia: number; n: number }[];
    };
}

const num = (v: number) => v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number | null, segno = true) => v == null ? 'n.d.' :
    `${segno && v > 0 ? '+' : ''}${v.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const data = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const colore = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300';

function nomeCiclo(mesi: number) {
    if (mesi === 0) return 'settimanali';
    return mesi === 1 ? 'mensili' : `ogni ${mesi} mesi`;
}

function Dato({ titolo, valore, nota, classe = 'text-white' }: { titolo: string; valore: string; nota?: string; classe?: string }) {
    return (
        <div className="px-4 py-3 bg-slate-900 border border-slate-800 rounded-lg">
            <div className="text-xs text-slate-400">{titolo}</div>
            <div className={`mt-1 text-xl font-bold tabular-nums ${classe}`}>{valore}</div>
            {nota && <div className="text-xs text-slate-500">{nota}</div>}
        </div>
    );
}

function Statistica() {
    const ticker = useSearchParams().get('ticker') ?? '';
    const [dati, setDati] = useState<Risposta | null>(null);
    const [errore, setErrore] = useState<string | null>(ticker ? null : 'Nessun ticker indicato');

    useEffect(() => {
        if (!ticker) return;
        let annullato = false;
        fetch(`/api/straddle-azionario/statistica?ticker=${encodeURIComponent(ticker)}`)
            .then(async r => {
                const d = await r.json();
                if (annullato) return;
                if (r.ok) setDati(d);
                else setErrore(d.errore ?? `Errore ${r.status}`);
            })
            .catch(e => { if (!annullato) setErrore(String(e)); });
        return () => { annullato = true; };
    }, [ticker]);

    const r = dati?.riepilogo;
    const settimanale = dati?.mesi === 0;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
            <Link href="/livelli-azionari" className="text-xs text-cyan-400 hover:text-cyan-300">← Livelli azionari</Link>
            <h1 className="mt-2 text-xl font-bold tracking-wide">STATISTICA {ticker}</h1>

            {errore && <p className="mt-4 text-sm text-red-400">{errore}</p>}
            {!errore && !dati && <p className="mt-4 text-sm text-slate-400">Leggo lo storico da IBKR…</p>}

            {dati && r && (
                <>
                    <p className="mt-1 text-sm text-slate-400">
                        Scadenze {nomeCiclo(dati.mesi)}.{' '}
                        {settimanale
                            ? <>Movimento dall&apos;apertura del lunedì alla chiusura del venerdì, ultime {r.n} settimane complete.</>
                            : <>Movimento dalla chiusura di una scadenza alla chiusura della successiva, ultimi {r.n} periodi.</>}
                    </p>
                    {!settimanale && (
                        <p className="mt-1 text-xs text-amber-400">
                            Date passate dedotte: terzo venerdì del mese, con il ciclo di oggi. IBKR non dà le scadenze già passate.
                        </p>
                    )}

                    <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-4xl">
                        <Dato titolo="Movimento medio, senza segno" valore={pct(r.mediaAssoluta, false)} nota={`mediano ${pct(r.medianaAssoluta, false)}`} />
                        <Dato titolo="Media col segno" valore={pct(r.mediaSegno)} classe={colore(r.mediaSegno)} />
                        <Dato titolo="Periodi in rialzo" valore={String(r.su)} nota={`in media ${pct(r.mediaSu)}`} classe="text-emerald-400" />
                        <Dato titolo="Periodi in ribasso" valore={String(r.giu)} nota={`in media ${pct(r.mediaGiu)}`} classe="text-red-400" />
                    </div>

                    <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm text-slate-300 tabular-nums">
                        <span>Massimo <b className={colore(r.massimo)}>{pct(r.massimo)}</b></span>
                        {r.oltre.map(o => <span key={o.soglia}>Oltre {o.soglia}%: <b className="text-white">{o.n}</b> su {r.n}</span>)}
                    </div>

                    <div className="mt-6 max-w-3xl overflow-x-auto border border-slate-800 rounded-lg">
                        <table className="min-w-full text-sm tabular-nums">
                            <thead>
                                <tr className="bg-slate-900 text-right text-xs text-slate-400">
                                    <th className="px-4 py-2 font-semibold text-left">Da</th>
                                    <th className="px-4 py-2 font-semibold text-left">A</th>
                                    <th className="px-4 py-2 font-semibold">{settimanale ? 'Apertura' : 'Chiusura iniziale'}</th>
                                    <th className="px-4 py-2 font-semibold">{settimanale ? 'Chiusura' : 'Chiusura finale'}</th>
                                    <th className="px-4 py-2 font-semibold">Movimento</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...dati.periodi].reverse().map(p => (
                                    <tr key={p.da} className="border-t border-slate-800 text-right">
                                        <td className="px-4 py-1.5 text-left text-slate-300">{data(p.da)}</td>
                                        <td className="px-4 py-1.5 text-left text-slate-300">{data(p.a)}</td>
                                        <td className="px-4 py-1.5">{num(p.inizio)}</td>
                                        <td className="px-4 py-1.5">{num(p.fine)}</td>
                                        <td className={`px-4 py-1.5 font-bold ${colore(p.pct)}`}>{pct(p.pct)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </main>
    );
}

export default function StatisticaPage() {
    return (
        <Suspense>
            <Statistica />
        </Suspense>
    );
}
