import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Smile di volatilita' dello SPX 0DTE con il convexity ladder, per la curva a
 * destra del grafico di /market (formule di Optix Smile).
 *
 * Le letture (sezioni 1-6: IV ATM, expected move, IV a 25 delta, Tilt, Curv,
 * vertice) le fa `execution/smile.py` dentro il poller dei volumi: l'ultima
 * sta in `frontend/data/catena/quote.json` insieme alle righe per strike, e
 * ognuna si accoda a `frontend/data/smile/YYYY-MM-DD.ndjson`. Qui si fanno
 * le sezioni 7-8 (z-score e regime), che hanno bisogno di quello storico, e il
 * convexity ladder per le frecce: la gamma netta dei taker per strike, cioe'
 * il `gexLr` di /api/gex con il segno opposto (lui e' il lato dei dealer).
 *
 * Dalla versione 2 delle letture (27/10/2026, vedi smile.py) il regime lavora
 * su Tilt e Curv in % dell'IV ATM, con isteresi (si entra a |z| >= 1, si esce
 * sotto 0,5) e una conferma a maggioranza su CONFERMA_SEC, non su 2 letture di fila
 * (erano 20 s, e 40 cambi di regime in 80 minuti). Le letture della versione
 * 1 restano nei file ma non entrano negli z-score: hanno un'altra IV.
 * Dalle 15:15 ET il regime si sospende: a pochi minuti dalla scadenza l'IV
 * 0DTE e' fatta di prezzi da pochi tick (il 26/10 l'IV ATM e' risalita da 11
 * a 16 e il Tilt e' andato sotto zero).
 *
 * Solo locale e solo oggi, come /api/verticali.
 */

interface RigaQuote {
    strike: number;
    cAsk?: number | null;
    pAsk?: number | null;
    cIv?: number | null;
    pIv?: number | null;
    /** Le IV in % usate dalla lettura (smile.py v2): dal mid, o il ripiego sui modelGreeks. */
    cIvS?: number | null;
    pIvS?: number | null;
    gamma?: number | null;
    cb?: number;
    cs?: number;
    pb?: number;
    ps?: number;
}

interface Lettura {
    v?: number;
    t?: string;
    tEt: string;
    spot: number;
    ivAtm: number;
    em: number;
    tilt: number | null;
    curv: number | null;
    tiltN?: number | null;
    curvN?: number | null;
    est25?: boolean;
    ivProprie?: number;
    put25: number | null;
    call25: number | null;
    vertice: { strike: number; iv: number; sigma: number | null } | null;
    range: number;
}

interface FileQuote {
    date: string;
    time: string;
    spot: number | null;
    expiry: string;
    smile: Lettura | null;
    strikes: RigaQuote[];
}

export interface PuntoSmile {
    strike: number;
    /** IV in %, null se scartata (iv <= 0, iv > 500% o ask <= 0). */
    callIv: number | null;
    putIv: number | null;
    /** La linea della curva: put sotto lo spot, call da lo spot in su. */
    ivOtm: number | null;
    /** IV OTM in media mobile a 3 strike: la linea della curva, i pallini restano sui valori veri. */
    ivLiscia: number | null;
    /** Gamma netta dei taker in $M per 1%: > 0 taker lunghi di convessita', < 0 corti. */
    conv: number | null;
}

export type Regime = 'PIATTA + VOL ALTA' | 'PIATTA + VOL BASSA' | 'RIALZISTA' | 'RIBASSISTA' | 'RANGE A C' | 'PIATTA' | 'NEUTRO';

const SOGLIA = 1.0;
/** Sotto questa soglia un regime gia' confermato si lascia. */
const SOGLIA_USCITA = 0.5;
/**
 * Conferma: un regime diventa quello confermato quando e' il grezzo in almeno
 * QUOTA_CONFERMA delle letture degli ultimi CONFERMA_SEC. Non "90 s di fila":
 * con il rumore delle IV il grezzo salta una lettura ogni tanto, e cosi' non si
 * confermava mai niente.
 */
const CONFERMA_SEC = 90;
const QUOTA_CONFERMA = 0.7;
/** Da quest'ora ET il regime si sospende. */
const FINE_REGIME_ET = '15:15:00';
const VERSIONE = 2;
/**
 * Minimi della dev. std. Tilt e Curv sono in % dell'IV ATM: 0,3 e 0,2 punti
 * di vol dell'originale su un'IV ATM di 15-20.
 */
