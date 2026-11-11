import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
// @ts-ignore -- node:sqlite c'e' in Node 24, ma i @types/node installati non lo dichiarano ancora
import { DatabaseSync } from 'node:sqlite';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Vertical da 5 e 10 punti ricavati dai singoli trade dello scanner SPX (`/spx-scanner`), per le
 * saette di Zone Footprint su Quantower (11/11/2026).
 *
 * Un vertical = due stampe sullo stesso tipo (call o put), stessa classe e scadenza, stessa
 * quantita', strike a 5 o 10 punti, a non piu' di 1 secondo (risoluzione IBKR). Ogni stampa entra in
 * un vertical solo. Il verso viene dal prezzo del pacchetto contro il suo mid, con il bid/ask di
 * prima del trade: call pagata sopra il mid = BULL CALL (comprato), sotto = BEAR CALL; put pagata
 * sopra il mid = BEAR PUT, sotto = BULL PUT. Senza bid/ask (trade prima del 10/11) il verso e'
 * 'incerto'. Aperto o chiuso non si sa: lo scanner non legge l'open interest.
 *
 * Gli strike passano in ES con la basis ES - SPX del momento: mediana dei punti di
 * `data/market/YYYY-MM-DD.json` dei 5 minuti prima del trade, solo nel cash (9:30-16:00 NY, dopo la
 * chiusura SPX resta fermo); fuori dal cash l'ultima basis cash disponibile (`basisFonte`).
 *
 * `?giorno=YYYY-MM-DD` (default l'ultimo dello scanner, entrambe le sessioni), `?min=N` contratti
 * per gamba (default 200). Solo locale.
 */

const DB = path.join(process.cwd(), 'data', 'spx-scanner', 'scanner.db');
const MARKET = path.join(process.cwd(), 'data', 'market');

type Riga = {
    ts: number; seq: number; sessione: string; size: number; price: number | null; bid: number | null; ask: number | null;
    conditions: string | null; trading_class: string; real_expiry: string; strike: number; opt_right: 'C' | 'P';
};

/** Scarto in minuti di un fuso da UTC in un istante. */
function scarto(fuso: string, ms: number): number {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000);
}

