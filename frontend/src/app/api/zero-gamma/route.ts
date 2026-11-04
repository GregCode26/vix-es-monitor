import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { calcolaZeroGamma, URL_CBOE, type ZeroGammaCboe } from '@/lib/zeroGammaCboe';
import { serieZeroGammaPoller } from '@/lib/zeroGammaPoller';

export const dynamic = 'force-dynamic';

/**
 * Zero Gamma di SPX, da due fonti:
 *  - `manuale`: il valore che l'utente legge da GEXBot (Discord) e inserisce
 *    a mano con POST {valore}; l'ultimo vale, la lista resta per il confronto.
 *  - `poller`: la traccia in tempo reale dal nostro poller volumi, una lettura
 *    al minuto dall'apertura cash (lib/zeroGammaPoller.ts): stessa
 *    definizione di GEXBot, entro ~1 punto il 04/11/2026. E' quella che le
 *    pagine disegnano; Cboe resta come riserva quando il poller non c'e'.
 *  - `cboe`: calcolato qui dalla catena completa Cboe ritardata di 15 minuti
 *    (lib/zeroGammaCboe.ts). La catena pesa ~13 MB e si riscarica al massimo
 *    ogni 5 minuti durante il cash (ogni 30 fuori), con una sola richiesta in
 *    volo: tutti i chiamanti (pagine, Quantower) leggono la stessa cache.
 *
 * Ogni calcolo Cboe nuovo e ogni valore manuale si accodano a
 * `frontend/data/zero-gamma/YYYY-MM-DD.ndjson`, per verificare nei giorni
 * quale variante Cboe segue GEXBot. Solo oggi; niente Supabase (pochi byte,
 * ma serve solo in locale). Su Vercel il calcolo Cboe funziona, il manuale
 * vive solo in memoria.
 */

interface VoceManuale {
  ora: string;
  valore: number | null;
}

function cartella() {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'frontend', 'package.json'))
    ? path.join(cwd, 'frontend', 'data', 'zero-gamma')
    : path.join(cwd, 'data', 'zero-gamma');
}

function oggiRoma(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
}

function oraRoma(): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
}

/** Il cash di New York (con un quarto d'ora di margine, per il ritardo Cboe) in un giorno feriale. */
function inSessione(): boolean {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const min = +p.hour * 60 + +p.minute;
  return min >= 9 * 60 + 30 && min <= 16 * 60 + 30;
}

// ─── Stato in memoria ───
const manualePerGiorno = new Map<string, VoceManuale[]>();
let cache: { giorno: string; preso: number; dato: ZeroGammaCboe | null; errore: string | null } | null = null;
let inVolo: Promise<void> | null = null;
let ultimoIstanteSalvato: string | null = null;