const MIN_SD = { tiltN: 1.5, curvN: 1.0, ivAtm: 0.5 };
const FASCIA_SEC = 15 * 60;
const GIORNI_STORICO = 30;
const CONTRACT_SIZE = 100;
/** Letture di oggi su cui ricostruire isteresi e conferma del regime (30 min a una ogni 10 s). */
const LETTURE_REGIME = 180;

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Next puo' partire dalla radice del repo o da frontend/: i dati stanno comunque in frontend/data. */
function cartellaDati() {
    const cwd = process.cwd();
    return fs.existsSync(path.join(cwd, 'frontend', 'package.json'))
        ? path.join(cwd, 'frontend', 'data')
        : path.join(cwd, 'data');
}

const secondi = (t: string) => {
    const [h, m, s] = t.split(':').map(Number);
    return h * 3600 + m * 60 + (s || 0);
};

function leggiNdjson(file: string): Lettura[] {
    try {
        return fs.readFileSync(file, 'utf-8').split('\n').flatMap((riga) => {
            if (!riga.trim()) return [];
            try {
                return [JSON.parse(riga) as Lettura];
            } catch {
                return []; // riga a meta' mentre il poller scrive
            }
        });
    } catch {
        return [];
    }
}

/** Una lettura ripetuta identica (mercato fermo) non e' una lettura nuova. */
function senzaRipetute(letture: Lettura[]): Lettura[] {
    return letture.filter((l, i) => {
        const p = letture[i - 1];
        return !p || p.spot !== l.spot || p.ivAtm !== l.ivAtm || p.tilt !== l.tilt || p.curv !== l.curv;
    });
}

const versione2 = (l: Lettura) => (l.v ?? 1) >= VERSIONE;

// I giorni passati non cambiano piu': si leggono una volta.
const cacheGiorni = new Map<string, Lettura[]>();

/** Letture dei giorni passati (fino a 30), ognuna con il giorno da cui viene. */
function storico(dir: string, oggi: string): { giorno: string; l: Lettura }[] {
    let file: string[];
    try {
        file = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(0, 10) < oggi);
    } catch {
        return [];
    }
    return file.sort().slice(-GIORNI_STORICO).flatMap((f) => {
        const giorno = f.slice(0, 10);
        if (!cacheGiorni.has(giorno)) cacheGiorni.set(giorno, senzaRipetute(leggiNdjson(path.join(dir, f)).filter(versione2)));
        return cacheGiorni.get(giorno)!.map((l) => ({ giorno, l }));
    });
}

type Misura = 'tiltN' | 'curvN' | 'ivAtm';
type Base = 'storico' | 'provvisoria' | 'in raccolta';
type Z = { tilt: number | null; curv: number | null; ivAtm: number | null };

/** z = (x - media) / max(dev. std. di popolazione, minSd). */
function z(x: number | null, valori: number[], minSd: number): number | null {
    if (x == null || valori.length === 0) return null;
    const media = valori.reduce((a, b) => a + b, 0) / valori.length;
    const sd = Math.sqrt(valori.reduce((a, b) => a + (b - media) ** 2, 0) / valori.length);
    return (x - media) / Math.max(sd, minSd);
}

/**
 * Sezione 7. La base di confronto di una lettura: i giorni passati alla stessa
 * ora ET +-15 min (almeno 3 giorni e 15 letture), altrimenti le letture di
 * oggi dell'ultima ora prima di questa (almeno 10), altrimenti niente. La
 * lettura stessa non entra nella sua base: smorzerebbe il proprio z.
 */
function zScore(l: Lettura, passato: { giorno: string; l: Lettura }[], oggi: Lettura[]): { base: Base; z: Z | null } {
    const t = secondi(l.tEt);
    const vicini = passato.filter((p) => Math.abs(secondi(p.l.tEt) - t) <= FASCIA_SEC);
    let base: Base = 'in raccolta';
    let campione: Lettura[] = [];
    if (new Set(vicini.map((p) => p.giorno)).size >= 3 && vicini.length >= 15) {
        base = 'storico';
        campione = vicini.map((p) => p.l);
    } else {
        const ora = oggi.filter((o) => secondi(o.tEt) < t && secondi(o.tEt) > t - 3600);
        if (ora.length >= 10) {
            base = 'provvisoria';
            campione = ora;
        }
    }
    if (base === 'in raccolta') return { base, z: null };
    const di = (m: Misura) => campione.map((c) => c[m]).filter((v): v is number => v != null);
    return {
        base,
        z: {
            tilt: z(l.tiltN ?? null, di('tiltN'), MIN_SD.tiltN),
            curv: z(l.curvN ?? null, di('curvN'), MIN_SD.curvN),
            ivAtm: z(l.ivAtm, di('ivAtm'), MIN_SD.ivAtm),
        },
    };
}

