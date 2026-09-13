// frontend/src/app/api/gex/route.ts
//
// GEX reale calcolato dal gamma IBKR e dal volume per strike.
//
// Sostituisce il generatore sintetico (port di execution/gexbot.py), che
// inventava strike, open interest, volume e segno lasciando reale il solo
// prezzo SPX. Qui tutto viene dai dati che il poller dei volumi raccoglie
// da TWS: il gamma arriva dai modelGreeks sulle stesse sottoscrizioni gia'
// aperte per il volume.
//
// Ogni punto porta DUE misure, e la pagina commuta fra le due senza rifare
// la richiesta:
//   `gex`   pesato sul volume scambiato oggi -> misura di FLUSSO
//   `gexOi` pesato sull'open interest        -> misura di POSIZIONAMENTO,
//                                               e' il GEX canonico
// L'open interest e' fermo al closing del giorno prima, quindi intraday non
// si muove: cambia solo perche' cambiano gamma e spot.
//
// In entrambi i casi non si sa chi ha comprato e chi ha venduto: il segno
// (call positive, put negative) resta l'euristica standard "dealer lunghi di
// call, corti di put", non un dato osservato.
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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

/**
 * Flusso NUOVO di uno snapshot: il gamma exposure dei soli contratti
 * scambiati da quello precedente, non il totale di giornata.
 */
interface GexPoint {
    time: string;
    strike: number;
    /** Dai contratti scambiati fra i due snapshot. */
    gex: number;
    /** Dalla variazione di open interest, intraday quasi sempre zero. */
    gexOi: number;
}

/** Totale di giornata per strike: l'ultimo valore cumulato disponibile. */
interface ProfileRow {
    strike: number;
    gex: number;
    gexOi: number;
}

/**
 * Il sottostante al momento dello snapshot, cosi' come IBKR lo vedeva quando
 * ha valutato il gamma. E' la serie giusta per la linea dello spot su una
 * pagina di gamma: viene dallo stesso istante e dallo stesso feed, non da
 * /api/market con la sua conversione di fuso fatta a mano.
 */
interface SpotPoint {
    time: string;
    price: number;
}

/** Il profilo com'era N minuti fa, per mostrare da che parte si sta muovendo. */
interface ProfileSnapshot {
    minutesAgo: number;
    time: string;
    rows: ProfileRow[];
}

/**
 * Una fotografia del profilo cumulato, in forma compatta: i valori stanno
 * nello stesso ordine degli strike dichiarati una volta sola accanto alla
 * serie. Ripetere `{strike, gex, gexOi}` per 37 strike e 250 istanti
 * significherebbe mandare tre volte la stessa cosa.
 */
interface SerieFrame {
    time: string;
    gex: number[];
    gexOi: number[];
}

/** Quanto lontano indietro guardano i pallini storici. */
const MINUTI_STORICO = [1, 5, 10];

/** Un punto di spot ogni mezzo minuto: piu' fitto non si distingue. */
const SPOT_STEP_SEC = 30;

/**
 * Ogni quanto fotografare il profilo cumulato per la serie storica.
 *
 * `profile` dice com'e' il muro adesso, e una riga orizzontale tirata da un
 * capo all'altro del grafico non puo' dire altro. Per vedere COME i livelli si
 * sono costruiti serve il cumulato a ogni istante, non solo all'ultimo: questa
 * e' quella serie, campionata ogni due minuti perche' a dieci secondi
 * sarebbero tremila fotografie da 37 valori l'una per niente.
 */
const SERIE_STEP_SEC = 120;

