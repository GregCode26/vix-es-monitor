/**
 * Hedging Pressure / Acceleration Analysis API
 *
 * Combines GEX, Vanna, spot movement, and IV changes to estimate
 * hedging pressure and acceleration potential across the option chain.
 *
 * Flow:
 * 1. Read from /api/gex for profile, spots, strikes (latest snapshot)
 * 2. Read from /api/iv-monitor for IV and IV changes
 * 3. Calculate Vanna from collected delta and vega
 * 4. Calculate proximity weights based on spot and ATM IV
 * 5. Combine into hedging pressure profile per strike
 * 6. Normalize and return
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { estimateVanna, vannaToHedgingPressure } from '@/lib/vanna';
import { calculateHedgingPressure, normalizeHedgingPressure, identifyRiskZones } from '@/lib/hedgingPressure';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Snapshot letti da Supabase per ogni richiesta.
 *
 * Uno snapshot con tutta la catena pesa ~5,5 KB, e la pagina chiama ogni 15
 * secondi: 60 snapshot erano 330 KB a richiesta, ~79 MB l'ora di egress con
 * la sola pagina aperta. Il profilo ne usa uno solo, quello di adesso; gli
 * altri servivano a `pressureHistory`, che ora se la costruisce la pagina
 * accumulando quello che riceve. Sei bastano a coprire un giro saltato.
 */
const SNAPSHOT_RECENTI = 6;

interface StrikeRow {
    strike: number;
    calls?: number;
    puts?: number;
    callsOi?: number;
    putsOi?: number;
    gamma?: number | null;
    delta?: number | null;
    vega?: number | null;
}

interface Snapshot {
    time: string;
    spxPrice?: number | null;
    undPrice?: number | null;
    volumes: StrikeRow[];
}

interface IVSnapshot {
    time: string;
    esPrice: number | null;
    atmStrike: number;
    weightedPutIV: number | null;
    weightedCallIV: number | null;
    putIVChangePct: number | null;
    callIVChangePct: number | null;
}

interface HedgingPressureRow {
    strike: number;
    gex: number;
    vanna: number | null;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
    normalizedPressure: number;
    proximity: number;
}

interface PressureHistoryPoint {
    time: string;
    strike: number;
    gammaPressure: number;
    vannaPressure: number;
    totalPressure: number;
}

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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
            console.error('Hedging pressure local read failed:', e);
        }
    }
    return null;
}

/**
 * Senza Supabase il deploy su Vercel non ha dati: i JSON locali restano fuori
 * dal pacchetto di proposito (vedi frontend/.vercelignore).
 *
 * Il primo snapshot della giornata arriva senza catena (`volumes: []`) e
 * serve solo come riferimento di apertura per `spotDelta`.
 */
async function readSupabaseSnapshots(dateStr: string): Promise<Snapshot[] | null> {
    if (!supabase) return null;

    const [primo, recenti] = await Promise.all([
        supabase
            .from('volumes_snapshots')
            .select('time, spx_price, und_price')
            .eq('date', dateStr)
            .not('und_price', 'is', null)
            .order('time', { ascending: true })
            .limit(1),
        supabase
            .from('volumes_snapshots')
            .select('time, spx_price, und_price, volumes')
            .eq('date', dateStr)
            .order('time', { ascending: false })
            .limit(SNAPSHOT_RECENTI),
    ]);

    if (primo.error || recenti.error) {
        console.error('Hedging pressure Supabase error:', primo.error?.message ?? recenti.error?.message);
        return null;
    }

    const snapshots: Snapshot[] = (recenti.data ?? []).reverse().map((r) => ({
        time: r.time,
        spxPrice: r.spx_price,
        undPrice: r.und_price,
        volumes: r.volumes as StrikeRow[],
    }));

    const apertura = primo.data?.[0];
    if (apertura && snapshots.length > 0 && apertura.time < snapshots[0].time) {
        snapshots.unshift({
            time: apertura.time,
            spxPrice: apertura.spx_price,
            undPrice: apertura.und_price,
            volumes: [],
        });
    }
    return snapshots;
}

