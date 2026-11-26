'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

/**
 * Statistica di un ticker di /livelli-azionari: movimento % per periodo di
 * scadenza (vedi execution/livelli_statistica.py).
 */

/** `pct2`: movimento su due periodi di fila (dall'inizio di quello prima alla fine di questo). */
interface Periodo { da: string; a: string; giorni: number; inizio: number; fine: number; pct: number; pct2?: number | null }
interface Risposta {
    ticker: string; mesi: number; quotate: string[]; periodi: Periodo[];
    riepilogo: {
        n: number; mediaAssoluta: number; medianaAssoluta: number; mediaSegno: number;
        su: number; mediaSu: number | null; giu: number; mediaGiu: number | null; massimo: number;
        oltre: { soglia: number; n: number }[];
        mediaAssoluta2?: number | null; medianaAssoluta2?: number | null; oltre2?: { soglia: number; n: number }[];
    };
}

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface PuntoCurva { strike: number; iv: number; lato: string; fonte: string }
interface Curva { scadenza: string; dte: number; punti: PuntoCurva[]; mancanti: number }
interface RispostaCurve { spot: number; ora: string; curve: Curva[] }

const COLORI_CURVE = ['#22d3ee', '#f472b6'];

/**
 * Curva di volatilita' implicita di oggi, 1a e 2a scadenza (execution/livelli_smile.py:
 * IV del modello IBKR per strike, put sotto lo spot e call sopra). Si legge a
 * parte: ~30 contratti 4 alla volta, fino a un minuto e mezzo.
 */
