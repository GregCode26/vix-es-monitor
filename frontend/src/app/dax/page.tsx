'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Chart as ChartJS, LinearScale, PointElement, LineElement, Tooltip, Filler, LineController, ScatterController, type Plugin } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { Line } from 'react-chartjs-2';
import {
    type Gamba, type Impostazioni, type Mercato, type Scenario, type TipoGamba,
    bs, curva, dataDa, giorniTra, griglia, isoGiorno, ivImplicita, pareggi, riporto, riportoDaParita, scadenzaTrimestraleVicinaA, scadenzaVicinaA, totali, valutaGamba,
} from '@/lib/daxStrategia';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Filler, LineController, ScatterController, annotationPlugin);

/**
 * DAX: strategia put su ODAX a ~90 giorni. Si comprano 2 vertical di put e le
 * si finanziano vendendo put lontane: se il DAX sale non si perde (costo ~0),
 * se scende si guadagna fino ai livelli delle put vendute.
 * Rifacimento del foglio Excel "ODAX - DDE IB": quote da IBKR (/api/dax),
 * prezzi e greche con Black-Scholes, simulazioni su indice, data e IV.
 */

// ---------- costanti e default ----------

const CHIAVE_LOCALE = 'daxStrategia_v1';

const IMP_DEFAULT: Impostazioni = { moltOpzioni: 5, moltFuture: 5, commOpzioni: 2.5, commFuture: 1, tasso: 2.05, classeFuture: 'FDXM' };
const MKT_DEFAULT: Mercato = { indiceLast: 26261, indiceClose: 26045, futureLast: null, futureClose: null };

function nuovoId() { return Math.random().toString(36).slice(2, 10); }

function gamba(p: Partial<Gamba>): Gamba {
    return {
        id: nuovoId(), attiva: true, qta: 1, tipo: 'P', strike: 0, scadenza: '2027-03-19', iv: null,
        apertura: null, chiusura: null, dataApertura: isoGiorno(new Date()), gruppo: '', mid: null, ...p,
    };
}

/** Le gambe del foglio Excel, come esempio iniziale. */
const GAMBE_ESEMPIO: Gamba[] = [
    gamba({ qta: 1, strike: 25000, iv: 17.75, apertura: 665.5, mid: 665.5, gruppo: 'V1' }),
    gamba({ qta: -1, strike: 24500, iv: 18.91, apertura: 548.5, mid: 548.5, gruppo: 'V1' }),
    gamba({ qta: 1, strike: 22000, iv: 24.96, apertura: 228.5, mid: 228.5, gruppo: 'V2' }),
    gamba({ qta: -1, strike: 20700, iv: 28.2, apertura: 152.25, mid: 152.25, gruppo: 'V2' }),
];

type Zoom = 'strike' | 'passi' | '10' | '25' | '40';

/** Una riga del registro: come le note sul grafico dell'Excel (apertura, IV ai due estremi, chiusura). */
interface Ciclo {
    id: string;
    apertura: string;        // YYYY-MM-DD
    scadenza: string;        // es. "Dec 26"
    last: number | null;     // indice all'apertura
    ivAtm: number | null;
    ivPrimaComprata: number | null;
    ivLontana: number | null;
    gambe: string;
    chiusura: string;        // YYYY-MM-DD, vuoto se aperto
    lastChiusura: number | null;
    pnl: number | null;      // EUR, commissioni comprese
    note: string;
}

/** I cicli annotati sul grafico del video (P&L noto solo per Dec 26). */
const REGISTRO_ESEMPIO: Ciclo[] = [
    { id: 'c1', apertura: '2025-03-19', scadenza: 'Jun 25', last: 23350, ivAtm: 18.7, ivPrimaComprata: null, ivLontana: null, gambe: '', chiusura: '', lastChiusura: null, pnl: null, note: '' },
    { id: 'c2', apertura: '2025-06-10', scadenza: 'Sep 25', last: 24090, ivAtm: 16.0, ivPrimaComprata: null, ivLontana: null, gambe: '', chiusura: '', lastChiusura: null, pnl: null, note: '' },
    { id: 'c3', apertura: '2025-12-15', scadenza: 'Mar 26', last: 24278, ivAtm: 14.5, ivPrimaComprata: null, ivLontana: null, gambe: '', chiusura: '', lastChiusura: null, pnl: null, note: '' },
    { id: 'c4', apertura: '2026-02-27', scadenza: 'Jun 26', last: 25300, ivAtm: 15.3, ivPrimaComprata: null, ivLontana: null, gambe: '+1 23600 ... -5 15000', chiusura: '2026-03-10', lastChiusura: null, pnl: null, note: '' },
    { id: 'c5', apertura: '2026-05-14', scadenza: 'Sep 26', last: 24440, ivAtm: 18.3, ivPrimaComprata: 21.196, ivLontana: 43.6, gambe: '+1 23000 / -1 22500 · +1 18600 / -1 17400 · -5 14200', chiusura: '', lastChiusura: null, pnl: null, note: 'a scadenza' },
    { id: 'c6', apertura: '2026-09-02', scadenza: 'Dec 26', last: 25836, ivAtm: 15.9, ivPrimaComprata: 18.59, ivLontana: 39.971, gambe: '+1 24500 / -1 24000 · +1 21500 / -1 20200 · -2 16600 / -4 16400', chiusura: '2026-10-01', lastChiusura: 25000, pnl: 499.5, note: 'mai in perdita, chiusa in anticipo' },
];

interface Salvataggio {
    gambe: Gamba[]; imp: Impostazioni; mkt: Mercato; passo: number; zoom: Zoom;
    supporti?: string; registro?: Ciclo[]; ivAtm?: number | null;
}

interface RispostaIbkr {
    errore?: string;
    ora?: string;
    indice?: { bid: number | null; ask: number | null; last: number | null; close: number | null; tipoDati: string };
    future?: { bid: number | null; ask: number | null; last: number | null; close: number | null; tipoDati: string; classe: string; scadenza: string };
    scadenze?: string[];
    atm?: { strike: number; scadenza: string; iv: number | null; put: number | null; call: number | null };
    gambe?: { id: string; errore?: string; bid?: number | null; ask?: number | null; last?: number | null; close?: number | null; mid?: number | null; iv?: number | null; tipoDati?: string }[];
}

// ---------- formattazione ----------

const fmt = (v: number | null | undefined, d = 2) =>
    v == null || !isFinite(v) ? '—' : v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? '—' : `${fmt(v, d)} €`);
const colore = (v: number | null | undefined) => (v == null || Math.abs(v) < 1e-9 ? 'text-slate-300' : v > 0 ? 'text-green-400' : 'text-red-400');
const dataLunga = (d: Date) => d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

// ---------- piccoli componenti ----------

function Card({ titolo, children, className = '' }: { titolo?: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-slate-800/50 border border-slate-700 rounded-lg p-2 ${className}`}>
            {titolo && <div className="text-[9px] font-bold tracking-widest text-slate-500 uppercase mb-2">{titolo}</div>}
            {children}
        </div>
    );
}

function Campo({ etichetta, children }: { etichetta: string; children: React.ReactNode }) {
    return (
        <label className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-slate-400">{etichetta}</span>
            {children}
        </label>
    );
}

function Num({ valore, onChange, passo = 'any', className = '', placeholder }: {
    valore: number | null | undefined; onChange: (v: number | null) => void; passo?: string; className?: string; placeholder?: string;
}) {
    return (
        <input
            type="number" step={passo} value={valore ?? ''} placeholder={placeholder}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            className={`bg-slate-900 border border-slate-700 rounded px-1 py-0 text-right font-mono text-slate-200 focus:outline-none focus:border-blue-500 ${className}`}
        />
    );
}

function Bottone({ onClick, children, tono = 'neutro', titolo, disabled }: {
    onClick: () => void; children: React.ReactNode; tono?: 'neutro' | 'verde' | 'rosso' | 'blu' | 'ambra' | 'viola'; titolo?: string; disabled?: boolean;
}) {
    const toni = {
        neutro: 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200',
        verde: 'bg-green-900/40 hover:bg-green-800/60 border-green-700/60 text-green-300',
        rosso: 'bg-red-900/40 hover:bg-red-800/60 border-red-700/60 text-red-300',
        blu: 'bg-blue-600 hover:bg-blue-700 border-blue-500 text-white',
        ambra: 'bg-amber-900/40 hover:bg-amber-800/60 border-amber-700/60 text-amber-300',
        viola: 'bg-violet-900/40 hover:bg-violet-800/60 border-violet-700/60 text-violet-300',
    };
    return (
        <button onClick={onClick} title={titolo} disabled={disabled}
            className={`px-2 py-1 border rounded-lg text-[10px] font-bold transition-colors disabled:opacity-40 ${toni[tono]}`}>
            {children}
        </button>
    );
}

// ---------- TradingView ----------

/**
 * Simboli provati nel widget incorporato (23/11/2026): XETR:DAX e EUREX:FDAX1!
 * danno solo D/W/M (dati di fine giornata fuori da tradingview.com), TVC:DEU40
 * non e' disponibile, Pepperstone/Capital.com restano vuoti. Al minuto
 * funzionano solo i CFD OANDA e FOREX.com, gli unici aggiornati in tempo reale
 * (Xetra e FDAX nel widget sono dati di fine giornata: la candela di oggi manca).
 * Il grafico parte sul giornaliero.
 */
const SIMBOLI_TV = [
    { s: 'OANDA:DE30EUR', n: 'DAX CFD OANDA (tempo reale)' },
    { s: 'FOREXCOM:GRXEUR', n: 'DAX CFD FOREX.com (tempo reale)' },
    { s: 'XETR:DAX', n: 'DAX indice Xetra (fermo a ieri)' },
    { s: 'EUREX:FDAX1!', n: 'FDAX future (fermo a ieri)' },
];

function GraficoTradingView({ onClose }: { onClose: () => void }) {
    const box = useRef<HTMLDivElement>(null);
    const [simbolo, setSimbolo] = useState(SIMBOLI_TV[0].s);

    useEffect(() => {
        const el = box.current;
        if (!el) return;
        el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
        script.type = 'text/javascript';
        script.async = true;
        script.innerHTML = JSON.stringify({
            autosize: true, symbol: simbolo, interval: 'D', timezone: 'Europe/Rome', theme: 'dark', style: '1',
            locale: 'it', backgroundColor: '#0c0d10', gridColor: 'rgba(51,65,85,0.3)', allow_symbol_change: true,
            hide_side_toolbar: false, withdateranges: true, details: false, calendar: false, support_host: 'https://www.tradingview.com',
        });
        el.appendChild(script);
        return () => { el.innerHTML = ''; };
    }, [simbolo]);

    useEffect(() => {
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-2 md:p-6" onClick={onClose}>
            <div className="bg-[#0c0d10] border border-slate-700 rounded-xl w-full h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-blue-400">GRAFICO DAX · giornaliero</span>
                        <select value={simbolo} onChange={(e) => setSimbolo(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] text-slate-200">
                            {SIMBOLI_TV.map(x => <option key={x.s} value={x.s}>{x.n} — {x.s}</option>)}
                        </select>
                        <a href={`https://www.tradingview.com/chart/?symbol=XETR%3ADAX&interval=1`} target="_blank" rel="noreferrer"
                            className="text-[10px] text-slate-400 hover:text-slate-200 underline">DAX Xetra 1 min su TradingView ↗</a>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-lg leading-none">×</button>
                </div>
                <div ref={box} className="tradingview-widget-container flex-1 min-h-0" />
            </div>
        </div>
    );
}

