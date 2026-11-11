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
 * piu' care le call o le put vicino all'ATM. Si usano gli strike veri (prezzi senza interpolazione), a
 * coppie simmetriche attorno al punto della griglia da 2.5 piu' vicino al forward.
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
    /** centro delle coppie sulla griglia da 2.5 (uno strike o il punto fra due) */
    centro: number;
    /** media degli scarti delle distanze confrontabili, in % */
    indice: number | null;
    bilanciati: number; confrontabili: number;
    /** prima distanza dall'ATM non bilanciata, e da che parte */
    inizio: { d: number; lato: 'call' | 'put' } | null;
    /** le distanze sbilanciate: quante per lato */
    call: number; put: number;
};

const valido = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

const r2 = (x: number) => Math.round(x * 100) / 100;

function calcola(q: Quote): { righe: Riga[]; lettura: Lettura } | null {
    const s = [...q.strikes].sort((a, b) => a.strike - b.strike);
    const fwd = q.smile?.fwd ?? q.spot;
    if (!fwd || s.length < 3) return null;
    // Strike veri della catena: il centro e' il punto della griglia da 2.5 piu' vicino al forward. Se cade su
    // uno strike le coppie sono centro -5/+5, -10/+10...; se cade a meta' fra due strike, -2.5/+2.5, -7.5/+7.5...
    // Cosi' la coppia resta simmetrica attorno al forward entro 1.25 punti.
    const centro = Math.round(fwd / 2.5) * 2.5;
    const perStrike = new Map(s.map((x) => [x.strike, x]));
    const partenza = perStrike.has(centro) ? 5 : 2.5;
    const righe: Riga[] = [];
    for (let d = partenza; d <= 100; d += 5) {
        const P = perStrike.get(centro - d), C = perStrike.get(centro + d);
        if (!P || !C) continue;
        const pb = P.pBid, pa = P.pAsk, cb = C.cBid, ca = C.cAsk;
        if (!valido(pb) || !valido(pa) || !valido(cb) || !valido(ca) || pa < pb || ca < cb) continue;
        const pm = (pb + pa) / 2, cm = (cb + ca) / 2;
        const scarto = ((cm - pm) / ((cm + pm) / 2)) * 100;
        const stato: Riga['stato'] = pm < 0.1 || cm < 0.1 ? 'economiche'
            : cb <= pa && pb <= ca ? 'bilanciati' : cm > pm ? 'call' : 'put';
        righe.push({
            d, kPut: P.strike, kCall: C.strike,
            put: { bid: pb, ask: pa, mid: r2(pm), iv: P.pIvS ?? null },
            call: { bid: cb, ask: ca, mid: r2(cm), iv: C.cIvS ?? null },
            stato, scarto: r2(scarto),
        });
    }
    const conf = righe.filter((r) => r.stato !== 'economiche');
    const primo = conf.find((r) => r.stato === 'call' || r.stato === 'put');
    const lettura: Lettura = {
        time: q.time, spot: q.spot, fwd: r2(fwd), centro,
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
