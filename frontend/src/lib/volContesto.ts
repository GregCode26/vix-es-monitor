/**
 * La lettura della volatilita' di /market, rifatta il 03/11/2026 sugli studi
 * `execution/studio_vol.py` (giornaliero, 2007-2026) e
 * `execution/studio_vol_intraday.py` (5 minuti SPX + VIX1D, 2023-2026):
 *
 * - **bande**: dove puo' chiudere SPX, al 68% e al 95%, dal VIX1D del momento
 *   ma con i quantili osservati per fascia oraria e per vol realizzata finora
 *   (`volCalibrazioneIntraday.ts`). Il +-1 sigma "teorico" del VIX1D conteneva
 *   la chiusura nell'87% dei casi invece del 68%: le bande prezzate erano larghe.
 *   La nostra IV 0DTE non serve qui: al mattino e' circa il doppio del VIX1D
 *   (18,8 contro 9,9 il 02/11 alle 10:00) e non ha storico da calibrare.
 * - **divergenze**: SPX scende di oltre 1 sigma in 30 minuti e il VIX1D NON
 *   sale quanto di solito (rimbalzo: +0,14 sigma a 60 min, 59% su, n 172) o
 *   sale piu' del solito (continuazione: -0,10, 47% su, n 310). Unico candidato
 *   di direzione emerso, su 12 caselle testate: IN PROVA, da verificare.
 * - **contesto**: le chiusure di ieri di VIX, VIX9D, VIX3M, VIX1D e SKEW
 *   (scritte da `tws_poller.py`) contro i percentili dal 2022
 *   (`volCalibrazioneGiorno.ts`): prevedono l'ampiezza della giornata, non la
 *   direzione.
 * - **cor1m**: la correlazione implicita a 1 mese di Cboe (`data/vol/cor1m.json`,
 *   scritto da `tws_poller.py` dal CSV Cboe). Sotto 10 (dal 2017, 24 episodi)
 *   SPX nei 5 giorni dopo e' andato peggio che con lo stesso VIX: -0,19 sigma,
 *   16 episodi su 24 negativi (`execution/studio_vol_commento.py`, 13/11/2026).
 *   In sample e con la soglia presa da un commento: un avviso, IN PROVA.
 *
 * Tutto locale: legge `data/market/<giorno>.json` (campi `spx`, `vix1d`) e
 * `data/vol/chiusure.json`.
 */

import fs from 'fs';
import path from 'path';
import { minutiRomaDaNy } from './orarioNy';
import { VOL_INTRADAY } from './volCalibrazioneIntraday';
import { VOL_GIORNO } from './volCalibrazioneGiorno';

export interface BandeVol {
    /** SPX e VIX1D usati, e l'ora (italiana) del punto. */
    spot: number;
    vix1d: number;
    time: string;
    /** Movimento atteso del resto della giornata dal VIX1D (1 sigma teorico), in punti SPX. */
    emResto: number;
    /** Vol realizzata da inizio seduta / VIX1D. */
    rvIv: number | null;
    /** Moltiplicatori di `emResto` osservati per questa fascia e questo RV/IV. */
    q68: number;
    q95: number;
    su68: number; giu68: number; su95: number; giu95: number;
}

export interface Divergenza {
    /** Ora italiana 'HH:MM:SS' della chiusura della barra da 5 minuti. */
    time: string;
    tipo: 'rimbalzo' | 'continuazione';
    /** SPX negli ultimi 30 minuti in sigma, e il residuo di VIX1D in punti di vol. */
    dS: number;
    residuo: number;
}

export interface VoceContesto {
    nome: string;
    valore: number;
    percentile: number;
    /** Range medio del giorno dopo nel quintile, relativo alla media (1 = normale). */
    rangeRelativo: number;
    rho: number;
}

export interface Contesto {
    data: string;
    voci: VoceContesto[];
    /** Dalla misura che prevede meglio (VIX1D/VIX, altrimenti VIX9D/VIX). */
    attesa: 'AMPIA' | 'NORMALE' | 'STRETTA';
    rangeRelativo: number;
    cor1m: Cor1m | null;
}

export interface Cor1m {
    valore: number;
    data: string;
    sotto10: boolean;
    /** Chiusure consecutive sotto 10 fino a `data` (0 se sopra). */
    giorniSotto: number;
}

export interface Vol {
    bande: BandeVol | null;
    divergenze: Divergenza[];
    /** Lo stato dell'ultima barra: SPX 30 min in sigma e residuo VIX1D. */
    ultima: { time: string; dS: number; residuo: number } | null;
    contesto: Contesto | null;
}

type Punto = { time?: string; spx?: number | null; vix1d?: number | null };

