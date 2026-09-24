/**
 * FLUSSO GAMMA - pressione dalle opzioni realmente scambiate.
 *
 * Sostituisce il VOLFLOW, che misurava le variazioni dei premi ATM. Quella
 * costruzione aveva due difetti misurati sui dati veri:
 *
 *  - per la parita' put-call, C - P = S - K: le variazioni dei premi sono il
 *    movimento del prezzo al 95% (corr 0.953 su 1.283 intervalli da un
 *    minuto). I due termini di prezzo, il 55% del peso, rifacevano con piu'
 *    rumore la linea gia' disegnata sopra;
 *  - il poller ri-sceglie lo strike ATM nel 7.9% dei passaggi, e li' il
 *    premio "varia" di 2.38 punti contro 0.10 a strike fermo. Un salto 24
 *    volte piu' grande del segnale, che dominava gli z-score.
 *
 * Qui si guardano invece i contratti scambiati, strike per strike, pesati per
 * il loro gamma: e' la domanda di copertura che i dealer devono seguire, ed
 * e' l'unica cosa in questo progetto che sia risultata legata al movimento
 * successivo del prezzo.
 *
 * Correlazione col movimento del sottostante nel minuto successivo, misurata
 * su cinque sessioni complete: +0.226 grezzo, +0.182 nella forma qui sotto
 * (z-score piu' EMA), positiva in cinque sessioni su cinque. Non e' una
 * previsione -- 0.18 di correlazione spiega il 3% della varianza -- ma e' un
 * segnale vero, a differenza dello zero che davano tutte le costruzioni sui
 * premi.
 */

/** Una riga della catena come la manda /api/volumes. */
export interface RigaVolumi {
  strike: number;
  calls?: number | null;
  puts?: number | null;
  gamma?: number | null;
}

export interface SnapshotVolumi {
  time: string;
  volumes?: RigaVolumi[] | unknown;
}

export interface PuntoFlusso {
  timestamp: number;
  /** Il valore da disegnare, da -100 (put) a +100 (call). */
  valore: number;
  /** Flusso grezzo pesato gamma, prima della normalizzazione. */
  grezzo: number;
}

/**
 * Snapshot indietro su cui si misura il flusso.
 *
 * Gli snapshot arrivano ogni ~10 secondi, quindi 3 fanno mezzo minuto.
 * Misurato: 30s da' +0.226, un minuto +0.215, due minuti +0.155, cinque
 * +0.104. Piu' corto di cosi' non si puo' andare, meno di tre snapshot e si
 * finisce dentro il rumore di arrotondamento dei contatori.
 */
const FINESTRA_FLUSSO = 3;

/** Finestra del z-score: 180 snapshot, cioe' mezz'ora. */
const FINESTRA_ZSCORE = 180;

/** EMA da 3 punti (~30s): tiene +0.182 e porta il salto medio a 4.6 punti. */
const EMA_PUNTI = 3;

const CLIP = 3;

export class MotoreFlussoGamma {
  private storia: { timestamp: number; grezzo: number }[] = [];
  private catenaPrecedente: Map<number, { calls: number; puts: number }>[] = [];
  private emaPrecedente: number | null = null;

  /**
   * Il flusso pesato gamma fra due fotografie della catena.
   *
   * I volumi sono cumulativi di giornata (verificato: non decrescenti nel
   * 100% dei passaggi), quindi il flusso e' la differenza. Le differenze
   * negative si azzerano: capitano quando il poller riparte e il contatore
   * torna indietro, e non sono vendite.
   */
  private flussoFra(
    prima: Map<number, { calls: number; puts: number }>,
    dopo: RigaVolumi[],
  ): number {
    let netto = 0;
    for (const riga of dopo) {
      const pre = prima.get(riga.strike);
      if (!pre) continue;
      const gamma = riga.gamma ?? 0;
      if (!gamma) continue;
      const call = Math.max(0, (riga.calls ?? 0) - pre.calls);
      const put = Math.max(0, (riga.puts ?? 0) - pre.puts);
      netto += gamma * (call - put);
    }
    return netto;
  }

  private static indicizza(righe: RigaVolumi[]): Map<number, { calls: number; puts: number }> {
    const m = new Map<number, { calls: number; puts: number }>();
    for (const r of righe) m.set(r.strike, { calls: r.calls ?? 0, puts: r.puts ?? 0 });
    return m;
  }

  /**
   * Aggiunge uno snapshot e restituisce il punto da disegnare, se c'e'.
   *
   * Null finche' non ci sono abbastanza snapshot per chiudere la finestra.
   */
  public aggiungi(snapshot: SnapshotVolumi, timestamp: number): PuntoFlusso | null {
    const righe = Array.isArray(snapshot.volumes) ? (snapshot.volumes as RigaVolumi[]) : null;
    if (!righe || righe.length === 0) return null;

    this.catenaPrecedente.push(MotoreFlussoGamma.indicizza(righe));
    if (this.catenaPrecedente.length > FINESTRA_FLUSSO + 1) this.catenaPrecedente.shift();
    if (this.catenaPrecedente.length <= FINESTRA_FLUSSO) return null;

    const grezzo = this.flussoFra(this.catenaPrecedente[0], righe);

    this.storia.push({ timestamp, grezzo });
    if (this.storia.length > FINESTRA_ZSCORE) this.storia.shift();

    // z-score sulla mezz'ora: il flusso cambia scala fra l'apertura e le
    // ore morte, e senza normalizzare il pomeriggio sarebbe tutto piatto.
    const valori = this.storia.map((s) => s.grezzo);
    const media = valori.reduce((a, b) => a + b, 0) / valori.length;
    const varianza = valori.reduce((a, b) => a + (b - media) ** 2, 0) / valori.length;
    const sd = Math.sqrt(varianza);
    const z = sd === 0 ? 0 : Math.max(-CLIP, Math.min(CLIP, (grezzo - media) / sd));

    const alpha = 2 / (EMA_PUNTI + 1);
    const smussato = this.emaPrecedente === null ? z : alpha * z + (1 - alpha) * this.emaPrecedente;
    this.emaPrecedente = smussato;

    return {
      timestamp,
      valore: Math.round((smussato / CLIP) * 100 * 10) / 10,
      grezzo: Math.round(grezzo * 1000) / 1000,
    };
  }

  /** Quanti punti servono ancora prima che il valore sia significativo. */
  public get maturita(): number {
    return Math.min(100, Math.round((this.storia.length / 30) * 100));
  }
}
