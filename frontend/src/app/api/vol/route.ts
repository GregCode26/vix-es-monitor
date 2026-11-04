import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { calcolaVol } from '@/lib/volContesto';

export const dynamic = 'force-dynamic';

/**
 * Bande di chiusura, divergenze SPX/VIX1D e contesto della giornata
 * (lib/volContesto.ts). Le stesse cose arrivano anche dentro /api/smile
 * (`vol`); questa risponde anche prima dell'apertura, quando lo smile e' 503.
 * Locale e solo oggi.
 */
function cartellaDati() {
    const cwd = process.cwd();
    return fs.existsSync(path.join(cwd, 'frontend', 'package.json'))
        ? path.join(cwd, 'frontend', 'data')
        : path.join(cwd, 'data');
}

function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export async function GET() {
    const date = getTodayKey();
    if (process.env.VERCEL) return NextResponse.json({ date, local: false });
    return NextResponse.json({ date, local: true, ...calcolaVol(cartellaDati(), date) });
}
