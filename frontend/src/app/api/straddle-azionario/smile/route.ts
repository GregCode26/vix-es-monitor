import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET ?ticker= lancia `execution/livelli_smile.py`: curva di volatilita' implicita
 * di oggi (IV del modello IBKR per strike) della 1a e 2a scadenza, per la
 * pagina Statistica. Letta a ogni chiamata, non salvata. Solo locale.
 */

const esegui = promisify(execFile);
const ROOT = path.join(process.cwd(), '..');
const SCRIPT = path.join(ROOT, 'execution', 'livelli_smile.py');
const TICKER = /^[A-Z][A-Z0-9. ]{0,9}$/;

export async function GET(req: NextRequest) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });

    const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim().toUpperCase();
    if (!TICKER.test(ticker)) return NextResponse.json({ errore: 'Ticker non valido' }, { status: 400 });

    try {
        // ~30 contratti letti 4 alla volta: fino a un minuto e mezzo fuori orario.
        const { stdout } = await esegui('python', ['-u', SCRIPT, ticker], {
            cwd: ROOT, timeout: 180_000, windowsHide: true,
        });
        const risultato = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (risultato.errore) return NextResponse.json({ errore: risultato.errore }, { status: 502 });
        return NextResponse.json(risultato);
    } catch (err: unknown) {
        const messaggio = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ errore: `Lettura non riuscita: ${messaggio}` }, { status: 500 });
    }
}