function toSeconds(hhmmss: string): number {
    const [h, m, s] = hhmmss.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

/** Moltiplicatore del contratto SPX. */
const CONTRACT_SIZE = 100;

/*
 * Qui c'era la conversione da ora di Roma a ora di New York, con tanto di
 * calcolo dello scarto giusto (Europa e Stati Uniti cambiano l'ora in date
 * diverse, e per due settimane l'anno lo scarto e' di cinque ore invece di
 * sei). Era corretta e non serviva a niente: chi guarda questi grafici sta
 * in Italia e ragiona in ora italiana, come gia' facevano la pagina market,
 * i volumi e il monitor IV. Adesso l'orario che esce di qui e' lo stesso che
 * il poller ha scritto, cioe' quello dell'orologio locale.
 */

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Gamma exposure di uno strike, in milioni di dollari per un movimento
 * dell'1% del sottostante.
 *
 *   GEX = gamma * contratti * 100 * S^2 * 0.01
 *
 * `gamma` e' il gamma per punto di indice; moltiplicato per S^2 * 0.01
 * diventa la variazione di delta in dollari per un 1% di movimento. Call e
 * put entrano con segno opposto.
 */
function strikeGex(gamma: number, netContracts: number, spot: number): number {
    const dollars = gamma * netContracts * CONTRACT_SIZE * spot * spot * 0.01;
    return Math.round((dollars / 1e6) * 100) / 100;
}

/** Contratti netti di uno strike all'ultimo snapshot visto. */
interface Netti {
    vol: number;
    oi: number;
}

/**
 * Traduce gli snapshot in flusso nuovo piu' profilo cumulato.
 *
 * Il volume che il poller legge da TWS e' cumulato dall'apertura: ogni
 * snapshot porta il totale della giornata, non quanto e' passato negli
 * ultimi dieci secondi. Restituire quel totale come una serie di punti nel
 * tempo -- come si faceva finche' i dati erano sintetici, dove ogni
 * estrazione era indipendente -- disegna 900 bolle quasi identiche per
 * strike, una sopra l'altra: le legende "Addition" e "Subtraction" dicono
 * flusso ma mostrano giacenza, e il grafico diventa una banda piena
 * illeggibile che pesa due megabyte.
 *
 * Qui si separano le due domande:
 *   `points`  quanto e' stato scambiato FRA due snapshot, valutato al gamma
 *             corrente: e' il flusso, ed e' quello che ha senso disporre su
 *             un asse dei tempi. Vale zero quando nessuno ha scambiato, e in
 *             quel caso il punto non si manda proprio.
 *   `profile` il totale di giornata per strike, che e' semplicemente
 *             l'ultimo cumulato: e' quello che serve per i muri e le barre.
 *
 * Si differenziano i CONTRATTI, non il GEX: il gamma si muove a ogni
 * snapshot con lo spot e la volatilita', quindi differenziare il GEX
 * spaccerebbe per flusso anche la semplice rivalutazione di posizioni ferme.
 */
function elaboraSnapshot(
    snapshots: Snapshot[],
    dateStr: string,
    base: Map<number, Netti> | null,
    conStorico: boolean,
): {
    points: GexPoint[];
    profile: ProfileRow[];
    spot: SpotPoint[];
    profileHistory: ProfileSnapshot[];
    strikes: number[];
    serie: SerieFrame[];
} {
    const points: GexPoint[] = [];
    const precedenti = new Map<number, Netti>(base ?? []);
    const profilo = new Map<number, ProfileRow>();
    const spotSerie: SpotPoint[] = [];
    let ultimoSpotSec = -Infinity;
    let ultimoValido: SpotPoint | null = null;

    // Il profilo di N minuti fa non si ricostruisce dai `points`: quelli sono
    // differenze di contratti, mentre il profilo e' l'ultimo cumulato valutato
    // al gamma di quel momento. Si tiene invece una copia mentre si cammina,
    // ma solo sulla coda utile: dieci minuti a uno snapshot ogni dieci secondi
    // sono una sessantina di copie, non le migliaia di tutta la giornata.
    const ultimoSec = snapshots.length > 0 ? toSeconds(snapshots[snapshots.length - 1].time) : 0;
    // Un minuto di margine oltre il piu' lontano dei traguardi. Senza, la coda
    // cominciava esattamente sul traguardo dei 10 minuti e lo snapshot "non
    // oltre 10 minuti fa" -- che sta qualche secondo PRIMA di quel punto,
    // visto che ne arriva uno ogni dieci secondi -- restava fuori: la voce dei
    // 10 minuti non veniva quasi mai fuori, e i pallini erano due invece di tre.
    const inizioCoda = ultimoSec - Math.max(...MINUTI_STORICO) * 60 - 60;
    const coda: { sec: number; time: string; rows: ProfileRow[] }[] = [];

    // La serie storica del profilo: una fotografia ogni SERIE_STEP_SEC, per
    // tutta la sessione. E' quella che permette di vedere un muro costruirsi
    // invece che trovarselo gia' fatto.
    const fotografie: { time: string; mappa: Map<number, ProfileRow> }[] = [];
    let ultimaSerieSec = -Infinity;

    for (const snap of snapshots) {
        const orario = snap.time;
        // undPrice e' il sottostante secondo IBKR, quello su cui il gamma e'
        // stato effettivamente valutato: piu' corretto di spxPrice, che prima
        // dell'apertura del cash non esiste.
        const spot = snap.undPrice ?? snap.spxPrice ?? null;
        if (!spot || !Number.isFinite(spot) || !Array.isArray(snap.volumes)) continue;

        const snapSec = toSeconds(snap.time);
        if (snapSec - ultimoSpotSec >= SPOT_STEP_SEC) {
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

            const prec = precedenti.get(row.strike);
            precedenti.set(row.strike, { vol, oi });
            // Primo snapshot che vede questo strike: non c'e' un "prima" da
            // cui misurare il flusso. Il cumulato entra comunque nel profilo.
            if (!prec) continue;

            const dVol = vol - prec.vol;
            const dOi = oi - prec.oi;
            if (dVol === 0 && dOi === 0) continue;

            points.push({
                time: orario,
                strike: row.strike,
                gex: strikeGex(row.gamma, dVol, spot),
                gexOi: strikeGex(row.gamma, dOi, spot),
            });
        }

        if (conStorico && snapSec >= inizioCoda) {
            coda.push({ sec: snapSec, time: orario, rows: [...profilo.values()] });
        }
        if (conStorico && snapSec - ultimaSerieSec >= SERIE_STEP_SEC) {
            fotografie.push({ time: orario, mappa: new Map(profilo) });
            ultimaSerieSec = snapSec;
        }
        ultimoValido = { time: orario, price: spot };
    }

    // L'ultimo prezzo non deve aspettare il prossimo passo di campionamento:
    // e' quello che la pagina disegna come spot corrente.
    if (ultimoValido && spotSerie[spotSerie.length - 1]?.time !== ultimoValido.time) {
        spotSerie.push(ultimoValido);
    }

    const profileHistory: ProfileSnapshot[] = [];
    for (const minuti of MINUTI_STORICO) {
        const limite = ultimoSec - minuti * 60;
        // Il piu' recente non oltre il limite: se la sessione e' appena
        // cominciata non c'e', e quel pallino semplicemente non si disegna.
        let scelto: { sec: number; time: string; rows: ProfileRow[] } | null = null;
        for (const c of coda) {
            if (c.sec <= limite && (!scelto || c.sec > scelto.sec)) scelto = c;
        }
        if (scelto) {
            profileHistory.push({
                minutesAgo: minuti,
                time: scelto.time,
                rows: scelto.rows.sort((a, b) => a.strike - b.strike),
            });
        }
    }

    const profiloFinale = [...profilo.values()].sort((a, b) => a.strike - b.strike);
    const strikes = profiloFinale.map((r) => r.strike);

    // L'ultima fotografia deve essere lo stato di adesso, non quella di due
    // minuti fa: e' il bordo destro del grafico.
    if (conStorico && ultimoValido && fotografie[fotografie.length - 1]?.time !== ultimoValido.time) {
        fotografie.push({ time: ultimoValido.time, mappa: new Map(profilo) });
    }

    // Gli strike si fissano solo qui: uno comparso a meta' sessione manca
    // dalle fotografie precedenti, e li' vale zero.
    // Arrotondati al milione: la serie e' fatta per essere colorata, non
    // letta cifra per cifra, e i due decimali costavano un terzo del peso.
    const serie: SerieFrame[] = fotografie.map((f) => ({
        time: f.time,
        gex: strikes.map((s) => Math.round(f.mappa.get(s)?.gex ?? 0)),
        gexOi: strikes.map((s) => Math.round(f.mappa.get(s)?.gexOi ?? 0)),
    }));

    return {
        points,
        profile: profiloFinale,
        spot: spotSerie,
        profileHistory,
        strikes,
        serie,
    };
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
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {
            console.error('GEX local read failed:', e);
        }
    }
    return null;
}

