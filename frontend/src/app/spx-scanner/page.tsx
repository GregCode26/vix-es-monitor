'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false }) as any;

/**
 * SPX Options Volume Scanner - grafico 3D dei singoli trade.
 * X = DTE, Y = strike (linea gialla = ATM), Z = somma dei soli trade da almeno
 * N contratti del contratto, ogni stampa presa da sola (un ordine eseguito come
 * 400+200+200+200 con N = 500 non conta). Non e' il volume cumulativo.
 * CALL verdi, PUT rosse: mai sommate. Asse DTE fisso da 0 al filtro (90).
 * Le put sono spostate a sinistra della scadenza e le call a destra (le SPX AM
 * un po' di piu'), di una frazione della larghezza della barra, solo per non
 * sovrapporle.
 * I trade vengono da `python -m spx_flow_scanner.main trade`, che li legge solo
 * per i contratti saliti di volume: quelli non ancora letti sono contati in alto.
 */

interface Contratto {
    con_id: number; trading_class: string; real_expiry: string; dte: number; strike: number;
    opt_right: 'C' | 'P'; volume: number | null;
}
interface PerContratto { con_id: number; somma: number; n: number; massimo: number; ultimo: number }
interface Trade {
    con_id: number; ts: number; seq: number; size: number; price: number | null; exchange: string | null;
    conditions: string | null;
    /** C comprato, V venduto, I al mid, N senza quotazione, null non ancora chiesto. */
    verso: 'C' | 'V' | 'I' | 'N' | null; bid: number | null; ask: number | null;
    trading_class: string; real_expiry: string; strike: number; opt_right: 'C' | 'P';
}
interface Risposta {
    giorno: string; sessione: string; sessioni: string[]; giorni: string[];
    ciclo: { numero: number; started_at: number; spx: number; spx_source: string; atm: number } | null;
    contratti: Contratto[]; min: number; sogliaBase: number | null;
    perContratto: PerContratto[]; trade: Trade[];
    verifica: { da_leggere: number; letti: number; aggiornato: number | null } | null;
    /** Sessione precedente, solo contratti non ancora letti oggi (barre grigie). */
    precedente: { giorno: string; perContratto: (PerContratto & Pick<Contratto, 'trading_class' | 'real_expiry' | 'strike' | 'opt_right'>)[] } | null;
}

/**
 * Codici OPRA delle stampe multi-gamba (spread, combo, legate ad azioni): il
 * prezzo di una gamba confrontato col suo bid/ask non dice con sicurezza il
 * verso dell'ordine, e spesso sta fuori dalla quotazione.
 */
const MULTI_GAMBA = new Set('fghijklmnopq'.split(''));
const VERSI = {
    C: ['COMPRATO', 'text-green-400'], V: ['VENDUTO', 'text-red-400'],
    I: ['al mid', 'text-gray-400'], N: ['n.d.', 'text-gray-600'],
} as const;

function CellaVerso({ t }: { t: Trade }) {
    if (t.verso == null) return <td className="text-right text-gray-600">…</td>;
    const [testo, colore] = VERSI[t.verso];
    const spread = t.conditions != null && [...t.conditions].some(c => MULTI_GAMBA.has(c));
    // Fuori dalla quotazione: gamba di una combo prezzata come pacchetto, o stampa
    // in ritardo. Il 10/11/2026 erano cosi' 15 dei 20 trade senza codice multi-gamba.
    const fuori = t.price != null && t.bid != null && t.ask != null && (t.price > t.ask || t.price < t.bid);
    const quota = t.bid != null && t.ask != null ? `bid ${t.bid} / ask ${t.ask} prima del trade` : 'nessuna quotazione prima del trade';
    const avvisi = [spread && `codice ${t.conditions}: gamba di uno spread`, fuori && 'prezzo fuori dalla quotazione'].filter(Boolean);
    return (
        <td className={`text-right font-bold ${colore} ${avvisi.length ? 'opacity-60' : ''}`}
            title={`${quota}${avvisi.length ? ` · ${avvisi.join(', ')}: verso poco affidabile` : ''}`}>
            {testo}
            {spread && <span className="ml-1 font-normal text-[10px] text-amber-400">spr</span>}
            {fuori && <span className="ml-1 font-normal text-[10px] text-amber-400">fuori</span>}
        </td>
    );
}

