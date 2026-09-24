/**
 * RealDataProvider - dati veri, dalla stessa sorgente della pagina market.
 *
 * Nessuna fetch in piu' rispetto a quello che la market monitor gia' scarica:
 * `/api/market?history=true` una volta sola all'avvio, poi `/api/market`
 * (ultimo punto) a ogni giro. Sono le due identiche chiamate di
 * market/page.tsx (righe 1229 e 1027).
 *
 * Quella risposta porta gia' tutto quello che serve al VOLFLOW:
 *   - esf / spx / vwap          -> spot
 *   - callBid/Ask, putBid/Ask   -> premio ATM vero della chain SPX
 *   - esCallBid/Ask, esPutBid/Ask -> premio ATM vero della chain ES
 *   - esAtmStrike / spxAtmStrike  -> lo strike ATM scelto dal poller
 *   - esAtmIv                     -> IV ATM IBKR, in punti percentuali
 *
 * Quello che NON c'e' in questa sorgente e' il profilo per strike: niente
 * barre GEX e niente muri di gamma, che vivono in /api/volumes. Qui restano
 * vuoti invece di essere inventati: la versione precedente, quando i dati
 * mancavano, riempiva la pagina con Math.random() senza dirlo.
 */

import { AnalysisSnapshot, CandleData, MarketRegime } from "@/types/gamma";

interface PuntoMercato {
  time?: string;
  vix?: number | null;
  esf?: number | null;
  spx?: number | null;
  vwap?: number | null;
  callBid?: number | null;
  callAsk?: number | null;
  putBid?: number | null;
  putAsk?: number | null;
  esCallBid?: number | null;
  esCallAsk?: number | null;
  esPutBid?: number | null;
  esPutAsk?: number | null;
  esAtmStrike?: number | null;
  spxAtmStrike?: number | null;
  spxRef?: number | null;
  esAtmIv?: number | null;
}

/** Un punto gia' pronto per il motore VOLFLOW. */
export interface IngressoVolflow {
  callPrice: number;
  putPrice: number;
  callIv: number;
  putIv: number;
  callGamma: number;
  putGamma: number;
  timestamp: number;
}

/** Le due gambe ATM effettivamente quotate in un punto. */
interface GambeAtm {
  fonte: "SPX" | "ES";
  spot: number;
  strike: number;
  callMid: number;
  putMid: number;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && isFinite(v) && v > 0 ? v : null;

// --- Black-Scholes, r = 0 ------------------------------------------------
// A zero tassi la formula vale sia per l'indice sia per il future (Black-76
// con r = 0 e' la stessa cosa), quindi una sola implementazione copre SPX ed
// ES. Su 0DTE il carry e' comunque nell'ordine del centesimo di punto.

const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Approssimazione di Abramowitz-Stegun 26.2.17, errore < 7.5e-8. */
function normCdf(x: number): number {
  const segno = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + segno * y);
}

