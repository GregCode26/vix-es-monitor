/**
 * "Short su spinta del VIX" (13/11/2026, IN PROVA): l'unica regola rimasta in piedi su ~1.000 prove di
 * `execution/studio_ingressi_2pt.py` (target 2 punti ES, stop sulla liquidita' Bookmap).
 *
 * - Segnale: il VIX sale di almeno 0,14 in 5 minuti (VIX(t) - VIX(t-300 s), punti di
 *   `data/market/<giorno>.json` portati al secondo), fra le 9:35 e le 15:45 NY; dopo un segnale la regola
 *   non riscatta per 5 minuti (anche se quel segnale non ha dato un'operazione).
 * - Operazione SHORT: entrata al mid Bookmap del secondo dopo, target -2 punti, stop un tick sopra il primo
 *   muro ask >= 100 contratti fra 0,5 e 8 punti sopra il mid (dal libro del secondo del segnale); senza un
 *   muro li' l'operazione non si fa. Stop TRAILING: ogni secondo scende sul muro ask visto il secondo prima,
 *   mai in su; uscita a mercato dopo 15 minuti.
 * - Studio: 79 operazioni dal 14/10 al 12/11, +0,72 pt a operazione netti, 13 giornate positive su 15. Era la
 *   migliore di ~1.000 prove: puo' essere fortuna. Da giudicare solo sulle sedute dopo il 13/11.
 *
 * Le costanti sono le stesse dello studio: cambiarle in tutti e due i posti.
 * Solo locale (legge i file dei poller e di Bookmap), lettura incrementale del file Bookmap.
 */

import fs from 'fs';
import path from 'path';
import { minutiRomaDaNy } from './orarioNy';

export const SOGLIA_VIX = 0.14;
const FINESTRA_VIX = 300;
const RIARMO = 300;
export const TARGET = 2;
const TICK = 0.25;
const MURO = 100;
const MURO_MIN = 0.5;
const MURO_MAX = 8;
const DURATA = 900;
export const COSTO = 0.25;

export interface OperazioneVix {
    /** Ora (italiana) del segnale, 'HH:MM:SS'. */
    t: string;
    /** Salita del VIX negli ultimi 5 minuti. */
    dVix: number;
    /** Senza un muro ask utilizzabile: segnale senza operazione. */
    senzaMuro: boolean;
    entrata: number | null;
    muro: number | null;
    target: number | null;
    /** Lo stop nel tempo: [ora, prezzo] a ogni cambio (il primo e' lo stop iniziale). */
    stop: [string, number][];
    /** 'target' | 'stop' | 'tempo' | 'aperta' | 'fine dati' | 'senza prezzo'. */
    uscita: string | null;
    fine: string | null;
    prezzoUscita: number | null;
    /** Punti lordi (senza il costo). */
    punti: number | null;
}

interface Stato {
    giorno: string;
    offset: number;
    resto: string;
    mid: Float64Array;
    muroSopra: Float64Array;
    vixMtime: number;
    vix: Float64Array;
}

const stati = new Map<string, Stato>();
const hhmmss = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
const sec = (t: string) => +t.slice(0, 2) * 3600 + +t.slice(3, 5) * 60 + +t.slice(6, 8);

function leggiBookmap(st: Stato, file: string) {
    let size: number;
    try {
        size = fs.statSync(file).size;
    } catch {
        return;
    }
    if (size < st.offset) { st.offset = 0; st.resto = ''; st.mid.fill(NaN); st.muroSopra.fill(NaN); }
    if (size === st.offset) return;
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - st.offset);
        fs.readSync(fd, buf, 0, buf.length, st.offset);
        st.offset = size;
        const righe = (st.resto + buf.toString('utf-8')).split('\n');
        st.resto = righe.pop() ?? '';
        for (const riga of righe) {
            if (!riga) continue;
            let r: { t?: string; bid?: number | null; ask?: number | null; book?: { a?: [number, number][] } };
            try { r = JSON.parse(riga); } catch { continue; }
            if (!r.t || !r.bid || !r.ask) continue;
            const i = sec(r.t);
            if (i < 0 || i >= 86400) continue;
            const m = (r.bid + r.ask) / 2;
            st.mid[i] = m;
            let muro = NaN;
            for (const [p, s] of r.book?.a ?? []) {
                if (s >= MURO && p - m >= MURO_MIN && p - m <= MURO_MAX && !(p >= muro)) muro = p;
            }
            st.muroSopra[i] = muro;
        }
    } finally {
        fs.closeSync(fd);
    }
}

function leggiVix(st: Stato, file: string) {
    let mtime: number;
    try {
        mtime = fs.statSync(file).mtimeMs;
    } catch {
        return;
    }
    if (mtime === st.vixMtime) return;
    st.vixMtime = mtime;
    st.vix.fill(NaN);
    try {
        const grezzo = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const punti: { time?: string; vix?: number | null }[] = Array.isArray(grezzo) ? grezzo : grezzo?.data ?? [];
        for (const p of punti) {
            if (p.time && typeof p.vix === 'number' && p.vix > 0) st.vix[sec(p.time)] = p.vix;
        }
    } catch {
        /* file a meta' scrittura: si riprova al prossimo giro */
    }
}

