/**
 * Segnale AI su ES — riassunto dei dati delle altre pagine.
 *
 * Il modello non riceve le risposte grezze delle route (sarebbero centinaia di KB,
 * e ogni KB costa sia token sia egress Supabase): riceve un riassunto di poche
 * centinaia di numeri, campionato a 1 minuto, con i livelli già calcolati.
 */

import { oraRomaDaNy } from './orarioNy';

export type Bias = 'LONG' | 'SHORT' | 'NEUTRALE';

export interface Segnale {
    bias: Bias;
    confidenza: number;
    orizzonte: string;
    sintesi: string;
    motivi: { fonte: string; osservazione: string; direzione: Bias }[];
    livelli: {
        riferimento: number | null; invalidazione: number | null; obiettivo: number | null;
        /** L'obiettivo proposto dal modello quando `limitaObiettivo` l'ha accorciato a 1R. */
        obiettivoAi?: number | null;
    };
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

/**
 * Obiettivo a 1R (02/11/2026). Nel check 27/10-02/11 i target del modello
 * sono stati presi solo con R:R pianificato < 1,2 (5 su 5), mai sopra 1,3
 * (0 su 8: stop o uscita a tempo, spesso dopo essere stati in guadagno).
 * Oltre 1,2 volte il rischio l'obiettivo diventa riferimento +- rischio, e
 * quello del modello resta in `obiettivoAi`.
 */
export const RR_MASSIMO = 1.2;
export function limitaObiettivo(s: Segnale): Segnale {
    const { riferimento: rif, invalidazione: inv, obiettivo: obi } = s.livelli ?? {};
    if (s.bias === 'NEUTRALE' || rif == null || inv == null || obi == null) return s;
    const verso = s.bias === 'LONG' ? 1 : -1;
    const rischio = (rif - inv) * verso;
    const premio = (obi - rif) * verso;
    if (!(rischio > 0) || premio <= rischio * RR_MASSIMO) return s;
    return { ...s, livelli: { ...s.livelli, obiettivo: Math.round((rif + verso * rischio) * 4) / 4, obiettivoAi: obi } };
}

/**
 * Il verso della giornata dall'apertura del cash (9:30 NY): variazione di ES
 * e lato del VWAP. 'ribasso'/'rialzo' solo con almeno 10 punti E il prezzo
 * dalla stessa parte del VWAP, altrimenti 'laterale'.
 */
export function trendGiorno(storia: Riga[]) {
    const apertura = oraRomaDaNy('09:30');
    const primo = storia.find((p) => typeof p.time === 'string' && p.time >= apertura && typeof p.esf === 'number');
    const ultimo = [...storia].reverse().find((p) => typeof p.esf === 'number');
    if (!primo || !ultimo) return null;
    const variazione = (ultimo.esf as number) - (primo.esf as number);
    const vwap = typeof ultimo.vwap === 'number' ? ultimo.vwap : null;
    const sopra = vwap == null ? null : (ultimo.esf as number) > vwap;
    const verso = variazione >= 10 && sopra !== false ? 'rialzo' : variazione <= -10 && sopra !== true ? 'ribasso' : 'laterale';
    return { esAperturaCash: r(primo.esf), variazioneDaApertura: r(variazione), vwap: r(vwap), sopraVwap: sopra, verso };
}

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
    // Niente Zero Gamma: con le sole 0DTE e 37 strike attorno all'ATM il
    // livello non si puo' calcolare in modo affidabile (tolto da tutte le
    // pagine il 05/10/2026), e al modello arrivava un numero sbagliato.
    const cum = ordinato.reduce((s, p) => s + p[campo], 0);
    const perValore = [...ordinato].sort((a, b) => b[campo] - a[campo]);
    return {
        totale: r(cum, 0),
        maggioriPositivi: perValore.slice(0, 3).filter((p) => p[campo] > 0).map((p) => ({ strike: p.strike, valore: r(p[campo], 0) })),
        maggioriNegativi: perValore.slice(-3).reverse().filter((p) => p[campo] < 0).map((p) => ({ strike: p.strike, valore: r(p[campo], 0) })),
    };
}

