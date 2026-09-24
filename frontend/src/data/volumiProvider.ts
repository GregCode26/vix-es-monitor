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

export class VolumiProvider {
  private motore = new MotoreFlussoGamma();
  private ultimoOrario: string | null = null;
  private todayMs: number;
  /** Perche' non c'e' niente da mostrare, se non c'e'. */
  public avviso: string | null = null;

  constructor() {
    const oggi = new Date();
    oggi.setHours(0, 0, 0, 0);
    this.todayMs = oggi.getTime();
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
    const da = this.ultimoOrario ? `?since=${encodeURIComponent(this.ultimoOrario)}` : "";
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
