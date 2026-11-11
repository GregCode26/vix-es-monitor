import fs from 'fs';
import path from 'path';

/**
 * La basis ES - SPX di un momento, per portare strike SPX sul prezzo ES (11/11/2026, saette dei vertical
 * di Zone Footprint): mediana dei punti di `data/market/YYYY-MM-DD.json` dei 5 minuti prima, solo nel cash
 * (9:30-16:00 NY: dopo la chiusura SPX resta fermo mentre ES si muove); fuori dal cash l'ultima basis cash.
 * I `time` dei file market sono ora di Roma.
 */

const MARKET = fs.existsSync(path.join(process.cwd(), 'frontend', 'package.json'))
    ? path.join(process.cwd(), 'frontend', 'data', 'market')
    : path.join(process.cwd(), 'data', 'market');

/** Scarto in minuti di un fuso da UTC in un istante. */
function scarto(fuso: string, ms: number): number {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000);
}

/** Epoch (s) di un 'HH:MM:SS' di Roma del giorno `data`. */
export function epochRoma(data: string, ora: string): number {
    const [y, m, d] = data.split('-').map(Number);
    const [hh, mm, ss] = ora.split(':').map(Number);
    const comeUtc = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
    return Math.round((comeUtc - scarto('Europe/Rome', comeUtc) * 60000) / 1000);
}

function minutiNy(epoch: number): number {
    const ms = epoch * 1000 + scarto('America/New_York', epoch * 1000) * 60000;
    const d = new Date(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const dataRoma = (epoch: number) => new Date(epoch * 1000 + scarto('Europe/Rome', epoch * 1000) * 60000).toISOString().slice(0, 10);

/** Punti (epoch, ES - SPX) del cash dei file market dal giorno `fino` indietro, fino a trovarne uno con dati. */
export function basiCash(giorniRoma: string[]): { t: number; b: number }[] {
    const tutti = fs.existsSync(MARKET) ? fs.readdirSync(MARKET).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
    const primo = giorniRoma[0];
    // il giorno con dati cash prima del primo richiesto, per i trade della notte e della mattina
    const prima = tutti.filter((f) => f.slice(0, 10) < primo).slice(-3);
    const file = [...prima, ...giorniRoma.map((g) => `${g}.json`).filter((f) => tutti.includes(f))];
    const out: { t: number; b: number }[] = [];
    for (const f of [...new Set(file)]) {
        try {
            const righe = JSON.parse(fs.readFileSync(path.join(MARKET, f), 'utf-8'));
            if (!Array.isArray(righe)) continue;
            for (const p of righe) {
                if (typeof p?.esf !== 'number' || typeof p?.spx !== 'number' || typeof p?.time !== 'string') continue;
                const t = epochRoma(f.slice(0, 10), p.time);
                const n = minutiNy(t);
                if (n < 9 * 60 + 30 || n > 16 * 60) continue;
                out.push({ t, b: p.esf - p.spx });
            }
        } catch { /* file a meta' scrittura: si salta */ }
    }
    return out.sort((a, b) => a.t - b.t);
}

function mediana(v: number[]): number {
    const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function basisAl(basi: { t: number; b: number }[], ts: number): { basis: number | null; fonte: string } {
    const finestra = basi.filter((p) => p.t <= ts && p.t >= ts - 300).map((p) => p.b);
    if (finestra.length) return { basis: mediana(finestra), fonte: 'momento' };
    const prima = basi.filter((p) => p.t <= ts).slice(-20).map((p) => p.b);
    if (prima.length) return { basis: mediana(prima), fonte: 'ultima cash' };
    const dopo = basi.filter((p) => p.t > ts).slice(0, 20).map((p) => p.b);
    if (dopo.length) return { basis: mediana(dopo), fonte: 'prima cash dopo' };
    return { basis: null, fonte: 'nessuna' };
}

