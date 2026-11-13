/**
 * La curva dello smile SPX 0DTE a destra del grafico di /market (Optix Smile).
 *
 * Si disegna nella colonna dell'asse `y-smile`, che sta fra l'area del
 * grafico e la scala dei prezzi: un asse vuoto che serve solo a riservare lo
 * spazio. Le y sono prezzi SPX, portati sulla scala ES con la stessa basis
 * della colonna SPX (`chart.$basisSpx`): senza basis, prima delle 15:30, la
 * curva non si disegna. Le x sono l'IV: piu' a sinistra = IV piu' bassa = piu'
 * spazio di movimento, piu' a destra = il livello respinge.
 *
 * - linea grigia sulla IV OTM (put sotto lo spot, call da lo spot in su), in
 *   media a 3 strike perche' non segua il rumore di uno solo;
 * - pallino verde = IV della call, rosso = IV della put; quello del lato non
 *   OTM resta staccato dalla curva; vuoto oltre +-2 sigma;
 * - frecce = convexity ladder: arancio da sinistra = taker corti di
 *   convessita' (gamma netta < 0), azzurra da destra = taker lunghi.
 *
 * - linee orizzontali su tutto il grafico: le bande di chiusura 68%
 *   (tratteggio lungo) e 95% (puntinato) e il vertice IV MIN (viola, piena),
 *   che non e' orizzontale: segue nel tempo i cambi di strike del vertice, a
 *   gradini. Dal 03/11/2026 le bande sono quelle calibrate di
 *   lib/volContesto.ts (VIX1D x quantili osservati): lo Spot +-1/2 sigma
 *   dell'IV 0DTE, piu' largo del vero, resta solo se le bande mancano
 *   (niente VIX1D, prima delle 9:45 o dopo le 15:50 NY).
 */

import { oraRomaDaNy } from './orarioNy';
import type { Vol } from './volContesto';

export const SMILE_COL = 180;

/**
 * Il resoconto (contesto, bande, regime, IV ATM, vertice, z) sta in una fascia
 * SOPRA il grafico, allineata a destra e su piu' colonne, non piu' in testa
 * alla colonna dello smile: il 06/11/2026 l'utente ha chiesto di spostarlo
 * perche' copriva la curva. La fascia e' il `layout.padding.top` del grafico,
 * messo da `beforeLayout` solo quando lo smile e' acceso.
 */
const RES_COLONNE = 3;
const RES_COLONNA_PX = 205;
const RES_RIGA_PX = 13;
type Riga = [string, string, string];
const altezzaResoconto = (n: number) => (n === 0 ? 0 : 6 + Math.ceil(n / RES_COLONNE) * RES_RIGA_PX + 4);

export interface DatiSmile {
    time: string;
    spot: number;
    smile: {
        ivAtm: number | null;
        em: number | null;
        tilt: number | null;
        curv: number | null;
        vertice: { strike: number; iv: number; sigma: number | null } | null;
        base: 'storico' | 'provvisoria' | 'in raccolta';
        z: { tilt: number | null; curv: number | null; ivAtm: number | null } | null;
        regime: string | null;
        /** Dalle 15:15 ET il regime non si calcola: l'IV a ridosso della scadenza e' rumore. */
        sospeso?: boolean;
        /** Dopo la chiusura: niente curva, resta solo la traccia del vertice. */
        chiuso?: boolean;
        /** Una IV a 25 delta presa fuori dai contratti che la racchiudono. */
        est25?: boolean;
        /** Secondi da cui l'IV ATM non cambia. */
        ivFermaSec?: number;
        /** [ora 'HH:MM:SS' italiana, strike] a ogni cambio del vertice, in ordine. */
        storiaVertice?: [string, number][];
        /** [ora italiana, regime] a ogni cambio del regime confermato nell'ultima mezz'ora. */
        cambiRegime?: [string, string][];
    };
    /** Bande di chiusura, divergenze e contesto (lib/volContesto.ts), dal 03/11/2026. */
    vol?: Vol;
    punti: {
        strike: number; callIv: number | null; putIv: number | null; ivOtm: number | null;
        /** IV OTM in media a 3 strike, per la linea; assente prima della v2 di /api/smile. */
        ivLiscia?: number | null;
        conv: number | null;
    }[];
}

