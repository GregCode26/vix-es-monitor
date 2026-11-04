/**
 * Zero Gamma di SPX dalla catena completa delle opzioni Cboe (ritardata di
 * 15 minuti, gratuita): https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json
 * (~13 MB, ~30.000 contratti di tutte le scadenze con open interest, volume,
 * IV e gamma).
 *
 * Perche' qui e non dai nostri dati: il poller dei volumi segue solo lo 0DTE
 * e ~77 strike, e lo Zero Gamma calcolato da li' sbagliava di 5-15 punti
 * (tolto il 05/10/2026, vedi CLAUDE.md). La catena Cboe e' intera.
 *
 * Varianti, tutte salvate per il confronto con il valore di GEXBot che
 * l'utente inserisce a mano:
 *  - `volStrike` (principale): il punto vicino allo spot in cui il profilo per
 *    strike, gamma Cboe x VOLUME di oggi (call +, put -), cambia segno. Il
 *    03/11/2026 alle 9:58 ET dava 7.554,3 contro 7.555 di GEXBot: la loro
 *    definizione sembra questa. Un confronto solo: va verificato.
 *  - `volStrike0dte`: lo stesso sul solo 0DTE.
 *  - `volSweep`: lo spot a cui il GEX totale pesato sul volume si annulla,
 *    rivalutando il gamma (Black-Scholes) a spot diversi.
 *  - `oiSweep`: lo stesso pesato sull'open interest, la definizione classica
 *    (SqueezeMetrics/perfiliev). Lo stesso giorno: 7.652.
 *  - `oiSweep0dte`: il classico sul solo 0DTE (7.609).
 */

export const URL_CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json';

interface OpzioneCboe {
  option: string;
  iv: number;
  open_interest: number;
  volume: number;
  gamma: number;
}

export interface ZeroGammaCboe {
  /** Ora della catena Cboe, ISO UTC. */
  istante: string;
  /** La stessa in ora di Roma 'HH:MM:SS'. */
  ora: string;
  spot: number;
  principale: number | null;
  varianti: {
    volStrike: number | null;
    volStrike0dte: number | null;
    volSweep: number | null;
    oiSweep: number | null;
    oiSweep0dte: number | null;
  };
  /** GEX totale allo spot in miliardi $ per 1%, pesato sul volume e sull'open interest. */
  gexVolB: number;
  gexOiB: number;
  contratti: number;
}

interface Opzione {
  call: boolean;
  strike: number;
  anni: number;
  iv: number;
  oi: number;
  vol: number;
  gamma: number;
  oggi: boolean;
}

/** Scarto in minuti di un fuso da UTC in un istante (come in lib/orarioNy.ts). */
function scarto(fuso: string, istante: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(istante).map((x) => [x.type, x.value]),
  );
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - istante.getTime()) / 60000);
}

/** Istante UTC di un'ora di New York in una data. */
function istanteNy(anno: number, mese: number, giorno: number, ora: number, minuti: number): number {
  const ingenuo = Date.UTC(anno, mese - 1, giorno, ora, minuti);
  return ingenuo - scarto('America/New_York', new Date(ingenuo)) * 60000;
}

function gammaBs(S: number, K: number, T: number, v: number): number {
  if (T <= 0 || v <= 0) return 0;
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / sq;
  return Math.exp(-0.5 * d1 * d1) / (S * sq * Math.sqrt(2 * Math.PI));
}

