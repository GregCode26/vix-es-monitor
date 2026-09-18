import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Market Tide: premio e volume netti (lato ask meno lato bid) della catena
 * SPX 0DTE, cumulati sulla giornata. Li calcola tws_volumes_poller.py e li
 * scrive nel campo `tide` di ogni snapshot.
 *
 * Si leggono da Supabase (colonna `tide`, vedi sql/006) con ripiego sul file
 * locale: senza la colonna la pagina pubblicata restava vuota, perche' su
 * Vercel i JSON dei poller non esistono. Dalla riga si prendono solo `tide`,
 * l'ora e il prezzo: `volumes` pesa 5 KB a snapshot ed e' quello che
 * spenderebbe l'egress.
 *
 * Solo oggi, e `?since=HH:MM:SS` come /api/volumes.
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

/**
 * Gli snapshot col tide di oggi, dal database. `null` distingue "Supabase non
 * risponde" (si ripiega sul file) da "non c'e' ancora niente".
 */
async function readSupabaseSnapshots(date: string, since: string | null): Promise<Snapshot[] | null> {
    if (!supabase) return null;
    // PostgREST tronca a 1000 righe senza dirlo, e a uno snapshot ogni dieci
    // secondi il tetto arriva dopo neanche tre ore di sessione.
    const PAGE = 1000;
    const MAX = 10000;
    const righe: Snapshot[] = [];
    for (let from = 0; from < MAX; from += PAGE) {
        let query = supabase
            .from('volumes_snapshots')
            .select('time, spx_price, und_price, tide')
            .eq('date', date)
            .not('tide', 'is', null)
            .order('time', { ascending: true })
            .range(from, from + PAGE - 1);
        if (since) query = query.gt('time', since);
        const { data, error } = await query;
        if (error) {
            // Colonna non ancora creata (sql/006): non e' un guasto, e il file
            // locale ce l'ha comunque.
            console.error('Market tide Supabase error:', error.message);
            return null;
        }
        if (!data || data.length === 0) break;
        righe.push(...data.map((r) => ({
            time: r.time,
            spxPrice: r.spx_price,
            undPrice: r.und_price,
            tide: r.tide as Snapshot['tide'],
        })));
        if (data.length < PAGE) break;
    }
    return righe;
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sinceParam = searchParams.get('since');
    const since = isValidTime(sinceParam) ? sinceParam : null;
    const date = getTodayKey();

    const daDb = await readSupabaseSnapshots(date, since);
    const snapshots = daDb && daDb.length > 0
        ? daDb
        : (readLocalSnapshots(date) ?? []).filter((s) => !since || s.time > since);

    const points: TidePoint[] = [];
    for (const s of snapshots) {
        if (!s.tide) continue;
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
