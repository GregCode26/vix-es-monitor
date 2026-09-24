/**
 * VOLFLOW 0-100 Engine
 *
 * Indicatore di pressione opzioni ATM in tempo reale
 * Combina: Price, IV, Gamma + Accelerazioni
 * Output: Valore 0-100 dove 50 = equilibrio perfetto
 */

export interface VolflowInput {
  callPrice: number;
  putPrice: number;
  callIv: number;
  putIv: number;
  callGamma: number;
  putGamma: number;
  timestamp: number;
}

export interface VolflowOutput {
  volflow: number; // 0-100
  callPressure: number; // Z-scored
  putPressure: number; // Z-scored
  ivPressure: number;
  gammaPressure: number;
  raw: number; // Before sigmoid
  confidence: number; // 0-100
}

interface HistoryEntry {
  timestamp: number;
  input: VolflowInput;
  callPriceChange: number;
  putPriceChange: number;
  callIvChange: number;
  putIvChange: number;
  callGammaChange: number;
  putGammaChange: number;
  callPriceAccel: number;
  putPriceAccel: number;
  callIvAccel: number;
  putIvAccel: number;
  callGammaAccel: number;
  putGammaAccel: number;
  /** Il RAW smussato di questo punto: e' la memoria dell'EMA. */
  smoothedRaw: number;
}

export class VolflowEngine {
  private history: HistoryEntry[] = [];
  private maxHistory: number = 100; // Keep last 100 snapshots

  // Configuration
  /**
   * Pendenza della sigmoide finale.
   *
   * Era 8.0, un valore scelto a occhio: misurato sul vero (1.680 punti, 38
   * sessioni piu' oggi) il |raw| ha mediana 0.37 e p90 1.72, e con 8.0 meta'
   * esatta delle letture finiva sotto 5 o sopra 95. L'indicatore era di
   * fatto binario. A 2.0 le estreme tornano al 12% e due letture su tre
   * stanno fra 20 e 80.
   *
   * Non si scende al valore che porterebbe il p90 esatto a 90/100 perche' il
   * campione e' fatto delle code di sessione che i file locali conservano:
   * e' l'ora piu' mossa della giornata, quindi il |raw| vero di meta'
   * pomeriggio e' piu' piccolo di questo e una sigmoide tarata li'
   * schiaccerebbe tutto sul 50.
   *
   * 2.3 e' il valore che si accompagna a smoothing = 3 e lookback 60s (vedi
   * sotto): tiene le letture estreme all'8.7% e il salto medio fra due punti
   * a 13 (era 29 col confronto tick su tick).
   */
  private sensitivity: number = 2.3;
  /**
   * Lunghezza dell'EMA sul RAW, in punti (alpha = 2/(smoothing+1)).
   *
   * Era 1, cioe' alpha = 1: nessuno smoothing, ogni punto a 15 secondi
   * valeva per se'. Con i premi veri il valore saltava da 99 a 2 e ritorno
   * nel giro di un minuto. A 3 il salto medio scende da 28 a 24 punti.
   *
   * Piu' in la' non conviene: il rumore che resta e' quello del bid/ask che
   * balla sui mid a 15 secondi, e si toglie prendendo i dati piu' spesso,
   * non allungando la media.
   */
  private smoothing: number = 3.0;

  /**
   * Distanza, in millisecondi, del punto contro cui si misurano le variazioni.
   *
   * Prima si confrontava sempre col punto immediatamente precedente, a 15
   * secondi di distanza. Su una ATM 0DTE da pochi punti mezzo spread bid/ask
   * vale l'1.3% del mid (mediana su 38 sessioni): un solo tick del bid muove
   * il "prezzo" piu' di quanto lo muova il mercato in quindici secondi, e il
   * segnale finiva per misurare il rimbalzo del book.
   *
   * Quanto si vedeva a schermo, misurato: con lookback 15s l'indicatore
   * restava dallo stesso lato del 50 nel 28% dei casi, cioe' si ribaltava a
   * quasi ogni tick -- meno persistente di una monetina. A 60 secondi sale al
   * 57% e il salto medio fra due letture scende da 29 a 13 punti.
   */
  private lookbackMs: number = 60000;
  private zScoreClip: number = 3.0;

  // Weights
  private readonly WEIGHT_PRICE_PRESSURE = 0.30;
  private readonly WEIGHT_PRICE_ACCEL = 0.25;
  private readonly WEIGHT_IV_PRESSURE = 0.20;
  private readonly WEIGHT_IV_ACCEL = 0.10;
  private readonly WEIGHT_GAMMA_PRESSURE = 0.10;
  private readonly WEIGHT_GAMMA_ACCEL = 0.05;

  constructor(sensitivity: number = 2.3, smoothing: number = 3.0) {
    this.sensitivity = Math.max(0.1, Math.min(20, sensitivity));
    this.smoothing = Math.max(1, Math.min(50, smoothing));
  }