/** Un campione al secondo dell'add-on Bookmap (/api/bookmap), solo i campi che servono qui. */
export type CampioneBookmap = {
    time: string;
    price: number | null;
    delta: number;
    cvd: number;
    book: { b: [number, number][]; a: [number, number][] } | null;
    /** [prezzo, contratti, verso, ora]: verso +1 = limit buyer che assorbono vendite, -1 = limit seller che assorbono acquisti. */
    abs: [number, number, number, string][] | null;
};

/** Un muro: un livello del book con almeno tanti contratti limit. */
const MURO = 150;
const ENTRO_PUNTI = 15;

/**
 * Bookmap degli ultimi 10 minuti (Modifica 1, 30/10/2026): il SHORT delle
 * 15:23 sull'R1 OB e' arrivato sul minimo del giorno, con 7.000 contratti
 * venduti a mercato contro muri bid sotto il prezzo e il delta girato in
 * positivo 30 s dopo -- niente di questo arrivava al modello.
 */
function riassumiBookmap(punti: CampioneBookmap[]) {
    const validi = punti.filter((p) => p.price !== null);
    const ultimo = validi[validi.length - 1];
    if (!ultimo) return null;
    const prezzo = ultimo.price as number;
    const sec = (t: string) => {
        const [h, m, x] = t.split(':').map(Number);
        return h * 3600 + m * 60 + (x || 0);
    };
    const ora = sec(ultimo.time);
    const da = (s: number) => validi.filter((p) => sec(p.time) > ora - s);
    const somma = (v: CampioneBookmap[]) => v.reduce((t, p) => t + p.delta, 0);

    const perMinuto = new Map<string, { t: string; prezzo: number; min: number; max: number; delta: number; cvd: number; assCompr: number; assVend: number }>();
    for (const p of validi) {
        const k = p.time.slice(0, 5);
        const v = perMinuto.get(k) ?? { t: k, prezzo: 0, min: Infinity, max: -Infinity, delta: 0, cvd: 0, assCompr: 0, assVend: 0 };
        v.prezzo = p.price as number;
        v.min = Math.min(v.min, p.price as number);
        v.max = Math.max(v.max, p.price as number);
        v.delta += p.delta;
        v.cvd = p.cvd;
        for (const a of p.abs ?? []) {
            if (a[2] === 1) v.assCompr += a[1];
            else v.assVend += a[1];
        }
        perMinuto.set(k, v);
    }

    const muri = (lato: 'b' | 'a') => (ultimo.book?.[lato] ?? [])
        .filter(([pr, q]) => q >= MURO && Math.abs(pr - prezzo) <= ENTRO_PUNTI)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([pr, q]) => ({ prezzo: pr, contratti: q }));
    // Spariti: muri di 3-5 minuti fa dalla parte giusta del prezzo, ora sotto un terzo.
    const visti = new Map<string, { prezzo: number; contratti: number; lato: 'bid' | 'ask' }>();
    for (const p of da(300).filter((x) => sec(x.time) <= ora - 180)) {
        for (const lato of ['b', 'a'] as const) {
            for (const [pr, q] of p.book?.[lato] ?? []) {
                if (q < MURO || Math.abs(pr - prezzo) > ENTRO_PUNTI) continue;
                if (lato === 'b' ? pr >= prezzo : pr <= prezzo) continue;
                const k = `${lato}${pr}`;
                if ((visti.get(k)?.contratti ?? 0) < q) visti.set(k, { prezzo: pr, contratti: q, lato: lato === 'b' ? 'bid' : 'ask' });
            }
        }
    }
    const adesso = (lato: 'bid' | 'ask', pr: number) => (ultimo.book?.[lato === 'bid' ? 'b' : 'a'] ?? []).find(([x]) => x === pr)?.[1] ?? 0;
    const spariti = [...visti.values()]
        .map((m) => ({ ...m, adesso: adesso(m.lato, m.prezzo) }))
        .filter((m) => m.adesso < m.contratti / 3);

    const vicini = da(600).flatMap((p) => p.abs ?? []).filter((a) => Math.abs(a[0] - prezzo) <= 5);
    const ass = (verso: number) => {
        const v = vicini.filter((a) => a[2] === verso);
        return { quanti: v.length, contratti: v.reduce((t, a) => t + a[1], 0), prezzi: [...new Set(v.map((a) => a[0]))].sort((x, y) => x - y) };
    };
    const tratto = (s: number) => {
        const v = da(s);
        return { delta: somma(v), variazionePrezzo: r(prezzo - ((v[0]?.price as number | undefined) ?? prezzo)) };
    };

    return {
        nota: 'ES dal book Rithmic (Bookmap), ora di Roma. delta = contratti comprati a mercato meno venduti; cvd = la somma del giorno. Muri = ordini limit >= 150 contratti entro 15 punti. Assorbimento = volume aggressivo su un prezzo >= 2 volte la coda, col livello che regge: compratori = limit buyer che assorbono vendite (rialzista), venditori = il contrario. Vendite forti col prezzo fermo e muri bid sotto = esaurimento, non rottura.',
        prezzo,
        ultimi10minPerMinuto: [...perMinuto.values()].slice(-10).map((v) => ({ ...v, min: r(v.min), max: r(v.max) })),
        ultimi60s: tratto(60),
        ultimi3min: tratto(180),
        muriBidSotto: muri('b'),
        muriAskSopra: muri('a'),
        muriSpariti3_5minFa: spariti,
        assorbimenti10minEntro5Punti: { compratori: ass(1), venditori: ass(-1) },
    };
}

