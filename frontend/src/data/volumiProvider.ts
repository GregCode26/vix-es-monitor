/**
 * Legge /api/volumes e ne ricava la serie del flusso gamma.
 *
 * Si scarica in modo incrementale con `?since=`, come fanno le pagine
 * spx-volumes e gex: il primo giro porta la sessione, poi solo gli snapshot
 * nuovi (~2 KB ogni 15 secondi). Scaricare tutto ogni volta costava
 * centinaia di MB di egress al giorno, ed e' proprio il motivo per cui il
 * vecchio provider era stato scritto male.
 */

import { MotoreFlussoGamma, PuntoFlusso, SnapshotVolumi } from "@/engines/flussoGamma";
import { oraRomaDaNy } from "@/lib/orarioNy";

export class VolumiProvider {
  private motore = new MotoreFlussoGamma();
  private ultimoOrario: string | null = null;
  private todayMs: number;
  /** Perche' non c'e' niente da mostrare, se non c'e'. */
  public avviso: string | null = null;

  /**
   * Primo orario utile: l'apertura cash delle 9:30 di New York. Il poller
   * scrive gia' dalle 13:30 italiane (il 02/11/2026 dalle 14:06), quando SPX
   * e' fermo e i volumi sono quelli della notte: dentro lo z-score sporcavano
   * la base della prima mezz'ora.
   */
  private apertura: string;

  /** `data` (YYYY-MM-DD) per una giornata passata, letta una volta dal file locale. */
  constructor(private data: string | null = null) {
    const giorno = data ? new Date(`${data}T00:00:00`) : new Date();
    giorno.setHours(0, 0, 0, 0);
    this.todayMs = giorno.getTime();
    this.apertura = oraRomaDaNy("09:30", new Date(this.todayMs + 12 * 3600000));
  }

  private oraInMs(timeStr: string): number {
    const [h, m, s] = timeStr.split(":").map(Number);
    return this.todayMs + (h || 0) * 3600000 + (m || 0) * 60000 + (s || 0) * 1000;
  }

  /**
   * Gli snapshot arrivati dall'ultima chiamata, gia' trasformati in punti.
   *
   * Il motore tiene il proprio stato fra una chiamata e l'altra, quindi la
   * finestra a cavallo di due fetch non si perde.
   */
  public async nuoviPunti(): Promise<PuntoFlusso[]> {
    if (this.data && this.ultimoOrario) return []; // giornata chiusa: basta il primo giro
    const da = this.data
      ? `?date=${this.data}`
      : this.ultimoOrario ? `?since=${encodeURIComponent(this.ultimoOrario)}` : "";
    let dati: { history?: SnapshotVolumi[] };
    try {
      const res = await fetch(`/api/volumes${da}`, { cache: "no-store" });
      if (!res.ok) {
        this.avviso = `/api/volumes ha risposto ${res.status}`;
        return [];
      }
      dati = await res.json();
    } catch {
      this.avviso = "rete non raggiungibile";
      return [];
    }

    const storico = Array.isArray(dati.history) ? dati.history : [];
    if (storico.length === 0) {
      // Il poller dei volumi raccoglie solo fra le 13:30 e le 22:00: prima e'
      // la risposta normale, non un guasto.
      if (!this.ultimoOrario) this.avviso = "nessun volume per oggi: poller fermo o sessione non iniziata";
      return [];
    }

    const punti: PuntoFlusso[] = [];
    for (const snap of storico) {
      if (!snap.time) continue;
      if (this.ultimoOrario && snap.time <= this.ultimoOrario) continue;
      this.ultimoOrario = snap.time;
      if (snap.time < this.apertura) continue;
      const p = this.motore.aggiungi(snap, this.oraInMs(snap.time));
      if (p) punti.push(p);
    }

    if (punti.length > 0) this.avviso = null;
    return punti;
  }

  public get maturita(): number {
    return this.motore.maturita;
  }
}
