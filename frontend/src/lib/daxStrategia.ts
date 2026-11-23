/**
 * Calcoli della pagina /dax: opzioni ODAX (europee sull'indice DAX, che e' un
 * indice total return, quindi dividendi = 0) con Black-Scholes, e future DAX.
 * Prezzi in punti indice; gli euro sono punti x moltiplicatore.
 */

export type TipoGamba = 'C' | 'P' | 'F';

export interface Gamba {
    id: string;
    attiva: boolean;          // esclusa = non entra nei totali (per i "what if")
    qta: number;              // + comprata, - venduta
    tipo: TipoGamba;
    strike: number;           // ignorato per il future
    scadenza: string;         // YYYY-MM-DD
    iv: number | null;        // % (es. 17.75)
    apertura: number | null;  // prezzo di apertura
    chiusura: number | null;  // se valorizzato la gamba e' chiusa: P&L realizzato
    dataApertura: string;     // YYYY-MM-DD
    gruppo: string;           // es. "V1": le gambe dello stesso gruppo si sommano (vertical)
    mid: number | null;       // (bid+ask)/2 da IBKR o a mano
    ivIbkr?: number | null;   // IV del modello IBKR, solo da mostrare
    note?: string;
}

export interface Impostazioni {
    moltOpzioni: number;      // EUR per punto, ODAX = 5
    moltFuture: number;       // FDAX 25, FDXM 5, FDXS 1
    commOpzioni: number;      // EUR per contratto per lato
    commFuture: number;
    tasso: number;            // % annuo
    classeFuture: 'FDAX' | 'FDXM' | 'FDXS';
}

export interface Mercato {
    indiceLast: number | null;
    indiceClose: number | null;
    futureLast: number | null;
    futureClose: number | null;
    /**
     * Riporto annuo implicito per scadenza (YYYY-MM-DD), da parita' put-call ATM:
     * forward = indice x e^(riporto x T). Senza, si usa il tasso. Il 23/11/2026 il
     * forward di mar 27 era 25.292 con l'indice a 24.991 (riporto ~3,8%, non il
     * 2% del tasso): con il solo tasso la IV ATM usciva 18,4 contro 19,45 di IBKR,
     * con il forward 19,46.
     */
    carry?: Record<string, number>;
}

export interface Scenario {
    indice: number;           // indice simulato
    oggi: Date;               // data di valutazione simulata
    shiftIv: number;          // punti di vol aggiunti a tutte le IV
    aScadenza: boolean;       // tutto valutato a scadenza (payoff intrinseco)
}

const SQRT2PI = Math.sqrt(2 * Math.PI);
export function nPdf(x: number) { return Math.exp(-0.5 * x * x) / SQRT2PI; }
export function nCdf(x: number) {
    // Abramowitz-Stegun 26.2.17, errore < 7.5e-8
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
}

export interface Greche { prezzo: number; delta: number; gamma: number; theta: number; vega: number }

/**
 * Black-Scholes europeo con costo di riporto b (= Black-76 sul forward S·e^(bT)).
 * T in anni, r, b e sigma decimali; b omesso = r. Greche rispetto all'indice:
 * theta per giorno, vega per 1 punto di vol.
 */
export function bs(tipo: 'C' | 'P', S: number, K: number, T: number, r: number, sigma: number, b: number = r): Greche {
    if (T <= 0 || sigma <= 0) {
        const intr = tipo === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
        const delta = tipo === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
        return { prezzo: intr, delta, gamma: 0, theta: 0, vega: 0 };
    }
    const sq = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (b + sigma * sigma / 2) * T) / (sigma * sq);
    const d2 = d1 - sigma * sq;
    const sc = Math.exp(-r * T);
    const sb = Math.exp((b - r) * T);
    const gamma = sb * nPdf(d1) / (S * sigma * sq);
    const vega = S * sb * nPdf(d1) * sq / 100;
    const decad = -S * sb * nPdf(d1) * sigma / (2 * sq);
    if (tipo === 'C') {
        const prezzo = S * sb * nCdf(d1) - K * sc * nCdf(d2);
        const theta = (decad - (b - r) * S * sb * nCdf(d1) - r * K * sc * nCdf(d2)) / 365;
        return { prezzo, delta: sb * nCdf(d1), gamma, theta, vega };
    }
    const prezzo = K * sc * nCdf(-d2) - S * sb * nCdf(-d1);
    const theta = (decad + (b - r) * S * sb * nCdf(-d1) + r * K * sc * nCdf(-d2)) / 365;
    return { prezzo, delta: sb * (nCdf(d1) - 1), gamma, theta, vega };
}

