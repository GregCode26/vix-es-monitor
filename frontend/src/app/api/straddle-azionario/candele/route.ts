import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET ?ticker=&anni= lancia `execution/livelli_candele.py`: candele giornaliere
 * da IBKR per il grafico di /livelli-azionari. Lette a ogni chiamata, non salvate. Solo locale.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'livelli_candele.py');
const TICKER = /^[A-Z][A-Z0-9. ]{0,9}$/;

export async function GET(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });

    const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim().toUpperCase();
    if (!TICKER.test(ticker)) return NextResponse.json({ errore: 'Ticker non valido' }, { status: 400 });
    const anni = String(Math.max(1, Math.min(5, Number(req.nextUrl.searchParams.get('anni')) || 1)));

    try {
        const { stdout } = await esegui('python', ['-u', SCRIPT, ticker, anni], {
            cwd: ROOT, timeout: 90_000, windowsHide: true,
        });
        const risultato = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (risultato.errore) return NextResponse.json({ errore: risultato.errore }, { status: 502 });
        return NextResponse.json(risultato);
    } catch (err: unknown) {
        const messaggio = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ errore: `Lettura non riuscita: ${messaggio}` }, { status: 500 });
    }
}