function accoda(giorno: string, riga: object) {
  if (process.env.VERCEL) return;
  try {
    const dir = cartella();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${giorno}.ndjson`), JSON.stringify(riga) + '\n');
  } catch (e) {
    console.error('zero-gamma: scrittura fallita', e);
  }
}

/** Il manuale di oggi: dalla memoria, o ricostruito dal file del giorno dopo un riavvio. */
function manuale(giorno: string): VoceManuale[] {
  const inMemoria = manualePerGiorno.get(giorno);
  if (inMemoria) return inMemoria;
  const lista: VoceManuale[] = [];
  try {
    const testo = fs.readFileSync(path.join(cartella(), `${giorno}.ndjson`), 'utf-8');
    for (const riga of testo.split('\n')) {
      if (!riga.trim()) continue;
      const r = JSON.parse(riga);
      if (r.tipo === 'manuale') lista.push({ ora: r.ora, valore: r.valore });
      if (r.tipo === 'cboe' && r.istante) ultimoIstanteSalvato = r.istante;
    }
  } catch {
    // nessun file: oggi niente ancora
  }
  manualePerGiorno.set(giorno, lista);
  return lista;
}

async function aggiornaCboe(giorno: string) {
  try {
    const res = await fetch(URL_CBOE, {
      // Cboe risponde con un redirect a cdn-api.cboe.com: fetch lo segue da solo.
      headers: { 'User-Agent': 'Mozilla/5.0 (dashboard personale)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Cboe HTTP ${res.status}`);
    const dato = calcolaZeroGamma(await res.json());
    if (!dato) throw new Error('catena Cboe non leggibile');
    cache = { giorno, preso: Date.now(), dato, errore: null };
    if (dato.istante !== ultimoIstanteSalvato) {
      ultimoIstanteSalvato = dato.istante;
      // `ora` e' quella della catena Cboe; `salvato` quella in cui l'abbiamo calcolata.
      accoda(giorno, { tipo: 'cboe', salvato: oraRoma(), ...dato });
    }
  } catch (e) {
    // Si tiene l'ultimo valore buono, segnando l'errore.
    cache = { giorno, preso: Date.now(), dato: cache?.giorno === giorno ? cache.dato : null, errore: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(request: NextRequest) {
  // ?date= di un giorno passato: solo la traccia del poller, dal file locale dei volumi
  // (per execution/studio_conferma_range.py). Niente Cboe (e' solo l'ultima catena) ne' manuale.
  const passato = request.nextUrl.searchParams.get('date');
  if (passato && /^\d{4}-\d{2}-\d{2}$/.test(passato) && passato < oggiRoma()) {
    const serie = serieZeroGammaPoller(passato);
    return NextResponse.json({ date: passato, poller: serie.length > 0 ? { serie, ultimo: serie[serie.length - 1] } : null });
  }
  const giorno = oggiRoma();
  const lista = manuale(giorno);
  const ttl = inSessione() ? 5 * 60_000 : 30 * 60_000;
  const scaduta = !cache || cache.giorno !== giorno || Date.now() - cache.preso > ttl;
  const conCboe = request.nextUrl.searchParams.get('cboe') !== '0';
  if (conCboe && scaduta) {
    inVolo ??= aggiornaCboe(giorno).finally(() => { inVolo = null; });
    // Il primo calcolo del giorno si aspetta; dopo si risponde con la cache e si aggiorna dietro.
    if (!cache || cache.giorno !== giorno) await inVolo;
  }
  const ultimo = lista[lista.length - 1] ?? null;
  const serie = serieZeroGammaPoller(giorno);
  return NextResponse.json({
    date: giorno,
    manuale: ultimo && ultimo.valore !== null ? ultimo : null,
    storiaManuale: lista,
    poller: serie.length > 0 ? { serie, ultimo: serie[serie.length - 1] } : null,
    cboe: cache?.giorno === giorno ? cache.dato : null,
    erroreCboe: cache?.giorno === giorno ? cache.errore : null,
  });
}

/** {valore: number} imposta lo Zero Gamma manuale (prezzo SPX); {valore: null} lo toglie. */
export async function POST(request: NextRequest) {
  let body: { valore?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON non valido' }, { status: 400 });
  }
  const v = body.valore;
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 1000 || v > 20000)) {
    return NextResponse.json({ error: 'valore: un prezzo SPX (1000-20000) o null' }, { status: 400 });
  }
  const giorno = oggiRoma();
  const lista = manuale(giorno);
  const voce: VoceManuale = { ora: oraRoma(), valore: v === null ? null : Math.round((v as number) * 100) / 100 };
  lista.push(voce);
  // Il calcolo Cboe del momento accanto, per il confronto senza dover allineare gli orari dopo.
  const c = cache?.giorno === giorno ? cache.dato : null;
  const serie = serieZeroGammaPoller(giorno);
  accoda(giorno, {
    tipo: 'manuale', ...voce, fonte: 'gexbot',
    cboe: c ? { istante: c.istante, varianti: c.varianti, spot: c.spot } : null,
    poller: serie.length > 0 ? serie[serie.length - 1] : null,
  });
  return NextResponse.json({ ok: true, manuale: voce.valore === null ? null : voce });
}
