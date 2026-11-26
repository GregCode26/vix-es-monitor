'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });
// Su canvas e con i suoi dati: si monta solo con la vista Mappa Calore aperta.
const GammaHeatmapLive = dynamic(() => import('@/components/GammaHeatmapLive'), { ssr: false });
// La verifica della linea piu' alta contro ES (/linea-alta), come vista dopo Serie Temporali.
const LineaAlta = dynamic(() => import('@/components/LineaAlta'), { ssr: false });

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
    /** Le linee della serie temporale: gli strike per cui la route calcola lo storico. */
    topStrikes: number[];
}

const REFRESH_MS = 15000;
/**
 * Punti di storico tenuti in memoria. Basta per la sessione intera anche con
 * la pagina aperta dall'inizio: uno snapshot ogni dieci secondi per 8 ore e
 * mezza e 20 strike sono ~61.000 punti. Il vecchio tetto di 20.000 tagliava
 * le prime ore.
 */
const MAX_STORICO = 80000;
/**
 * Una tinta per linea: la tavolozza di default di echarts ne ha 9, e dalla
 * decima le linee si confondono. In ordine di strike, quindi tinte vicine non
 * stanno mai su strike vicini.
 */
const COLORI_LINEE = [
    '#60a5fa', '#f97316', '#34d399', '#f472b6', '#facc15',
    '#a78bfa', '#22d3ee', '#ef4444', '#a3e635', '#e879f9',
    '#2563eb', '#fdba74', '#059669', '#be185d', '#ca8a04',
    '#7c3aed', '#0e7490', '#fca5a5', '#65a30d', '#cbd5e1',
];
/** Su quanti minuti si misura la variazione che fa lampeggiare gli strike in legenda. */
const VARIAZIONE_MIN = 5;
/** Quanti strike lampeggiano in tutto: sopra lo spot in verde, sotto in rosso. */
const LAMPEGGIANTI = 2;

type ViewMode = 'profile' | 'timeseries' | 'lineaAlta' | 'heatmap';

/** Un singolo trade grande dallo scanner (`/api/spx-scanner`, `python -m spx_flow_scanner.main trade`). */
interface GrandeTrade {
    con_id: number; ts: number; seq: number; size: number; price: number | null; exchange: string | null;
    trading_class: string; real_expiry: string; strike: number; opt_right: 'C' | 'P';
}
/** Soglia del singolo trade: la stessa che salva lo scanner (SCANNER_TRADE_MIN). */
const MIN_GRANDE_TRADE = 500;
const GRANDI_TRADE_MS = 60_000;
/** Pentagono regolare, punta in alto. */
const PENTAGONO = 'path://M50 0 L97.6 34.5 L79.4 90.5 L20.6 90.5 L2.4 34.5 Z';

/** Quello che la legenda usa dell'istanza di echarts. */
interface GraficoEcharts {
    dispatchAction: (a: { type: string; [k: string]: unknown }) => void;
    convertFromPixel: (finder: { yAxisIndex: number }, valore: number) => number;
    setOption: (opzione: Record<string, unknown>) => void;
    getZr: () => { on: (evento: string, cb: (e: EventoZr) => void) => void; setCursorStyle: (stile: string) => void };
}

interface EventoZr {
    offsetX: number;
    offsetY: number;
    wheelDelta: number;
    event: Event;
}

/** Margine sinistro del grafico Profilo: la colonna degli strike, dove la rotella cambia scala. */
const MARGINE_STRIKE = 60;
/** Minimo di strike visibili zoomando con la rotella. */
const MIN_STRIKE_VISIBILI = 4;
/** Ogni quanti strike un'etichetta, con `ampiezza` strike visibili: tutti quando c'e' posto. */
function passoEtichette(ampiezza: number): number {
    return Math.max(1, Math.ceil(ampiezza / 24));
}

/**
 * Asse degli strike fra `min` e `max` (in indici): tacche ed etichette sugli strike interi, non
 * dove le metterebbe echarts partendo da un bordo frazionario (-0.5, 3.27...).
 */
function assiStrike(min: number, max: number) {
    const passo = passoEtichette(max - min);
    const valori: number[] = [];
    for (let i = Math.ceil(Math.max(0, min) / passo) * passo; i <= max; i += passo) valori.push(i);
    return { min, max, axisTick: { customValues: valori }, axisLabel: { customValues: valori } };
}

type DatoCandela = { value: number[]; itemStyle: Record<string, unknown> };

/**
 * Candele tagliate al bordo dell'asse: echarts nasconde quelle tutte fuori ma lascia sbordare
 * sopra/sotto il grafico quelle a meta'.
 */
function candeleDentro(dati: DatoCandela[], min: number, max: number): DatoCandela[] {
    const dentro = (v: number) => Math.max(min, Math.min(max, v));
    return dati
        .filter((d) => d.value[4] >= min && d.value[3] <= max)
        .map((d) => ({ ...d, value: [d.value[0], ...d.value.slice(1).map(dentro)] }));
}

interface PressureHistoryPoint {
    time: string;
    strike: number;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
}

