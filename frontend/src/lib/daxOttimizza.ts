/**
 * Ricerca della combinazione per la strategia DAX (/dax, STUDIO): con le put
 * ODAX lette da IBKR (`dax_quote.py` modo "catena") si provano tutte le
 * combinazioni con le regole dei video e si tengono le migliori, che poi
 * Claude confronta e sceglie (/api/dax/ottimizza).
 *
 * Regole (video del 23/11 e lezione del 18/11/2026, minuti 40-77):
 * - V1 = put spread largo 500, comprata ~3,5-7% sotto lo spot (24500/24000 con
 *   il DAX a 25.755-25.836), costa ~87-98 punti.
 * - V2 = put spread largo 1000-1500 (1300 nell'ultima versione: 21500/20200),
 *   comprata ~13-20% sotto, su supporti e gap; tutto sotto V1.
 * - Put vendute ~35-44% sotto ("sempre intorno al 40%"), 4-6 in tutto ("-5 va
 *   bene, con -6 la curva si piega verso il basso"), su uno strike o divise fra
 *   due strike a 200 punti (3+2, 2+4...): quante bastano perche' il netto con le
 *   commissioni sia ~0 (lui apre a -5/-6 punti di credito, ~25-30 EUR, che
 *   pagano i ~22 EUR di commissioni).
 * - Vega/theta della posizione intorno a 4, non oltre (73,7/19,5 = 3,8 va bene,
 *   4,7 con -6 vendute no): vega troppo alto rispetto al theta incassato.
 * Prezzi eseguibili: si compra all'ask e si vende al bid.
 */

import { bs, nCdf } from './daxStrategia';

export interface PutQuota { strike: number; bid: number | null; ask: number | null; mid: number | null; iv: number | null; delta: number | null }
export interface CatenaScadenza {
    scadenza: string; dte: number; put: PutQuota[];
    atm: { strike: number; put: number | null; call: number | null; iv: number | null };
}

export interface GambaCandidato { qta: number; strike: number; prezzo: number; mid: number | null; iv: number | null; gruppo: string }

export interface Candidato {
    id: number;
    scadenza: string; dte: number;
    gambe: GambaCandidato[];
    larghezzaV1: number; larghezzaV2: number;
    costoV1: number; costoV2: number;        // punti, all'ask/bid
    incassoVendute: number;                  // punti
    nVendute: number;                        // put vendute in tutto
    nettoPunti: number;                      // + debito / - credito, commissioni comprese
    commissioniEur: number;
    maxGuadagnoEur: number;
    zonaMax: [number, number];               // DAX a scadenza dove si guadagna il massimo
    beGiu: number | null; beGiuPct: number | null;
    perdita40Eur: number; perdita45Eur: number;  // a scadenza con il DAX -40% / -45%
    pSottoBe: number | null;                 // probabilita' neutrale al rischio di chiudere sotto il pareggio
    distV1Pct: number; distV2Pct: number;    // distanza delle comprate dallo spot
    distVendutePct: number;                  // distanza della venduta piu' alta
    ivAtm: number | null; ivPrimaComprata: number | null; ivLontana: number | null;
    thetaEur: number; vegaEur: number;       // greche della posizione all'apertura (theta al giorno, vega per +1 punto IV)
    vegaTheta: number | null;                // |vega| / theta: intorno a 4 e non oltre
    oggiMeno5Eur: number; oggiMeno10Eur: number;      // variazione di valore oggi con il DAX -5% / -10%, IV ferme
    oggiMeno10IvEur: number;                 // idem a -10% con tutte le IV +10 punti (il crollo vero)
    rapporto: number;                        // max guadagno / |perdita a -45%|
}

const V1_LARGH = [500];
const V2_LARGH = [1000, 1300, 1500];
const VENDUTE_TOT = [4, 5, 6];
const VEGA_THETA_MAX = 5;   // oltre si scarta; fino a 4 e' "dentro"

/** Payoff a scadenza (punti) di un insieme di put, premio escluso. */
function intrinseco(gambe: GambaCandidato[], x: number) {
    return gambe.reduce((s, g) => s + g.qta * Math.max(g.strike - x, 0), 0);
}

/** Modi di mettere n put vendute su k5 (alto) e k6 = k5 - 200: tutte su uno strike, o 3+resto, 2+resto. */
function divisioni(n: number): [number, number][] {
    const out: [number, number][] = [[n, 0]];
    for (const a of [3, 2]) if (a < n && !out.some(([x]) => x === a)) out.push([a, n - a]);
    return out;
}

