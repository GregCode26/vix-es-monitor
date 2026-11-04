/**
 * Il profilo GEX per strike di /api/gex, per la pagina spx-gamma-v2.
 *
 * Fino al 03/11/2026 la pagina non lo leggeva: le barre del riquadro a destra
 * erano vuote e i quattro livelli LONG/SHORT/CALL/PUT stavano tutti sullo
 * strike ATM come segnaposto.
 *
 * `?flow=0` perche' le bolle del flusso sono il 95% della risposta e qui non
 * si disegnano; dopo il primo giro `?since=`, perche' senza ogni chiamata
 * scarica la sessione intera da Supabase (12-17 MB a fine giornata, vedi
 * CLAUDE.md sull'egress). Il `profile` di una risposta incrementale e' gia'
 * il totale di giornata e sostituisce quello che c'e'.
 */

export interface RigaProfilo {
  strike: number;
  /** Pesato per open interest: posizionamento, il GEX canonico. */
  gexOi: number;
}

/** Il profilo ogni 2 minuti, come lo manda la rotta (`serie`). */
interface FotoProfilo {
  time: string;
  gexOi: number[];
}

export interface DatiGex {
  /** Il profilo piu' recente. */
  profilo: RigaProfilo[];
  /** Gli strike delle colonne di `serie`. */
  strikes: number[];
  /** Solo dal caricamento completo: con `since` la rotta non la ricostruisce. */
  serie: FotoProfilo[];
}

export class GexProvider {
  private ultimoOrario: string | null = null;
  private dati: DatiGex = { profilo: [], strikes: [], serie: [] };
  public avviso: string | null = null;

  /** `data` = giornata passata (YYYY-MM-DD) da leggere una volta sola dai file locali. */
  constructor(private data: string | null = null) {}

  /** Aggiorna; restituisce i dati nuovi, o null se non e' cambiato niente. */
  public async aggiorna(): Promise<DatiGex | null> {
    if (this.data && this.ultimoOrario) return null; // giornata chiusa: basta il primo giro
    const parametri = new URLSearchParams({ flow: "0" });
    if (this.data) parametri.set("date", this.data);
    else if (this.ultimoOrario) parametri.set("since", this.ultimoOrario);

    try {
      const res = await fetch(`/api/gex?${parametri}`, { cache: "no-store" });
      if (res.status === 503) {
        // Il poller dei volumi non ha ancora gamma: prima dell'apertura e'
        // la risposta normale.
        this.avviso = "GEX non disponibile: poller volumi fuori orario";
        return null;
      }
      if (!res.ok) {
        this.avviso = `/api/gex ha risposto ${res.status}`;
        return null;
      }
      const risposta = await res.json();
      if (typeof risposta.lastTime === "string") this.ultimoOrario = risposta.lastTime;
      const righe: RigaProfilo[] = Array.isArray(risposta.profile) ? risposta.profile : [];
      if (righe.length === 0) return null;
      const incrementale = parametri.has("since");
      this.dati = {
        profilo: righe.map((r) => ({ strike: r.strike, gexOi: r.gexOi })).sort((a, b) => a.strike - b.strike),
        strikes: incrementale ? this.dati.strikes : Array.isArray(risposta.strikes) ? risposta.strikes : [],
        serie: incrementale ? this.dati.serie : Array.isArray(risposta.serie) ? risposta.serie : [],
      };
      this.avviso = null;
      return this.dati;
    } catch {
      this.avviso = "/api/gex non raggiungibile";
      return null;
    }
  }
}

/**
 * Il profilo com'era a un orario ('HH:MM:SS'), dalla serie a 2 minuti.
 *
 * Serve per rivedere una giornata: il profilo "finale" e' tutto a zero,
 * perche' dopo la scadenza delle 0DTE il gamma vale zero (02/11/2026: 77
 * strike, tutti 0 alle 22:00). Senza orario si prende l'ultima fotografia in
 * cui il gamma c'era ancora.
 */
export function profiloAlle(dati: DatiGex, ora: string | null): RigaProfilo[] {
  if (dati.serie.length === 0 || dati.strikes.length === 0) return dati.profilo;
  let scelta: FotoProfilo | null = null;
  for (const foto of dati.serie) {
    if (ora !== null && foto.time > ora) break;
    if (ora !== null || foto.gexOi.some((v) => v !== 0)) scelta = foto;
  }
  if (!scelta) return [];
  return dati.strikes.map((strike, i) => ({ strike, gexOi: scelta.gexOi[i] ?? 0 }));
}

/**
 * Gli strike col GEX OI piu' positivo e piu' negativo, in prezzi SPX.
 *
 * Stessa definizione di Major Pos/Neg Gamma in /spx-gamma. Niente Zero
 * Gamma: con 0DTE e 37+40 strike la catena e' troppo incompleta per
 * calcolarlo (vedi CLAUDE.md).
 */
export function livelliDi(righe: RigaProfilo[]): { positivo: number | null; negativo: number | null; totale: number } {
  let positivo: RigaProfilo | null = null;
  let negativo: RigaProfilo | null = null;
  let totale = 0;
  for (const r of righe) {
    totale += r.gexOi;
    if (r.gexOi > 0 && (!positivo || r.gexOi > positivo.gexOi)) positivo = r;
    if (r.gexOi < 0 && (!negativo || r.gexOi < negativo.gexOi)) negativo = r;
  }
  return { positivo: positivo?.strike ?? null, negativo: negativo?.strike ?? null, totale };
}