/** La condizione di ogni regime a soglia `s`; NEUTRO e' quando nessun'altra vale. */
function vale(r: Regime, { tilt, curv, ivAtm }: Z, s: number): boolean {
    switch (r) {
        case 'PIATTA + VOL ALTA': return curv != null && curv <= -s && ivAtm != null && ivAtm >= s;
        case 'PIATTA + VOL BASSA': return curv != null && curv <= -s && ivAtm != null && ivAtm <= -s / 2;
        case 'RIALZISTA': return tilt != null && tilt >= s;
        case 'RIBASSISTA': return tilt != null && tilt <= -s;
        case 'RANGE A C': return curv != null && curv >= s;
        case 'PIATTA': return curv != null && curv <= -s;
        default: return false;
    }
}

const ORDINE: Regime[] = ['PIATTA + VOL ALTA', 'PIATTA + VOL BASSA', 'RIALZISTA', 'RIBASSISTA', 'RANGE A C', 'PIATTA'];

/**
 * Sezione 8: le regole in ordine, vince la prima vera. Con isteresi: il
 * regime confermato resta finche' la sua condizione vale a SOGLIA_USCITA.
 */
function regime(zs: Z, confermato: Regime | null): Regime {
    if (confermato && confermato !== 'NEUTRO' && vale(confermato, zs, SOGLIA_USCITA)) return confermato;
    return ORDINE.find((r) => vale(r, zs, SOGLIA)) ?? 'NEUTRO';
}

/** Gamma netta dei taker su uno strike, in $M per 1% (stesse unita' di /api/gex). */
function convessita(r: RigaQuote, spot: number): number | null {
    if (r.gamma == null || r.cb == null || r.cs == null || r.pb == null || r.ps == null) return null;
    const netti = (r.cb - r.cs) + (r.pb - r.ps);
    return Math.round((r.gamma * netti * CONTRACT_SIZE * spot * spot * 0.01) / 1e6 * 100) / 100;
}

const valida = (iv: number | null | undefined, ask: number | null | undefined) =>
    iv != null && iv > 0 && iv <= 5 && ask != null && ask > 0 ? Math.round(iv * 10000) / 100 : null;

/**
 * La storia del vertice IV MIN per la linea viola: solo i cambi di strike
 * (~60 in una sessione), con l'ora italiana delle etichette del grafico.
 */
function storiaDelVertice(letture: Lettura[]): [string, number][] {
    const storia: [string, number][] = [];
    for (const o of letture) {
        const strike = o.vertice?.strike;
        if (o.t && strike != null && strike !== storia[storia.length - 1]?.[1]) storia.push([o.t, strike]);
    }
    return storia;
}

/** La traccia IV MIN di un giorno passato, gia' con la basis ES-SPX di quel giorno. */
interface TracciaGiorno {
    date: string;
    /** Mediana di ES - SPX nelle ore delle letture: null se il file di /api/market manca. */
    basis: number | null;
    /** Ora dell'ultima lettura: l'ultimo tratto finisce li'. */
    fine: string;
    storia: [string, number][];
}

const GIORNI_TRACCIA_MAX = 10;
// I giorni passati non cambiano piu': si leggono una volta.
const cacheTracce = new Map<string, TracciaGiorno | null>();

function basisDelGiorno(dati: string, giorno: string, da: string, a: string): number | null {
    let punti: { time?: string; esf?: number | null; spx?: number | null }[];
    try {
        const grezzo = JSON.parse(fs.readFileSync(path.join(dati, 'market', `${giorno}.json`), 'utf-8'));
        punti = Array.isArray(grezzo) ? grezzo : grezzo?.data ?? [];
    } catch {
        return null;
    }
    // Solo nelle ore delle letture: fuori dal cash SPX resta fermo e ES no.
    const diff = punti
        .filter((p) => p.time && p.time >= da && p.time <= a && p.esf != null && p.spx != null)
        .map((p) => (p.esf as number) - (p.spx as number))
        .sort((x, y) => x - y);
    if (diff.length === 0) return null;
    const m = Math.floor(diff.length / 2);
    return diff.length % 2 ? diff[m] : (diff[m - 1] + diff[m]) / 2;
}