const BARRE = VOL_INTRADAY.barreGiorno;
const sec = (t: string) => {
    const [h, m, s] = t.split(':').map(Number);
    return h * 3600 + m * 60 + (s || 0);
};
const hhmmss = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');

function leggiPunti(dati: string, giorno: string): Punto[] {
    try {
        const grezzo = JSON.parse(fs.readFileSync(path.join(dati, 'market', `${giorno}.json`), 'utf-8'));
        return Array.isArray(grezzo) ? grezzo : grezzo?.data ?? [];
    } catch {
        return [];
    }
}

/**
 * Le chiusure delle barre da 5 minuti di oggi: S[k], V[k] = ultimo SPX e VIX1D
 * entro la fine della barra k (barra 0 = 9:30-9:35 NY), come le barre IBKR
 * dello studio. Un valore piu' vecchio di 2 minuti non vale (poller fermo).
 */
function barre(punti: Punto[], adesso: Date): { S: (number | null)[]; V: (number | null)[]; fine: string[] } {
    const apertura = minutiRomaDaNy('09:30', adesso) * 60;
    const ora = adesso.getHours() * 3600 + adesso.getMinutes() * 60 + adesso.getSeconds();
    const validi = punti
        .filter((p) => p.time && p.spx != null && p.vix1d != null && (p.spx as number) > 0 && (p.vix1d as number) > 0)
        .map((p) => ({ t: sec(p.time as string), s: p.spx as number, v: p.vix1d as number }));
    const S: (number | null)[] = [], V: (number | null)[] = [], fine: string[] = [];
    let j = 0;
    let ultimo: { t: number; s: number; v: number } | null = null;
    for (let k = 0; k < BARRE; k++) {
        const t = apertura + 300 * (k + 1);
        if (t > ora) break;
        while (j < validi.length && validi[j].t <= t) ultimo = validi[j++];
        const buono = ultimo && ultimo.t > t - 120 && ultimo.t > apertura;
        S.push(buono ? ultimo!.s : null);
        V.push(buono ? ultimo!.v : null);
        fine.push(hhmmss(t));
    }
    return { S, V, fine };
}

function digitize(x: number, bordi: readonly number[]): number {
    return bordi.filter((b) => b <= x).length;
}

function calcolaBande(punti: Punto[], S: (number | null)[], V: (number | null)[], adesso: Date): BandeVol | null {
    const i = S.length - 1;                       // ultima barra chiusa
    if (i < 3 || i > 74) return null;             // calibrato 9:45-15:50 NY
    const ora = adesso.getHours() * 3600 + adesso.getMinutes() * 60 + adesso.getSeconds();
    const ultimo = [...punti].reverse().find((p) => p.spx != null && p.vix1d != null && p.time && sec(p.time) <= ora);
    if (!ultimo || ora - sec(ultimo.time as string) > 120) return null;
    const spot = ultimo.spx as number, vix1d = ultimo.vix1d as number;
    // vol realizzata da inizio seduta, come nello studio: somma dei quadrati
    // dei rendimenti a 5 minuti diviso (i + 1) barre
    let rv = 0;
    for (let k = 1; k <= i; k++) {
        const a = S[k - 1], b = S[k];
        if (a && b) rv += Math.log(b / a) ** 2;
    }
    const rvIv = Math.sqrt((rv * 252 * BARRE) / (i + 1)) * 100 / vix1d;
    const fasce = VOL_INTRADAY.fasce;
    const f = fasce[Math.min(Math.floor(i / VOL_INTRADAY.barrePerFascia), fasce.length - 1)];
    const [q68, q95] = f.q[digitize(rvIv, f.bordiRvIv)];
    const chiusura = minutiRomaDaNy('16:00', adesso) * 60;
    const rimaste = Math.max(0, (chiusura - ora) / 300);
    const emResto = spot * vix1d / 100 / Math.sqrt(252) * Math.sqrt(rimaste / BARRE);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return {
        spot, vix1d, time: ultimo.time as string,
        emResto: r1(emResto), rvIv: Math.round(rvIv * 100) / 100, q68, q95,
        su68: r1(spot + q68 * emResto), giu68: r1(spot - q68 * emResto),
        su95: r1(spot + q95 * emResto), giu95: r1(spot - q95 * emResto),
    };
}

