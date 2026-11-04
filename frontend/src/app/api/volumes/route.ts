import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { giornoRichiesto } from '@/lib/giornoRichiesto';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

interface VolumeSnapshot {
    time: string;
    spxPrice?: number | null;
    isOpening?: boolean;
    volumes: unknown;
}

/** `since` e' un orario 'HH:MM:SS': confrontabile con < e > perche' zero-padded. */
function isValidTime(value: string | null): value is string {
    return !!value && /^\d{2}:\d{2}:\d{2}$/.test(value);
}

function readLocalSnapshots(targetDate: string): VolumeSnapshot[] | null {
    // I poller scrivono in frontend/data/volumes; a seconda di dove Next e'
    // stato avviato process.cwd() puo' essere la root del repo o frontend/.
    const candidates = [
        path.join(process.cwd(), 'data', 'volumes', `${targetDate}.json`),
        path.join(process.cwd(), 'frontend', 'data', 'volumes', `${targetDate}.json`),
    ];

    for (const dataPath of candidates) {
        try {
            if (!fs.existsSync(dataPath)) continue;
            const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {
            console.error('Volumes local read failed:', e);
        }
    }
    return null;
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        // Oggi, oppure `?date=` per una giornata passata: quella si legge solo
        // dal file locale, mai da Supabase (vedi lib/giornoRichiesto.ts).
        const { data: targetDate, passato } = giornoRichiesto(searchParams);
        const sinceParam = searchParams.get('since');
        const since = isValidTime(sinceParam) ? sinceParam : null;

        // Su Vercel esiste solo questa strada: il filesystem non ha i JSON
        // dei poller, che girano sulla macchina locale.
        if (supabase && !passato) {
            // PostgREST tronca a 1000 righe senza segnalarlo, e a uno snapshot
            // ogni 10 secondi il tetto arriva dopo meno di tre ore: senza
            // paginare, il primo caricamento perdeva tutto il resto della
            // sessione. Gli aggiornamenti con `since` non ne risentivano, il
            // che rendeva il buco difficile da notare.
            const PAGE = 1000;
            const MAX = 10000; // ~28h a 10 secondi, con margine
            const righe: { time: string; spx_price: number | null; is_opening: boolean; volumes: unknown }[] = [];
            let erroreDb = false;

            for (let from = 0; from < MAX; from += PAGE) {
                let query = supabase
                    .from('volumes_snapshots')
                    .select('time, spx_price, is_opening, volumes')
                    .eq('date', targetDate)
                    .order('time', { ascending: true })
                    .range(from, from + PAGE - 1);

                // Il cuore del risparmio di banda: con `since` il client riceve
                // solo gli snapshot comparsi dopo l'ultimo che gia' possiede,
                // ~1,8 KB invece dell'intera sessione.
                if (since) query = query.gt('time', since);

                const { data, error } = await query;

                if (error) {
                    console.error('Volumes Supabase error:', error.message);
                    erroreDb = true;
                    break;
                }
                if (!data || data.length === 0) break;
                righe.push(...data);
                if (data.length < PAGE) break;
            }

            if (!erroreDb) {
                const history: VolumeSnapshot[] = righe.map((row) => ({
                    time: row.time,
                    spxPrice: row.spx_price,
                    isOpening: row.is_opening,
                    volumes: row.volumes,
                }));
                return NextResponse.json({ date: targetDate, since, history }, { status: 200 });
            }
        }

        const local = readLocalSnapshots(targetDate);
        if (local) {
            const history = since ? local.filter((s) => s.time > since) : local;
            return NextResponse.json({ date: targetDate, since, history }, { status: 200 });
        }

        return NextResponse.json({ date: targetDate, since, history: [] }, { status: 200 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Volume API Error:', message);
        return NextResponse.json({ error: 'Internal Server Error', details: message }, { status: 500 });
    }
}