/** Epoch (s) di un 'HH:MM:SS' di Roma del giorno `data`. */
function epochRoma(data: string, ora: string): number {
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

const dataRoma = (epoch: number) => new Date(epoch * 1000 + scarto('Europe/Rome', epoch * 1000) * 60000).toISOString().slice(0, 10);

/** Punti (epoch, ES - SPX) del cash dei file market dal giorno `fino` indietro, fino a trovarne uno con dati. */
function basiCash(giorniRoma: string[]): { t: number; b: number }[] {
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

function basisAl(basi: { t: number; b: number }[], ts: number): { basis: number | null; fonte: string } {
    const finestra = basi.filter((p) => p.t <= ts && p.t >= ts - 300).map((p) => p.b);
    if (finestra.length) return { basis: mediana(finestra), fonte: 'momento' };
    const prima = basi.filter((p) => p.t <= ts).slice(-20).map((p) => p.b);
    if (prima.length) return { basis: mediana(prima), fonte: 'ultima cash' };
    const dopo = basi.filter((p) => p.t > ts).slice(0, 20).map((p) => p.b);
    if (dopo.length) return { basis: mediana(dopo), fonte: 'prima cash dopo' };
    return { basis: null, fonte: 'nessuna' };
}

const mid = (r: Riga) => (r.bid != null && r.ask != null && r.bid > 0 && r.ask >= r.bid ? (r.bid + r.ask) / 2 : null);
const arrot = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);

export async function GET(req: NextRequest) {
    if (!fs.existsSync(DB)) return NextResponse.json({ error: 'database dello scanner non trovato' }, { status: 503 });
    const db = new DatabaseSync(DB, { readOnly: true });
    try {
        const q = req.nextUrl.searchParams;
        const giorno = q.get('giorno') || (db.prepare('SELECT MAX(giorno) g FROM trades').get() as { g: string | null })?.g;
        if (!giorno) return NextResponse.json({ giorno: null, verticali: [] });
        const min = Math.max(1, Number(q.get('min') ?? 200) || 200);
        const conVerso = (db.prepare("SELECT COUNT(*) n FROM pragma_table_info('trades') WHERE name = 'bid'").get() as { n: number }).n > 0;
        const righe = db.prepare(
            `SELECT t.ts, t.seq, t.sessione, t.size, t.price, t.conditions, ${conVerso ? 't.bid, t.ask' : 'NULL bid, NULL ask'},
                    o.trading_class, o.real_expiry, o.strike, o.opt_right
             FROM trades t JOIN options_contracts o ON o.con_id = t.con_id
             WHERE t.giorno = ? AND t.size >= ? ORDER BY t.ts, t.seq`).all(giorno, min) as Riga[];

        // Stessa classe, scadenza, tipo e quantita': le sole stampe che possono fare coppia.
        const gruppi = new Map<string, Riga[]>();
        for (const r of righe) {
            const k = `${r.sessione}|${r.trading_class}|${r.real_expiry}|${r.opt_right}|${r.size}`;
            (gruppi.get(k) ?? gruppi.set(k, []).get(k)!).push(r);
        }
        const coppie: [Riga, Riga][] = [];
        for (const lista of gruppi.values()) {
            const usato = new Set<number>();
            for (let i = 0; i < lista.length; i++) {
                if (usato.has(i)) continue;
                let migliore = -1, punteggio = Infinity;
                for (let j = i + 1; j < lista.length && lista[j].ts - lista[i].ts <= 1; j++) {
                    if (usato.has(j)) continue;
                    const larghezza = Math.abs(lista[j].strike - lista[i].strike);
                    if (larghezza !== 5 && larghezza !== 10) continue;
                    // prima lo stesso secondo, poi la gamba piu' stretta
                    const p = (lista[j].ts - lista[i].ts) * 100 + larghezza;
                    if (p < punteggio) { punteggio = p; migliore = j; }
                }
                if (migliore >= 0) { usato.add(i); usato.add(migliore); coppie.push([lista[i], lista[migliore]]); }
            }
        }

        const giorniRoma = [...new Set(coppie.map(([a]) => dataRoma(a.ts)))].sort();
        const basi = giorniRoma.length ? basiCash(giorniRoma) : [];
        const verticali = coppie.map(([a, b]) => {
            const [basso, alto] = a.strike < b.strike ? [a, b] : [b, a];
            const call = basso.opt_right === 'C';
            // il pacchetto con il segno di chi lo compra: call = basso - alto, put = alto - basso
            const lungo = call ? basso : alto, corto = call ? alto : basso;
            const prezzo = lungo.price != null && corto.price != null ? lungo.price - corto.price : null;
            const mL = mid(lungo), mC = mid(corto);
            const m = mL != null && mC != null ? mL - mC : null;
            const diff = prezzo != null && m != null ? prezzo - m : null;
            const verso = diff == null || Math.abs(diff) < 0.01 ? 'incerto' : diff > 0 ? 'comprato' : 'venduto';
            const nome = verso === 'incerto' ? (call ? 'CALL' : 'PUT')
                : call ? (verso === 'comprato' ? 'BULL CALL' : 'BEAR CALL') : (verso === 'comprato' ? 'BEAR PUT' : 'BULL PUT');
            const ts = Math.min(a.ts, b.ts);
            const { basis, fonte } = basisAl(basi, ts);
            return {
                ts, sessione: a.sessione, classe: a.trading_class, scadenza: a.real_expiry, tipo: basso.opt_right,
                kBasso: basso.strike, kAlto: alto.strike, larghezza: alto.strike - basso.strike, size: a.size,
                prezzo: arrot(prezzo), mid: arrot(m), verso, nome, condizioni: [a.conditions, b.conditions].filter(Boolean).join('/') || null,
                basis: arrot(basis), basisFonte: fonte,
                esBasso: basis == null ? null : arrot(basso.strike + basis), esAlto: basis == null ? null : arrot(alto.strike + basis),
            };
        }).sort((x, y) => x.ts - y.ts);
        return NextResponse.json({ giorno, min, n: verticali.length, verticali });
    } finally {
        db.close();
    }
}
