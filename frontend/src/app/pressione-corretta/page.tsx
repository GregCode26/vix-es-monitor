'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/**
 * Pagina di prova (13/11/2026): la serie temporale di /hedging-pressure rifatta
 * con le correzioni (lati Lee-Ready, copertura in contratti ES, niente peso di
 * vicinanza, niente vanna), con accanto il delta ES di Bookmap per vedere se il
 * ribilanciamento previsto dei dealer compare davvero. Dati da /api/pressione-corretta.
 */

interface Corr { r: number; n: number }
interface Risposta {
    date: string; time: string | null; spot: number; gTot: number; cum: number; bookmap: boolean;
    correlazioni: {
        stessoMinuto: Corr | null; minutoDopo: Corr | null; spxStessoMinuto: Corr | null; alNettoDelPrezzo: Corr | null;
        mediaFlusso: number | null; mediaDelta: number | null;
    };
    minuti: { t: string; spx: number; gTot: number; flusso: number; cum: number; delta: number | null; es: number | null }[];
    strike: number[];
    linee: { strike: number; gAdesso: number; cum: number[]; g: number[] }[];
}

const COLORI = [
    '#60a5fa', '#f97316', '#34d399', '#f472b6', '#facc15', '#a78bfa', '#22d3ee', '#ef4444', '#a3e635', '#e879f9',
    '#2563eb', '#fdba74', '#059669', '#be185d', '#ca8a04', '#7c3aed', '#0e7490', '#fca5a5', '#65a30d', '#cbd5e1',
];
const AGGIORNA_MS = 30_000;
const fmt = (v: number, d = 0) => v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const oggi = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function Correlazione({ titolo, c, nota }: { titolo: string; c: Corr | null; nota: string }) {
    const colore = c == null ? 'text-slate-500' : Math.abs(c.r) >= 0.2 ? 'text-amber-300' : 'text-slate-200';
    return (
        <div className="bg-slate-900 border border-slate-800 rounded p-3" title={nota}>
            <div className="text-[11px] text-slate-400">{titolo}</div>
            <div className={`text-xl font-bold ${colore}`}>{c ? (c.r >= 0 ? '+' : '') + c.r.toFixed(2) : '—'}</div>
            <div className="text-[10px] text-slate-500">{c ? `${c.n} minuti` : 'servono ≥10 minuti con Bookmap'}</div>
        </div>
    );
}

