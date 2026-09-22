/**
 * Segnale AI su ES — riassunto dei dati delle altre pagine.
 *
 * Il modello non riceve le risposte grezze delle route (sarebbero centinaia di KB,
 * e ogni KB costa sia token sia egress Supabase): riceve un riassunto di poche
 * centinaia di numeri, campionato a 1 minuto, con i livelli già calcolati.
 */

export type Bias = 'LONG' | 'SHORT' | 'NEUTRALE';

export interface Segnale {
    bias: Bias;
    confidenza: number;
    orizzonte: string;
    sintesi: string;
    motivi: { fonte: string; osservazione: string; direzione: Bias }[];
    livelli: { riferimento: number | null; invalidazione: number | null; obiettivo: number | null };
    rischi: string[];
}

// Lo schema per gli structured output: il modello non può rispondere in altro formato.
const numeroONull = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const bias = { type: 'string', enum: ['LONG', 'SHORT', 'NEUTRALE'] };
export const SCHEMA_SEGNALE = {
    type: 'object',
    additionalProperties: false,
    required: ['bias', 'confidenza', 'orizzonte', 'sintesi', 'motivi', 'livelli', 'rischi'],
    properties: {
        bias,
        confidenza: { type: 'integer', description: '0-100' },
        orizzonte: { type: 'string' },
        sintesi: { type: 'string' },
        motivi: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['fonte', 'osservazione', 'direzione'],
                properties: { fonte: { type: 'string' }, osservazione: { type: 'string' }, direzione: bias },
            },
        },
        livelli: {
            type: 'object',
            additionalProperties: false,
            required: ['riferimento', 'invalidazione', 'obiettivo'],
            properties: { riferimento: numeroONull, invalidazione: numeroONull, obiettivo: numeroONull },
        },
        rischi: { type: 'array', items: { type: 'string' } },
    },
};

/** HH:MM:SS a Roma, `minuti` fa: è il fuso in cui i poller scrivono `time`. */
export function oraRoma(minutiFa = 0): string {
    const d = new Date(Date.now() - minutiFa * 60_000);
    return d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour12: false });
}

const r = (x: unknown, dec = 2) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(dec)) : null);

/** Un punto per minuto (l'ultimo di ciascun minuto), solo gli ultimi `minuti`. */
function perMinuto<T extends { time: string }>(serie: T[], minuti: number): T[] {
    const soglia = oraRoma(minuti);
    const perChiave = new Map<string, T>();
    for (const p of serie) if (p.time > soglia) perChiave.set(p.time.slice(0, 5), p);
    return [...perChiave.values()];
}

type Riga = Record<string, unknown> & { time: string };
type ProfiloRiga = { strike: number; gex: number; gexOi: number };

function livelliGamma(profilo: ProfiloRiga[], campo: 'gex' | 'gexOi') {
    const ordinato = [...profilo].sort((a, b) => a.strike - b.strike);
    // Zero Gamma: dove la somma cumulativa per strike cambia segno.
    let cum = 0;
    let zero: number | null = null;
    for (const p of ordinato) {
        const prima = cum;
        cum += p[campo];
        if (prima !== 0 && Math.sign(prima) !== Math.sign(cum)) zero = p.strike;
    }
    const perValore = [...ordinato].sort((a, b) => b[campo] - a[campo]);
    return {
        zeroGamma: zero,
        totale: r(cum, 0),
        maggioriPositivi: perValore.slice(0, 3).filter((p) => p[campo] > 0).map((p) => ({ strike: p.strike, valore: r(p[campo], 0) })),
        maggioriNegativi: perValore.slice(-3).reverse().filter((p) => p[campo] < 0).map((p) => ({ strike: p.strike, valore: r(p[campo], 0) })),
    };
}