/**
 * L'ultimo snapshot non oltre `since`, che fa da base per il primo delta di
 * una richiesta incrementale. Una riga sola, quindi non paga la pena di
 * paginare.
 */
async function leggiSnapshotPrecedente(dateStr: string, since: string): Promise<Snapshot | null> {
    if (supabase) {
        const { data, error } = await supabase
            .from('volumes_snapshots')
            .select('time, spx_price, und_price, volumes')
            .eq('date', dateStr)
            .lte('time', since)
            .order('time', { ascending: false })
            .limit(1);
        if (!error && data && data.length > 0) {
            return {
                time: data[0].time,
                spxPrice: data[0].spx_price,
                undPrice: data[0].und_price,
                volumes: data[0].volumes as StrikeRow[],
            };
        }
        if (error) console.error('GEX base snapshot error:', error.message);
    }
    const local = readLocalSnapshots(dateStr);
    if (!local) return null;
    const prima = local.filter((s) => s.time <= since);
    return prima.length > 0 ? prima[prima.length - 1] : null;
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        // Solo la giornata corrente: le sessioni passate restano nel database
        // ma non si servono, e non c'e' un parametro per chiederle.
        const targetDate = getTodayKey();
        const sinceParam = searchParams.get('since');
        // Ogni snapshot vale ~37 punti: senza `since` la pagina riscaricherebbe
        // l'intera giornata a ogni giro.
        const since = sinceParam && /^\d{2}:\d{2}:\d{2}$/.test(sinceParam) ? sinceParam : null;
        // `flow=0` per chi vuole solo il profilo per strike: le bolle del
        // flusso sono il 95% della risposta (mezzo megabyte a fine sessione)
        // e /spx-gamma non le disegna.
        const conFlusso = searchParams.get('flow') !== '0';

        let snapshots: Snapshot[] | null = null;

        if (supabase) {
            // PostgREST tronca a 1000 righe (`db-max-rows`) senza dire niente.
            // Il poller scrive uno snapshot ogni 10 secondi, quindi il tetto
            // arriva dopo meno di tre ore di sessione: da li' in poi il primo
            // caricamento della pagina restava fermo a meta' pomeriggio,
            // mentre gli aggiornamenti con `since` -- poche righe per volta --
            // continuavano ad arrivare. Il risultato era un grafico che
            // sembrava vivo ma con un buco in mezzo.
            const PAGE = 1000;
            const MAX = 10000; // ~28h a 10 secondi, con margine
            const righe: { time: string; spx_price: number | null; und_price: number | null; volumes: unknown }[] = [];
            let erroreDb = false;

            for (let from = 0; from < MAX; from += PAGE) {
                let query = supabase
                    .from('volumes_snapshots')
                    .select('time, spx_price, und_price, volumes')
                    .eq('date', targetDate)
                    .order('time', { ascending: true })
                    .range(from, from + PAGE - 1);
                if (since) query = query.gt('time', since);
                const { data, error } = await query;

                if (error) {
                    console.error('GEX Supabase error:', error.message);
                    erroreDb = true;
                    break;
                }
                if (!data || data.length === 0) break;
                righe.push(...data);
                if (data.length < PAGE) break;
            }

            if (!erroreDb) {
                snapshots = righe.map((r) => ({
                    time: r.time,
                    spxPrice: r.spx_price,
                    undPrice: r.und_price,
                    volumes: r.volumes as StrikeRow[],
                }));
            }
        }

        if (!snapshots || snapshots.length === 0) {
            const local = readLocalSnapshots(targetDate) ?? [];
            snapshots = since ? local.filter((s) => s.time > since) : local;
        }

        // Il flusso e' una differenza, quindi il primo snapshot dopo `since`
        // ha bisogno di quello prima di `since` per essere misurato: senza,
        // ogni giro da 30 secondi perderebbe un pezzo di scambiato.
        let base: Map<number, Netti> | null = null;
        if (since && snapshots.length > 0) {
            const precedente = await leggiSnapshotPrecedente(targetDate, since);
            if (precedente) {
                base = new Map();
                for (const row of precedente.volumes ?? []) {
                    base.set(row.strike, {
                        vol: (row.calls ?? 0) - (row.puts ?? 0),
                        oi: (row.callsOi ?? 0) - (row.putsOi ?? 0),
                    });
                }
            }
        }

        // Lo storico serve solo al primo caricamento, per non far aspettare
        // dieci minuti i pallini: dopo, il client ha gia' i profili che ha
        // ricevuto e se li tiene da solo. Con `since` la finestra e' larga
        // pochi secondi e non conterrebbe comunque niente.
        const { points, profile, spot, profileHistory, strikes, serie } = elaboraSnapshot(snapshots, targetDate, base, !since);
        // `lastTime` e' l'ora di Roma dell'ultimo snapshot: il client la
        // rimanda come `since`. I punti invece portano l'ora di New York,
        // che e' quella su cui ragiona la pagina.
        const lastTime = snapshots.length > 0 ? snapshots[snapshots.length - 1].time : null;

        // Con `since` una risposta vuota e' normale: vuol dire solo che non
        // sono arrivati snapshot nuovi. Il 503 vale solo al primo caricamento.
        // Si guarda il profilo, non i punti: a mercato fermo puo' non essere
        // passato un solo contratto, ma le posizioni ci sono lo stesso.
        if (!since && profile.length === 0) {
            // Nessun gamma disponibile: il poller dei volumi gira solo nella
            // finestra 13:30-22:00, e prima di allora non c'e' niente da
            // calcolare. Meglio dirlo che restituire numeri inventati.
            return NextResponse.json(
                {
                    error: 'Nessun dato di gamma disponibile per ' + targetDate +
                        '. Il poller dei volumi raccoglie fra le 13:30 e le 22:00.',
                },
                { status: 503 },
            );
        }

        // Il primo caricamento non manda tutto il flusso della giornata: a
        // fine sessione sono decine di migliaia di bolle e qualche megabyte,
        // per un grafico che a quella densita' e' comunque una macchia. Si
        // manda l'ultimo tratto -- circa un'ora e mezza -- e il resto della
        // giornata resta comunque rappresentato, perche' `profile` e'
        // cumulato dall'apertura e non dipende da questo taglio.
        const MAX_PUNTI = 8000;
        const tagliati = conFlusso && points.length > MAX_PUNTI;
        const finali = conFlusso ? (tagliati ? points.slice(-MAX_PUNTI) : points) : [];

        // `profile` sostituisce quello che il client ha, non ci si somma: e'
        // gia' il totale di giornata. `points` invece si accoda.
        return NextResponse.json(
            { date: targetDate, since, lastTime, points: finali, profile, spot, profileHistory, strikes, serie, troncato: tagliati },
            { status: 200 },
        );
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unexpected error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
