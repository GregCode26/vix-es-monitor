import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Pagina di prova `/sbilanciamento` (11/11/2026): call e put SPX 0DTE alla stessa distanza dall'ATM.
 *
 * Nessun dato nuovo: legge `data/catena/quote.json`, gli ultimi bid/ask dei 37 strike che il poller dei
 * volumi riscrive ogni 10 s. Il centro e' il forward da put-call parity (`smile.fwd`), non lo spot: su
 * 0DTE differiscono di poco, ma centrando sullo spot uno scarto di 1-2 punti basterebbe a far sembrare
 * piu' care le call o le put vicino all'ATM. Per ogni distanza d = 5, 10, ... il prezzo della call a F+d e
 * della put a F-d e' interpolato linearmente fra i due strike vicini (bid, ask e IV).
 *
 * Bilanciati = i due intervalli bid-ask si sovrappongono: con quei prezzi non si puo' dire quale costi
 * di piu'. Altrimenti il lato piu' caro e lo scarto in % del prezzo medio della coppia. Sotto 0.10 di
 * mid le opzioni sono a pochi tick e il confronto non vale ('troppo economiche').
 *
 * Ogni nuova lettura di quote.json (solo di oggi) aggiunge una riga riassuntiva a
 * `data/sbilanciamento/YYYY-MM-DD.ndjson`, per poter verificare dopo se lo sbilanciamento anticipa
 * SPX. La storia c'e' solo per i momenti in cui qualcuno ha chiamato la route (pagina aperta).
 */

function cartellaDati() {
    const cwd = process.cwd();
    return fs.existsSync(path.join(cwd, 'frontend', 'package.json')) ? path.join(cwd, 'frontend', 'data') : path.join(cwd, 'data');
}

type Strike = { strike: number; cBid: number | null; cAsk: number | null; pBid: number | null; pAsk: number | null; cIvS?: number | null; pIvS?: number | null };
type Quote = { date: string; time: string; spot: number | null; expiry: string; smile?: { fwd?: number; ivAtm?: number; em?: number } | null; strikes: Strike[] };

export type Riga = {
    d: number;
    kPut: number; kCall: number;
    put: { bid: number; ask: number; mid: number; iv: number | null };
    call: { bid: number; ask: number; mid: number; iv: number | null };
    stato: 'bilanciati' | 'call' | 'put' | 'economiche';
    /** (call - put) / media dei due mid, in %: + = call piu' care. */
    scarto: number;
};

export type Lettura = {
    time: string; spot: number | null; fwd: number;
    /** media degli scarti delle distanze confrontabili, in % */
    indice: number | null;
    bilanciati: number; confrontabili: number;
    /** prima distanza dall'ATM non bilanciata, e da che parte */
    inizio: { d: number; lato: 'call' | 'put' } | null;
    /** le distanze sbilanciate: quante per lato */
    call: number; put: number;
};

const valido = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function interpola(s: Strike[], x: number, campo: keyof Strike): number | null {
    for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1];
        if (x < a.strike || x > b.strike) continue;
        const va = a[campo] as number | null | undefined, vb = b[campo] as number | null | undefined;
        if (!valido(va) || !valido(vb)) return null;
        const w = (x - a.strike) / (b.strike - a.strike);
        return va + (vb - va) * w;
    }
    return null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function calcola(q: Quote): { righe: Riga[]; lettura: Lettura } | null {
    const s = [...q.strikes].sort((a, b) => a.strike - b.strike);
    const fwd = q.smile?.fwd ?? q.spot;
    if (!fwd || s.length < 3) return null;
    const righe: Riga[] = [];
    for (let d = 5; d <= 100; d += 5) {
        const kP = fwd - d, kC = fwd + d;
        const pb = interpola(s, kP, 'pBid'), pa = interpola(s, kP, 'pAsk');
        const cb = interpola(s, kC, 'cBid'), ca = interpola(s, kC, 'cAsk');
        if (pb == null || pa == null || cb == null || ca == null || pa < pb || ca < cb) continue;
        const pm = (pb + pa) / 2, cm = (cb + ca) / 2;
        const scarto = ((cm - pm) / ((cm + pm) / 2)) * 100;
        const stato: Riga['stato'] = pm < 0.1 || cm < 0.1 ? 'economiche'
            : cb <= pa && pb <= ca ? 'bilanciati' : cm > pm ? 'call' : 'put';
        righe.push({
            d, kPut: r2(kP), kCall: r2(kC),
            put: { bid: r2(pb), ask: r2(pa), mid: r2(pm), iv: interpola(s, kP, 'pIvS') },
            call: { bid: r2(cb), ask: r2(ca), mid: r2(cm), iv: interpola(s, kC, 'cIvS') },
            stato, scarto: r2(scarto),
        });
    }
    const conf = righe.filter((r) => r.stato !== 'economiche');
    const primo = conf.find((r) => r.stato === 'call' || r.stato === 'put');
    const lettura: Lettura = {
        time: q.time, spot: q.spot, fwd: r2(fwd),
        indice: conf.length ? r2(conf.reduce((t, r) => t + r.scarto, 0) / conf.length) : null,
        bilanciati: conf.filter((r) => r.stato === 'bilanciati').length,
        confrontabili: conf.length,
        inizio: primo ? { d: primo.d, lato: primo.stato as 'call' | 'put' } : null,
        call: conf.filter((r) => r.stato === 'call').length,
        put: conf.filter((r) => r.stato === 'put').length,
    };
    return { righe, lettura };
}

const oggiRoma = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

export async function GET() {
    const base = cartellaDati();
    let q: Quote;
    try {
        q = JSON.parse(fs.readFileSync(path.join(base, 'catena', 'quote.json'), 'utf-8'));
    } catch {
        return NextResponse.json({ error: 'quote.json non disponibile (poller dei volumi spento o fuori orario)' }, { status: 503 });
    }
    const r = calcola(q);
    if (!r) return NextResponse.json({ error: 'catena incompleta' }, { status: 503 });

    const cartella = path.join(base, 'sbilanciamento');
    const file = path.join(cartella, `${q.date}.ndjson`);
    let storia: Lettura[] = [];
    try {
        if (fs.existsSync(file)) storia = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { storia = []; }
    if (q.date === oggiRoma() && storia[storia.length - 1]?.time !== q.time) {
        try {
            fs.mkdirSync(cartella, { recursive: true });
            fs.appendFileSync(file, JSON.stringify(r.lettura) + '\n');
            storia.push(r.lettura);
        } catch { /* solo storia persa */ }
    }
    return NextResponse.json({ date: q.date, expiry: q.expiry, ivAtm: q.smile?.ivAtm ?? null, em: q.smile?.em ?? null, ...r, storia });
}