const oraIt = (ts: number | null, secondi = false) => ts == null ? 'n.d.' :
    new Date(ts * 1000).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit',
        ...(secondi ? { second: '2-digit' } : {}) });
const fmt = (v: number | null | undefined) => v == null ? 'n.d.' : v.toLocaleString('it-IT');
/** Data di oggi a New York, YYYY-MM-DD: i giorni dello scanner sono giorni di borsa NY. */
const oggiNy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** Cosa cambia fra due letture: se nulla, il grafico 3D non si ridisegna. */
const firma = (d: Risposta) => [d.giorno, d.sessione, d.min, d.ciclo?.numero, d.ciclo?.started_at,
    d.verifica?.aggiornato, d.perContratto.length, d.trade.length, d.contratti.length,
    d.precedente?.perContratto.length].join('|');

export default function SpxScannerPage() {
    const [dati, setDati] = useState<Risposta | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [pronto, setPronto] = useState(false);
    const [giorno, setGiorno] = useState('');
    const [sessione, setSessione] = useState('');
    const [tipo, setTipo] = useState<'CP' | 'C' | 'P'>('CP');
    const [dteMax, setDteMax] = useState(90);
    const [range, setRange] = useState(300);
    const [minimo, setMinimo] = useState(200);
    // Schermata dei vertical della sessione notturna/mattina: dalle 15:30 la pagina passa alla cash e li nasconde.
    const [mattina, setMattina] = useState(false);
    const grafico = useRef<any>(null);
    const ultimaFirma = useRef('');
    // SPX live da /api/market (punto piu' recente), arrotondato al punto per non
    // ridisegnare il 3D a ogni decimale. Usato per la linea gialla solo sul giorno di oggi.
    const [spotLive, setSpotLive] = useState<number | null>(null);

    useEffect(() => {
        // Filtri iniziali anche dall'indirizzo: /spx-scanner?min=500&range=500&dte=30&tipo=P
        const q = new URLSearchParams(window.location.search);
        if (q.get('min')) setMinimo(+q.get('min')!);
        if (q.get('range')) setRange(+q.get('range')!);
        if (q.get('dte')) setDteMax(+q.get('dte')!);
        const t = q.get('tipo'); if (t === 'C' || t === 'P' || t === 'CP') setTipo(t);
        import('echarts-gl').then(() => setPronto(true));
    }, []);

    useEffect(() => {
        let attivo = true;
        const carica = async () => {
            const p = new URLSearchParams({ min: String(minimo) });
            if (giorno) p.set('giorno', giorno);
            if (sessione) p.set('sessione', sessione);
            // Sul giorno corrente: la sessione prima, in grigio, dove oggi non c'e' ancora niente.
            if (!giorno) p.set('precedente', '1');
            try {
                const r = await fetch(`/api/spx-scanner?${p}`);
                const j = await r.json();
                if (!attivo) return;
                if (!r.ok) { setErrore(j.error || `HTTP ${r.status}`); return; }
                setErrore(null);
                const f = firma(j);
                if (f !== ultimaFirma.current) { ultimaFirma.current = f; setDati(j); }
            } catch (e: any) { if (attivo) setErrore(String(e)); }
        };
        const t0 = setTimeout(carica, 300);   // il campo N si scrive cifra per cifra
        // 15 s: i trade arrivano ogni minuto e i volumi ogni 10, ma cosi' si vedono subito.
        // Solo locale (SQLite, niente Supabase): i ~5 MB non costano egress.
        const t = setInterval(carica, 15_000);
        return () => { attivo = false; clearTimeout(t0); clearInterval(t); };
    }, [giorno, sessione, minimo]);

    useEffect(() => {
        let attivo = true;
        const leggi = async () => {
            try {
                const j = await (await fetch('/api/market')).json();
                if (attivo && typeof j?.spx === 'number' && j.spx > 0) setSpotLive(Math.round(j.spx));
            } catch { /* resta l'ultimo valore */ }
        };
        leggi();
        const t = setInterval(leggi, 5_000);
        return () => { attivo = false; clearInterval(t); };
    }, []);

    // Il grafico si ridisegna da zero a ogni cambio (notMerge): in modalita' merge echarts-gl
    // lasciava a schermo le barre gia' filtrate. Si conserva solo l'inquadratura.
    const inquadratura = () => {
        try {
            const v = grafico.current?.getEchartsInstance()?.getOption()?.grid3D?.[0]?.viewControl;
            if (v) return { projection: 'perspective', alpha: v.alpha, beta: v.beta, distance: v.distance, center: v.center };
        } catch { /* primo disegno */ }
        return { projection: 'perspective', distance: 230, alpha: 22, beta: 35 };
    };

    const vista = useMemo(() => {
        if (!dati) return null;
        // Giorno di oggi (o la notturna di domani, gia' iniziata): linea sullo spot live.
        // Giorni passati: l'ATM dell'ultimo ciclo di quel giorno.
        const live = dati.giorno >= oggiNy() && spotLive != null;
        const atm = live ? spotLive : dati.ciclo?.atm ?? null;
        const meta = new Map(dati.contratti.map(c => [c.con_id, c]));
        const dteDi = (scad: string) => {
            const s = `${scad.slice(0, 4)}-${scad.slice(4, 6)}-${scad.slice(6, 8)}`;
            return Math.round((Date.parse(s) - Date.parse(dati.giorno)) / 86_400_000);
        };
        const passa = (r: 'C' | 'P', dte: number, strike: number) =>
            (tipo === 'CP' || r === tipo) && dte <= dteMax && (atm == null || Math.abs(strike - atm) <= range);
        const barre = dati.perContratto
            .map(p => ({ p, c: meta.get(p.con_id) }))
            .filter((x): x is { p: PerContratto; c: Contratto } => !!x.c && passa(x.c.opt_right, x.c.dte, x.c.strike));
        const trade = dati.trade.filter(t => passa(t.opt_right, dteDi(t.real_expiry), t.strike));
        // Barre grigie: la sessione precedente sui contratti che oggi lo scanner non ha ancora letto.
        const grigie = (dati.precedente?.perContratto ?? [])
            .map(g => ({ g, dte: dteDi(g.real_expiry) }))
            .filter(({ g, dte }) => dte >= 0 && passa(g.opt_right, dte, g.strike));
        const maxZ = Math.max(1, ...barre.map(b => b.p.somma), ...grigie.map(x => x.g.somma));
        const strikeVicini = [...new Set(dati.contratti.filter(c => c.dte <= 1).map(c => c.strike))].sort((a, b) => a - b);
        const passo = strikeVicini.length > 1 ? Math.max(1, Math.min(...strikeVicini.slice(1).map((v, i) => v - strikeVicini[i]))) : 5;
        // Asse DTE fisso da 0 al filtro "DTE <=" (90 di base), anche se le scadenze lontane non hanno trade.
        const xMin = -0.5, xMax = Math.max(1, dteMax) + 0.5;
        const larghezza = Math.max(0.35, xMax / 120);   // con 90 giorni una barra da 0.35 sparirebbe
        const series: any[] = (['C', 'P'] as const).filter(r => tipo === 'CP' || tipo === r).map(r => ({
            type: 'bar3D', name: r === 'C' ? 'CALL' : 'PUT',
            data: barre.filter(b => b.c.opt_right === r).map(({ p, c }) => ({
                value: [c.dte + (r === 'C' ? 0.55 : -0.55) * larghezza + (c.trading_class === 'SPX' ? 1.3 * larghezza : 0), c.strike, p.somma], p, c,
            })),
            barSize: [larghezza, passo * 0.8],
            shading: 'lambert',
            itemStyle: { color: r === 'C' ? '#22c55e' : '#ef4444', opacity: 0.95 },
            emphasis: { itemStyle: { color: '#facc15' } },
        }));
        const nomeGrigie = dati.precedente ? `${dati.precedente.giorno.slice(8, 10)}/${dati.precedente.giorno.slice(5, 7)} (non ancora letti oggi)` : '';
        if (grigie.length) {
            series.push({
                type: 'bar3D', name: nomeGrigie,
                data: grigie.map(({ g, dte }) => ({
                    value: [dte + (g.opt_right === 'C' ? 0.55 : -0.55) * larghezza + (g.trading_class === 'SPX' ? 1.3 * larghezza : 0), g.strike, g.somma],
                    g, dte,
                })),
                barSize: [larghezza, passo * 0.8],
                shading: 'lambert',
                itemStyle: { color: '#6b7280', opacity: 0.55 },
                emphasis: { itemStyle: { color: '#9ca3af' } },
            });
        }
        if (atm != null) {
            series.push({ type: 'line3D', name: 'ATM', data: [[xMin, atm, 0], [xMax, atm, 0]], lineStyle: { color: '#facc15', width: 4 } });
            series.push({ type: 'line3D', name: 'ATM ', data: [[0, atm, 0], [0, atm, maxZ]], lineStyle: { color: '#facc15', width: 2, opacity: 0.6 } });
        }
        const option = {
            backgroundColor: '#0b0f17',
            legend: { data: ['CALL', 'PUT', 'ATM', ...(grigie.length ? [nomeGrigie] : [])], textStyle: { color: '#ccc' }, top: 8 },
            tooltip: {
                formatter: (x: any) => {
                    const g = x.data?.g;
                    if (g) {
                        return `<b>${g.trading_class} ${g.real_expiry} ${g.strike} ${g.opt_right === 'C' ? 'CALL' : 'PUT'}</b><br/>` +
                            `<span style="color:#9ca3af">sessione del ${dati.precedente!.giorno}, oggi non ancora letto</span><br/>` +
                            `DTE ${x.data.dte}<br/>Trade da ≥ ${fmt(dati.min)}: <b>${g.n}</b>, contratti <b>${fmt(g.somma)}</b><br/>` +
                            `più grande ${fmt(g.massimo)}`;
                    }
                    const p: PerContratto | undefined = x.data?.p, c: Contratto | undefined = x.data?.c;
                    if (!p || !c) return x.seriesName?.startsWith('ATM') ? (live ? `SPX live ${atm}` : `ATM ${atm}`) : '';
                    return `<b>${c.trading_class} ${c.real_expiry} ${c.strike} ${c.opt_right === 'C' ? 'CALL' : 'PUT'}</b><br/>` +
                        `DTE ${c.dte}<br/>Trade da ≥ ${fmt(dati.min)}: <b>${p.n}</b>, contratti <b>${fmt(p.somma)}</b><br/>` +
                        `più grande ${fmt(p.massimo)} · ultimo ${oraIt(p.ultimo, true)}<br/>` +
                        `<span style="color:#888">volume sessione ${fmt(c.volume)}</span>`;
                },
            },
            xAxis3D: { type: 'value', name: 'DTE', min: xMin, max: xMax, nameTextStyle: { color: '#ccc' }, axisLabel: { color: '#aaa' } },
            // Estremi tondi a 25 punti: con la linea sullo spot live (7547) uscivano tacche 7.247/7.847.
            yAxis3D: { type: 'value', name: 'Strike', min: atm != null ? Math.floor((atm - range) / 25) * 25 : undefined,
                max: atm != null ? Math.ceil((atm + range) / 25) * 25 : undefined,
                nameTextStyle: { color: '#ccc' }, axisLabel: { color: '#aaa' } },
            zAxis3D: { type: 'value', name: `Σ trade ≥ ${dati.min}`, min: 0, nameTextStyle: { color: '#ccc' }, axisLabel: { color: '#aaa' } },
            grid3D: {
                boxWidth: 160, boxDepth: 110, boxHeight: 80,
                viewControl: inquadratura(),
                light: { main: { intensity: 1.1, shadow: false }, ambient: { intensity: 0.4 } },
                axisLine: { lineStyle: { color: '#555' } }, splitLine: { lineStyle: { color: '#222' } },
            },
            series,
        };
        return { option, atm, live, barre, trade, dteDi, grigie: grigie.length };
    }, [dati, tipo, dteMax, range, spotLive]);

    const ciclo = dati?.ciclo;
    const ver = dati?.verifica;
    const sel = 'bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm';
    return (
        <div className="min-h-screen bg-[#0b0f17] text-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-lg font-bold mr-2">SPX Options · singoli trade · 3D</h1>
                <select className={sel} value={giorno || dati?.giorno || ''} onChange={e => { setGiorno(e.target.value); setSessione(''); }}>
                    {/* Il giorno dell'ultimo ciclo c'e' anche prima che abbia volumi salvati */}
                    {[...new Set([...(dati ? [dati.giorno] : []), ...(dati?.giorni ?? [])])].sort().reverse()
                        .map(g => <option key={g}>{g}</option>)}
                </select>
                <select className={sel} value={sessione || dati?.sessione || ''} onChange={e => setSessione(e.target.value)}>
                    {(dati?.sessioni ?? []).map(s => <option key={s}>{s}</option>)}
                </select>
                <select className={sel} value={tipo} onChange={e => setTipo(e.target.value as any)}>
                    <option value="CP">CALL + PUT</option><option value="C">solo CALL</option><option value="P">solo PUT</option>
                </select>
                <label className="text-sm font-bold">trade ≥ <input type="number" step={100} min={1} className={`${sel} w-24`} value={minimo}
                    onChange={e => setMinimo(Math.max(1, +e.target.value || 1))} /> contratti</label>
                <label className="text-sm">DTE ≤ <input type="number" className={`${sel} w-16`} value={dteMax} onChange={e => setDteMax(+e.target.value)} /></label>
                <label className="text-sm">ATM ± <input type="number" step={50} className={`${sel} w-20`} value={range} onChange={e => setRange(+e.target.value)} /></label>
                <div className="ml-auto flex gap-2">
                    <button onClick={() => setMattina(true)} className="px-3 py-1.5 bg-blue-900 hover:bg-blue-800 border border-blue-700 rounded-lg text-xs"
                        title="Vertical 5/10 punti della sessione notturna e della mattina (prima dell'apertura cash)">VERTICAL MATTINA</button>
                    <a href="/hedging-pressure" className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">MARKET MAKER</a>
                    <a href="/market" className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">CHART</a>
                </div>
            </div>
            {errore && <div className="text-red-400 mb-2">{errore}</div>}
            {dati && !giorno && dati.giorno < oggiNy() && (
                <div className="mb-2 px-3 py-1.5 rounded border border-amber-600 bg-amber-950/40 text-amber-300 text-sm">
                    Dati del {dati.giorno}: oggi lo scanner non ha ancora letto niente (fuori orario, o TWS/scanner fermi).
                    La pagina si aggiorna da sola appena arriva il primo ciclo.
                </div>
            )}
            {dati && vista?.live && ciclo && Date.now() / 1000 - ciclo.started_at > 20 * 60 && (
                <div className="mb-2 px-3 py-1.5 rounded border border-amber-600 bg-amber-950/40 text-amber-300 text-sm">
                    Ultimo ciclo volumi alle {oraIt(ciclo.started_at)}: lo scanner ne fa uno ogni 10 minuti, potrebbe essere fermo.
                </div>
            )}
            {dati && vista && (
                <div className="text-xs text-gray-400 mb-2 space-y-0.5">
                    <div>
                        {vista.live && <span className="text-yellow-400">linea gialla = SPX live {vista.atm} · </span>}
                        {ciclo && <>Ciclo volumi {ciclo.numero} {oraIt(ciclo.started_at)} · SPX {ciclo.spx?.toFixed(2)} ({ciclo.spx_source}) · ATM del ciclo {ciclo.atm} · </>}
                        altezza = somma dei soli trade da ≥ {fmt(dati.min)} contratti, ogni stampa da sola (non il volume cumulativo) ·
                        in vista {fmt(vista.barre.length)} contratti con trade, {fmt(vista.trade.length)} trade
                        {vista.grigie > 0 && dati.precedente && <span className="text-gray-300"> · in grigio {fmt(vista.grigie)} contratti
                            della sessione del {dati.precedente.giorno} non ancora letti oggi (spariscono quando lo scanner li legge)</span>}
                    </div>
                    <div>
                        {dati.sogliaBase != null && minimo < dati.sogliaBase &&
                            <span className="text-amber-400">salvati solo i trade ≥ {dati.sogliaBase}: filtro portato a {dati.sogliaBase} · </span>}
                        {ver ? <>trade letti per {fmt(ver.letti)} contratti, ultimo aggiornamento {oraIt(ver.aggiornato)} ·{' '}
                            <span className={ver.da_leggere ? 'text-amber-400' : ''}>
                                {fmt(ver.da_leggere)} contratti con volume salito di ≥ {fmt(dati.min)} non ancora verificati
                            </span></> : <span className="text-amber-400">nessun trade letto: avvia python -m spx_flow_scanner.main trade</span>}
                        {' '}· CALL a destra e PUT a sinistra della loro scadenza, SPX AM un po' più a destra, solo per non sovrapporle
                    </div>
                </div>
            )}
            <div style={{ height: '64vh' }} className="border border-gray-800 rounded">
                {pronto && vista && <ReactECharts ref={grafico} option={vista.option} notMerge={true} style={{ height: '100%', width: '100%' }} />}
            </div>
            {vista && dati && (
                <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
                    {(['C', 'P'] as const).map(r => (
                        <div key={r}>
                            <div className={`font-bold mb-1 ${r === 'C' ? 'text-green-400' : 'text-red-400'}`}>
                                LARGE {r === 'C' ? 'CALL' : 'PUT'} TRADES (≥ {fmt(dati.min)})</div>
                            <table className="w-full">
                                <thead className="text-gray-500"><tr><th className="text-left">Ora</th><th className="text-left">DTE</th>
                                    <th className="text-left">Scadenza</th><th>Strike</th><th className="text-right">Contratti</th>
                                    <th className="text-right">Prezzo</th><th className="text-right">Verso</th><th className="text-right">Borsa</th></tr></thead>
                                <tbody>{vista.trade.filter(t => t.opt_right === r).slice(0, 25).map(t => (
                                    <tr key={`${t.con_id}-${t.ts}-${t.seq}`} className="border-t border-gray-800">
                                        <td>{oraIt(t.ts, true)}</td><td>{vista.dteDi(t.real_expiry)}</td>
                                        <td>{t.trading_class} {t.real_expiry}</td><td className="text-center">{t.strike}</td>
                                        <td className="text-right font-bold">{fmt(t.size)}</td>
                                        <td className="text-right">{t.price ?? 'n.d.'}</td><CellaVerso t={t} /><td className="text-right">{t.exchange ?? ''}</td>
                                    </tr>))}</tbody>
                            </table>
                        </div>
                    ))}
                </div>
            )}
            {mattina && <VerticaliMattina giorno={giorno || dati?.giorno || ''} minimo={minimo} chiudi={() => setMattina(false)} />}
        </div>
    );
}