function CurvaVol({ ticker }: { ticker: string }) {
    const [dati, setDati] = useState<RispostaCurve | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [giro, setGiro] = useState(0);

    useEffect(() => {
        let annullato = false;
        fetch(`/api/straddle-azionario/smile?ticker=${encodeURIComponent(ticker)}`)
            .then(async (r) => {
                const d = await r.json();
                if (annullato) return;
                if (r.ok) { setDati(d); setErrore(null); } else setErrore(d.errore ?? `Errore ${r.status}`);
            })
            .catch((e) => { if (!annullato) setErrore(String(e)); });
        return () => { annullato = true; };
    }, [ticker, giro]);

    const option = useMemo(() => {
        if (!dati) return null;
        const tutte = dati.curve.flatMap((c) => c.punti.map((p) => p.iv));
        if (tutte.length === 0) return null;
        return {
            backgroundColor: '#020617',
            animation: false,
            legend: { top: 4, textStyle: { color: '#cbd5e1', fontSize: 11 } },
            tooltip: {
                // Niente riquadro dei valori sul puntatore: resta solo il mirino.
                showContent: false,
                trigger: 'axis',
                axisPointer: { type: 'cross', label: { backgroundColor: '#1e293b' } },
                formatter: (p: { seriesName: string; data: [number, number, string] }[]) =>
                    `<b>Strike ${p[0]?.data?.[0]}</b> (${(((p[0]?.data?.[0] ?? 0) / dati.spot - 1) * 100).toFixed(1)}% dallo spot)<br/>` +
                    p.map((x) => `${x.seriesName}: <b>${x.data[1].toFixed(1)}%</b> <span style="color:#94a3b8">${x.data[2]}</span>`).join('<br/>'),
            },
            grid: { left: 48, right: 16, top: 36, bottom: 40 },
            xAxis: { type: 'value', scale: true, name: 'Strike', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: '#94a3b8' },
                axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.3)' } } },
            yAxis: { type: 'value', scale: true, name: 'IV %', nameTextStyle: { color: '#94a3b8' }, axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51,65,85,0.3)' } } },
            series: dati.curve.map((c, i) => ({
                name: `${i + 1}ª ${data(c.scadenza)} (${c.dte} gg)`, type: 'line', smooth: true, symbolSize: 6,
                data: c.punti.map((p) => [p.strike, p.iv, `${p.lato === 'P' ? 'put' : p.lato === 'C' ? 'call' : 'put+call'} · ${p.fonte}`]),
                lineStyle: { color: COLORI_CURVE[i], width: 2 }, itemStyle: { color: COLORI_CURVE[i] },
                ...(i === 0 ? {
                    markLine: { symbol: 'none', silent: true, data: [{ xAxis: dati.spot }],
                        lineStyle: { color: '#e2e8f0', type: 'dashed' }, label: { formatter: `Spot ${num(dati.spot)}`, color: '#e2e8f0' } },
                } : {}),
            })),
        };
    }, [dati]);

    return (
        <div className="w-full xl:w-[520px] xl:sticky xl:top-4 border border-slate-800 rounded-lg bg-slate-950 p-3">
            <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-semibold text-slate-200">Curva di volatilità di oggi</div>
                <button onClick={() => { setDati(null); setErrore(null); setGiro((g) => g + 1); }}
                    className="text-xs text-cyan-400 hover:text-cyan-300">Aggiorna</button>
            </div>
            <div className="text-xs text-slate-500">IV del modello IBKR per strike, 1ª e 2ª scadenza: put sotto lo spot, call sopra.</div>
            {errore && <p className="mt-3 text-sm text-red-400">{errore}</p>}
            {!errore && !dati && <p className="mt-3 text-sm text-slate-400">Leggo le opzioni da IBKR (fino a un minuto e mezzo)…</p>}
            {dati && !option && <p className="mt-3 text-sm text-amber-400">Nessuna IV disponibile da IBKR in questo momento.</p>}
            {option && <div className="mt-2 h-[380px]"><ReactECharts option={option} notMerge style={{ height: '100%', width: '100%' }} /></div>}
            {dati && dati.curve.some((c) => c.mancanti > 0) && (
                <div className="mt-1 text-xs text-amber-400">
                    Strike senza IV: {dati.curve.map((c, i) => `${i + 1}ª ${c.mancanti}`).join(', ')} (fuori orario IBKR non sempre la calcola).
                </div>
            )}
            {dati && (
                <div className="mt-1 text-xs text-slate-500">
                    Letta alle {new Date(dati.ora).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}, spot {num(dati.spot)}.
                </div>
            )}
        </div>
    );
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

                    {(() => {
                        // Una riga per orizzonte, le soglie in colonna: si leggono una sotto l'altra.
                        const due = dati.periodi.map(p => p.pct2).filter((v): v is number => v != null);
                        const righe = [
                            { nome: '1 scadenza', medio: r.mediaAssoluta, mediano: r.medianaAssoluta, massimo: r.massimo, oltre: r.oltre, n: r.n },
                            ...(r.mediaAssoluta2 != null && due.length > 0 ? [{
                                nome: '2 scadenze', medio: r.mediaAssoluta2, mediano: r.medianaAssoluta2 ?? null,
                                massimo: due.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)), oltre: r.oltre2 ?? [], n: due.length,
                            }] : []),
                        ];
                        return (
                            <div className="mt-4 max-w-4xl overflow-x-auto border border-slate-800 rounded-lg">
                                <table className="min-w-full text-sm tabular-nums">
                                    <thead>
                                        <tr className="bg-slate-900 text-right text-xs text-slate-400">
                                            <th className="px-3 py-2 text-left font-semibold">Movimento</th>
                                            <th className="px-3 py-2 font-semibold">Medio</th>
                                            <th className="px-3 py-2 font-semibold">Mediano</th>
                                            <th className="px-3 py-2 font-semibold">Massimo</th>
                                            {r.oltre.map(o => <th key={o.soglia} className="px-3 py-2 font-semibold">Oltre {o.soglia}%</th>)}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {righe.map(x => (
                                            <tr key={x.nome} className="border-t border-slate-800 text-right text-slate-300">
                                                <td className="px-3 py-1.5 text-left font-semibold text-cyan-300 whitespace-nowrap">{x.nome}</td>
                                                <td className="px-3 py-1.5 font-bold text-white">{pct(x.medio, false)}</td>
                                                <td className="px-3 py-1.5">{pct(x.mediano, false)}</td>
                                                <td className={`px-3 py-1.5 font-bold ${colore(x.massimo)}`}>{pct(x.massimo)}</td>
                                                {r.oltre.map(o => {
                                                    const c = x.oltre.find(y => y.soglia === o.soglia)?.n ?? 0;
                                                    return (
                                                        <td key={o.soglia} className="px-3 py-1.5 whitespace-nowrap">
                                                            <b className="text-white">{c}</b> <span className="text-slate-500">su {x.n}</span>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        );
                    })()}

                    <div className="mt-6 flex flex-col-reverse xl:flex-row xl:items-start gap-4">
                    <div className="w-full max-w-4xl overflow-x-auto border border-slate-800 rounded-lg">
                        <table className="min-w-full text-sm tabular-nums">
                            <thead>
                                <tr className="bg-slate-900 text-right text-xs text-slate-400">
                                    <th className="px-4 py-2 font-semibold text-left">Da</th>
                                    <th className="px-4 py-2 font-semibold text-left">A</th>
                                    <th className="px-4 py-2 font-semibold">{settimanale ? 'Apertura' : 'Chiusura iniziale'}</th>
                                    <th className="px-4 py-2 font-semibold">{settimanale ? 'Chiusura' : 'Chiusura finale'}</th>
                                    <th className="px-4 py-2 font-semibold">Movimento</th>
                                    <th className="px-4 py-2 font-semibold" title={settimanale
                                        ? "Dall'apertura del lunedì della settimana prima alla chiusura di questo venerdì"
                                        : 'Dalla chiusura di due scadenze fa alla chiusura di questa'}>A 2 scadenze</th>
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
                                        <td className={`px-4 py-1.5 ${p.pct2 == null ? 'text-slate-600' : colore(p.pct2)}`}>{p.pct2 == null ? '—' : pct(p.pct2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <CurvaVol ticker={ticker} />
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
