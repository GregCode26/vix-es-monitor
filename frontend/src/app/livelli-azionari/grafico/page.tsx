'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/**
 * Grafico a candele giornaliere di un ticker di /livelli-azionari, da IBKR
 * (execution/livelli_candele.py), con sopra L1/L2/L3 della riga da cui si e'
 * arrivati (`?id=`), o della piu' recente di quel ticker.
 */

type Barra = [string, number, number, number, number, number];
interface Scadenza { scadenza: string; dte: number; straddle?: number }
interface Riga { id: string; ticker: string; ora: string; spot: number; scadenze: Scadenza[] }

const LIVELLI = [
    { nome: 'L1', molt: 1 / Math.sqrt(3), colore: '#22d3ee' },
    { nome: 'L2', molt: 1, colore: '#fbbf24' },
    { nome: 'L3', molt: Math.sqrt(3), colore: '#c084fc' },
];
const fmt = (v: number) => v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBreve = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

function Grafico() {
    const q = useSearchParams();
    const ticker = (q.get('ticker') ?? '').toUpperCase();
    const id = q.get('id');
    const [anni, setAnni] = useState(1);
    const [barre, setBarre] = useState<Barra[] | null>(null);
    const [riga, setRiga] = useState<Riga | null>(null);
    const [scelta, setScelta] = useState(0);
    const [errore, setErrore] = useState<string | null>(ticker ? null : 'Nessun ticker indicato');

    useEffect(() => {
        if (!ticker) return;
        let annullato = false;
        fetch(`/api/straddle-azionario/candele?ticker=${encodeURIComponent(ticker)}&anni=${anni}`)
            .then(async (r) => {
                const d = await r.json();
                if (annullato) return;
                if (r.ok) { setBarre(d.barre); setErrore(null); } else setErrore(d.errore ?? `Errore ${r.status}`);
            })
            .catch((e) => { if (!annullato) setErrore(String(e)); });
        return () => { annullato = true; };
    }, [ticker, anni]);

    useEffect(() => {
        if (!ticker) return;
        fetch('/api/straddle-azionario').then((r) => r.json()).then((d) => {
            const righe: Riga[] = d.righe ?? [];
            setRiga(righe.find((x) => x.id === id) ?? righe.find((x) => x.ticker === ticker) ?? null);
        }).catch(() => { /* senza righe: solo candele */ });
    }, [ticker, id]);

    const scad = riga?.scadenze[scelta];
    const livelli = useMemo(() => {
        if (!riga || !scad?.straddle) return [];
        return LIVELLI.flatMap((l) => [
            { ...l, verso: '↑', valore: riga.spot + scad.straddle! * l.molt },
            { ...l, verso: '↓', valore: riga.spot - scad.straddle! * l.molt },
        ]);
    }, [riga, scad]);

    const option = useMemo(() => {
        if (!barre || barre.length === 0) return null;
        const date = barre.map((b) => b[0]);
        // Sei mesi visibili all'apertura, il resto si raggiunge con lo zoom.
        const inizio = Math.max(0, 100 - (126 / barre.length) * 100);
        const minLiv = Math.min(...livelli.map((l) => l.valore));
        const maxLiv = Math.max(...livelli.map((l) => l.valore));
        return {
            backgroundColor: '#020617',
            animation: false,
            tooltip: {
                // Niente riquadro dei valori sul puntatore: resta solo il mirino.
                showContent: false,
                trigger: 'axis', axisPointer: { type: 'cross' },
                formatter: (p: { dataIndex: number }[]) => {
                    const b = barre[p[0]?.dataIndex ?? 0];
                    if (!b) return '';
                    const prima = barre[(p[0]?.dataIndex ?? 0) - 1];
                    const var_ = prima ? ((b[4] - prima[4]) / prima[4]) * 100 : null;
                    return `<b>${dataBreve(b[0])}</b><br/>A ${fmt(b[1])} · Max ${fmt(b[2])}<br/>Min ${fmt(b[3])} · C <b>${fmt(b[4])}</b>` +
                        (var_ != null ? ` (${var_ >= 0 ? '+' : ''}${var_.toFixed(2)}%)` : '') +
                        `<br/>Volume ${b[5].toLocaleString('it-IT')}`;
                },
            },
            axisPointer: { link: [{ xAxisIndex: 'all' }] },
            grid: [
                { left: 60, right: 90, top: 30, height: '62%' },
                { left: 60, right: 90, top: '78%', height: '14%' },
            ],
            xAxis: [
                { type: 'category', data: date, boundaryGap: true, axisLabel: { color: '#94a3b8', formatter: dataBreve }, axisLine: { lineStyle: { color: '#334155' } } },
                { type: 'category', data: date, gridIndex: 1, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#334155' } } },
            ],
            yAxis: [
                {
                    scale: true, position: 'right', axisLabel: { color: '#94a3b8' },
                    splitLine: { lineStyle: { color: 'rgba(51,65,85,0.35)' } },
                    // I livelli devono restare in vista anche se lontani dalle candele.
                    min: (v: { min: number }) => (livelli.length ? Math.min(v.min, minLiv) : v.min),
                    max: (v: { max: number }) => (livelli.length ? Math.max(v.max, maxLiv) : v.max),
                },
                { scale: true, gridIndex: 1, position: 'right', axisLabel: { show: false }, splitLine: { show: false } },
            ],
            dataZoom: [
                { type: 'inside', xAxisIndex: [0, 1], start: inizio, end: 100 },
                { type: 'slider', xAxisIndex: [0, 1], start: inizio, end: 100, bottom: 4, height: 18, borderColor: '#334155', textStyle: { color: '#94a3b8' } },
            ],
            series: [
                {
                    name: ticker, type: 'candlestick',
                    data: barre.map((b) => [b[1], b[4], b[3], b[2]]),
                    itemStyle: { color: '#22c55e', color0: '#ef4444', borderColor: '#22c55e', borderColor0: '#ef4444' },
                    markLine: {
                        symbol: 'none', silent: true,
                        data: [
                            ...(riga ? [{
                                yAxis: riga.spot, lineStyle: { color: '#e2e8f0', type: 'dashed', width: 1 },
                                label: { formatter: `Spot ${fmt(riga.spot)}`, color: '#e2e8f0', position: 'end' },
                            }] : []),
                            ...livelli.map((l) => ({
                                yAxis: l.valore, lineStyle: { color: l.colore, width: l.nome === 'L2' ? 1.5 : 1, type: l.nome === 'L3' ? 'dotted' : 'solid' },
                                label: { formatter: `${l.nome}${l.verso} ${fmt(l.valore)}`, color: l.colore, position: 'end' },
                            })),
                        ],
                    },
                },
                {
                    name: 'Volume', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
                    data: barre.map((b, i) => ({ value: b[5], itemStyle: { color: i > 0 && b[4] < barre[i - 1][4] ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.5)' } })),
                },
            ],
        };
    }, [barre, livelli, riga, ticker]);

    const sel = 'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm';
    return (
        <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
            <Link href="/livelli-azionari" className="text-xs text-cyan-400 hover:text-cyan-300">← Livelli azionari</Link>
            <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-bold tracking-wide mr-2">{ticker} · candele giornaliere</h1>
                <label className="text-sm text-slate-400">Storico{' '}
                    <select className={sel} value={anni} onChange={(e) => { setAnni(+e.target.value); setBarre(null); }}>
                        <option value={1}>1 anno</option><option value={2}>2 anni</option><option value={5}>5 anni</option>
                    </select>
                </label>
                {riga && (
                    <label className="text-sm text-slate-400">Livelli della{' '}
                        <select className={sel} value={scelta} onChange={(e) => setScelta(+e.target.value)}>
                            {riga.scadenze.map((s, i) => (
                                <option key={s.scadenza} value={i}>{i + 1}ª scadenza · {dataBreve(s.scadenza)} ({s.dte} gg)</option>
                            ))}
                        </select>
                    </label>
                )}
                <Link href={`/livelli-azionari/statistica?ticker=${encodeURIComponent(ticker)}`} className="text-xs text-cyan-400 hover:text-cyan-300">Statistica</Link>
            </div>
            {riga ? (
                <p className="mt-1 text-xs text-slate-400">
                    Livelli dal calcolo del {new Date(riga.ora).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    {' '}(spot {fmt(riga.spot)}{scad?.straddle ? `, straddle ${fmt(scad.straddle)}` : ''}): L1 = straddle/√3, L2 = straddle, L3 = straddle×√3.
                </p>
            ) : (
                <p className="mt-1 text-xs text-slate-500">Nessuna riga salvata per {ticker}: solo candele.</p>
            )}

            {errore && <p className="mt-4 text-sm text-red-400">{errore}</p>}
            {!errore && !option && <p className="mt-4 text-sm text-slate-400">Leggo le candele da IBKR…</p>}
            {option && (
                <div className="mt-4 h-[75vh] min-h-[480px] border border-slate-800 rounded-lg">
                    <ReactECharts option={option} notMerge style={{ height: '100%', width: '100%' }} />
                </div>
            )}
        </main>
    );
}

export default function GraficoPage() {
    return (
        <Suspense>
            <Grafico />
        </Suspense>
    );
}