const VERDE = '#22c55e';
const ROSSO = '#ef4444';
const ARANCIO = '#f59e0b';
const AZZURRO = '#22d3ee';
const COLORE_1S = 'rgba(226, 232, 240, 0.55)';
const COLORE_2S = 'rgba(148, 163, 184, 0.45)';
const COLORE_VERTICE = 'rgba(192, 132, 252, 0.8)';
const RAGGIO = 4;
const FRECCIA_MAX_PX = 40;
const FRECCIA_MIN_PX = 8;
/** Sotto questa quota della convessita' piu' grande la freccia non si disegna. */
const FRECCIA_SOGLIA = 0.05;
const MARGINE_X = 14;

const COLORE_REGIME: Record<string, string> = {
    'RIALZISTA': VERDE,
    'RIBASSISTA': ROSSO,
    'RANGE A C': '#a855f7',
    'PIATTA': '#94a3b8',
    'PIATTA + VOL ALTA': ARANCIO,
    'PIATTA + VOL BASSA': AZZURRO,
    'NEUTRO': '#cbd5e1',
};

function freccia(ctx: CanvasRenderingContext2D, da: number, a: number, y: number, colore: string) {
    const verso = Math.sign(a - da);
    ctx.strokeStyle = colore;
    ctx.fillStyle = colore;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(da, y);
    ctx.lineTo(a - verso * 5, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a, y);
    ctx.lineTo(a - verso * 7, y - 4);
    ctx.lineTo(a - verso * 7, y + 4);
    ctx.closePath();
    ctx.fill();
}

function pallino(ctx: CanvasRenderingContext2D, x: number, y: number, colore: string, vuoto: boolean) {
    ctx.beginPath();
    ctx.arc(x, y, RAGGIO, 0, Math.PI * 2);
    if (vuoto) {
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.strokeStyle = colore;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    } else {
        ctx.fillStyle = colore;
        ctx.fill();
    }
}

/**
 * Una linea orizzontale su tutto il grafico e sulla colonna, con l'etichetta
 * a destra nella colonna. Tratteggiata e trasparente: passa sopra ES e VIX.
 */
function lineaLivello(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number,
    colore: string, tratto: number[], etichetta: string) {
    ctx.save();
    ctx.strokeStyle = colore;
    ctx.lineWidth = 1;
    ctx.setLineDash(tratto);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colore;
    ctx.fillText(etichetta, x1 - 3, y - 1);
    ctx.restore();
}

/** L'indice della prima etichetta dell'asse x (ore 'HH:MM:SS' in ordine) >= t. */
function indiceOra(etichette: string[], t: string): number {
    let lo = 0;
    let hi = etichette.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (etichette[m] < t) lo = m + 1;
        else hi = m;
    }
    return lo;
}

