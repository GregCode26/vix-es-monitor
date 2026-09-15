'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false }) as any;

interface VolumePoint {
    strike: number;
    calls?: number;
    puts?: number;
    volume?: number;
}

interface VolumeSnapshot {
    time: string;
    volumes: VolumePoint[];
    spxPrice?: number | null;
    isOpening?: boolean;
}

function build3DOption(
    strikes: number[],
    times: string[],
    data3D: number[][],
    title: string,
    colorRange: string[],
    maxVol: number,
    savedViewControl: any,
    spxPathIndices: number[] | null
) {
    const series: any[] = [{
        type: 'bar3D',
        data: data3D,
        shading: 'lambert',
        barSize: Math.max(2, Math.min(15, 200 / strikes.length)),
        emphasis: {
            itemStyle: { color: '#ffff00' }
        }
    }];

    // Add a dynamic line tracing the SPX price over time
    if (spxPathIndices && spxPathIndices.length > 0) {
        const linePoints: any[] = [];
        for (let i = 0; i < times.length; i++) {
            const strikeIdx = spxPathIndices[i] ?? -1;
            if (strikeIdx >= 0) {
                // Find all volume data points at this specific time step i
                const pointsAtTime = data3D.filter(item => item[1] === i);
                let height = 0;
                if (pointsAtTime.length > 0) {
                    // Height is set to the volume of the closest strike that has the largest volume at this time step
                    const vols = pointsAtTime.map(item => item[2]);
                    height = Math.max(...vols);
                }
                // We add a tiny multiplier (1.02) so the line floats just above the highest bar at this time step
                linePoints.push([strikeIdx, i, height > 0 ? height * 1.02 : 10]);
            }
        }

        if (linePoints.length > 0) {
            series.push({
                type: 'line3D',
                data: linePoints,
                lineStyle: {
                    width: 4,
                    color: '#ffff00' // Bright yellow for the SPX price path
                }
            });
        }
    }

    const grid3D: any = {
        boxWidth: 200,
        boxDepth: 140,
        boxHeight: 80,
        environment: '#0c0d10',
        light: {
            main: { intensity: 1.4, shadow: true },
            ambient: { intensity: 0.4 }
        },
        viewControl: savedViewControl ? savedViewControl : {
            autoRotate: false,
            alpha: 20,
            beta: -30,
            distance: 300
        }
    };

    return {
        tooltip: {
            formatter: (params: any) => {
                if (params.seriesType === 'line3D') {
                    const timeIdx = params.value[1];
                    const strike = strikes[params.value[0]];
                    return `<b>SPX TRACE</b><br/>Time: ${times[timeIdx]}<br/>Strike: ${strike}`;
                }
                const strike = strikes[params.value[0]];
                const time = times[params.value[1]];
                const vol = params.value[2];
                return `<b>${title}</b><br/>Strike: <b>${strike}</b><br/>Time: ${time}<br/>Volume: <b>${vol.toLocaleString()}</b>`;
            }
        },
        visualMap: {
            show: false,
            dimension: 1, // color by time index
            seriesIndex: 0, // Only color the bar3D series, leaving line3D white
            min: 0,
            max: Math.max(1, times.length - 1),
            inRange: {
                color: colorRange
            }
        },
        xAxis3D: {
            type: 'category',
            data: strikes.map(String),
            name: 'Strike',
            nameTextStyle: { color: '#cbd5e1', fontSize: 12 },
            axisLabel: { 
                color: '#94a3b8',
                fontSize: 10, 
                interval: Math.max(0, Math.floor(strikes.length / 15))
            },
            axisLine: { lineStyle: { color: '#475569' } },
            splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.15)' } }
        },
        yAxis3D: {
            type: 'category',
            data: times,
            inverse: true,
            name: 'Time →',
            nameTextStyle: { color: '#cbd5e1', fontSize: 12 },
            axisLabel: { color: '#94a3b8', fontSize: 9, interval: Math.max(0, Math.floor(times.length / 8)) },
            axisLine: { lineStyle: { color: '#475569' } },
            splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.15)' } }
        },
        zAxis3D: {
            type: 'value',
            name: 'Volume',
            max: maxVol > 0 ? Math.ceil(maxVol * 1.1) : undefined,
            nameTextStyle: { color: '#cbd5e1', fontSize: 12 },
            axisLabel: { 
                color: '#94a3b8', 
                fontSize: 10,
                formatter: (v: number) => v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v)
            },
            axisLine: { lineStyle: { color: '#475569' } },
            splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.15)' } }
        },
        grid3D: grid3D,
        series: series
    };
}