function calcolaDivergenze(S: (number | null)[], V: (number | null)[], fine: string[]) {
    const p = VOL_INTRADAY.divergenze;
    const soglia = p.sogliaResiduo * p.sdResiduo;
    const out: Divergenza[] = [];
    let ultima: Vol['ultima'] = null;
    const ultimaPerTipo: Record<string, number> = {};
    for (let k = p.barraMin; k < S.length && k <= p.barraMax; k++) {
        const s0 = S[k - p.barre], s1 = S[k], v0 = V[k - p.barre], v1 = V[k];
        if (!s0 || !s1 || !v0 || !v1) continue;
        const sig = s1 * v1 / 100 / Math.sqrt(252 * BARRE);
        const dS = (s1 - s0) / (sig * Math.sqrt(p.barre));
        const residuo = (v1 - v0) - (p.beta * dS + p.alfa);
        ultima = { time: fine[k], dS: Math.round(dS * 100) / 100, residuo: Math.round(residuo * 100) / 100 };
        if (dS >= -p.sogliaSpx) continue;
        const tipo = residuo < -soglia ? 'rimbalzo' : residuo > soglia ? 'continuazione' : null;
        if (!tipo) continue;
        // una volta scattato, lo stesso tipo si riarma dopo 30 minuti
        if (ultimaPerTipo[tipo] != null && k - ultimaPerTipo[tipo] < p.riarmoBarre) continue;
        ultimaPerTipo[tipo] = k;
        out.push({ time: fine[k], tipo, dS: ultima.dS, residuo: ultima.residuo });
    }
    return { divergenze: out, ultima };
}

function percentile(x: number, percentili: readonly number[]): number {
    if (x <= percentili[0]) return 0;
    if (x >= percentili[percentili.length - 1]) return 100;
    const j = percentili.findIndex((p) => p > x);
    const a = percentili[j - 1], b = percentili[j];
    return Math.round(j - 1 + (b > a ? (x - a) / (b - a) : 0));
}

function leggiCor1m(dati: string): Cor1m | null {
    try {
        const f = JSON.parse(fs.readFileSync(path.join(dati, 'vol', 'cor1m.json'), 'utf-8'));
        if (typeof f?.chiusura !== 'number' || typeof f?.data !== 'string') return null;
        const storia: [string, number][] = Array.isArray(f.storia) ? f.storia : [];
        let giorniSotto = 0;
        for (let i = storia.length - 1; i >= 0 && storia[i][1] < 10; i--) giorniSotto++;
        return { valore: f.chiusura, data: f.data, sotto10: f.chiusura < 10, giorniSotto };
    } catch {
        return null;
    }
}

function calcolaContesto(dati: string): Contesto | null {
    let file: { chiusure?: Record<string, { data: string; chiusura: number }> };
    try {
        file = JSON.parse(fs.readFileSync(path.join(dati, 'vol', 'chiusure.json'), 'utf-8'));
    } catch {
        return null;
    }
    const c = file.chiusure ?? {};
    const vix = c.VIX;
    if (!vix) return null;
    const stessaData = (k: string) => (c[k] && c[k].data === vix.data ? c[k].chiusura : null);
    const valori: [keyof typeof VOL_GIORNO, number | null][] = [
        ['VIX1D/VIX', stessaData('VIX1D') != null ? (stessaData('VIX1D') as number) / vix.chiusura : null],
        ['VIX9D/VIX', stessaData('VIX9D') != null ? (stessaData('VIX9D') as number) / vix.chiusura : null],
        ['VIX/VIX3M', stessaData('VIX3M') != null ? vix.chiusura / (stessaData('VIX3M') as number) : null],
        ['SKEW', stessaData('SKEW')],
        ['VIX', vix.chiusura],
    ];
    const voci: VoceContesto[] = [];
    for (const [nome, valore] of valori) {
        if (valore == null) continue;
        const cal = VOL_GIORNO[nome];
        voci.push({
            nome, valore: Math.round(valore * 1000) / 1000,
            percentile: percentile(valore, cal.percentili),
            rangeRelativo: cal.rangeRelativo[digitize(valore, cal.bordiQuintili)],
            rho: cal.rho,
        });
    }
    const guida = voci.find((v) => v.nome === 'VIX1D/VIX') ?? voci.find((v) => v.nome === 'VIX9D/VIX') ?? voci[0];
    if (!guida) return null;
    const r = guida.rangeRelativo;
    return {
        data: vix.data, voci, attesa: r >= 1.1 ? 'AMPIA' : r <= 0.9 ? 'STRETTA' : 'NORMALE', rangeRelativo: r,
        cor1m: leggiCor1m(dati),
    };
}

export function calcolaVol(dati: string, giorno: string, adesso: Date = new Date()): Vol {
    const punti = leggiPunti(dati, giorno);
    const { S, V, fine } = barre(punti, adesso);
    const { divergenze, ultima } = calcolaDivergenze(S, V, fine);
    return { bande: calcolaBande(punti, S, V, adesso), divergenze, ultima, contesto: calcolaContesto(dati) };
}
