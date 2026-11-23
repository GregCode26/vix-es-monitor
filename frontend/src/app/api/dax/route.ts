import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Strategia DAX (/dax).
 *   GET          -> posizione salvata (gambe e impostazioni)
 *   PUT {..}     -> salva la posizione
 *   POST {gambe, classeFuture} -> lancia `execution/dax_quote.py` e rende le quote IBKR
 * Solo locale: serve TWS e la posizione sta in un file, non su Supabase.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'dax_quote.py');
const FILE = path.join(process.cwd(), 'data', 'dax', 'posizione.json');

export async function GET() {
    if (process.env.VERCEL) return NextResponse.json({ local: false, posizione: null });
    try {
        return NextResponse.json({ local: true, posizione: JSON.parse(fs.readFileSync(FILE, 'utf8')) });
    } catch {
        return NextResponse.json({ local: true, posizione: null });
    }
}

export async function PUT(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') return NextResponse.json({ errore: 'Corpo non valido' }, { status: 400 });
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(corpo, null, 1));
    return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    const corpo = await req.json().catch(() => null);
    const gambe = Array.isArray(corpo?.gambe) ? corpo.gambe : [];
    const classeFuture = ['FDAX', 'FDXM', 'FDXS'].includes(corpo?.classeFuture) ? corpo.classeFuture : 'FDXM';
    const richiesta = {
        classeFuture,
        scadenzaAtm: /^\d{4}-\d{2}-\d{2}$/.test(String(corpo?.scadenzaAtm)) ? corpo.scadenzaAtm : null,
        gambe: gambe
            .filter((g: Record<string, unknown>) => (g.tipo === 'C' || g.tipo === 'P') && Number(g.strike) > 0
                && /^\d{4}-\d{2}-\d{2}$/.test(String(g.scadenza)))
            .map((g: Record<string, unknown>) => ({ id: String(g.id), tipo: g.tipo, strike: Number(g.strike), scadenza: g.scadenza })),
    };
    try {
        const { stdout } = await esegui('python', ['-u', SCRIPT, JSON.stringify(richiesta)], {
            cwd: ROOT, timeout: 120_000, windowsHide: true,
        });
        const risultato = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (risultato.errore) return NextResponse.json({ errore: risultato.errore }, { status: 502 });
        return NextResponse.json({ ...risultato, ora: new Date().toISOString() });
    } catch (err: unknown) {
        const messaggio = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ errore: `Lettura IBKR non riuscita: ${messaggio}` }, { status: 500 });
    }
}
