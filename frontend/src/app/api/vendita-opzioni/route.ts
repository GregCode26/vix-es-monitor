import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Vendita opzioni: POST lancia `execution/vendita_opzioni.py` in background
 * (sui titoli in portafoglio, o su `{tickers: [...]}`), che legge IBKR in sola
 * lettura e scrive `data/vendita-opzioni/ultimo.json` alla fine e `stato.json`
 * durante il calcolo. GET li rilegge. Solo locale: serve TWS.
 */

const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'vendita_opzioni.py');
const CARTELLA = path.join(process.cwd(), 'data', 'vendita-opzioni');
const LOG = path.join(ROOT, '.tmp', 'vendita-opzioni.log');
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;
/** Oltre questo uno `stato` ancora "in corso" e' di un calcolo morto, non lo si aspetta. */
const SCADUTO_MS = 15 * 60_000;

function leggi(nome: string) {
    try {
        return JSON.parse(fs.readFileSync(path.join(CARTELLA, `${nome}.json`), 'utf8'));
    } catch {
        return null;
    }
}

function inCorso(stato: { inCorso?: boolean; inizio?: string } | null) {
    return !!stato?.inCorso && Date.now() - Date.parse(stato.inizio ?? '') < SCADUTO_MS;
}

export async function GET() {
    if (process.env.VERCEL) return NextResponse.json({ local: false });
    const stato = leggi('stato');
    return NextResponse.json({ local: true, ultimo: leggi('ultimo'), stato: stato && { ...stato, inCorso: inCorso(stato) } });
}

export async function POST(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    if (inCorso(leggi('stato'))) return NextResponse.json({ errore: 'Calcolo gia\' in corso' }, { status: 409 });

    const corpo = await req.json().catch(() => ({}));
    const tickers: string[] = Array.isArray(corpo?.tickers)
        ? corpo.tickers.map((t: unknown) => String(t).trim().toUpperCase()).filter((t: string) => TICKER.test(t))
        : [];

    fs.mkdirSync(CARTELLA, { recursive: true });
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    // Stato scritto subito, cosi' la pagina vede "in corso" anche prima che Python si colleghi.
    fs.writeFileSync(path.join(CARTELLA, 'stato.json'), JSON.stringify({
        inCorso: true, inizio: new Date().toISOString(), titolo: 'collegamento a TWS', fatti: 0, totale: 0,
    }));
    const log = fs.openSync(LOG, 'w');
    const figlio = spawn('python', ['-u', SCRIPT, ...tickers], {
        cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    });
    figlio.unref();
    return NextResponse.json({ ok: true });
}