/** L'innesco di /market (AI Livelli) come lo manda la pagina. */
export type Innesco = {
    livello: string;
    prezzoLivello: number;
    esf: number | null;
    lato?: 'da sotto' | 'da sopra';
    esf10m?: number;
    distanzaMax30m?: number;
    contatto?: number;
    /** 1σ da adesso alla chiusura in punti (expected move dello smile) e distanzaMax30m / em. */
    em?: number;
    estensione?: number;
};

/** Mediana di ES - SPX sugli ultimi punti con SPX: la base per portare gli strike in ES. */
function basisRecente(storia: Riga[]): number | null {
    const d = storia.slice(-40)
        .filter((p) => typeof p.esf === 'number' && typeof p.spx === 'number')
        .map((p) => (p.esf as number) - (p.spx as number))
        .sort((a, b) => a - b);
    if (d.length === 0) return null;
    const m = Math.floor(d.length / 2);
    return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * Gli strike pesanti a 3 punti ES dal livello dell'innesco (Modifica 1): il 30/10
 * l'R1 OB a 7630.97 ES era lo strike SPX 7600, il massimo di gamma negativa per
 * flusso e per open interest, e il modello l'ha messo fra i rischi.
 */
function confluenze(innesco: Innesco, profilo: ProfiloRiga[], hedging: Record<string, unknown> | null, basis: number | null) {
    if (basis === null) return [];
    const vicino = (strike: number) => Math.abs(strike + basis - innesco.prezzoLivello) <= 3;
    const out: { strike: number; strikeInEs: number | null; cosa: string }[] = [];
    for (const campo of ['gex', 'gexOi'] as const) {
        const nome = campo === 'gex' ? 'flusso' : 'open interest';
        const per = [...profilo].sort((a, b) => b[campo] - a[campo]);
        per.slice(0, 3).forEach((p, i) => {
            if (p[campo] > 0 && vicino(p.strike)) out.push({ strike: p.strike, strikeInEs: r(p.strike + basis), cosa: `${i + 1}o strike gamma positiva (${nome})` });
        });
        per.slice(-3).reverse().forEach((p, i) => {
            if (p[campo] < 0 && vicino(p.strike)) out.push({ strike: p.strike, strikeInEs: r(p.strike + basis), cosa: `${i + 1}o strike gamma negativa (${nome})` });
        });
    }
    ((hedging?.riskZones as { strike: number; riskLevel: string; pressure: number }[]) ?? [])
        .filter((z) => z.riskLevel !== 'low')
        .sort((a, b) => Math.abs(b.pressure) - Math.abs(a.pressure))
        .slice(0, 3)
        .forEach((z, i) => {
            if (vicino(z.strike)) out.push({ strike: z.strike, strikeInEs: r(z.strike + basis), cosa: `${i + 1}a zona di pressione market maker` });
        });
    return out;
}

export function riassumi(fonti: {
    market: { latest: Riga | null; history: Riga[] };
    gex: { profile?: ProfiloRiga[]; spot?: { time: string; price: number }[]; profileHistory?: { minutesAgo: number; rows: ProfiloRiga[] }[] } | null;
    iv: { snapshots?: Riga[] } | null;
    tide: { points?: Riga[] } | null;
    hedging: Record<string, unknown> | null;
    bookmap?: { points?: CampioneBookmap[] } | null;
    innesco?: Innesco | null;
}) {
    const { market, gex, iv, tide, hedging, bookmap, innesco } = fonti;
    const basis = basisRecente(market.history);
    const storia = market.history;
    const es = storia.map((p) => p.esf).filter((x): x is number => typeof x === 'number');

    const spot = gex?.spot?.at(-1)?.price ?? null;
    const vicino = (s: number) => spot === null || Math.abs(s - spot) <= 60;
    const profilo = gex?.profile ?? [];
    const dieciMinFa = gex?.profileHistory?.find((h) => h.minutesAgo === 10)?.rows;

    return {
        oraRoma: oraRoma(),
        ...(innesco ? { innesco: { ...innesco, confluenze: confluenze(innesco, profilo, hedging, basis), basisEsSpx: r(basis) } } : {}),
        es: {
            ultimo: market.latest,
            trendGiorno: trendGiorno(storia),
            sessione: es.length
                ? { primo: es[0], massimo: Math.max(...es), minimo: Math.min(...es), primoOrario: storia[0]?.time }
                : null,
            ultimi60minPerMinuto: perMinuto(storia, 60).map((p) => ({
                t: p.time.slice(0, 5), es: r(p.esf), vix: r(p.vix), spx: r(p.spx), vwap: r(p.vwap), esIvAtm: r(p.esAtmIv),
            })),
        },
        gammaSpx: gex
            ? {
                  nota: 'Valori in $M. gex = pesato sul volume del giorno (flusso), gexOi = pesato su open interest (posizionamento). Segno: call +, put − (euristica dealer long call / short put). Solo 0DTE e 37 strike attorno all\'ATM: non bastano per uno Zero Gamma o una soglia di regime.',
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
        bookmapEs: bookmap?.points?.length ? riassumiBookmap(bookmap.points) : null,
    };
}

export const SYSTEM_PROMPT = `Sei un analista di microstruttura del mercato USA. Ricevi un riassunto in JSON dei dati live di una dashboard personale: ES (future S&P 500) e VIX, profilo di gamma exposure delle opzioni SPX 0DTE, IV near-ATM di put e call 0DTE, flusso netto di premio sulla catena 0DTE (market tide), zone di pressione di hedging dei market maker e il book di ES da Bookmap (delta, muri limit, assorbimenti).

Il tuo compito: dare un bias direzionale su ES per i prossimi 15-60 minuti — LONG, SHORT o NEUTRALE — con una confidenza 0-100 e i motivi, citando per ciascuno la fonte e il numero che lo sostiene.

Regole:
- È un esercizio di studio. Sii onesto sull'incertezza: se i segnali sono contrastanti o scarsi, rispondi NEUTRALE con confidenza bassa. Una confidenza sopra 70 richiede più fonti indipendenti concordi.
- Una sezione a null significa che quella fonte non ha dati ora (es. poller fermo o fuori orario): dillo nei rischi e non inventare.
- SPX e ES differiscono per la base (ES di solito sopra SPX di qualche punto/decina di punti): converti i livelli SPX in livelli ES usando la differenza attuale tra i due, e dai i livelli in punti ES.
- Gamma: non dedurre dai segni dei singoli strike uno Zero Gamma, un "flip" o una soglia di cambio di regime (tipo "sotto X la gamma diventa negativa e il movimento accelera"). Il profilo copre solo le 0DTE e 37 strike attorno all'ATM, e il segno è un'euristica, non un dato osservato. Il gex di flusso descrive lo scambiato di oggi, non il posizionamento: non chiamarlo regime. Usa gli strike solo come muri o magneti vicini allo spot.
- Se c'è il campo innesco, l'analisi è partita da sola perché ES è arrivato a 1 punto da quel livello tracciato sul grafico (range R1/R2/R3 dal straddle, o GEX+/GEX- = strike di gamma positiva/negativa maggiore, in punti ES): di' nella sintesi se i dati fanno pensare che il livello tenga o venga rotto, e da' il bias di conseguenza. innesco.lato dice da che parte arriva ES: 'da sotto' = il livello e' una resistenza (tiene -> SHORT, rotto -> LONG), 'da sopra' = e' un supporto (tiene -> LONG, rotto -> SHORT); esf10m e' ES 10 minuti fa, distanzaMax30m quanto ES era lontano dal livello nell'ultima mezz'ora, contatto quante volte oggi ES e' arrivato su quel livello (2 o piu' = gia' testato). Per prevedere una rottura servono conferme dai flussi: arrivare vicino al livello, da solo, non lo e'. ES a 1 punto oltre il livello e' dentro la tolleranza dell'innesco, non e' una rottura.
- Movimento passato contro prossimo (con innesco): market tide cumulato, VIX in salita o discesa, distanza dal VWAP, gex di flusso cumulato e massimi/minimi in fila descrivono il movimento che ha PORTATO il prezzo al livello, non quello dopo: da soli non bastano a dire che il livello si rompe. innesco.estensione = distanzaMax30m / em (em = 1 sigma da adesso alla chiusura delle 16:00 ET, in punti, dallo smile 0DTE): con estensione >= 0.6 al primo o secondo contatto il movimento e' gia' lungo e la reazione sul livello e' l'ipotesi di partenza; la continuazione richiede prove fresche degli ultimi 1-3 minuti in bookmapEs (delta ancora in accelerazione col prezzo che avanza, muri dalla parte del movimento spariti o assenti, niente assorbimenti contrari).
- innesco.confluenze: strike pesanti (gamma, open interest, zone di pressione) a 3 punti ES dal livello. Una confluenza rinforza la tenuta del livello: pesala fra i motivi, non solo fra i rischi.
- bookmapEs (se c'e'): delta e CVD minuto per minuto, muri limit vicini, muri spariti, assorbimenti. Vendite (o acquisti) forti col prezzo che non avanza piu' e muri dalla parte opposta = esaurimento; muri spariti dalla parte del livello = rottura piu' probabile. Cita i numeri.
- Trend del giorno (es.trendGiorno, dall'apertura cash e rispetto al VWAP): un bias CONTRO il verso 'rialzo' o 'ribasso' (LONG in ribasso, SHORT in rialzo) richiede prove fresche di inversione negli ultimi 1-3 minuti di bookmapEs (delta girato col prezzo che segue, assorbimenti dalla parte del bias, muri contrari spariti) e anche cosi' confidenza al massimo 45; senza quelle prove rispondi NEUTRALE. Con estensione alta in una giornata di trend la reazione attesa sul livello e' una pausa, non un'inversione. Nel check 27/10-02/11 i LONG contro il trend sono stati 1 su 6.
- livelli.riferimento = prezzo ES attuale; invalidazione = livello ES che smentirebbe il bias; obiettivo = il primo livello di reazione plausibile, a circa 1 volta il rischio (|obiettivo - riferimento| fra 0,8 e 1,2 volte |riferimento - invalidazione|), non un obiettivo lontano: i target piu' lontani di 1,2 volte il rischio non sono mai stati raggiunti. Con bias NEUTRALE puoi lasciarli a null.
- Scrivi in italiano, conciso.`;
