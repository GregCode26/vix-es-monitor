'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    TimeScale,
    Filler,
} from 'chart.js';
import GexPage from '../gex/page';
import annotationPlugin from 'chartjs-plugin-annotation';
import 'chartjs-adapter-date-fns';
import { Line } from 'react-chartjs-2';
import { leggiRefLines, salvaRefLines, leggiVisibilita, REF_LINES_VIS_KEY } from '@/lib/refLines';
import AiSignalPanel from '@/components/AiSignalPanel';

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    TimeScale,
    Filler,
    annotationPlugin
);

// Custom scale background plugin — draws a lighter bg behind each axis area
// Scale area background - subtle dark shade
const scaleBackgroundPlugin = {
    id: 'scaleBackground',
    beforeDraw: (chart: any) => {
        const { ctx, chartArea, scales, width, height } = chart;
        if (!chartArea) return;
        const bgColor = 'rgba(12, 13, 16, 0.4)'; 
        ctx.save();
        ctx.fillStyle = bgColor;
        if (scales['y-left']) {
            const s = scales['y-left'];
            ctx.fillRect(0, 0, s.right, height);
        }
        if (scales['y-right']) {
            const s = scales['y-right'];
            ctx.fillRect(s.left, 0, width - s.left, height);
        }
        if (scales.x) {
            const s = scales.x;
            ctx.fillRect(chartArea.left, s.top, chartArea.right - chartArea.left, height - s.top);
        }
        ctx.restore();
    }
};

// Current Price Tags Plugin - Draws the yellow/blue tags on Y axes
const priceTagPlugin = {
    id: 'priceTag',
    afterDraw: (chart: any) => {
        const { ctx, scales, data } = chart;
        if (!data.datasets[0].data.length) return;

        const drawTag = (axisId: string, value: number, color: string, textColor: string = '#000') => {
            const scale = scales[axisId];
            if (!scale) return;
            const y = scale.getPixelForValue(value);
            const text = axisId === 'y-right' ? value.toLocaleString() : value.toFixed(2);
            
            ctx.save();
            ctx.font = 'bold 12px Arial';
            const textWidth = ctx.measureText(text).width;
            const tagWidth = textWidth + 12;
            const tagHeight = 20;
            const x = axisId === 'y-right' ? scale.left : scale.right - tagWidth;

            // Draw box
            ctx.fillStyle = color;
            ctx.fillRect(x, y - tagHeight / 2, tagWidth, tagHeight);

            // Draw text
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + tagWidth / 2, y);
            
            // Draw horizontal dotted line to the tag
            ctx.beginPath();
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.moveTo(axisId === 'y-right' ? chart.chartArea.right : chart.chartArea.left, y);
            ctx.lineTo(axisId === 'y-right' ? scale.left : scale.right, y);
            ctx.stroke();
            
            ctx.restore();
        };

        const lastIdx = data.datasets[0].data.length - 1;
        const esfVal = data.datasets[0].data[lastIdx];
        const vixVal = data.datasets[1].data[lastIdx];

        if (esfVal !== null) drawTag('y-right', esfVal, '#facc15'); // Yellow for ES
        if (vixVal !== null) drawTag('y-left', vixVal, '#3b82f6', '#fff'); // Blue for VIX
    }
};

// Custom crosshair plugin
const crosshairPlugin = {
    id: 'crosshair',
    afterDraw: (chart: any) => {
        if (chart.crosshair && chart.crosshair.x !== undefined && chart.crosshair.y !== undefined) {
            const { ctx, chartArea: { top, bottom, left, right }, scales } = chart;
            ctx.save();
            
            // Draw lines
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.moveTo(chart.crosshair.x, top);
            ctx.lineTo(chart.crosshair.x, bottom);
            ctx.moveTo(left, chart.crosshair.y);
            ctx.lineTo(right, chart.crosshair.y);
            ctx.stroke();

            // Draw axis labels
            ctx.setLineDash([]);
            ctx.font = '11px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // X-axis label
            const xValue = scales.x.getValueForPixel(chart.crosshair.x);
            const xLabel = scales.x.getLabelForValue(xValue);
            if (xLabel) {
                const tw = ctx.measureText(xLabel).width + 10;
                ctx.fillStyle = '#2a2e39';
                ctx.fillRect(chart.crosshair.x - tw/2, bottom, tw, 20);
                ctx.fillStyle = '#d1d4dc';
                ctx.fillText(xLabel, chart.crosshair.x, bottom + 10);
            }

            // Y-axis labels (optional, can be noisy with priceTagPlugin)
            
            ctx.restore();
        }
    }
};

/**
 * Trascina un intervallo bloccato dallo zoom finche' i dati non rientrano.
 *
 * Lo zoom scelto resta quello scelto: si sposta l'intervallo, non lo si
 * ridimensiona. Serve perche' lo zoom verticale fissa min e max dell'asse,
 * e da quel momento la linea puo' uscire dalla finestra mentre il prezzo
 * si muove -- senza piu' rientrare da sola.
 */
function ancoraAiDati(range: [number, number], valori: number[]): [number, number] {
    if (valori.length === 0) return range;
    const span = range[1] - range[0];
    if (!(span > 0)) return range;

    const dMin = Math.min(...valori);
    const dMax = Math.max(...valori);
    const margine = span * 0.08;

    // Zoom piu' stretto dell'escursione dei dati: non si puo' mostrare
    // tutto, quindi si insegue l'ultimo valore tenendolo al centro.
    if (dMax - dMin + 2 * margine >= span) {
        const ultimo = valori[valori.length - 1];
        return [ultimo - span / 2, ultimo + span / 2];
    }

    let [min, max] = range;
    if (dMax > max - margine) {
        const scarto = dMax - (max - margine);
        min += scarto; max += scarto;
    }
    if (dMin < min + margine) {
        const scarto = (min + margine) - dMin;
        min -= scarto; max -= scarto;
    }
    return [min, max];
}


interface DataPoint {
    time: string;
    vix: number | null;
    esf: number | null;
    spx?: number | null;
    coneUp?: number | null;
    coneDown?: number | null;
    /** VWAP di giornata di ES, dal tick RTVolume di IBKR. */
    vwap?: number | null;
}

interface ReferenceLines {
    r1Down: string;
    r2Down: string;
    r3Down: string;
    r2Up: string;
    r3Up: string;
    r1Up: string;
    r1DownOb: string;
    r2DownOb: string;
    r3DownOb: string;
    r2UpOb: string;
    r3UpOb: string;
    r1UpOb: string;
}

interface RefLineVisibility {
    r1Down: boolean;
    r2Down: boolean;
    r3Down: boolean;
    r2Up: boolean;
    r3Up: boolean;
    r1Up: boolean;
    r1DownOb: boolean;
    r2DownOb: boolean;
    r3DownOb: boolean;
    r2UpOb: boolean;
    r3UpOb: boolean;
    r1UpOb: boolean;
}

interface RangeCalcInput {
    spx: string;
    es: string;
    callBid: string;
    callAsk: string;
    putBid: string;
    putAsk: string;
}

/**
 * Campanella di apertura e momento dello scatto Opening Bell, in ora di Roma,
 * nello stesso formato 'HH:MM:SS' di `DataPoint.time`: cosi' il confronto e'
 * un confronto fra stringhe e non serve ricostruire una data.
 */
const APERTURA_USA = '15:30:00';
const OB_SNAPSHOT = '15:35:00';

// --- Helpers ---
function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isInTradingHours() {
    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    // Active from 00:05 to 23:00 Italian time
    if (hour === 0) return minutes >= 5;
    return hour >= 1 && hour < 23;
}

function isTradingJustStarted() {
    // Returns true if current time is exactly 00:05:xx (within first minute of trading)
    const now = new Date();
    return now.getHours() === 0 && now.getMinutes() === 5;
}