/**
 * Il vertice IV MIN nel tempo: a gradini, ogni tratto sullo strike che era il
 * vertice da quell'ora al cambio successivo, l'ultimo fino alla colonna con
 * l'etichetta. Tutta la storia e' portata su ES con la basis di adesso: e'
 * lenta, e quella di ogni ora passata non c'e' qui.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- l'istanza Chart.js
function storiaVertice(chart: any, ctx: CanvasRenderingContext2D, storia: [string, number][],
    yDi: (strike: number) => number, x1: number) {
    const etichette: string[] = chart.data.labels ?? [];
    const asseX = chart.scales.x;
    if (storia.length === 0 || etichette.length === 0 || !asseX) return;
    ctx.save();
    ctx.strokeStyle = COLORE_VERTICE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    storia.forEach(([t, strike], i) => {
        const x = Math.max(asseX.getPixelForValue(Math.min(indiceOra(etichette, t), etichette.length - 1)), chart.chartArea.left);
        const y = yDi(strike);
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, yDi(storia[i - 1][1]));
            ctx.lineTo(x, y);
        }
    });
    const ultimo = storia[storia.length - 1][1];
    const y = yDi(ultimo);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.font = '9px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = COLORE_VERTICE;
    ctx.fillText(`IV MIN ${ultimo.toFixed(1)}`, x1 - 3, y - 1);
    ctx.restore();
}

/** Le righe del resoconto: contesto, bande, divergenza, regime, IV ATM, vertice, z-score, avvisi. */
function righeResoconto(s: DatiSmile['smile'], vol: Vol | undefined): Riga[] {
    const righe: Riga[] = [];
    // In testa il contesto della giornata (studio_vol.py: prevede l'ampiezza,
    // non la direzione), poi bande e ultima divergenza.
    const c = vol?.contesto;
    if (c) {
        righe.push(['bold 11px Arial', c.attesa === 'AMPIA' ? ARANCIO : c.attesa === 'STRETTA' ? AZZURRO : '#cbd5e1',
            `GIORNATA ${c.attesa} ×${c.rangeRelativo.toFixed(2)}`]);
        // Ognuna col suo percentile dal 2022 e il range medio del suo quintile.
        for (const v of c.voci.filter((x) => x.nome !== 'VIX' && x.nome !== 'VIX/VIX3M')) {
            const valore = v.nome === 'SKEW' ? v.valore.toFixed(0) : v.valore.toFixed(2);
            righe.push(['10px Arial', '#94a3b8', `${v.nome} ${valore} (${v.percentile}°) ×${v.rangeRelativo.toFixed(2)}`]);
        }
        // COR1M sotto 10: unico caso con una tendenza su SPX a 5 giorni (studio_vol_commento.py), in prova
        const k = c.cor1m;
        if (k) righe.push(['10px Arial', k.sotto10 ? ARANCIO : '#64748b', k.sotto10
            ? `COR1M ${k.valore.toFixed(2)} < 10 da ${k.giorniSotto}g · SPX 5g debole (in prova)`
            : `COR1M ${k.valore.toFixed(2)}`]);
    }
    const b = vol?.bande;
    if (b) {
        righe.push(['10px Arial', '#e2e8f0',
            `chiusura 68% ±${(b.q68 * b.emResto).toFixed(0)} · 95% ±${(b.q95 * b.emResto).toFixed(0)}`]);
        righe.push(['10px Arial', '#64748b', `VIX1D ${b.vix1d.toFixed(1)} · RV/IV ${b.rvIv?.toFixed(2) ?? '—'}`]);
    }
    const u = vol?.ultima;
    if (u) {
        const d = vol?.divergenze[vol.divergenze.length - 1];
        righe.push(['10px Arial', '#64748b', `SPX 30' ${u.dS >= 0 ? '+' : ''}${u.dS.toFixed(1)}σ · res VIX1D ${u.residuo >= 0 ? '+' : ''}${u.residuo.toFixed(2)}`]);
        if (d) righe.push(['10px Arial', d.tipo === 'rimbalzo' ? VERDE : ROSSO, `div. ${d.tipo} ${d.time.slice(0, 5)} (in prova)`]);
    }
    // Il regime dello smile resta come informazione, non piu' come segnale:
    // lo studio intraday non trova direzione nelle variazioni di vol.
    righe.push(['10px Arial', s.regime ? COLORE_REGIME[s.regime] ?? '#cbd5e1' : '#64748b',
        `smile: ${s.regime ?? (s.chiuso ? 'MERCATO CHIUSO' : s.sospeso ? `sospeso dalle ${oraRomaDaNy('15:15').slice(0, 5)}`
            : s.base === 'in raccolta' ? 'in raccolta' : 'in conferma')}`]);
    if (s.ivAtm != null) {
        righe.push(['10px Arial', '#94a3b8', `IV ATM ${s.ivAtm.toFixed(1)}%${s.em != null ? ` · 1σ ${s.em.toFixed(1)}` : ''}`]);
    }
    if (s.vertice) {
        const sg = s.vertice.sigma;
        righe.push(['10px Arial', '#c084fc',
            `IV MIN ${s.vertice.strike} ${s.vertice.iv.toFixed(1)}%${sg != null ? ` (${sg >= 0 ? '+' : ''}${sg.toFixed(1)}σ)` : ''}`]);
    }
    if (s.z) {
        const f = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
        righe.push(['10px Arial', '#64748b',
            `z tilt ${f(s.z.tilt)} curv ${f(s.z.curv)} atm ${f(s.z.ivAtm)}${s.base === 'provvisoria' ? ' (prov.)' : ''}`]);
    }
    // Avvisi sulla qualita' del dato: 25 delta fuori catena, IV che non si muove.
    const avvisi: string[] = [];
    if (s.est25) avvisi.push('25Δ estrapolata');
    if ((s.ivFermaSec ?? 0) >= 60) avvisi.push(`IV ferma da ${Math.round((s.ivFermaSec as number) / 60)}'`);
    if (avvisi.length) righe.push(['10px Arial', ARANCIO, avvisi.join(' · ')]);
    return righe;
}