type Verticale = {
    ts: number; sessione: string; classe: string; scadenza: string; tipo: 'C' | 'P'; kBasso: number; kAlto: number; larghezza: number;
    size: number; prezzo: number | null; mid: number | null; verso: string; nome: string; condizioni: string | null;
    basis: number | null; basisFonte: string; esBasso: number | null; esAlto: number | null;
};

/** Vertical 5/10 punti della sessione notturna (notte + mattina italiana) da /api/spx-scanner/verticali. */
function VerticaliMattina({ giorno, minimo, chiudi }: { giorno: string; minimo: number; chiudi: () => void }) {
    const [lista, setLista] = useState<Verticale[] | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    // la pagina passa una funzione nuova a ogni render: dal ref, cosi' non si ricarica a ogni aggiornamento
    const chiudiRef = useRef(chiudi);
    useEffect(() => { chiudiRef.current = chiudi; }, [chiudi]);
    useEffect(() => {
        let attivo = true;
        const carica = async () => {
            try {
                const p = new URLSearchParams({ min: String(minimo) });
                if (giorno) p.set('giorno', giorno);
                const r = await fetch(`/api/spx-scanner/verticali?${p}`);
                const j = await r.json();
                if (!attivo) return;
                if (!r.ok) { setErrore(j.error || `HTTP ${r.status}`); return; }
                setErrore(null);
                setLista((j.verticali as Verticale[]).filter(v => v.sessione === 'notturna'));
            } catch (e: unknown) { if (attivo) setErrore(String(e)); }
        };
        carica();
        const t = setInterval(carica, 30_000);
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') chiudiRef.current(); };
        window.addEventListener('keydown', esc);
        return () => { attivo = false; clearInterval(t); window.removeEventListener('keydown', esc); };
    }, [giorno, minimo]);
    const colore = (v: Verticale) => v.verso === 'incerto' ? '#9ca3af' : v.nome.startsWith('BULL') ? '#34d399' : '#f43f5e';
    const oggi = giorno.replaceAll('-', '');
    return (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto" onClick={chiudi}>
            <div className="bg-[#0f1520] border border-slate-700 rounded-lg w-full max-w-5xl p-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-base font-bold">Vertical della mattina · {giorno} · sessione notturna · gambe ≥ {fmt(minimo)}</h2>
                    <button onClick={chiudi} className="ml-auto px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-xs">CHIUDI (Esc)</button>
                </div>
                {errore && <div className="text-red-400 mb-2">{errore}</div>}
                {!lista && !errore && <div className="text-gray-400 text-sm">Carico...</div>}
                {lista && lista.length === 0 && <div className="text-gray-400 text-sm">Nessun vertical da 5 o 10 punti con gambe da almeno {fmt(minimo)} contratti nella sessione notturna.</div>}
                {lista && lista.length > 0 && (
                    <table className="w-full text-sm">
                        <thead className="text-xs text-gray-400 border-b border-slate-700">
                            <tr><th className="text-left p-1">Ora</th><th className="text-left p-1">Vertical</th><th className="text-left p-1">Tipo</th>
                                <th className="text-center p-1">Strike SPX</th><th className="text-center p-1">Strike ES</th><th className="text-right p-1">Contratti</th>
                                <th className="text-right p-1">Prezzo / mid</th><th className="text-left p-1">Scadenza</th></tr>
                        </thead>
                        <tbody>
                            {lista.map((v, i) => (
                                <tr key={i} className="border-b border-slate-800">
                                    <td className="p-1">{oraIt(v.ts, true)}</td>
                                    <td className="p-1 font-bold" style={{ color: colore(v) }}>{v.nome}</td>
                                    <td className="p-1" style={{ color: v.tipo === 'C' ? '#3b82f6' : '#f97316' }}>{v.tipo === 'C' ? 'call' : 'put'} {v.larghezza} pt</td>
                                    <td className="p-1 text-center">{v.kBasso} / {v.kAlto}</td>
                                    <td className="p-1 text-center text-gray-300">{v.esBasso == null ? 'n.d.' : `${v.esBasso.toFixed(2)} / ${v.esAlto!.toFixed(2)}`}
                                        {v.basisFonte !== 'momento' && <span className="text-gray-500" title={`basis ${v.basis} (${v.basisFonte})`}> *</span>}</td>
                                    <td className="p-1 text-right font-bold">{fmt(v.size)}</td>
                                    <td className="p-1 text-right">{v.prezzo ?? 'n.d.'} / {v.mid ?? 'n.d.'}</td>
                                    <td className="p-1">{v.classe} {v.scadenza === oggi ? '0DTE' : `${v.scadenza.slice(6, 8)}/${v.scadenza.slice(4, 6)}`}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="text-[11px] text-gray-500 mt-3">
                    Due stampe stesso tipo e scadenza, stessa quantità, strike a 5 o 10 punti, entro 1 s. Verso dal prezzo del pacchetto contro il mid prima del trade
                    (BULL verde, BEAR rosso, grigio = al mid o senza quote). Aperti o chiusi non si sa. * = strike ES con la basis dell&apos;ultima sessione cash
                    (di notte SPX non quota). Si aggiorna ogni 30 s; la soglia è quella della pagina.
                </div>
            </div>
        </div>
    );
}