export default function MarketPage() {
    const router = useRouter();
    const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
    const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
    const [status, setStatus] = useState<'live' | 'paused' | 'connecting' | 'error'>('connecting');
    const [lastUpdate, setLastUpdate] = useState<string>('');
    const [firstEsfValue, setFirstEsfValue] = useState<number | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    /**
     * Le due linee arancioni del cono, i dataset 'Straddle Up' e
     * 'Straddle Down'. Sono un'altra cosa dai livelli R1/R2/R3, che pure
     * dallo straddle si ricavano: quelle sono annotazioni orizzontali ferme,
     * queste seguono il prezzo per tutta la sessione.
     */
    const [mostraStraddle, setMostraStraddle] = useState(true);
    /**
     * L'indice SPX sulla scala destra, quella di ES. Solo da mercato aperto:
     * prima delle 15:30 l'indice non stampa e il poller ripiega sull'ultimo
     * prezzo o sulla chiusura di ieri, cioe' una riga piatta che non e' un
     * prezzo di oggi.
     */
    const [mostraSpx, setMostraSpx] = useState(true);
    const [mostraAi, setMostraAi] = useState(false);
    /**
     * Gli stessi livelli R1/R2/R3 dell'Opening Bell, ma in termini SPX: il
     * calcolo parte dallo SPX e ci somma il basis per portarli su ES, qui il
     * basis non si somma. Vanno con la linea verde, non con quella di ES.
     */
    const [mostraRangeSpxOb, setMostraRangeSpxOb] = useState(true);
  const [activeTab, setActiveTab] = useState<'market'|'gex'>('market');

    const [pluginsReady, setPluginsReady] = useState(false);
    const isZoomedRef = useRef(false);
    const [showDivergences, setShowDivergences] = useState(true);
    const [isLocked, setIsLocked] = useState(false);

    const [refLines, setRefLines] = useState<ReferenceLines>({
        r1Down: '',
        r2Down: '',
        r3Down: '',
        r2Up: '',
        r3Up: '',
        r1Up: '',
        r1DownOb: '',
        r2DownOb: '',
        r3DownOb: '',
        r2UpOb: '',
        r3UpOb: '',
        r1UpOb: '',
    });
    const [refLineVisibility, setRefLineVisibility] = useState<RefLineVisibility>({
        r1Down: true,
        r2Down: true,
        r3Down: true,
        r2Up: true,
        r3Up: true,
        r1Up: true,
        r1DownOb: true,
        r2DownOb: true,
        r3DownOb: true,
        r2UpOb: true,
        r3UpOb: true,
        r1UpOb: true,
    });

    // Range Calculator state
    const emptyCalcInput: RangeCalcInput = { spx: '', es: '', callBid: '', callAsk: '', putBid: '', putAsk: '' };

    /** Riempie solo i campi vuoti: quello che hai inserito a mano resta. */
    const riempiVuoti = (prev: RangeCalcInput, proposta: RangeCalcInput): RangeCalcInput => {
        const merged = { ...prev };
        let cambiato = false;
        (Object.keys(proposta) as (keyof RangeCalcInput)[]).forEach((k) => {
            if (!merged[k] && proposta[k]) { merged[k] = proposta[k]; cambiato = true; }
        });
        return cambiato ? merged : prev;
    };
    const [showRangeCalc, setShowRangeCalc] = useState(false);
    const [rangeCalcTab, setRangeCalcTab] = useState<'morning' | 'ob'>('morning');
    // Ultimo orario di riga gia' inserito nel grafico, per non duplicare.
    const lastSourceTime = useRef<string | null>(null);
    const [rangeCalcMorning, setRangeCalcMorning] = useState<RangeCalcInput>(emptyCalcInput);
    const [rangeCalcOb, setRangeCalcOb] = useState<RangeCalcInput>(emptyCalcInput);

    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const sessionWatchRef = useRef<NodeJS.Timeout | null>(null);
    const chartRef = useRef<any>(null);
    const manualZoomRef = useRef(false);
    // L'utente ha spostato la vista a mano trascinando: si resta dove ha messo.
    const panLibRef = useRef(false);
    const manualLimitsRef = useRef<{
        x: [any, any] | null;
        yLeft: [number, number] | null;
        yRight: [number, number] | null;
    }>({ x: null, yLeft: null, yRight: null });
    const manualYLeftZoomingRef = useRef(false);
    const manualYRightZoomingRef = useRef(false);
    const vertZoomRef = useRef<{ active: boolean; axis: 'y-left' | 'y-right'; startY: number; startRange: [number, number] } | null>(null);
    const horizZoomRef = useRef<{ active: boolean; startX: number; startRangeX: [any, any] } | null>(null);
    // Shift + trascinamento su un asse Y: trasla quella sola scala, in su o in
    // giu', lasciando ferme l'altra e il tempo. Senza Shift il trascinamento
    // sull'asse resta lo zoom di sempre.
    const axisPanRef = useRef<{ active: boolean; axis: 'y-left' | 'y-right'; startY: number; startRange: [number, number] } | null>(null);
    // Assi che l'utente ha posizionato a mano: non vanno riagganciati ai dati,
    // altrimenti il primo aggiornamento rimetterebbe la linea dove stava.
    const axisPinnedRef = useRef<{ 'y-left': boolean; 'y-right': boolean }>({ 'y-left': false, 'y-right': false });

    // ---- Auth check ----
    useEffect(() => {
        const auth = localStorage.getItem('market_auth');
        if (auth !== 'true') {
            router.replace('/login');
        } else {
            setIsAuthorized(true);
            // Load divergence preference
            const savedDiv = localStorage.getItem('marketShowDivergences');
            if (savedDiv !== null) setShowDivergences(savedDiv === 'true');
            const savedStr = localStorage.getItem('marketShowStraddle');
            if (savedStr !== null) setMostraStraddle(savedStr === 'true');
            const savedSpx = localStorage.getItem('marketShowSpx');
            if (savedSpx !== null) setMostraSpx(savedSpx === 'true');
            const savedSpxOb = localStorage.getItem('marketShowRangeSpxOb');
            if (savedSpxOb !== null) setMostraRangeSpxOb(savedSpxOb === 'true');
        }
    }, [router]);

    // Save divergence preference
    useEffect(() => {
        localStorage.setItem('marketShowDivergences', String(showDivergences));
    }, [showDivergences]);

    useEffect(() => {
        localStorage.setItem('marketShowStraddle', String(mostraStraddle));
    }, [mostraStraddle]);


    useEffect(() => {
        localStorage.setItem('marketShowSpx', String(mostraSpx));
    }, [mostraSpx]);

    useEffect(() => {
        localStorage.setItem('marketShowRangeSpxOb', String(mostraRangeSpxOb));
    }, [mostraRangeSpxOb]);



    // ---- ES/VIX Divergence Detection ----
    /**
     * Divergenze ES/VIX su un livello.
     *
     * L'idea e' quella del doppio tentativo: il prezzo torna a provare la
     * stessa quota e la volatilita' non lo accompagna. Due minimi appoggiati
     * al supporto con il VIX piu' basso al secondo -- la paura rientra mentre
     * il prezzo tiene -- e' un segnale rialzista; due massimi sulla resistenza
     * con il VIX piu' alto e' quello opposto.
     *
     * Tre cose lo rendono quello che e', e ognuna ha una storia.
     *
     * I pivot si cercano sull'ES, non sul VIX. Cercandoli sul VIX i due punti
     * a confronto cadevano dove capitava rispetto al prezzo, e la coppia non
     * era un doppio tentativo su una quota: erano due momenti qualsiasi in cui
     * la volatilita' aveva girato.
     *
     * Devono stare vicinissimi allo stesso livello, tre punti ES. Non e' una
     * taratura, e' la definizione: il segnale dice "il prezzo ha provato
     * QUESTA quota due volte", e a otto o dieci punti di distanza non la stava
     * piu' provando.
     *
     * E si guarda lontano, fino a due ore. Prima si teneva un solo pivot
     * precedente, sovrascritto a ogni pivot nuovo, quindi si confrontavano
     * sempre e solo pivot consecutivi: la divergenza piu' lunga trovabile in
     * una giornata era di cinque minuti, e allargare la finestra massima non
     * cambiava niente, perche' non c'era nessuna coppia lontana da accettare.
     *
     * I livelli arrivano dal pannello Range, sono in termini ES come i prezzi
     * qui, e non passano dal filtro della visibilita': nascondere le linee e'
     * pulizia del grafico, non dice che quei livelli non esistano piu'.
     */
    const detectDivergences = useCallback((points: DataPoint[], livelli: number[]) => {
        const lbL = 5;
        const lbR = 5;
        /** Distanza fra i due pivot, in punti da 15 secondi. */
        const DISTANZA_MIN = 5;
        const DISTANZA_MAX = 480;   // due ore
        /** Quanto vicino al livello deve stare un pivot, in punti ES. */
        const VICINANZA = 3;
        /** Di quanto deve essersi mosso il VIX perche' sia una divergenza. */
        const DELTA_VIX = 0.05;

        if (points.length < lbL + lbR + DISTANZA_MIN) return {};
        if (livelli.length === 0) return {};

        const annotations: Record<string, unknown> = {};
        const prices = points.map((p) => p.esf);
        const oscillator = points.map((p) => p.vix);

        /** Indice del livello piu' vicino, se il prezzo ci sta praticamente sopra. */
        const livelloDi = (prezzo: number): number | null => {
            let scelto: number | null = null;
            let minima = Infinity;
            livelli.forEach((l, k) => {
                const d = Math.abs(prezzo - l);
                if (d <= VICINANZA && d < minima) { minima = d; scelto = k; }
            });
            return scelto;
        };

        const isPivot = (values: (number | null)[], index: number, alto: boolean) => {
            const current = values[index];
            if (current === null) return false;
            for (let i = index - lbL; i <= index + lbR; i++) {
                if (i === index) continue;
                const value = values[i];
                if (value === null) return false;
                if (alto ? value > current : value < current) return false;
            }
            return true;
        };

        type Pivot = { index: number; price: number; osc: number; livello: number };
        type Candidata = { da: Pivot; a: Pivot; toro: boolean; durata: number };

        const minimi: Pivot[] = [];
        const massimi: Pivot[] = [];
        const candidate: Candidata[] = [];

        for (let confirmIndex = lbL + lbR; confirmIndex < points.length; confirmIndex++) {
            const pivotIndex = confirmIndex - lbR;
            const price = prices[pivotIndex];
            const oscValue = oscillator[pivotIndex];
            if (price === null || oscValue === null) continue;

            const livello = livelloDi(price);
            if (livello === null) continue;
            const qui: Pivot = { index: pivotIndex, price, osc: oscValue, livello };

            // Minimo dell'ES appoggiato al livello: si cerca il tentativo
            // precedente piu' lontano sulla stessa quota che avesse il VIX
            // piu' alto, cioe' la paura rientrata da allora.
            if (isPivot(prices, pivotIndex, false)) {
                for (const prec of minimi) {
                    const bars = pivotIndex - prec.index;
                    if (bars < DISTANZA_MIN || bars > DISTANZA_MAX) continue;
                    if (prec.livello !== livello) continue;
                    if (oscValue < prec.osc - DELTA_VIX) {
                        candidate.push({ da: prec, a: qui, toro: true, durata: bars });
                        break;
                    }
                }
                minimi.push(qui);
                while (minimi.length && pivotIndex - minimi[0].index > DISTANZA_MAX) minimi.shift();
            }

            if (isPivot(prices, pivotIndex, true)) {
                for (const prec of massimi) {
                    const bars = pivotIndex - prec.index;
                    if (bars < DISTANZA_MIN || bars > DISTANZA_MAX) continue;
                    if (prec.livello !== livello) continue;
                    if (oscValue > prec.osc + DELTA_VIX) {
                        candidate.push({ da: prec, a: qui, toro: false, durata: bars });
                        break;
                    }
                }
                massimi.push(qui);
                while (massimi.length && pivotIndex - massimi[0].index > DISTANZA_MAX) massimi.shift();
            }
        }

        // Un episodio lungo produce una candidata per ogni pivot che lo
        // attraversa: si tiene la piu' lunga e si scarta quello che le si
        // accavalla. Un tentativo che dura un'ora e' una riga, non trenta.
        candidate.sort((a, b) => b.durata - a.durata);
        const tenute: Candidata[] = [];
        for (const c of candidate) {
            const accavallata = tenute.some((t) =>
                t.da.livello === c.da.livello && t.toro === c.toro
                && c.da.index < t.a.index && t.da.index < c.a.index);
            if (!accavallata) tenute.push(c);
        }

        tenute.forEach((c, i) => {
            const colore = c.toro ? 'rgba(34, 197, 94, 0.95)' : 'rgba(239, 68, 68, 0.95)';
            const nome = c.toro ? 'bull' : 'bear';

            // Sull'ES la riga viene piatta, perche' i due punti stanno sulla
            // stessa quota: e' il livello provato due volte.
            annotations[`es-vix-div-${nome}-es-${i}`] = {
                type: 'line',
                xMin: points[c.da.index].time,
                xMax: points[c.a.index].time,
                yMin: c.da.price,
                yMax: c.a.price,
                yScaleID: 'y-right',
                borderColor: colore,
                borderWidth: 2,
                label: {
                    display: true,
                    content: c.toro ? 'Bull Div' : 'Bear Div',
                    position: 'end',
                    backgroundColor: colore,
                    color: '#fff',
                    font: { size: 10, weight: 'bold' }
                }
            };

            // Sul VIX e' inclinata, ed e' lei a dire perche' c'e' un segnale:
            // senza, si vedrebbe solo che il prezzo e' tornato dov'era.
            annotations[`es-vix-div-${nome}-vix-${i}`] = {
                type: 'line',
                xMin: points[c.da.index].time,
                xMax: points[c.a.index].time,
                yMin: c.da.osc,
                yMax: c.a.osc,
                yScaleID: 'y-left',
                borderColor: colore,
                borderWidth: 2,
                borderDash: [4, 3],
            };
        });

        return annotations;
    }, []);

    /** I livelli del pannello Range, in numeri, per il filtro delle divergenze. */
    const livelliPerDivergenze = useMemo(
        () => Object.values(refLines)
            .map((v) => parseFloat(v as string))
            .filter((n) => !isNaN(n) && n > 0),
        [refLines],
    );

    // ---- Zoom ----
    const updateZoomState = useCallback(() => {
        if (chartRef.current) {
            const chart = chartRef.current;
            // If zoomed (either by plugin or manually), save ALL current limits
            if (isZoomedRef.current || manualZoomRef.current) {
                const yLeftMin = chart.scales['y-left'].min;
                const yLeftMax = chart.scales['y-left'].max;
                const yRightMin = chart.scales['y-right'].min;
                const yRightMax = chart.scales['y-right'].max;

                // We only lock an axis if its range is significantly different from "auto" or if it was manually touched.
                // However, for simplicity and reliability, we'll store both if either is zoomed, 
                // but the imperative update will decide whether to USE them based on manualZoomRef.
                manualLimitsRef.current = {
                    x: [chart.scales.x.min, chart.scales.x.max],
                    yLeft: [yLeftMin, yLeftMax],
                    yRight: [yRightMin, yRightMax],
                };
                setIsLocked(true);
            }
        }
    }, []);

    // ---- Range Calculator computation ----
    const calcRange = useCallback((input: RangeCalcInput) => {
        const spx = parseFloat(input.spx);
        const es = parseFloat(input.es);
        const callBid = parseFloat(input.callBid);
        const callAsk = parseFloat(input.callAsk);
        const putBid = parseFloat(input.putBid);
        const putAsk = parseFloat(input.putAsk);

        if ([spx, es, callBid, callAsk, putBid, putAsk].some(isNaN)) return null;

        const basis = es - spx;
        const callMid = (callBid + callAsk) / 2;
        const putMid = (putBid + putAsk) / 2;
        const straddle = callMid + putMid;
        const sqrt3 = Math.sqrt(3);

        return {
            basis: Math.round(basis * 100) / 100,
            callMid: Math.round(callMid * 100) / 100,
            putMid: Math.round(putMid * 100) / 100,
            straddle: Math.round(straddle * 100) / 100,
            r1Up: Math.round((spx + straddle + basis) * 100) / 100,
            r1Down: Math.round((spx - straddle + basis) * 100) / 100,
            r2Up: Math.round((spx + straddle / sqrt3 + basis) * 100) / 100,
            r2Down: Math.round((spx - straddle / sqrt3 + basis) * 100) / 100,
            r3Up: Math.round((spx + straddle * sqrt3 + basis) * 100) / 100,
            r3Down: Math.round((spx - straddle * sqrt3 + basis) * 100) / 100,
        };
    }, []);

    const morningResults = useMemo(() => calcRange(rangeCalcMorning), [rangeCalcMorning, calcRange]);
    const obResults = useMemo(() => calcRange(rangeCalcOb), [rangeCalcOb, calcRange]);

    // ---- Imperative chart update (preserves zoom) ----
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart || dataPoints.length === 0) return;

        chart.data.datasets[0].data = dataPoints.map((d) => d.esf);
        chart.data.datasets[1].data = dataPoints.map((d) => d.vix);
        chart.data.datasets[4].data = dataPoints.map((d) => d.vwap ?? null);

        // SPX: solo da mercato aperto. Prima delle 15:30 il valore che arriva
        // non e' l'indice che quota, quindi meglio niente linea che una linea
        // finta.
        if (chart.data.datasets[5]) {
            chart.data.datasets[5].data = dataPoints.map(
                (d) => (d.time >= APERTURA_USA ? (d.spx ?? null) : null));
            chart.data.datasets[5].hidden = !mostraSpx;
        }
        
        // Ported from logica.zip: Add Cone datasets
        if (chart.data.datasets.length > 3) {
            chart.data.datasets[2].data = dataPoints.map((d) => d.coneUp ?? null);
            chart.data.datasets[3].data = dataPoints.map((d) => d.coneDown ?? null);
            // Nascoste per dataset e non svuotando i dati: cosi' l'asse non si
            // riscala quando tornano, e la legenda resta coerente.
            chart.data.datasets[2].hidden = !mostraStraddle;
            chart.data.datasets[3].hidden = !mostraStraddle;
        }




        const newAnnotations: any = {};
        const baseConfigs = [
            // Mattina: tratteggiata. Sono i livelli delle 10:35, calcolati
            // sulla chain ES quando l'America dorme ancora: restano un
            // riferimento, ma non sono quelli su cui si sta scambiando.
            { key: 'r1Down', color: '#ef4444', dash: [6, 3] },
            { key: 'r2Down', color: '#f97316', dash: [6, 3] },
            { key: 'r3Down', color: '#facc15', dash: [6, 3] },
            { key: 'r1Up', color: '#3b82f6', dash: [6, 3] },
            { key: 'r2Up', color: '#06b6d4', dash: [6, 3] },
            { key: 'r3Up', color: '#10b981', dash: [6, 3] },
            // Opening Bell: continua, perche' a mercato aperto e' quella che
            // conta e la linea piena e' quella che l'occhio segue.
            { key: 'r1DownOb', color: '#ef4444', dash: [] },
            { key: 'r2DownOb', color: '#f97316', dash: [] },
            { key: 'r3DownOb', color: '#facc15', dash: [] },
            { key: 'r1UpOb', color: '#3b82f6', dash: [] },
            { key: 'r2UpOb', color: '#06b6d4', dash: [] },
            { key: 'r3UpOb', color: '#10b981', dash: [] },
        ];

        baseConfigs.forEach(({ key, color, dash }) => {
            const val = refLines[key as keyof ReferenceLines];
            if (val && !isNaN(parseFloat(val)) && refLineVisibility[key as keyof RefLineVisibility]) {
                newAnnotations[key] = {
                    type: 'line', yMin: parseFloat(val), yMax: parseFloat(val),
                    yScaleID: 'y-right', borderColor: color, borderWidth: 2, borderDash: dash,
                };
            }
        });



        // Gli stessi sei livelli dell'Opening Bell in termini SPX. Non sono
        // un secondo calcolo: `calcRange` parte dallo SPX e aggiunge il basis
        // per esprimerli su ES, qui il basis si toglie. Partono dalle 15:35,
        // l'ora dello scatto da cui sono ricavati: prima di allora non
        // esistevano.
        if (mostraRangeSpxOb && obResults) {
            const daIdx = dataPoints.findIndex((d) => d.time >= OB_SNAPSHOT);
            if (daIdx >= 0) {
                const spxConfigs = [
                    { key: 'r1Down', color: '#ef4444', label: 'R1↓ SPX' },
                    { key: 'r2Down', color: '#f97316', label: 'R2↓ SPX' },
                    { key: 'r3Down', color: '#facc15', label: 'R3↓ SPX' },
                    { key: 'r1Up', color: '#3b82f6', label: 'R1↑ SPX' },
                    { key: 'r2Up', color: '#06b6d4', label: 'R2↑ SPX' },
                    { key: 'r3Up', color: '#10b981', label: 'R3↑ SPX' },
                ] as const;
                spxConfigs.forEach(({ key, color, label }) => {
                    const val = obResults[key] - obResults.basis;
                    newAnnotations[`${key}ObSpx`] = {
                        type: 'line',
                        xScaleID: 'x',
                        xMin: dataPoints[daIdx].time,
                        xMax: dataPoints[dataPoints.length - 1].time,
                        yMin: val, yMax: val,
                        yScaleID: 'y-right',
                        borderColor: color,
                        borderWidth: 1.5,
                        borderDash: [2, 2],
                        label: {
                            display: true,
                            content: label,
                            position: 'start',
                            backgroundColor: 'rgba(15, 23, 42, 0.75)',
                            color,
                            font: { size: 9, weight: 'bold' },
                        },
                    };
                });
            }
        }

        // Divergence boxes
        if (showDivergences) {
            const divAnnotations = detectDivergences(dataPoints, livelliPerDivergenze);
            Object.assign(newAnnotations, divAnnotations);
        }

        chart.options.plugins.annotation.annotations = newAnnotations;

        // Determine independent locks & handle Auto-Scroll
        const prevMax = chart.scales.x.max;
        const prevDataLen = chart.data.labels.length - 1; 
        const isAtEnd = prevMax >= prevDataLen - 1; // Within 1 point of the end

        chart.data.labels = dataPoints.map((d) => d.time);
        const newDataLen = dataPoints.length;

        // Auto-scroll logic: If we were at the end, shift the window forward
        if (!panLibRef.current && isAtEnd && (isZoomedRef.current || manualZoomRef.current) && manualLimitsRef.current?.x) {
            const currentRange = manualLimitsRef.current.x[1] - manualLimitsRef.current.x[0];
            const newMax = newDataLen - 1;
            const newMin = Math.max(0, newMax - currentRange);
            manualLimitsRef.current.x = [newMin, newMax];
        }

        const xLocked = (isZoomedRef.current || manualZoomRef.current) && manualLimitsRef.current?.x;
        const yLeftLocked = manualYLeftZoomingRef.current && manualLimitsRef.current?.yLeft;
        const yRightLocked = manualYRightZoomingRef.current && manualLimitsRef.current?.yRight;

        // Apply X lock
        if (xLocked && manualLimitsRef.current?.x) {
            chart.options.scales.x.min = manualLimitsRef.current.x[0];
            chart.options.scales.x.max = manualLimitsRef.current.x[1];
        } else {
            delete chart.options.scales.x.min;
            delete chart.options.scales.x.max;
        }

        // Determine visible window indices for adaptive scaling
        const xMinIdx = chart.scales.x.min !== undefined ? Math.max(0, Math.floor(chart.scales.x.min)) : 0;
        const xMaxIdx = chart.scales.x.max !== undefined ? Math.min(dataPoints.length - 1, Math.ceil(chart.scales.x.max)) : dataPoints.length - 1;
        const visiblePoints = dataPoints.slice(xMinIdx, xMaxIdx + 1);

        // Handle Y Scales (Auto-scaling vs Lock)
        if (visiblePoints.length > 0) {
            // 1. Scale proporzionali: stessa distanza verticale = stessa
            //    variazione percentuale, su entrambi gli assi.
            //
            //    ES sta attorno a 7800 e il VIX attorno a 14,7: qualunque
            //    scala calcolata in valore assoluto rende le due linee
            //    incomparabili. Con l'autoscala indipendente ciascuna riempiva
            //    l'altezza disponibile, e un VIX fermo sembrava agitato quanto
            //    un ES in tendenza. Qui si sceglie UNA semi-ampiezza relativa
            //    `p` valida per entrambi: l'asse di ES diventa
            //    [centroEs*(1-p), centroEs*(1+p)] e quello del VIX
            //    [centroVix*(1-p), centroVix*(1+p)]. A quel punto un
            //    movimento dell'1% occupa lo stesso spazio sui due assi, e il
            //    rapporto visivo fra le linee e' quello vero.
            // Con la linea SPX accesa l'asse destro deve contenere due prezzi
            // distanti quanto il basis, che a indice 6.600 vale mezzo punto
            // percentuale: tarandolo sul solo ES la linea verde finirebbe
            // sotto il bordo.
            const esfValues = visiblePoints
                .flatMap(d => [d.esf, mostraSpx && d.time >= APERTURA_USA ? (d.spx ?? null) : null])
                .filter((v): v is number => v !== null && v !== undefined);
            const vixValuesAuto = visiblePoints.map(d => d.vix).filter((v): v is number => v !== null);
            const semiRelativa = (v: number[]) => {
                if (v.length === 0) return null;
                const lo = Math.min(...v), hi = Math.max(...v), c = (lo + hi) / 2;
                return c > 0 ? { centro: c, rel: (hi - lo) / 2 / c } : null;
            };
            const es = semiRelativa(esfValues);
            const vix = semiRelativa(vixValuesAuto);

            // Soglia minima: con una linea perfettamente piatta `rel` e' zero e
            // l'asse degenererebbe in un punto.
            const MIN_REL = 0.0004;
            let p = Math.max(es?.rel ?? 0, vix?.rel ?? 0, MIN_REL) * 1.18;

            // Le linee di riferimento allargano la scala solo se non la
            // stravolgono: R3 puo' stare all'1,8% dallo spot, quasi dieci volte
            // l'escursione di una giornata tranquilla, e includerla a forza
            // schiacciava ES in una banda sottile. Oltre il doppio della
            // finestra si lascia fuori: per vederla basta allargare lo zoom.
            if (es) {
                const livelliSpx = mostraRangeSpxOb && obResults
                    ? [obResults.r1Up, obResults.r2Up, obResults.r3Up,
                       obResults.r1Down, obResults.r2Down, obResults.r3Down]
                        .map((v) => v - obResults.basis)
                    : [];
                const distanzeRef = Object.entries(refLines)
                    .filter(([k]) => (refLineVisibility as unknown as Record<string, boolean | undefined>)[k] !== false)
                    .map(([, v]) => parseFloat(v))
                    .concat(livelliSpx)
                    .filter((v) => !isNaN(v))
                    .map((v) => Math.abs(v - es.centro) / es.centro);
                const vicine = distanzeRef.filter((d) => d <= p * 2);
                if (vicine.length > 0) p = Math.max(p, Math.max(...vicine) * 1.08);
            }

            if (!yRightLocked && es) {
                chart.options.scales['y-right'].min = es.centro * (1 - p);
                chart.options.scales['y-right'].max = es.centro * (1 + p);
            }
            if (!yLeftLocked && vix) {
                chart.options.scales['y-left'].min = vix.centro * (1 - p);
                chart.options.scales['y-left'].max = vix.centro * (1 + p);
            }

            if (yRightLocked) {
                // Asse bloccato dallo zoom: si conserva l'ampiezza scelta ma si
                // sposta l'intervallo se ES sta uscendo dalla finestra.
                const bloccato: [number, number] = manualLimitsRef.current?.yRight
                    ?? [chart.scales['y-right'].min, chart.scales['y-right'].max];
                const esValues = visiblePoints.map(d => d.esf).filter((v): v is number => v !== null);
                // Se hai posizionato la vista trascinando, resta dove l'hai
                // messa: l'ancoraggio serve solo a rimediare allo zoom.
                const [rMin, rMax] = (panLibRef.current || axisPinnedRef.current['y-right'])
                    ? bloccato
                    : ancoraAiDati(bloccato, esValues);
                chart.options.scales['y-right'].min = rMin;
                chart.options.scales['y-right'].max = rMax;
                if (manualLimitsRef.current) manualLimitsRef.current.yRight = [rMin, rMax];
            }

            // 2. Asse del VIX quando e' bloccato dallo zoom (quello
            //    automatico e' gia' stato calcolato sopra, in proporzione).
            if (yLeftLocked) {
                const bloccato: [number, number] = manualLimitsRef.current?.yLeft
                    ?? [chart.scales['y-left'].min, chart.scales['y-left'].max];
                const vixValues = visiblePoints.map(d => d.vix).filter((v): v is number => v !== null);
                const [rMin, rMax] = (panLibRef.current || axisPinnedRef.current['y-left'])
                    ? bloccato
                    : ancoraAiDati(bloccato, vixValues);
                chart.options.scales['y-left'].min = rMin;
                chart.options.scales['y-left'].max = rMax;
                if (manualLimitsRef.current) manualLimitsRef.current.yLeft = [rMin, rMax];
            }
        }

        chart.update('none');
    }, [dataPoints, firstEsfValue, refLines, refLineVisibility, showDivergences, detectDivergences, livelliPerDivergenze, mostraStraddle, mostraSpx, mostraRangeSpxOb, obResults]);

    // ---- Plugins (zoom) ----
    useEffect(() => {
        const initPlugins = async () => {
            try {
                const zoomPlugin = (await import('chartjs-plugin-zoom')).default;
                ChartJS.register(zoomPlugin);
                setPluginsReady(true);
            } catch (err) {
                console.error('Error loading zoom plugin:', err);
                setPluginsReady(true);
            }
        };
        initPlugins();
    }, []);

    // ---- Reference lines persistence ----
    // La logica sta in lib/refLines: la legge anche /gex, e tenerne due copie
    // e' gia' costato un asse Y andato a 2026.
    useEffect(() => {
        const salvate = leggiRefLines();
        if (salvate) setRefLines(prev => ({ ...prev, ...salvate }));
        const vis = leggiVisibilita();
        if (vis) setRefLineVisibility(prev => ({ ...prev, ...vis }));
    }, []);

    useEffect(() => {
        salvaRefLines(refLines as unknown as Record<string, string>);
    }, [refLines]);

    useEffect(() => {
        localStorage.setItem(REF_LINES_VIS_KEY, JSON.stringify(refLineVisibility));
    }, [refLineVisibility]);

    // ---- Range Calculator persistence ----
    useEffect(() => {
        const todayKey = getTodayKey();
        const savedMorning = localStorage.getItem(`rangeCalc_morning_${todayKey}`);
        if (savedMorning) {
            try { setRangeCalcMorning(JSON.parse(savedMorning)); } catch { }
        }
        const savedOb = localStorage.getItem(`rangeCalc_ob_${todayKey}`);
        if (savedOb) {
            try { setRangeCalcOb(JSON.parse(savedOb)); } catch { }
        }
    }, []);

    useEffect(() => {
        const todayKey = getTodayKey();
        localStorage.setItem(`rangeCalc_morning_${todayKey}`, JSON.stringify(rangeCalcMorning));
    }, [rangeCalcMorning]);

    useEffect(() => {
        const todayKey = getTodayKey();
        localStorage.setItem(`rangeCalc_ob_${todayKey}`, JSON.stringify(rangeCalcOb));
    }, [rangeCalcOb]);


    const applyToChart = useCallback((session: 'morning' | 'ob') => {
        const results = session === 'morning' ? morningResults : obResults;
        if (!results) return;

        const suffix = session === 'ob' ? 'Ob' : '';
        setRefLines(prev => ({
            ...prev,
            [`r1Up${suffix}`]: results.r1Up.toFixed(2),
            [`r1Down${suffix}`]: results.r1Down.toFixed(2),
            [`r2Up${suffix}`]: results.r2Up.toFixed(2),
            [`r2Down${suffix}`]: results.r2Down.toFixed(2),
            [`r3Up${suffix}`]: results.r3Up.toFixed(2),
            [`r3Down${suffix}`]: results.r3Down.toFixed(2),
        } as any));
    }, [morningResults, obResults]);

    // Applicazione automatica al grafico appena i livelli sono calcolabili.
    // Una volta sola per sessione e per caricamento di pagina, e solo se le
    // linee non ci sono gia': se le hai tolte a mano non te le rimetto.
    const autoApplicati = useRef<{ morning: boolean; ob: boolean }>({ morning: false, ob: false });

    useEffect(() => {
        if (!morningResults || autoApplicati.current.morning) return;
        autoApplicati.current.morning = true;
        if (!refLines.r1Up) applyToChart('morning');
    }, [morningResults, refLines.r1Up, applyToChart]);

    useEffect(() => {
        if (!obResults || autoApplicati.current.ob) return;
        autoApplicati.current.ob = true;
        if (!refLines.r1UpOb) applyToChart('ob');
    }, [obResults, refLines.r1UpOb, applyToChart]);

    const autoFillLivePrices = useCallback((session: 'morning' | 'ob') => {
        const latestPoint = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1] : null;
        const esVal = latestPoint?.esf ?? (dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].esf : null);
        const spxVal = latestPoint?.spx ?? (esVal !== null && esVal !== undefined ? esVal - 15 : null);

        const setInput = session === 'morning' ? setRangeCalcMorning : setRangeCalcOb;
        if (esVal !== null && esVal !== undefined) {
            setInput(prev => ({
                ...prev,
                es: esVal.toFixed(2),
                spx: spxVal !== null && spxVal !== undefined ? spxVal.toFixed(2) : prev.spx,
            }));
        }
    }, [dataPoints]);

    // ---- Persist intraday data to localStorage by date ----
    const persistDataPoints = useCallback((points: DataPoint[]) => {
        const key = `marketData_${getTodayKey()}`;
        try {
            localStorage.setItem(key, JSON.stringify(points));
        } catch { }
    }, []);


    // ---- Live data fetch ----
    const fetchData = useCallback(async () => {
        try {
            const res = await fetch('/api/market', { cache: 'no-store' });
            if (!res.ok) throw new Error('API error');
            const data = await res.json();
            if (data.error) {
                setStatus('error');
                return;
            }

            const now = new Date();
            const timeStr = now.toLocaleTimeString('it-IT', {
                timeZone: 'Europe/Rome',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            // Automatic snapshot at 10:35 CET and 15:35 CET
            if (data.esf !== null && data.esf !== undefined) {
                const hours = now.getHours();
                const minutes = now.getMinutes();
                const esfStr = data.esf.toFixed(2);
                // SPX vero se l'indice quota; altrimenti il riferimento del
                // poller (ultimo prezzo, poi chiusura precedente). Il basis
                // che ne esce include il movimento notturno, quindi e' una
                // stima -- ma e' misurata, non il 15 fisso di prima.
                const spxRef = data.spx ?? data.spxRef ?? null;
                const spxStr = spxRef ? spxRef.toFixed(2) : (data.esf - 15).toFixed(2);

                const q = (v: unknown) => (typeof v === 'number' && isFinite(v) && v > 0 ? v.toFixed(2) : '');

                // Non piu' il minuto esatto. Bastava un giro di poll saltato --
                // una scheda in secondo piano, che il browser rallenta e dopo
                // qualche minuto congela -- perche' le 10:35 passassero senza
                // che nessuno guardasse, e il pannello restava vuoto per tutto
                // il giorno: il backfill dallo storico gira una volta sola, al
                // caricamento della pagina, quindi chi aveva la dashboard gia'
                // aperta prima delle 10:35 non veniva coperto da nessuno dei
                // due. La finestra e' la stessa mezz'ora di tolleranza del
                // backfill, e riempiVuoti fa si' che a scrivere sia comunque
                // solo il primo giro utile.
                const minutiOra = hours * 60 + minutes;
                const FINESTRA = 30;
                const MATTINA = 10 * 60 + 35;
                const POMERIGGIO = 15 * 60 + 35;

                if (minutiOra >= MATTINA && minutiOra <= MATTINA + FINESTRA) {
                    // Straddle dalla chain ES: alle 10:35 CET sono le 04:35 a
                    // New York e le SPX quotano in Global Trading Hours con
                    // spread larghi, mentre le ES 0DTE sono piene su CME.
                    setRangeCalcMorning(prev => riempiVuoti(prev, {
                        es: esfStr, spx: spxStr,
                        callBid: q(data.esCallBid), callAsk: q(data.esCallAsk),
                        putBid: q(data.esPutBid), putAsk: q(data.esPutAsk),
                    }));
                } else if (minutiOra >= POMERIGGIO && minutiOra <= POMERIGGIO + FINESTRA) {
                    // A mercato aperto lo straddle torna sulla chain SPX.
                    setRangeCalcOb(prev => riempiVuoti(prev, {
                        es: esfStr, spx: spxStr,
                        callBid: q(data.callBid), callAsk: q(data.callAsk),
                        putBid: q(data.putBid), putAsk: q(data.putAsk),
                    }));
                }
            }

            setDataPoints((prev) => {
                const newPoint: DataPoint = {
                    time: timeStr,
                    vix: data.vix,
                    esf: data.esf,
                    spx: data.spx,
                    coneUp: data.coneUp,
                    coneDown: data.coneDown,
                    vwap: data.vwap,
                };
                if (prev.length === 0 && data.esf !== null) {
                    setFirstEsfValue(data.esf);
                }
                // Il poller scrive ogni 15 secondi, qui si interroga ogni 5:
                // senza questo controllo lo stesso punto verrebbe appeso tre
                // volte. Si continua a interrogare a 5 secondi perche' costa
                // poco (~180 byte) e fa comparire il dato nuovo subito.
                if (data.sourceTime && data.sourceTime === lastSourceTime.current) {
                    return prev;
                }
                if (data.sourceTime) lastSourceTime.current = data.sourceTime;
                const updated = [...prev, newPoint].slice(-2000); // ~8h20m a 15s
                persistDataPoints(updated);
                return updated;
            });

            setLastUpdate(timeStr);
            setStatus('live');
        } catch {
            setStatus('error');
        }
    }, [persistDataPoints]);

    /**
     * Compila i pannelli Range dallo storico.
     *
     * L'auto-compilazione dal vivo scatta solo se la pagina e' aperta esattamente
     * alle 10:35 o alle 15:35: chi apre la dashboard piu' tardi non la vedeva
     * mai scattare. Qui si ripesca il primo punto utile a partire da quell'ora,
     * cosi' il pannello si riempie a qualunque ora si apra la pagina.
     */
    const backfillRangeCalc = useCallback((history: Record<string, unknown>[]) => {
        const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

        const findAt = (target: string, campi: string[]) => {
            // Tolleranza di 30 minuti: se il poller era fermo all'orario esatto
            // si prende il primo punto buono successivo, invece di rinunciare.
            const [th, tm] = target.split(':').map(Number);
            const limite = th * 60 + tm + 30;
            for (const p of history) {
                const t = typeof p.time === 'string' ? p.time : '';
                if (!t || t < target) continue;
                const [h, m] = t.split(':').map(Number);
                if (h * 60 + m > limite) break;
                if (campi.every((c) => num(p[c]) !== null) && num(p.esf) !== null) return p;
            }
            return null;
        };

        const applica = (
            punto: Record<string, unknown> | null,
            chiavi: { call: string; callA: string; put: string; putA: string },
            setter: typeof setRangeCalcMorning,
        ) => {
            if (!punto) return;
            const spot = num(punto.spx) ?? num(punto.spxRef);
            const proposta: RangeCalcInput = {
                es: (num(punto.esf) as number).toFixed(2),
                spx: (spot ?? (num(punto.esf) as number) - 15).toFixed(2),
                callBid: (num(punto[chiavi.call]) as number).toFixed(2),
                callAsk: (num(punto[chiavi.callA]) as number).toFixed(2),
                putBid: (num(punto[chiavi.put]) as number).toFixed(2),
                putAsk: (num(punto[chiavi.putA]) as number).toFixed(2),
            };
            // Si riempie campo per campo, non tutto-o-niente. La versione
            // precedente si arrendeva se `es` era gia' valorizzato, e bastava
            // aver avuto la pagina aperta alle 15:35 con una build vecchia --
            // che scriveva solo es e spx -- perche' le quote non entrassero
            // mai piu' e il pannello restasse muto: calcRange vuole tutti e
            // sei i campi, con cinque su sei non calcola niente.
            setter((prev) => riempiVuoti(prev, proposta));
        };

        // La mattina si usa la chain ES, il pomeriggio quella SPX.
        applica(
            findAt('10:35:00', ['esCallBid', 'esCallAsk', 'esPutBid', 'esPutAsk']),
            { call: 'esCallBid', callA: 'esCallAsk', put: 'esPutBid', putA: 'esPutAsk' },
            setRangeCalcMorning,
        );
        applica(
            findAt('15:35:00', ['callBid', 'callAsk', 'putBid', 'putAsk']),
            { call: 'callBid', callA: 'callAsk', put: 'putBid', putA: 'putAsk' },
            setRangeCalcOb,
        );
    }, []);

    // ---- Main mount logic ----
    useEffect(() => {
        if (!isAuthorized) return;

        const startup = async () => {
            const todayKey = getTodayKey();
            const localKey = `marketData_${todayKey}`;

            // Le sessioni passate non si tengono: senza questa passata il
            // browser accumulava una copia di ogni giornata, che nessuno
            // rilegge piu' ma che resta li' a occupare la quota.
            try {
                const vecchie = Object.keys(localStorage).filter(
                    (k) => /^(marketData|rangeCalc_morning|rangeCalc_ob)_\d{4}-\d{2}-\d{2}$/.test(k)
                        && !k.endsWith(todayKey),
                );
                vecchie.forEach((k) => localStorage.removeItem(k));
            } catch { }

            // If it's 00:00 start, clear old data
            if (isTradingJustStarted()) {
                localStorage.removeItem(localKey);
            }

            // Try to load from localStorage first
            const cached = localStorage.getItem(localKey);
            if (cached) {
                try {
                    const parsed = JSON.parse(cached) as DataPoint[];
                    if (parsed.length > 0) {
                        setDataPoints(parsed);
                        const firstValid = parsed.find(p => p.esf !== null);
                        if (firstValid) setFirstEsfValue(firstValid.esf);
                        setLastUpdate(parsed[parsed.length - 1].time);
                        setStatus(isInTradingHours() ? 'live' : 'paused');
                    }
                } catch { }
            }

            // Also fetch yfinance history to fill in any gaps (even if we have cache)
            try {
                const res = await fetch('/api/market?history=true', { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    if (data.history && data.history.length > 0) {
                        const history = data.history as DataPoint[];
                        setDataPoints(history);
                        const firstValid = history.find(p => p.esf !== null);
                        if (firstValid) setFirstEsfValue(firstValid.esf);
                        setLastUpdate(history[history.length - 1].time);
                        persistDataPoints(history);
                        setStatus(isInTradingHours() ? 'live' : 'paused');
                        backfillRangeCalc(history as unknown as Record<string, unknown>[]);
                    }
                }
            } catch { }

            // Start polling only within trading hours
            if (isInTradingHours()) {
                fetchData();
                intervalRef.current = setInterval(fetchData, 5000);
            } else {
                setStatus(dataPoints.length > 0 ? 'paused' : 'paused');
            }

            // Watch for session boundary changes every minute
            sessionWatchRef.current = setInterval(() => {
                const hour = new Date().getHours();
                const minutes = new Date().getMinutes();

                if (hour === 0 && minutes === 5) {
                    // New session start at 00:05: clear data and start fresh
                    localStorage.removeItem(`marketData_${getTodayKey()}`);
                    setDataPoints([]);
                    setFirstEsfValue(null);
                    setLastUpdate('');

                    // Start polling
                    if (intervalRef.current) clearInterval(intervalRef.current);
                    fetchData();
                    intervalRef.current = setInterval(fetchData, 5000);
                    setStatus('live');
                } else if (hour === 23 && minutes === 0) {
                    // End of session: stop polling
                    if (intervalRef.current) {
                        clearInterval(intervalRef.current);
                        intervalRef.current = null;
                    }
                    setStatus('paused');
                }
            }, 30000); // check every 30s

        };

        startup();

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
            if (sessionWatchRef.current) clearInterval(sessionWatchRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthorized]);

    // ---- Reference line handlers ----
    const handleRefLineChange = (key: keyof ReferenceLines, value: string) => {
        setRefLines((prev) => ({ ...prev, [key]: value }));
    };
    const toggleRefLineVisibility = (key: keyof RefLineVisibility) => {
        setRefLineVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    /**
     * Almeno uno dei livelli R1/R2/R3 e' acceso?
     *
     * Serve a decidere cosa fa l'interruttore unico: se se ne vede anche uno
     * solo li spegne tutti, altrimenti li riaccende. Cosi' un solo comando
     * basta sempre, senza stati intermedi da indovinare.
     */
    const straddleVisibile = Object.values(refLineVisibility).some(Boolean);

    /**
     * Accende o spegne in blocco i dodici livelli R1/R2/R3.
     *
     * Gli occhietti nel pannello Ref Lines ci sono da sempre, ma sono uno per
     * linea e stanno dentro un pannello da aprire: per togliere di mezzo i
     * range mentre si guarda il grafico ci volevano dodici clic e due
     * passaggi. La visibilita' finisce nel localStorage, che la pagina del
     * gamma rilegge: spegnendole qui spariscono anche di la'.
     */
    const toggleStraddle = () => {
        const acceso = !straddleVisibile;
        setRefLineVisibility((prev) => {
            const nuovo = { ...prev };
            (Object.keys(nuovo) as (keyof RefLineVisibility)[]).forEach((k) => { nuovo[k] = acceso; });
            return nuovo;
        });
    };

    // ---- Crosshair ----
    const handleMouseMove = (e: React.MouseEvent) => {
        const chart = chartRef.current;
        if (!chart) return;
        const rect = chart.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (x >= chart.chartArea.left && x <= chart.chartArea.right &&
            y >= chart.chartArea.top && y <= chart.chartArea.bottom) {
            chart.crosshair = { x, y };
        } else {
            chart.crosshair = null;
        }
        chart.draw();
    };
    const handleMouseOut = () => {
        if (chartRef.current) {
            chartRef.current.crosshair = null;
            chartRef.current.draw();
        }
    };

    // ---- Wheel Zoom (only when mouse is over the X axis) ----
    const handleWheel = (e: React.WheelEvent) => {
        const chart = chartRef.current;
        if (!chart) return;

        const rect = chart.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Only zoom if mouse is over the X axis area
        const xScale = chart.scales.x;
        if (y < xScale.top || y > xScale.bottom || x < xScale.left || x > xScale.right) return;

        e.preventDefault();

        const factor = e.deltaY < 0 ? 0.85 : 1.18; // scroll up = zoom in, down = zoom out

        const r0Raw = xScale.min;
        const r1Raw = xScale.max;
        // getDecimalForValue for string labels; otherwise use numeric directly
        const r0 = typeof r0Raw === 'string' ? xScale.getDecimalForValue(r0Raw) : r0Raw;
        const r1 = typeof r1Raw === 'string' ? xScale.getDecimalForValue(r1Raw) : r1Raw;

        const span = r1 - r0;
        const center = (r0 + r1) / 2;
        const newSpan = span * factor;

        chart.options.scales.x.min = center - newSpan / 2;
        chart.options.scales.x.max = center + newSpan / 2;

        isZoomedRef.current = true;
        manualZoomRef.current = true;
        updateZoomState();
        chart.update('none');
    };

    // ---- Vertical Zoom (Left Click on Scale) and Pan (Right Click) ----
    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0 && e.button !== 2) return; // Allow left and right click
        const chart = chartRef.current;
        if (!chart) return;

        const rect = chart.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Shift + tasto sinistro sopra un asse Y: lo si trascina su e giu'.
        // Va intercettato prima dello zoom verticale, che occupa la stessa
        // area con lo stesso tasto.
        if (e.button === 0 && e.shiftKey) {
            const asse = (['y-left', 'y-right'] as const).find((id) => {
                const sc = chart.scales[id];
                return sc && x >= sc.left && x <= sc.right && y >= sc.top && y <= sc.bottom;
            });
            if (asse) {
                const sc = chart.scales[asse];
                axisPanRef.current = { active: true, axis: asse, startY: y, startRange: [sc.min, sc.max] };
                isZoomedRef.current = true;
                e.preventDefault();
                return;
            }
        }

        // Check if mouse is over the right scale area (Y-axes)
        // Check if mouse is over the left scale area (VIX)
        const vScale = chart.scales['y-left'];
        let isScaleClick = false;

        if (x >= vScale.left && x <= vScale.right) {
            vertZoomRef.current = {
                active: true,
                axis: 'y-left',
                startY: y,
                startRange: [chart.scales['y-left'].min, chart.scales['y-left'].max],
            };
            isZoomedRef.current = true;
            isScaleClick = true;
        }

        // Check if mouse is over the right scale area (Price)
        const yScale = chart.scales['y-right'];
        if (x >= yScale.left && x <= yScale.right) {
            vertZoomRef.current = {
                active: true,
                axis: 'y-right',
                startY: y,
                startRange: [chart.scales['y-right'].min, chart.scales['y-right'].max],
            };
            isZoomedRef.current = true;
            isScaleClick = true;
        }

        // Check if mouse is over the bottom scale area (X-axis)
        // Only allow Left-click to trigger zoom
        const xScale = chart.scales.x;
        if (e.button === 0 && y >= xScale.top && y <= xScale.bottom) {
            horizZoomRef.current = {
                active: true,
                startX: x,
                startRangeX: [xScale.min, xScale.max],
            };
            isZoomedRef.current = true;
            isScaleClick = true;
        }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
        const chart = chartRef.current;
        if (!chart) return;

        // Trascinamento di un solo asse (Shift): l'ampiezza non cambia, si
        // sposta l'intervallo.
        const trascina = axisPanRef.current;
        if (trascina && trascina.active) {
            const rect = chart.canvas.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const scala = chart.scales[trascina.axis];
            const altezza = scala.bottom - scala.top;
            if (altezza > 0) {
                const [min0, max0] = trascina.startRange;
                // Si parte sempre dai valori di inizio trascinamento: cosi' il
                // movimento non accumula errore e tornando indietro col mouse
                // si torna esattamente da dove si era partiti.
                const perPixel = (max0 - min0) / altezza;
                const salto = (y - trascina.startY) * perPixel;
                const nuovi: [number, number] = [min0 + salto, max0 + salto];

                chart.options.scales[trascina.axis].min = nuovi[0];
                chart.options.scales[trascina.axis].max = nuovi[1];

                manualZoomRef.current = true;
                axisPinnedRef.current[trascina.axis] = true;
                if (trascina.axis === 'y-left') {
                    manualYLeftZoomingRef.current = true;
                    manualLimitsRef.current.yLeft = nuovi;
                } else {
                    manualYRightZoomingRef.current = true;
                    manualLimitsRef.current.yRight = nuovi;
                }

                updateZoomState();
                chart.update('none');
            }
            return;
        }

        // Vertical Zoom (Y-axes)
        if (vertZoomRef.current && vertZoomRef.current.active) {
            const rect = chart.canvas.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const deltaY = y - vertZoomRef.current.startY;
            const factor = 1 + (deltaY / 200);

            const zoomScale = (range: [number, number], f: number) => {
                const center = (range[0] + range[1]) / 2;
                const halfSize = ((range[1] - range[0]) / 2) * f;
                return [center - halfSize, center + halfSize];
            };

            const newRange = zoomScale(vertZoomRef.current.startRange, factor);
            const axis = vertZoomRef.current.axis;

            chart.options.scales[axis].min = newRange[0];
            chart.options.scales[axis].max = newRange[1];

            manualZoomRef.current = true;
            if (axis === 'y-left') manualYLeftZoomingRef.current = true;
            if (axis === 'y-right') manualYRightZoomingRef.current = true;
            
            updateZoomState();
            chart.update('none');
        }

        // Horizontal Zoom (X-axis)
        if (horizZoomRef.current && horizZoomRef.current.active) {
            const rect = chart.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const deltaX = x - horizZoomRef.current.startX;

            // Regular X Zoom (left click over X axis region)
            const factor = 1 - (deltaX / 200); // Inverse for X drag intuition

            const zoomX = (range: [any, any], f: number) => {
                const r0 = typeof range[0] === 'string' ? chart.scales.x.getDecimalForValue(range[0]) : range[0];
                const r1 = typeof range[1] === 'string' ? chart.scales.x.getDecimalForValue(range[1]) : range[1];

                const span = r1 - r0;
                const center = (r0 + r1) / 2;
                const newSpan = span * f;
                const newR0 = center - newSpan / 2;
                const newR1 = center + newSpan / 2;
                return [newR0, newR1];
            };

            const newRangeX = zoomX(horizZoomRef.current.startRangeX, factor);
            chart.options.scales.x.min = newRangeX[0];
            chart.options.scales.x.max = newRangeX[1];
            manualZoomRef.current = true;

            updateZoomState();
            chart.update('none');
        }
    };

    const handleGlobalMouseUp = () => {
        let updated = false;
        if (axisPanRef.current && axisPanRef.current.active) {
            axisPanRef.current.active = false;
            updated = true;
        }
        if (vertZoomRef.current && vertZoomRef.current.active) {
            vertZoomRef.current.active = false;
            updated = true;
        }
        if (horizZoomRef.current && horizZoomRef.current.active) {
            horizZoomRef.current.active = false;
            updated = true;
        }
        if (updated) {
            updateZoomState();
        }
    };

    useEffect(() => {
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, []);

    // ---- Zoom controls ----
    const handleZoomIn = (axis: 'x' | 'y') => {
        if (chartRef.current) {
            const chart = chartRef.current;
            chart.zoom(axis === 'x' ? { x: 1.2 } : { y: 1.2 });
            if (axis === 'y') {
                manualYLeftZoomingRef.current = true;
                manualYRightZoomingRef.current = true;
                manualZoomRef.current = true;
                // Si registra l'ampiezza appena ottenuta: senza questo il
                // prossimo aggiornamento riapplicherebbe un intervallo vecchio.
                manualLimitsRef.current = {
                    ...(manualLimitsRef.current ?? { x: null, yLeft: null, yRight: null }),
                    yLeft: [chart.scales['y-left'].min, chart.scales['y-left'].max],
                    yRight: [chart.scales['y-right'].min, chart.scales['y-right'].max],
                };
            }
            updateZoomState();
        }
    };
    const handleZoomOut = (axis: 'x' | 'y') => {
        if (chartRef.current) {
            const chart = chartRef.current;
            chart.zoom(axis === 'x' ? { x: 0.8 } : { y: 0.8 });
            if (axis === 'y') {
                manualYLeftZoomingRef.current = true;
                manualYRightZoomingRef.current = true;
                manualZoomRef.current = true;
                // Si registra l'ampiezza appena ottenuta: senza questo il
                // prossimo aggiornamento riapplicherebbe un intervallo vecchio.
                manualLimitsRef.current = {
                    ...(manualLimitsRef.current ?? { x: null, yLeft: null, yRight: null }),
                    yLeft: [chart.scales['y-left'].min, chart.scales['y-left'].max],
                    yRight: [chart.scales['y-right'].min, chart.scales['y-right'].max],
                };
            }
            updateZoomState();
        }
    };
    const handleResetZoom = () => {
        if (chartRef.current) {
            const chart = chartRef.current;
            chart.resetZoom();
            isZoomedRef.current = false;
            manualZoomRef.current = false;
            panLibRef.current = false;
            manualYLeftZoomingRef.current = false;
            manualYRightZoomingRef.current = false;
            manualLimitsRef.current = { x: null, yLeft: null, yRight: null };
            axisPinnedRef.current = { 'y-left': false, 'y-right': false };

            // Explicitly clear all scale lockings
            delete chart.options.scales.x.min;
            delete chart.options.scales.x.max;
            delete chart.options.scales['y-left'].min;
            delete chart.options.scales['y-left'].max;
            delete chart.options.scales['y-right'].min;
            delete chart.options.scales['y-right'].max;

            setIsLocked(false);
            chart.update();
        }
    };

    // ---- Chart config ----
    const chartData = useMemo(() => ({
        labels: [] as string[],
        datasets: [
            {
                label: 'ES=F (S&P 500 Futures)',
                data: [] as (number | null)[],
                borderColor: '#facc15',
                backgroundColor: 'rgba(250, 204, 21, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1,
                yAxisID: 'y-right',
                fill: false,
            },
            {
                label: 'VIX (Volatility Index)',
                data: [] as (number | null)[],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1,
                yAxisID: 'y-left',
                fill: false,
            },
            {
                label: 'Straddle Up',
                data: [] as (number | null)[],
                borderColor: '#f97316',
                borderWidth: 1,
                borderDash: [2, 4],
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'y-right',
                fill: false,
            },
            {
                label: 'Straddle Down',
                data: [] as (number | null)[],
                borderColor: '#f97316',
                borderWidth: 1,
                borderDash: [2, 4],
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'y-right',
                fill: false,
            },
            {
                // In coda, per non spostare gli indici dei dataset gia' usati
                // altrove (0 = ES, 1 = VIX).
                label: 'VWAP (ES)',
                data: [] as (number | null)[],
                borderColor: '#22d3ee',
                borderWidth: 1.5,
                borderDash: [6, 3],
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'y-right',
                fill: false,
            },
            {
                // Sulla scala di ES, non su una sua: SPX ed ES sono lo stesso
                // sottostante a meno del basis, e vederli distanti quanto il
                // basis li rende e' il motivo per cui la linea sta qui.
                label: 'SPX (cash)',
                data: [] as (number | null)[],
                borderColor: '#22c55e',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1,
                yAxisID: 'y-right',
                fill: false,
            },
        ],
    }), []);

    const chartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index' as const, intersect: false },
        plugins: {
            annotation: { annotations: {} },
            zoom: {
                zoom: {
                    wheel: { enabled: false }, // Wheel zoom handled manually (only on X axis)
                    drag: { enabled: false }, // Disable native drag zoom to ensure custom panning works
                    pinch: { enabled: true },
                    mode: 'x' as const,
                    onZoomComplete: () => {
                        isZoomedRef.current = true;
                        manualZoomRef.current = true;
                        setIsLocked(true);
                        updateZoomState();
                    },
                },
                pan: {
                    enabled: true, // Enable native pan plugin for smooth left-drag panning
                    // Trascinamento libero in tutte le direzioni. Quando lo si
                    // usa, `panLibRef` congela la vista dove l'hai messa: ne'
                    // l'auto-scroll ne' l'ancoraggio agli assi la spostano piu'.
                    mode: 'xy' as const,
                    modifierKey: undefined,
                    // Con Shift sopra un asse Y il trascinamento e' nostro e
                    // muove quella scala soltanto: se lo prendesse anche il
                    // plugin sposterebbe l'intera vista insieme a lei.
                    onPanStart: ({ chart, point, event }: { chart: any; point: { x: number | null; y: number | null }; event: any }) => {
                        if (!event?.srcEvent?.shiftKey || point?.x == null) return true;
                        const px = point.x;
                        const sopraUnAsse = (['y-left', 'y-right'] as const).some((id) => {
                            const sc = chart.scales[id];
                            return sc && px >= sc.left && px <= sc.right;
                        });
                        return !sopraUnAsse;
                    },
                    onPanComplete: ({ chart }: { chart: any }) => {
                        isZoomedRef.current = true;
                        manualZoomRef.current = true;
                        panLibRef.current = true;
                        manualYLeftZoomingRef.current = true;
                        manualYRightZoomingRef.current = true;
                        manualLimitsRef.current = {
                            x: [chart.scales.x.min, chart.scales.x.max],
                            yLeft: [chart.scales['y-left'].min, chart.scales['y-left'].max],
                            yRight: [chart.scales['y-right'].min, chart.scales['y-right'].max],
                        };
                        // We set manual locking specifically when the user interacts 
                        // but we will keep the "other" axis adapting if not touched.
                        // For global pans, we usually lock what was moved.
                        setIsLocked(true);
                        updateZoomState();
                    },
                },
                // Removed limits to allow free panning in any direction
            },
            title: {
                display: false, // Cleaner TV look
            },
            legend: {
                display: true,
                position: 'top' as const,
                align: 'start' as const,
                labels: { color: '#94a3b8', boxWidth: 12, font: { size: 12 } },
            },
            tooltip: { enabled: false },
        },
        scales: {
            x: {
                display: true,
                offset: true,
                ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 11 } },
                grid: { color: 'rgba(51, 65, 85, 0.1)', drawTicks: true },
            },
            'y-left': {
                type: 'linear' as const,
                position: 'left' as const,
                display: true,
                // Un margine sopra e sotto l'escursione dei dati: la linea
                // resta staccata dai bordi invece di strisciarci contro.
                grace: '10%',
                ticks: { color: '#94a3b8', font: { size: 11 }, padding: 8 },
                grid: { color: 'rgba(51, 65, 85, 0.1)' },
            },
            'y-voltide': {
                type: 'linear' as const,
                position: 'left' as const,
                display: false, // Hidden by default for cleaner look
            },
            'y-right': {
                type: 'linear' as const,
                position: 'right' as const,
                display: true,
                grace: '10%',
                ticks: {
                    color: '#94a3b8',
                    font: { size: 11 },
                    padding: 8,
                },
                grid: { display: false },
            },
        },
    }), [updateZoomState]);

    const latestVix = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].vix : null;
    const latestEsf = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].esf : null;

    if (isAuthorized === null) {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
            </div>
        );
    }

    const statusConfig = {
        live: { label: 'LIVE', color: 'bg-green-500/20 text-green-400 border-green-500/30', dot: 'bg-green-400 animate-pulse' },
        paused: { label: 'Outside Trading Hours', color: 'bg-slate-500/20 text-slate-400 border-slate-500/30', dot: 'bg-slate-400' },
        connecting: { label: 'Connecting...', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', dot: 'bg-yellow-400 animate-pulse' },
        error: { label: 'Error', color: 'bg-red-500/20 text-red-400 border-red-500/30', dot: 'bg-red-400' },
    };
    const sc = statusConfig[status];

    return (
        <div className="min-h-screen bg-[#0c0d10] text-slate-300 p-4 md:p-8 font-sans">
            <div className="w-full max-w-[1920px] mx-auto">
                {/* Header */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-6">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-4">
                            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-orange-400 bg-clip-text text-transparent">
                                Market Monitor <span className="text-sm font-light text-slate-500 italic ml-2">ODD LOGIC</span>
                            </h1>
                            <div className="flex items-center gap-2 ml-2">
                                <div className="flex items-center gap-2 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-md">
                                    <span className="text-[10px] font-bold text-blue-400/80 tracking-tight">VIX</span>
                                    <span className="text-lg font-bold text-blue-400 leading-none">
                                        {latestVix !== null ? latestVix.toFixed(2) : '—'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-2 py-1 bg-green-500/10 border border-green-500/20 rounded-md">
                                    <div className="flex flex-col items-end">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-green-400/80 tracking-tight">ES</span>
                                            <span className="text-lg font-bold text-green-400 leading-none">
                                                {latestEsf !== null ? latestEsf.toLocaleString('en-US') : '—'}
                                            </span>
                                        </div>
                                        {firstEsfValue !== null && (
                                            <span className="text-[10px] text-slate-500 font-medium leading-none mt-0.5">
                                                Ø {firstEsfValue.toFixed(0)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                        <p className="text-slate-400 text-sm mt-0.5">
                            VIX & S&P 500 Futures — Daily History & Real-Time
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 mt-3 md:mt-0">
                        {/* Tab Switcher */}
<div className="flex bg-slate-900 border border-slate-700 rounded-lg p-1">
                            <button onClick={() => setActiveTab('market')} className={`px-3 py-1 text-xs font-bold rounded ${activeTab === 'market' ? 'bg-slate-700 text-white' : 'text-slate-500'}`}>CHART</button>
                            <button onClick={() => setActiveTab('gex')} className={`px-3 py-1 text-xs font-bold rounded ${activeTab === 'gex' ? 'bg-slate-700 text-white' : 'text-slate-500'}`}>GEX</button>
                            <button onClick={() => router.push('/spx-volumes')} className="px-3 py-1 text-xs font-bold rounded text-slate-500 hover:text-white">VOLUMI SPX</button>
                            <button onClick={() => router.push('/hedging-pressure')} className="px-3 py-1 text-xs font-bold rounded text-slate-500 hover:text-white">MARKET MAKER</button>
                            <button onClick={() => router.push('/market-tide')} className="px-3 py-1 text-xs font-bold rounded text-slate-500 hover:text-white">MARKET TIDE</button>
                            <button onClick={() => router.push('/bookmap')} className="px-3 py-1 text-xs font-bold rounded text-slate-500 hover:text-white">BOOKMAP</button>
                        </div>
                        
                        {/* Bias su ES da Claude, a titolo di studio */}
                        <button
                            onClick={() => setMostraAi((v) => !v)}
                            title="Segnale AI su ES (studio)"
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${mostraAi
                                ? 'bg-purple-600/30 text-purple-300 border-purple-500/50 hover:bg-purple-600/40'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {mostraAi ? '◉' : '◌'} AI Signal
                        </button>

                        {/* Le due linee del cono */}
                        <button
                            onClick={() => setMostraStraddle((v) => !v)}
                            title={mostraStraddle ? 'Nascondi le linee dello straddle' : 'Mostra le linee dello straddle'}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${mostraStraddle
                                ? 'bg-orange-600/30 text-orange-300 border-orange-500/50 hover:bg-orange-600/40'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {mostraStraddle ? '◉' : '◌'} Straddle
                        </button>

                        {/* L'indice SPX, da mercato aperto, sulla scala di ES */}
                        <button
                            onClick={() => setMostraSpx((v) => !v)}
                            title={mostraSpx ? "Nascondi la linea SPX (dalle 15:30)" : "Mostra la linea SPX dalle 15:30, sulla scala destra"}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${mostraSpx
                                ? 'bg-green-600/30 text-green-300 border-green-500/50 hover:bg-green-600/40'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {mostraSpx ? '◉' : '◌'} SPX
                        </button>

                        {/* I sei livelli dell'Opening Bell in termini SPX */}
                        <button
                            onClick={() => setMostraRangeSpxOb((v) => !v)}
                            title={mostraRangeSpxOb ? "Nascondi i range SPX dell'Opening Bell" : "Mostra i range SPX dell'Opening Bell, dalle 15:35"}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${mostraRangeSpxOb
                                ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50 hover:bg-emerald-600/40'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {mostraRangeSpxOb ? '◉' : '◌'} Range SPX OB
                        </button>

                        {/* I dodici livelli R1/R2/R3, che sono un'altra cosa */}
                        <button
                            onClick={toggleStraddle}
                            title={straddleVisibile ? 'Nascondi i livelli R1/R2/R3 (anche sulla pagina GEX)' : 'Mostra i livelli R1/R2/R3'}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${straddleVisibile
                                ? 'bg-sky-600/30 text-sky-300 border-sky-500/50 hover:bg-sky-600/40'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {straddleVisibile ? '◉' : '◌'} Range
                        </button>

                        {/* Le divergenze stavano nella riga dello zoom, lontane
                            dagli altri due: i tre comandi che accendono e
                            spengono roba sul grafico erano sparsi in due punti
                            diversi dello schermo. */}
                        <button
                            onClick={() => setShowDivergences(!showDivergences)}
                            title={showDivergences ? 'Nascondi le divergenze' : 'Mostra le divergenze'}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors mr-4 ${showDivergences
                                ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30 hover:bg-yellow-500/30'
                                : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'}`}
                        >
                            {showDivergences ? '◉' : '◌'} Divergenze
                        </button>

                        {/* Settings button */}
                        <button
                            onClick={() => setShowSettings(!showSettings)}
                            className="px-3 py-1.5 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-lg text-xs font-medium transition-colors"
                        >
                            ⚙️ Ref Lines
                        </button>

                        {/* Range Calculator button */}
                        <button
                            onClick={() => setShowRangeCalc(!showRangeCalc)}
                            className={`px-3 py-1.5 border rounded-lg text-xs font-bold transition-colors ${showRangeCalc
                                ? 'bg-purple-600/30 text-purple-300 border-purple-500/50 hover:bg-purple-600/40'
                                : 'bg-slate-700/50 hover:bg-slate-700 border-slate-600 text-slate-300'
                            }`}
                        >
                            📐 Range Calc
                        </button>





                        {/* Status badge */}
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${sc.color}`}>
                            <span className={`w-2 h-2 rounded-full ${sc.dot}`} />
                            {sc.label}
                        </span>

                        {lastUpdate && (
                            <span className="text-slate-500 text-xs">Last: {lastUpdate}</span>
                        )}
                    </div>
                </div>

                {/* Outside hours banner */}
                {status === 'paused' && (
                    <div className="mb-5 bg-slate-800/60 border border-slate-700/50 rounded-xl px-5 py-3 flex items-center gap-3">
                        <span className="text-xl">⏸️</span>
                        <div>
                            <p className="text-sm font-medium text-slate-200">Polling inactive — outside trading window</p>
                            <p className="text-xs text-slate-400 mt-0.5">Live data collection runs <span className="text-slate-300 font-medium">00:05 – 23:00</span> (local time). Historical data from today is shown above.</p>
                        </div>
                    </div>
                )}

                {/* Range Calculator Panel */}
                {showRangeCalc && (() => {
                    const activeInput = rangeCalcTab === 'morning' ? rangeCalcMorning : rangeCalcOb;
                    const setActiveInput = rangeCalcTab === 'morning' ? setRangeCalcMorning : setRangeCalcOb;
                    const results = rangeCalcTab === 'morning' ? morningResults : obResults;
                    const sessionLabel = rangeCalcTab === 'morning' ? 'Morning 10:35' : 'Opening Bell 15:35';

                    return (
                        <div className="bg-slate-800/80 backdrop-blur-sm border border-purple-500/30 rounded-xl p-5 mb-4">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-slate-200">📐 IV Range Calculator</h3>
                                <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-0.5">
                                    <button
                                        onClick={() => setRangeCalcTab('morning')}
                                        className={`px-3 py-1 text-xs font-bold rounded transition-colors ${rangeCalcTab === 'morning' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                    >
                                        🌅 Morning
                                    </button>
                                    <button
                                        onClick={() => setRangeCalcTab('ob')}
                                        className={`px-3 py-1 text-xs font-bold rounded transition-colors ${rangeCalcTab === 'ob' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                    >
                                        🔔 Opening Bell
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4 items-start">
                                {/* Input Fields */}
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs text-purple-300/70 font-medium uppercase tracking-wider">{sessionLabel} — Input</p>
                                        <button
                                            onClick={() => autoFillLivePrices(rangeCalcTab)}
                                            className="px-2 py-0.5 bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 rounded text-[10px] font-semibold text-purple-200 transition-colors flex items-center gap-1"
                                            title="Cattura prezzo ES e SPX correnti dal feed live"
                                        >
                                            ⚡ Auto-Fill Prezzi Live
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                        {([
                                            { key: 'spx', label: 'SPX Price' },
                                            { key: 'es', label: 'ES Price' },
                                            { key: 'callBid', label: 'ATM Call Bid' },
                                            { key: 'callAsk', label: 'ATM Call Ask' },
                                            { key: 'putBid', label: 'ATM Put Bid' },
                                            { key: 'putAsk', label: 'ATM Put Ask' },
                                        ] as const).map(({ key, label }) => (
                                            <div key={key}>
                                                <label className="block text-[10px] font-medium text-slate-400 mb-0.5">{label}</label>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={activeInput[key]}
                                                    onChange={(e) => setActiveInput(prev => ({ ...prev, [key]: e.target.value }))}
                                                    placeholder="0.00"
                                                    className="w-full px-2 py-1.5 bg-slate-900/60 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Divider */}
                                <div className="hidden lg:flex items-center justify-center h-full">
                                    <div className="w-px h-full bg-slate-700/50 min-h-[120px]"></div>
                                </div>

                                {/* Calculated Results */}
                                <div>
                                    <p className="text-xs text-purple-300/70 font-medium mb-2 uppercase tracking-wider">Risultati calcolati</p>
                                    {results ? (
                                        <div className="space-y-1.5">
                                            {/* Intermediate values */}
                                            <div className="grid grid-cols-4 gap-1.5 text-xs">
                                                <div className="bg-slate-900/40 rounded px-2 py-1 border border-slate-700/30">
                                                    <span className="text-slate-500">Basis</span>
                                                    <span className="float-right text-slate-300 font-mono">{results.basis.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-slate-900/40 rounded px-2 py-1 border border-slate-700/30">
                                                    <span className="text-slate-500">Call Mid</span>
                                                    <span className="float-right text-slate-300 font-mono">{results.callMid.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-slate-900/40 rounded px-2 py-1 border border-slate-700/30">
                                                    <span className="text-slate-500">Put Mid</span>
                                                    <span className="float-right text-slate-300 font-mono">{results.putMid.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-purple-900/30 rounded px-2 py-1 border border-purple-500/20">
                                                    <span className="text-purple-300">Straddle</span>
                                                    <span className="float-right text-purple-200 font-mono font-bold">{results.straddle.toFixed(2)}</span>
                                                </div>
                                            </div>

                                            {/* Range levels - ES prices */}
                                            <div className="grid grid-cols-3 gap-1.5 text-xs mt-2">
                                                <div className="bg-blue-900/20 rounded px-2 py-1.5 border border-blue-500/20">
                                                    <span className="text-blue-400 font-bold">R1 Up</span>
                                                    <span className="float-right text-blue-300 font-mono">{results.r1Up.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-cyan-900/20 rounded px-2 py-1.5 border border-cyan-500/20">
                                                    <span className="text-cyan-400 font-bold">R2 Up</span>
                                                    <span className="float-right text-cyan-300 font-mono">{results.r2Up.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-green-900/20 rounded px-2 py-1.5 border border-green-500/20">
                                                    <span className="text-green-400 font-bold">R3 Up</span>
                                                    <span className="float-right text-green-300 font-mono">{results.r3Up.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-red-900/20 rounded px-2 py-1.5 border border-red-500/20">
                                                    <span className="text-red-400 font-bold">R1 Down</span>
                                                    <span className="float-right text-red-300 font-mono">{results.r1Down.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-orange-900/20 rounded px-2 py-1.5 border border-orange-500/20">
                                                    <span className="text-orange-400 font-bold">R2 Down</span>
                                                    <span className="float-right text-orange-300 font-mono">{results.r2Down.toFixed(2)}</span>
                                                </div>
                                                <div className="bg-yellow-900/20 rounded px-2 py-1.5 border border-yellow-500/20">
                                                    <span className="text-yellow-400 font-bold">R3 Down</span>
                                                    <span className="float-right text-yellow-300 font-mono">{results.r3Down.toFixed(2)}</span>
                                                </div>
                                            </div>

                                            {/* Apply button */}
                                            <button
                                                onClick={() => applyToChart(rangeCalcTab)}
                                                className="mt-2 w-full py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded-lg transition-colors border border-purple-400/50 shadow-lg shadow-purple-900/30"
                                            >
                                                ✅ APPLY {rangeCalcTab === 'morning' ? 'MORNING' : 'OB'} RANGES TO CHART
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center justify-center h-[120px] text-slate-500 text-sm">
                                            <p>Inserisci tutti i valori per calcolare i range</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Reference Lines Panel */}
                {showSettings && (
                    <div className="bg-slate-800/80 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 mb-6">
                        <h3 className="text-lg font-semibold mb-4 text-slate-200">Reference Lines (ES=F)</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                            {([
                                { key: 'r1Down', label: 'R1 Down', colorClass: 'text-red-400', ringClass: 'focus:ring-red-500/50' },
                                { key: 'r1DownOb', label: 'R1 Down OB', colorClass: 'text-red-400/70', ringClass: 'focus:ring-red-500/50' },
                                { key: 'r2Down', label: 'R2 Down', colorClass: 'text-orange-400', ringClass: 'focus:ring-orange-500/50' },
                                { key: 'r2DownOb', label: 'R2 Down OB', colorClass: 'text-orange-400/70', ringClass: 'focus:ring-orange-500/50' },
                                { key: 'r3Down', label: 'R3 Down', colorClass: 'text-yellow-400', ringClass: 'focus:ring-yellow-500/50' },
                                { key: 'r3DownOb', label: 'R3 Down OB', colorClass: 'text-yellow-400/70', ringClass: 'focus:ring-yellow-500/50' },
                                { key: 'r1Up', label: 'R1 Up', colorClass: 'text-blue-400', ringClass: 'focus:ring-blue-500/50' },
                                { key: 'r1UpOb', label: 'R1 Up OB', colorClass: 'text-blue-400/70', ringClass: 'focus:ring-blue-500/50' },
                                { key: 'r2Up', label: 'R2 Up', colorClass: 'text-cyan-400', ringClass: 'focus:ring-cyan-500/50' },
                                { key: 'r2UpOb', label: 'R2 Up OB', colorClass: 'text-cyan-400/70', ringClass: 'focus:ring-cyan-500/50' },
                                { key: 'r3Up', label: 'R3 Up', colorClass: 'text-green-400', ringClass: 'focus:ring-green-500/50' },
                                { key: 'r3UpOb', label: 'R3 Up OB', colorClass: 'text-green-400/70', ringClass: 'focus:ring-green-500/50' },
                            ] as const).map(({ key, label, colorClass, ringClass }) => (
                                <div key={key} className="bg-slate-900/30 p-2 rounded-lg border border-slate-700/30">
                                    <div className="flex items-center justify-between mb-1">
                                        <label className={`block text-xs font-medium ${colorClass}`}>{label}</label>
                                        <button
                                            onClick={() => toggleRefLineVisibility(key)}
                                            className={`text-slate-400 hover:${colorClass} transition-colors`}
                                            title={refLineVisibility[key] ? 'Hide line' : 'Show line'}
                                        >
                                            {refLineVisibility[key] ? (
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                </svg>
                                            ) : (
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                                </svg>
                                            )}
                                        </button>
                                    </div>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={refLines[key] || ''}
                                        onChange={(e) => handleRefLineChange(key, e.target.value)}
                                        placeholder="e.g. 6850"
                                        className={`w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 ${ringClass}`}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Chart Area */}
                {activeTab === 'market' ? (
                  <div className="bg-[#0c0d10] border border-slate-800/50 rounded-lg p-2 md:p-4 shadow-2xl">
                    {/* Zoom Controls */}
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 font-medium">Zoom X:</span>
                            <button onClick={() => handleZoomOut('x')} className="w-8 h-8 flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition-colors" title="Zoom Out X">−</button>
                            <button onClick={() => handleZoomIn('x')} className="w-8 h-8 flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition-colors" title="Zoom In X">+</button>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 font-medium">Zoom Y:</span>
                            <button onClick={() => handleZoomOut('y')} className="w-8 h-8 flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition-colors" title="Zoom Out Y">−</button>
                            <button onClick={() => handleZoomIn('y')} className="w-8 h-8 flex items-center justify-center bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 hover:text-white transition-colors" title="Zoom In Y">+</button>
                        </div>



                        <button
                            onClick={handleResetZoom}
                            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-300 flex items-center gap-2 ${isLocked
                                ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)] border-blue-400'
                                : 'bg-slate-800/80 text-slate-400 border border-slate-700 hover:bg-slate-700 cursor-default'
                                }`}
                            title={isLocked ? 'Restore Live View' : 'Live Tracking Active'}
                        >
                            {isLocked ? (
                                <><span className="w-2 h-2 bg-white rounded-full animate-pulse"></span> RESTORE LIVE VIEW</>
                            ) : (
                                <><span className="w-2 h-2 bg-green-500 rounded-full"></span> LIVE TRACKING</>
                            )}
                        </button>
                    </div>

                    <div
                        className="h-[calc(100vh-240px)] min-h-[400px] cursor-crosshair"
                        onMouseMove={handleMouseMove}
                        onMouseOut={handleMouseOut}
                        onMouseDown={handleMouseDown}
                        onWheel={handleWheel}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        {dataPoints.length > 0 ? (
                            <Line
                                ref={chartRef}
                                data={chartData}
                                options={chartOptions}
                                plugins={[scaleBackgroundPlugin, crosshairPlugin, priceTagPlugin]}
                            />
                        ) : (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                    <div className="w-12 h-12 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                                    <p className="text-slate-400 text-sm">
                                        {status === 'paused'
                                            ? 'No data yet — polling starts at 00:00'
                                            : 'Loading session data...'}
                                    </p>
                                </div>
                            </div>
                        )}
                          </div>
                      </div>
                    ) : (
                      <div className="w-full h-[calc(100vh-240px)] min-h-[400px] bg-[#0c0d10] border border-slate-800/50 rounded-lg p-4 shadow-2xl">
                        <GexPage />
                      </div>
                    )}
                {mostraAi && <AiSignalPanel onClose={() => setMostraAi(false)} />}
                {/* Footer */}
                <div className="mt-4 text-center text-slate-600 text-xs">
                    Data refreshed every 5 seconds • Active window: 00:00–23:00 CET • Source: IBKR TWS
                    <br />
                    <span className="text-slate-500">💡 Tip: Rotella sull&apos;asse X = zoom orizzontale • Trascina grafico = pan completo • Trascina assi Y = scala verticale</span>
                </div>
            </div>
        </div>
    );
}
