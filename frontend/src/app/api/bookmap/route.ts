import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * CVD e liquidita' bid/ask di ES, da Bookmap.
 *
 * Li manda `execution/bookmap_addon.py`, che gira dentro Bookmap: un campione
 * al secondo con i contratti comprati/venduti in quel secondo e la somma del
 * book a N livelli per lato. Qui si accodano a
 * `frontend/data/bookmap/YYYY-MM-DD.ndjson` (una riga per campione, cosi'
 * scrivere costa un append e non la riscrittura del file) e si tengono in
 * memoria per la GET.
 *
 * Il CVD si calcola qui, sommando `buy - sell` sull'intera giornata: se lo
 * tenesse l'add-on ripartirebbe da zero a ogni riavvio di Bookmap.
 *
 * Solo locale, niente Supabase: su ES un campione al secondo sono ~80.000
 * righe al giorno, e senza bisogno di vederle da fuori non vale l'egress.
 * Solo oggi; `?since=HH:MM:SS` per la lettura incrementale, altrimenti gli
 * ultimi MAX_INIZIALI campioni.
 */

interface Campione {
    date: string;
    t: string;
    alias: string;
    price: number | null;
    bid: number | null;
    ask: number | null;
    buy: number;
    sell: number;
    bidLiq: number;
    askLiq: number;
    levels: number;
    book?: Book;
    addB?: number;
    remB?: number;
    addA?: number;
    remA?: number;
}

/** Ordini limit per livello: [prezzo, contratti], solo i livelli sopra la soglia dell'add-on. */
export interface Book {
    b: [number, number][];
    a: [number, number][];
}

export interface BookmapPoint {
    time: string;
    price: number | null;
    bid: number | null;
    ask: number | null;
    buy: number;
    sell: number;
    delta: number;
    cvd: number;
    bidLiq: number;
    askLiq: number;
    levels: number;
    alias: string;
    book: Book | null;
    /**
     * Contratti limit aggiunti/tolti in quel secondo nei primi 5 livelli di
     * ciascun lato (tolti = cancellati + eseguiti). Null nei campioni di prima
     * che l'add-on li contasse.
     */
    addB: number | null;
    remB: number | null;
    addA: number | null;
    remA: number | null;
}

interface Giornata {
    points: BookmapPoint[];
    visti: Set<string>;
    cvd: number;
}

/** Tre ore a un campione al secondo: quanto la pagina tiene in memoria. */
const MAX_INIZIALI = 10800;

const giornate = new Map<string, Giornata>();

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isValidTime(value: string | null): value is string {
    return !!value && /^\d{2}:\d{2}:\d{2}$/.test(value);
}

/** Next puo' partire dalla radice del repo o da frontend/: i dati stanno comunque in frontend/data. */
function cartella() {
    const cwd = process.cwd();
    const daRadice = path.join(cwd, 'frontend', 'package.json');
    return fs.existsSync(daRadice)
        ? path.join(cwd, 'frontend', 'data', 'bookmap')
        : path.join(cwd, 'data', 'bookmap');
}

function aggiungi(g: Giornata, c: Campione): BookmapPoint | null {
    const chiave = `${c.alias}|${c.t}`;
    // L'add-on ripete l'invio se la POST va in timeout: il campione puo' essere gia' arrivato.
    if (g.visti.has(chiave)) return null;
    g.visti.add(chiave);
    const delta = (Number(c.buy) || 0) - (Number(c.sell) || 0);
    g.cvd += delta;
    const p: BookmapPoint = {
        time: c.t,
        price: c.price ?? null,
        bid: c.bid ?? null,
        ask: c.ask ?? null,
        buy: Number(c.buy) || 0,
        sell: Number(c.sell) || 0,
        delta: Math.round(delta * 100) / 100,
        cvd: Math.round(g.cvd * 100) / 100,
        bidLiq: Number(c.bidLiq) || 0,
        askLiq: Number(c.askLiq) || 0,
        levels: Number(c.levels) || 0,
        alias: c.alias,
        // I campioni scritti prima che l'add-on mandasse il book non ce l'hanno.
        book: c.book && Array.isArray(c.book.b) && Array.isArray(c.book.a) ? c.book : null,
        addB: numeroONull(c.addB),
        remB: numeroONull(c.remB),
        addA: numeroONull(c.addA),
        remA: numeroONull(c.remA),
    };
    g.points.push(p);
    return p;
}

function numeroONull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function giornata(date: string): Giornata {
    let g = giornate.get(date);
    if (g) return g;
    g = { points: [], visti: new Set(), cvd: 0 };
    try {
        const testo = fs.readFileSync(path.join(cartella(), `${date}.ndjson`), 'utf-8');
        for (const riga of testo.split('\n')) {
            if (!riga.trim()) continue;
            try {
                aggiungi(g, JSON.parse(riga));
            } catch {
                // una riga troncata (processo interrotto a meta' scrittura) non deve costare la giornata
            }
        }
    } catch {
        // nessun file ancora: giornata vuota
    }
    // Una sola giornata in memoria alla volta, oltre a quella appena caricata.
    for (const k of giornate.keys()) if (k !== date) giornate.delete(k);
    giornate.set(date, g);
    return g;
}

function valido(c: unknown): c is Campione {
    const x = c as Campione;
    return !!x && typeof x.alias === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && isValidTime(x.t);
}

export async function POST(request: NextRequest) {
    if (process.env.VERCEL) {
        return NextResponse.json({ error: 'Bookmap e\' solo locale' }, { status: 503 });
    }
    let body: { samples?: unknown[] };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'JSON non valido' }, { status: 400 });
    }
    const samples = Array.isArray(body.samples) ? body.samples.filter(valido) : [];
    if (samples.length === 0) return NextResponse.json({ saved: 0 });

    const dir = cartella();
    fs.mkdirSync(dir, { recursive: true });

    // Di solito un solo giorno per POST, ma a mezzanotte (o svuotando la coda) possono essere due.
    const perGiorno = new Map<string, Campione[]>();
    for (const c of samples) {
        const lista = perGiorno.get(c.date) ?? [];
        lista.push(c);
        perGiorno.set(c.date, lista);
    }

    let saved = 0;
    for (const [date, lista] of perGiorno) {
        const g = giornata(date);
        const righe: string[] = [];
        for (const c of lista) {
            if (aggiungi(g, c)) {
                righe.push(JSON.stringify(c));
                saved++;
            }
        }
        // L'add-on svuota la coda in ordine, anche dopo un'interruzione: i punti
        // restano cronologici e `?since=` non ne perde.
        if (righe.length > 0) fs.appendFileSync(path.join(dir, `${date}.ndjson`), righe.join('\n') + '\n');
    }
    return NextResponse.json({ saved });
}

export async function GET(request: NextRequest) {
    const date = getTodayKey();
    // Su Vercel i campioni non arrivano mai: l'add-on scrive sul PC dove gira Bookmap.
    if (process.env.VERCEL) {
        return NextResponse.json({ date, points: [], lastTime: null, total: 0, local: false });
    }
    const g = giornata(date);
    const since = request.nextUrl.searchParams.get('since');

    let points: BookmapPoint[];
    if (isValidTime(since)) {
        points = g.points.filter((p) => p.time > since);
    } else {
        points = g.points.slice(-MAX_INIZIALI);
    }
    const ultimo = g.points[g.points.length - 1];
    return NextResponse.json({
        date,
        points,
        lastTime: ultimo?.time ?? null,
        total: g.points.length,
    });
}