// Quanti snapshot disegnare, a 10 s l'uno. Ora che il trasporto e' incrementale
// il browser ha in memoria l'intera sessione: quanta mostrarne e' solo una
// questione di quanti bar3D regge echarts-gl (~37 barre per snapshot).
const WINDOW_OPTIONS = [
    { label: '16 min', value: 100 },
    { label: '1 ora', value: 360 },
    { label: '3 ore', value: 1080 },
    { label: 'Sessione', value: 0 },
];

export default function SpxVolumesPage() {
    const router = useRouter();
    const [history, setHistory] = useState<VolumeSnapshot[]>([]);
    const [windowSize, setWindowSize] = useState(360);
    const [chartsReady, setChartsReady] = useState(false);
    
    // Core references
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const callChartRef = useRef<any>(null);
    const putChartRef = useRef<any>(null);
    const savedCallView = useRef<any>(null);
    const savedPutView = useRef<any>(null);
    // Ultimo snapshot gia' in memoria: la route restituisce solo i successivi.
    const lastTimeRef = useRef<string | null>(null);
    const sessionDateRef = useRef<string | null>(null);

    const fetchData = async () => {
        try {
            const since = lastTimeRef.current;
            const url = since ? `/api/volumes?since=${encodeURIComponent(since)}` : '/api/volumes';
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();

                // Cambio di giornata: si riparte da zero, senza `since`.
                if (data.date && sessionDateRef.current && data.date !== sessionDateRef.current) {
                    sessionDateRef.current = data.date;
                    lastTimeRef.current = null;
                    setHistory([]);
                    return;
                }
                if (data.date) sessionDateRef.current = data.date;

                if (data.history) {
                    // Pre-capture user's current camera angles before setting new history
                    if (callChartRef.current) {
                        try {
                            const inst = callChartRef.current.getEchartsInstance();
                            const opt = inst.getOption() as any;
                            if (opt?.grid3D?.[0]?.viewControl) {
                                savedCallView.current = opt.grid3D[0].viewControl;
                            }
                        } catch (err) {}
                    }
                    if (putChartRef.current) {
                        try {
                            const inst = putChartRef.current.getEchartsInstance();
                            const opt = inst.getOption() as any;
                            if (opt?.grid3D?.[0]?.viewControl) {
                                savedPutView.current = opt.grid3D[0].viewControl;
                            }
                        } catch (err) {}
                    }

                    // Update memory with new snapshots
                    const incoming: VolumeSnapshot[] = data.history;
                    if (incoming.length > 0) {
                        lastTimeRef.current = incoming[incoming.length - 1].time;
                    }
                    if (since) {
                        // Risposta incrementale: si accoda, non si sostituisce.
                        if (incoming.length > 0) setHistory(prev => [...prev, ...incoming]);
                    } else {
                        setHistory(incoming);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to fetch volumes', e);
        }
    };

    useEffect(() => {
        let active = true;

        const loadCharts = async () => {
            await import('echarts-gl');
            if (active) {
                setChartsReady(true);
            }
        };

        loadCharts();
        fetchData();
        intervalRef.current = setInterval(fetchData, 30000);
        return () => {
            active = false;
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, []);

    const { strikes, times, callsData, putsData, maxCallVol, maxPutVol, spxPathIndices } = useMemo(() => {
        // I volumi sono cumulati dall'apertura: il grafico mostra il delta
        // rispetto al primo snapshot *visibile*, quindi la finestra definisce
        // anche la baseline. Era il comportamento di prima, con la finestra
        // fissata a 100 snapshot dal poller.
        const visible = windowSize > 0 ? history.slice(-windowSize) : history;

        const timesArr: string[] = [];
        const strikesSet = new Set<number>();
        let openSPX: number | null = null;

        visible.forEach(snapshot => {
            timesArr.push(snapshot.time);
            if (snapshot.isOpening && snapshot.spxPrice) {
                openSPX = snapshot.spxPrice;
            }
            snapshot.volumes.forEach(v => strikesSet.add(v.strike));
        });

        const strikesArr = Array.from(strikesSet).sort((a, b) => a - b);
        
        // Find the index of the strike closest to the SPX price at EACH time step
        const spxPathIndices: number[] = visible.map(snapshot => {
            if (!snapshot.spxPrice) return -1;
            let minDiff = Infinity;
            let closestIdx = -1;
            strikesArr.forEach((s, idx) => {
                const diff = Math.abs(s - snapshot.spxPrice!);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIdx = idx;
                }
            });
            return closestIdx;
        });

        const callsData3D: number[][] = [];
        const putsData3D: number[][] = [];
        let maxC = 0;
        let maxP = 0;
        
        const initialCallVol = new Map<number, number>();
        const initialPutVol = new Map<number, number>();

        visible.forEach((snapshot, timeIndex) => {
            snapshot.volumes.forEach(v => {
                const strikeIndex = strikesArr.indexOf(v.strike);
                if (strikeIndex === -1) return;

                const rawCallVol = v.calls ?? v.volume ?? 0;
                const rawPutVol = v.puts ?? 0;
                
                if (!initialCallVol.has(v.strike)) initialCallVol.set(v.strike, rawCallVol);
                if (!initialPutVol.has(v.strike)) initialPutVol.set(v.strike, rawPutVol);

                const callVol = Math.max(0, rawCallVol - initialCallVol.get(v.strike)!);
                const putVol = Math.max(0, rawPutVol - initialPutVol.get(v.strike)!);

                if (callVol > 0) {
                    callsData3D.push([strikeIndex, timeIndex, callVol]);
                    if (callVol > maxC) maxC = callVol;
                }
                if (putVol > 0) {
                    putsData3D.push([strikeIndex, timeIndex, putVol]);
                    if (putVol > maxP) maxP = putVol;
                }
            });
        });

        return {
            strikes: strikesArr.length > 0 ? strikesArr : [6000],
            times: timesArr.length > 0 ? timesArr : ['--:--'],
            callsData: callsData3D,
            putsData: putsData3D,
            maxCallVol: maxC,
            maxPutVol: maxP,
            spxPathIndices
        };
    }, [history, windowSize]);


    const callColors = ['#ffffff', '#e0c3fc', '#c084fc', '#a855f7', '#7c3aed', '#5b21b6', '#3b0764'];
    const putColors = ['#ffffff', '#fcd6e0', '#f472b6', '#ec4899', '#be185d', '#9d174d', '#500724'];

    // Notice we inject the explicitly saved camera view instances!
    const callOption = build3DOption(strikes, times, callsData, 'CALLS', callColors, maxCallVol, savedCallView.current, spxPathIndices);
    const putOption = build3DOption(strikes, times, putsData, 'PUTS', putColors, maxPutVol, savedPutView.current, spxPathIndices);

    const lastTime = times.length > 1 ? times[times.length - 1] : null;
    const snapshotCount = history.length;

    return (
        <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-3 md:p-5 font-sans">
            <div className="w-full max-w-[1920px] mx-auto">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-fuchsia-400 bg-clip-text text-transparent">
                            SPX 3D Volumes
                        </h1>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-green-500/20 text-green-400 border-green-500/30">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            LIVE
                        </span>
                        {lastTime && (
                            <span className="text-slate-500 text-xs">Last: {lastTime} ({snapshotCount} snaps)</span>
                        )}
                        <div className="flex items-center gap-1">
                            {WINDOW_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    onClick={() => setWindowSize(opt.value)}
                                    className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                                        windowSize === opt.value
                                            ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                                            : 'bg-slate-800/60 text-slate-500 border-slate-700 hover:text-slate-300'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <button
                        onClick={() => router.push('/market')}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs transition-colors"
                    >
                        CHART
                    </button>
                </div>

                {chartsReady && history.length > 0 ? (
                    <div className="flex flex-col md:flex-row gap-3">
                        {/* PUTS */}
                        <div className="flex-1 bg-[#0c0d10] border border-pink-900/40 rounded-xl p-2 shadow-2xl w-full">
                            <div className="flex items-center gap-2 px-3 py-1">
                                <span className="text-xs font-bold text-pink-400 tracking-widest">◀ PUTS</span>
                                <div className="flex-1 h-px bg-gradient-to-r from-pink-500/40 to-transparent" />
                            </div>
                            <div className="h-[calc(100vh-110px)] min-h-[500px]">
                                <ReactECharts
                                    ref={putChartRef}
                                    option={putOption}
                                    style={{ height: '100%', width: '100%' }}
                                    notMerge={true}
                                />
                            </div>
                        </div>

                        {/* CALLS */}
                        <div className="flex-1 bg-[#0c0d10] border border-purple-900/40 rounded-xl p-2 shadow-2xl w-full">
                            <div className="flex items-center gap-2 px-3 py-1">
                                <span className="text-xs font-bold text-purple-400 tracking-widest">CALLS ▶</span>
                                <div className="flex-1 h-px bg-gradient-to-l from-purple-500/40 to-transparent" />
                            </div>
                            <div className="h-[calc(100vh-110px)] min-h-[500px]">
                                <ReactECharts
                                    ref={callChartRef}
                                    option={callOption}
                                    style={{ height: '100%', width: '100%' }}
                                    notMerge={true}
                                />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="bg-[#0c0d10] border border-slate-800/80 rounded-xl flex items-center justify-center h-[calc(100vh-100px)]">
                        <div className="text-center">
                            <div className="w-12 h-12 border-4 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mx-auto mb-4" />
                            <p className="text-slate-400 text-sm">
                                {chartsReady ? 'Waiting for option volume data...' : 'Loading 3D chart engine...'}<br />
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
