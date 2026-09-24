'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface VolumeRow {
    strike: number;
    calls?: number;
    puts?: number;
    callsOi?: number;
    putsOi?: number;
}

interface ProfileRow {
    strike: number;
    gex: number;
    gexOi: number;
}

interface SpotPoint {
    time: string;
    price: number;
}

interface VolumesSnapshot {
    time: string;
    spxPrice?: number | null;
    volumes?: VolumeRow[];
}

interface GexResponse {
    profile?: ProfileRow[];
    spot?: SpotPoint[];
    date?: string;
}

interface VolumesResponse {
    snapshots?: VolumesSnapshot[];
    history?: VolumesSnapshot[];
}

const REFRESH_MS = 5000;

interface RangeValues {
    r1Up: number;
    r1Down: number;
    r2Up: number;
    r2Down: number;
    r3Up: number;
    r3Down: number;
}

function inMiliardi(milioni: number): number {
    return Math.round((milioni / 1000) * 100) / 100;
}

// Normale CDF approssimata (Hastings)
function normCdf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));

    return 0.5 * (1.0 + sign * y);
}

function estimateDelta(strike: number, spot: number, isCall: boolean, volatility = 0.6): number {
    // Black-Scholes delta con volatilità 0DTE
    // Per 0DTE, usiamo solo moneyness e IV approssiata
    const timeToExpiry = 1 / 252; // 1 giorno
    const r = 0.05; // tasso risk-free

    const d1 = (Math.log(spot / strike) + (r + (volatility * volatility) / 2) * timeToExpiry) /
               (volatility * Math.sqrt(timeToExpiry));

    if (isCall) {
        return normCdf(d1);
    } else {
        return normCdf(d1) - 1;
    }
}

function calcRanges(spx: number, es: number, callBid: number, callAsk: number, putBid: number, putAsk: number): RangeValues | null {
    if ([spx, es, callBid, callAsk, putBid, putAsk].some(isNaN)) return null;

    const basis = es - spx;
    const callMid = (callBid + callAsk) / 2;
    const putMid = (putBid + putAsk) / 2;
    const straddle = callMid + putMid;
    const sqrt3 = Math.sqrt(3);

    return {
        r1Up: Math.round((spx + straddle + basis) * 100) / 100,
        r1Down: Math.round((spx - straddle + basis) * 100) / 100,
        r2Up: Math.round((spx + straddle / sqrt3 + basis) * 100) / 100,
        r2Down: Math.round((spx - straddle / sqrt3 + basis) * 100) / 100,
        r3Up: Math.round((spx + straddle * sqrt3 + basis) * 100) / 100,
        r3Down: Math.round((spx - straddle * sqrt3 + basis) * 100) / 100,
    };
}

