// frontend/src/app/spx-gamma/page.tsx
//
// Profilo del gamma per strike, con lo spot che ci scorre accanto.
//
// Era un mockup: barre, pallini e livelli erano array scritti a mano su
// strike di un'altra epoca, e solo la linea dello spot veniva da /api/market.
// Ora tutto arriva da /api/gex, cioe' dagli stessi snapshot che il poller dei
// volumi raccoglie da TWS -- gamma compreso, dai modelGreeks.
//
// Le barre sono il totale di giornata per strike, nelle due letture che
// l'API porta gia' calcolate:
//   OI      pesato sull'open interest -> POSIZIONAMENTO, il GEX canonico
//   Volume  pesato sul volume scambiato oggi -> FLUSSO
// I pallini sono lo stesso profilo (OI) com'era 1, 5 e 10 minuti fa: dicono
// da che parte si sta muovendo un muro, non solo quanto e' alto.
'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/** Totale di giornata per strike, gia' cumulato dal server. */
interface ProfileRow {
    strike: number;
    gex: number;
    gexOi: number;
}

/** Il sottostante come IBKR lo vedeva quando ha valutato il gamma. */
interface SpotPoint {
    time: string;
    price: number;
}

interface ProfileSnapshot {
    minutesAgo: number;
    time: string;
    rows: ProfileRow[];
}

/** Profilo ricevuto, con l'istante in cui l'abbiamo visto. */
interface VoceStorico {
    tMs: number;
    rows: ProfileRow[];
}

const MINUTI_STORICO = [1, 5, 10];
/** Dieci minuti di profili a un giro ogni 15s, con margine. */
const MAX_STORICO = 120;
const REFRESH_MS = 15000;
/** Quanti strike seguire con i pallini: tutti e 37 sarebbero una nuvola. */
const TOP_STRIKE = 8;

/**
 * L'API ragiona in milioni. Su 0DTE il volume di giornata su uno strike ATM
 * porta il GEX oltre i centomila milioni: in miliardi si legge, in milioni
 * l'asse diventa una fila di zeri.
 */
function inMiliardi(milioni: number): number {
    return Math.round((milioni / 1000) * 100) / 100;
}

type Base = 'oi' | 'vol' | 'entrambe';

/**
 * Le due basi non stanno sulla stessa scala: l'open interest e' quello di
 * ieri sera, il volume e' tutto quello passato oggi, e su 0DTE il secondo
 * vale una ventina di volte il primo. Messe insieme su un asse lineare, le
 * barre OI si schiacciano sullo zero -- da qui il selettore, con 'entrambe'
 * per chi vuole vedere proprio quel rapporto.
 */
const BASI: { id: Base; label: string }[] = [
    { id: 'oi', label: 'Open Interest' },
    { id: 'vol', label: 'Volume' },
    { id: 'entrambe', label: 'Entrambe' },
];

// Converts "HH:mm:ss" time string to a Date timestamp for today
function timeStringToDate(timeStr: string): number {
    const [h, m, s] = timeStr.split(':').map(Number);
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s ?? 0).getTime();
}

/**
 * Livello di inversione del gamma, per somma cumulata: si sale per strike
 * finche' il totale non cambia segno, e si interpola fra i due adiacenti.
 *
 * E' un'approssimazione, e va detto: il gamma flip vero si troverebbe
 * rivalutando l'intero profilo a spot diversi, e il gamma che abbiamo e'
 * quello di adesso, misurato a questo spot. Sopra questo livello i dealer
 * risultano lunghi di gamma (movimento smorzato), sotto corti (accelerato).
 */
function zeroGamma(rows: ProfileRow[], chiave: 'gex' | 'gexOi'): number | null {
    if (rows.length < 2) return null;
    let cum = 0;
    let precStrike: number | null = null;
    let precCum = 0;
    for (const r of rows) {
        const nuovo = cum + r[chiave];
        if (precStrike !== null && ((precCum <= 0 && nuovo > 0) || (precCum >= 0 && nuovo < 0))) {
            const salto = nuovo - precCum;
            if (salto === 0) return r.strike;
            const frazione = -precCum / salto;
            return Math.round((precStrike + (r.strike - precStrike) * frazione) * 100) / 100;
        }
        precCum = nuovo;
        precStrike = r.strike;
        cum = nuovo;
    }
    return null;
}

