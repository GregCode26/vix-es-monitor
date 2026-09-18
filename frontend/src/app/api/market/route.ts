import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Quando si e' scoperto che market_data non ha la colonna es_atm_iv (vedi
 * sql/005). Vale dieci minuti, poi si riprova: dopo la migrazione la colonna
 * torna da sola, senza riavviare il server.
 */
let colonnaIvMancaDal: number | null = null;
const RIPROVA_COLONNA_IV_MS = 10 * 60 * 1000;
const colonnaIvManca = () => colonnaIvMancaDal !== null && Date.now() - colonnaIvMancaDal < RIPROVA_COLONNA_IV_MS;

export const dynamic = 'force-dynamic';

// La colonna `spx` fa parte dello schema di market_data: la migrazione a
// runtime che la aggiungeva (con credenziali Postgres dirette) non serve piu'.

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** I sei livelli di una sessione, piu' i valori intermedi da cui vengono. */
interface LivelliRange {
    basis: number;
    straddle: number;
    r1Up: number; r1Down: number;
    r2Up: number; r2Down: number;
    r3Up: number; r3Down: number;
}

type PuntoStorico = Record<string, unknown>;

const numero = (v: unknown): number | null =>
    typeof v === 'number' && isFinite(v) && v > 0 ? v : null;

const secondi = (hhmmss: string): number => {
    const [h, m, s] = hhmmss.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
};

/**
 * Il primo punto utile a partire da un orario, entro mezz'ora.
 *
 * Stessa tolleranza che la pagina market usa per compilarsi da sola: se il
 * poller era fermo alle 10:35 in punto si prende il primo buono dopo, invece
 * di rinunciare alla giornata.
 */
function puntoAllOra(storico: PuntoStorico[], oraTarget: string, campi: string[]): PuntoStorico | null {
    const inizio = secondi(oraTarget);
    const limite = inizio + 30 * 60;
    for (const p of storico) {
        const t = typeof p.time === 'string' ? p.time : '';
        if (!t) continue;
        const sec = secondi(t);
        if (sec < inizio) continue;
        if (sec > limite) break;
        if (numero(p.esf) !== null && campi.every((c) => numero(p[c]) !== null)) return p;
    }
    return null;
}

/**
 * Il modello di range dallo straddle ATM, gli stessi conti che il pannello
 * Range fa nella pagina market.
 *
 * Sta anche qui perche' i livelli calcolati nel browser vivono nel
 * localStorage di quel browser: chi apre il gamma da un'altra macchina, o dal
 * sito pubblicato, non li vedrebbe mai. Calcolati dove i dati gia' passano,
 * valgono per chiunque guardi. Le modifiche fatte a mano nel pannello restano
 * pero' piu' forti di questi, e la pagina che li usa lo rispetta.
 */
function livelliDa(punto: PuntoStorico | null, campi: { c: string; ca: string; p: string; pa: string }): LivelliRange | null {
    if (!punto) return null;
    const es = numero(punto.esf);
    const spot = numero(punto.spx) ?? numero(punto.spxRef) ?? (es !== null ? es - 15 : null);
    const callBid = numero(punto[campi.c]);
    const callAsk = numero(punto[campi.ca]);
    const putBid = numero(punto[campi.p]);
    const putAsk = numero(punto[campi.pa]);
    if (es === null || spot === null || callBid === null || callAsk === null || putBid === null || putAsk === null) {
        return null;
    }

    const basis = es - spot;
    const straddle = (callBid + callAsk) / 2 + (putBid + putAsk) / 2;
    const r3 = Math.sqrt(3);
    const arrotonda = (v: number) => Math.round(v * 100) / 100;

    return {
        basis: arrotonda(basis),
        straddle: arrotonda(straddle),
        r1Up: arrotonda(spot + straddle + basis),
        r1Down: arrotonda(spot - straddle + basis),
        r2Up: arrotonda(spot + straddle / r3 + basis),
        r2Down: arrotonda(spot - straddle / r3 + basis),
        r3Up: arrotonda(spot + straddle * r3 + basis),
        r3Down: arrotonda(spot - straddle * r3 + basis),
    };
}