/**
 * Le tracce IV MIN degli ultimi `n` giorni prima di oggi, per Quantower: il
 * suo grafico mostra anche i giorni passati, e la linea che segue i cambi del
 * vertice spariva a mezzanotte (29/10/2026).
 */
function tracceGiorni(dati: string, oggi: string, n: number): TracciaGiorno[] {
    const dir = path.join(dati, 'smile');
    let file: string[];
    try {
        file = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(0, 10) < oggi);
    } catch {
        return [];
    }
    return file.sort().slice(-n).flatMap((f) => {
        const giorno = f.slice(0, 10);
        if (!cacheTracce.has(giorno)) {
            const letture = leggiNdjson(path.join(dir, f)).filter((l) => l.t);
            const storia = storiaDelVertice(letture);
            cacheTracce.set(giorno, storia.length === 0 ? null : {
                date: giorno,
                basis: basisDelGiorno(dati, giorno, letture[0].t as string, letture[letture.length - 1].t as string),
                fine: letture[letture.length - 1].t as string,
                storia,
            });
        }
        const t = cacheTracce.get(giorno);
        return t ? [t] : [];
    });
}

export async function GET(request: Request) {
    const date = getTodayKey();
    if (process.env.VERCEL) {
        return NextResponse.json({ date, local: false });
    }
    const dati = cartellaDati();
    // ?giorni=N: solo le tracce IV MIN dei giorni passati, anche prima
    // dell'apertura, quando lo smile di oggi risponde 503.
    const giorni = Number(new URL(request.url).searchParams.get('giorni'));
    if (giorni > 0) {
        return NextResponse.json({ date, local: true, giorni: tracceGiorni(dati, date, Math.min(giorni, GIORNI_TRACCIA_MAX)) });
    }
    let q: FileQuote;
    try {
        q = JSON.parse(fs.readFileSync(path.join(dati, 'catena', 'quote.json'), 'utf-8'));
    } catch {
        return NextResponse.json({ error: 'Nessuna catena: il poller dei volumi non ha ancora scritto' }, { status: 503 });
    }
    if (q.date !== date) {
        return NextResponse.json({ error: `Ultima catena del ${q.date}: oggi il poller non ha ancora scritto` }, { status: 503 });
    }
    const dirSmile = path.join(dati, 'smile');
    const letture = leggiNdjson(path.join(dirSmile, `${date}.ndjson`));
    const storiaVertice = storiaDelVertice(letture);
    const l = q.smile;
    if (!l || q.spot == null) {
        // Dopo la chiusura lo smile non si calcola piu', ma la traccia del
        // vertice IV MIN della giornata resta sul grafico (28/10/2026: alle
        // 21:00 spariva con tutto il resto).
        const fine = letture[letture.length - 1];
        if (!fine || storiaVertice.length === 0) {
            return NextResponse.json({ error: 'Smile non calcolabile: mancano lo spot o le IV vicino all\'ATM' }, { status: 503 });
        }
        return NextResponse.json({
            date,
            local: true,
            time: q.time,
            spot: fine.spot,
            expiry: q.expiry,
            smile: {
                ivAtm: null, em: null, tilt: null, curv: null,
                vertice: fine.vertice ?? null,
                base: 'in raccolta',
                z: null,
                regime: null,
                sospeso: true,
                chiuso: true,
                storiaVertice,
            },
            punti: [],
        });
    }
    const spot = q.spot;
    const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);

    const punti: PuntoSmile[] = q.strikes
        .filter((r) => Math.abs(r.strike - spot) <= l.range)
        .map((r) => {
            // cIvS/pIvS ci sono dalla versione 2 di smile.py; prima, i modelGreeks.
            const callIv = r.cIvS !== undefined ? r2(r.cIvS) : valida(r.cIv, r.cAsk);
            const putIv = r.pIvS !== undefined ? r2(r.pIvS) : valida(r.pIv, r.pAsk);
            const ivOtm = r.strike < spot ? putIv ?? callIv : callIv ?? putIv;
            return { strike: r.strike, callIv, putIv, ivOtm, ivLiscia: null, conv: convessita(r, spot) };
        })
        .sort((a, b) => a.strike - b.strike);
    const conIv = punti.filter((p) => p.ivOtm != null);
    conIv.forEach((p, i) => {
        const vicini = conIv.slice(Math.max(0, i - 1), i + 2).map((v) => v.ivOtm as number);
        p.ivLiscia = r2(vicini.reduce((a, b) => a + b, 0) / vicini.length);
    });

    // Z-score e regime: isteresi e conferma dipendono dalle letture prima,
    // quindi si ricostruiscono sulle ultime letture di oggi.
    const oggi = senzaRipetute(letture.filter(versione2));
    const finestra = oggi.slice(-LETTURE_REGIME);
    // Del passato serve solo la fascia della finestra +-15 min.
    const inizio = finestra.length ? secondi(finestra[0].tEt) - FASCIA_SEC : 0;
    const passato = storico(dirSmile, date).filter((p) => secondi(p.l.tEt) >= inizio);
    // Da quanto l'IV ATM non cambia: se IBKR smette di aggiornare si vede.
    let ivFermaSec = 0;
    const ultima = letture[letture.length - 1];
    if (ultima) {
        const diversa = [...letture].reverse().find((o) => o.ivAtm !== ultima.ivAtm);
        if (diversa) ivFermaSec = secondi(ultima.tEt) - secondi(diversa.tEt);
    }
    let confermato: Regime | null = null;
    let ultimo: ReturnType<typeof zScore> | null = null;
    let grezzo: Regime | null = null;
    const recenti: [number, Regime | null][] = [];
    /**
     * Quando il regime confermato e' cambiato, nella finestra ricostruita qui
     * sopra: [ora italiana 'HH:MM:SS', regime]. /market ci mette i pallini
     * sulla linea del prezzo, e li accumula per conto suo -- questa finestra
     * e' mezz'ora, non la giornata, perche' ricostruire il regime su tutte le
     * letture vorrebbe dire uno z-score per ognuna contro tutto lo storico.
     */
    const cambiRegime: [string, Regime][] = [];
    for (const o of finestra) {
        const zs = zScore(o, passato, oggi);
        ultimo = zs;
        grezzo = zs.z ? regime(zs.z, confermato) : null;
        const t = secondi(o.tEt);
        recenti.push([t, grezzo]);
        while (t - recenti[0][0] > CONFERMA_SEC) recenti.shift();
        // Serve una finestra piena: con le prime letture la maggioranza e' di poche.
        if (t - recenti[0][0] < CONFERMA_SEC - 10) continue;
        const conti = new Map<Regime, number>();
        for (const [, r] of recenti) if (r) conti.set(r, (conti.get(r) ?? 0) + 1);
        for (const [r, n] of conti) {
            if (r !== confermato && n >= QUOTA_CONFERMA * recenti.length) {
                confermato = r;
                // `t` manca nelle letture piu' vecchie: senza ora non c'e' pallino.
                if (o.t) cambiRegime.push([o.t, r]);
            }
        }
    }
    if (!ultimo) ultimo = zScore(l, passato, oggi);
    const sospeso = l.tEt >= FINE_REGIME_ET;

    return NextResponse.json({
        date,
        local: true,
        time: q.time,
        spot,
        expiry: q.expiry,
        smile: {
            ivAtm: r2(l.ivAtm),
            em: r2(l.em),
            tilt: r2(l.tilt),
            curv: r2(l.curv),
            tiltN: r2(l.tiltN),
            curvN: r2(l.curvN),
            est25: l.est25 ?? false,
            ivProprie: l.ivProprie ?? null,
            ivFermaSec,
            versione: l.v ?? 1,
            put25: r2(l.put25),
            call25: r2(l.call25),
            vertice: l.vertice,
            base: ultimo.base,
            z: ultimo.z && { tilt: r2(ultimo.z.tilt), curv: r2(ultimo.z.curv), ivAtm: r2(ultimo.z.ivAtm) },
            // In raccolta non c'e' regime; finche' nessuno ha la maggioranza, nemmeno.
            regime: ultimo.base === 'in raccolta' || sospeso ? null : confermato,
            regimeGrezzo: sospeso ? null : grezzo,
            sospeso,
            cambiRegime,
            storiaVertice,
        },
        punti,
    });
}