/** IV implicita (in %) dal prezzo, per bisezione. null se il prezzo e' sotto l'intrinseco. */
export function ivImplicita(tipo: 'C' | 'P', prezzo: number, S: number, K: number, T: number, r: number, b: number = r): number | null {
    if (!(prezzo > 0) || T <= 0) return null;
    let lo = 0.001, hi = 3;
    if (bs(tipo, S, K, T, r, lo, b).prezzo > prezzo || bs(tipo, S, K, T, r, hi, b).prezzo < prezzo) return null;
    for (let i = 0; i < 100; i++) {
        const m = (lo + hi) / 2;
        if (bs(tipo, S, K, T, r, m, b).prezzo > prezzo) hi = m; else lo = m;
        if (hi - lo < 1e-6) break;
    }
    return ((lo + hi) / 2) * 100;
}

export function dataDa(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 17, 30); // ODAX scade alle 13:00 CET, ma la sessione chiude dopo: basta il giorno
}

export function giorniTra(a: Date, b: Date): number {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / 86_400_000);
}

export function isoGiorno(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Terzo venerdi' del mese (scadenza mensile ODAX). */
export function terzoVenerdi(anno: number, mese0: number): Date {
    const primo = new Date(anno, mese0, 1);
    const offset = (5 - primo.getDay() + 7) % 7;
    return new Date(anno, mese0, 1 + offset + 14);
}

/** Scadenza mensile piu' vicina a `giorni` da oggi. */
export function scadenzaVicinaA(oggi: Date, giorni: number): Date {
    const obiettivo = oggi.getTime() + giorni * 86_400_000;
    let migliore = terzoVenerdi(oggi.getFullYear(), oggi.getMonth());
    for (let i = 0; i < 18; i++) {
        const d = terzoVenerdi(oggi.getFullYear(), oggi.getMonth() + i);
        if (Math.abs(d.getTime() - obiettivo) < Math.abs(migliore.getTime() - obiettivo)) migliore = d;
    }
    return migliore;
}

export interface ValoreGamba extends Greche {
    valore: number;       // prezzo simulato per unita'
    puntiPnl: number;     // (valore - apertura) x qta, in punti
    eurPnl: number;       // in euro
    deltaQ: number; gammaQ: number; thetaEur: number; vegaEur: number; // con qta e moltiplicatore
    chiusa: boolean;
}

/** Riporto annuo della scadenza: quello implicito letto da IBKR, altrimenti il tasso. */
export function riporto(scadenza: string, imp: Impostazioni, mkt: Mercato): number {
    return mkt.carry?.[scadenza] ?? imp.tasso / 100;
}

/** Riporto implicito dalla parita' put-call: F = (C - P)·e^(rT) + K, b = ln(F/S)/T. */
export function riportoDaParita(call: number, put: number, K: number, S: number, T: number, r: number): number | null {
    if (!(T > 0) || !(S > 0)) return null;
    const F = (call - put) * Math.exp(r * T) + K;
    return F > 0 ? Math.log(F / S) / T : null;
}

/** Valore di una gamba nello scenario. Gambe chiuse: P&L realizzato, greche zero. */
export function valutaGamba(g: Gamba, sc: Scenario, imp: Impostazioni, mkt: Mercato): ValoreGamba {
    const molt = g.tipo === 'F' ? imp.moltFuture : imp.moltOpzioni;
    const apertura = g.apertura ?? 0;
    if (g.chiusura != null) {
        const punti = (g.chiusura - apertura) * g.qta;
        return {
            prezzo: g.chiusura, delta: 0, gamma: 0, theta: 0, vega: 0, valore: g.chiusura,
            puntiPnl: punti, eurPnl: punti * molt, deltaQ: 0, gammaQ: 0, thetaEur: 0, vegaEur: 0, chiusa: true,
        };
    }
    const scad = dataDa(g.scadenza);
    const giorni = Math.max(0, giorniTra(sc.oggi, scad));
    const T = sc.aScadenza ? 0 : giorni / 365;
    let gr: Greche;
    if (g.tipo === 'F') {
        // il future segue l'indice con la base di adesso, che si azzera a scadenza
        const baseAttuale = mkt.futureLast != null && mkt.indiceLast != null ? mkt.futureLast - mkt.indiceLast : 0;
        const giorniOra = Math.max(1, giorniTra(new Date(), scad));
        const base = sc.aScadenza ? 0 : baseAttuale * Math.min(1, giorni / giorniOra);
        gr = { prezzo: sc.indice + base, delta: 1, gamma: 0, theta: 0, vega: 0 };
    } else {
        const sigma = Math.max(0.01, ((g.iv ?? 20) + sc.shiftIv) / 100);
        gr = bs(g.tipo, sc.indice, g.strike, T, imp.tasso / 100, sigma, riporto(g.scadenza, imp, mkt));
    }
    const punti = (gr.prezzo - apertura) * g.qta;
    return {
        ...gr, valore: gr.prezzo, puntiPnl: punti, eurPnl: punti * molt,
        deltaQ: gr.delta * g.qta, gammaQ: gr.gamma * g.qta,
        thetaEur: gr.theta * g.qta * molt, vegaEur: gr.vega * g.qta * molt, chiusa: false,
    };
}

export interface Totali {
    pnlAperte: number;      // EUR, non realizzato
    realizzato: number;     // EUR
    commPagate: number;
    commDaPagare: number;
    netto: number;          // tutto meno commissioni
    deltaEur: number;       // EUR per punto di indice
    deltaContratti: number; // delta in "opzioni equivalenti"
    gammaQ: number; thetaEur: number; vegaEur: number;
}

export function totali(gambe: Gamba[], sc: Scenario, imp: Impostazioni, mkt: Mercato): Totali {
    const t: Totali = { pnlAperte: 0, realizzato: 0, commPagate: 0, commDaPagare: 0, netto: 0, deltaEur: 0, deltaContratti: 0, gammaQ: 0, thetaEur: 0, vegaEur: 0 };
    for (const g of gambe) {
        if (!g.attiva) continue;
        const v = valutaGamba(g, sc, imp, mkt);
        const molt = g.tipo === 'F' ? imp.moltFuture : imp.moltOpzioni;
        const comm = Math.abs(g.qta) * (g.tipo === 'F' ? imp.commFuture : imp.commOpzioni);
        t.commPagate += comm;
        if (v.chiusa) { t.realizzato += v.eurPnl; t.commPagate += comm; }
        else {
            t.pnlAperte += v.eurPnl;
            // a scadenza le opzioni OTM scadono senza commissione di chiusura
            const scadeAZero = sc.aScadenza && g.tipo !== 'F' && v.valore === 0;
            if (!scadeAZero) t.commDaPagare += comm;
        }
        t.deltaEur += v.deltaQ * molt;
        t.deltaContratti += v.deltaQ;
        t.gammaQ += v.gammaQ;
        t.thetaEur += v.thetaEur;
        t.vegaEur += v.vegaEur;
    }
    t.netto = t.pnlAperte + t.realizzato - t.commPagate - t.commDaPagare;
    return t;
}

/** P&L netto (EUR) in funzione dell'indice. */
export function curva(gambe: Gamba[], sc: Scenario, imp: Impostazioni, mkt: Mercato, xs: number[]): number[] {
    return xs.map(x => totali(gambe, { ...sc, indice: x }, imp, mkt).netto);
}

/** Punti di pareggio: dove la curva cambia segno, interpolati. */
export function pareggi(xs: number[], ys: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < xs.length; i++) {
        const a = ys[i - 1], b = ys[i];
        if (a === 0) out.push(xs[i - 1]);
        else if (a * b < 0) out.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-a / (b - a)));
    }
    return out;
}

export function griglia(min: number, max: number, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(min + (max - min) * i / n);
    return out;
}

/** Scadenza trimestrale ODAX (terzo venerdi' di marzo/giugno/settembre/dicembre) piu' vicina a `giorni` da oggi. */
export function scadenzaTrimestraleVicinaA(oggi: Date, giorni: number): Date {
    const obiettivo = oggi.getTime() + giorni * 86_400_000;
    let migliore: Date | null = null;
    for (let i = 0; i < 24; i++) {
        const mese = oggi.getMonth() + i;
        if ((mese % 12) % 3 !== 2) continue;
        const d = terzoVenerdi(oggi.getFullYear(), mese);
        if (d.getTime() <= oggi.getTime()) continue;
        if (!migliore || Math.abs(d.getTime() - obiettivo) < Math.abs(migliore.getTime() - obiettivo)) migliore = d;
    }
    return migliore ?? scadenzaVicinaA(oggi, giorni);
}