function calcolaRange(storico: PuntoStorico[]) {
    return {
        // La mattina si usa la chain ES: alle 10:35 a New York sono le 4:35 e
        // le SPX quotano larghe. Il pomeriggio, a mercato aperto, quella SPX.
        morning: livelliDa(
            puntoAllOra(storico, '10:35:00', ['esCallBid', 'esCallAsk', 'esPutBid', 'esPutAsk']),
            { c: 'esCallBid', ca: 'esCallAsk', p: 'esPutBid', pa: 'esPutAsk' },
        ),
        ob: livelliDa(
            puntoAllOra(storico, '15:35:00', ['callBid', 'callAsk', 'putBid', 'putAsk']),
            { c: 'callBid', ca: 'callAsk', p: 'putBid', pa: 'putAsk' },
        ),
    };
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const historyMode = searchParams.get('history') === 'true';

        const isSupabaseConfigured = supabaseUrl !== 'https://placeholder.supabase.co';

        const getLocalData = (dateStr: string) => {
            try {
                const dataPath = path.join(process.cwd(), 'data', 'market', `${dateStr}.json`);
                if (fs.existsSync(dataPath)) {
                    const content = fs.readFileSync(dataPath, 'utf-8');
                    return JSON.parse(content);
                }
            } catch (e) {
                console.error('Local JSON Error:', e);
            }
            return null;
        };

        // Le colonne delle quote sono snake_case su Postgres ma la pagina le
        // legge in camelCase, come le scrive il poller nel file locale.
        const QUOTE_COLUMNS = 'call_bid, call_ask, put_bid, put_ask, es_call_bid, es_call_ask, es_put_bid, es_put_ask, es_atm_strike, spx_atm_strike, spx_ref, es_atm_iv';

        // Finche' sql/005_market_data_es_atm_iv.sql non e' stato eseguito la
        // colonna non c'e', e PostgREST rifiuta l'intera select: senza questo
        // lo storico cadeva tutto sul file locale, e su Vercel restava vuoto.
        const colonne = (c: string) => (colonnaIvManca() ? c.replace(/,\s*es_atm_iv/, '') : c);
        const segnaSeMancaIv = (message: string | undefined) => {
            if (colonnaIvManca() || !message?.includes('es_atm_iv')) return false;
            colonnaIvMancaDal = Date.now();
            console.warn('market_data.es_atm_iv assente: eseguire sql/005_market_data_es_atm_iv.sql');
            return true;
        };

        const withCamelQuotes = (row: any) => ({
            ...row,
            callBid: row.callBid ?? row.call_bid ?? null,
            callAsk: row.callAsk ?? row.call_ask ?? null,
            putBid: row.putBid ?? row.put_bid ?? null,
            putAsk: row.putAsk ?? row.put_ask ?? null,
            esCallBid: row.esCallBid ?? row.es_call_bid ?? null,
            esCallAsk: row.esCallAsk ?? row.es_call_ask ?? null,
            esPutBid: row.esPutBid ?? row.es_put_bid ?? null,
            esPutAsk: row.esPutAsk ?? row.es_put_ask ?? null,
            esAtmStrike: row.esAtmStrike ?? row.es_atm_strike ?? null,
            spxAtmStrike: row.spxAtmStrike ?? row.spx_atm_strike ?? null,
            spxRef: row.spxRef ?? row.spx_ref ?? null,
            esAtmIv: row.esAtmIv ?? row.es_atm_iv ?? null,
            vwap: typeof row.vwap === 'number' ? row.vwap : null,
        });

        /**
         * Scarica tutte le righe di una giornata, a pagine.
         *
         * PostgREST tronca silenziosamente a 1000 righe (`db-max-rows`): senza
         * paginare, con il poller che scrive ogni 5 secondi si perdeva tutto
         * quello che veniva dopo le prime ~83 minuti di sessione.
         */
        const fetchDayRows = async (dateStr: string, columns: string) => {
            const PAGE = 1000;
            const MAX = 30000; // ~24h a 5 secondi, con margine
            const all: any[] = [];
            for (let from = 0; from < MAX; from += PAGE) {
                const { data, error } = await supabase
                    .from('market_data')
                    .select(colonne(columns))
                    .eq('date', dateStr)
                    .order('created_at', { ascending: true })
                    .range(from, from + PAGE - 1);
                if (error && segnaSeMancaIv(error.message)) {
                    from -= PAGE; // stessa pagina, senza la colonna
                    continue;
                }
                if (error) {
                    console.error('Supabase page fetch failed:', error.message);
                    break;
                }
                if (!data || data.length === 0) break;
                all.push(...data);
                if (data.length < PAGE) break;
            }
            return all;
        };

        const formatHistory = (data: any[]) => {
            return (data || []).map((raw: any) => withCamelQuotes(raw)).map((item: any) => ({
                ...item,
                time: item.time || new Date(item.created_at).toLocaleTimeString('it-IT', {
                    timeZone: 'Europe/Rome',
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                })
            }));
        };

        // Le sessioni passate restano nel database ma non si servono: qui si
        // risponde solo sulla giornata corrente, e non c'e' un `?date=` da
        // cui chiedere il resto.

        // --- Intraday history for today ---
        if (historyMode) {
            const today = getTodayKey();
            let data = null;

            if (isSupabaseConfigured) {
                try {
                    data = await fetchDayRows(today, `time, vix, esf, spx, created_at, volTide, coneUp, coneDown, vwap, ${QUOTE_COLUMNS}`);
                } catch (e) { console.error('Supabase fetch failed:', e); }
            }
            if (!data || data.length === 0) data = getLocalData(today);

            // If local/Supabase is empty for today, just return empty history
            if (!data || data.length === 0) {
                return NextResponse.json({ history: [] }, { status: 200 });
            }

            const storico = formatHistory(data);
            return NextResponse.json({ history: storico, range: calcolaRange(storico) }, { status: 200 });

        } else {
            // --- Latest price mode ---
            const today = getTodayKey();
            let vixPrice = null;
            let esfPrice = null;
            let spxPrice = null;
            let quotes: Record<string, number | null> = {};
            // Orario della riga di origine: il poller scrive ogni 15 secondi
            // mentre la pagina interroga ogni 5, e senza questo appenderebbe
            // tre volte lo stesso punto.
            let sourceTime: string | null = null;

            if (isSupabaseConfigured) {
                try {
                    const ultima = () => supabase
                        .from('market_data')
                        .select(colonne(`time, vix, esf, spx, created_at, vwap, ${QUOTE_COLUMNS}`))
                        .eq('date', today)
                        .order('created_at', { ascending: false })
                        .limit(1);
                    // La select e' costruita a runtime: il tipo delle righe non si ricava.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let { data, error }: { data: any[] | null; error: { message: string } | null } = await ultima();
                    if (error && segnaSeMancaIv(error.message)) ({ data, error } = await ultima());

                    if (!error && data && data.length > 0) {
                        vixPrice = data[0].vix;
                        esfPrice = data[0].esf;
                        spxPrice = data[0].spx ?? null;
                        quotes = withCamelQuotes(data[0]);
                        sourceTime = (data[0] as { time?: string }).time ?? null;
                    }
                } catch (e) { console.error('Supabase fetch failed:', e); }
            }

            if (vixPrice === null || esfPrice === null) {
                const localData = getLocalData(today);
                if (localData && localData.length > 0) {
                    const lastPoint = localData[localData.length - 1];
                    vixPrice = lastPoint.vix;
                    esfPrice = lastPoint.esf;
                    if (lastPoint.spx !== undefined) spxPrice = lastPoint.spx;
                    quotes = withCamelQuotes(lastPoint);
                    sourceTime = lastPoint.time ?? null;
                }
            }

            if (vixPrice === null || esfPrice === null) {
                return NextResponse.json({ error: 'No data available for today. Please ensure the poller is running.' }, { status: 404 });
            }

            const now = new Date();
            return NextResponse.json({
                timestamp: now.toISOString(),
                sourceTime,
                vwap: quotes.vwap ?? null,
                vix: vixPrice,
                esf: esfPrice,
                spx: spxPrice,
                // Quote ATM per la compilazione automatica del Range Calc:
                // le es* dalla chain ES (range delle 10:35), le altre da SPX
                // (range delle 15:35).
                callBid: quotes.callBid ?? null,
                callAsk: quotes.callAsk ?? null,
                putBid: quotes.putBid ?? null,
                putAsk: quotes.putAsk ?? null,
                esCallBid: quotes.esCallBid ?? null,
                esCallAsk: quotes.esCallAsk ?? null,
                esPutBid: quotes.esPutBid ?? null,
                esPutAsk: quotes.esPutAsk ?? null,
                esAtmStrike: quotes.esAtmStrike ?? null,
                spxAtmStrike: quotes.spxAtmStrike ?? null,
                spxRef: quotes.spxRef ?? null,
                esAtmIv: quotes.esAtmIv ?? null,
            }, { status: 200 });
        }
    } catch (error: any) {
        console.error('API Error:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', details: error.message },
            { status: 500 }
        );
    }
}
