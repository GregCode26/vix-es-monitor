import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Market Tide: premio e volume netti (lato ask meno lato bid) della catena
 * SPX 0DTE, cumulati sulla giornata. Li calcola tws_volumes_poller.py e li
 * scrive nel campo `tide` di ogni snapshot.
 *
 * Solo locale: il campo non va su Supabase, quindi su Vercel la serie e'
 * vuota. Solo oggi, e `?since=HH:MM:SS` come /api/volumes.
 */

interface Snapshot {
    time: string;
    spxPrice?: number | null;
    undPrice?: number | null;
    tide?: { ncp: number; npp: number; ncv: number; npv: number };
}

export interface TidePoint {
    time: string;
    spx: number | null;
    ncp: number;
    npp: number;
    /** Volume netto call meno volume netto put, in contratti. */
    netVol: number;
}

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

function readLocalSnapshots(dateStr: string): Snapshot[] | null {
    const candidates = [
        path.join(process.cwd(), 'data', 'volumes', `${dateStr}.json`),
        path.join(process.cwd(), 'frontend', 'data', 'volumes', `${dateStr}.json`),
    ];
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (Array.isArray(parsed)) return parsed as Snapshot[];
        } catch (e) {
            console.error('Market tide local read failed:', e);
        }
    }
    return null;
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sinceParam = searchParams.get('since');
    const since = isValidTime(sinceParam) ? sinceParam : null;
    const date = getTodayKey();

    const points: TidePoint[] = [];
    for (const s of readLocalSnapshots(date) ?? []) {
        if (!s.tide || (since && s.time <= since)) continue;
        points.push({
            time: s.time,
            spx: s.undPrice ?? s.spxPrice ?? null,
            ncp: s.tide.ncp,
            npp: s.tide.npp,
            netVol: s.tide.ncv - s.tide.npv,
        });
    }

    return NextResponse.json({ date, since, points });
}
