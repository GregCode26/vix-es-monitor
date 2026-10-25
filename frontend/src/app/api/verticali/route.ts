import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Costo di esecuzione dei vertical da 5 punti sullo SPX 0DTE.
 *
 * Legge `frontend/data/catena/quote.json`, che `execution/tws_volumes_poller.py`
 * sovrascrive a ogni giro (10 s) con il bid/ask dei 37 strike che segue. Per
 * ogni coppia K / K+5 restituisce il vertical sulle call e quello sulle put:
 * prezzo naturale long (debito, si paga l'ask e si incassa il bid) e short
 * (credito), mid e costo. Il costo e' la meta' del bid/ask delle due gambe
 * sommata, ed e' lo stesso per il long e lo short sugli stessi contratti: la
 * scelta vera e' fra call e put sugli stessi strike, che danno la stessa
 * esposizione (bull call = bull put, bear put = bear call).
 *
 * Solo locale e solo oggi: il file non va su Supabase, e una quotazione di
 * ieri non serve a eseguire niente.
 *
 * `?sim=1` risponde con una catena simulata (vedi `catenaSimulata`), per
 * vedere la pagina a mercato chiuso. La risposta ha `sim: true`.
 */

interface RigaQuote {
    strike: number;
    cBid: number | null;
    cAsk: number | null;
    pBid: number | null;
    pAsk: number | null;
}

interface FileQuote {
    date: string;
    time: string;
    spot: number | null;
    expiry: string;
    strikes: RigaQuote[];
}

export interface Lato {
    /** Prezzo del vertical long al naturale: compri a ask, vendi a bid. */
    debito: number;
    /** Prezzo del vertical short al naturale: vendi a bid, compri a ask. */
    credito: number;
    mid: number;
    /** Meta' del bid/ask delle due gambe, in punti (x100 = $ a contratto). */
    costo: number;
}

export interface Vertical {
    k1: number;
    k2: number;
    /** Long = bull call, short = bear call. */
    call: Lato | null;
    /** Long = bear put, short = bull put. */
    put: Lato | null;
}

const AMPIEZZA = 5;

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Next puo' partire dalla radice del repo o da frontend/: i dati stanno comunque in frontend/data. */
function fileQuote() {
    const cwd = process.cwd();
    const daRadice = path.join(cwd, 'frontend', 'package.json');
    return fs.existsSync(daRadice)
        ? path.join(cwd, 'frontend', 'data', 'catena', 'quote.json')
        : path.join(cwd, 'data', 'catena', 'quote.json');
}

/** Distribuzione normale cumulata (Abramowitz-Stegun 26.2.17, errore < 1e-7). */
function normale(x: number) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}

/**
 * Catena 0DTE finta: Black-Scholes a 3 ore dalla scadenza, IV 19% con un po' di
 * skew sulle put, bid/ask con il tick dello SPX (0,05 sotto 3 $, 0,10 sopra) e
 * spread che si allarga col prezzo come nei dati veri del 23/10/2026. Lo spot
 * oscilla di qualche punto nel tempo, cosi' la pagina si vede aggiornare.
 */
function catenaSimulata(): FileQuote {
    const ora = new Date();
    const spot = Math.round((7648 + 8 * Math.sin(ora.getTime() / 120000)) * 100) / 100;
    const T = 3 / 24 / 365;
    const prezzo = (K: number, call: boolean) => {
        const iv = 0.19 + 0.0004 * Math.max(0, spot - K);
        const d1 = (Math.log(spot / K) + (iv * iv * T) / 2) / (iv * Math.sqrt(T));
        const d2 = d1 - iv * Math.sqrt(T);
        return call ? spot * normale(d1) - K * normale(d2) : K * normale(-d2) - spot * normale(-d1);
    };
    const quota = (m: number): [number, number] => {
        const tick = m < 3 ? 0.05 : 0.1;
        const meta = m < 3 ? 0.05 : 0.05 + 0.004 * m;
        const bid = Math.max(0, Math.round((m - meta) / tick) * tick);
        const ask = Math.max(tick, Math.round((m + meta) / tick) * tick);
        return [arrotonda(bid), arrotonda(ask > bid ? ask : bid + tick)];
    };
    const atm = Math.round(spot / 5) * 5;
    const strikes: RigaQuote[] = [];
    for (let i = -18; i <= 18; i++) {
        const K = atm + 5 * i;
        const [cBid, cAsk] = quota(prezzo(K, true));
        const [pBid, pAsk] = quota(prezzo(K, false));
        strikes.push({ strike: K, cBid, cAsk, pBid, pAsk });
    }
    const hh = (n: number) => String(n).padStart(2, '0');
    return {
        date: getTodayKey(),
        time: `${hh(ora.getHours())}:${hh(ora.getMinutes())}:${hh(ora.getSeconds())}`,
        spot,
        expiry: getTodayKey().replace(/-/g, ''),
        strikes,
    };
}

const arrotonda = (x: number) => Math.round(x * 100) / 100;

/** Vertical fra la gamba che vale di piu' (`cara`, quella che il long compra) e l'altra; coppie [bid, ask]. */
function lato(cara: [number | null, number | null], economica: [number | null, number | null]): Lato | null {
    const [cb, ca] = cara;
    const [eb, ea] = economica;
    if (cb == null || ca == null || eb == null || ea == null || ca < cb || ea < eb) return null;
    const mid = (cb + ca) / 2 - (eb + ea) / 2;
    return {
        debito: arrotonda(ca - eb),
        credito: arrotonda(cb - ea),
        mid: arrotonda(mid),
        costo: arrotonda((ca - cb) / 2 + (ea - eb) / 2),
    };
}

export async function GET(request: NextRequest) {
    const date = getTodayKey();
    const sim = request.nextUrl.searchParams.get('sim') === '1';
    let q: FileQuote;
    if (sim) {
        q = catenaSimulata();
    } else {
        if (process.env.VERCEL) {
            return NextResponse.json({ date, local: false, sim, verticali: [] });
        }
        try {
            q = JSON.parse(fs.readFileSync(fileQuote(), 'utf-8'));
        } catch {
            return NextResponse.json({ error: 'Nessuna quotazione: il poller dei volumi non ha ancora scritto' }, { status: 503 });
        }
        if (q.date !== date) {
            return NextResponse.json({ error: `Ultima quotazione del ${q.date}: oggi il poller non ha ancora scritto` }, { status: 503 });
        }
    }

    const perStrike = new Map(q.strikes.map((r) => [r.strike, r]));
    const verticali: Vertical[] = [];
    for (const r of q.strikes) {
        const alto = perStrike.get(r.strike + AMPIEZZA);
        if (!alto) continue;
        verticali.push({
            k1: r.strike,
            k2: alto.strike,
            // Sulle call vale di piu' lo strike basso, sulle put quello alto.
            call: lato([r.cBid, r.cAsk], [alto.cBid, alto.cAsk]),
            put: lato([alto.pBid, alto.pAsk], [r.pBid, r.pAsk]),
        });
    }

    return NextResponse.json({ date, local: true, sim, time: q.time, spot: q.spot, expiry: q.expiry, verticali });
}