export default function SpxGammaPage() {
    const router = useRouter();
    const [profile, setProfile] = useState<ProfileRow[]>([]);
    const [spot, setSpot] = useState<SpotPoint[]>([]);
    const [storico, setStorico] = useState<VoceStorico[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [aggiornato, setAggiornato] = useState<string | null>(null);
    const [base, setBase] = useState<Base>('oi');
    const lastTime = useRef<string | null>(null);
    const giornoSessione = useRef<string | null>(null);

    const fetchGex = useCallback(async () => {
        try {
            // Ogni snapshot vale ~37 strike: senza `since` si riscaricherebbe
            // l'intera giornata a ogni giro, che e' la voce che spende
            // l'egress di Supabase.
            // `flow=0`: qui si disegna il profilo per strike, non le bolle del
            // flusso, che da sole sono mezzo megabyte a fine sessione.
            const since = lastTime.current;
            const q = new URLSearchParams({ flow: '0' });
            if (since) q.set('since', since);
            const res = await fetch(`/api/gex?${q}`, { cache: 'no-store' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Caricamento del gamma fallito');
            }
            const json = await res.json();

            // Cambio di giornata: si riparte da zero, senza `since`. Senza
            // questo il cursore restava all'ultimo snapshot di ieri sera e
            // oggi la pagina scartava tutto fino a quell'ora.
            if (json.date && giornoSessione.current && json.date !== giornoSessione.current) {
                giornoSessione.current = json.date;
                lastTime.current = null;
                setProfile([]);
                setSpot([]);
                setStorico([]);
                setAggiornato(null);
                return;
            }
            if (json.date) giornoSessione.current = json.date;

            if (json.lastTime) lastTime.current = json.lastTime;

            const nuovoProfilo: ProfileRow[] = json.profile ?? [];
            const nuovoSpot: SpotPoint[] = json.spot ?? [];
            const adesso = Date.now();

            // Con `since` una risposta vuota e' normale: vuol dire solo che
            // non sono arrivati snapshot nuovi. Si tiene quello che c'e'.
            if (nuovoProfilo.length > 0) {
                setProfile(nuovoProfilo);
                setStorico((prev) => [...prev, { tMs: adesso, rows: nuovoProfilo }].slice(-MAX_STORICO));
            }
            if (nuovoSpot.length > 0) {
                setSpot((prev) => (since ? [...prev, ...nuovoSpot].slice(-2000) : nuovoSpot));
                setAggiornato(nuovoSpot[nuovoSpot.length - 1].time);
            }
            // Al primo giro lo storico lo passa il server, altrimenti i
            // pallini comparirebbero solo dopo dieci minuti di pagina aperta.
            if (!since && Array.isArray(json.profileHistory)) {
                const semi: VoceStorico[] = (json.profileHistory as ProfileSnapshot[])
                    .map((p) => ({ tMs: adesso - p.minutesAgo * 60000, rows: p.rows }))
                    .sort((a, b) => a.tMs - b.tMs);
                setStorico((prev) => [...semi, ...prev].slice(-MAX_STORICO));
            }
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Errore');
        }
    }, []);

    useEffect(() => {
        fetchGex();
        const id = setInterval(fetchGex, REFRESH_MS);
        return () => clearInterval(id);
    }, [fetchGex]);

    const spotData = useMemo(
        () => spot.map((p) => [timeStringToDate(p.time), p.price]),
        [spot],
    );

    /** Barre: positive e negative separate, entrambe verso destra. */
    const barre = useMemo(() => {
        const posOi: number[][] = [];
        const negOi: number[][] = [];
        const posVol: number[][] = [];
        const negVol: number[][] = [];
        for (const r of profile) {
            if (r.gexOi > 0) posOi.push([inMiliardi(r.gexOi), r.strike]);
            else if (r.gexOi < 0) negOi.push([inMiliardi(-r.gexOi), r.strike]);
            if (r.gex > 0) posVol.push([inMiliardi(r.gex), r.strike]);
            else if (r.gex < 0) negVol.push([inMiliardi(-r.gex), r.strike]);
        }
        return { posOi, negOi, posVol, negVol };
    }, [profile]);

    /** Su quale delle due misure ragionano pallini e livelli. */
    const chiave: 'gex' | 'gexOi' = base === 'vol' ? 'gex' : 'gexOi';

    /** Gli strike che contano davvero, quelli che i pallini seguono. */
    const strikeSeguiti = useMemo(() => {
        return new Set(
            [...profile]
                .sort((a, b) => Math.abs(b[chiave]) - Math.abs(a[chiave]))
                .slice(0, TOP_STRIKE)
                .map((r) => r.strike),
        );
    }, [profile, chiave]);

    const pallini = useMemo(() => {
        const adesso = Date.now();
        const punti: number[][] = [];
        for (const minuti of MINUTI_STORICO) {
            const limite = adesso - minuti * 60000;
            let scelto: VoceStorico | null = null;
            for (const v of storico) {
                if (v.tMs <= limite && (!scelto || v.tMs > scelto.tMs)) scelto = v;
            }
            if (!scelto) continue;
            for (const r of scelto.rows) {
                if (!strikeSeguiti.has(r.strike)) continue;
                const valore = base === 'vol' ? r.gex : r.gexOi;
                if (valore === 0) continue;
                punti.push([inMiliardi(Math.abs(valore)), r.strike]);
            }
        }
        return punti;
    }, [storico, strikeSeguiti, base]);

    /** Livelli di riferimento, tutti dedotti dal profilo vero. */
    const livelli = useMemo(() => {
        if (profile.length === 0) return { maxPos: null, maxNeg: null, flip: null };
        let maxPos: ProfileRow | null = null;
        let maxNeg: ProfileRow | null = null;
        for (const r of profile) {
            if (r[chiave] > 0 && (!maxPos || r[chiave] > maxPos[chiave])) maxPos = r;
            if (r[chiave] < 0 && (!maxNeg || r[chiave] < maxNeg[chiave])) maxNeg = r;
        }
        return {
            maxPos: maxPos?.strike ?? null,
            maxNeg: maxNeg?.strike ?? null,
            flip: zeroGamma(profile, chiave),
        };
    }, [profile, chiave]);

    const prezzoOra = spotData.length > 0 ? spotData[spotData.length - 1][1] : null;

    /** Scale ricavate dai dati: niente piu' 7300-7520 scritti a mano. */
    const scale = useMemo(() => {
        const strikes = profile.map((r) => r.strike);
        const prezzi = spot.map((p) => p.price);
        // L'asse si allarga su quello che si vede: con la sola base OI, le
        // barre a volume non devono comprimerla.
        const valori = profile.flatMap((r) =>
            base === 'oi' ? [Math.abs(r.gexOi)]
                : base === 'vol' ? [Math.abs(r.gex)]
                    : [Math.abs(r.gexOi), Math.abs(r.gex)],
        );
        if (strikes.length === 0) return null;
        const min = Math.min(...strikes, ...(prezzi.length > 0 ? prezzi : strikes));
        const max = Math.max(...strikes, ...(prezzi.length > 0 ? prezzi : strikes));
        const margine = Math.max((max - min) * 0.03, 5);
        return {
            yMin: Math.floor((min - margine) / 5) * 5,
            yMax: Math.ceil((max + margine) / 5) * 5,
            xMax: inMiliardi(Math.max(...valori, 1)) * 1.1,
        };
    }, [profile, spot, base]);

    const pronto = profile.length > 0 && scale !== null;

    const option = useMemo(() => {
        if (!pronto || !scale) return {};

        const markLines: Record<string, unknown>[] = [];
        if (prezzoOra != null) {
            markLines.push({
                yAxis: prezzoOra,
                lineStyle: { color: '#06b6d4', type: 'dotted', width: 1.5 },
            });
        }
        if (livelli.maxPos != null) {
            markLines.push({
                yAxis: livelli.maxPos,
                label: { formatter: `Major Pos Gamma ${livelli.maxPos}`, position: 'insideStartTop', color: '#4ade80' },
                lineStyle: { color: '#4ade80', type: 'dashed', width: 1 },
            });
        }
        if (livelli.maxNeg != null) {
            markLines.push({
                yAxis: livelli.maxNeg,
                label: { formatter: `Major Neg Gamma ${livelli.maxNeg}`, position: 'insideStartBottom', color: '#f87171' },
                lineStyle: { color: '#f87171', type: 'dashed', width: 1 },
            });
        }
        if (livelli.flip != null) {
            markLines.push({
                yAxis: livelli.flip,
                label: { formatter: `Zero Gamma ~${livelli.flip}`, position: 'insideStartTop', color: '#f59e0b' },
                lineStyle: { color: '#f59e0b', type: 'dashed', width: 1 },
            });
        }

        const serieBarre = [
            ...(base !== 'vol'
                ? [
                    {
                        name: 'Pos GEX (OI)',
                        type: 'bar',
                        xAxisIndex: 0,
                        data: barre.posOi,
                        itemStyle: { color: '#4ade80', opacity: 0.8 },
                        barWidth: 3,
                    },
                    {
                        name: 'Neg GEX (OI)',
                        type: 'bar',
                        xAxisIndex: 0,
                        data: barre.negOi,
                        itemStyle: { color: '#f87171', opacity: 0.8 },
                        barWidth: 3,
                    },
                ]
                : []),
            ...(base !== 'oi'
                ? [
                    {
                        name: 'Pos GEX (Volume)',
                        type: 'bar',
                        xAxisIndex: 0,
                        data: barre.posVol,
                        itemStyle: { color: '#86efac', opacity: 0.9 },
                        barWidth: base === 'entrambe' ? 1.5 : 3,
                        barGap: '-75%',
                    },
                    {
                        name: 'Neg GEX (Volume)',
                        type: 'bar',
                        xAxisIndex: 0,
                        data: barre.negVol,
                        itemStyle: { color: '#fca5a5', opacity: 0.9 },
                        barWidth: base === 'entrambe' ? 1.5 : 3,
                        barGap: '-75%',
                    },
                ]
                : []),
        ];

        return {
            backgroundColor: '#0c0d10',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
            },
            legend: {
                data: [
                    ...serieBarre.map((s) => s.name),
                    'Spot', '1/5/10 min fa',
                ],
                textStyle: { color: '#94a3b8', fontSize: 10 },
                top: 10,
                right: 10,
                orient: 'vertical',
                backgroundColor: 'rgba(12, 13, 16, 0.8)',
                padding: 10,
                borderRadius: 4,
                borderColor: '#334155',
                borderWidth: 1,
            },
            grid: {
                left: 60,
                right: 30,
                top: 50,
                bottom: 50,
            },
            xAxis: [
                {
                    // Top X-Axis: Gamma Exposure
                    type: 'value',
                    position: 'top',
                    min: 0,
                    max: scale.xMax,
                    name: 'Gamma Exposure ($Bn per 1% di movimento)',
                    nameLocation: 'center',
                    nameGap: 25,
                    nameTextStyle: { color: '#e2e8f0', fontSize: 14, fontWeight: 'bold' },
                    axisLabel: { color: '#94a3b8' },
                    splitLine: { show: false },
                    axisLine: { lineStyle: { color: '#334155' } },
                },
                {
                    // Bottom X-Axis: ora italiana, la stessa che scrive il poller
                    type: 'time',
                    position: 'bottom',
                    name: 'Ora italiana',
                    nameLocation: 'center',
                    nameGap: 30,
                    nameTextStyle: { color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' },
                    axisLabel: {
                        color: '#94a3b8',
                        formatter: '{HH}:{mm}',
                    },
                    splitLine: { show: false },
                    axisLine: { lineStyle: { color: '#334155' } },
                },
            ],
            yAxis: {
                // Shared Y-Axis: Strike Price
                type: 'value',
                min: scale.yMin,
                max: scale.yMax,
                name: 'Strike',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            series: [
                ...serieBarre,
                {
                    name: 'Spot',
                    type: 'line',
                    xAxisIndex: 1, // Binds to bottom time axis
                    data: spotData,
                    showSymbol: false,
                    lineStyle: { color: '#06b6d4', width: 2 },
                    markLine: {
                        symbol: ['none', 'none'],
                        label: {
                            show: true,
                            position: 'end',
                            formatter: '{c}',
                            color: '#06b6d4',
                            backgroundColor: 'rgba(6, 182, 212, 0.1)',
                            borderColor: '#06b6d4',
                            borderWidth: 1,
                            padding: [2, 4],
                            borderRadius: 4,
                        },
                        data: markLines,
                    },
                },
                {
                    name: '1/5/10 min fa',
                    type: 'scatter',
                    xAxisIndex: 0,
                    data: pallini,
                    itemStyle: { color: '#e2e8f0', shadowBlur: 5, shadowColor: '#000' },
                    symbolSize: 4,
                },
            ],
        };
    }, [pronto, scale, barre, spotData, pallini, livelli, prezzoOra, base]);

    return (
        <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
            <div className="w-full max-w-[1920px] mx-auto">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
                            SPX Gamma Exposure
                        </h1>
                        {aggiornato && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                LIVE {aggiornato}
                            </span>
                        )}
                        {prezzoOra != null && (
                            <span className="text-xs text-slate-400">
                                SPX <span className="text-cyan-400 font-semibold">{prezzoOra.toFixed(2)}</span>
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2 items-center">
                        <div className="flex rounded-lg overflow-hidden border border-slate-700 mr-1">
                            {BASI.map((b) => (
                                <button
                                    key={b.id}
                                    onClick={() => setBase(b.id)}
                                    className={`px-2.5 py-1.5 text-xs transition-colors ${base === b.id
                                        ? 'bg-teal-600/30 text-teal-300'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
                                        }`}
                                >
                                    {b.label}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => router.push('/gex')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            GEX Flow
                        </button>
                        <button
                            onClick={() => router.push('/spx-volumes')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            SPX Volumes
                        </button>
                        <button
                            onClick={() => router.push('/hedging-pressure')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            Hedging Pressure
                        </button>
                        <button
                            onClick={() => router.push('/market')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            Market Monitor
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="text-amber-300 bg-amber-950/30 border border-amber-900/50 p-2 rounded text-xs mb-2">
                        ⚠️ {error}
                    </div>
                )}

                <div className="bg-[#0c0d10] border border-slate-800/80 rounded-xl p-2 shadow-2xl w-full">
                    <div className="h-[calc(100vh-120px)] min-h-[600px]">
                        {pronto ? (
                            <ReactECharts
                                option={option}
                                style={{ height: '100%', width: '100%' }}
                                notMerge={true}
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-slate-500">
                                {error ? (
                                    <span>Nessun gamma da disegnare.</span>
                                ) : (
                                    <>
                                        <div className="w-12 h-12 border-4 border-teal-500/30 border-t-teal-500 rounded-full animate-spin" />
                                        <span>In attesa degli snapshot del poller...</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <p className="mt-2 text-[11px] text-slate-500">
                    Gamma dai modelGreeks IBKR sugli stessi contratti che il poller dei volumi
                    sottoscrive. Il segno (call positive, put negative) e&apos; l&apos;euristica standard
                    &quot;dealer lunghi di call, corti di put&quot;, non un dato osservato; lo Zero Gamma e&apos;
                    l&apos;inversione della somma cumulata, un&apos;approssimazione del livello di flip.
                </p>
            </div>
        </div>
    );
}
