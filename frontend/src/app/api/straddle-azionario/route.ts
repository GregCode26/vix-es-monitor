import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Straddle azionario: POST {ticker} lancia `execution/straddle_azionario.py`,
 * che legge IBKR, e salva la riga; GET le rilegge; DELETE ?id= ne toglie una.
 * Solo locale: serve TWS, e le righe stanno in un file, non su Supabase.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'straddle_azionario.py');
const FILE = path.join(process.cwd(), 'data', 'straddle-azionario', 'righe.json');
const TICKER = /^[A-Z][A-Z0-9. ]{0,9}$/;

type Riga = Record<string, unknown> & { id: string };

function leggiRighe(): Riga[] {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        return [];
    }
}

function scriviRighe(righe: Riga[]) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(righe, null, 1));
}

export async function GET() {
    if (process.env.VERCEL) return NextResponse.json({ local: false, righe: [] });
    return NextResponse.json({ local: true, righe: leggiRighe() });
}

export async function POST(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });

    const corpo = await req.json().catch(() => null);
    const ticker = String(corpo?.ticker ?? '').trim().toUpperCase();
    if (!TICKER.test(ticker)) return NextResponse.json({ errore: 'Ticker non valido' }, { status: 400 });

    try {
        const { stdout } = await esegui('python', ['-u', SCRIPT, ticker], {
            cwd: ROOT, timeout: 180_000, windowsHide: true,
        });
        const risultato = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (risultato.errore) return NextResponse.json({ errore: risultato.errore }, { status: 502 });

        const riga: Riga = { id: randomUUID(), ...risultato };
        scriviRighe([riga, ...leggiRighe()]);
        return NextResponse.json({ riga });
    } catch (err: unknown) {
        const messaggio = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ errore: `Calcolo non riuscito: ${messaggio}` }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    const id = req.nextUrl.searchParams.get('id');
    scriviRighe(leggiRighe().filter(r => r.id !== id));
    return NextResponse.json({ ok: true });
}