export function cercaCombinazioni(
    catene: CatenaScadenza[], spot: number,
    opz: { tasso: number; commOpzioni: number; moltOpzioni: number; massimo?: number },
): { candidati: Candidato[]; provate: number } {
    const molt = opz.moltOpzioni, r = opz.tasso / 100;
    const tutti: Candidato[] = [];
    let provate = 0;

    for (const c of catene) {
        const perStrike = new Map(c.put.map(p => [p.strike, p]));
        const acquisto = (k: number) => { const p = perStrike.get(k); return p ? (p.ask ?? p.mid) : null; };
        const vendita = (k: number) => { const p = perStrike.get(k); return p && p.bid && p.bid > 0 ? p.bid : null; };
        const iv = (k: number) => perStrike.get(k)?.iv ?? null;
        const mid = (k: number) => perStrike.get(k)?.mid ?? null;
        const ks = [...perStrike.keys()].sort((a, b) => a - b);
        const T = Math.max(1, c.dte) / 365;
        // forward dalla parita' ATM: probabilita' e greche come IBKR (Black-76 sul forward)
        const F = c.atm.call != null && c.atm.put != null ? (c.atm.call - c.atm.put) * Math.exp(r * T) + c.atm.strike : spot * Math.exp(r * T);
        const carry = Math.log(F / spot) / T;
        // IV mancante: quella dello strike piu' vicino che ce l'ha
        const ivUsata = (k: number) => {
            const v = iv(k); if (v != null) return v;
            const vicino = ks.filter(x => iv(x) != null).sort((a, b) => Math.abs(a - k) - Math.abs(b - k))[0];
            return vicino != null ? iv(vicino)! : 25;
        };
        const valore = (g: GambaCandidato, S: number, piuIv = 0) => bs('P', S, g.strike, T, r, (ivUsata(g.strike) + piuIv) / 100, carry);

        const v1 = ks.filter(k => k >= spot * 0.93 && k <= spot * 0.965);
        const v2 = ks.filter(k => k >= spot * 0.80 && k <= spot * 0.87);
        const vend = ks.filter(k => k >= spot * 0.56 && k <= spot * 0.65);

        for (const k1 of v1) for (const w1 of V1_LARGH) {
            const k2 = k1 - w1;
            const a1 = acquisto(k1), b2 = vendita(k2);
            if (a1 == null || b2 == null) continue;
            for (const k3 of v2) for (const w2 of V2_LARGH) {
                const k4 = k3 - w2;
                if (k3 >= k2) continue;
                const a3 = acquisto(k3), b4 = vendita(k4);
                if (a3 == null || b4 == null) continue;
                for (const k5 of vend) {
                    const b5 = vendita(k5);
                    if (k5 >= k4 || b5 == null) continue;
                    const k6 = k5 - 200, b6 = vendita(k6);
                    const debito = (a1 - b2) + (a3 - b4);
                    // per ogni divisione, il minimo di put vendute che paga vertical e commissioni
                    for (const [q5Base, q6Base] of divisioni(6)) {
                        let scelta: { q5: number; q6: number } | null = null;
                        for (const n of VENDUTE_TOT) {
                            const q5 = q6Base === 0 ? n : Math.min(q5Base, n), q6 = n - q5;
                            if (q6 > 0 && b6 == null) break;
                            const commPunti = ((4 + n) * opz.commOpzioni) / molt;
                            if (q5 * b5 + q6 * (b6 ?? 0) >= debito + commPunti) { scelta = { q5, q6 }; break; }
                        }
                        if (!scelta) continue;
                        const { q5, q6 } = scelta;
                        if (q6Base > 0 && q6 === 0) continue;   // gia' contata come "tutte su k5"
                        provate++;
                        const n = q5 + q6;
                        const nOpz = 4 + n;
                        const commissioniEur = nOpz * opz.commOpzioni;
                        const incasso = q5 * b5 + q6 * (b6 ?? 0);
                        const nettoPunti = debito - incasso + commissioniEur / molt;
                        const gambe: GambaCandidato[] = [
                            { qta: 1, strike: k1, prezzo: a1, mid: mid(k1), iv: iv(k1), gruppo: 'V1' },
                            { qta: -1, strike: k2, prezzo: b2, mid: mid(k2), iv: iv(k2), gruppo: 'V1' },
                            { qta: 1, strike: k3, prezzo: a3, mid: mid(k3), iv: iv(k3), gruppo: 'V2' },
                            { qta: -1, strike: k4, prezzo: b4, mid: mid(k4), iv: iv(k4), gruppo: 'V2' },
                            { qta: -q5, strike: k5, prezzo: b5, mid: mid(k5), iv: iv(k5), gruppo: 'S' },
                        ];
                        if (q6 > 0) gambe.push({ qta: -q6, strike: k6, prezzo: b6!, mid: mid(k6), iv: iv(k6), gruppo: 'S' });
                        const kBasso = q6 > 0 ? k6 : k5;

                        // greche all'apertura e forma della curva a oggi: variazione di valore rispetto ad adesso
                        // (senza spread d'ingresso ne' commissioni, che spostano tutta la curva e non la piegano)
                        let theta = 0, vega = 0, oraPunti = 0;
                        for (const g of gambe) { const v = valore(g, spot); theta += g.qta * v.theta; vega += g.qta * v.vega; oraPunti += g.qta * v.prezzo; }
                        const oggi = (S: number, piuIv = 0) =>
                            (gambe.reduce((s, g) => s + g.qta * valore(g, S, piuIv).prezzo, 0) - oraPunti) * molt;
                        const vegaTheta = theta > 0 ? Math.abs(vega) / theta : null;

                        const pnl = (x: number) => (intrinseco(gambe, x) - nettoPunti) * molt;
                        // pareggio sotto le vendute: si scende a passi di 10 da k5
                        let beGiu: number | null = null;
                        for (let x = k5; x > spot * 0.2; x -= 10) { if (pnl(x) < 0) { beGiu = x + 10 * (pnl(x) / (pnl(x) - pnl(x + 10))); break; } }
                        const maxGuadagnoEur = pnl(k5);
                        const perdita45Eur = pnl(spot * 0.55);
                        const sigma = (iv(kBasso) ?? 40) / 100;
                        const pSottoBe = beGiu ? nCdf((Math.log(beGiu / F) + sigma * sigma * T / 2) / (sigma * Math.sqrt(T))) : null;
                        tutti.push({
                            id: 0, scadenza: c.scadenza, dte: c.dte, gambe,
                            larghezzaV1: w1, larghezzaV2: w2, costoV1: a1 - b2, costoV2: a3 - b4, incassoVendute: incasso, nVendute: n, nettoPunti,
                            commissioniEur, maxGuadagnoEur, zonaMax: [k5, k4],
                            beGiu, beGiuPct: beGiu ? (beGiu / spot - 1) * 100 : null,
                            perdita40Eur: pnl(spot * 0.60), perdita45Eur, pSottoBe,
                            distV1Pct: (k1 / spot - 1) * 100, distV2Pct: (k3 / spot - 1) * 100,
                            distVendutePct: (k5 / spot - 1) * 100,
                            ivAtm: c.atm.iv, ivPrimaComprata: iv(k1), ivLontana: iv(kBasso),
                            thetaEur: theta * molt, vegaEur: vega * molt, vegaTheta,
                            oggiMeno5Eur: oggi(spot * 0.95), oggiMeno10Eur: oggi(spot * 0.90), oggiMeno10IvEur: oggi(spot * 0.90, 10),
                            rapporto: maxGuadagnoEur / Math.max(1, Math.abs(Math.min(0, perdita45Eur))),
                        });
                    }
                }
            }
        }
    }

    // Vega/theta oltre 5: la posizione e' troppo sbilanciata sulla volatilita' (se ne resta qualcuna).
    const equilibrate = tutti.filter(c => c.vegaTheta != null && c.vegaTheta <= VEGA_THETA_MAX);
    const base = equilibrate.length ? equilibrate : tutti;
    // Ordine nella casella: rapporto guadagno/perdita a -45%, a pari merito chi resta sopra zero oggi a -5%;
    // vega/theta oltre 4 pesa meno.
    const punteggio = (c: Candidato) => c.rapporto * (c.vegaTheta != null && c.vegaTheta <= 4 ? 1 : 0.7) * (c.oggiMeno5Eur >= 0 ? 1 : 0.85);

    // Per scadenza e per fascia di distanza delle put vendute (35-38%, 38-41%, 41-44%):
    // ordinando tutto insieme vincerebbero sempre le vendute piu' lontane. In ogni casella
    // le migliori con V1 diversi (le varianti delle sole vendute si somigliano troppo).
    const scadenze = [...new Set(base.map(c => c.scadenza))].sort();
    const fasce = [[-38, -35], [-41, -38], [-44, -41]];
    const perCasella = Math.max(1, Math.floor((opz.massimo ?? 12) / Math.max(1, scadenze.length * fasce.length)));
    const scelti: Candidato[] = [];
    for (const sc of scadenze) for (const [lo, hi] of fasce) {
        const casella = base.filter(c => c.scadenza === sc && c.distVendutePct >= lo && c.distVendutePct < hi).sort((a, b) => punteggio(b) - punteggio(a));
        const visti = new Set<string>();
        for (const c of casella) {
            if (visti.size >= perCasella) break;
            const chiave = `${c.gambe[0].strike}/${c.gambe[2].strike}/${c.larghezzaV2}`;
            if (visti.has(chiave)) continue;
            visti.add(chiave);
            scelti.push({ ...c, id: scelti.length + 1 });
        }
    }
    return { candidati: scelti, provate };
}