function leggi(json: unknown): { istante: number; spot: number; opzioni: Opzione[] } | null {
  const j = json as { timestamp?: string; data?: { current_price?: number; options?: OpzioneCboe[] } };
  const spot = j?.data?.current_price;
  const lista = j?.data?.options;
  if (!j?.timestamp || !spot || !Array.isArray(lista)) return null;
  // "2026-11-03 14:58:21": UTC (le ultime contrattazioni nella catena sono di 15 minuti prima, in ET).
  const istante = Date.parse(j.timestamp.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(istante)) return null;
  const nyOggi = new Date(istante + scarto('America/New_York', new Date(istante)) * 60000);
  const oggi = [nyOggi.getUTCFullYear() % 100, nyOggi.getUTCMonth() + 1, nyOggi.getUTCDate()];

  const opzioni: Opzione[] = [];
  for (const o of lista) {
    const m = /^(SPXW?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(o.option ?? '');
    if (!m) continue;
    const [, radice, aa, mm, gg, tipo, k] = m;
    // SPXW scade alle 16:00 ET, i mensili SPX al settlement AM delle 9:30.
    const [h, mi] = radice === 'SPXW' ? [16, 0] : [9, 30];
    const scadenza = istanteNy(2000 + +aa, +mm, +gg, h, mi);
    const anni = (scadenza - istante) / (365 * 86400_000);
    if (anni <= 0 || !(o.iv > 0 && o.iv < 5)) continue;
    opzioni.push({
      call: tipo === 'C',
      strike: +k / 1000,
      anni,
      iv: o.iv,
      oi: o.open_interest || 0,
      vol: o.volume || 0,
      gamma: o.gamma || 0,
      oggi: +aa === oggi[0] && +mm === oggi[1] && +gg === oggi[2],
    });
  }
  return { istante, spot, opzioni };
}

/** Il cambio di segno del profilo per strike (gamma Cboe x peso) piu' vicino allo spot, entro 60 punti. */
function cambioPerStrike(opz: Opzione[], spot: number, peso: 'vol' | 'oi'): number | null {
  const prof = new Map<number, number>();
  for (const o of opz) {
    const w = peso === 'vol' ? o.vol : o.oi;
    if (!w) continue;
    const g = o.gamma * w * 100 * spot * spot * 0.01;
    prof.set(o.strike, (prof.get(o.strike) ?? 0) + (o.call ? g : -g));
  }
  const ks = [...prof.keys()].filter((k) => Math.abs(k - spot) <= 60).sort((a, b) => a - b);
  let migliore: number | null = null;
  for (let i = 1; i < ks.length; i++) {
    const a = prof.get(ks[i - 1])!;
    const b = prof.get(ks[i])!;
    if (a === 0 || b === 0 || (a < 0) === (b < 0)) continue;
    const x = ks[i - 1] + ((ks[i] - ks[i - 1]) * -a) / (b - a);
    if (migliore === null || Math.abs(x - spot) < Math.abs(migliore - spot)) migliore = x;
  }
  return migliore;
}

/** Lo spot, entro +-5%, a cui il GEX totale ricalcolato si annulla; il piu' vicino allo spot. */
function cambioSweep(opz: Opzione[], spot: number, peso: 'vol' | 'oi'): number | null {
  const sel = opz.filter((o) => (peso === 'vol' ? o.vol : o.oi) > 0 && o.strike > spot * 0.8 && o.strike < spot * 1.2);
  if (sel.length === 0) return null;
  const totale = (S: number) => {
    let t = 0;
    for (const o of sel) {
      const g = gammaBs(S, o.strike, o.anni, o.iv) * (peso === 'vol' ? o.vol : o.oi) * 100 * S * S * 0.01;
      t += o.call ? g : -g;
    }
    return t;
  };
  let migliore: number | null = null;
  let xa = spot * 0.95;
  let ya = totale(xa);
  for (let i = 1; i <= 200; i++) {
    const xb = spot * (0.95 + i * 0.0005);
    const yb = totale(xb);
    if (ya !== 0 && yb !== 0 && (ya < 0) !== (yb < 0)) {
      const x = xa + ((xb - xa) * -ya) / (yb - ya);
      if (migliore === null || Math.abs(x - spot) < Math.abs(migliore - spot)) migliore = x;
    }
    xa = xb;
    ya = yb;
  }
  return migliore;
}

function gexAlloSpot(opz: Opzione[], spot: number, peso: 'vol' | 'oi'): number {
  let t = 0;
  for (const o of opz) {
    const g = o.gamma * (peso === 'vol' ? o.vol : o.oi) * 100 * spot * spot * 0.01;
    t += o.call ? g : -g;
  }
  return t / 1e9;
}

const arrotonda = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export function calcolaZeroGamma(json: unknown): ZeroGammaCboe | null {
  const dati = leggi(json);
  if (!dati || dati.opzioni.length === 0) return null;
  const { istante, spot, opzioni } = dati;
  const zeroDte = opzioni.filter((o) => o.oggi);
  const varianti = {
    volStrike: arrotonda(cambioPerStrike(opzioni, spot, 'vol')),
    volStrike0dte: arrotonda(cambioPerStrike(zeroDte, spot, 'vol')),
    volSweep: arrotonda(cambioSweep(opzioni, spot, 'vol')),
    oiSweep: arrotonda(cambioSweep(opzioni, spot, 'oi')),
    oiSweep0dte: arrotonda(cambioSweep(zeroDte, spot, 'oi')),
  };
  const ora = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(istante));
  return {
    istante: new Date(istante).toISOString(),
    ora,
    spot: Math.round(spot * 100) / 100,
    principale: varianti.volStrike,
    varianti,
    gexVolB: Math.round(gexAlloSpot(opzioni, spot, 'vol') * 100) / 100,
    gexOiB: Math.round(gexAlloSpot(opzioni, spot, 'oi') * 100) / 100,
    contratti: opzioni.length,
  };
}