/** Il resoconto nella fascia sopra il grafico, a colonne (in ordine per colonna), che finisce al bordo destro. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- l'istanza Chart.js
function intestazione(ctx: CanvasRenderingContext2D, chart: any, righe: Riga[]) {
    if (righe.length === 0) return;
    const perColonna = Math.ceil(righe.length / RES_COLONNE);
    const colonne = Math.ceil(righe.length / perColonna);
    const x1 = chart.width - 4;
    const x0 = Math.max(0, x1 - colonne * RES_COLONNA_PX);
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(x0, 2, x1 - x0, altezzaResoconto(righe.length) - 4);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    righe.forEach(([font, colore, testo], i) => {
        ctx.font = font;
        ctx.fillStyle = colore;
        ctx.fillText(testo, x0 + 6 + Math.floor(i / perColonna) * RES_COLONNA_PX, 6 + (i % perColonna) * RES_RIGA_PX);
    });
    ctx.restore();
}

export const smilePlugin = {
    id: 'smile',
    // La fascia del resoconto: lo spazio sopra il grafico, quanto servono le righe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- l'istanza Chart.js
    beforeLayout: (chart: any) => {
        const dati: DatiSmile | null | undefined = chart.$smile;
        const righe = chart.$smileVisibile && dati ? righeResoconto(dati.smile, dati.vol) : [];
        chart.$smileRighe = righe;
        const layout = (chart.options.layout ??= {});
        const pad = typeof layout.padding === 'object' && layout.padding ? layout.padding : {};
        layout.padding = { ...pad, top: altezzaResoconto(righe.length) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- l'istanza Chart.js con le proprieta' $ messe dalla pagina
    afterDraw: (chart: any) => {
        const dati: DatiSmile | null | undefined = chart.$smile;
        const colonna = chart.scales['y-smile'];
        const prezzi = chart.scales['y-right'];
        const basis: number | null | undefined = chart.$basisSpx;
        if (!chart.$smileVisibile || !colonna || !prezzi || colonna.width < 20) return;
        const { ctx, chartArea } = chart;
        const x0 = colonna.left;
        const x1 = colonna.right;

        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
        ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
        ctx.font = '10px Arial';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';

        const messaggio = !dati ? 'Smile: in attesa dei dati'
            : basis == null ? `Smile: in attesa della basis ES-SPX (${oraRomaDaNy('09:30').slice(0, 5)})` : null;
        if (messaggio || !dati) {
            ctx.fillStyle = '#64748b';
            ctx.fillText(messaggio ?? '', x0 + 6, chartArea.top + 6);
            ctx.restore();
            return;
        }

        const s = dati.smile;
        const b = basis as number;
        const yDi = (strike: number) => prezzi.getPixelForValue(strike + b);
        const punti = dati.punti.filter((p) => p.ivOtm != null).sort((a, b) => a.strike - b.strike);
        if (punti.length === 0) {
            // A mercato chiuso la curva non c'e', la traccia IV MIN della giornata si'.
            if (s.storiaVertice?.length) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(chartArea.left, chartArea.top, x1 - chartArea.left, chartArea.bottom - chartArea.top);
                ctx.clip();
                storiaVertice(chart, ctx, s.storiaVertice, yDi, x1);
                ctx.restore();
            }
            intestazione(ctx, chart, chart.$smileRighe ?? []);
            ctx.restore();
            return;
        }
        const dentro = (y: number) => y >= chartArea.top && y <= chartArea.bottom;
        const xDentro = (x: number) => x >= x0 + 2 && x <= x1 - 2;
        // La scala delle IV sugli strike che si vedono, non su tutta la
        // catena: con lo zoom sui prezzi se ne vedono pochi, e scalata su
        // tutti e 37 la curva si schiacciava in una riga dritta.
        const visibili = punti.filter((p) => dentro(yDi(p.strike)));
        const ivs = (visibili.length >= 2 ? visibili : punti).map((p) => p.ivOtm as number);
        let ivMin = Math.min(...ivs);
        let ivMax = Math.max(...ivs);
        if (ivMax - ivMin < 0.5) {
            const c = (ivMax + ivMin) / 2;
            ivMin = c - 0.25;
            ivMax = c + 0.25;
        }
        const xDi = (iv: number) => x0 + MARGINE_X + ((iv - ivMin) / (ivMax - ivMin)) * (x1 - x0 - 2 * MARGINE_X);
        const em = s.em ?? 0;
        const oltre2s = (strike: number) => em > 0 && Math.abs(strike - dati.spot) > 2 * em;

        // Livelli orizzontali (sezioni 3 e 6): Spot +-1 sigma e +-2 sigma, e
        // il vertice IV MIN. Prezzi SPX, portati su ES con la basis come la curva.
        ctx.save();
        ctx.beginPath();
        ctx.rect(chartArea.left, chartArea.top, x1 - chartArea.left, chartArea.bottom - chartArea.top);
        ctx.clip();
        const livelli: [number, string, number[], string][] = [];
        const bande = dati.vol?.bande;
        if (bande) {
            livelli.push(
                [bande.su95, COLORE_2S, [2, 4], '95%'],
                [bande.su68, COLORE_1S, [6, 4], '68%'],
                [bande.giu68, COLORE_1S, [6, 4], '68%'],
                [bande.giu95, COLORE_2S, [2, 4], '95%'],
            );
        } else if (em > 0) {
            livelli.push(
                [dati.spot + 2 * em, COLORE_2S, [2, 4], '+2σ'],
                [dati.spot + em, COLORE_1S, [6, 4], '+1σ'],
                [dati.spot - em, COLORE_1S, [6, 4], '−1σ'],
                [dati.spot - 2 * em, COLORE_2S, [2, 4], '−2σ'],
            );
        }
        if (s.storiaVertice?.length) storiaVertice(chart, ctx, s.storiaVertice, yDi, x1);
        else if (s.vertice) livelli.push([s.vertice.strike, COLORE_VERTICE, [], 'IV MIN']);
        for (const [prezzo, colore, tratto, nome] of livelli) {
            const y = yDi(prezzo);
            if (dentro(y)) lineaLivello(ctx, chartArea.left, x1, y, colore, tratto, `${nome} ${prezzo.toFixed(1)}`);
        }
        ctx.restore();

        ctx.beginPath();
        ctx.rect(x0 - FRECCIA_MAX_PX - 12, chartArea.top, x1 - x0 + FRECCIA_MAX_PX + 12, chartArea.bottom - chartArea.top);
        ctx.clip();

        // Linea grigia sulla IV OTM, tagliata sulla colonna: verso gli strike
        // fuori vista uscirebbe dalla scala e finirebbe sopra il grafico.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
        ctx.clip();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        punti.forEach((p, i) => {
            const x = xDi(p.ivLiscia ?? (p.ivOtm as number));
            const y = yDi(p.strike);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.restore();

        // Frecce del convexity ladder, prima dei pallini cosi' la punta ci arriva sotto.
        const maxConv = Math.max(0, ...punti.map((p) => Math.abs(p.conv ?? 0)));
        if (maxConv > 0) {
            for (const p of punti) {
                const c = p.conv ?? 0;
                if (Math.abs(c) < maxConv * FRECCIA_SOGLIA) continue;
                const y = yDi(p.strike);
                if (!dentro(y)) continue;
                const x = xDi(p.ivOtm as number);
                const len = FRECCIA_MIN_PX + (Math.abs(c) / maxConv) * (FRECCIA_MAX_PX - FRECCIA_MIN_PX);
                if (c < 0) freccia(ctx, x - RAGGIO - 3 - len, x - RAGGIO - 2, y, ARANCIO);
                else freccia(ctx, Math.min(x1 - 2, x + RAGGIO + 3 + len), x + RAGGIO + 2, y, AZZURRO);
            }
        }

        // Pallini: prima quello staccato (il lato non OTM), poi quello sulla curva.
        for (const p of punti) {
            const y = yDi(p.strike);
            if (!dentro(y)) continue;
            const vuoto = oltre2s(p.strike);
            const sottoSpot = p.strike < dati.spot;
            const altra = sottoSpot ? p.callIv : p.putIv;
            if (altra != null && altra !== p.ivOtm) {
                const xa = xDi(altra);
                if (xDentro(xa)) pallino(ctx, xa, y, sottoSpot ? VERDE : ROSSO, vuoto);
            }
            // Sulla curva il colore e' del lato da cui viene la IV OTM (con il ripiego sull'altro lato).
            const daCall = sottoSpot ? p.putIv == null : p.callIv != null;
            pallino(ctx, xDi(p.ivOtm as number), y, daCall ? VERDE : ROSSO, vuoto);
        }
        ctx.restore();
        // Fuori dal clip della colonna: la fascia sta sopra il grafico.
        intestazione(ctx, chart, chart.$smileRighe ?? []);
    },
};