/** Ultimo valore finito fra `da` e `i` compresi (il ffill dello studio, che parte dalle 9:30 NY). */
function indietro(a: Float64Array, i: number, da: number): number {
    for (let k = i; k >= da; k--) if (Number.isFinite(a[k])) return a[k];
    return NaN;
}

export function operazioniVix(dati: string, giorno: string, istante: Date, oraAttuale: number | null): OperazioneVix[] {
    let st = stati.get(giorno);
    if (!st) {
        st = {
            giorno, offset: 0, resto: '', mid: new Float64Array(86400).fill(NaN), muroSopra: new Float64Array(86400).fill(NaN),
            vixMtime: 0, vix: new Float64Array(86400).fill(NaN),
        };
        stati.set(giorno, st);
        // tiene in memoria solo le ultime giornate chieste
        for (const k of [...stati.keys()].sort().slice(0, -3)) stati.delete(k);
    }
    leggiBookmap(st, path.join(dati, 'bookmap', `${giorno}.ndjson`));
    leggiVix(st, path.join(dati, 'market', `${giorno}.json`));

    const s0 = minutiRomaDaNy('09:30', istante) * 60;
    const i0 = s0 + 300, i1 = s0 + 6 * 3600 + 15 * 60;
    // mid e VIX al secondo con il ffill dalla 9:30 NY, come lo studio
    const fineDati = oraAttuale ?? 86399;
    const n = Math.min(86400, s0 + 6 * 3600 + 30 * 60 + 2);
    const mid = new Float64Array(n).fill(NaN), vix = new Float64Array(n).fill(NaN);
    let ultimoMid = NaN, ultimoVix = NaN;
    for (let i = s0; i < n; i++) {
        if (Number.isFinite(st.mid[i])) ultimoMid = st.mid[i];
        if (Number.isFinite(st.vix[i])) ultimoVix = st.vix[i];
        if (i <= fineDati) { mid[i] = ultimoMid; vix[i] = ultimoVix; }
    }
    // ultimo secondo con un dato Bookmap vero: oltre, l'operazione e' ancora aperta
    let ultimoDato = -1;
    for (let i = Math.min(n - 1, fineDati); i >= s0; i--) if (Number.isFinite(st.mid[i])) { ultimoDato = i; break; }

    const out: OperazioneVix[] = [];
    let ultimoSegnale = -1e9;
    for (let i = i0; i < i1 && i <= fineDati; i++) {
        const d = vix[i] - vix[i - FINESTRA_VIX];
        if (!(d >= SOGLIA_VIX) || i - ultimoSegnale < RIARMO) continue;
        ultimoSegnale = i;
        const op: OperazioneVix = {
            t: hhmmss(i), dVix: Math.round(d * 100) / 100, senzaMuro: false, entrata: null, muro: null, target: null,
            stop: [], uscita: null, fine: null, prezzoUscita: null, punti: null,
        };
        out.push(op);
        const ent = mid[i + 1];
        const muro = st.muroSopra[i];
        if (i + 1 > ultimoDato) { op.uscita = 'aperta'; continue; }
        if (!Number.isFinite(ent)) { op.uscita = 'senza prezzo'; continue; }   // Bookmap non ancora partito
        if (!Number.isFinite(muro) || muro + TICK - ent <= TICK) { op.senzaMuro = true; continue; }
        op.entrata = ent; op.muro = muro; op.target = ent - TARGET;
        // stop in punti dall'entrata dalla parte della perdita: SHORT -> prezzo = entrata + distanza
        let livello = -(muro + TICK - ent);
        op.stop.push([hhmmss(i + 1), ent - livello]);
        const fine = Math.min(n, i + 2 + DURATA);
        for (let k = i + 2; k < fine; k++) {
            if (k > ultimoDato) { op.uscita = 'aperta'; break; }
            // trailing: il muro ask visto il secondo prima, solo a favore, mai oltre il target
            const m = st.muroSopra[k - 1];
            if (Number.isFinite(m)) {
                const nuovo = Math.min(-(m + TICK - ent), TARGET - TICK);
                if (nuovo > livello) { livello = nuovo; op.stop.push([hhmmss(k), ent - livello]); }
            }
            const w = -(mid[k] - ent);
            // nello stesso secondo vince lo stop, come nello studio
            if (w <= livello) { Object.assign(op, { uscita: 'stop', fine: hhmmss(k), prezzoUscita: ent - livello, punti: livello }); break; }
            if (w >= TARGET) { Object.assign(op, { uscita: 'target', fine: hhmmss(k), prezzoUscita: ent - TARGET, punti: TARGET }); break; }
            if (k === fine - 1) {
                if (fine - (i + 2) < DURATA) Object.assign(op, { uscita: 'fine dati', fine: hhmmss(k) });
                else Object.assign(op, { uscita: 'tempo', fine: hhmmss(k), prezzoUscita: mid[k], punti: w });
            }
        }
        if (op.punti != null) op.punti = Math.round(op.punti * 100) / 100;
    }
    return out;
}