/** Solo l'ultima riga IV: la route non usa lo storico. */
async function readSupabaseLatestIV(dateStr: string): Promise<IVSnapshot | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('iv_snapshots')
        .select('time, es_price, atm_strike, weighted_put_iv, weighted_call_iv, put_iv_change_pct, call_iv_change_pct')
        .eq('date', dateStr)
        .order('time', { ascending: false })
        .limit(1);
    if (error) {
        console.error('Hedging pressure IV Supabase error:', error.message);
        return null;
    }
    const r = data?.[0];
    if (!r) return null;
    return {
        time: r.time,
        esPrice: r.es_price,
        atmStrike: r.atm_strike,
        weightedPutIV: r.weighted_put_iv,
        weightedCallIV: r.weighted_call_iv,
        putIVChangePct: r.put_iv_change_pct,
        callIVChangePct: r.call_iv_change_pct,
    };
}

function readLocalIVSnapshots(dateStr: string): IVSnapshot[] | null {
    const candidates = [
        path.join(process.cwd(), 'data', 'iv-monitor', `${dateStr}.json`),
        path.join(process.cwd(), 'frontend', 'data', 'iv-monitor', `${dateStr}.json`),
    ];
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {
            console.error('IV local read failed:', e);
        }
    }
    return null;
}

function getAtmIv(ivSnapshot: IVSnapshot | null): number {
    if (!ivSnapshot) return 0.25; // default to 25% if no data
    const putIv = ivSnapshot.weightedPutIV ?? 0;
    const callIv = ivSnapshot.weightedCallIV ?? 0;
    const avg = (putIv + callIv) / 2;
    return Math.max(0.01, avg); // IV as decimal, min 1%
}

function getIvChange(ivSnapshot: IVSnapshot | null): number {
    if (!ivSnapshot) return 0;
    const putChange = ivSnapshot.putIVChangePct ?? 0;
    const callChange = ivSnapshot.callIVChangePct ?? 0;
    const avgChange = (putChange + callChange) / 2;
    // IV change is in percent; convert to basis points / 100 for consistency
    return avgChange / 100;
}