export function riassumi(fonti: {
    market: { latest: Riga | null; history: Riga[] };
    gex: { profile?: ProfiloRiga[]; spot?: { time: string; price: number }[]; profileHistory?: { minutesAgo: number; rows: ProfiloRiga[] }[] } | null;
    iv: { snapshots?: Riga[] } | null;
    tide: { points?: Riga[] } | null;
    hedging: Record<string, unknown> | null;
}) {
    const { market, gex, iv, tide, hedging } = fonti;
    const storia = market.history;
    const es = storia.map((p) => p.esf).filter((x): x is number => typeof x === 'number');

    const spot = gex?.spot?.at(-1)?.price ?? null;
    const vicino = (s: number) => spot === null || Math.abs(s - spot) <= 60;
    const profilo = gex?.profile ?? [];
    const dieciMinFa = gex?.profileHistory?.find((h) => h.minutesAgo === 10)?.rows;

    return {
        oraRoma: oraRoma(),
        es: {
            ultimo: market.latest,
            sessione: es.length
                ? { primo: es[0], massimo: Math.max(...es), minimo: Math.min(...es), primoOrario: storia[0]?.time }
                : null,
            ultimi60minPerMinuto: perMinuto(storia, 60).map((p) => ({
                t: p.time.slice(0, 5), es: r(p.esf), vix: r(p.vix), spx: r(p.spx), vwap: r(p.vwap), esIvAtm: r(p.esAtmIv),
            })),
        },
        gammaSpx: gex
            ? {
                  nota: 'Valori in $M. gex = pesato sul volume del giorno (flusso), gexOi = pesato su open interest (posizionamento). Segno: call +, put − (euristica dealer long call / short put).',
                  spotSpx: spot,
                  flusso: livelliGamma(profilo, 'gex'),
                  posizionamento: livelliGamma(profilo, 'gexOi'),
                  profiloVicinoSpot: profilo.filter((p) => vicino(p.strike)).map((p) => ({ k: p.strike, gex: r(p.gex, 0), gexOi: r(p.gexOi, 0) })),
                  totaleFlusso10minFa: dieciMinFa ? r(dieciMinFa.reduce((s, p) => s + p.gex, 0), 0) : null,
              }
            : null,
        ivSpx0dte: iv?.snapshots?.length
            ? {
                  nota: 'IV pesata near-ATM delle put e delle call 0DTE SPX (decimale). Put IV che sale più delle call = domanda di protezione.',
                  ultimi15minPerMinuto: perMinuto(iv.snapshots, 15).map((s) => ({
                      t: s.time.slice(0, 5), spx: r(s.esPrice), putIv: r(s.weightedPutIV, 4), callIv: r(s.weightedCallIV, 4),
                  })),
              }
            : null,
        marketTide: tide?.points?.length
            ? {
                  nota: 'Catena SPX 0DTE: ncp = premio netto call, npp = premio netto put ($), netVol = volume netto. ncp in salita e npp in discesa = flusso rialzista.',
                  ultimi30minPerMinuto: perMinuto(tide.points, 30).map((p) => ({ t: p.time.slice(0, 5), spx: r(p.spx), ncp: p.ncp, npp: p.npp, netVol: p.netVol })),
              }
            : null,
        pressioneMarketMaker: hedging
            ? {
                  spot: hedging.spot,
                  atmIv: hedging.atmIv,
                  ivChange: hedging.ivChange,
                  zoneDiRischio: ((hedging.riskZones as { strike: number; riskLevel: string; pressure: number }[]) ?? [])
                      .filter((z) => z.riskLevel !== 'low')
                      .sort((a, b) => Math.abs(b.pressure) - Math.abs(a.pressure))
                      .slice(0, 6)
                      .map((z) => ({ strike: z.strike, livello: z.riskLevel, pressione: r(z.pressure, 0) })),
              }
            : null,
    };
}

export const SYSTEM_PROMPT = `Sei un analista di microstruttura del mercato USA. Ricevi un riassunto in JSON dei dati live di una dashboard personale: ES (future S&P 500) e VIX, profilo di gamma exposure delle opzioni SPX 0DTE, IV near-ATM di put e call 0DTE, flusso netto di premio sulla catena 0DTE (market tide) e zone di pressione di hedging dei market maker.

Il tuo compito: dare un bias direzionale su ES per i prossimi 15-60 minuti — LONG, SHORT o NEUTRALE — con una confidenza 0-100 e i motivi, citando per ciascuno la fonte e il numero che lo sostiene.

Regole:
- È un esercizio di studio. Sii onesto sull'incertezza: se i segnali sono contrastanti o scarsi, rispondi NEUTRALE con confidenza bassa. Una confidenza sopra 70 richiede più fonti indipendenti concordi.
- Una sezione a null significa che quella fonte non ha dati ora (es. poller fermo o fuori orario): dillo nei rischi e non inventare.
- SPX e ES differiscono per la base (ES di solito sopra SPX di qualche punto/decina di punti): converti i livelli SPX in livelli ES usando la differenza attuale tra i due, e dai i livelli in punti ES.
- livelli.riferimento = prezzo ES attuale; invalidazione = livello ES che smentirebbe il bias; obiettivo = livello ES plausibile. Con bias NEUTRALE puoi lasciarli a null.
- Scrivi in italiano, conciso.`;
