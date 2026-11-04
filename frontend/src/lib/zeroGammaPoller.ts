import fs from 'fs';
import path from 'path';
import { oraRomaDaNy } from '@/lib/orarioNy';

/**
 * Zero Gamma di SPX in tempo reale dal poller volumi (file locale
 * frontend/data/volumes/YYYY-MM-DD.json), con la stessa definizione di GEXBot
 * ("gex by volume"): profilo per strike gamma × (call − put scambiate oggi),
 * cambio di segno piu' vicino allo spot entro ±60 punti, interpolato fra i
 * due strike. Il 04/11/2026, su 21 orari 9:31-14:19 ET, e' stato entro ~1
 * punto dalla linea di GEXBot (7.697,0 contro 7.697,95 alle 14:19), senza i
 * 15 minuti di ritardo della catena Cboe. Bastano i 37 strike 0DTE del
 * poller: quel giorno la variante Cboe solo 0DTE coincideva con quella su
 * tutte le scadenze.
 *
 * Una lettura al minuto (l'ultimo snapshot di ogni minuto) dall'apertura cash
 * 9:30 NY: e' la "traccia nello storico" disegnata dalle pagine. Il file si
 * rilegge solo quando cambia (il poller lo sostituisce intero ogni ~10 s), e
 * al massimo ogni 20 s.
 */

interface RigaVolumi {
  strike: number;
  calls?: number | null;
  puts?: number | null;
  gamma?: number | null;
}

interface Snapshot {
  time: string;
  spxPrice?: number | null;
  undPrice?: number | null;
  volumes?: RigaVolumi[];
}

/** [ora di Roma 'HH:MM:SS', Zero Gamma SPX] */
export type PuntoZeroGamma = [string, number];

const ENTRO_PUNTI = 60;
const RILETTURA_MS = 20_000;

export function zeroGammaSnapshot(s: Snapshot): number | null {
  const spot = s.spxPrice || s.undPrice;
  if (!spot || !s.volumes) return null;
  const prof = new Map<number, number>();
  for (const r of s.volumes) {
    if (!r.gamma) continue;
    prof.set(r.strike, r.gamma * ((r.calls ?? 0) - (r.puts ?? 0)));
  }
  const ks = [...prof.keys()].filter((k) => Math.abs(k - spot) <= ENTRO_PUNTI).sort((a, b) => a - b);
  let migliore: number | null = null;
  for (let i = 1; i < ks.length; i++) {
    const a = prof.get(ks[i - 1])!;
    const b = prof.get(ks[i])!;
    if (a === 0 || b === 0 || (a < 0) === (b < 0)) continue;
    const x = ks[i - 1] + ((ks[i] - ks[i - 1]) * -a) / (b - a);
    if (migliore === null || Math.abs(x - spot) < Math.abs(migliore - spot)) migliore = x;
  }
  return migliore === null ? null : Math.round(migliore * 10) / 10;
}

function fileVolumi(giorno: string): string {
  const cwd = process.cwd();
  const radice = fs.existsSync(path.join(cwd, 'frontend', 'package.json')) ? path.join(cwd, 'frontend') : cwd;
  return path.join(radice, 'data', 'volumes', `${giorno}.json`);
}

let cache: { giorno: string; mtime: number; letto: number; serie: PuntoZeroGamma[] } | null = null;

/** La traccia di oggi, una lettura al minuto dall'apertura cash. Vuota senza file (es. Vercel). */
export function serieZeroGammaPoller(giorno: string): PuntoZeroGamma[] {
  if (process.env.VERCEL) return [];
  if (cache && cache.giorno === giorno && Date.now() - cache.letto < RILETTURA_MS) return cache.serie;
  const file = fileVolumi(giorno);
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return cache?.giorno === giorno ? cache.serie : [];
  }
  if (cache && cache.giorno === giorno && cache.mtime === mtime) {
    cache.letto = Date.now();
    return cache.serie;
  }
  let snapshots: Snapshot[];
  try {
    const dati = JSON.parse(fs.readFileSync(file, 'utf-8'));
    snapshots = Array.isArray(dati) ? dati : [];
  } catch {
    // File a meta' (non dovrebbe: il poller fa os.replace) o illeggibile: si tiene l'ultima.
    return cache?.giorno === giorno ? cache.serie : [];
  }
  const apertura = oraRomaDaNy('09:30', new Date(`${giorno}T12:00:00`)); // il giorno chiesto: l'ora legale cambia
  const perMinuto = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (!s.time || s.time < apertura) continue;
    perMinuto.set(s.time.slice(0, 5), s); // l'ultimo di ogni minuto
  }
  const serie: PuntoZeroGamma[] = [];
  for (const s of perMinuto.values()) {
    const v = zeroGammaSnapshot(s);
    if (v !== null) serie.push([s.time, v]);
  }
  serie.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  cache = { giorno, mtime, letto: Date.now(), serie };
  return serie;
}