function toSeconds(hhmmss: string): number {
    const [h, m, s] = hhmmss.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

interface GexPoint {
    time: string;
    strike: number;
    gex: number;
    gexOi: number;
}

interface ProfileRow {
    strike: number;
    gex: number;
    gexOi: number;
}

interface SpotPoint {
    time: string;
    price: number;
}

/**
 * Elaborate snapshots to extract latest GEX profile and spot.
 * Reused from /api/gex logic.
 */
function elaboraSnapshot(snapshots: Snapshot[]): {
    profile: ProfileRow[];
    spot: SpotPoint[];
    strikes: number[];
    latestSnapshotTime: string | null;
} {
    const CONTRACT_SIZE = 100;

    function strikeGex(gamma: number, netContracts: number, spot: number): number {
        const dollars = gamma * netContracts * CONTRACT_SIZE * spot * spot * 0.01;
        return Math.round((dollars / 1e6) * 100) / 100;
    }

    const profilo = new Map<number, ProfileRow>();
    const spotSerie: SpotPoint[] = [];
    let ultimoSpotSec = -Infinity;
    let ultimoValido: SpotPoint | null = null;

    for (const snap of snapshots) {
        const orario = snap.time;
        const spot = snap.undPrice ?? snap.spxPrice ?? null;
        if (!spot || !Number.isFinite(spot) || !Array.isArray(snap.volumes)) continue;

        const snapSec = toSeconds(snap.time);
        if (snapSec - ultimoSpotSec >= 30) {
            spotSerie.push({ time: orario, price: spot });
            ultimoSpotSec = snapSec;
        }

        for (const row of snap.volumes) {
            if (row.gamma == null || !Number.isFinite(row.gamma)) continue;

            const vol = (row.calls ?? 0) - (row.puts ?? 0);
            const oi = (row.callsOi ?? 0) - (row.putsOi ?? 0);

            profilo.set(row.strike, {
                strike: row.strike,
                gex: strikeGex(row.gamma, vol, spot),
                gexOi: strikeGex(row.gamma, oi, spot),
            });
        }

        ultimoValido = { time: orario, price: spot };
    }

    if (ultimoValido && spotSerie[spotSerie.length - 1]?.time !== ultimoValido.time) {
        spotSerie.push(ultimoValido);
    }

    const profiloFinale = [...profilo.values()].sort((a, b) => a.strike - b.strike);
    const strikes = profiloFinale.map((r) => r.strike);

    return {
        profile: profiloFinale,
        spot: spotSerie,
        strikes,
        latestSnapshotTime: ultimoValido?.time ?? null,
    };
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const targetDate = getTodayKey();

        // Read volume snapshots (with gamma, delta, vega)
        let local = (await readSupabaseSnapshots(targetDate)) ?? [];
        if (local.length === 0) local = readLocalSnapshots(targetDate) ?? [];
        if (local.length === 0) {
            return NextResponse.json(
                { error: 'No volume data available for ' + targetDate },
                { status: 503 }
            );
        }

        const { profile, spot, strikes, latestSnapshotTime } = elaboraSnapshot(local);
        if (profile.length === 0) {
            return NextResponse.json(
                { error: 'No gamma data available for ' + targetDate },
                { status: 503 }
            );
        }

        // Get latest spot
        const latestSpot = spot.length > 0 ? spot[spot.length - 1].price : null;
        if (!latestSpot) {
            return NextResponse.json(
                { error: 'No spot data available' },
                { status: 503 }
            );
        }

        // Read IV data to get current IV and changes
        let latestIV = await readSupabaseLatestIV(targetDate);
        if (!latestIV) {
            const ivSnapshots = readLocalIVSnapshots(targetDate) ?? [];
            latestIV = ivSnapshots.length > 0 ? ivSnapshots[ivSnapshots.length - 1] : null;
        }
        const atmIv: number = getAtmIv(latestIV);
        const ivChange = getIvChange(latestIV);

        // Time to expiration for 0DTE (approximated)
        const now = new Date();
        const daysToExp = 1; // 0DTE, treat as 1 day
        const timeToExpiry = daysToExp / 365;

        // Build enriched strikes with delta/vega/vanna
        const enrichedStrikes: Array<{
            strike: number;
            gex: number;
            delta: number | null;
            vega: number | null;
            vanna: number | null;
        }> = [];

        if (local.length > 0) {
            const latestSnapshot = local[local.length - 1];
            for (const row of (latestSnapshot.volumes ?? []) as StrikeRow[]) {
                const strike = row.strike;
                if (strike == null) continue;
                const gexRow = profile.find((p) => p.strike === strike);
                if (!gexRow) continue;

                // @ts-expect-error - atmIv is guaranteed to be a number from getAtmIv
                const vanna = estimateVanna(row.vega, latestSpot, strike, atmIv, timeToExpiry);
                const vannaHedging = vannaToHedgingPressure(vanna, latestSpot);

                enrichedStrikes.push({
                    strike: row.strike,
                    gex: gexRow.gex,
                    delta: row.delta ?? null,
                    vega: row.vega ?? null,
                    vanna: vannaHedging,
                });
            }
        }

        // Calculate spot delta (price change from opening to now)
        // Simple: use first and last spot from today
        const spotDelta = spot.length > 1 ? spot[spot.length - 1].price - spot[0].price : 0;

        // Calculate hedging pressure
        const pressures = calculateHedgingPressure(enrichedStrikes, latestSpot, spotDelta, atmIv, ivChange);

        // Normalize pressure values
        const rawPressures = pressures.map((p) => p.totalPressure);
        const normalizedPressures = normalizeHedgingPressure(rawPressures);

        // Build final response
        const hedgingProfile: HedgingPressureRow[] = pressures.map((p, idx) => ({
            strike: p.strike,
            gex: p.gex,
            vanna: p.vanna,
            gammaPressure: Math.round(p.gammaPressure * 100) / 100,
            vannaPressure: Math.round(p.vannaPressure * 100) / 100,
            totalPressure: Math.round(p.totalPressure * 100) / 100,
            normalizedPressure: normalizedPressures[idx],
            proximity: Math.round(p.proximity * 100) / 100,
        }));

        // Identify risk zones
        const riskZones = identifyRiskZones(pressures);

        // Build pressure history for top 5 strikes (for time-series visualization)
        // Pick top 5 by absolute normalized pressure
        const topStrikes = pressures
            .map((p, idx) => ({ ...p, normPressure: normalizedPressures[idx] }))
            .sort((a, b) => Math.abs(b.normPressure) - Math.abs(a.normPressure))
            .slice(0, 5)
            .map((p) => p.strike);

        const pressureHistory: PressureHistoryPoint[] = [];
        if (topStrikes.length > 0 && local.length > 0) {
            // Calculate pressure at each snapshot for top strikes
            for (const snap of local) {
                const snapSpot = snap.undPrice ?? snap.spxPrice ?? null;
                if (!snapSpot) continue;

                // Simple delta from previous snapshot
                const snapDelta = spot.filter((p) => p.time <= snap.time);
                const currentSpotDelta =
                    snapDelta.length > 1 ? snapDelta[snapDelta.length - 1].price - snapDelta[0].price : 0;

                for (const strike of topStrikes) {
                    const row = snap.volumes?.find((v) => v.strike === strike);
                    if (!row || row.gamma == null) continue;

                    // @ts-expect-error - atmIv is guaranteed to be a number from getAtmIv
                    const vanna = estimateVanna(row.vega, snapSpot, strike, atmIv, timeToExpiry);
                    const vannaHedging = vannaToHedgingPressure(vanna, snapSpot);

                    const gexRow = profile.find((p) => p.strike === strike);
                    if (!gexRow) continue;

                    const CONTRACT_SIZE = 100;
                    const strikeGex = (gamma: number, netContracts: number, s: number) => {
                        const dollars = gamma * netContracts * CONTRACT_SIZE * s * s * 0.01;
                        return Math.round((dollars / 1e6) * 100) / 100;
                    };

                    const vol = (row.calls ?? 0) - (row.puts ?? 0);
                    const gex = strikeGex(row.gamma, vol, snapSpot);

                    const scale = Math.max(1, snapSpot * 0.01 * Math.max(0.5, Math.min(2, atmIv / 25)));
                    const distance = Math.abs(strike - snapSpot);
                    const proximity = distance === 0 ? 1 : Math.exp(-distance / scale);

                    const gammaPressure = gex * currentSpotDelta * proximity;
                    const vannaPressure = vannaHedging ? vannaHedging * ivChange * proximity : 0;
                    const totalPressure = gammaPressure + vannaPressure;

                    pressureHistory.push({
                        time: snap.time,
                        strike,
                        gammaPressure: Math.round(gammaPressure * 100) / 100,
                        vannaPressure: Math.round(vannaPressure * 100) / 100,
                        totalPressure: Math.round(totalPressure * 100) / 100,
                    });
                }
            }
        }

        return NextResponse.json(
            {
                date: targetDate,
                time: latestSnapshotTime,
                spot: latestSpot,
                atmStrike: latestIV?.atmStrike ?? null,
                atmIv: Math.round(atmIv * 10000) / 100, // as percentage
                spotDelta: Math.round(spotDelta * 100) / 100,
                ivChange: Math.round(ivChange * 10000) / 100, // in basis points
                profile: hedgingProfile,
                riskZones,
                strikes,
                pressureHistory: pressureHistory.slice(-1000), // Limit to last 1000 points
            },
            { status: 200 }
        );
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unexpected error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