// ---------- grafico P&L ----------

/** Etichette in euro sui punti a passo fisso, come nel foglio. */
const etichettePassi: Plugin<'line'> = {
    id: 'etichettePassi',
    afterDatasetsDraw(chart) {
        const i = chart.data.datasets.findIndex(d => d.label === 'passi');
        if (i < 0 || !chart.isDatasetVisible(i)) return;
        const meta = chart.getDatasetMeta(i);
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        meta.data.forEach((p, k) => {
            const raw = chart.data.datasets[i].data[k] as { x: number; y: number };
            const testo = `${fmt(raw.y, 0)} €`;
            const sopra = raw.y >= 0;
            ctx.fillStyle = raw.y >= 0 ? '#4ade80' : '#f87171';
            ctx.fillText(testo, p.x, p.y + (sopra ? -10 : 16));
        });
        ctx.restore();
    },
};

// ---------- pagina ----------

export default function DaxPage() {
    const [gambe, setGambe] = useState<Gamba[]>(GAMBE_ESEMPIO);
    const [imp, setImp] = useState<Impostazioni>(IMP_DEFAULT);
    const [mkt, setMkt] = useState<Mercato>(MKT_DEFAULT);
    const [passo, setPasso] = useState(100);
    const [zoom, setZoom] = useState<Zoom>('strike');
    const [caricato, setCaricato] = useState(false);
    const [locale, setLocale] = useState(true);

    // simulazione (non salvata)
    const [indiceSim, setIndiceSim] = useState<number | null>(null);
    const [giorniAvanti, setGiorniAvanti] = useState(0);
    const [shiftIv, setShiftIv] = useState(0);
    const [aScadenza, setAScadenza] = useState(false);

    // IBKR
    const [inLettura, setInLettura] = useState(false);
    const [auto, setAuto] = useState(true);
    const [ivMercato, setIvMercato] = useState(true);
    const leggiRef = useRef<(() => void) | null>(null);
    const inLetturaRef = useRef(false);
    const [statoIbkr, setStatoIbkr] = useState<string>('');
    const [scadenzeIbkr, setScadenzeIbkr] = useState<string[]>([]);
    const [mostraTv, setMostraTv] = useState(false);
    const [fonteIndice, setFonteIndice] = useState('a mano');

    // modello strategia
    const [mostraModello, setMostraModello] = useState(false);

    // supporti / gap da guardare sul grafico, registro cicli, IV ATM
    const [supporti, setSupporti] = useState('24025, 21504, 20207, 16205');
    const [registro, setRegistro] = useState<Ciclo[]>(REGISTRO_ESEMPIO);
    const [ivAtm, setIvAtm] = useState<number | null>(15.9);

    // ----- caricamento e salvataggio -----
    useEffect(() => {
        (async () => {
            let dati: Salvataggio | null = null;
            try {
                const r = await fetch('/api/dax');
                const j = await r.json();
                setLocale(j.local !== false);
                dati = j.posizione;
            } catch { /* offline */ }
            if (!dati) {
                try { dati = JSON.parse(localStorage.getItem(CHIAVE_LOCALE) || 'null'); } catch { /* niente */ }
            }
            if (dati) {
                if (Array.isArray(dati.gambe)) setGambe(dati.gambe);
                if (dati.imp) setImp({ ...IMP_DEFAULT, ...dati.imp });
                if (dati.mkt) setMkt({ ...MKT_DEFAULT, ...dati.mkt });
                if (dati.passo) setPasso(dati.passo);
                if (dati.zoom) setZoom(dati.zoom);
                if (typeof dati.supporti === 'string') setSupporti(dati.supporti);
                if (Array.isArray(dati.registro)) setRegistro(dati.registro);
                if (dati.ivAtm !== undefined) setIvAtm(dati.ivAtm);
            }
            setCaricato(true);
        })();
    }, []);

    useEffect(() => {
        if (!caricato) return;
        const dati: Salvataggio = { gambe, imp, mkt, passo, zoom, supporti, registro, ivAtm };
        const t = setTimeout(() => {
            try { localStorage.setItem(CHIAVE_LOCALE, JSON.stringify(dati)); } catch { /* niente */ }
            if (locale) fetch('/api/dax', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dati) }).catch(() => { });
        }, 700);
        return () => clearTimeout(t);
    }, [gambe, imp, mkt, passo, zoom, supporti, registro, ivAtm, caricato, locale]);

    // ----- IBKR -----
    const gambeRef = useRef(gambe);
    gambeRef.current = gambe;

    const leggiIbkr = useCallback(async () => {
        setInLettura(true);
        setStatoIbkr('lettura da IBKR…');
        try {
            const r = await fetch('/api/dax', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gambe: gambeRef.current.filter(g => g.tipo !== 'F' && g.chiusura == null), classeFuture: imp.classeFuture,
                    scadenzaAtm: gambeRef.current.filter(g => g.tipo !== 'F' && g.chiusura == null).map(g => g.scadenza).sort().at(-1) ?? null,
                }),
            });
            const j: RispostaIbkr = await r.json();
            if (!r.ok || j.errore) { setStatoIbkr(j.errore || `errore ${r.status}`); return; }
            // L'indice DAX senza abbonamento arriva ritardato di 15 min mentre future e
            // opzioni sono live: in quel caso l'indice = future live - base di ieri
            // (close future - close indice), altrimenti IV e P&L partono da un prezzo vecchio.
            const futLive = j.future?.last ?? (j.future?.bid && j.future?.ask ? (j.future.bid + j.future.ask) / 2 : null);
            const idxIbkr = j.indice?.last ?? (j.indice?.bid && j.indice?.ask ? (j.indice.bid + j.indice.ask) / 2 : null);
            const ritardato = !!j.indice?.tipoDati?.includes('delayed');
            const daFuture = ritardato && j.future?.tipoDati === 'live' && futLive != null && j.future?.close && j.indice?.close
                ? Math.round((futLive - (j.future.close - j.indice.close)) * 100) / 100 : null;
            setFonteIndice(daFuture != null ? `da future (IBKR ritardato: ${fmt(idxIbkr, 0)})` : ritardato ? 'IBKR ritardato 15 min' : 'IBKR');
            const indiceNuovo = daFuture ?? idxIbkr;
            let carry: number | null = null;
            if (j.atm?.put != null && j.atm?.call != null && indiceNuovo) {
                const T = Math.max(0, giorniTra(new Date(), dataDa(j.atm.scadenza))) / 365;
                carry = riportoDaParita(j.atm.call, j.atm.put, j.atm.strike, indiceNuovo, T, imp.tasso / 100);
            }
            setMkt(m => ({
                indiceLast: indiceNuovo ?? m.indiceLast,
                indiceClose: j.indice?.close ?? m.indiceClose,
                futureLast: futLive ?? m.futureLast,
                futureClose: j.future?.close ?? m.futureClose,
                carry: carry != null && j.atm ? { ...(m.carry ?? {}), [j.atm.scadenza]: carry } : m.carry,
            }));
            if (j.scadenze) setScadenzeIbkr(j.scadenze);
            if (j.atm?.iv != null) setIvAtm(j.atm.iv);
            const perId = new Map((j.gambe ?? []).map(q => [q.id, q]));
            const errori = (j.gambe ?? []).filter(q => q.errore).length;
            // Con "IV dal mercato" la IV di ogni gamba si ricalcola dal mid (stesso modello
            // del grafico), cosi' valore simulato = prezzo di mercato e il P&L e' quello vero.
            const tasso = imp.tasso / 100;
            setGambe(gs => gs.map(g => {
                const q = perId.get(g.id);
                if (!q || q.errore) return g;
                const mid = q.mid ?? q.last ?? q.close ?? null;
                let iv = g.iv ?? q.iv ?? null;
                if (ivMercato && g.tipo !== 'F') {
                    const T = Math.max(0, giorniTra(new Date(), dataDa(g.scadenza))) / 365;
                    const b = carry != null && j.atm?.scadenza === g.scadenza ? carry : riporto(g.scadenza, imp, mkt);
                    const daMid = mid != null && indiceNuovo ? ivImplicita(g.tipo, mid, indiceNuovo, g.strike, T, tasso, b) : null;
                    iv = daMid != null ? Math.round(daMid * 100) / 100 : (q.iv ?? iv);
                }
                return { ...g, mid: mid ?? g.mid, ivIbkr: q.iv ?? null, iv, apertura: g.apertura ?? mid } as Gamba;
            }));
            const tipo = j.indice?.tipoDati ? ` (${j.indice.tipoDati})` : '';
            setStatoIbkr(`IBKR ${new Date().toLocaleTimeString('it-IT')}${tipo}${errori ? ` · ${errori} gambe non trovate` : ''}`);
        } catch (e) {
            setStatoIbkr(`IBKR non raggiungibile: ${e instanceof Error ? e.message : e}`);
        } finally {
            setInLettura(false);
        }
    }, [imp, mkt, ivMercato]);

    useEffect(() => {
        leggiRef.current = leggiIbkr;
    }, [leggiIbkr]);
    useEffect(() => { inLetturaRef.current = inLettura; }, [inLettura]);

    // auto: una lettura subito all'apertura della pagina, poi ogni 60 s
    useEffect(() => {
        if (!auto || !caricato || !locale) return;
        const leggi = () => { if (!inLetturaRef.current) leggiRef.current?.(); };
        leggi();
        const t = setInterval(leggi, 60_000);
        return () => clearInterval(t);
    }, [auto, caricato, locale]);

    // ----- scenario -----
    const oggiReale = useMemo(() => new Date(), []);
    const oggi = useMemo(() => new Date(oggiReale.getTime() + giorniAvanti * 86_400_000), [oggiReale, giorniAvanti]);
    const indiceLive = mkt.indiceLast ?? 0;
    const indice = indiceSim ?? indiceLive;
    const futureSim = mkt.futureLast != null ? mkt.futureLast + (indice - indiceLive) : null;
    const scenario: Scenario = useMemo(() => ({ indice, oggi, shiftIv, aScadenza }), [indice, oggi, shiftIv, aScadenza]);

    const aperte = gambe.filter(g => g.attiva && g.chiusura == null);
    const scadenzaMax = aperte.length ? aperte.map(g => g.scadenza).sort().at(-1)! : null;
    const giorniScad = scadenzaMax ? Math.max(0, giorniTra(oggi, dataDa(scadenzaMax))) : null;

    const tot = useMemo(() => totali(gambe, scenario, imp, mkt), [gambe, scenario, imp, mkt]);
    const valori = useMemo(() => new Map(gambe.map(g => [g.id, valutaGamba(g, scenario, imp, mkt)])), [gambe, scenario, imp, mkt]);

    // ----- range del grafico -----
    const [xMin, xMax] = useMemo(() => {
        if (!indice) return [0, 1];
        if (zoom === 'passi') return [indice - 5 * passo, indice + 5 * passo];
        if (zoom !== 'strike') { const p = Number(zoom) / 100; return [indice * (1 - p), indice * (1 + p)]; }
        const ks = aperte.filter(g => g.tipo !== 'F').map(g => g.strike).filter(k => k > 0);
        const lo = Math.min(indice, ...ks), hi = Math.max(indice, ...ks);
        const margine = Math.max((hi - lo) * 0.12, indice * 0.03);
        return [lo - margine, hi + margine];
    }, [indice, zoom, passo, aperte]);

    const xs = useMemo(() => griglia(xMin, xMax, 240), [xMin, xMax]);
    const ysOggi = useMemo(() => curva(gambe, scenario, imp, mkt, xs), [gambe, scenario, imp, mkt, xs]);
    const ysScad = useMemo(() => curva(gambe, { ...scenario, aScadenza: true }, imp, mkt, xs), [gambe, scenario, imp, mkt, xs]);
    const xsPassi = useMemo(() => Array.from({ length: 11 }, (_, i) => indice + (i - 5) * passo).filter(x => x >= xMin && x <= xMax), [indice, passo, xMin, xMax]);
    const ysPassi = useMemo(() => curva(gambe, scenario, imp, mkt, xsPassi), [gambe, scenario, imp, mkt, xsPassi]);

    // pareggi e massimi su un range largo, a scadenza (o alla data simulata)
    const largo = useMemo(() => griglia(Math.max(1, indice * 0.3), indice * 1.7, 1400), [indice]);
    const ysLargo = useMemo(() => curva(gambe, scenario, imp, mkt, largo), [gambe, scenario, imp, mkt, largo]);
    const be = useMemo(() => pareggi(largo, ysLargo), [largo, ysLargo]);
    const beGiu = be.filter(x => x < indice).at(-1) ?? null;
    const beSu = be.find(x => x > indice) ?? null;
    const ysLargoScad = useMemo(() => curva(gambe, { ...scenario, aScadenza: true }, imp, mkt, largo), [gambe, scenario, imp, mkt, largo]);
    const maxGuadagno = Math.max(...ysLargoScad);
    const maxPerdita = Math.min(...ysLargoScad);
    const xMaxGuadagno = largo[ysLargoScad.indexOf(maxGuadagno)];

    // ----- volatilita' d'ingresso (le due IV "estreme" che si annotano all'apertura) -----
    const opzAperte = aperte.filter(g => g.tipo !== 'F');
    const primaComprata = opzAperte.filter(g => g.qta > 0).sort((a, b) => b.strike - a.strike)[0] ?? null;
    const piuLontanaVenduta = opzAperte.filter(g => g.qta < 0).sort((a, b) => a.strike - b.strike)[0] ?? null;
    const livelliSupporto = useMemo(() => supporti.split(/[,;\s]+/).map(Number).filter(x => x > 0), [supporti]);

    const registraApertura = () => {
        const descr = [...opzAperte].sort((a, b) => b.strike - a.strike).map(g => `${g.qta > 0 ? '+' : ''}${g.qta} ${g.tipo}${g.strike}`).join(' / ');
        const scad = scadenzaMax ? dataDa(scadenzaMax).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) : '';
        setRegistro(r => [...r, {
            id: nuovoId(), apertura: isoGiorno(new Date()), scadenza: scad, last: mkt.indiceLast, ivAtm,
            ivPrimaComprata: primaComprata?.iv ?? null, ivLontana: piuLontanaVenduta?.iv ?? null, gambe: descr,
            chiusura: '', lastChiusura: null, pnl: null, note: '',
        }]);
    };
    const chiudiCiclo = (id: string) => setRegistro(r => r.map(c => (c.id === id
        ? { ...c, chiusura: isoGiorno(new Date()), lastChiusura: mkt.indiceLast, pnl: Math.round(tot.netto * 100) / 100 } : c)));
    const aggiornaCiclo = (id: string, p: Partial<Ciclo>) => setRegistro(r => r.map(c => (c.id === id ? { ...c, ...p } : c)));
    const totaleRegistro = registro.reduce((t, c) => t + (c.pnl ?? 0), 0);

    // ----- gruppi (vertical) -----
    const gruppi = useMemo(() => {
        const m = new Map<string, Gamba[]>();
        for (const g of gambe) if (g.attiva && g.gruppo) m.set(g.gruppo, [...(m.get(g.gruppo) ?? []), g]);
        return [...m.entries()].map(([nome, gs]) => {
            const apertura = gs.reduce((s, g) => s + g.qta * (g.apertura ?? 0), 0);
            const ultimo = gs.every(g => g.mid != null || g.chiusura != null)
                ? gs.reduce((s, g) => s + g.qta * (g.chiusura ?? g.mid ?? 0), 0) : null;
            const sim = gs.reduce((s, g) => s + g.qta * (valori.get(g.id)?.valore ?? 0), 0);
            const opz = gs.filter(g => g.tipo !== 'F').map(g => g.strike);
            const larghezza = opz.length >= 2 ? Math.max(...opz) - Math.min(...opz) : null;
            const pnl = gs.reduce((s, g) => s + (valori.get(g.id)?.eurPnl ?? 0), 0);
            return { nome, gs, apertura, ultimo, sim, larghezza, pnl };
        });
    }, [gambe, valori]);

    // ----- azioni sulle gambe -----
    const aggiorna = (id: string, p: Partial<Gamba>) => setGambe(gs => gs.map(g => (g.id === id ? { ...g, ...p } : g)));
    const togli = (id: string) => setGambe(gs => gs.filter(g => g.id !== id));
    const aggiungi = (tipo: TipoGamba) => setGambe(gs => [...gs, gamba({
        tipo, qta: tipo === 'F' ? -1 : 1, strike: tipo === 'F' ? 0 : Math.round(indiceLive / 100) * 100,
        scadenza: gs.at(-1)?.scadenza ?? isoGiorno(scadenzaVicinaA(new Date(), 90)),
        apertura: tipo === 'F' ? mkt.futureLast : null,
    })]);

    const calcolaIv = () => setGambe(gs => gs.map(g => {
        if (g.tipo === 'F' || g.chiusura != null || !indiceLive) return g;
        const prezzo = g.mid ?? g.apertura;
        const T = Math.max(0, giorniTra(new Date(), dataDa(g.scadenza))) / 365;
        const iv = prezzo != null ? ivImplicita(g.tipo, prezzo, indiceLive, g.strike, T, imp.tasso / 100, riporto(g.scadenza, imp, mkt)) : null;
        return iv != null ? { ...g, iv: Math.round(iv * 100) / 100 } : g;
    }));
    const usaIvIbkr = () => setGambe(gs => gs.map(g => (g.ivIbkr != null ? { ...g, iv: g.ivIbkr } : g)));

    // ----- grafico -----
    const datiGrafico = useMemo(() => ({
        datasets: [
            {
                label: aScadenza ? 'A scadenza' : `Al ${oggi.toLocaleDateString('it-IT')}`,
                data: xs.map((x, i) => ({ x, y: ysOggi[i] })),
                borderColor: '#60a5fa', borderWidth: 2.5, pointRadius: 0, tension: 0,
                segment: { borderColor: (c: { p1: { parsed: { y: number } } }) => (c.p1.parsed.y >= 0 ? '#22c55e' : '#ef4444') },
                fill: { target: 'origin', above: 'rgba(34,197,94,0.07)', below: 'rgba(239,68,68,0.07)' },
            },
            {
                label: 'Payoff a scadenza',
                data: xs.map((x, i) => ({ x, y: ysScad[i] })),
                borderColor: '#8b5cf6', borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, hidden: aScadenza,
            },
            {
                label: 'passi',
                data: xsPassi.map((x, i) => ({ x, y: ysPassi[i] })),
                hidden: zoom !== 'passi',
                showLine: false, pointRadius: 4, pointBackgroundColor: '#0c0d10', pointBorderColor: '#e2e8f0', pointBorderWidth: 1.5,
            },
            {
                label: 'adesso',
                data: [{ x: indice, y: tot.netto }],
                showLine: false, pointRadius: 9, pointBackgroundColor: '#facc15', pointBorderColor: '#0c0d10', pointBorderWidth: 2,
            },
        ],
    }), [xs, ysOggi, ysScad, xsPassi, ysPassi, indice, tot.netto, aScadenza, oggi, zoom]);

    const opzioniGrafico = useMemo(() => {
        const annotazioni: Record<string, object> = {
            zero: { type: 'line', yMin: 0, yMax: 0, borderColor: 'rgba(148,163,184,0.5)', borderWidth: 1, borderDash: [4, 4] },
            spot: {
                type: 'line', xMin: indice, xMax: indice, borderColor: '#06b6d4', borderWidth: 1.5,
                label: { display: true, content: `DAX ${fmt(indice, 0)}`, position: 'start', backgroundColor: '#0e7490', color: '#ecfeff', font: { size: 9, weight: 'bold' } },
            },
        };
        if (indiceSim != null && indiceLive) annotazioni.live = { type: 'line', xMin: indiceLive, xMax: indiceLive, borderColor: 'rgba(6,182,212,0.35)', borderWidth: 1, borderDash: [2, 3] };
        be.forEach((x, i) => {
            if (x >= xMin && x <= xMax) annotazioni[`be${i}`] = {
                type: 'line', xMin: x, xMax: x, borderColor: '#f59e0b', borderWidth: 1, borderDash: [5, 4],
                label: { display: true, content: `BE ${fmt(x, 0)}`, position: 'end', backgroundColor: 'rgba(120,53,15,0.85)', color: '#fde68a', font: { size: 10 } },
            };
        });
        livelliSupporto.forEach((x, i) => {
            if (x >= xMin && x <= xMax) annotazioni[`sup${i}`] = {
                type: 'line', xMin: x, xMax: x, borderColor: 'rgba(226,232,240,0.45)', borderWidth: 1, borderDash: [1, 3],
                label: { display: true, content: fmt(x, 0), position: 'center', rotation: -90, backgroundColor: 'rgba(15,23,42,0.85)', color: '#cbd5e1', font: { size: 9 } },
            };
        });
        const strikeVisti = new Set<number>();
        aperte.filter(g => g.tipo !== 'F').forEach(g => {
            if (strikeVisti.has(g.strike) || g.strike < xMin || g.strike > xMax) return;
            strikeVisti.add(g.strike);
            annotazioni[`k${g.strike}`] = {
                type: 'line', xMin: g.strike, xMax: g.strike, borderColor: g.qta > 0 ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)', borderWidth: 1,
                label: { display: true, content: `${g.qta > 0 ? '+' : ''}${g.qta} ${g.tipo}${g.strike}`, position: 'start', yAdjust: 22, backgroundColor: 'transparent', color: g.qta > 0 ? '#4ade80' : '#f87171', font: { size: 9 } },
            };
        });
        return {
            responsive: true, maintainAspectRatio: false, animation: false as const,
            interaction: { mode: 'nearest' as const, intersect: false, axis: 'x' as const },
            plugins: {
                legend: { display: false },
                annotation: { annotations: annotazioni },
                tooltip: {
                    filter: (it: { dataset: { label?: string } }) => it.dataset.label !== 'passi',
                    callbacks: {
                        title: (it: { parsed: { x: number } }[]) => `DAX ${fmt(it[0]?.parsed.x, 0)} (${fmt(((it[0]?.parsed.x ?? 0) / indiceLive - 1) * 100, 1)}%)`,
                        label: (it: { dataset: { label?: string }; parsed: { y: number } }) => `${it.dataset.label}: ${eur(it.parsed.y)}`,
                    },
                },
            },
            scales: {
                x: { type: 'linear' as const, min: xMin, max: xMax, ticks: { color: '#94a3b8', callback: (v: string | number) => fmt(Number(v), 0) }, grid: { color: 'rgba(51,65,85,0.3)' } },
                y: { ticks: { color: '#94a3b8', callback: (v: string | number) => `${fmt(Number(v), 0)} €` }, grid: { color: 'rgba(51,65,85,0.3)' } },
            },
        };
    }, [indice, indiceSim, indiceLive, be, xMin, xMax, aperte, livelliSupporto]);

    const varIndice = mkt.indiceLast && mkt.indiceClose ? (mkt.indiceLast / mkt.indiceClose - 1) * 100 : null;
    const varFuture = mkt.futureLast && mkt.futureClose ? (mkt.futureLast / mkt.futureClose - 1) * 100 : null;
    const spostaIndice = (d: number) => setIndiceSim(Math.round((indice + d) * 100) / 100);

    return (
        <main className="min-h-screen bg-[#0c0d10] text-slate-300 p-2 md:p-3 font-sans">
            <div className="w-full max-w-[1920px] mx-auto space-y-2">
                {/* intestazione */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">DAX · Put spread finanziati</h1>
                        <p className="text-[10px] text-slate-500">2 vertical di put a ~90 giorni pagati vendendo put lontane: DAX su = nessuna perdita, DAX giù = guadagno fino alle put vendute.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Bottone tono="blu" onClick={() => setMostraTv(true)} titolo="Grafico TradingView a candele giornaliere">📈 GRAFICO DAX</Bottone>
                        <Bottone onClick={leggiIbkr} disabled={inLettura || !locale} titolo="Indice, future e quote delle gambe da TWS (solo locale)">{inLettura ? 'LETTURA…' : '⟳ AGGIORNA DA IBKR'}</Bottone>
                        <label className="flex items-center gap-1 text-[10px] text-slate-400" title="Rilegge IBKR ogni 60 secondi">
                            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={!locale} /> auto 60s
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-slate-400" title="A ogni lettura IBKR la IV di ogni gamba si ricalcola dal mid: grafico e P&L seguono i prezzi di mercato. Spento = IV scritte a mano">
                            <input type="checkbox" checked={ivMercato} onChange={(e) => setIvMercato(e.target.checked)} /> IV dal mercato
                        </label>
                        <Link href="/market" className="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-[10px] transition-colors">← MARKET</Link>
                    </div>
                </div>
                {statoIbkr && <div className="text-[10px] text-slate-500">{statoIbkr}</div>}
                {!locale && <div className="text-amber-300 bg-amber-950/30 border border-amber-900/50 p-2 rounded text-[10px]">Su Vercel non c&apos;è IBKR: prezzi a mano, posizione salvata solo in questo browser.</div>}

                {/* riga 1: mercato, impostazioni, date, simulazione, pareggi */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-2">
                    <Card titolo={<>S1 · indice DAX</>}>
                        <div className="text-xl font-bold font-mono text-cyan-400">{fmt(mkt.indiceLast, 0)}</div>
                        <div className={`text-xs font-mono ${colore(varIndice)}`}>{varIndice == null ? '—' : `${varIndice > 0 ? '+' : ''}${fmt(varIndice)}%`}</div>
                        <div className={`text-[9px] ${fonteIndice.startsWith('da future') ? 'text-amber-400' : 'text-slate-500'}`}>{fonteIndice}</div>
                        <div className="mt-2 space-y-1">
                            <Campo etichetta="last"><Num valore={mkt.indiceLast} onChange={(v) => { setFonteIndice('a mano'); setMkt(m => ({ ...m, indiceLast: v })); }} className="w-20" /></Campo>
                            <Campo etichetta="close"><Num valore={mkt.indiceClose} onChange={(v) => setMkt(m => ({ ...m, indiceClose: v }))} className="w-20" /></Campo>
                        </div>
                    </Card>

                    <Card titolo={<>S2 · future <select value={imp.classeFuture} onChange={(e) => {
                        const c = e.target.value as Impostazioni['classeFuture'];
                        setImp(i => ({ ...i, classeFuture: c, moltFuture: c === 'FDAX' ? 25 : c === 'FDXM' ? 5 : 1 }));
                    }} className="ml-1 bg-slate-900 border border-slate-700 rounded text-[9px] text-slate-300">
                        <option value="FDAX">FDAX</option><option value="FDXM">FDXM</option><option value="FDXS">FDXS</option>
                    </select></>}>
                        <div className="text-xl font-bold font-mono text-violet-400">{fmt(mkt.futureLast, 0)}</div>
                        <div className={`text-xs font-mono ${colore(varFuture)}`}>
                            {varFuture == null ? '—' : `${varFuture > 0 ? '+' : ''}${fmt(varFuture)}%`}
                            {mkt.futureLast != null && mkt.indiceLast != null && <span className="text-slate-500 ml-2">base {fmt(mkt.futureLast - mkt.indiceLast, 1)}</span>}
                        </div>
                        {Object.entries(mkt.carry ?? {}).map(([sc, c]) => (
                            <div key={sc} className="text-[9px] text-slate-500" title="Riporto implicito dalla parità put-call ATM: le opzioni si prezzano sul forward indice·e^(riporto·T)">
                                riporto {sc} <span className="font-mono text-slate-300">{fmt(c * 100, 2)}%</span>
                            </div>
                        ))}
                        <div className="mt-2 space-y-1">
                            <Campo etichetta="last"><Num valore={mkt.futureLast} onChange={(v) => setMkt(m => ({ ...m, futureLast: v }))} className="w-20" /></Campo>
                            <Campo etichetta="close"><Num valore={mkt.futureClose} onChange={(v) => setMkt(m => ({ ...m, futureClose: v }))} className="w-20" /></Campo>
                        </div>
                    </Card>

                    <Card titolo="Moltiplicatori e commissioni">
                        <div className="space-y-1">
                            <Campo etichetta="molt. opzioni €"><Num valore={imp.moltOpzioni} onChange={(v) => setImp(i => ({ ...i, moltOpzioni: v ?? 5 }))} className="w-16" /></Campo>
                            <Campo etichetta="molt. future €"><Num valore={imp.moltFuture} onChange={(v) => setImp(i => ({ ...i, moltFuture: v ?? 5 }))} className="w-16" /></Campo>
                            <Campo etichetta="comm. opzioni €"><Num valore={imp.commOpzioni} onChange={(v) => setImp(i => ({ ...i, commOpzioni: v ?? 0 }))} className="w-16" /></Campo>
                            <Campo etichetta="comm. future €"><Num valore={imp.commFuture} onChange={(v) => setImp(i => ({ ...i, commFuture: v ?? 0 }))} className="w-16" /></Campo>
                            <Campo etichetta="tasso %"><Num valore={imp.tasso} onChange={(v) => setImp(i => ({ ...i, tasso: v ?? 0 }))} className="w-16" /></Campo>
                        </div>
                        <div className="mt-2 pt-2 border-t border-slate-700 text-[10px] space-y-0.5">
                            <div className="flex justify-between"><span className="text-slate-500">commissioni pagate</span><span className="font-mono text-amber-300">{eur(tot.commPagate)}</span></div>
                            <div className="flex justify-between"><span className="text-slate-500">da pagare</span><span className="font-mono text-amber-300">{eur(tot.commDaPagare)}</span></div>
                        </div>
                    </Card>

                    <Card titolo="Date">
                        <div className="text-[9px] text-slate-500">OGGI {giorniAvanti !== 0 && <span className="text-amber-400">(simulato {giorniAvanti > 0 ? '+' : ''}{giorniAvanti} g)</span>}</div>
                        <div className="text-xs font-bold text-slate-200 capitalize">{dataLunga(oggi)}</div>
                        <div className="flex gap-1 mt-1">
                            <Bottone onClick={() => setGiorniAvanti(g => g - 1)}>− giorno</Bottone>
                            <Bottone onClick={() => setGiorniAvanti(g => g + 1)}>+ giorno</Bottone>
                            <Bottone onClick={() => setGiorniAvanti(g => g + 7)}>+7</Bottone>
                            {giorniAvanti !== 0 && <Bottone onClick={() => setGiorniAvanti(0)}>↺</Bottone>}
                        </div>
                        <div className="text-[9px] text-slate-500 mt-2">SCADENZA</div>
                        <div className="text-xs font-bold text-amber-400 capitalize">{scadenzaMax ? dataLunga(dataDa(scadenzaMax)) : '—'}</div>
                        <div className="flex items-baseline gap-2 mt-1">
                            <span className="text-xl font-bold font-mono text-slate-100">{giorniScad ?? '—'}</span>
                            <span className="text-[10px] text-slate-500">giorni a scadenza</span>
                        </div>
                    </Card>

                    <Card titolo={<>Indice simulato {indiceSim != null && <span className="text-amber-400 normal-case">({fmt((indice / indiceLive - 1) * 100, 2)}%)</span>}</>}>
                        <div className="text-xl font-bold font-mono text-cyan-300">{fmt(indice, 0)}</div>
                        <div className="text-[10px] text-slate-500">future {fmt(futureSim, 0)}</div>
                        <div className="grid grid-cols-2 gap-1 mt-2">
                            <Bottone tono="rosso" onClick={() => spostaIndice(-passo)}>− {passo}</Bottone>
                            <Bottone tono="verde" onClick={() => spostaIndice(passo)}>+ {passo}</Bottone>
                            <Bottone tono="rosso" onClick={() => spostaIndice(-indice * 0.01)}>−1%</Bottone>
                            <Bottone tono="verde" onClick={() => spostaIndice(indice * 0.01)}>+1%</Bottone>
                        </div>
                        <div className="flex items-center justify-between gap-1 mt-2">
                            <Campo etichetta="passo"><Num valore={passo} onChange={(v) => setPasso(Math.max(1, v ?? 100))} className="w-14" /></Campo>
                            {indiceSim != null && <Bottone onClick={() => setIndiceSim(null)} titolo="Torna all'indice reale">↺ live</Bottone>}
                        </div>
                    </Card>

                    <Card titolo="Break even giù & su">
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <div className="text-[9px] text-slate-500">GIÙ</div>
                                <div className="text-base font-bold font-mono text-red-400">{beGiu != null ? fmt(beGiu, 0) : 'nessuno'}</div>
                                <div className="text-[10px] font-mono text-slate-400">{beGiu != null ? `${fmt((beGiu / indice - 1) * 100, 2)}%` : ''}</div>
                            </div>
                            <div>
                                <div className="text-[9px] text-slate-500">SU</div>
                                <div className="text-base font-bold font-mono text-green-400">{beSu != null ? fmt(beSu, 0) : 'nessuno'}</div>
                                <div className="text-[10px] font-mono text-slate-400">{beSu != null ? `+${fmt((beSu / indice - 1) * 100, 2)}%` : ''}</div>
                            </div>
                        </div>
                        <div className="mt-2 pt-2 border-t border-slate-700 text-[10px] space-y-0.5">
                            <div className="flex justify-between"><span className="text-slate-500">max guadagno a scad.</span><span className="font-mono text-green-400">{eur(maxGuadagno, 0)}</span></div>
                            <div className="flex justify-between"><span className="text-slate-500">… con DAX a</span><span className="font-mono text-slate-300">{fmt(xMaxGuadagno, 0)}</span></div>
                            <div className="flex justify-between"><span className="text-slate-500">max perdita (−70%/+70%)</span><span className="font-mono text-red-400">{eur(maxPerdita, 0)}</span></div>
                        </div>
                    </Card>
                </div>

                {/* riga 2: grafico + riepilogo */}
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-2">
                    <Card className="flex flex-col">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2 text-[10px]">
                                <span className="text-xs font-bold text-blue-400">P&amp;L TOTALE</span>
                                <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-green-500 inline-block" />{aScadenza ? 'a scadenza' : `al ${oggi.toLocaleDateString('it-IT')}`}</span>
                                {!aScadenza && <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-violet-500 inline-block" />a scadenza</span>}
                                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />adesso</span>
                            </div>
                            <label className="flex items-center gap-1 text-[10px] text-slate-500" title="Supporti, minimi e gap da chiudere: linee puntinate sul grafico (dove piazzare il secondo vertical)">
                                supporti/gap
                                <input value={supporti} onChange={(e) => setSupporti(e.target.value)}
                                    className="w-44 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-slate-300" />
                            </label>
                            <div className="flex items-center gap-1">
                                {(['strike', 'passi', '10', '25', '40'] as Zoom[]).map(z => (
                                    <button key={z} onClick={() => setZoom(z)}
                                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${zoom === z ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-200'}`}>
                                        {z === 'strike' ? 'strike' : z === 'passi' ? '±5 passi' : `±${z}%`}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="relative flex-1 min-h-[300px]">
                            <Line data={datiGrafico as never} options={opzioniGrafico as never} plugins={[etichettePassi as never]} />
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
                            <Bottone tono="rosso" onClick={() => setShiftIv(s => s + 1)} titolo="Tutte le IV +1 punto">IV +1 (what if)</Bottone>
                            <Bottone tono="rosso" onClick={() => spostaIndice(-indice * 0.01)}>INDICE −1%</Bottone>
                            <Bottone tono={aScadenza ? 'viola' : 'neutro'} onClick={() => setAScadenza(a => !a)} titolo="Valuta tutto a scadenza">
                                {aScadenza ? '● PAYOFF A SCADENZA' : '○ PAYOFF A SCADENZA'}
                            </Bottone>
                            <Bottone tono="verde" onClick={() => spostaIndice(indice * 0.01)}>INDICE +1%</Bottone>
                            <Bottone tono="verde" onClick={() => setShiftIv(s => s - 1)} titolo="Tutte le IV −1 punto">IV −1 (what if)</Bottone>
                            {(shiftIv !== 0 || indiceSim != null || giorniAvanti !== 0 || aScadenza) && (
                                <Bottone tono="ambra" onClick={() => { setShiftIv(0); setIndiceSim(null); setGiorniAvanti(0); setAScadenza(false); }}>
                                    ↺ AZZERA SIMULAZIONE{shiftIv !== 0 ? ` (IV ${shiftIv > 0 ? '+' : ''}${shiftIv})` : ''}
                                </Bottone>
                            )}
                        </div>
                    </Card>

                    <div className="space-y-2">
                        <Card titolo="Total P&L + commissioni">
                            <div className={`text-2xl font-bold font-mono text-center py-2 ${colore(tot.netto)}`}>{eur(tot.netto)}</div>
                            <div className="text-[10px] space-y-0.5">
                                <div className="flex justify-between"><span className="text-slate-500">P&amp;L posizioni aperte</span><span className={`font-mono ${colore(tot.pnlAperte)}`}>{eur(tot.pnlAperte)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">P&amp;L realizzato</span><span className={`font-mono ${colore(tot.realizzato)}`}>{eur(tot.realizzato)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">commissioni totali</span><span className="font-mono text-amber-300">−{eur(tot.commPagate + tot.commDaPagare)}</span></div>
                            </div>
                        </Card>
                        <Card titolo="Greche · totale posizione">
                            <div className="grid grid-cols-2 gap-2 text-center">
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">DELTA</div>
                                    <div className={`text-sm font-bold font-mono ${colore(tot.deltaContratti)}`}>{fmt(tot.deltaContratti, 3)}</div>
                                    <div className="text-[9px] text-slate-500">{eur(tot.deltaEur)} / punto</div>
                                </div>
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">GAMMA</div>
                                    <div className={`text-sm font-bold font-mono ${colore(tot.gammaQ)}`}>{fmt(tot.gammaQ, 5)}</div>
                                    <div className="text-[9px] text-slate-500">{eur(tot.gammaQ * imp.moltOpzioni * 100, 2)} / 100 pt²</div>
                                </div>
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">THETA</div>
                                    <div className={`text-sm font-bold font-mono ${colore(tot.thetaEur)}`}>{eur(tot.thetaEur)}</div>
                                    <div className="text-[9px] text-slate-500">al giorno</div>
                                </div>
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">VEGA</div>
                                    <div className={`text-sm font-bold font-mono ${colore(tot.vegaEur)}`}>{eur(tot.vegaEur)}</div>
                                    <div className="text-[9px] text-slate-500">per +1 punto IV</div>
                                </div>
                            </div>
                        </Card>
                        <Card titolo="Volatilità d'ingresso · skew">
                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">IV ATM</div>
                                    <Num valore={ivAtm} onChange={setIvAtm} className="w-16 text-cyan-300 font-bold" />
                                </div>
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">1ª comprata {primaComprata ? primaComprata.strike : ''}</div>
                                    <div className="text-sm font-bold font-mono text-green-400">{fmt(primaComprata?.iv, 1)}</div>
                                </div>
                                <div className="bg-slate-900/60 rounded p-2">
                                    <div className="text-[9px] text-slate-500">venduta lontana {piuLontanaVenduta ? piuLontanaVenduta.strike : ''}</div>
                                    <div className="text-sm font-bold font-mono text-red-400">{fmt(piuLontanaVenduta?.iv, 1)}</div>
                                </div>
                            </div>
                            {ivAtm != null && piuLontanaVenduta?.iv != null && (
                                <div className="mt-2 text-[10px] flex justify-between">
                                    <span className="text-slate-500">skew lontana / ATM</span>
                                    <span className="font-mono text-amber-300">{fmt(piuLontanaVenduta.iv / ivAtm, 2)}× · +{fmt(piuLontanaVenduta.iv - ivAtm, 1)} punti</span>
                                </div>
                            )}
                            {piuLontanaVenduta && indice > 0 && (
                                <div className="text-[10px] flex justify-between">
                                    <span className="text-slate-500">distanza put vendute</span>
                                    <span className={`font-mono ${(1 - piuLontanaVenduta.strike / indice) >= 0.35 ? 'text-green-400' : 'text-amber-400'}`}>−{fmt((1 - piuLontanaVenduta.strike / indice) * 100, 1)}% (regola ~40%)</span>
                                </div>
                            )}
                            <p className="mt-1 text-[9px] text-slate-500">Si entra quando la IV vicino allo spot è bassa e quella delle put lontane resta alta: i vertical costano poco e le vendute incassano di più.</p>
                        </Card>
                        {gruppi.length > 0 && (
                            <Card titolo="Vertical / gruppi">
                                <table className="w-full text-[10px]">
                                    <thead><tr className="text-slate-500"><th className="text-left">gr.</th><th className="text-right">largh.</th><th className="text-right">apertura</th><th className="text-right">ultimo</th><th className="text-right">P&amp;L</th></tr></thead>
                                    <tbody>
                                        {gruppi.map(gr => (
                                            <tr key={gr.nome} className="border-t border-slate-800">
                                                <td className="font-bold text-slate-200">{gr.nome}</td>
                                                <td className="text-right font-mono">{gr.larghezza ?? '—'}</td>
                                                <td className="text-right font-mono" title={gr.apertura > 0 ? 'debito' : 'credito'}>
                                                    {fmt(Math.abs(gr.apertura))} <span className={gr.apertura > 0 ? 'text-red-400' : 'text-green-400'}>{gr.apertura > 0 ? 'D' : 'C'}</span>
                                                </td>
                                                <td className="text-right font-mono">{gr.ultimo != null ? fmt(Math.abs(gr.ultimo)) : '—'}</td>
                                                <td className={`text-right font-mono ${colore(gr.pnl)}`}>{eur(gr.pnl, 0)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </Card>
                        )}
                    </div>
                </div>

                {/* riga 3: gambe */}
                <Card>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-bold text-blue-400">GAMBE · ODAX / future</span>
                        <div className="flex flex-wrap gap-1.5">
                            <Bottone onClick={() => aggiungi('P')}>+ PUT</Bottone>
                            <Bottone onClick={() => aggiungi('C')}>+ CALL</Bottone>
                            <Bottone onClick={() => aggiungi('F')}>+ FUTURE</Bottone>
                            <Bottone tono="viola" onClick={() => setMostraModello(true)} titolo="Costruisce la strategia: 2 vertical di put + put lontane vendute">✦ MODELLO STRATEGIA</Bottone>
                            <Bottone tono="blu" onClick={calcolaIv} titolo="IV implicita dal mid (o dal prezzo di apertura) con l'indice attuale">CALCOLA IV</Bottone>
                            <Bottone onClick={usaIvIbkr} disabled={!gambe.some(g => g.ivIbkr != null)} titolo="Copia la IV del modello IBKR">IV DA IBKR</Bottone>
                            <Bottone tono="rosso" onClick={() => setGambe(gs => gs.map(g => ({ ...g, iv: null })))}>CANCELLA IV</Bottone>
                            <Bottone tono="rosso" onClick={() => { if (confirm('Cancellare tutte le gambe?')) setGambe([]); }}>CANCELLA GAMBE</Bottone>
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-[10px] whitespace-nowrap">
                            <thead>
                                <tr className="text-[9px] text-slate-500 uppercase border-b border-slate-700">
                                    <th className="p-1">on</th><th className="p-1">qta</th><th className="p-1">tipo</th><th className="p-1">gr.</th>
                                    <th className="p-1">strike</th><th className="p-1">dist.</th><th className="p-1">scadenza</th><th className="p-1">IV %</th><th className="p-1">IV IBKR</th>
                                    <th className="p-1">apertura</th><th className="p-1">chiusura</th><th className="p-1">data ap.</th><th className="p-1">mid</th>
                                    <th className="p-1 text-right">valore sim.</th><th className="p-1 text-right">punti</th><th className="p-1 text-right">P&amp;L €</th>
                                    <th className="p-1 text-right">delta</th><th className="p-1 text-right">gamma</th><th className="p-1 text-right">theta €</th><th className="p-1 text-right">vega €</th><th />
                                </tr>
                            </thead>
                            <tbody>
                                {gambe.map(g => {
                                    const v = valori.get(g.id)!;
                                    const riga = !g.attiva ? 'opacity-40' : g.chiusura != null ? 'bg-slate-800/40' : g.qta > 0 ? 'bg-green-950/20' : 'bg-red-950/20';
                                    return (
                                        <tr key={g.id} className={`border-b border-slate-800 ${riga}`}>
                                            <td className="p-1 text-center"><input type="checkbox" checked={g.attiva} onChange={(e) => aggiorna(g.id, { attiva: e.target.checked })} /></td>
                                            <td className="p-1"><Num valore={g.qta} passo="1" onChange={(x) => aggiorna(g.id, { qta: x ?? 0 })} className={`w-12 ${g.qta > 0 ? 'text-green-400' : 'text-red-400'}`} /></td>
                                            <td className="p-1">
                                                <select value={g.tipo} onChange={(e) => aggiorna(g.id, { tipo: e.target.value as TipoGamba })}
                                                    className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200">
                                                    <option value="P">P</option><option value="C">C</option><option value="F">F</option>
                                                </select>
                                            </td>
                                            <td className="p-1"><input value={g.gruppo} onChange={(e) => aggiorna(g.id, { gruppo: e.target.value.toUpperCase().slice(0, 6) })}
                                                className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center text-slate-200" /></td>
                                            <td className="p-1">{g.tipo === 'F' ? <span className="text-slate-600">—</span> : <Num valore={g.strike} passo="50" onChange={(x) => aggiorna(g.id, { strike: x ?? 0 })} className="w-16" />}</td>
                                            <td className="p-1 text-right font-mono text-slate-500">{g.tipo !== 'F' && g.strike > 0 && indice > 0 ? `${fmt((g.strike / indice - 1) * 100, 1)}%` : ''}</td>
                                            <td className="p-1">
                                                <input type="date" value={g.scadenza} onChange={(e) => aggiorna(g.id, { scadenza: e.target.value })}
                                                    list="scadenze-odax" className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-200 [color-scheme:dark]" />
                                            </td>
                                            <td className="p-1">{g.tipo === 'F' ? null : <Num valore={g.iv} onChange={(x) => aggiorna(g.id, { iv: x })} className="w-14" />}</td>
                                            <td className="p-1 font-mono text-slate-500 text-right">{g.ivIbkr != null ? fmt(g.ivIbkr) : '—'}</td>
                                            <td className="p-1"><Num valore={g.apertura} onChange={(x) => aggiorna(g.id, { apertura: x })} className="w-16" /></td>
                                            <td className="p-1"><Num valore={g.chiusura} onChange={(x) => aggiorna(g.id, { chiusura: x })} className="w-16" placeholder="aperta" /></td>
                                            <td className="p-1"><input type="date" value={g.dataApertura} onChange={(e) => aggiorna(g.id, { dataApertura: e.target.value })}
                                                className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-slate-400 [color-scheme:dark]" /></td>
                                            <td className="p-1"><Num valore={g.mid} onChange={(x) => aggiorna(g.id, { mid: x })} className="w-16 text-sky-300" /></td>
                                            <td className="p-1 text-right font-mono">{fmt(v.valore)}</td>
                                            <td className={`p-1 text-right font-mono ${colore(v.puntiPnl)}`}>{fmt(v.puntiPnl)}</td>
                                            <td className={`p-1 text-right font-mono font-bold ${colore(v.eurPnl)}`}>{eur(v.eurPnl)}</td>
                                            <td className="p-1 text-right font-mono">{fmt(v.deltaQ, 4)}</td>
                                            <td className="p-1 text-right font-mono">{fmt(v.gammaQ, 5)}</td>
                                            <td className={`p-1 text-right font-mono ${colore(v.thetaEur)}`}>{fmt(v.thetaEur)}</td>
                                            <td className={`p-1 text-right font-mono ${colore(v.vegaEur)}`}>{fmt(v.vegaEur)}</td>
                                            <td className="p-1"><button onClick={() => togli(g.id)} className="text-slate-600 hover:text-red-400" title="Elimina gamba">✕</button></td>
                                        </tr>
                                    );
                                })}
                                {gambe.length === 0 && <tr><td colSpan={21} className="p-4 text-center text-slate-500">Nessuna gamba: aggiungine una o usa MODELLO STRATEGIA.</td></tr>}
                            </tbody>
                        </table>
                        <datalist id="scadenze-odax">
                            {scadenzeIbkr.map(s => <option key={s} value={`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`} />)}
                        </datalist>
                    </div>
                    <p className="mt-2 text-[9px] text-slate-500">
                        Valore simulato con Black-Scholes (opzioni europee, DAX total return: dividendi 0) all&apos;indice, data e IV della simulazione.
                        Gamba con &quot;chiusura&quot; = chiusa, entra nel P&amp;L realizzato. Commissioni: {eur(imp.commOpzioni)} per contratto per lato; a scadenza le opzioni che scadono a zero non pagano la chiusura.
                    </p>
                </Card>
                <Card>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-bold text-blue-400">REGISTRO CICLI</span>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-400">totale chiusi <span className={`font-mono font-bold ${colore(totaleRegistro)}`}>{eur(totaleRegistro)}</span></span>
                            <Bottone tono="viola" onClick={registraApertura} disabled={!opzAperte.length} titolo="Annota oggi: indice, IV ATM, IV della 1ª comprata e della venduta più lontana, gambe">+ REGISTRA APERTURA</Bottone>
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-[10px] whitespace-nowrap">
                            <thead>
                                <tr className="text-[9px] text-slate-500 uppercase border-b border-slate-700">
                                    <th className="p-1 text-left">apertura</th><th className="p-1">scad.</th><th className="p-1 text-right">last</th>
                                    <th className="p-1 text-right">IV ATM</th><th className="p-1 text-right">IV 1ª comprata</th><th className="p-1 text-right">IV lontana</th>
                                    <th className="p-1 text-left">gambe</th><th className="p-1">chiusura</th><th className="p-1 text-right">last</th><th className="p-1 text-right">var %</th>
                                    <th className="p-1 text-right">P&amp;L €</th><th className="p-1 text-left">note</th><th />
                                </tr>
                            </thead>
                            <tbody>
                                {[...registro].sort((a, b) => b.apertura.localeCompare(a.apertura)).map(c => (
                                    <tr key={c.id} className="border-b border-slate-800">
                                        <td className="p-1"><input type="date" value={c.apertura} onChange={(e) => aggiornaCiclo(c.id, { apertura: e.target.value })} className="bg-transparent text-slate-300 [color-scheme:dark]" /></td>
                                        <td className="p-1"><input value={c.scadenza} onChange={(e) => aggiornaCiclo(c.id, { scadenza: e.target.value })} className="w-14 bg-transparent text-amber-400 text-center" /></td>
                                        <td className="p-1"><Num valore={c.last} onChange={(v) => aggiornaCiclo(c.id, { last: v })} className="w-16" /></td>
                                        <td className="p-1"><Num valore={c.ivAtm} onChange={(v) => aggiornaCiclo(c.id, { ivAtm: v })} className="w-14 text-cyan-300" /></td>
                                        <td className="p-1"><Num valore={c.ivPrimaComprata} onChange={(v) => aggiornaCiclo(c.id, { ivPrimaComprata: v })} className="w-14" /></td>
                                        <td className="p-1"><Num valore={c.ivLontana} onChange={(v) => aggiornaCiclo(c.id, { ivLontana: v })} className="w-14" /></td>
                                        <td className="p-1"><input value={c.gambe} onChange={(e) => aggiornaCiclo(c.id, { gambe: e.target.value })} className="w-60 bg-transparent font-mono text-slate-400" /></td>
                                        <td className="p-1"><input type="date" value={c.chiusura} onChange={(e) => aggiornaCiclo(c.id, { chiusura: e.target.value })} className="bg-transparent text-slate-300 [color-scheme:dark]" /></td>
                                        <td className="p-1"><Num valore={c.lastChiusura} onChange={(v) => aggiornaCiclo(c.id, { lastChiusura: v })} className="w-16" /></td>
                                        <td className={`p-1 text-right font-mono ${colore(c.last && c.lastChiusura ? c.lastChiusura - c.last : null)}`}>{c.last && c.lastChiusura ? `${fmt((c.lastChiusura / c.last - 1) * 100, 1)}%` : ''}</td>
                                        <td className="p-1"><Num valore={c.pnl} onChange={(v) => aggiornaCiclo(c.id, { pnl: v })} className={`w-20 font-bold ${colore(c.pnl)}`} /></td>
                                        <td className="p-1"><input value={c.note} onChange={(e) => aggiornaCiclo(c.id, { note: e.target.value })} className="w-36 bg-transparent text-slate-400" /></td>
                                        <td className="p-1">
                                            <div className="flex gap-1">
                                                {!c.chiusura && <button onClick={() => chiudiCiclo(c.id)} className="px-1.5 rounded bg-amber-900/40 text-amber-300 text-[9px] font-bold" title="Chiude oggi con l'indice e il P&L netto attuali">CHIUDI</button>}
                                                <button onClick={() => { if (confirm('Eliminare il ciclo?')) setRegistro(r => r.filter(x => x.id !== c.id)); }} className="text-slate-600 hover:text-red-400">✕</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
            </div>

            {mostraTv && <GraficoTradingView onClose={() => setMostraTv(false)} />}
            {mostraModello && (
                <ModelloStrategia
                    indice={indiceLive} tasso={imp.tasso} ivAtmIniziale={ivAtm ?? 16} comm={imp.commOpzioni} molt={imp.moltOpzioni}
                    onClose={() => setMostraModello(false)}
                    onCrea={(nuove, sostituisci) => { setGambe(gs => (sostituisci ? nuove : [...gs, ...nuove])); setMostraModello(false); }}
                />
            )}
        </main>
    );
}

// ---------- modello della strategia ----------

/**
 * IV stimata con uno skew lineare: +0.6 punti per ogni 1% sotto lo spot, che
 * e' quanto si vede nei cicli del video (Dec 26: ATM 15.9, 24500 a -5% 18.6,
 * 16200 a -37% 40.0; Sep 26: ATM 18.3, 14200 a -42% 43.6). Solo per il
 * modello: dopo la creazione contano i prezzi IBKR.
 */
function ivStimata(atm: number, indice: number, strike: number) {
    return atm + Math.max(0, (1 - strike / indice) * 100) * 0.6 - Math.max(0, (strike / indice - 1) * 100) * 0.15;
}

const arrotonda = (x: number, passo: number) => Math.round(x / passo) * passo;

/**
 * Regole dal video: scadenza trimestrale a ~3-4 mesi; vertical 1 con la put
 * comprata ~5% sotto lo spot e larga 500 (paga ~90 punti); vertical 2 piu'
 * in basso, sui supporti/gap; put vendute ~37-40% sotto, su due strike vicini
 * in rapporto 1:2 (es. -2 16600 / -4 16400), quante bastano a pagare tutto.
 */
function ModelloStrategia({ indice, tasso, ivAtmIniziale, comm, molt, onClose, onCrea }: {
    indice: number; tasso: number; ivAtmIniziale: number; comm: number; molt: number;
    onClose: () => void; onCrea: (g: Gamba[], sostituisci: boolean) => void;
}) {
    const [dte, setDte] = useState(100);
    const [ivAtm, setIvAtm] = useState(ivAtmIniziale);
    const [v1Dist, setV1Dist] = useState(-5);
    const [v1Largh, setV1Largh] = useState(500);
    const [v2Dist, setV2Dist] = useState(-17);
    const [v2Largh, setV2Largh] = useState(1300);
    const [venduteDist, setVenduteDist] = useState(-36);
    const [venduteScarto, setVenduteScarto] = useState(200);
    const [qtaVertical, setQtaVertical] = useState(1);

    const scadenza = isoGiorno(scadenzaTrimestraleVicinaA(new Date(), dte));
    const giorni = Math.max(1, giorniTra(new Date(), dataDa(scadenza)));
    const T = giorni / 365;
    const prezzo = (K: number) => bs('P', indice, K, T, tasso / 100, Math.max(0.05, ivStimata(ivAtm, indice, K) / 100)).prezzo;

    const a = arrotonda(indice * (1 + v1Dist / 100), 500);
    const b = a - v1Largh;
    const c = arrotonda(indice * (1 + v2Dist / 100), 100);
    const d = c - v2Largh;
    const sAlta = arrotonda(indice * (1 + venduteDist / 100), 100);
    const sBassa = sAlta - venduteScarto;

    const costoV1 = prezzo(a) - prezzo(b);
    const costoV2 = prezzo(c) - prezzo(d);
    const debito = qtaVertical * (costoV1 + costoV2);
    // premio di un "pacchetto" 1 alta + 2 basse, e quanti pacchetti servono (commissioni comprese)
    const premioPacchetto = prezzo(sAlta) + 2 * prezzo(sBassa);
    let pacchetti = 1;
    for (; pacchetti < 20; pacchetti++) {
        const nOpz = 4 * qtaVertical + 3 * pacchetti;
        if (pacchetti * premioPacchetto >= debito + (nOpz * comm) / molt) break;
    }
    const qAlta = pacchetti, qBassa = 2 * pacchetti;
    const nOpzioni = 4 * qtaVertical + qAlta + qBassa;
    const netto = debito - qAlta * prezzo(sAlta) - qBassa * prezzo(sBassa);
    const maxGuadagno = (qtaVertical * (v1Largh + v2Largh) - netto) * molt - nOpzioni * comm;

    const crea = (sostituisci: boolean) => {
        const oggi = isoGiorno(new Date());
        const g = (qta: number, K: number, gruppo: string) => {
            const iv = Math.round(ivStimata(ivAtm, indice, K) * 100) / 100;
            const p = Math.round(prezzo(K) * 10) / 10;
            return gamba({ qta, tipo: 'P', strike: K, scadenza, iv, apertura: p, mid: p, gruppo, dataApertura: oggi });
        };
        onCrea([
            g(qtaVertical, a, 'V1'), g(-qtaVertical, b, 'V1'),
            g(qtaVertical, c, 'V2'), g(-qtaVertical, d, 'V2'),
            g(-qAlta, sAlta, 'S'), g(-qBassa, sBassa, 'S'),
        ], sostituisci);
    };

    const riga = (nome: string, K: number, qta: number) => (
        <div className="grid grid-cols-[1fr_50px_70px_60px_60px] items-center gap-2 text-[10px]">
            <span className="text-slate-400">{nome}</span>
            <span className={`font-mono text-right ${qta > 0 ? 'text-green-400' : 'text-red-400'}`}>{qta > 0 ? '+' : ''}{qta}</span>
            <span className="font-mono text-slate-200 text-right">{fmt(K, 0)}</span>
            <span className="font-mono text-slate-500 text-right">{fmt((K / indice - 1) * 100, 1)}%</span>
            <span className="font-mono text-slate-300 text-right">{fmt(prezzo(K), 1)}</span>
        </div>
    );

    return (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-[#0c0d10] border border-slate-700 rounded-xl w-full max-w-xl p-5 space-y-2 max-h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-violet-400">Modello strategia</span>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-lg leading-none">×</button>
                </div>
                <p className="text-[10px] text-slate-400">
                    2 vertical di put comprati, pagati vendendo put ~40% sotto lo spot (1:2 su due strike vicini). Prezzi stimati con
                    Black-Scholes e lo skew dei cicli passati: dopo la creazione usa AGGIORNA DA IBKR e CALCOLA IV.
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <Campo etichetta="DTE obiettivo"><Num valore={dte} onChange={(v) => setDte(v ?? 100)} className="w-16" /></Campo>
                    <div className="text-[10px] text-slate-400 self-center">scadenza <span className="text-amber-400 font-mono">{scadenza}</span> ({giorni} g)</div>
                    <Campo etichetta="IV ATM %"><Num valore={ivAtm} onChange={(v) => setIvAtm(v ?? 16)} className="w-16" /></Campo>
                    <Campo etichetta="qta per vertical"><Num valore={qtaVertical} passo="1" onChange={(v) => setQtaVertical(Math.max(1, v ?? 1))} className="w-16" /></Campo>
                    <Campo etichetta="V1 comprata % spot"><Num valore={v1Dist} onChange={(v) => setV1Dist(v ?? -5)} className="w-16" /></Campo>
                    <Campo etichetta="V1 larghezza"><Num valore={v1Largh} passo="100" onChange={(v) => setV1Largh(v ?? 500)} className="w-16" /></Campo>
                    <Campo etichetta="V2 comprata % spot"><Num valore={v2Dist} onChange={(v) => setV2Dist(v ?? -17)} className="w-16" /></Campo>
                    <Campo etichetta="V2 larghezza"><Num valore={v2Largh} passo="100" onChange={(v) => setV2Largh(v ?? 1300)} className="w-16" /></Campo>
                    <Campo etichetta="vendute % spot"><Num valore={venduteDist} onChange={(v) => setVenduteDist(v ?? -36)} className="w-16" /></Campo>
                    <Campo etichetta="scarto 2° strike"><Num valore={venduteScarto} passo="100" onChange={(v) => setVenduteScarto(v ?? 200)} className="w-16" /></Campo>
                </div>
                <div className="grid grid-cols-[1fr_50px_70px_60px_60px] gap-2 text-[9px] text-slate-500 uppercase border-t border-slate-800 pt-2">
                    <span>gamba</span><span className="text-right">qta</span><span className="text-right">strike</span><span className="text-right">dist.</span><span className="text-right">prezzo</span>
                </div>
                {riga('V1 put comprata', a, qtaVertical)}
                {riga('V1 put venduta', b, -qtaVertical)}
                {riga('V2 put comprata', c, qtaVertical)}
                {riga('V2 put venduta', d, -qtaVertical)}
                {riga('Put lontana venduta', sAlta, -qAlta)}
                {riga('Put lontana venduta', sBassa, -qBassa)}
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-2 text-[10px] space-y-0.5">
                    <div className="flex justify-between"><span className="text-slate-400">costo V1 / V2</span><span className="font-mono text-red-400">{fmt(costoV1, 1)} / {fmt(costoV2, 1)} pt</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">netto apertura</span><span className={`font-mono font-bold ${netto > 0 ? 'text-red-400' : 'text-green-400'}`}>{netto > 0 ? 'debito' : 'credito'} {fmt(Math.abs(netto), 1)} pt = {eur(Math.abs(netto) * molt)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">commissioni ({nOpzioni} opzioni)</span><span className="font-mono text-amber-300">{eur(nOpzioni * comm)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">guadagno max a scadenza (DAX tra {fmt(d, 0)} e {fmt(sAlta, 0)})</span><span className="font-mono text-green-400">{eur(maxGuadagno, 0)}</span></div>
                </div>
                <div className="flex justify-end gap-2">
                    <Bottone onClick={() => crea(false)}>AGGIUNGI</Bottone>
                    <Bottone tono="blu" onClick={() => crea(true)}>SOSTITUISCI GAMBE</Bottone>
                </div>
            </div>
        </div>
    );
}
