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
import { giornoRichiesto } from '@/lib/giornoRichiesto';

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

/**
 * Con `?storia=1` la route manda anche la pressione del resto della
 * sessione, uno snapshot al minuto. Serve al primo caricamento della pagina:
 * senza, la serie temporale partiva da quando la si apriva.
 *
 * Uno al minuto e non tutti: sull'intera sessione (13:30-22:00) sono ~510
 * snapshot da ~5,5 KB, ~2,8 MB di egress per ogni apertura della pagina,
 * contro i ~17 MB di tutti quelli a dieci secondi. Per una linea che si
 * guarda su ore il minuto basta; il dettaglio a dieci secondi lo aggiungono
 * poi i giri normali.
 */
const STORIA_MAX = 1000;

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

/**
 * Uno snapshot al minuto della giornata: quelli con i secondi fra 00 e 09.
 * Il poller ne scrive uno ogni dieci secondi, quindi ne cade quasi sempre
 * esattamente uno per minuto; `time` e' testo 'HH:MM:SS', e il filtro lo fa
 * Postgres, cosi' gli altri cinque non escono proprio dal database.
 */
async function readSupabaseStoria(dateStr: string): Promise<Snapshot[] | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('volumes_snapshots')
        .select('time, spx_price, und_price, volumes')
        .eq('date', dateStr)
        .like('time', '%:%:0_')
        .order('time', { ascending: true })
        .limit(STORIA_MAX);
    if (error) {
        console.error('Hedging pressure storia Supabase error:', error.message);
        return null;
    }
    return (data ?? []).map((r) => ({
        time: r.time,
        spxPrice: r.spx_price,
        undPrice: r.und_price,
        volumes: r.volumes as StrikeRow[],
    }));
}