export default function OokPage() {
    const [volumes, setVolumes] = useState<VolumeRow[]>([]);
    const [gex, setGex] = useState<ProfileRow[]>([]);
    const [spot, setSpot] = useState<SpotPoint[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [updated, setUpdated] = useState<string | null>(null);
    const [ranges, setRanges] = useState<RangeValues | null>(null);
    const [rangeInputs, setRangeInputs] = useState({
        spx: '',
        es: '',
        callBid: '',
        callAsk: '',
        putBid: '',
        putAsk: '',
    });
    const chartRef = useRef<any>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [chartOffset, setChartOffset] = useState({ x: 0, y: 0 });
    const [showTheory, setShowTheory] = useState(false);

    const fetchData = useCallback(async () => {
        try {
            const gexRes = await fetch('/api/gex?flow=0', { cache: 'no-store' });
            if (!gexRes.ok) throw new Error('GEX fetch failed');
            const gexData: GexResponse = await gexRes.json();

            const volRes = await fetch('/api/volumes', { cache: 'no-store' });
            if (!volRes.ok) throw new Error('Volumes fetch failed');
            const volData: VolumesResponse = await volRes.json();

            if (gexData.profile && gexData.profile.length > 0) {
                setGex(gexData.profile);
            }
            if (gexData.spot && gexData.spot.length > 0) {
                setSpot(gexData.spot);
                setUpdated(gexData.spot[gexData.spot.length - 1].time);
            }

            const snapshots = volData.history || volData.snapshots;
            if (snapshots && snapshots.length > 0) {
                const lastSnapshot = snapshots[snapshots.length - 1];
                if (lastSnapshot.volumes && Array.isArray(lastSnapshot.volumes)) {
                    setVolumes(lastSnapshot.volumes);
                }
            }

            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Fetch error');
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, REFRESH_MS);
        return () => clearInterval(interval);
    }, [fetchData]);

    const currentSpot = useMemo(() => {
        return spot.length > 0 ? spot[spot.length - 1].price : null;
    }, [spot]);

    const handleRangeCalc = useCallback(() => {
        const result = calcRanges(
            parseFloat(rangeInputs.spx),
            parseFloat(rangeInputs.es),
            parseFloat(rangeInputs.callBid),
            parseFloat(rangeInputs.callAsk),
            parseFloat(rangeInputs.putBid),
            parseFloat(rangeInputs.putAsk),
        );
        if (result) {
            setRanges(result);
            localStorage.setItem('ookRanges', JSON.stringify(result));
        }
    }, [rangeInputs]);

    useEffect(() => {
        // Leggi i dati calcolati da /market
        const today = new Date().toISOString().split('T')[0];
        const keys = Object.keys(localStorage).filter(k => k.includes('rangeCalc'));
        console.log('All rangeCalc keys:', keys, 'Today:', today);

        // Prova prima le chiavi di oggi, poi tutte le altre
        const sortedKeys = keys.sort((a, b) => {
            const aToday = a.includes(today) ? 0 : 1;
            const bToday = b.includes(today) ? 0 : 1;
            return aToday - bToday;
        });

        for (const key of sortedKeys) {
            try {
                const data = JSON.parse(localStorage.getItem(key) || '{}');
                console.log(`Checking ${key}:`, data);

                // Controlla se ha dati validi (non stringhe vuote)
                const spxVal = parseFloat(data.spx);
                const esVal = parseFloat(data.es);
                const callBidVal = parseFloat(data.callBid);
                const callAskVal = parseFloat(data.callAsk);
                const putBidVal = parseFloat(data.putBid);
                const putAskVal = parseFloat(data.putAsk);

                if (!isNaN(spxVal) && !isNaN(esVal) && !isNaN(callBidVal) && !isNaN(callAskVal) && !isNaN(putBidVal) && !isNaN(putAskVal)) {
                    const result = calcRanges(spxVal, esVal, callBidVal, callAskVal, putBidVal, putAskVal);
                    if (result) {
                        console.log('✅ Loaded ranges from', key, ':', result);
                        setRanges(result);
                        break;
                    }
                }
            } catch (e) {
                console.error(`Error parsing ${key}:`, e);
            }
        }
    }, []);

    const dataByStrike = useMemo(() => {
        if (volumes.length === 0 || gex.length === 0 || currentSpot == null) return null;

        const gexMap = new Map(gex.map(g => [g.strike, g]));

        return volumes.map(vol => {
            const g = gexMap.get(vol.strike);
            const callVol = vol.calls ?? 0;
            const putVol = vol.puts ?? 0;
            const netVol = callVol - putVol;

            // Calcola delta e pondra i volumi
            const callDelta = Math.abs(estimateDelta(vol.strike, currentSpot, true));
            const putDelta = Math.abs(estimateDelta(vol.strike, currentSpot, false));

            const volDeltaNet = (callVol * callDelta) - (putVol * putDelta);

            return {
                strike: vol.strike,
                dexBuy: Math.max(0, netVol),
                dexSell: Math.max(0, -netVol),
                gammaPos: Math.max(0, g?.gex ?? 0),
                gammaNeg: Math.max(0, -(g?.gex ?? 0)),
                callVol,
                putVol,
                volDeltaNet,
            };
        }).sort((a, b) => a.strike - b.strike); // Ordinato da basso a alto
    }, [volumes, gex, currentSpot]);

    const scales = useMemo(() => {
        if (!dataByStrike || dataByStrike.length === 0) return null;

        const dexVals = dataByStrike.flatMap(d => [d.dexBuy, d.dexSell]);
        const gammaVals = dataByStrike.flatMap(d => [d.gammaPos, d.gammaNeg]);
        const volVals = dataByStrike.flatMap(d => [d.callVol, d.putVol]);

        return {
            dexMax: Math.max(...dexVals, 1) * 1.15,
            gammaMax: inMiliardi(Math.max(...gammaVals, 1)) * 1.15,
            volMax: (Math.max(...volVals, 1) / 1000) * 1.15,
        };
    }, [dataByStrike]);

    if (!dataByStrike || !scales) {
        return (
            <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-5">
                <div className="text-center pt-20">
                    <div className="w-12 h-12 border-4 border-teal-500/30 border-t-teal-500 rounded-full animate-spin mx-auto mb-4" />
                    <span>In attesa dei dati...</span>
                </div>
            </div>
        );
    }

    const strikeLabels = dataByStrike.map(d => d.strike.toFixed(0));

    // Trova l'indice dello spot più vicino
    const spotIndex = currentSpot != null
        ? dataByStrike.findIndex(d => Math.abs(d.strike - currentSpot) === Math.min(...dataByStrike.map(x => Math.abs(x.strike - currentSpot))))
        : -1;

    // Calcola la posizione Y della linea dello spot nel grafico basata sul valore dello strike
    const strikeMin = dataByStrike.length > 0 ? dataByStrike[0].strike : 0;
    const strikeMax = dataByStrike.length > 0 ? dataByStrike[dataByStrike.length - 1].strike : 0;
    const spotYPercent = currentSpot != null && strikeMax > strikeMin
        ? 100 - ((currentSpot - strikeMin) / (strikeMax - strikeMin)) * 100
        : 50;

    const option = {
        backgroundColor: '#0c0d10',
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            backgroundColor: 'rgba(12, 13, 16, 0.95)',
            borderColor: '#334155',
            textStyle: { color: '#e2e8f0', fontSize: 11 },
        },
        toolbox: {
            feature: {
                dataZoom: { yAxisIndex: 'all' },
                restore: {},
            },
            right: 20,
            top: 10,
            iconStyle: { borderColor: '#94a3b8' },
            textStyle: { color: '#94a3b8' },
        },
        grid: [
            { left: 50, right: '68%', top: 40, bottom: 50, containLabel: true },
            { left: '34%', right: '36%', top: 40, bottom: 50, containLabel: true },
            { left: '66%', right: 50, top: 40, bottom: 50, containLabel: true },
        ],
        xAxis: [
            { type: 'value', gridIndex: 0, name: 'DEX', axisLabel: { color: '#94a3b8', fontSize: 9 }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false }, scale: true },
            { type: 'value', gridIndex: 1, name: 'Gamma', axisLabel: { color: '#94a3b8', fontSize: 9 }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false }, scale: true },
            { type: 'value', gridIndex: 2, name: 'Volume', axisLabel: { color: '#94a3b8', fontSize: 9 }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false }, scale: true },
        ],
        dataZoom: [
            { type: 'inside', yAxisIndex: [0, 1, 2], moveOnMouseMove: true, zoomOnMouseWheel: false, startValue: 0, endValue: 100 },
        ],
        yAxis: [
            { type: 'category', gridIndex: 0, data: strikeLabels, axisLabel: { color: '#94a3b8', fontSize: 9 }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false } },
            { type: 'category', gridIndex: 1, data: strikeLabels, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false } },
            { type: 'category', gridIndex: 2, data: strikeLabels, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { show: false } },
        ],
        series: [
            // DEX Buy (verde)
            { name: 'DEX Buy', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, data: dataByStrike.map(d => d.dexBuy), itemStyle: { color: '#22c55e', opacity: 0.85 }, barWidth: '70%' },
            // DEX Sell (viola) - negativa
            { name: 'DEX Sell', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, data: dataByStrike.map(d => -d.dexSell), itemStyle: { color: '#a855f7', opacity: 0.85 }, barWidth: '70%' },

            // Gamma Pos (blu)
            { name: 'Gamma +', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: dataByStrike.map(d => inMiliardi(d.gammaPos)), itemStyle: { color: '#3b82f6', opacity: 0.85 }, barWidth: '70%' },
            // Gamma Neg (arancione) - negativa
            { name: 'Gamma -', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: dataByStrike.map(d => -inMiliardi(d.gammaNeg)), itemStyle: { color: '#fb923c', opacity: 0.85 }, barWidth: '70%' },

            // Volume Net Delta (call delta - put delta)
            { name: 'Vol Δ', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: dataByStrike.map(d => d.volDeltaNet / 1000), itemStyle: { color: (d: { value: number }) => d.value > 0 ? '#10b981' : '#ef4444', opacity: 0.85 }, barWidth: '70%' },

            // Spot line - rimosso, ora usato solo graphic
            ...(false ? [
                {
                    type: 'scatter',
                    symbolSize: 0,
                    data: [],
                    markLine: {
                        silent: false,
                        symbol: ['none', 'none'],
                        lineStyle: { color: '#f97316', width: 2.5, type: 'solid' },
                        data: [{
                            yAxis: strikeLabels[spotIndex],
                            label: {
                                show: true,
                                position: 'start',
                                formatter: `SPX ${currentSpot?.toFixed(2)}`,
                                color: '#f97316',
                                backgroundColor: 'rgba(249, 115, 22, 0.15)',
                                borderColor: '#f97316',
                                borderWidth: 1,
                                borderRadius: 3,
                                padding: [4, 8],
                                fontSize: 11,
                                fontWeight: 'bold',
                            }
                        }],
                    },
                },
                {
                    type: 'scatter',
                    symbolSize: 0,
                    data: [],
                    markLine: {
                        silent: false,
                        symbol: ['none', 'none'],
                        lineStyle: { color: '#f97316', width: 2.5, type: 'solid' },
                        data: [{
                            yAxis: strikeLabels[spotIndex],
                        }],
                    },
                },
                {
                    type: 'scatter',
                    symbolSize: 0,
                    data: [],
                    markLine: {
                        silent: false,
                        symbol: ['none', 'none'],
                        lineStyle: { color: '#f97316', width: 2.5, type: 'solid' },
                        data: [{
                            yAxis: strikeLabels[spotIndex],
                        }],
                    },
                },
            ] : []),
        ],
        legend: {
            data: ['DEX Buy', 'DEX Sell', 'Gamma +', 'Gamma -', 'Vol Δ'],
            textStyle: { color: '#94a3b8', fontSize: 11 },
            top: 8,
            left: 'center',
        },
        graphic: [],
    };

    return (
        <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-4">
            <div className="mb-3">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-orange-400 bg-clip-text text-transparent">
                            OOK: DEX / Gamma / Volume
                        </h1>
                        <button
                            onClick={() => setShowTheory(!showTheory)}
                            className="ml-2 px-2 py-1 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-xs text-slate-400 hover:text-slate-200 transition-colors"
                            title="Mostra la teoria delle metriche"
                        >
                            ℹ️ Info
                        </button>
                        {updated && (
                            <span className="text-xs text-slate-400">
                                {updated}
                            </span>
                        )}
                        {currentSpot != null && (
                            <span className="text-xs text-orange-400 font-semibold ml-2">
                                SPX {currentSpot.toFixed(2)}
                            </span>
                        )}
                    </div>
                </div>

                {/* Range Info */}
                {ranges && (
                    <div className="bg-slate-900/40 border border-slate-700/50 rounded p-2 mb-3">
                        <div className="text-[11px] text-slate-400">
                            R1: <span className="text-red-400 font-semibold">{ranges.r1Up.toFixed(2)}</span> / <span className="text-red-400 font-semibold">{ranges.r1Down.toFixed(2)}</span> &nbsp;&nbsp;
                            R2: <span className="text-yellow-400 font-semibold">{ranges.r2Up.toFixed(2)}</span> / <span className="text-yellow-400 font-semibold">{ranges.r2Down.toFixed(2)}</span> &nbsp;&nbsp;
                            R3: <span className="text-purple-400 font-semibold">{ranges.r3Up.toFixed(2)}</span> / <span className="text-purple-400 font-semibold">{ranges.r3Down.toFixed(2)}</span>
                        </div>
                    </div>
                )}
            </div>

            {error && (
                <div className="text-amber-300 bg-amber-950/30 border border-amber-900/50 p-2 rounded text-xs mb-2">
                    ⚠️ {error}
                </div>
            )}

            <div
                className="bg-[#0c0d10] border border-slate-800/80 rounded-lg shadow-2xl overflow-hidden relative"
                ref={chartRef}
                onMouseDown={(e) => {
                    setIsDragging(true);
                    setDragStart({ x: e.clientX, y: e.clientY });
                }}
                onMouseMove={(e) => {
                    if (!isDragging) return;
                    const deltaX = e.clientX - dragStart.x;
                    const deltaY = e.clientY - dragStart.y;
                    setChartOffset({ x: chartOffset.x + deltaX, y: chartOffset.y + deltaY });
                    setDragStart({ x: e.clientX, y: e.clientY });
                }}
                onMouseUp={() => setIsDragging(false)}
                onMouseLeave={() => setIsDragging(false)}
                style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
            >
                <div
                    style={{
                        height: '750px',
                        width: '100%',
                        transform: `translate(${chartOffset.x}px, ${chartOffset.y}px)`,
                        transition: isDragging ? 'none' : 'transform 0.1s',
                    }}
                >
                    <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />
                </div>
                {/* Linea arancione orizzontale (Spot) */}
                {currentSpot != null && spotIndex >= 0 && (
                    <div
                        className="absolute w-full h-px bg-gradient-to-r from-transparent via-orange-500 to-transparent pointer-events-none"
                        style={{
                            top: `${spotYPercent}%`,
                            transform: `translateY(-50%) translate(${chartOffset.x}px, ${chartOffset.y}px)`,
                        }}
                    />
                )}

                {/* Range Lines */}
                {ranges && strikeMax > strikeMin && (
                    <>
                        {[
                            { val: ranges.r1Up, bgColor: '#ef4444' },
                            { val: ranges.r1Down, bgColor: '#ef4444' },
                            { val: ranges.r2Up, bgColor: '#eab308' },
                            { val: ranges.r2Down, bgColor: '#eab308' },
                            { val: ranges.r3Up, bgColor: '#a855f7' },
                            { val: ranges.r3Down, bgColor: '#a855f7' },
                        ].map((range, idx) => {
                            const pct = 100 - ((range.val - strikeMin) / (strikeMax - strikeMin)) * 100;
                            return (
                                <div key={idx} className="absolute w-full h-px pointer-events-none" style={{
                                    top: `${pct}%`,
                                    backgroundImage: `linear-gradient(to right, transparent, ${range.bgColor}, transparent)`,
                                    opacity: 0.5,
                                    transform: `translate(${chartOffset.x}px, ${chartOffset.y}px)`,
                                }} />
                            );
                        })}
                    </>
                )}

                {/* Overlay label con prezzo SPX */}
                {currentSpot != null && spotIndex >= 0 && (
                    <div
                        className="absolute left-2 bg-orange-500/10 border border-orange-500/50 rounded px-3 py-1 text-xs text-orange-400 font-bold pointer-events-none"
                        style={{
                            top: `${spotYPercent}%`,
                            transform: `translateY(-50%) translate(${chartOffset.x}px, ${chartOffset.y}px)`,
                        }}
                    >
                        SPX {currentSpot.toFixed(2)}
                    </div>
                )}
            </div>

            <p className="mt-2 text-[11px] text-slate-500">
                DEX: buy/sell (net call/put volume) | Gamma: exposure ($Bn/1%) | Volume: call/put delta-adjusted (K) | Linea arancione = spot price
            </p>

            {/* Modal Info */}
            {showTheory && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowTheory(false)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-2xl max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
                        <h2 className="text-xl font-bold text-blue-400 mb-4">Metriche OOK</h2>

                        <div className="space-y-4 text-sm text-slate-300">
                            <div>
                                <h3 className="text-green-400 font-semibold mb-1">DEX Profile (Dealer Exposure)</h3>
                                <p>Mostra il net volume call/put ponderato. Verde = call dominanti (dealer compra), Viola = put dominanti (dealer vende). Misura lo squilibrio immediato tra buyer e seller.</p>
                            </div>

                            <div>
                                <h3 className="text-blue-400 font-semibold mb-1">Gamma Profile</h3>
                                <p>Convessità netta della posizione. Blu = gamma positivo (dealer lungo, accelerazione), Arancione = gamma negativo (dealer corto, decelerazione). Misurato in $Miliardi per 1% movimento SPX.</p>
                            </div>

                            <div>
                                <h3 className="text-emerald-400 font-semibold mb-1">Volume Δ (Delta-Adjusted)</h3>
                                <p>Volume call ponderato per delta call MENO volume put ponderato per delta put. Verde = dominanza call, Rosso = dominanza put. Usa Black-Scholes con volatilità 0DTE ~60%.</p>
                            </div>

                            <div>
                                <h3 className="text-orange-400 font-semibold mb-1">Linea Arancione</h3>
                                <p>Spot price SPX attuale. I range R1/R2/R3 sono calcolati dal Range Calc e mostrano i livelli di targeting dall'ATM straddle.</p>
                            </div>

                            <div>
                                <h3 className="text-yellow-400 font-semibold mb-1">Delta (Black-Scholes)</h3>
                                <p>Stimato usando la formula di Black-Scholes con time-to-expiry di 1 giorno (0DTE) e IV approssimata 60%. ATM ≈ 0.5 call, ATM ≈ -0.5 put.</p>
                            </div>

                            <div className="text-xs text-slate-500 mt-6 pt-4 border-t border-slate-700">
                                <p>Basato su dati IBKR TWS. Aggiornamento ogni 5 secondi durante la sessione di trading.</p>
                            </div>
                        </div>

                        <button
                            onClick={() => setShowTheory(false)}
                            className="mt-4 w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm font-semibold transition-colors"
                        >
                            Chiudi
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
