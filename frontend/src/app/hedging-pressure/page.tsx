'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface HedgingPressureRow {
    strike: number;
    gex: number;
    vanna: number | null;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
    normalizedPressure: number;
    proximity: number;
}

interface RiskZone {
    strike: number;
    riskLevel: 'high' | 'medium' | 'low';
    reason: string[];
    pressure: number;
}

interface HedgingPressureResponse {
    date: string;
    time: string | null;
    spot: number;
    atmStrike: number | null;
    atmIv: number; // as percentage
    spotDelta: number;
    ivChange: number; // in basis points
    profile: HedgingPressureRow[];
    riskZones: RiskZone[];
    strikes: number[];
}

const REFRESH_MS = 15000;

type ViewMode = 'profile' | 'timeseries' | 'heatmap';

interface PressureHistoryPoint {
    time: string;
    strike: number;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
}

interface HedgingPressureResponseWithHistory extends HedgingPressureResponse {
    pressureHistory?: PressureHistoryPoint[];
}

export default function HedgingPressurePage() {
    const router = useRouter();
    const [data, setData] = useState<HedgingPressureResponseWithHistory | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showDebug, setShowDebug] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('profile');
    const lastTime = useRef<string | null>(null);
    const giornoSessione = useRef<string | null>(null);

    const fetchHedgingPressure = useCallback(async () => {
        try {
            const res = await fetch('/api/hedging-pressure', { cache: 'no-store' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Caricamento fallito');
            }
            const json = (await res.json()) as HedgingPressureResponse;

            // Cambio di giornata: si riparte da zero
            if (json.date && giornoSessione.current && json.date !== giornoSessione.current) {
                giornoSessione.current = json.date;
                lastTime.current = null;
                setData(null);
                setError(null);
                return;
            }
            if (json.date) giornoSessione.current = json.date;

            setData(json);
            setError(null);
            setLoading(false);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Errore');
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchHedgingPressure();
        const id = setInterval(fetchHedgingPressure, REFRESH_MS);
        return () => clearInterval(id);
    }, [fetchHedgingPressure]);

    // Prepara i dati per il grafico
    const chartData = useMemo(() => {
        if (!data || data.profile.length === 0) return null;

        const profile = data.profile;

        // Ordina per strike e costruisci array paralleli
        const sortedProfile = [...profile].sort((a, b) => a.strike - b.strike);
        const posData: number[] = [];
        const negData: number[] = [];

        for (const row of sortedProfile) {
            const normalized = row.normalizedPressure;
            if (normalized > 0) {
                posData.push(normalized);
                negData.push(0);
            } else if (normalized < 0) {
                posData.push(0);
                negData.push(normalized); // Mantieni negativo per echarts
            } else {
                posData.push(0);
                negData.push(0);
            }
        }

        return { posData, negData, profile: sortedProfile };
    }, [data]);

    // Calcola scale e limiti
    const scale = useMemo(() => {
        if (!data || data.profile.length === 0) return null;

        const strikes = data.profile.map((r) => r.strike);
        const pressures = data.profile.map((r) => Math.abs(r.normalizedPressure));

        const minStrike = Math.min(...strikes);
        const maxStrike = Math.max(...strikes);
        const maxPressure = Math.max(...pressures, 1);

        return {
            yMin: Math.floor((minStrike - 5) / 5) * 5,
            yMax: Math.ceil((maxStrike + 5) / 5) * 5,
            xMax: Math.ceil(maxPressure * 1.1),
        };
    }, [data]);

    // Opzione echarts per il grafico time-series (gamma vs vanna)
    const timeseriesOption = useMemo(() => {
        if (!data || !data.pressureHistory || data.pressureHistory.length === 0) {
            return {
                backgroundColor: '#0c0d10',
                title: { text: 'Nessun dato storico disponibile', left: 'center', textStyle: { color: '#94a3b8' } },
            };
        }

        const groupedByStrike: Record<number, { time: string[]; total: number[] }> = {};

        for (const point of data.pressureHistory) {
            if (!groupedByStrike[point.strike]) {
                groupedByStrike[point.strike] = { time: [], total: [] };
            }
            groupedByStrike[point.strike].time.push(point.time);
            groupedByStrike[point.strike].total.push(point.totalPressure);
        }

        const series = Object.entries(groupedByStrike)
            .slice(0, 5) // Top 5 strikes only
            .map(([strike, d]) => {
                const lineData = d.time.map((t, i) => [t, d.total[i]]);
                return {
                    name: `Strike ${strike}`,
                    type: 'line' as const,
                    data: lineData,
                    smooth: true,
                    symbolSize: 3,
                    lineStyle: { width: 2 },
                };
            });

        return {
            backgroundColor: '#0c0d10',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
            },
            legend: {
                data: Object.keys(groupedByStrike).map((k) => `K${k}`),
                textStyle: { color: '#94a3b8', fontSize: 9 },
                top: 10,
                right: 10,
                orient: 'vertical',
                max: 8,
            },
            grid: {
                left: 60,
                right: 40,
                top: 50,
                bottom: 40,
            },
            xAxis: {
                type: 'time',
                name: 'Time',
                nameLocation: 'center',
                nameGap: 30,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12 },
                axisLabel: { color: '#94a3b8', formatter: '{HH}:{mm}' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            yAxis: {
                type: 'value',
                name: 'Gamma Pressure',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 11 },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
                axisPointer: { type: 'line' },
            },
            series,
        };
    }, [data]);

    // Opzione echarts per heatmap (pressione per strike nel tempo)
    const heatmapOption = useMemo(() => {
        if (!data || !data.pressureHistory || data.pressureHistory.length === 0) return {};

        // Group by strike and create heatmap data
        const heatmapData: [number, number, number][] = []; // [time_index, strike, pressure]
        const timeIndex: Record<string, number> = {};
        const uniqueTimes: string[] = [];
        const uniqueStrikes = Array.from(new Set(data.pressureHistory.map((p) => p.strike))).sort((a, b) => a - b);

        // Build time index
        for (const point of data.pressureHistory) {
            if (!(point.time in timeIndex)) {
                timeIndex[point.time] = uniqueTimes.length;
                uniqueTimes.push(point.time);
            }
        }

        // Build heatmap data
        for (const point of data.pressureHistory) {
            const timeIdx = timeIndex[point.time];
            const strikeIdx = uniqueStrikes.indexOf(point.strike);
            heatmapData.push([timeIdx, strikeIdx, Math.round(point.totalPressure * 10) / 10]);
        }

        return {
            backgroundColor: '#0c0d10',
            tooltip: { position: 'top' },
            grid: {
                left: 60,
                right: 40,
                top: 50,
                bottom: 40,
            },
            xAxis: {
                type: 'category',
                data: uniqueTimes,
                name: 'Time',
                nameLocation: 'center',
                nameGap: 30,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12 },
                axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (val: string) => val.split(':').slice(0, 2).join(':') },
                splitLine: { show: false },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            yAxis: {
                type: 'category',
                data: uniqueStrikes,
                name: 'Strike',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12 },
                axisLabel: { color: '#94a3b8', fontSize: 8 },
                splitLine: { show: false },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            visualMap: {
                min: -100,
                max: 100,
                calculable: true,
                orient: 'vertical',
                right: 10,
                top: 50,
                inRange: {
                    color: ['#ef4444', '#f97316', '#fbbf24', '#e5e7eb', '#93c5fd', '#3b82f6'],
                },
                textStyle: { color: '#94a3b8', fontSize: 9 },
            },
            series: [
                {
                    name: 'Hedging Pressure',
                    type: 'heatmap',
                    data: heatmapData,
                    cellSize: ['auto', 20],
                    emphasis: {
                        itemStyle: {
                            borderColor: '#fff',
                            borderWidth: 1,
                        },
                    },
                },
            ],
        };
    }, [data]);

    // Opzione echarts per il grafico profile (barre)
    const option = useMemo(() => {
        if (!chartData || !scale || !data) return {};

        const markLines: Record<string, unknown>[] = [];

        // Trova lo strike più vicino allo spot per disegnare la linea
        let closestStrike: string | null = null;
        if (data.spot != null && chartData.profile.length > 0) {
            let minDistance = Math.abs(chartData.profile[0].strike - data.spot);
            closestStrike = chartData.profile[0].strike.toString();

            for (let i = 1; i < chartData.profile.length; i++) {
                const distance = Math.abs(chartData.profile[i].strike - data.spot);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestStrike = chartData.profile[i].strike.toString();
                }
            }

            if (closestStrike) {
                markLines.push({
                    yAxis: closestStrike,
                    lineStyle: { color: '#06b6d4', type: 'dotted', width: 2.5 },
                    label: {
                        formatter: `Spot ${data.spot.toFixed(2)}`,
                        position: 'end',
                        color: '#06b6d4',
                    },
                });
            }
        }

        // ATM
        if (data.atmStrike != null) {
            markLines.push({
                yAxis: data.atmStrike.toString(),
                lineStyle: { color: '#8b5cf6', type: 'dashed', width: 1.5 },
                label: {
                    formatter: `ATM ${data.atmStrike}`,
                    position: 'start',
                    color: '#8b5cf6',
                },
            });
        }

        return {
            backgroundColor: '#0c0d10',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                formatter: (params: any) => {
                    if (!Array.isArray(params) || params.length === 0) return '';
                    const param = params[0];
                    const strike = param.value[1];
                    const row = chartData.profile.find((r) => r.strike === strike);
                    if (!row) return '';

                    return `
<div style="color: #e2e8f0; font-size: 11px;">
  <div><strong>Strike:</strong> ${row.strike}</div>
  <div><strong>Pressure:</strong> ${row.normalizedPressure}</div>
  <div><strong>Gamma:</strong> ${row.gammaPressure.toFixed(2)}</div>
  <div><strong>Vanna Proxy:</strong> ${row.vannaPressure ? row.vannaPressure.toFixed(2) : 'N/A'}</div>
  <div><strong>GEX:</strong> ${row.gex.toFixed(2)}</div>
  <div><strong>Proximity:</strong> ${(row.proximity * 100).toFixed(0)}%</div>
</div>
`.trim();
                },
            },
            legend: {
                data: ['Bullish Pressure', 'Bearish Pressure', 'Zero Line'],
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
                right: 40,
                top: 50,
                bottom: 40,
            },
            xAxis: {
                type: 'value',
                min: -scale.xMax,
                max: scale.xMax,
                name: 'Hedging Pressure (normalized)',
                nameLocation: 'center',
                nameGap: 30,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
                axisPointer: { type: 'line' },
            },
            yAxis: {
                type: 'category',
                data: data.strikes.map((s) => s.toString()),
                name: 'Strike',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            series: [
                {
                    name: 'Bullish Pressure',
                    type: 'bar',
                    data: chartData.posData,
                    itemStyle: { color: '#3b82f6', opacity: 0.85 },
                    barWidth: '60%',
                    markLine: {
                        symbol: 'none',
                        data: markLines,
                        lineStyle: { width: 2 },
                    },
                },
                {
                    name: 'Bearish Pressure',
                    type: 'bar',
                    data: chartData.negData,
                    itemStyle: { color: '#ef4444', opacity: 0.85 },
                    barWidth: '60%',
                },
            ],
        };
    }, [chartData, scale, data]);

    const pronto = data !== null && !loading;

    return (
        <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
            <div className="w-full max-w-[1920px] mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">
                            Hedging Pressure e Accelerazione
                        </h1>
                        {data?.time && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-blue-500/20 text-blue-400 border-blue-500/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                                LIVE {data.time}
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2 items-center">
                        <div className="flex rounded-lg overflow-hidden border border-slate-700">
                            {(['profile', 'timeseries', 'heatmap'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => setViewMode(mode)}
                                    className={`px-2.5 py-1.5 text-xs transition-colors ${
                                        viewMode === mode
                                            ? 'bg-blue-600/30 text-blue-300'
                                            : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
                                    }`}
                                >
                                    {mode === 'profile' ? 'Profilo' : mode === 'timeseries' ? 'Serie Temporali' : 'Mappa Calore'}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowInfo(!showInfo)}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                            title="Come leggere questo indicatore"
                        >
                            ℹ️ Guida
                        </button>
                        <button
                            onClick={() => setShowDebug(!showDebug)}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            {showDebug ? 'Nascondi Debug' : 'Debug'}
                        </button>
                        <button
                            onClick={() => router.push('/spx-gamma')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            Profilo GEX
                        </button>
                        <button
                            onClick={() => router.push('/market')}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                        >
                            Monitor di Mercato
                        </button>
                    </div>
                </div>

                {/* Key Metrics */}
                {data && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
                        <div className="bg-slate-800/50 border border-slate-700 p-2 rounded-lg">
                            <div className="text-[10px] text-slate-500">Spot</div>
                            <div className="text-lg font-bold text-cyan-400">{data.spot.toFixed(2)}</div>
                        </div>
                        <div className="bg-slate-800/50 border border-slate-700 p-2 rounded-lg">
                            <div className="text-[10px] text-slate-500">IV ATM</div>
                            <div className="text-lg font-bold text-purple-400">{data.atmIv.toFixed(1)}%</div>
                        </div>
                        <div className={`bg-slate-800/50 border p-2 rounded-lg ${data.spotDelta >= 0 ? 'border-green-700' : 'border-red-700'}`}>
                            <div className="text-[10px] text-slate-500">Spot Δ</div>
                            <div className={`text-lg font-bold ${data.spotDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {data.spotDelta >= 0 ? '+' : ''}{data.spotDelta.toFixed(2)}
                            </div>
                        </div>
                        <div className={`bg-slate-800/50 border p-2 rounded-lg ${data.ivChange >= 0 ? 'border-green-700' : 'border-red-700'}`}>
                            <div className="text-[10px] text-slate-500">IV Δ</div>
                            <div className={`text-lg font-bold ${data.ivChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {data.ivChange >= 0 ? '+' : ''}{data.ivChange.toFixed(0)} bps
                            </div>
                        </div>
                        <div className="bg-slate-800/50 border border-slate-700 p-2 rounded-lg">
                            <div className="text-[10px] text-slate-500">Zone di Rischio</div>
                            <div className="text-lg font-bold text-amber-400">{data.riskZones.length}</div>
                        </div>
                    </div>
                )}

                {/* Main Chart */}
                {error && (
                    <div className="text-amber-300 bg-amber-950/30 border border-amber-900/50 p-2 rounded text-xs mb-2">
                        ⚠️ {error}
                    </div>
                )}

                <div className="bg-[#0c0d10] border border-slate-800/80 rounded-xl p-2 shadow-2xl w-full mb-3">
                    <div className="h-[calc(100vh-300px)] min-h-[600px]">
                        {pronto ? (
                            <ReactECharts
                                option={viewMode === 'profile' ? option : viewMode === 'timeseries' ? timeseriesOption : heatmapOption}
                                style={{ height: '100%', width: '100%' }}
                                notMerge={true}
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-slate-500">
                                {error ? (
                                    <span>Impossibile caricare i dati di hedging pressure.</span>
                                ) : (
                                    <>
                                        <div className="w-12 h-12 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                                        <span>Caricamento dati di hedging pressure...</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Debug Panel */}
                {showDebug && data && (
                    <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 mb-3">
                        <h3 className="text-sm font-bold text-blue-400 mb-2">Informazioni di Debug</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div>
                                <div className="text-slate-500">Data</div>
                                <div className="font-mono text-slate-300">{data.date}</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Spot</div>
                                <div className="font-mono text-slate-300">{data.spot.toFixed(2)}</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Strike ATM</div>
                                <div className="font-mono text-slate-300">{data.atmStrike ?? 'N/A'}</div>
                            </div>
                            <div>
                                <div className="text-slate-500">IV ATM</div>
                                <div className="font-mono text-slate-300">{data.atmIv.toFixed(2)}%</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Delta Spot</div>
                                <div className="font-mono text-slate-300">{data.spotDelta.toFixed(4)}</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Cambio IV</div>
                                <div className="font-mono text-slate-300">{data.ivChange.toFixed(2)} bps</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Strike Totali</div>
                                <div className="font-mono text-slate-300">{data.profile.length}</div>
                            </div>
                            <div>
                                <div className="text-slate-500">Zone di Rischio</div>
                                <div className="font-mono text-slate-300">{data.riskZones.length}</div>
                            </div>
                        </div>

                        {data.riskZones.length > 0 && (
                            <div className="mt-3">
                                <div className="text-slate-400 text-xs mb-2">Zone di Rischio:</div>
                                <div className="space-y-1 max-h-32 overflow-y-auto">
                                    {data.riskZones.map((zone) => (
                                        <div key={zone.strike} className="text-[10px] text-slate-400 bg-slate-800/30 p-1.5 rounded">
                                            <div className="font-mono">
                                                Strike {zone.strike} ({zone.riskLevel}): {zone.pressure.toFixed(1)} | {zone.reason.join(', ')}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Info Modal */}
                {showInfo && (
                    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
                        <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-2xl max-h-[80vh] overflow-y-auto">
                            <div className="p-6">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-2xl font-bold text-blue-400">Come leggere la Hedging Pressure</h2>
                                    <button
                                        onClick={() => setShowInfo(false)}
                                        className="text-slate-400 hover:text-slate-200 text-2xl"
                                    >
                                        ✕
                                    </button>
                                </div>

                                <div className="space-y-4 text-slate-300 text-sm">
                                    <section>
                                        <h3 className="text-lg font-bold text-cyan-400 mb-2">📊 Cos'è questo indicatore?</h3>
                                        <p>
                                            La Hedging Pressure stima dove l'attività di hedging dei dealer può accelerare o decelerare i movimenti di mercato.
                                            Combina l'esposizione al gamma (GEX) con la vanna (interazione volatilità-delta) per mostrare le zone potenziali di hedging.
                                        </p>
                                    </section>

                                    <section>
                                        <h3 className="text-lg font-bold text-blue-400 mb-2">📈 Barre Blu (a destra) = Pressione Rialzista</h3>
                                        <p>
                                            I dealer stanno aggiungendo hedges al rialzo. Quando lo spot sale, aggiungono altri hedges per compensare. Questa pressione
                                            <strong> supporta il movimento rialzista</strong> (ammortizzato da gamma, non auto-amplificante).
                                        </p>
                                        <p className="text-slate-400 mt-1">Scenario: GEX positivo + spot in salita → dealer aggiungono hedges verso l'alto</p>
                                    </section>

                                    <section>
                                        <h3 className="text-lg font-bold text-red-400 mb-2">📉 Barre Rosse (a sinistra) = Pressione Ribassista</h3>
                                        <p>
                                            I dealer stanno aggiungendo hedges al ribasso. Quando lo spot scende, aggiungono altri hedges per compensare. Questa pressione
                                            <strong> può amplificare il movimento ribassista</strong> (accelerato da gamma negativo).
                                        </p>
                                        <p className="text-slate-400 mt-1">Scenario: GEX negativo + spot in calo → dealer costretti a vendere di più</p>
                                    </section>

                                    <section>
                                        <h3 className="text-lg font-bold text-amber-400 mb-2">⚡ Come tradare con questo indicatore</h3>
                                        <ul className="space-y-2 list-disc list-inside">
                                            <li>
                                                <strong>Barre ROSSE grandi:</strong> Zona potenziale di accelerazione. Se lo spot la raggiunge, aspettati un movimento deciso al ribasso.
                                            </li>
                                            <li>
                                                <strong>Barre BLU grandi:</strong> Zona di supporto. I rialzi possono stagnare o subire squeeze qui.
                                            </li>
                                            <li>
                                                <strong>GAMMA + VANNA allineati:</strong> Controlla il Debug mode. Quando entrambi puntano nella stessa direzione, la pressione è massima.
                                            </li>
                                            <li>
                                                <strong>Barre in decremento (Time Series):</strong> I dealer stanno liberando hedges. Il potenziale di reversal aumenta.
                                            </li>
                                        </ul>
                                    </section>

                                    <section>
                                        <h3 className="text-lg font-bold text-purple-400 mb-2">📐 Cosa significano i componenti</h3>
                                        <p>
                                            <strong>Componente Gamma:</strong> Movimento del prezzo × posizione gamma del dealer. Mostra la pressione di hedging dal movimento dello spot.
                                        </p>
                                        <p className="mt-2">
                                            <strong>Componente Vanna:</strong> Cambio di volatilità × sensibilità vega del dealer. Mostra la pressione di hedging dai cambi di IV.
                                        </p>
                                        <p className="mt-2">
                                            <strong>Proximity Weight:</strong> Gli strike lontani dallo spot hanno peso ridotto. Solo gli strike vicini contano immediatamente.
                                        </p>
                                    </section>

                                    <section>
                                        <h3 className="text-lg font-bold text-slate-400 mb-2">⚠️ Limitazioni</h3>
                                        <ul className="space-y-1 list-disc list-inside text-slate-400 text-xs">
                                            <li>Vanna è stimata, non osservata. Usa l'approssimazione di Black-Scholes.</li>
                                            <li>L'euristica del dealer (call long, put short) è standard, non confermata.</li>
                                            <li>Funziona meglio su strike liquidi vicini all'ATM.</li>
                                            <li>L'hedging reale può differire dalla pressione stimata.</li>
                                        </ul>
                                    </section>
                                </div>

                                <div className="mt-6 flex justify-end">
                                    <button
                                        onClick={() => setShowInfo(false)}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                                    >
                                        Chiudi
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Footer Info */}
                <p className="mt-2 text-[11px] text-slate-500">
                    La hedging pressure combina l'esposizione al gamma (GEX) e la copertura di vanna sulla volatilità lungo la catena di opzioni. Le barre si estendono a destra (pressione rialzista)
                    o a sinistra (pressione ribassista) in base all'attività di hedging stimata del dealer. Il peso di prossimità enfatizza gli strike vicini all'ATM. Le zone di rischio evidenziano
                    le aree dove gamma e vanna si allineano, suggerendo una potenziale accelerazione.
                </p>
            </div>
        </div>
    );
}
