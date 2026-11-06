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
    trading_class: string; real_expiry: string; strike: number; opt_right: 'C' | 'P';
}
interface Risposta {
    giorno: string; sessione: string; sessioni: string[]; giorni: string[];
    ciclo: { numero: number; started_at: number; spx: number; spx_source: string; atm: number } | null;
    contratti: Contratto[]; min: number; sogliaBase: number | null;
    perContratto: PerContratto[]; trade: Trade[];
    verifica: { da_leggere: number; letti: number; aggiornato: number | null } | null;
}

const oraNy = (ts: number | null, secondi = false) => ts == null ? 'n.d.' :
    new Date(ts * 1000).toLocaleTimeString('it-IT', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
        ...(secondi ? { second: '2-digit' } : {}) });
const fmt = (v: number | null | undefined) => v == null ? 'n.d.' : v.toLocaleString('it-IT');

export default function SpxScannerPage() {
    const [dati, setDati] = useState<Risposta | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [pronto, setPronto] = useState(false);
    const [giorno, setGiorno] = useState('');
    const [sessione, setSessione] = useState('');
    const [tipo, setTipo] = useState<'CP' | 'C' | 'P'>('CP');
    const [dteMax, setDteMax] = useState(90);
    const [range, setRange] = useState(300);
    const [minimo, setMinimo] = useState(500);
    const grafico = useRef<any>(null);

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
            try {
                const r = await fetch(`/api/spx-scanner?${p}`);
                const j = await r.json();
                if (!attivo) return;
                if (!r.ok) { setErrore(j.error || `HTTP ${r.status}`); return; }
                setErrore(null); setDati(j);
            } catch (e: any) { if (attivo) setErrore(String(e)); }
        };
        const t0 = setTimeout(carica, 300);   // il campo N si scrive cifra per cifra
        const t = setInterval(carica, 60_000);
        return () => { attivo = false; clearTimeout(t0); clearInterval(t); };
    }, [giorno, sessione, minimo]);

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
        const atm = dati.ciclo?.atm ?? null;
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
        const maxZ = Math.max(1, ...barre.map(b => b.p.somma));
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
        if (atm != null) {
            series.push({ type: 'line3D', name: 'ATM', data: [[xMin, atm, 0], [xMax, atm, 0]], lineStyle: { color: '#facc15', width: 4 } });
            series.push({ type: 'line3D', name: 'ATM ', data: [[0, atm, 0], [0, atm, maxZ]], lineStyle: { color: '#facc15', width: 2, opacity: 0.6 } });
        }
        const option = {
            backgroundColor: '#0b0f17',
            legend: { data: ['CALL', 'PUT', 'ATM'], textStyle: { color: '#ccc' }, top: 8 },
            tooltip: {
                formatter: (x: any) => {
                    const p: PerContratto | undefined = x.data?.p, c: Contratto | undefined = x.data?.c;
                    if (!p || !c) return x.seriesName?.startsWith('ATM') ? `ATM ${atm}` : '';
                    return `<b>${c.trading_class} ${c.real_expiry} ${c.strike} ${c.opt_right === 'C' ? 'CALL' : 'PUT'}</b><br/>` +
                        `DTE ${c.dte}<br/>Trade da ≥ ${fmt(dati.min)}: <b>${p.n}</b>, contratti <b>${fmt(p.somma)}</b><br/>` +
                        `più grande ${fmt(p.massimo)} · ultimo ${oraNy(p.ultimo, true)} NY<br/>` +
                        `<span style="color:#888">volume sessione ${fmt(c.volume)}</span>`;
                },
            },
            xAxis3D: { type: 'value', name: 'DTE', min: xMin, max: xMax, nameTextStyle: { color: '#ccc' }, axisLabel: { color: '#aaa' } },
            yAxis3D: { type: 'value', name: 'Strike', min: atm != null ? atm - range : undefined, max: atm != null ? atm + range : undefined,
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
        return { option, atm, barre, trade, dteDi };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dati, tipo, dteMax, range]);

    const ciclo = dati?.ciclo;
    const ver = dati?.verifica;
    const sel = 'bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm';
    return (
        <div className="min-h-screen bg-[#0b0f17] text-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-lg font-bold mr-2">SPX Options · singoli trade · 3D</h1>
                <select className={sel} value={giorno || dati?.giorno || ''} onChange={e => { setGiorno(e.target.value); setSessione(''); }}>
                    {(dati?.giorni ?? []).map(g => <option key={g}>{g}</option>)}
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
                    <a href="/hedging-pressure" className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">MARKET MAKER</a>
                    <a href="/market" className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">CHART</a>
                </div>
            </div>
            {errore && <div className="text-red-400 mb-2">{errore}</div>}
            {dati && vista && (
                <div className="text-xs text-gray-400 mb-2 space-y-0.5">
                    <div>
                        {ciclo && <>Ciclo volumi {ciclo.numero} {oraNy(ciclo.started_at)} NY · SPX {ciclo.spx?.toFixed(2)} ({ciclo.spx_source}) · ATM {vista.atm} · </>}
                        altezza = somma dei soli trade da ≥ {fmt(dati.min)} contratti, ogni stampa da sola (non il volume cumulativo) ·
                        in vista {fmt(vista.barre.length)} contratti con trade, {fmt(vista.trade.length)} trade
                    </div>
                    <div>
                        {dati.sogliaBase != null && minimo < dati.sogliaBase &&
                            <span className="text-amber-400">salvati solo i trade ≥ {dati.sogliaBase}: filtro portato a {dati.sogliaBase} · </span>}
                        {ver ? <>trade letti per {fmt(ver.letti)} contratti, ultimo aggiornamento {oraNy(ver.aggiornato)} NY ·{' '}
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
                                <thead className="text-gray-500"><tr><th className="text-left">Ora NY</th><th className="text-left">DTE</th>
                                    <th className="text-left">Scadenza</th><th>Strike</th><th className="text-right">Contratti</th>
                                    <th className="text-right">Prezzo</th><th className="text-right">Borsa</th></tr></thead>
                                <tbody>{vista.trade.filter(t => t.opt_right === r).slice(0, 25).map(t => (
                                    <tr key={`${t.con_id}-${t.ts}-${t.seq}`} className="border-t border-gray-800">
                                        <td>{oraNy(t.ts, true)}</td><td>{vista.dteDi(t.real_expiry)}</td>
                                        <td>{t.trading_class} {t.real_expiry}</td><td className="text-center">{t.strike}</td>
                                        <td className="text-right font-bold">{fmt(t.size)}</td>
                                        <td className="text-right">{t.price ?? 'n.d.'}</td><td className="text-right">{t.exchange ?? ''}</td>
                                    </tr>))}</tbody>
                            </table>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