/** Lo stesso campionamento sul file locale. */
function campionaAlMinuto(snapshots: Snapshot[]): Snapshot[] {
    const out: Snapshot[] = [];
    let ultimoMinuto: string | null = null;
    for (const s of snapshots) {
        const minuto = s.time.slice(0, 5);
        if (minuto === ultimoMinuto) continue;
        ultimoMinuto = minuto;
        out.push(s);
    }
    return out;
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
            // gamma 0 non e' "gamma nullo": dopo la chiusura IBKR manda 0 su
            // tutta la catena, e tenerlo azzerava l'intero profilo (03/11/2026:
            // alle 22:00 tutte le pressioni valevano 0 e i "top strike"
            // diventavano i primi cinque dell'array). Si tiene l'ultimo valido.
            if (row.gamma == null || !Number.isFinite(row.gamma) || row.gamma === 0) continue;

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
        const conStoria = searchParams.get('storia') === '1';
        // `?date=YYYY-MM-DD` (09/11/2026, per execution/studio_rombi_serie.py): un giorno
        // passato, SOLO dai file locali (lib/giornoRichiesto.ts), mai da Supabase.
        const { data: targetDate, passato } = giornoRichiesto(searchParams);

        // Read volume snapshots (with gamma, delta, vega)
        let local = passato ? [] : (await readSupabaseSnapshots(targetDate)) ?? [];
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
        let latestIV = passato ? null : await readSupabaseLatestIV(targetDate);
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

        /**
         * Gli strike di cui si manda lo storico: i piu' carichi per
         * |pressione normalizzata|. Sono le linee della serie temporale, e
         * vengono dagli snapshot che il poller scrive comunque per tutta la
         * catena: piu' linee non costano richieste a IBKR ne' letture in piu'
         * da Supabase, solo una risposta piu' grande.
         *
         * Solo fra quelli con una pressione vera: a parita' di valore il sort
         * lascia l'ordine dell'array, quindi quando le pressioni sono tutte
         * uguali (chiusura, o un dato di gamma che non e' ancora arrivato) la
         * vecchia versione sceglieva i cinque strike piu' BASSI della catena,
         * lontanissimi dallo spot. Se non ne restano abbastanza si completa
         * con i piu' vicini allo spot, che e' la scelta neutra.
         */
        const NUM_TOP_STRIKE = 20;
        const perVicinanza = pressures
            .map((p) => p.strike)
            .sort((x, y) => Math.abs(x - latestSpot) - Math.abs(y - latestSpot));
        const topStrikes = pressures
            .map((p, idx) => ({ strike: p.strike, normPressure: normalizedPressures[idx], tot: p.totalPressure }))
            .filter((p) => Number.isFinite(p.tot) && p.tot !== 0)
            .sort((a, b) => Math.abs(b.normPressure) - Math.abs(a.normPressure))
            .slice(0, NUM_TOP_STRIKE)
            .map((p) => p.strike);
        for (const strike of perVicinanza) {
            if (topStrikes.length >= NUM_TOP_STRIKE) break;
            if (!topStrikes.includes(strike)) topStrikes.push(strike);
        }

        // Il riferimento di apertura per lo spostamento dello spot: e' il
        // primo punto della serie, che readSupabaseSnapshots mette apposta.
        const aperturaSpot = spot.length > 0 ? spot[0].price : null;
        const CONTRACT_SIZE = 100;
        const strikeGexStorico = (gamma: number, netContracts: number, s: number) => {
            const dollars = gamma * netContracts * CONTRACT_SIZE * s * s * 0.01;
            return Math.round((dollars / 1e6) * 100) / 100;
        };

        /**
         * La pressione dei top strike a ogni snapshot. Lo spostamento dello
         * spot si misura dall'apertura: prima si prendeva l'ultimo punto della
         * serie a 30 s non oltre lo snapshot, che e' lo stesso numero a meno
         * di mezzo minuto, ma per gli snapshot della storia quella serie non
         * c'e'.
         */
        const pressioneDi = (snaps: Snapshot[]): PressureHistoryPoint[] => {
            const out: PressureHistoryPoint[] = [];
            if (topStrikes.length === 0 || aperturaSpot == null) return out;
            for (const snap of snaps) {
                const snapSpot = snap.undPrice ?? snap.spxPrice ?? null;
                if (!snapSpot) continue;
                const currentSpotDelta = snapSpot - aperturaSpot;

                for (const strike of topStrikes) {
                    const row = snap.volumes?.find((v) => v.strike === strike);
                    if (!row || row.gamma == null || !Number.isFinite(row.gamma) || row.gamma === 0) continue;

                    // @ts-expect-error - atmIv is guaranteed to be a number from getAtmIv
                    const vanna = estimateVanna(row.vega, snapSpot, strike, atmIv, timeToExpiry);
                    const vannaHedging = vannaToHedgingPressure(vanna, snapSpot);

                    const vol = (row.calls ?? 0) - (row.puts ?? 0);
                    const gex = strikeGexStorico(row.gamma, vol, snapSpot);

                    // Come calculateProximityScale: atmIv e' decimale, la
                    // normalizzazione e' in punti percentuali.
                    const scale = Math.max(1, snapSpot * 0.01 * Math.max(0.5, Math.min(2, (atmIv * 100) / 25)));
                    const distance = Math.abs(strike - snapSpot);
                    const proximity = distance === 0 ? 1 : Math.exp(-distance / scale);

                    const gammaPressure = gex * currentSpotDelta * proximity;
                    const vannaPressure = vannaHedging ? vannaHedging * ivChange * proximity : 0;
                    const totalPressure = gammaPressure + vannaPressure;

                    out.push({
                        time: snap.time,
                        strike,
                        gammaPressure: Math.round(gammaPressure * 100) / 100,
                        vannaPressure: Math.round(vannaPressure * 100) / 100,
                        totalPressure: Math.round(totalPressure * 100) / 100,
                    });
                }
            }
            return out;
        };

        // Senza Supabase `local` e' la giornata intera, da cui il tetto.
        const pressureHistory = pressioneDi(local.filter((snap) => Array.isArray(snap.volumes) && snap.volumes.length > 0)).slice(-1000);

        // La storia della sessione, solo se chiesta: la pagina la vuole una
        // volta, al primo caricamento, e poi continua con i giri normali.
        // Si ferma dove comincia `local`, che e' gia' in pressureHistory.
        let storia: PressureHistoryPoint[] = [];
        if (conStoria) {
            let campioni = passato ? null : await readSupabaseStoria(targetDate);
            if (!campioni || campioni.length === 0) campioni = campionaAlMinuto(readLocalSnapshots(targetDate) ?? []);
            const inizioRecenti = pressureHistory.length > 0 ? pressureHistory[0].time : null;
            storia = pressioneDi(campioni.filter((snap) => inizioRecenti == null || snap.time < inizioRecenti));
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
                topStrikes,
                pressureHistory,
                ...(conStoria ? { storia } : {}),
            },
            { status: 200 }
        );
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unexpected error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
