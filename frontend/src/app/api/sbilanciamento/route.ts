import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Pagina di prova `/sbilanciamento` (11/11/2026, vertical dal 12/11): vertical SPX 0DTE da 5 punti alla
 * stessa distanza dall'ATM, call sopra contro put sotto, confrontati al mid.
 *
 * Nessun dato nuovo: legge `data/catena/quote.json`, gli ultimi bid/ask dei 37 strike che il poller dei
 * volumi riscrive ogni 10 s. Il centro e' il punto della griglia da 2.5 piu' vicino al forward da put-call
 * parity (`smile.fwd`), non lo spot: centrando sullo spot uno scarto di 1-2 punti basterebbe a sbilanciare
 * le coppie vicino all'ATM. Per ogni distanza d (dal centro allo strike vicino del vertical):
 *   call vertical  centro+d / centro+d+5  = mid C(centro+d) - mid C(centro+d+5)
 *   put vertical   centro-d / centro-d-5  = mid P(centro-d) - mid P(centro-d-5)
 * Un vertical da 5 vale circa 5 x la probabilita' (neutrale al rischio) che SPX chiuda oltre la sua
 * meta': il confronto dice se il mercato prezza piu' probabile arrivare a +d o a -d.
 *
 * Bilanciati = mid entro 0.05 (un tick) l'uno dall'altro. Altrimenti il lato piu' caro e lo scarto in %
 * del mid medio della coppia. Sotto 0.10 di mid il confronto non vale ('troppo economiche'). Bid/ask
 * del vertical = i prezzi naturali (bid vicino - ask lontano, ask vicino - bid lontano), solo per vederli.
 *
 * Ogni nuova lettura di quote.json (solo di oggi) aggiunge una riga riassuntiva a
 * `data/sbilanciamento/YYYY-MM-DD.ndjson` (`tipo: 'vertical'`; le righe dell'11/11 senza `tipo` erano sulle
 * singole opzioni), per poter verificare dopo se lo sbilanciamento anticipa SPX. La storia c'e' solo per
 * i momenti in cui qualcuno ha chiamato la route (pagina aperta).
 */

function cartellaDati() {
    const cwd = process.cwd();
    return fs.existsSync(path.join(cwd, 'frontend', 'package.json')) ? path.join(cwd, 'frontend', 'data') : path.join(cwd, 'data');
}

type Strike = { strike: number; cBid: number | null; cAsk: number | null; pBid: number | null; pAsk: number | null; cIvS?: number | null; pIvS?: number | null };
type Quote = { date: string; time: string; spot: number | null; expiry: string; smile?: { fwd?: number; ivAtm?: number; em?: number } | null; strikes: Strike[] };

export type Riga = {
    d: number;
    /** strike vicino e lontano di ciascun vertical */
    kPut: number; kPut2: number; kCall: number; kCall2: number;
    put: { bid: number; ask: number; mid: number };
    call: { bid: number; ask: number; mid: number };
    stato: 'bilanciati' | 'call' | 'put' | 'economiche';
    /** (call vertical - put vertical) / media dei due mid, in %: + = call piu' care. */
    scarto: number;
};

export type Lettura = {
    tipo?: 'vertical';
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
    const centro = Math.round(fwd / 2.5) * 2.5;
    const perStrike = new Map(s.map((x) => [x.strike, x]));
    const partenza = perStrike.has(centro) ? 0 : 2.5;
    const righe: Riga[] = [];
    for (let d = partenza; d <= 100; d += 5) {
        const P = perStrike.get(centro - d), P2 = perStrike.get(centro - d - 5);
        const C = perStrike.get(centro + d), C2 = perStrike.get(centro + d + 5);
        if (!P || !P2 || !C || !C2) continue;
        const q4 = [P.pBid, P.pAsk, P2.pBid, P2.pAsk, C.cBid, C.cAsk, C2.cBid, C2.cAsk];
        if (!q4.every(valido)) continue;
        const [pb, pa, p2b, p2a, cb, ca, c2b, c2a] = q4 as number[];
        if (pa < pb || p2a < p2b || ca < cb || c2a < c2b) continue;
        const pm = (pb + pa) / 2 - (p2b + p2a) / 2, cm = (cb + ca) / 2 - (c2b + c2a) / 2;
        const media = (cm + pm) / 2;
        const scarto = media > 0 ? ((cm - pm) / media) * 100 : 0;
        const stato: Riga['stato'] = pm < 0.1 || cm < 0.1 ? 'economiche'
            : Math.abs(cm - pm) <= 0.05 + 1e-9 ? 'bilanciati' : cm > pm ? 'call' : 'put';
        righe.push({
            d, kPut: P.strike, kPut2: P2.strike, kCall: C.strike, kCall2: C2.strike,
            put: { bid: r2(Math.max(0, pb - p2a)), ask: r2(pa - p2b), mid: r2(pm) },
            call: { bid: r2(Math.max(0, cb - c2a)), ask: r2(ca - c2b), mid: r2(cm) },
            stato, scarto: r2(scarto),
        });
    }
    const conf = righe.filter((r) => r.stato !== 'economiche');
    const primo = conf.find((r) => r.stato === 'call' || r.stato === 'put');
    const lettura: Lettura = {
        tipo: 'vertical', time: q.time, spot: q.spot, fwd: r2(fwd), centro,
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
        if (fs.existsSync(file)) storia = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Lettura).filter((l) => l.tipo === 'vertical');
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