function d1di(S: number, K: number, T: number, sigma: number): number {
  return (Math.log(S / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
}

function prezzoBS(isCall: boolean, S: number, K: number, T: number, sigma: number): number {
  const d1 = d1di(S, K, T, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return isCall
    ? S * normCdf(d1) - K * normCdf(d2)
    : K * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * IV implicita per bisezione, in punti percentuali.
 *
 * Bisezione e non Newton: su 0DTE vicino alla scadenza vega crolla e Newton
 * diverge proprio quando serve. 80 giri su [1%, 500%] costano nulla una volta
 * ogni cinque secondi e non possono scappare.
 */
function ivImplicita(isCall: boolean, prezzo: number, S: number, K: number, T: number): number | null {
  const intrinseco = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  // Sotto l'intrinseco non esiste sigma che ci arrivi: quote stantia o
  // incrociata, meglio dichiararlo che restituire il fondo dell'intervallo.
  if (!(prezzo > intrinseco + 1e-6)) return null;

  let basso = 0.01;
  let alto = 5;
  if (prezzoBS(isCall, S, K, T, alto) < prezzo) return null; // fuori scala

  for (let i = 0; i < 80; i++) {
    const medio = (basso + alto) / 2;
    if (prezzoBS(isCall, S, K, T, medio) < prezzo) basso = medio;
    else alto = medio;
  }
  return ((basso + alto) / 2) * 100;
}

/** Gamma BS: uguale per call e put a parita' di sigma, diversa se la IV lo e'. */
function gammaBS(S: number, K: number, T: number, ivPerc: number): number {
  const sigma = ivPerc / 100;
  if (!(sigma > 0) || !(T > 0)) return 0;
  return normPdf(d1di(S, K, T, sigma)) / (S * sigma * Math.sqrt(T));
}

export class RealDataProvider {
  private candele: CandleData[] = [];
  private ultimoTsCandela = 0;
  private storicoCaricato = false;
  private todayMs: number;
  private atmIvPrecedente: number | null = null;
  /**
   * La sessione gia' trascorsa, pronta per il motore.
   *
   * Lo storico di /api/market porta le quote ATM riga per riga, non solo il
   * prezzo: ricalcolarle costa un'inversione a punto e riempie il riquadro
   * VOLFLOW sulla stessa finestra del grafico dei prezzi. Senza, il pannello
   * di sotto ripartiva vuoto a ogni ricaricamento mentre quello di sopra era
   * gia' pieno, e i due non potevano combaciare.
   */
  private storicoVolflow: IngressoVolflow[] = [];
  /** Ultimo motivo per cui un punto non era utilizzabile, per la UI. */
  public ultimoAvviso: string | null = null;

  constructor() {
    const oggi = new Date();
    oggi.setHours(0, 0, 0, 0);
    this.todayMs = oggi.getTime();
  }

  private oraInMs(timeStr?: string): number {
    if (!timeStr || typeof timeStr !== "string") return Date.now();
    const [h, m, s] = timeStr.split(":").map(Number);
    return this.todayMs + (h || 0) * 3600000 + (m || 0) * 60000 + (s || 0) * 1000;
  }

  /**
   * Anni alla scadenza 0DTE: le opzioni del giorno chiudono alle 22:00 CET.
   *
   * Il pavimento di cinque minuti evita che, nell'ultimo quarto d'ora, T -> 0
   * faccia esplodere IV e gamma verso l'infinito.
   */
  private tempoAScadenza(tsMs: number): number {
    const scadenza = this.todayMs + 22 * 3600000;
    const secondi = Math.max(300, (scadenza - tsMs) / 1000);
    return secondi / (365 * 24 * 3600);
  }

  async initialize(): Promise<void> {
    await this.caricaStorico();
  }

  /** Una sola volta: la serie del giorno, per non partire con il grafico vuoto. */
  private async caricaStorico(): Promise<void> {
    if (this.storicoCaricato) return;
    try {
      const res = await fetch("/api/market?history=true", { cache: "no-store" });
      if (!res.ok) return;
      const dati = await res.json();
      const storico: PuntoMercato[] = Array.isArray(dati?.history) ? dati.history : [];

      for (const p of storico) {
        const spot = num(p.esf) ?? num(p.spx);
        if (spot === null) continue;
        const ts = this.oraInMs(p.time);
        if (ts <= this.ultimoTsCandela) continue; // il poller ripete lo stesso orario
        this.candele.push({ timestamp: ts, open: spot, high: spot, low: spot, close: spot, volume: 0 });
        this.ultimoTsCandela = ts;

        const ing = this.ingresso(p, ts);
        if (ing) this.storicoVolflow.push(ing);
      }
      this.tagliaCandele();
      this.storicoCaricato = true;
      console.log(`[REAL] storico: ${this.candele.length} punti`);
    } catch (e) {
      console.error("[REAL] storico non caricato:", e);
    }
  }

  private tagliaCandele(): void {
    const MAX = 720; // ~3 ore a un punto ogni 15 secondi
    if (this.candele.length > MAX) this.candele = this.candele.slice(-MAX);
  }

  /**
   * Le gambe ATM da usare: SPX quando quota, altrimenti ES.
   *
   * La mattina presto la chain SPX non stampa ancora (a New York sono le
   * quattro) e il poller riempie solo le es*; nel pomeriggio ci sono
   * entrambe e si preferisce SPX, che e' il sottostante dello studio.
   */
  private gambe(p: PuntoMercato): GambeAtm | null {
    const spxSpot = num(p.spx) ?? num(p.spxRef);
    const spxStrike = num(p.spxAtmStrike);
    const cb = num(p.callBid), ca = num(p.callAsk), pb = num(p.putBid), pa = num(p.putAsk);
    if (spxSpot !== null && spxStrike !== null && cb !== null && ca !== null && pb !== null && pa !== null) {
      return { fonte: "SPX", spot: spxSpot, strike: spxStrike, callMid: (cb + ca) / 2, putMid: (pb + pa) / 2 };
    }

    const esSpot = num(p.esf);
    const esStrike = num(p.esAtmStrike);
    const ecb = num(p.esCallBid), eca = num(p.esCallAsk), epb = num(p.esPutBid), epa = num(p.esPutAsk);
    if (esSpot !== null && esStrike !== null && ecb !== null && eca !== null && epb !== null && epa !== null) {
      return { fonte: "ES", spot: esSpot, strike: esStrike, callMid: (ecb + eca) / 2, putMid: (epb + epa) / 2 };
    }

    return null;
  }

  /** Prezzi, IV per gamba e gamma di un punto, o null se non e' quotato. */
  private ingresso(p: PuntoMercato, ts: number): IngressoVolflow | null {
    const g = this.gambe(p);
    if (!g) return null;
    const T = this.tempoAScadenza(ts);
    const ivPoller = num(p.esAtmIv);
    const callIv = ivImplicita(true, g.callMid, g.spot, g.strike, T) ?? ivPoller;
    const putIv = ivImplicita(false, g.putMid, g.spot, g.strike, T) ?? ivPoller;
    if (callIv === null || putIv === null) return null;
    return {
      callPrice: g.callMid,
      putPrice: g.putMid,
      callIv,
      putIv,
      callGamma: gammaBS(g.spot, g.strike, T, callIv),
      putGamma: gammaBS(g.spot, g.strike, T, putIv),
      timestamp: ts,
    };
  }

  /** La sessione gia' passata, da far ripercorrere al motore all'avvio. */
  public getStoricoVolflow(): IngressoVolflow[] {
    return this.storicoVolflow;
  }

  async generateSnapshot(): Promise<AnalysisSnapshot | null> {
    await this.caricaStorico();

    let punto: PuntoMercato;
    try {
      const res = await fetch("/api/market", { cache: "no-store" });
      if (!res.ok) {
        // 404 = il poller non ha ancora scritto niente oggi: e' la risposta
        // normale prima dell'apertura, non un guasto.
        this.ultimoAvviso = res.status === 404 ? "nessun dato per oggi: poller fermo o sessione non iniziata" : `/api/market ha risposto ${res.status}`;
        return null;
      }
      punto = await res.json();
    } catch (e) {
      this.ultimoAvviso = "rete non raggiungibile";
      console.error("[REAL] fetch fallita:", e);
      return null;
    }

    const spot = num(punto.esf) ?? num(punto.spx);
    if (spot === null) {
      this.ultimoAvviso = "punto senza prezzo";
      return null;
    }

    const ts = this.oraInMs(punto.time);
    if (ts > this.ultimoTsCandela) {
      this.candele.push({ timestamp: ts, open: spot, high: spot, low: spot, close: spot, volume: 0 });
      this.ultimoTsCandela = ts;
      this.tagliaCandele();
    }

    const T = this.tempoAScadenza(ts);
    const gambe = this.gambe(punto);
    const ivPoller = num(punto.esAtmIv); // gia' in punti percentuali

    let callIv: number | null = null;
    let putIv: number | null = null;
    let atmCall: { price: number; iv: number; gamma: number } | undefined;
    let atmPut: { price: number; iv: number; gamma: number } | undefined;

    if (gambe) {
      // IV per gamba invertita dai premi veri: e' l'unico modo di avere call
      // e put separate, visto che esAtmIv e' gia' la media delle due.
      callIv = ivImplicita(true, gambe.callMid, gambe.spot, gambe.strike, T) ?? ivPoller;
      putIv = ivImplicita(false, gambe.putMid, gambe.spot, gambe.strike, T) ?? ivPoller;

      if (callIv !== null && putIv !== null) {
        atmCall = {
          price: gambe.callMid,
          iv: callIv,
          gamma: gammaBS(gambe.spot, gambe.strike, T, callIv),
        };
        atmPut = {
          price: gambe.putMid,
          iv: putIv,
          gamma: gammaBS(gambe.spot, gambe.strike, T, putIv),
        };
        this.ultimoAvviso = null;
      } else {
        this.ultimoAvviso = "IV non invertibile e esAtmIv assente";
      }
    } else {
      this.ultimoAvviso = "quote ATM assenti in questo punto: VOLFLOW fermo";
    }

    const atmIv =
      callIv !== null && putIv !== null ? (callIv + putIv) / 2 : ivPoller ?? 0;
    const ivMomentum = this.atmIvPrecedente !== null ? atmIv - this.atmIvPrecedente : 0;
    if (atmIv > 0) this.atmIvPrecedente = atmIv;

    const atm = gambe ? gambe.strike : Math.round(spot / 5) * 5;

    return {
      timestamp: ts,
      marketSnapshot: {
        timestamp: ts,
        spot,
        atmStrike: atm,
        date: new Date(ts).toISOString(),
      },
      // Il profilo per strike non e' in /api/market: niente catena finta.
      optionsChain: [],
      gammaMetrics: {
        spot,
        atm,
        // Muri di gamma e GEX totale stanno in /api/volumes: qui non si
        // inventano, si lasciano sull'ATM cosi' la pagina disegna una sola
        // riga di riferimento vera invece di quattro livelli immaginari.
        majorLongGamma: atm,
        majorShortGamma: atm,
        callGamma: atm,
        putGamma: atm,
        totalGex: 0,
        gammaPressure: 0,
        gammaMomentum: 0,
        volatilityPressure: 0,
        regime: MarketRegime.GAMMA_STABLE,
      },
      volatilityMetrics: {
        atmIv,
        callIv: callIv ?? 0,
        putIv: putIv ?? 0,
        ivSpread: callIv !== null && putIv !== null ? putIv - callIv : 0,
        ivMomentum,
      },
      // Copia: PriceChart ha `candles` fra le dipendenze dell'effetto, e con
      // lo stesso riferimento mutato il grafico non si ridisegnerebbe mai.
      priceCandles: [...this.candele],
      gexBars: [],
      atmCall,
      atmPut,
    };
  }
}

export async function createRealDataProvider(): Promise<RealDataProvider> {
  const provider = new RealDataProvider();
  await provider.initialize();
  return provider;
}
