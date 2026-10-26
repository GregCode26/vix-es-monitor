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
 * Solo locale e solo oggi, come /api/verticali.
 */

interface RigaQuote {
    strike: number;
    cAsk?: number | null;
    pAsk?: number | null;
    cIv?: number | null;
    pIv?: number | null;
    gamma?: number | null;
    cb?: number;
    cs?: number;
    pb?: number;
    ps?: number;
}

interface Lettura {
    t?: string;
    tEt: string;
    spot: number;
    ivAtm: number;
    em: number;
    tilt: number | null;
    curv: number | null;
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
    /** Gamma netta dei taker in $M per 1%: > 0 taker lunghi di convessita', < 0 corti. */
    conv: number | null;
}

export type Regime = 'PIATTA + VOL ALTA' | 'PIATTA + VOL BASSA' | 'RIALZISTA' | 'RIBASSISTA' | 'RANGE A C' | 'PIATTA' | 'NEUTRO';

const SOGLIA = 1.0;
const MIN_SD = { tilt: 0.3, curv: 0.2, ivAtm: 0.5 };
const FASCIA_SEC = 15 * 60;
const GIORNI_STORICO = 30;
const CONTRACT_SIZE = 100;
/** Letture di oggi su cui ricostruire la conferma del regime. */
const LETTURE_REGIME = 60;

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
        if (!cacheGiorni.has(giorno)) cacheGiorni.set(giorno, senzaRipetute(leggiNdjson(path.join(dir, f))));
        return cacheGiorni.get(giorno)!.map((l) => ({ giorno, l }));
    });
}

type Misura = 'tilt' | 'curv' | 'ivAtm';
type Base = 'storico' | 'provvisoria' | 'in raccolta';

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
 * oggi dell'ultima ora (almeno 10), altrimenti niente.
 */
function zScore(l: Lettura, passato: { giorno: string; l: Lettura }[], oggi: Lettura[]) {
    const t = secondi(l.tEt);
    const vicini = passato.filter((p) => Math.abs(secondi(p.l.tEt) - t) <= FASCIA_SEC);
    let base: Base = 'in raccolta';
    let campione: Lettura[] = [];
    if (new Set(vicini.map((p) => p.giorno)).size >= 3 && vicini.length >= 15) {
        base = 'storico';
        campione = vicini.map((p) => p.l);
    } else {
        const ora = oggi.filter((o) => secondi(o.tEt) <= t && secondi(o.tEt) > t - 3600);
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
            tilt: z(l.tilt, di('tilt'), MIN_SD.tilt),
            curv: z(l.curv, di('curv'), MIN_SD.curv),
            ivAtm: z(l.ivAtm, di('ivAtm'), MIN_SD.ivAtm),
        },
    };
}

/** Sezione 8: le regole in ordine, vince la prima vera. */
function regime(zs: { tilt: number | null; curv: number | null; ivAtm: number | null }): Regime {
    const { tilt, curv, ivAtm } = zs;
    if (curv != null && curv <= -SOGLIA && ivAtm != null && ivAtm >= SOGLIA) return 'PIATTA + VOL ALTA';
    if (curv != null && curv <= -SOGLIA && ivAtm != null && ivAtm <= -SOGLIA / 2) return 'PIATTA + VOL BASSA';
    if (tilt != null && tilt >= SOGLIA) return 'RIALZISTA';
    if (tilt != null && tilt <= -SOGLIA) return 'RIBASSISTA';
    if (curv != null && curv >= SOGLIA) return 'RANGE A C';
    if (curv != null && curv <= -SOGLIA) return 'PIATTA';
    return 'NEUTRO';
}

/** Gamma netta dei taker su uno strike, in $M per 1% (stesse unita' di /api/gex). */
function convessita(r: RigaQuote, spot: number): number | null {
    if (r.gamma == null || r.cb == null || r.cs == null || r.pb == null || r.ps == null) return null;
    const netti = (r.cb - r.cs) + (r.pb - r.ps);
    return Math.round((r.gamma * netti * CONTRACT_SIZE * spot * spot * 0.01) / 1e6 * 100) / 100;
}

const valida = (iv: number | null | undefined, ask: number | null | undefined) =>
    iv != null && iv > 0 && iv <= 5 && ask != null && ask > 0 ? Math.round(iv * 10000) / 100 : null;

export async function GET() {
    const date = getTodayKey();
    if (process.env.VERCEL) {
        return NextResponse.json({ date, local: false });
    }
    const dati = cartellaDati();
    let q: FileQuote;
    try {
        q = JSON.parse(fs.readFileSync(path.join(dati, 'catena', 'quote.json'), 'utf-8'));
    } catch {
        return NextResponse.json({ error: 'Nessuna catena: il poller dei volumi non ha ancora scritto' }, { status: 503 });
    }
    if (q.date !== date) {
        return NextResponse.json({ error: `Ultima catena del ${q.date}: oggi il poller non ha ancora scritto` }, { status: 503 });
    }
    const l = q.smile;
    if (!l || q.spot == null) {
        return NextResponse.json({ error: 'Smile non calcolabile: mancano lo spot o le IV vicino all\'ATM' }, { status: 503 });
    }
    const spot = q.spot;

    const punti: PuntoSmile[] = q.strikes
        .filter((r) => Math.abs(r.strike - spot) <= l.range)
        .map((r) => {
            const callIv = valida(r.cIv, r.cAsk);
            const putIv = valida(r.pIv, r.pAsk);
            const ivOtm = r.strike < spot ? putIv ?? callIv : callIv ?? putIv;
            return { strike: r.strike, callIv, putIv, ivOtm, conv: convessita(r, spot) };
        });

    // Z-score e regime: la conferma vuole 2 letture nuove consecutive con lo
    // stesso esito, quindi si ricostruisce sulle ultime letture di oggi.
    const dirSmile = path.join(dati, 'smile');
    const passato = storico(dirSmile, date);
    const letture = leggiNdjson(path.join(dirSmile, `${date}.ndjson`));
    const oggi = senzaRipetute(letture);
    // La storia del vertice IV MIN per la linea viola: solo i cambi di strike
    // (~60 in una sessione), con l'ora italiana delle etichette del grafico.
    const storiaVertice: [string, number][] = [];
    for (const o of letture) {
        const strike = o.vertice?.strike;
        if (o.t && strike != null && strike !== storiaVertice[storiaVertice.length - 1]?.[1]) storiaVertice.push([o.t, strike]);
    }
    let confermato: Regime | null = null;
    let precedente: Regime | null = null;
    let ultimo: ReturnType<typeof zScore> | null = null;
    let grezzo: Regime | null = null;
    for (const o of oggi.slice(-LETTURE_REGIME)) {
        const zs = zScore(o, passato, oggi);
        ultimo = zs;
        grezzo = zs.z ? regime(zs.z) : null;
        if (grezzo && grezzo === precedente && grezzo !== confermato) confermato = grezzo;
        precedente = grezzo;
    }
    if (!ultimo) ultimo = zScore(l, passato, oggi);

    const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
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
            put25: r2(l.put25),
            call25: r2(l.call25),
            vertice: l.vertice,
            base: ultimo.base,
            z: ultimo.z && { tilt: r2(ultimo.z.tilt), curv: r2(ultimo.z.curv), ivAtm: r2(ultimo.z.ivAtm) },
            // In raccolta non c'e' regime; senza due letture uguali di fila, nemmeno.
            regime: ultimo.base === 'in raccolta' ? null : confermato,
            regimeGrezzo: grezzo,
            storiaVertice,
        },
        punti,
    });
}