function PressioneCorretta() {
    // ?date=YYYY-MM-DD apre direttamente un giorno passato.
    const chiesto = useSearchParams().get('date');
    const [giorno, setGiorno] = useState(chiesto && /^\d{4}-\d{2}-\d{2}$/.test(chiesto) ? chiesto : oggi());
    const [dati, setDati] = useState<Risposta | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [vista, setVista] = useState<'cum' | 'g'>('cum');

    const carica = useCallback(() => {
        const q = giorno === oggi() ? '' : `?date=${giorno}`;
        fetch(`/api/pressione-corretta${q}`, { cache: 'no-store' })
            .then(async (r) => {
                const d = await r.json();
                if (!r.ok) { setErrore(d.errore ?? `Errore ${r.status}`); return; }
                setDati(d); setErrore(null);
            })
            .catch((e) => setErrore(String(e)));
    }, [giorno]);

    useEffect(() => {
        carica();
        if (giorno !== oggi()) return;
        const id = setInterval(carica, AGGIORNA_MS);
        return () => clearInterval(id);
    }, [giorno, carica]);

    const opzioneLinee = useMemo(() => {
        if (!dati) return null;
        const tempi = dati.minuti.map((m) => m.t);
        return {
            backgroundColor: '#020617', animation: false,
            tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'cross', label: { backgroundColor: '#1e293b' } }, valueFormatter: (v: number) => (v == null ? '—' : fmt(v, 1)) },
            legend: { type: 'scroll', top: 0, textStyle: { color: '#cbd5e1', fontSize: 10 } },
            grid: { left: 70, right: 70, top: 40, bottom: 60 },
            xAxis: { type: 'category', data: tempi, axisLabel: { color: '#94a3b8' } },
            yAxis: [
                {
                    type: 'value', name: vista === 'cum' ? 'ES ribilanciati' : 'ES per punto SPX', nameTextStyle: { color: '#94a3b8' },
                    axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.35)' } },
                },
                { type: 'value', name: 'SPX', scale: true, position: 'right', axisLabel: { color: '#facc15' }, splitLine: { show: false } },
            ],
            dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8, textStyle: { color: '#94a3b8' } }],
            series: [
                ...dati.linee.map((l, i) => ({
                    name: `K${l.strike}`, type: 'line', showSymbol: false, data: vista === 'cum' ? l.cum : l.g,
                    lineStyle: { width: 1.3 }, color: COLORI[i % COLORI.length],
                })),
                {
                    name: 'Totale', type: 'line', showSymbol: false, color: '#ffffff', lineStyle: { width: 2.5 },
                    data: vista === 'cum' ? dati.minuti.map((m) => m.cum) : dati.minuti.map((m) => m.gTot),
                },
                { name: 'SPX', type: 'line', yAxisIndex: 1, showSymbol: false, color: '#facc15', lineStyle: { width: 1.5, type: 'dashed' }, data: dati.minuti.map((m) => m.spx) },
            ],
        };
    }, [dati, vista]);

    const opzioneFlusso = useMemo(() => {
        if (!dati) return null;
        return {
            backgroundColor: '#020617', animation: false,
            tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'cross', label: { backgroundColor: '#1e293b' } }, valueFormatter: (v: number) => (v == null ? '—' : fmt(v, 0)) },
            legend: { top: 0, textStyle: { color: '#cbd5e1', fontSize: 11 } },
            grid: { left: 70, right: 70, top: 36, bottom: 60 },
            xAxis: { type: 'category', data: dati.minuti.map((m) => m.t), axisLabel: { color: '#94a3b8' } },
            yAxis: [
                { type: 'value', name: 'previsto (ES)', nameTextStyle: { color: '#94a3b8' }, axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.35)' } } },
                { type: 'value', name: 'delta Bookmap', position: 'right', axisLabel: { color: '#22d3ee' }, splitLine: { show: false } },
            ],
            dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8, textStyle: { color: '#94a3b8' } }],
            series: [
                {
                    name: 'Ribilanciamento previsto dei dealer', type: 'bar',
                    data: dati.minuti.map((m) => ({ value: m.flusso, itemStyle: { color: m.flusso >= 0 ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)' } })),
                },
                { name: 'Delta aggressivo ES (Bookmap)', type: 'line', yAxisIndex: 1, showSymbol: false, color: '#22d3ee', lineStyle: { width: 1.2 }, data: dati.minuti.map((m) => m.delta) },
            ],
        };
    }, [dati]);

    const c = dati?.correlazioni;
    const btn = (attivo: boolean) => `px-3 py-1 text-xs font-bold rounded ${attivo ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
            <Link href="/hedging-pressure" className="text-xs text-cyan-400 hover:text-cyan-300">← Hedging pressure (serie originale)</Link>
            <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-bold tracking-wide mr-2">Pressione corretta <span className="text-xs font-normal text-amber-400 align-middle">in prova</span></h1>
                <input type="date" value={giorno} max={oggi()} onChange={(e) => { if (e.target.value) { setDati(null); setGiorno(e.target.value); } }}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm" />
                {dati && <span className="text-xs text-slate-400">ultimo snapshot {dati.time} · SPX {fmt(dati.spot, 2)}{giorno === oggi() ? ' · si aggiorna ogni 30 s' : ''}</span>}
            </div>

            {errore && <p className="mt-4 text-sm text-red-400">{errore}</p>}
            {!errore && !dati && <p className="mt-4 text-sm text-slate-400">Calcolo dal file dei volumi…</p>}

            {dati && c && (
                <>
                    <div className="mt-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                        <div className="bg-slate-900 border border-slate-800 rounded p-3" title="Somma su tutti gli strike di gamma × posizione dei dealer × 100 / 50">
                            <div className="text-[11px] text-slate-400">Gamma dei dealer adesso</div>
                            <div className={`text-xl font-bold ${dati.gTot < 0 ? 'text-orange-400' : 'text-sky-400'}`}>{fmt(dati.gTot)} ES/pt</div>
                            <div className="text-[10px] text-slate-500">{dati.gTot < 0 ? 'corti: comprano se SPX sale' : 'lunghi: vendono se SPX sale'}</div>
                        </div>
                        <div className="bg-slate-900 border border-slate-800 rounded p-3">
                            <div className="text-[11px] text-slate-400">Ribilanciato oggi (netto)</div>
                            <div className={`text-xl font-bold ${dati.cum >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(dati.cum)} ES</div>
                            <div className="text-[10px] text-slate-500">medio |previsto| {c.mediaFlusso != null ? fmt(c.mediaFlusso) : '—'} vs |delta| {c.mediaDelta != null ? fmt(c.mediaDelta) : '—'} ES/min</div>
                        </div>
                        <Correlazione titolo="Previsto vs delta, stesso minuto" c={c.stessoMinuto} nota="Pearson fra ribilanciamento previsto e delta aggressivo ES di Bookmap nello stesso minuto" />
                        <Correlazione titolo="Solo prezzo SPX vs delta" c={c.spxStessoMinuto} nota="Lo stesso confronto con la sola variazione di SPX del minuto: la base da battere" />
                        <Correlazione titolo="Previsto vs delta, al netto del prezzo" c={c.alNettoDelPrezzo} nota="Correlazione parziale: quello che il previsto aggiunge oltre al movimento di SPX. È il numero che conta." />
                        <Correlazione titolo="Previsto vs delta del minuto dopo" c={c.minutoDopo} nota="Se il ribilanciamento anticipasse il flusso ES, qui sarebbe positivo" />
                    </div>
                    {!dati.bookmap && <p className="mt-2 text-xs text-amber-400">Nessun file Bookmap per questo giorno: il confronto con il delta ES non c&apos;è.</p>}

                    <div className="mt-5 flex items-center gap-2">
                        <span className="text-sm font-semibold mr-2">Per strike (i 20 con più gamma dei dealer adesso)</span>
                        <button className={btn(vista === 'cum')} onClick={() => setVista('cum')}>ES ribilanciati cumulati</button>
                        <button className={btn(vista === 'g')} onClick={() => setVista('g')}>Gamma in ES per punto</button>
                    </div>
                    <div className="mt-2 h-[48vh] min-h-[360px] border border-slate-800 rounded-lg">
                        {opzioneLinee && <ReactECharts option={opzioneLinee} notMerge style={{ height: '100%', width: '100%' }} />}
                    </div>

                    <div className="mt-5 text-sm font-semibold">Ribilanciamento previsto per minuto contro il delta ES reale</div>
                    <div className="mt-2 h-[36vh] min-h-[300px] border border-slate-800 rounded-lg">
                        {opzioneFlusso && <ReactECharts option={opzioneFlusso} notMerge style={{ height: '100%', width: '100%' }} />}
                    </div>

                    <div className="mt-5 text-xs text-slate-400 leading-relaxed max-w-4xl space-y-1">
                        <p className="text-slate-300 font-semibold">Cosa cambia rispetto alla serie di /hedging-pressure</p>
                        <p>• <b>Posizione dei dealer dai lati Lee-Ready</b>: dealer = −((call comprate − vendute) + (put comprate − vendute)) dai clienti. Le due gambe di un vertical si compensano invece di sommarsi; non si usa più il volume senza lato con &quot;call +, put −&quot;.</p>
                        <p>• <b>Copertura in contratti ES</b>: gamma × posizione × 100 / 50 = ES per punto di SPX. Ogni ~10 s i dealer ribilanciano −G × variazione di SPX, con la posizione di quel momento; le linee sono la somma di questi ribilanciamenti. Niente più GEX × spostamento dall&apos;apertura.</p>
                        <p>• <b>Nessun peso di vicinanza</b>: la gamma cala già da sola lontano dallo spot.</p>
                        <p>• <b>Nessuna vanna</b>: gli snapshot non hanno la IV per strike per calcolarla bene, e prima pesava quasi zero.</p>
                        <p className="text-slate-500">Limiti: conta solo la gamma (non la copertura delta delle opzioni nuove), solo i 37 strike del poller e solo i contratti classificati da quando il poller è partito; supponiamo che i dealer siano la controparte di ogni trade dei clienti. Verde = i dealer comprano ES, rosso = vendono.</p>
                    </div>
                </>
            )}
        </main>
    );
}

export default function PressioneCorrettaPage() {
    return (
        <Suspense>
            <PressioneCorretta />
        </Suspense>
    );
}