  /**
   * Calculate percentage change
   */
  private percentChange(current: number, previous: number): number {
    if (previous === 0) return 0;
    return (current - previous) / previous;
  }

  /**
   * Calculate Z-Score from array of values
   */
  private calculateZScore(value: number, values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    const zScore = (value - mean) / stdDev;

    // Clip outliers
    return Math.max(-this.zScoreClip, Math.min(this.zScoreClip, zScore));
  }

  /**
   * Sigmoid transformation: RAW → 0-100
   */
  private sigmoid(raw: number): number {
    const exponent = -this.sensitivity * raw;
    const clipped = Math.max(-100, Math.min(100, exponent));
    return 100 / (1 + Math.exp(clipped));
  }

  /**
   * Il punto piu' recente arretrato di almeno `lookbackMs`, o null se la
   * sessione non e' ancora cosi' lunga.
   */
  private riferimento(timestamp: number): HistoryEntry | null {
    const limite = timestamp - this.lookbackMs;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].timestamp <= limite) return this.history[i];
    }
    return null;
  }

  /** Tiene il punto in memoria senza contributo: serve a riempire il lookback. */
  private spingiNeutro(input: VolflowInput): void {
    this.history.push({
      timestamp: input.timestamp,
      input,
      callPriceChange: 0,
      putPriceChange: 0,
      callIvChange: 0,
      putIvChange: 0,
      callGammaChange: 0,
      putGammaChange: 0,
      callPriceAccel: 0,
      putPriceAccel: 0,
      callIvAccel: 0,
      putIvAccel: 0,
      callGammaAccel: 0,
      putGammaAccel: 0,
      smoothedRaw: 0,
    });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /**
   * Main calculation: input → VOLFLOW output
   */
  public calculate(input: VolflowInput): VolflowOutput {
    // Initialize first entry
    if (this.history.length === 0) {
      this.history.push({
        timestamp: input.timestamp,
        input,
        callPriceChange: 0,
        putPriceChange: 0,
        callIvChange: 0,
        putIvChange: 0,
        callGammaChange: 0,
        putGammaChange: 0,
        callPriceAccel: 0,
        putPriceAccel: 0,
        callIvAccel: 0,
        putIvAccel: 0,
        callGammaAccel: 0,
        putGammaAccel: 0,
        smoothedRaw: 0,
      });

      return {
        volflow: 50,
        callPressure: 0,
        putPressure: 0,
        ivPressure: 0,
        gammaPressure: 0,
        raw: 0,
        confidence: 0,
      };
    }

    // Il punto di riferimento e' quello di `lookbackMs` fa, non l'ultimo
    // arrivato: e' li' che sta la differenza fra misurare il mercato e
    // misurare il bid/ask che balla.
    const prev = this.riferimento(input.timestamp);

    // Finche' la sessione non e' abbastanza lunga da contenere un lookback
    // intero non si inventa un valore: si tiene il punto e si risponde
    // neutro, con confidenza nulla.
    if (!prev) {
      this.spingiNeutro(input);
      return { volflow: 50, callPressure: 0, putPressure: 0, ivPressure: 0, gammaPressure: 0, raw: 0, confidence: 0 };
    }

    // Calculate changes
    const callPriceChange = this.percentChange(input.callPrice, prev.input.callPrice);
    const putPriceChange = this.percentChange(input.putPrice, prev.input.putPrice);
    const callIvChange = input.callIv - prev.input.callIv;
    const putIvChange = input.putIv - prev.input.putIv;
    const callGammaChange = input.callGamma - prev.input.callGamma;
    const putGammaChange = input.putGamma - prev.input.putGamma;

    // Calculate accelerations
    const callPriceAccel = callPriceChange - prev.callPriceChange;
    const putPriceAccel = putPriceChange - prev.putPriceChange;
    const callIvAccel = callIvChange - prev.callIvChange;
    const putIvAccel = putIvChange - prev.putIvChange;
    const callGammaAccel = callGammaChange - prev.callGammaChange;
    const putGammaAccel = putGammaChange - prev.putGammaChange;

    // Store in history
    const entry: HistoryEntry = {
      timestamp: input.timestamp,
      input,
      callPriceChange,
      putPriceChange,
      callIvChange,
      putIvChange,
      callGammaChange,
      putGammaChange,
      callPriceAccel,
      putPriceAccel,
      callIvAccel,
      putIvAccel,
      callGammaAccel,
      putGammaAccel,
      smoothedRaw: 0, // riempito sotto, quando il RAW e' noto
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Collect historical values for Z-Score normalization
    const callPriceChanges = this.history.map((h) => h.callPriceChange);
    const putPriceChanges = this.history.map((h) => h.putPriceChange);
    const callIvChanges = this.history.map((h) => h.callIvChange);
    const putIvChanges = this.history.map((h) => h.putIvChange);
    const callGammaChanges = this.history.map((h) => h.callGammaChange);
    const putGammaChanges = this.history.map((h) => h.putGammaChange);
    const callPriceAccels = this.history.map((h) => h.callPriceAccel);
    const putPriceAccels = this.history.map((h) => h.putPriceAccel);
    const callIvAccels = this.history.map((h) => h.callIvAccel);
    const putIvAccels = this.history.map((h) => h.putIvAccel);
    const callGammaAccels = this.history.map((h) => h.callGammaAccel);
    const putGammaAccels = this.history.map((h) => h.putGammaAccel);

    // Calculate Z-Scores
    const zCallPriceChange = this.calculateZScore(callPriceChange, callPriceChanges);
    const zPutPriceChange = this.calculateZScore(putPriceChange, putPriceChanges);
    const zCallIvChange = this.calculateZScore(callIvChange, callIvChanges);
    const zPutIvChange = this.calculateZScore(putIvChange, putIvChanges);
    const zCallGammaChange = this.calculateZScore(callGammaChange, callGammaChanges);
    const zPutGammaChange = this.calculateZScore(putGammaChange, putGammaChanges);
    const zCallPriceAccel = this.calculateZScore(callPriceAccel, callPriceAccels);
    const zPutPriceAccel = this.calculateZScore(putPriceAccel, putPriceAccels);
    const zCallIvAccel = this.calculateZScore(callIvAccel, callIvAccels);
    const zPutIvAccel = this.calculateZScore(putIvAccel, putIvAccels);
    const zCallGammaAccel = this.calculateZScore(callGammaAccel, callGammaAccels);
    const zPutGammaAccel = this.calculateZScore(putGammaAccel, putGammaAccels);

    // Component calculations
    const pricePressure = 0.30 * zCallPriceChange - 0.30 * zPutPriceChange;
    const priceAcceleration = 0.25 * zCallPriceAccel - 0.25 * zPutPriceAccel;
    const ivPressure = 0.20 * zCallIvChange - 0.20 * zPutIvChange;
    const ivAcceleration = 0.10 * zCallIvAccel - 0.10 * zPutIvAccel;
    const gammaPressure = 0.10 * zCallGammaChange - 0.10 * zPutGammaChange;
    // Era 0.05 * zCallGammaChange - 0.05 * zPutGammaChange, cioe' gli stessi
    // termini della riga sopra: non un'accelerazione ma la pressure contata
    // una seconda volta, con il gamma che pesava 0.15 su una misura sola.
    const gammaAcceleration = 0.05 * zCallGammaAccel - 0.05 * zPutGammaAccel;

    // Raw signal
    const raw =
      pricePressure +
      priceAcceleration +
      ivPressure +
      ivAcceleration +
      gammaPressure +
      gammaAcceleration;

    // EMA sul RAW smussato del punto precedente.
    //
    // Prima si ricalcolava il RAW grezzo di `prev` con `calculateRaw()`, che
    // pero' lo rifaceva sulla finestra di z-score *aggiornata* (quella che
    // contiene gia' il punto nuovo): il valore di riferimento cambiava
    // all'indietro a ogni giro, e non essendo mai smussato l'EMA non aveva
    // memoria oltre un passo. Con smoothing = 1, alpha = 1 e la riga non si
    // vedeva; da 2 in su falsava tutto.
    const alpha = 2 / (this.smoothing + 1);
    const smoothedRaw = alpha * raw + (1 - alpha) * prev.smoothedRaw;
    entry.smoothedRaw = smoothedRaw;

    // Transform to 0-100
    const volflow = this.sigmoid(smoothedRaw);

    // Calculate confidence (0-100)
    const confidence = Math.min(100, (this.history.length / this.maxHistory) * 100);

    return {
      volflow: Math.round(volflow * 100) / 100, // Round to 2 decimals
      callPressure: Math.round(pricePressure * 100) / 100,
      putPressure: Math.round(-pricePressure * 100) / 100,
      ivPressure: Math.round(ivPressure * 100) / 100,
      gammaPressure: Math.round(gammaPressure * 100) / 100,
      raw: Math.round(smoothedRaw * 100) / 100,
      confidence: Math.round(confidence),
    };
  }

  // Getters for configuration
  public setSensitivity(value: number) {
    this.sensitivity = Math.max(0.1, Math.min(20, value));
  }

  public setSmoothing(value: number) {
    this.smoothing = Math.max(1, Math.min(50, value));
  }

  public getHistory() {
    return [...this.history];
  }

  public getSensitivity() {
    return this.sensitivity;
  }

  public getSmoothing() {
    return this.smoothing;
  }

  /** In secondi: e' cosi' che si ragiona guardando il grafico. */
  public setLookbackSeconds(value: number) {
    this.lookbackMs = Math.max(15, Math.min(600, value)) * 1000;
  }

  public getLookbackSeconds() {
    return this.lookbackMs / 1000;
  }
}
