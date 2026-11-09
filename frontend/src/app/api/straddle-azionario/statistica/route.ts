import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET ?ticker= lancia `execution/livelli_statistica.py`: movimento % per periodo
 * di scadenza, letto da IBKR a ogni chiamata e non salvato. Solo locale.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'livelli_statistica.py');
const TICKER = /^[A-Z][A-Z0-9. ]{0,9}$/;

export async function GET(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });

    const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim().toUpperCase();
    if (!TICKER.test(ticker)) return NextResponse.json({ errore: 'Ticker non valido' }, { status: 400 });

    try {
        const { stdout } = await esegui('python', ['-u', SCRIPT, ticker], {
            cwd: ROOT, timeout: 120_000, windowsHide: true,
        });
        const risultato = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (risultato.errore) return NextResponse.json({ errore: risultato.errore }, { status: 502 });
        return NextResponse.json(risultato);
    } catch (err: unknown) {
        const messaggio = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ errore: `Calcolo non riuscito: ${messaggio}` }, { status: 500 });
    }
}
