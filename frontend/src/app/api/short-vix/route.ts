import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { giornoRichiesto, mezzogiornoDi } from '@/lib/giornoRichiesto';
import { operazioniVix, SOGLIA_VIX, TARGET, COSTO } from '@/lib/shortVix';

export const dynamic = 'force-dynamic';

/**
 * GET /api/short-vix — le operazioni "short su spinta del VIX" (IN PROVA, vedi lib/shortVix.ts) di oggi,
 * o di `?date=YYYY-MM-DD` dai file locali. Le disegna l'indicatore Quantower. Solo locale.
 */
export async function GET(req: NextRequest) {
    const cwd = process.cwd();
    const dati = fs.existsSync(path.join(cwd, 'frontend', 'package.json')) ? path.join(cwd, 'frontend', 'data') : path.join(cwd, 'data');
    const { data, passato } = giornoRichiesto(req.nextUrl.searchParams);
    const adesso = new Date();
    const oraAttuale = passato ? null : adesso.getHours() * 3600 + adesso.getMinutes() * 60 + adesso.getSeconds();
    const operazioni = operazioniVix(dati, data, passato ? mezzogiornoDi(data) : adesso, oraAttuale);
    const chiuse = operazioni.filter((o) => o.punti != null);
    return NextResponse.json({
        date: data, sogliaVix: SOGLIA_VIX, target: TARGET, costo: COSTO,
        operazioni,
        riassunto: {
            segnali: operazioni.length,
            senzaMuro: operazioni.filter((o) => o.senzaMuro).length,
            chiuse: chiuse.length,
            vinte: chiuse.filter((o) => (o.punti as number) > 0).length,
            nettoPunti: Math.round(chiuse.reduce((s, o) => s + (o.punti as number) - COSTO, 0) * 100) / 100,
        },
    });
}