interface HedgingPressureResponseWithHistory extends HedgingPressureResponse {
    pressureHistory?: PressureHistoryPoint[];
    /** Il resto della sessione, uno snapshot al minuto: arriva solo con `?storia=1`. */
    storia?: PressureHistoryPoint[];
    /** SPX di ogni snapshot ([ora, prezzo]), per le candele a 10 s del Profilo. */
    prezzi?: [string, number][];
}

/** Candele SPX della vista Profilo (al posto delle linee Spot/ATM, 26/11/2026). */
const CANDELA_SEC = 10;
/** Quanti minuti di candele si vedono sull'asse del tempo in alto. */
const CANDELE_MIN = 30;

/** Ora 'HH:MM:SS' -> secondi del giorno. */
function secDi(ora: string): number {
    const [h, m, s] = ora.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

/**
 * Prezzo -> posizione sull'asse degli strike (che e' a categorie: lo strike i sta in i),
 * interpolando fra strike vicini, cosi' la candela cade alla sua altezza anche fra due strike.
 */
/** Inverso di indiceStrike: posizione sull'asse -> prezzo. */
function prezzoDaIndice(indice: number, strikes: number[]): number {
    const n = strikes.length;
    if (n === 0) return 0;
    if (n === 1) return strikes[0];
    const i = Math.max(0, Math.min(n - 2, Math.floor(indice)));
    return strikes[i] + (indice - i) * (strikes[i + 1] - strikes[i]);
}

function indiceStrike(prezzo: number, strikes: number[]): number {
    const n = strikes.length;
    if (n === 0) return 0;
    if (n === 1 || prezzo <= strikes[0]) return n === 1 ? 0 : (prezzo - strikes[0]) / (strikes[1] - strikes[0]);
    if (prezzo >= strikes[n - 1]) return n - 1 + (prezzo - strikes[n - 1]) / (strikes[n - 1] - strikes[n - 2]);
    let i = 0;
    while (strikes[i + 1] < prezzo) i++;
    return i + (prezzo - strikes[i]) / (strikes[i + 1] - strikes[i]);
}

/** 'HH:MM:SS' del giorno `data` -> millisecondi, per l'asse del tempo. */
function inMs(data: string, ora: string): number {
    return new Date(`${data}T${ora.length === 5 ? `${ora}:00` : ora}`).getTime();
}

function hhmm(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function HedgingPressurePage() {
    const router = useRouter();
    const [data, setData] = useState<HedgingPressureResponseWithHistory | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showDebug, setShowDebug] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('profile');
    /**
     * La mappa, una volta aperta, resta montata (nascosta) per tutta la vita
     * della pagina: rimontarla a ogni ritorno rileggeva l'intera sessione di
     * gamma da Supabase.
     */
    const [mappaAperta, setMappaAperta] = useState(false);
    const lastTime = useRef<string | null>(null);
    const giornoSessione = useRef<string | null>(null);
    /**
     * Lo storico della pressione, accumulato qui.
     *
     * La route ne manda solo l'ultimo minuto -- leggerne dieci da Supabase a
     * ogni giro costava ~79 MB l'ora -- quindi la serie nel tempo la tiene la
     * pagina, unendo quello che arriva. La chiave e' ora+strike: i giri si
     * sovrappongono e lo stesso punto arriva piu' volte.
     */
    const [storico, setStorico] = useState<PressureHistoryPoint[]>([]);
    /** SPX per ora dello snapshot, accumulato dai giri (la route manda solo gli ultimi minuti). */
    const [prezzi, setPrezzi] = useState<Map<string, number>>(new Map());
    /** La storia della sessione si chiede una volta: finche' non arriva, e di nuovo a ogni giorno nuovo. */
    const serveStoria = useRef(true);
    /**
     * La finestra di zoom della serie temporale, in ms. Il grafico si
     * ricostruisce a ogni giro (notMerge), quindi senza questo lo zoom
     * tornerebbe a tutta la sessione ogni 15 secondi. `live`: il bordo destro
     * era sull'ultimo dato, e allora la finestra lo segue.
     */
    const zoomSerie = useRef<{ da: number; a: number; live: boolean } | null>(null);
    const ultimoMsSerie = useRef(0);
    /** Le linee spente dalla legenda: come lo zoom, senza questo tornerebbero tutte ogni 15 secondi. */
    const legendaSerie = useRef<Record<string, boolean>>({});
    const [lineeSpente, setLineeSpente] = useState<Record<string, boolean>>({});
    /** Il grafico, per comandarlo dalla legenda: e' fuori dal canvas perche' un canvas ridisegnato per lampeggiare costerebbe tutte le linee. */
    const graficoRef = useRef<GraficoEcharts | null>(null);
    /**
     * Scala degli strike del Profilo: rotella sulla colonna degli strike = allarga/stringe attorno
     * al puntatore, trascinare col mouse = sposta su/giu', doppio clic = tutti gli strike.
     * `da`/`a` sono i bordi dell'asse in prezzi (non indici, cosi' regge il ricentrare della catena).
     * Sta in un ref e si applica con setOption sui soli assi: con uno stato React ogni scatto di
     * rotella o pixel di trascinamento ricostruiva tutte le serie, e il grafico andava a scatti.
     */
    const zoomStrikeRef = useRef<{ da: number; a: number } | null>(null);
    const strikesRef = useRef<number[]>([]);
    strikesRef.current = data?.strikes ?? [];
    const viewModeRef = useRef(viewMode);
    viewModeRef.current = viewMode;
    /** Le candele del Profilo non tagliate, per ritagliarle a ogni zoom senza ricostruire il grafico. */
    const candeleRef = useRef<DatoCandela[]>([]);
    const collegaZoomStrike = useCallback((c: GraficoEcharts) => {
        const zr = c.getZr();
        /** Bordi attuali dell'asse in indici (tutti gli strike = -0.5 .. n-0.5). */
        const bordi = (strikes: number[]): [number, number] => {
            const z = zoomStrikeRef.current;
            const n = strikes.length;
            return z ? [indiceStrike(z.da, strikes), indiceStrike(z.a, strikes)] : [-0.5, n - 0.5];
        };
        let inAttesa = false;
        /** Nuovi bordi in indici: limitati alla catena, applicati al prossimo frame. */
        const applica = (da: number, ampiezza: number) => {
            const strikes = strikesRef.current;
            const n = strikes.length;
            if (ampiezza >= n - 1e-6) zoomStrikeRef.current = null;
            else {
                const lo = Math.max(-0.5, Math.min(n - 0.5 - ampiezza, da));
                zoomStrikeRef.current = { da: prezzoDaIndice(lo, strikes), a: prezzoDaIndice(lo + ampiezza, strikes) };
            }
            if (inAttesa) return;
            inAttesa = true;
            requestAnimationFrame(() => {
                inAttesa = false;
                if (viewModeRef.current !== 'profile') return;
                const [min, max] = bordi(strikesRef.current);
                c.setOption({
                    yAxis: [assiStrike(min, max)],
                    series: [{ id: 'candele', data: candeleDentro(candeleRef.current, min, max) }],
                });
            });
        };
        zr.on('mousewheel', (e) => {
            if (viewModeRef.current !== 'profile' || e.offsetX > MARGINE_STRIKE) return;
            const strikes = strikesRef.current;
            if (strikes.length < 2) return;
            e.event.preventDefault();
            const [lo, hi] = bordi(strikes);
            const m = Math.max(lo, Math.min(hi, c.convertFromPixel({ yAxisIndex: 0 }, e.offsetY)));
            const f = e.wheelDelta > 0 ? 0.85 : 1 / 0.85;
            const ampiezza = Math.max(MIN_STRIKE_VISIBILI, (hi - lo) * f);
            // Lo strike sotto il puntatore resta sotto il puntatore.
            applica(m - (m - lo) * (ampiezza / (hi - lo)), ampiezza);
        });
        // Trascinando col mouse (tasto sinistro, ovunque sul grafico) si sposta tutto in su/giu'.
        let trascina: { y0: number; lo: number; ampiezza: number; perPixel: number } | null = null;
        zr.on('mousedown', (e) => {
            if (viewModeRef.current !== 'profile' || !zoomStrikeRef.current) return; // tutto visibile: niente da spostare
            const [lo, hi] = bordi(strikesRef.current);
            const perPixel = (c.convertFromPixel({ yAxisIndex: 0 }, e.offsetY + 100) - c.convertFromPixel({ yAxisIndex: 0 }, e.offsetY)) / 100;
            trascina = { y0: e.offsetY, lo, ampiezza: hi - lo, perPixel };
        });
        zr.on('mousemove', (e) => {
            if (!trascina) return;
            zr.setCursorStyle('grabbing');
            // Il contenuto segue il mouse: trascinare in giu' mostra gli strike piu' alti.
            applica(trascina.lo - (e.offsetY - trascina.y0) * trascina.perPixel, trascina.ampiezza);
        });
        const fine = () => { trascina = null; };
        zr.on('mouseup', fine);
        zr.on('globalout', fine);
        zr.on('dblclick', () => {
            if (viewModeRef.current === 'profile' && zoomStrikeRef.current) applica(0, Infinity);
        });
    }, []);
    // La linea della serie temporale sotto il puntatore: il suo strike si evidenzia in legenda.
    const [lineaSotto, setLineaSotto] = useState<string | null>(null);

    const fetchHedgingPressure = useCallback(async () => {
        try {
            const conStoria = serveStoria.current;
            const res = await fetch(conStoria ? '/api/hedging-pressure?storia=1' : '/api/hedging-pressure', { cache: 'no-store' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Caricamento fallito');
            }
            const json = (await res.json()) as HedgingPressureResponseWithHistory;

            // Cambio di giornata: si riparte da zero
            if (json.date && giornoSessione.current && json.date !== giornoSessione.current) {
                giornoSessione.current = json.date;
                lastTime.current = null;
                serveStoria.current = true;
                zoomSerie.current = null;
                setStorico([]);
                setPrezzi(new Map());
                setData(null);
                setError(null);
                return;
            }
            if (json.date) giornoSessione.current = json.date;

            setData(json);
            if (conStoria) serveStoria.current = false;
            if (json.prezzi && json.prezzi.length > 0) {
                setPrezzi((prec) => {
                    const m = new Map(prec);
                    for (const [t, p] of json.prezzi!) m.set(t, p);
                    // Solo quanto serve alle candele visibili, con margine.
                    const ultimo = Math.max(...[...m.keys()].map(secDi));
                    for (const t of m.keys()) if (secDi(t) < ultimo - (CANDELE_MIN + 10) * 60) m.delete(t);
                    return m;
                });
            }
            setStorico((prec) => {
                const visti = new Set(prec.map((p) => `${p.time}|${p.strike}`));
                const arrivati = [...(json.storia ?? []), ...(json.pressureHistory ?? [])];
                const nuovi = arrivati.filter((p) => !visti.has(`${p.time}|${p.strike}`));
                if (nuovi.length === 0) return prec;
                const uniti = [...prec, ...nuovi];
                // La storia e' piu' vecchia di quello che c'e' gia': in ordine
                // di tempo, o le linee tornerebbero indietro.
                if (json.storia && json.storia.length > 0) uniti.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
                return uniti.slice(-MAX_STORICO);
            });
            setError(null);
            setLoading(false);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Errore');
            setLoading(false);
        }
    }, []);

    /**
     * Large trade CALL e PUT dello scanner, del giorno della pagina, sessione cash: i singoli trade
     * da almeno MIN_GRANDE_TRADE contratti (ogni stampa da sola, non il volume cumulativo).
     * Solo locale: senza scanner la route risponde 503 e i pentagoni semplicemente non ci sono.
     */
    const [grandiTrade, setGrandiTrade] = useState<GrandeTrade[]>([]);
    const giornoPagina = data?.date ?? null;
    useEffect(() => {
        if (!giornoPagina) return;
        let attivo = true;
        const carica = async () => {
            try {
                const r = await fetch(`/api/spx-scanner?leggero=1&sessione=cash&min=${MIN_GRANDE_TRADE}&giorno=${giornoPagina}`,
                    { cache: 'no-store' });
                if (!r.ok) { if (attivo) setGrandiTrade([]); return; }
                const j = await r.json();
                if (attivo) setGrandiTrade(j.giorno === giornoPagina ? (j.trade ?? []) : []);
            } catch { /* scanner assente: nessun pentagono */ }
        };
        carica();
        const id = setInterval(carica, GRANDI_TRADE_MS);
        return () => { attivo = false; clearInterval(id); };
    }, [giornoPagina]);

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

    /**
     * Serie temporale della pressione sui top strike di adesso.
     *
     * Prima l'asse era a categorie e ogni linea si allineava per indice:
     * strike con orari diversi finivano sfasati. E `slice(0, 5)` su un
     * oggetto con chiavi numeriche prendeva i cinque strike piu' BASSI, non i
     * piu' carichi. Ora l'asse e' il tempo vero, e gli strike sono quelli per
     * cui la route calcola lo storico (`topStrikes`). Uno strike che entra fra
     * i piu' carichi a sessione iniziata ha la linea solo da quel momento,
     * finche' non si ricarica la pagina.
     *
     * Lo zoom: rotella e trascinamento sul grafico, o la barra sotto. L'asse
     * Y si riadatta a quello che si vede (`filterMode: 'filter'`).
     */
    /**
     * Le voci della legenda, dal prezzo piu' alto al piu' basso. Lampeggiano i
     * due strike con la variazione assoluta maggiore della pressione negli
     * ultimi VARIAZIONE_MIN minuti, verdi sopra lo spot e rossi sotto: possono
     * stare entrambi dalla stessa parte. Chi non ha un dato di allora
     * (appena entrato fra i piu' carichi, o catena appena ricentrata) non
     * concorre: la sua variazione non si puo' misurare.
     */
    const vociLegenda = useMemo(() => {
        if (!data || storico.length === 0) return [];
        const top = [...data.topStrikes].sort((x, y) => x - y);
        const inTop = new Set(top);
        const perStrike = new Map<number, { ms: number; v: number }[]>();
        let ultimoMs = 0;
        for (const p of storico) {
            if (!inTop.has(p.strike)) continue;
            const ms = inMs(data.date, p.time);
            if (!Number.isFinite(ms)) continue;
            const punti = perStrike.get(p.strike) ?? [];
            punti.push({ ms, v: p.totalPressure });
            perStrike.set(p.strike, punti);
            if (ms > ultimoMs) ultimoMs = ms;
        }
        const obiettivo = ultimoMs - VARIAZIONE_MIN * 60000;
        const voci = top.map((strike, i) => {
            const punti = perStrike.get(strike) ?? [];
            const ultimo = punti[punti.length - 1];
            let rif: { ms: number; v: number } | null = null;
            for (const q of punti) {
                if (q.ms > obiettivo) break;
                rif = q;
            }
            // Dati vecchi da una parte o dall'altra non fanno una variazione su questa finestra.
            const valida = ultimo && rif && ultimo.ms >= ultimoMs - 60000 && rif.ms >= obiettivo - 120000;
            return {
                strike,
                colore: COLORI_LINEE[i % COLORI_LINEE.length],
                variazione: valida ? ultimo.v - rif!.v : null,
                lampeggio: null as 'su' | 'giu' | null,
            };
        });
        const piuMosse = voci
            .filter((x) => x.variazione != null && x.variazione !== 0)
            .sort((a, b) => Math.abs(b.variazione!) - Math.abs(a.variazione!))
            .slice(0, LAMPEGGIANTI);
        for (const x of piuMosse) x.lampeggio = x.strike > data.spot ? 'su' : 'giu';
        return voci.reverse();
    }, [storico, data]);

    const timeseriesOption = useMemo(() => {
        if (storico.length === 0 || !data) {
            return {
                backgroundColor: '#0c0d10',
                title: { text: 'Nessun dato storico disponibile', left: 'center', textStyle: { color: '#94a3b8' } },
            };
        }

        const top = [...data.topStrikes].sort((x, y) => x - y);
        const perStrike = new Map<number, [number, number][]>(top.map((k) => [k, []]));
        let ultimoMs = 0;
        for (const p of storico) {
            const serie = perStrike.get(p.strike);
            if (!serie) continue;
            const ms = inMs(data.date, p.time);
            if (!Number.isFinite(ms)) continue;
            serie.push([ms, p.totalPressure]);
            if (ms > ultimoMs) ultimoMs = ms;
        }
        ultimoMsSerie.current = ultimoMs;

        const series = top.map((strike, i) => ({
            name: `K${strike}`,
            type: 'line' as const,
            data: perStrike.get(strike) ?? [],
            showSymbol: false,
            sampling: 'lttb' as const,
            color: COLORI_LINEE[i % COLORI_LINEE.length],
            lineStyle: { width: 1.5 },
            emphasis: { focus: 'series' as const },
            // Senza, il passaggio sulla linea (senza simboli) non manda mouseover:
            // serve per evidenziare lo strike in legenda.
            triggerLineEvent: true,
        }));

        // La finestra di prima: se seguiva l'ultimo dato, scorre con lui
        // tenendo la stessa ampiezza.
        const z = zoomSerie.current;
        const finestra = z
            ? z.live
                ? { startValue: ultimoMs - (z.a - z.da), endValue: ultimoMs }
                : { startValue: z.da, endValue: z.a }
            : {};

        return {
            backgroundColor: '#0c0d10',
            tooltip: {
                trigger: 'axis',
                // Niente riquadro dei valori: resta solo il mirino.
                showContent: false,
                axisPointer: { type: 'cross' },
            },
            // La legenda che si vede e' quella HTML sopra il grafico (vociLegenda):
            // questa resta solo perche' echarts tenga lo stato delle linee spente.
            legend: {
                show: false,
                data: series.map((x) => x.name),
                selected: legendaSerie.current,
            },
            grid: {
                left: 60,
                right: 70,
                top: 50,
                bottom: 80,
            },
            xAxis: {
                type: 'time',
                name: 'Time',
                nameLocation: 'center',
                nameGap: 30,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12 },
                axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (val: number) => hhmm(val) },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
            },
            yAxis: {
                type: 'value',
                scale: true,
                name: 'Gamma Pressure',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 11 },
                axisLabel: { color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
                axisPointer: { type: 'line' },
            },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'filter', ...finestra },
                {
                    type: 'slider',
                    xAxisIndex: 0,
                    filterMode: 'filter',
                    height: 22,
                    bottom: 12,
                    borderColor: '#334155',
                    fillerColor: 'rgba(59, 130, 246, 0.15)',
                    textStyle: { color: '#94a3b8', fontSize: 9 },
                    labelFormatter: (val: number) => hhmm(val),
                    ...finestra,
                },
            ],
            series,
        };
    }, [storico, data]);

    /** Si ricorda dove l'utente ha zoomato, per rimetterlo li' al prossimo giro. */
    const suZoomSerie = useCallback(
        (_: unknown, chart: { getOption: () => { dataZoom?: { startValue?: number; endValue?: number; start?: number; end?: number }[] } }) => {
            const dz = chart.getOption().dataZoom?.[0];
            if (!dz || dz.startValue == null || dz.endValue == null) return;
            // Tutta la sessione: nessuna finestra da ricordare.
            if ((dz.start ?? 0) <= 0 && (dz.end ?? 100) >= 100) {
                zoomSerie.current = null;
                return;
            }
            const ultimo = ultimoMsSerie.current;
            zoomSerie.current = {
                da: dz.startValue,
                a: dz.endValue,
                // Un giro di margine: il bordo destro e' "sull'ultimo dato" anche
                // se l'ultimo punto e' arrivato mentre si trascinava.
                live: ultimo > 0 && dz.endValue >= ultimo - REFRESH_MS,
            };
        },
        [],
    );

    const suLegendaSerie = useCallback((e: { selected: Record<string, boolean> }) => {
        legendaSerie.current = e.selected;
        setLineeSpente(e.selected);
    }, []);

    // La vista Mappa Calore non e' piu' un grafico echarts: prima era la
    // pressione dei soli cinque strike di `storico`, troppo pochi per una
    // mappa. Ora e' il gamma dei market maker su tutta la catena nel tempo,
    // sul modello di SpotGamma (GammaHeatmapLive).

    /**
     * Candele SPX a CANDELA_SEC dagli snapshot del poller volumi (uno ogni ~10 s, quindi di solito
     * un prezzo per candela: l'apertura e' la chiusura della candela prima, cosi' il corpo mostra
     * il movimento). Conferma dal profilo: la pressione netta (somma dei top strike) dell'ultimo
     * snapshot non oltre la fine della candela ha lo stesso segno della candela -> piena,
     * altrimenti vuota. Candela piatta = mai confermata.
     */
    const candele = useMemo(() => {
        if (!data || prezzi.size === 0) return [];
        const netta = new Map<string, number>();
        for (const p of storico) netta.set(p.time, (netta.get(p.time) ?? 0) + p.totalPressure);
        const tempiNetta = [...netta.keys()].sort();
        const nettaA = (sec: number): number | null => {
            let lo = 0, hi = tempiNetta.length - 1, trovato = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (secDi(tempiNetta[mid]) <= sec) { trovato = mid; lo = mid + 1; } else hi = mid - 1;
            }
            return trovato < 0 ? null : netta.get(tempiNetta[trovato])!;
        };
        const punti = [...prezzi.entries()].map(([t, p]) => [secDi(t), p] as const).sort((a, b) => a[0] - b[0]);
        const out: { inizio: number; o: number; c: number; l: number; h: number; conferma: boolean; netta: number | null }[] = [];
        let corrente: (typeof out)[number] | null = null;
        let chiusuraPrima: number | null = null;
        for (const [sec, p] of punti) {
            const inizio = Math.floor(sec / CANDELA_SEC) * CANDELA_SEC;
            if (!corrente || corrente.inizio !== inizio) {
                if (corrente) { out.push(corrente); chiusuraPrima = corrente.c; }
                const o: number = chiusuraPrima ?? p;
                corrente = { inizio, o, c: p, l: Math.min(o, p), h: Math.max(o, p), conferma: false, netta: null };
            } else {
                corrente.c = p; corrente.l = Math.min(corrente.l, p); corrente.h = Math.max(corrente.h, p);
            }
        }
        if (corrente) out.push(corrente);
        for (const k of out) {
            k.netta = nettaA(k.inizio + CANDELA_SEC - 1);
            const verso = Math.sign(k.c - k.o);
            k.conferma = verso !== 0 && k.netta != null && Math.sign(k.netta) === verso;
        }
        return out;
    }, [prezzi, storico, data]);

    // Opzione echarts per il grafico profile (barre)
    const option = useMemo(() => {
        if (!chartData || !scale || !data) return {};

        // Al posto delle linee Spot e ATM (26/11/2026): le candele SPX a 10 s, sull'asse del tempo
        // in alto e alla loro altezza sull'asse degli strike (asse y nascosto in "indice di strike").
        const VERDE = '#22c55e', ROSSO = '#ef4444', GRIGIO = '#94a3b8';
        const ultimaCandela = candele[candele.length - 1];
        const baseMs = inMs(data.date, '00:00:00');
        // Asse degli strike continuo, in indici (lo strike i sta in i): zoom e spostamento fluidi,
        // non a scatti di uno strike come con l'asse a categorie. Bordi dalla rotella/trascinamento.
        const nStrike = data.strikes.length;
        const zs = zoomStrikeRef.current;
        const yMin = zs ? indiceStrike(zs.da, data.strikes) : -0.5;
        const yMax = zs ? indiceStrike(zs.a, data.strikes) : nStrike - 0.5;
        const etichettaStrike = (v: number) => {
            const i = Math.round(v);
            return Math.abs(v - i) < 1e-6 && i >= 0 && i < nStrike ? String(data.strikes[i]) : '';
        };
        // Barre orizzontali disegnate a mano: 'bar' su due assi numerici le farebbe verticali.
        // Alte il 60% di uno strike, tagliate al bordo del grafico quando si zooma.
        const serieBarre = {
            type: 'custom',
            encode: { x: 0, y: 1 },
            clip: true,
            renderItem: (params: any, api: any) => {
                const x = api.value(0);
                const i = api.value(1);
                if (!x) return null;
                const a = api.coord([0, i]);
                const b = api.coord([x, i]);
                const h = api.size([0, 1])[1] * 0.6;
                const cs = params.coordSys;
                const y0 = Math.max(a[1] - h / 2, cs.y);
                const y1 = Math.min(a[1] + h / 2, cs.y + cs.height);
                if (y1 <= y0) return null;
                return {
                    type: 'rect',
                    shape: { x: Math.min(a[0], b[0]), y: y0, width: Math.abs(b[0] - a[0]), height: y1 - y0 },
                    style: api.style(),
                };
            },
        };
        const indiceDi = new Map(data.strikes.map((s, i) => [String(s), i]));
        const barre = (valori: number[]) => valori.map((x, j) => {
            const strike = chartData.profile[j]?.strike;
            return { value: [x, indiceDi.get(String(strike)) ?? j], strike };
        });
        const datiCandele: DatoCandela[] = candele.map((k) => {
            const colore = k.c > k.o ? VERDE : k.c < k.o ? ROSSO : GRIGIO;
            const riempi = k.conferma ? colore : 'rgba(0,0,0,0)';
            return {
                value: [baseMs + k.inizio * 1000, indiceStrike(k.o, data.strikes), indiceStrike(k.c, data.strikes),
                    indiceStrike(k.l, data.strikes), indiceStrike(k.h, data.strikes)],
                itemStyle: { color: riempi, color0: riempi, borderColor: colore, borderColor0: colore, borderWidth: 1 },
            };
        });
        candeleRef.current = datiCandele;
        const serieCandele = {
            id: 'candele',
            name: 'SPX 10s',
            type: 'candlestick',
            xAxisIndex: 1,
            yAxisIndex: 0,
            z: 10,
            clip: true,
            barMaxWidth: 8,
            data: candeleDentro(datiCandele, yMin, yMax),
            tooltip: { show: false },
        };

        // Large trade: un pentagono per strike, lato e scadenza (mai sommate fra loro), CALL verde a
        // destra, PUT rosso a sinistra; pieno = 0DTE, solo bordo = scadenze successive (piu' all'interno).
        // Grandezza = contratti dei trade >= MIN_GRANDE_TRADE su quello strike.
        const categorie = new Set(data.strikes.map((s) => s.toString()));
        const scad0 = data.date.replaceAll('-', '');
        type Gruppo = { k: string; right: 'C' | 'P'; zero: boolean; scad: string; somma: number; trade: GrandeTrade[] };
        const gruppi = new Map<string, Gruppo>();
        let fuoriAsse = 0;
        for (const t of grandiTrade) {
            const k = String(t.strike);
            if (!categorie.has(k)) { fuoriAsse++; continue; }
            const chiave = `${k}|${t.opt_right}|${t.trading_class}|${t.real_expiry}`;
            const g = gruppi.get(chiave) ?? { k, right: t.opt_right, zero: t.real_expiry === scad0,
                scad: `${t.trading_class} ${t.real_expiry}`, somma: 0, trade: [] };
            g.somma += t.size;
            g.trade.push(t);
            gruppi.set(chiave, g);
        }
        const maxSomma = Math.max(1, ...[...gruppi.values()].map((g) => g.somma));
        const pentagoni = (['C', 'P'] as const).map((right) => ({
            name: right === 'C' ? 'Large CALL trades' : 'Large PUT trades',
            type: 'scatter',
            symbol: PENTAGONO,
            z: 5,
            itemStyle: { color: right === 'C' ? '#22c55e' : '#ef4444' },
            data: [...gruppi.values()].filter((g) => g.right === right).map((g) => {
                const colore = right === 'C' ? '#22c55e' : '#ef4444';
                return {
                    value: [(right === 'C' ? 1 : -1) * scale.xMax * (g.zero ? 0.9 : 0.75), indiceDi.get(g.k)],
                    symbolSize: 12 + 22 * Math.sqrt(g.somma / maxSomma),
                    itemStyle: g.zero
                        ? { color: colore, borderColor: '#0c0d10', borderWidth: 1 }
                        : { color: 'rgba(0,0,0,0)', borderColor: colore, borderWidth: 2 },
                    label: {
                        show: true, position: right === 'C' ? 'left' : 'right', color: colore, fontSize: 10,
                        formatter: () => (g.somma >= 1000 ? `${(g.somma / 1000).toFixed(1)}k` : String(g.somma)),
                    },
                    gruppo: g,
                };
            }),
        }));

        return {
            backgroundColor: '#0c0d10',
            tooltip: {
                trigger: 'axis',
                // Niente riquadro dei valori sul puntatore: resta solo il mirino.
                showContent: false,
                axisPointer: { type: 'cross' },
            },
            legend: {
                data: ['Bullish Pressure', 'Bearish Pressure', 'Large CALL trades', 'Large PUT trades', 'SPX 10s'],
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
                left: MARGINE_STRIKE,
                right: 40,
                top: 50,
                bottom: 40,
            },
            xAxis: [{
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
            }, {
                type: 'time',
                position: 'top',
                // Asse simmetrico attorno all'ultima candela: cade al centro del profilo (x = 0),
                // fra pressione ribassista e rialzista; la meta' destra resta vuota.
                min: ultimaCandela ? baseMs + (ultimaCandela.inizio - CANDELE_MIN * 60) * 1000 : undefined,
                max: ultimaCandela ? baseMs + (ultimaCandela.inizio + CANDELE_MIN * 60) * 1000 : undefined,
                axisLabel: { color: '#64748b', fontSize: 9, formatter: (val: number) => hhmm(val) },
                splitLine: { show: false },
                axisLine: { lineStyle: { color: '#334155' } },
                axisPointer: { show: false },
            }],
            yAxis: [{
                type: 'value',
                ...assiStrike(yMin, yMax),
                axisLabel: { ...assiStrike(yMin, yMax).axisLabel, color: '#94a3b8', formatter: etichettaStrike },
                axisPointer: { snap: true, label: { formatter: ({ value }: { value: number }) => etichettaStrike(Math.round(value)) } },
                name: 'Strike',
                nameLocation: 'center',
                nameGap: 40,
                nameTextStyle: { color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } },
                axisLine: { lineStyle: { color: '#334155' } },
            }],
            series: [
                {
                    name: 'Bullish Pressure',
                    ...serieBarre,
                    data: barre(chartData.posData),
                    itemStyle: { color: '#3b82f6', opacity: 0.85 },
                },
                {
                    name: 'Bearish Pressure',
                    ...serieBarre,
                    data: barre(chartData.negData),
                    itemStyle: { color: '#ef4444', opacity: 0.85 },
                },
                ...pentagoni,
                serieCandele,
            ],
            graphic: fuoriAsse > 0 ? [{
                type: 'text', left: 70, bottom: 8,
                style: { text: `${fuoriAsse} large trade su strike fuori dal grafico`, fill: '#64748b', fontSize: 10 },
            }] : [],
        };
    }, [chartData, scale, data, grandiTrade, candele]);

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
                            {(['profile', 'timeseries', 'lineaAlta', 'heatmap'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => {
                                        setViewMode(mode);
                                        if (mode === 'heatmap') setMappaAperta(true);
                                    }}
                                    className={`px-2.5 py-1.5 text-xs transition-colors ${
                                        viewMode === mode
                                            ? 'bg-blue-600/30 text-blue-300'
                                            : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
                                    }`}
                                >
                                    {mode === 'profile' ? 'Profilo' : mode === 'timeseries' ? 'Serie Temporali' : mode === 'lineaAlta' ? 'Linea Alta' : 'Mappa Calore'}
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
                    <div className="relative h-[calc(100vh-300px)] min-h-[600px]">
                        {viewMode === 'timeseries' && pronto && vociLegenda.length > 0 && (
                            <div className="absolute top-2 right-1 z-10 flex max-h-[calc(100%-3rem)] flex-col gap-0.5 overflow-y-auto">
                                {/* Il prezzo SPX fra gli strike: con `order` sta fra quello appena sopra e quello appena sotto. */}
                                <div
                                    title={`SPX ${data.spot.toFixed(2)}`}
                                    className="mx-1.5 my-0.5 h-0.5 bg-white"
                                    style={{ order: 2 * vociLegenda.filter((v) => v.strike > data.spot).length - 1 }}
                                />
                                {vociLegenda.map((v, i) => {
                                    const nome = `K${v.strike}`;
                                    const spenta = lineeSpente[nome] === false;
                                    const sotto = lineaSotto === nome;
                                    return (
                                        <button
                                            key={v.strike}
                                            type="button"
                                            style={{ order: 2 * i }}
                                            title={v.variazione == null
                                                ? `Variazione a ${VARIAZIONE_MIN} min non disponibile`
                                                : `${v.variazione > 0 ? '+' : ''}${Math.round(v.variazione).toLocaleString('it-IT')} in ${VARIAZIONE_MIN} min`}
                                            onClick={() => graficoRef.current?.dispatchAction({ type: 'legendToggleSelect', name: nome })}
                                            onMouseEnter={() => graficoRef.current?.dispatchAction({ type: 'highlight', seriesName: nome })}
                                            onMouseLeave={() => graficoRef.current?.dispatchAction({ type: 'downplay', seriesName: nome })}
                                            ref={sotto ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                            className={`flex items-center gap-1.5 rounded px-1.5 py-px text-[10px] leading-4 ${spenta ? 'opacity-40' : ''} ${
                                                sotto
                                                    ? 'bg-white/90 font-bold text-black ring-2 ring-white'
                                                    : v.lampeggio === 'su'
                                                    ? 'legenda-lampeggio bg-emerald-500/40 font-bold text-emerald-200'
                                                    : v.lampeggio === 'giu'
                                                      ? 'legenda-lampeggio bg-red-500/40 font-bold text-red-200'
                                                      : 'text-slate-400 hover:text-slate-200'
                                            }`}
                                        >
                                            <span className="h-0.5 w-3" style={{ backgroundColor: v.colore }} />
                                            {nome}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {mappaAperta && (
                            <div className={viewMode === 'heatmap' ? 'h-full' : 'hidden'}>
                                <GammaHeatmapLive attiva={viewMode === 'heatmap'} />
                            </div>
                        )}
                        {viewMode === 'lineaAlta' && (
                            <div className="h-full overflow-y-auto">
                                <LineaAlta incorporata />
                            </div>
                        )}
                        {viewMode === 'heatmap' || viewMode === 'lineaAlta' ? null : pronto ? (
                            <ReactECharts
                                option={viewMode === 'profile' ? option : timeseriesOption}
                                style={{ height: '100%', width: '100%' }}
                                notMerge={true}
                                onChartReady={(c: GraficoEcharts) => { graficoRef.current = c; collegaZoomStrike(c); }}
                                onEvents={viewMode === 'timeseries' ? {
                                    datazoom: suZoomSerie,
                                    legendselectchanged: suLegendaSerie,
                                    mouseover: (e: { seriesName?: string }) => setLineaSotto(e.seriesName ?? null),
                                    mouseout: () => setLineaSotto(null),
                                    globalout: () => setLineaSotto(null),
                                } : undefined}
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
