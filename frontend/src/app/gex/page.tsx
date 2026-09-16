// frontend/src/app/gex/page.tsx
'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import {
  Chart as ChartJS,
  LinearScale,
  CategoryScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  LineController,
  ScatterController,
  Tooltip,
  TimeScale,
  Legend
} from 'chart.js';
import 'chartjs-adapter-date-fns';
import { leggiRefLines, leggiVisibilita, REF_LINES_KEY, REF_LINES_VIS_KEY } from '@/lib/refLines';

// Base registration (safe for SSR).
// I *Controller servono quanto gli Element: qui il grafico si costruisce a
// mano con `new ChartJS`, e chart.js e' tree-shakeable, quindi senza
// registrarli il primo dataset di tipo line fa morire il render con
// `"line" is not a registered controller`. Finora non si notava perche'
// react-chartjs-2 registra LineController quando /market monta il suo <Line>:
// arrivando su /gex dal menu il controller c'era gia', aprendo /gex di suo
// no.
ChartJS.register(
  LinearScale, CategoryScale, PointElement, LineElement,
  BarElement, BarController, LineController, ScatterController,
  Tooltip, TimeScale, Legend
);

/** Totale di giornata per strike, gia' cumulato dal server. */
interface ProfileRow {
  strike: number;
  gex: number;
  gexOi: number;
}

/**
 * Una fotografia del profilo cumulato, come la manda l'API: i valori sono
 * nell'ordine di `strikes`, dichiarato una volta sola.
 */
interface SerieFrame {
  time: string;
  gex: number[];
  gexOi: number[];
}

interface SpxHistoryPoint {
  time: string;
  spxPrice?: number | null;
  spx?: number | null;
  esf?: number | null;
}

/**
 * Fondo scala del disegno, in M$: il livello a cui una riga e' spessa e piena
 * quanto puo' essere.
 *
 * Non si ricava dallo snapshot corrente, ed e' il punto della faccenda. Prima
 * spessore e opacita' venivano da |gex| diviso il massimo del profilo di quel
 * momento: il livello piu' grande aveva percio' rapporto 1 dal primo minuto
 * della sessione e restava disegnato al massimo per tutto il pomeriggio,
 * quanto che crescesse; e quando crescevano tutti insieme, numeratore e
 * denominatore si muovevano insieme e non cambiava niente per nessuno. Con un
 * metro fermo, invece, un muro che raddoppia si vede raddoppiare.
 *
 * Le due basi non stanno sulla stessa scala -- su 0DTE il volume di giornata
 * vale una ventina di volte l'open interest -- quindi il fondo scala e' suo
 * per ciascuna. Sono numeri di comodo, tarati su quello che si vede a fine
 * sessione: se un giorno i livelli li superano, il metro si allunga da solo
 * (e non si accorcia piu' fino a domani), cosi' niente esce dal grafico.
 */
const FONDO_SCALA_M: Record<'volume' | 'oi', number> = { volume: 150000, oi: 10000 };

/**
 * Sotto questa quota una riga non si disegna. Si misura sul muro piu' grande
 * della sessione, non sul fondo scala: il fondo scala e' tarato sulla fine
 * della giornata (150.000 M$ in volume), e il 16/09/2026 alle 16:47 lo strike
 * piu' grande valeva 4.544 M$ -- quota 0,17 -- quindi non si vedeva nessuna
 * riga. Spessore e colore restano invece sul metro fisso.
 */
const SOGLIA_RIGA = 0.18;

/**
 * Ogni quanto il client allunga la storia del profilo. E' lo stesso passo con
 * cui la campiona il server, cosi' la fotografia che arriva al caricamento e
 * quelle che si aggiungono poi hanno la stessa densita'.
 */
const SERIE_STEP_SEC = 120;

interface LivelliRange {
  r1Up: number; r1Down: number;
  r2Up: number; r2Down: number;
  r3Up: number; r3Down: number;
}

/** Dai due gruppi che manda l'API alle chiavi piatte usate dal grafico. */
function chiaviRange(r: { morning?: LivelliRange | null; ob?: LivelliRange | null }): Record<string, string> {
  const out: Record<string, string> = {};
  const versa = (liv: LivelliRange | null | undefined, suffisso: string) => {
    if (!liv) return;
    (['r1Up', 'r1Down', 'r2Up', 'r2Down', 'r3Up', 'r3Down'] as const).forEach((k) => {
      out[`${k}${suffisso}`] = liv[k].toFixed(2);
    });
  };
  versa(r?.morning, '');
  versa(r?.ob, 'Ob');
  return out;
}

/**
 * Da che ora il grafico ha qualcosa da mostrare: e' l'inizio della finestra
 * del poller dei volumi (13:30 italiane), quindi prima di quest'ora non
 * esiste nessun gamma con cui confrontare il prezzo.
 */
const INIZIO_SESSIONE_SEC = 13 * 3600 + 30 * 60;

function secondiEt(hhmmss: string): number {
  const [h, m, sec] = hhmmss.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
}

/**
 * Ora italiana adesso, 'HH:MM:SS': la stessa che il poller scrive negli
 * snapshot, quindi confrontabile con i loro orari senza conversioni.
 *
 * Prima si toglievano sei ore fisse per passare a New York. Lo scarto pero'
 * non e' sempre sei: Europa e Stati Uniti cambiano l'ora in date diverse, e
 * per un paio di settimane l'anno il grafico sarebbe stato spostato di
 * un'ora. Passata la pagina all'ora italiana, il problema non si pone.
 */
function oraItalianaAdesso(): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
}

export default function GexPage() {
  const [profile, setProfile] = useState<ProfileRow[]>([]);
  // La storia del profilo: com'era il muro su ogni strike, istante per
  // istante. E' quello che una riga orizzontale non puo' dire, perche' ne
  // attraversa il grafico con un valore solo.
  const [serie, setSerie] = useState<SerieFrame[]>([]);
  const [strikesSerie, setStrikesSerie] = useState<number[]>([]);
  const [spxHistory, setSpxHistory] = useState<SpxHistoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'lines' | 'bars'>('lines');
  // Su cosa pesare il gamma: i contratti scambiati oggi (flusso) o le
  // posizioni aperte (posizionamento, il GEX canonico). Ogni punto porta
  // gia' entrambi i valori, quindi il cambio e' istantaneo.
  const [gexBasis, setGexBasis] = useState<'volume' | 'oi'>('volume');
  // La vista di partenza e' la sessione intera: da quando la pagina disegna
  // come i muri si sono costruiti, una finestra di cinque minuti nasconde
  // proprio la cosa che c'e' da guardare.
  const [timeWindow, setTimeWindow] = useState<number | 'all'>('all');
  const [isZoomed, setIsZoomed] = useState(false);
  const [pluginsReady, setPluginsReady] = useState(false);
  const [nowClock, setNowClock] = useState<Date>(() => new Date());
  // Ora di Roma dell'ultimo snapshot ricevuto, da rimandare come `since`.
  const lastGexTime = useRef<string | null>(null);
  const giornoSessione = useRef<string | null>(null);
  const [refLines, setRefLines] = useState<Record<string, string>>({});
  // Gli stessi livelli, ma calcolati dal server sullo storico di giornata.
  // Servono a chi non li ha nel proprio localStorage -- un altro browser, il
  // sito pubblicato -- e fanno da base: quelli locali, se ci sono, vincono.
  const [rangeServer, setRangeServer] = useState<Record<string, string>>({});
  const [refLineVisibility, setRefLineVisibility] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const rileggi = () => {
      const salvate = leggiRefLines();
      if (salvate) setRefLines(salvate);
      const vis = leggiVisibilita();
      if (vis) setRefLineVisibility(vis);
    };
    rileggi();

    // I livelli li scrive /market, e non necessariamente prima che questa
    // pagina si apra: con le due schede affiancate, applicare i range di
    // fianco lasciava il grafico del gamma senza linee finche' non lo si
    // ricaricava a mano. `storage` scatta nelle ALTRE schede della stessa
    // origine, ed e' esattamente il caso; il ritorno sulla scheda copre il
    // resto, compreso l'essere andati e tornati.
    const suStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === REF_LINES_KEY || e.key === REF_LINES_VIS_KEY) rileggi();
    };
    const suRitorno = () => { if (!document.hidden) rileggi(); };

    window.addEventListener('storage', suStorage);
    document.addEventListener('visibilitychange', suRitorno);
    window.addEventListener('focus', rileggi);
    return () => {
      window.removeEventListener('storage', suStorage);
      document.removeEventListener('visibilitychange', suRitorno);
      window.removeEventListener('focus', rileggi);
    };
  }, []);

  /**
   * Quelli che si disegnano: i livelli del server fanno da base, e ogni
   * valore presente in localStorage lo copre. Cosi' chi ha compilato il
   * pannello a mano continua a vedere i suoi numeri, e chi apre la pagina da
   * un'altra parte ne vede comunque di validi invece di niente.
   */
  const livelli = useMemo(() => {
    const uniti: Record<string, string> = { ...rangeServer };
    for (const [k, v] of Object.entries(refLines)) if (v) uniti[k] = v;
    return uniti;
  }, [rangeServer, refLines]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS | null>(null);
  const isUserZoomedRef = useRef(false);
  const prevLineDateRef = useRef<number>(0);
  const latestSpxHistory = useRef<SpxHistoryPoint[]>([]);
  const latestSerie = useRef<SerieFrame[]>([]);
  const latestStrikes = useRef<number[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowClock(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  latestSpxHistory.current = spxHistory;
  latestSerie.current = serie;
  latestStrikes.current = strikesSerie;

  // ─── Dynamic import of plugins (client-side only) ───
  useEffect(() => {
    Promise.all([
      import('chartjs-plugin-zoom'),
      import('chartjs-plugin-annotation'),
    ]).then(([zoomMod, annotationMod]) => {
      ChartJS.register(zoomMod.default, annotationMod.default);
      setPluginsReady(true);
    });
  }, []);

  // ─── Data fetching ───
  useEffect(() => {
    const fetchGexData = async () => {
      try {
        // `flow=0`: le bolle del flusso non si disegnano piu', e quelle
        // bolle erano l'unica cosa che usasse `points`. Erano il 95% della
        // risposta -- mezzo megabyte a fine sessione -- per dati che ora
        // nessuno guarda.
        const since = lastGexTime.current;
        const q = new URLSearchParams({ flow: '0' });
        if (since) q.set('since', since);
        const res = await fetch(`/api/gex?${q}`, { cache: 'no-store' });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || 'Failed to load GEX data');
        }
        const json = await res.json();

        // Cambio di giornata: si riparte da zero, senza `since`. Senza questo
        // il cursore restava all'ultimo snapshot di ieri sera e per tutto
        // oggi la pagina scartava quello che arrivava prima di quell'ora.
        if (json.date && giornoSessione.current && json.date !== giornoSessione.current) {
          giornoSessione.current = json.date;
          lastGexTime.current = null;
          setProfile([]);
          setSerie([]);
          setStrikesSerie([]);
          // Il metro non si eredita dal giorno prima: torna al nominale e
          // ricomincia a crescere con la sessione nuova.
          fondoScala.current = { ...FONDO_SCALA_M };
          return;
        }
        if (json.date) giornoSessione.current = json.date;

        if (json.lastTime) lastGexTime.current = json.lastTime;

        // La storia del profilo arriva intera solo al primo caricamento: con
        // `since` la finestra e' larga pochi secondi e non conterrebbe niente.
        // Da li' in poi la allunga il client, una fotografia ogni due minuti,
        // usando il cumulato che riceve comunque a ogni giro.
        if (!since) {
          if (Array.isArray(json.strikes) && json.strikes.length > 0) setStrikesSerie(json.strikes);
          if (Array.isArray(json.serie)) setSerie(json.serie);
        } else {
          // L'ora di New York dell'ultimo snapshot e' quella dell'ultimo punto
          // di spot: `lastTime` e' ora di Roma e serve solo come cursore.
          const spotIn: { time: string }[] = json.spot ?? [];
          const oraEt = spotIn.length > 0 ? spotIn[spotIn.length - 1].time : null;
          const profiloIn: ProfileRow[] = json.profile ?? [];
          if (oraEt && profiloIn.length > 0) {
            setSerie((prec) => {
              const ultima = prec[prec.length - 1];
              if (ultima && secondiEt(oraEt) - secondiEt(ultima.time) < SERIE_STEP_SEC) return prec;
              const strikes = latestStrikes.current;
              if (strikes.length === 0) return prec;
              const mappa = new Map(profiloIn.map((r) => [r.strike, r]));
              return [...prec, {
                time: oraEt,
                gex: strikes.map((k) => Math.round(mappa.get(k)?.gex ?? 0)),
                gexOi: strikes.map((k) => Math.round(mappa.get(k)?.gexOi ?? 0)),
              }];
            });
          }
        }

        // Il profilo e' gia' il totale di giornata: si sostituisce, non si somma.
        const nuovoProfilo: ProfileRow[] = json.profile ?? [];
        if (nuovoProfilo.length > 0) setProfile(nuovoProfilo);
        setError(null);
      } catch (e: any) {
        setError(e.message || 'Error');
      }
    };
    const fetchSpxData = async () => {
      try {
        const res = await fetch('/api/market?history=true', { cache: 'no-store' });
        if (res.ok) {
          const json = await res.json();
          if (json.history?.length > 0) {
            // Nessuna conversione: /api/market scrive gia' l'ora italiana, la
            // stessa del gamma. Qui prima si toglievano sei ore a mano per
            // portare la linea del prezzo a New York -- ed erano sei fisse,
            // quindi sbagliate nelle settimane in cui i due cambi d'ora non
            // coincidono. Restava anche l'ultima cosa in orario americano
            // sulla pagina, e in "Profile Bars", dove l'unica serie sul tempo
            // e' proprio il prezzo, faceva sembrare che non fosse cambiato
            // niente.
            //
            // La finestra parte dalle 13:30, quando comincia a raccogliere il
            // poller dei volumi: cosi' l'asse copre lo stesso tratto del
            // gamma invece di allargarsi su ore in cui non c'e' nient'altro.
            if (json.range) setRangeServer(chiaviRange(json.range));
            setSpxHistory(
              json.history
                .filter((p: { time?: string; spx?: number | null; esf?: number | null }) => {
                  if (!p.time || (p.spx == null && p.esf == null)) return false;
                  return secondiEt(p.time) >= INIZIO_SESSIONE_SEC;
                })
                .map((p: { time: string; spx?: number | null; esf?: number | null }) => ({
                  time: p.time,
                  spxPrice: p.spx ?? p.esf,
                  spx: p.spx,
                  esf: p.esf,
                }))
            );
          }
        }
      } catch (e) {
        console.error('Failed to load SPX price history:', e);
      }
    };
    fetchGexData();
    fetchSpxData();
    const interval = setInterval(() => { fetchGexData(); fetchSpxData(); }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ─── Derived data ───
  // `latestDataTime` stava qui: calcolato a ogni aggiornamento e mai letto da
  // nessuno. Non era solo peso morto -- faceva `Math.max(...punti)`, e lo
  // spread passa un argomento per elemento: oltre qualche decina di migliaia
  // di punti lo stack finisce e la pagina muore con una eccezione
  // client-side, che e' esattamente come si presentava il guasto.
  // Gli spread rimasti qui sotto lavorano su array corti e delimitati (37
  // strike, i livelli di riferimento), non sulla serie dei punti.

  const gexProfile = useMemo(() => {
    // Il totale di giornata arriva gia' cumulato dal server: qui si sceglie
    // solo quale delle due misure mostrare.
    return profile.map((p) => ({ strike: p.strike, gex: gexBasis === 'oi' ? p.gexOi : p.gex }));
  }, [profile, gexBasis]);

  const currentBasis = useMemo(() => {
    for (let i = spxHistory.length - 1; i >= 0; i--) {
      const pt = spxHistory[i];
      if (pt.esf != null && pt.spx != null && pt.esf > 0 && pt.spx > 0) {
        return pt.esf - pt.spx;
      }
    }
    return 0;
  }, [spxHistory]);

  const yLimits = useMemo(() => {
    const now = oraItalianaAdesso();
    const filteredPrices = spxHistory.filter((dp) => dp.time <= now);
    const strikes = gexProfile.map((p) => p.strike);
    const prices = filteredPrices.map((p) => p.spxPrice).filter((p): p is number => !!p);

    // Gli strike sono il riferimento di scala: un livello lontano piu' del 20%
    // da li' non e' un livello, e' un dato sporco. Senza questo controllo
    // bastava una chiave estranea in `marketRefLines` per portare il minimo
    // dell'asse a 2026 e schiacciare tutto il grafico in una striscia.
    const centro = strikes.length > 0 ? (Math.min(...strikes) + Math.max(...strikes)) / 2 : null;
    const plausibile = (v: number) => centro === null || Math.abs(v - centro) <= centro * 0.2;

    const refLevels: number[] = [];
    Object.entries(livelli).forEach(([key, valStr]) => {
      const val = parseFloat(valStr);
      if (!isNaN(val) && refLineVisibility[key] !== false && plausibile(val - currentBasis)) {
        refLevels.push(val - currentBasis);
      }
    });

    const allValues = [...strikes, ...prices, ...refLevels];
    if (allValues.length === 0) return { min: 7300, max: 7600 };
    // Con reduce e non con lo spread: `prices` segue lo storico e cresce per
    // tutta la sessione.
    const min = allValues.reduce((a, b) => (b < a ? b : a), allValues[0]);
    const max = allValues.reduce((a, b) => (b > a ? b : a), allValues[0]);
    const padding = (max - min) * 0.05 || 50;
    return { min: Math.floor(min - padding), max: Math.ceil(max + padding) };
  }, [gexProfile, spxHistory, livelli, refLineVisibility, currentBasis]);

  const fondoScala = useRef({ ...FONDO_SCALA_M });

  /** Quanto pesa un valore sul metro fermo, da 0 a 1. */
  const quotaMuro = useCallback(
    (valore: number) => Math.min(1, Math.sqrt(Math.abs(valore) / fondoScala.current[gexBasis])),
    [gexBasis],
  );

  /** Il muro piu' grande della sessione sulla base corrente: lo aggiorna buildDatasets. */
  const massimoSessione = useRef(0);
  const muroVisibile = useCallback(
    (valore: number) => massimoSessione.current > 0 && Math.sqrt(Math.abs(valore) / massimoSessione.current) >= SOGLIA_RIGA,
    [],
  );

  /**
   * Il metro con cui si disegna: assoluto, e per tutta la sessione non
   * torna mai indietro. Se si accorciasse quando i livelli calano, la stessa
   * quantita' di gamma verrebbe disegnata in due modi diversi a due ore di
   * distanza, che e' il difetto da cui siamo partiti.
   */
  const scalaDisegno = useMemo(() => {
    const massimo = gexProfile.reduce((m, p) => Math.max(m, Math.abs(p.gex)), 0);
    const aggiornato = Math.max(fondoScala.current[gexBasis], massimo);
    fondoScala.current[gexBasis] = aggiornato;
    return aggiornato;
  }, [gexProfile, gexBasis]);

  const lineDate = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const oraLocale = oraItalianaAdesso();
    return new Date(`${todayStr}T${oraLocale}`);
  }, [nowClock]);

  const lineAnnotations = useMemo(() => {
    const annotations: Record<string, any> = {};

    // 1. Vertical line at "NOW"
    if (viewMode === 'lines') {
      const latestPrice = spxHistory.length > 0 ? spxHistory[spxHistory.length - 1].spxPrice : null;
      
      annotations[`now-line`] = {
        type: 'line',
        xMin: lineDate,
        xMax: lineDate,
        xScaleID: 'xTime',
        borderColor: 'rgba(168, 85, 247, 0.85)',
        borderWidth: 2,
        borderDash: [4, 3],
        label: {
          display: true,
          content: latestPrice ? `SPX ${latestPrice.toFixed(2)}` : 'NOW',
          position: 'start',
          yAdjust: 10,
          backgroundColor: 'rgba(168, 85, 247, 0.95)',
          color: '#ffffff',
          font: { size: 11, weight: 'bold' as const },
          padding: { top: 3, bottom: 3, left: 6, right: 6 },
          borderRadius: 4
        }
      };
    }

    // Le righe orizzontali del livello corrente non ci sono piu': nella vista
    // a linee quella di ogni strike arriva fino al bordo destro, e il suo
    // ultimo tratto E' il muro di adesso. Tenerle sarebbe stato disegnare due
    // volte la stessa cosa, una delle quali stesa anche sopra le ore in cui
    // non valeva.

    // 2. I livelli del Range Calc.
    //
    // Qui sopra c'era un `return` che li tagliava fuori da tutto quello che
    // non fosse la vista a linee: in "Profile Bars" non se n'e' mai visto
    // uno. Sono pero' livelli di prezzo su un asse di strike, cioe' proprio
    // quello che le barre hanno in ordinata -- e' anzi la vista in cui
    // servono di piu', perche' mostra a che altezza stanno i muri rispetto
    // ai range della giornata.
    //
    // Qui ne arrivavano quattro su dodici: R1 su e giu' per le due sessioni, e
    // basta. R2 e R3 li calcola /market e li salva insieme agli altri, ma
    // questa pagina non li guardava proprio -- da cui "non vedo i range
    // riportati", che era esattamente vero per due terzi di loro.
    //
    // La gerarchia resta leggibile con lo spessore: R1 piena e marcata, R2 e
    // R3 progressivamente piu' sottili e scariche. Le OB restano tratteggiate.
    const baseConfigs = (['', 'Ob'] as const).flatMap((suffix) =>
      ([1, 2, 3] as const).flatMap((livello) =>
        (['Up', 'Down'] as const).map((verso) => ({
          key: `r${livello}${verso}${suffix}`,
          label: `R${livello}${verso === 'Up' ? '↑' : '↓'}${suffix ? ' OB' : ''}`,
          color: verso === 'Up'
            ? ['#3b82f6', '#60a5fa', '#93c5fd'][livello - 1]
            : ['#ef4444', '#f87171', '#fca5a5'][livello - 1],
          // Mattina tratteggiata, opening bell continua: durante la
          // sessione americana i livelli che contano sono quelli calcolati
          // alle 15:35, e la linea piena e' quella che l'occhio segue.
          dash: suffix ? [] : [8, 4],
          width: [2.5, 1.5, 1][livello - 1],
        })),
      ),
    );

    baseConfigs.forEach(({ key, label, color, dash, width }) => {
      const valStr = livelli[key];
      if (valStr && !isNaN(parseFloat(valStr)) && refLineVisibility[key] !== false) {
        const spxLevel = parseFloat(valStr) - currentBasis;
        annotations[`ref-${key}`] = {
          type: 'line',
          yMin: spxLevel,
          yMax: spxLevel,
          borderColor: color,
          borderWidth: width,
          borderDash: dash,
          label: {
            display: true,
            content: `${label} ${spxLevel.toFixed(0)}`,
            position: 'end',
            xAdjust: -8,
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            color: color,
            font: { size: width >= 2 ? 11 : 9, weight: 'bold' as const },
            padding: { top: 2, bottom: 2, left: 4, right: 4 },
            borderRadius: 4
          }
        };
      }
    });

    return annotations;
  }, [gexProfile, scalaDisegno, quotaMuro, viewMode, spxHistory, lineDate, livelli, refLineVisibility, currentBasis]);

  // ─── Build datasets helper ───
  const buildDatasets = useCallback((currentSpxHistory: SpxHistoryPoint[], currentGexProfile: { strike: number; gex: number }[]) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const now = oraItalianaAdesso();

    const priceData = currentSpxHistory
      .filter(dp => dp.time <= now)
      .map((dp) => {
        const t = dp.time.includes(':') ? dp.time : `${dp.time}:00`;
        return { x: new Date(`${todayStr}T${t}`), y: dp.spxPrice || 0 };
      })
      .filter((pt) => !isNaN(pt.x.getTime()) && pt.y > 0);

    const priceDataset = {
      type: 'line' as const, label: 'SPX Price', data: priceData,
      xAxisID: 'xTime', yAxisID: 'y', borderColor: '#00f0ff',
      borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.1,
      showLine: true,
    };

    if (viewMode === 'lines') {
      // Un muro per strike, disegnato come una linea continua che attraversa
      // la sessione cambiando colore e spessore man mano che il gamma si
      // aggiunge o si toglie.
      //
      // Prima erano quadretti staccati, uno ogni due minuti: la taglia la
      // dicevano, ma a leggerli bisognava ricomporli con l'occhio. Una linea
      // sola dice la stessa cosa e in piu' mostra il verso -- si ingrossa
      // mentre il muro si costruisce, si assottiglia mentre si scioglie.
      //
      // Il valore sta dentro ogni punto (`v`), non in una variabile catturata:
      // l'aggiornamento imperativo sostituisce solo `data`, quindi una
      // chiusura su un array esterno resterebbe indietro di un giro e
      // colorerebbe i segmenti con i numeri di prima.
      const strikeSerie = latestStrikes.current;
      const serieOra = latestSerie.current;

      const valoreDi = (ctx: { chart?: { data?: { datasets?: { data?: { v?: number }[] }[] } }; datasetIndex?: number; p1DataIndex?: number }) =>
        ctx.chart?.data?.datasets?.[ctx.datasetIndex ?? 0]?.data?.[ctx.p1DataIndex ?? 0]?.v ?? 0;

      massimoSessione.current = serieOra.reduce((m, f) => {
        for (const v of gexBasis === 'oi' ? f.gexOi : f.gex) if (Math.abs(v) > m) m = Math.abs(v);
        return m;
      }, 0);

      const muri = [];
      for (let i = 0; i < strikeSerie.length; i++) {
        const strike = strikeSerie[i];
        const punti: { x: Date; y: number; v: number }[] = [];
        let massimo = 0;
        for (const f of serieOra) {
          const t = f.time.includes(':') ? f.time : `${f.time}:00`;
          const x = new Date(`${todayStr}T${t}`);
          if (isNaN(x.getTime())) continue;
          const v = (gexBasis === 'oi' ? f.gexOi : f.gex)[i] ?? 0;
          if (Math.abs(v) > massimo) massimo = Math.abs(v);
          punti.push({ x, y: strike, v });
        }
        // Uno strike che non ha mai contato non merita una linea: sarebbero
        // trentasette dataset di cui venti invisibili.
        if (punti.length === 0 || !muroVisibile(massimo)) continue;

        muri.push({
          type: 'line' as const,
          // Una sola voce in legenda per tutti: le altre resterebbero
          // trenta caselle senza nome.
          label: muri.length === 0 ? 'Muri per strike' : '',
          data: punti,
          xAxisID: 'xTime', yAxisID: 'y',
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0,
          borderColor: 'rgba(148, 163, 184, 0.5)',
          borderWidth: 1,
          order: 5,
          segment: {
            borderColor: (ctx: Parameters<typeof valoreDi>[0]) => {
              const v = valoreDi(ctx);
              const q = quotaMuro(v);
              // Sotto la soglia il muro non c'e' ancora: la linea non si
              // interrompe, semplicemente non si vede, e si accende quando
              // il livello comincia a contare.
              if (!muroVisibile(v)) return 'rgba(0, 0, 0, 0)';
              const opacita = 0.15 + q * 0.8;
              return v > 0 ? `rgba(34, 197, 94, ${opacita})` : `rgba(239, 68, 68, ${opacita})`;
            },
            borderWidth: (ctx: Parameters<typeof valoreDi>[0]) => {
              const v = valoreDi(ctx);
              return muroVisibile(v) ? 1 + quotaMuro(v) * 13 : 0;
            },
          },
        });
      }

      return [...muri, priceDataset];
    }

    // Il divisore era 15, con i valori in M$: sopra i 15 M$ -- cioe' sempre,
    // visto che a fine sessione uno strike ATM ne fa decine di migliaia -- il
    // conto sbatteva contro il tetto e ogni barra usciva della stessa identica
    // opacita'. Il colore non diceva piu' niente e restava solo la lunghezza.
    // Adesso e' lo stesso metro delle righe orizzontali.
    const intensita = (ctx: { raw?: { x?: number } }, minimo: number, massimo: number) => {
      const q = Math.min(1, Math.sqrt(Math.abs(ctx.raw?.x || 0) / fondoScala.current[gexBasis]));
      return minimo + q * (massimo - minimo);
    };

    const posGexDataset = {
      type: 'bar' as const, label: 'Positive GEX (M$/1%)',
      data: currentGexProfile.map((p) => ({ x: p.gex > 0 ? p.gex : 0, y: p.strike })),
      xAxisID: 'xGex', yAxisID: 'y',
      backgroundColor: (ctx: any) => `rgba(34, 197, 94, ${intensita(ctx, 0.12, 0.75)})`,
      borderColor: (ctx: any) => `rgba(74, 222, 128, ${intensita(ctx, 0.2, 0.95)})`,
      borderWidth: 1, barThickness: 8, indexAxis: 'y' as const,
    };
    const negGexDataset = {
      type: 'bar' as const, label: 'Negative GEX (M$/1%)',
      data: currentGexProfile.map((p) => ({ x: p.gex < 0 ? Math.abs(p.gex) : 0, y: p.strike })),
      xAxisID: 'xGex', yAxisID: 'y',
      backgroundColor: (ctx: any) => `rgba(239, 68, 68, ${intensita(ctx, 0.12, 0.75)})`,
      borderColor: (ctx: any) => `rgba(248, 113, 113, ${intensita(ctx, 0.2, 0.95)})`,
      borderWidth: 1, barThickness: 8, indexAxis: 'y' as const,
    };
    return [priceDataset, posGexDataset, negGexDataset];
  }, [viewMode, gexBasis, quotaMuro, muroVisibile]);

  const handleTimeWindowChange = useCallback((w: number | 'all') => {
    setTimeWindow(w);
    isUserZoomedRef.current = false;
    setIsZoomed(false);
    const chart = chartRef.current;
    if (chart) {
      chart.resetZoom();
      chart.update('none');
    }
  }, []);

  // ─── Create chart ONCE on mount (after plugins are ready) ───
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pluginsReady) return;

    // Destroy previous
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    isUserZoomedRef.current = false;
    setIsZoomed(false);

    const datasets = buildDatasets(latestSpxHistory.current, gexProfile);

    const xLimits = (() => {
      if (timeWindow === 'all') return null;
      const minDate = new Date(lineDate.getTime() - (timeWindow as number) * 60 * 1000);
      const paddingSeconds = Math.max(90, (timeWindow as number) * 0.25 * 60);
      const maxDateWithPadding = new Date(lineDate.getTime() + paddingSeconds * 1000);
      return { min: minDate, max: maxDateWithPadding };
    })();

    /**
     * Rimette l'asse del GEX dov'era.
     *
     * Il plugin zooma e trascina tutte le scale insieme, e il suo `mode` non
     * sa distinguerne una: senza questo, trascinare dentro il grafico faceva
     * scorrere anche il profilo, che invece deve restare inchiodato -- la
     * lunghezza di una barra e' un valore in dollari, non una posizione.
     */
    const fissaProfilo = () => {
      const c = chartRef.current;
      const opt = (c?.options.scales as { xGex?: { min?: number; max?: number } } | undefined)?.xGex;
      if (!opt) return;
      opt.min = 0;
      delete opt.max;
    };

    const chart = new ChartJS(canvas, {
      type: 'bar',
      data: { datasets: datasets as any },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const,
        scales: {
          xTime: {
            type: 'time' as const, position: 'bottom' as const,
            time: { unit: 'minute' as const, displayFormats: { minute: 'HH:mm' } },
            title: { display: true, text: 'Ora italiana', color: '#94a3b8', font: { size: 11, weight: 'bold' as const } },
            grid: { color: 'rgba(255,255,255,0.03)' },
            ticks: { color: '#94a3b8', font: { size: 10 } },
            min: xLimits ? xLimits.min : undefined,
            max: xLimits ? xLimits.max : undefined,
          },
          xGex: {
            type: 'linear' as const, position: 'top' as const, display: viewMode === 'bars',
            title: { display: true, text: 'SPX Gamma Exposure (M$ per 1%)', color: '#94a3b8', font: { size: 11, weight: 'bold' as const } },
            grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } }, min: 0,
          },
          y: {
            type: 'linear' as const,
            // Nella vista a barre la scala sta a sinistra, dove le barre hanno
            // la base: leggere l'altezza di un muro guardando dall'altra parte
            // del grafico non aiutava nessuno.
            position: (viewMode === 'bars' ? 'left' : 'right') as 'left' | 'right',
            min: yLimits.min, max: yLimits.max,
            title: { display: true, text: 'Strike', color: '#94a3b8', font: { size: 11, weight: 'bold' as const } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8', font: { size: 10 } },
          },
        },
        plugins: {
          legend: {
            display: true, position: 'bottom' as const,
            labels: {
              color: '#e2e8f0', boxWidth: 12, font: { size: 11 },
              // I muri sono un dataset per strike: senza filtro la legenda
              // diventerebbe una fila di caselle senza nome. Solo il primo
              // porta l'etichetta, gli altri la stringa vuota.
              filter: (item: { text?: string }) => !!item.text,
            },
          },
          annotation: { annotations: lineAnnotations },
          tooltip: {
            mode: 'index' as const, intersect: false,
            backgroundColor: '#0f172a', titleColor: '#38bdf8', bodyColor: '#f1f5f9',
            borderColor: '#334155', borderWidth: 1,
            callbacks: {
              label: (ctx: any) => {
                const l = ctx.dataset.label || '';
                if (l.includes('SPX Price')) return `SPX Price: ${ctx.parsed.y.toFixed(2)}`;
                if (ctx.raw?.v !== undefined) {
                  return `Strike ${ctx.parsed.y}: ${(ctx.raw.v / 1000).toFixed(1)} Bn`;
                }
                return `${l}: ${ctx.parsed.x.toFixed(2)} M$`;
              },
            },
          },
          zoom: {
            // `xGex` non compare: il profilo resta inchiodato dov'e'. Zoom e
            // trascinamento del plugin lavorano su tutte le scale insieme, e
            // non c'e' un modo di escluderne una dal `mode`; il ritocco lo fa
            // `fissaProfilo()`, richiamato dopo ogni gesto.
            limits: { xGex: { min: 0 } },
            zoom: {
              // La rotella la gestiamo a mano piu' sotto: qui ci sono tre
              // scale (xTime, xGex, y) e serve poter allargare il tempo
              // senza toccare gli strike. Al plugin restano il pizzico e il
              // trascinamento, che vanno bene come sono.
              wheel: { enabled: false }, pinch: { enabled: true }, mode: 'xy' as const,
              onZoom: () => { fissaProfilo(); isUserZoomedRef.current = true; setIsZoomed(true); },
            },
            pan: {
              enabled: true, mode: 'xy' as const,
              onPan: () => { fissaProfilo(); isUserZoomedRef.current = true; setIsZoomed(true); },
            },
          },
        },
      } as any,
    });

    chartRef.current = chart;

    /**
     * Rotella: ogni asse per conto suo.
     *
     * Sopra l'asse dei tempi allarga o stringe solo la finestra temporale,
     * sopra quello degli strike solo gli strike, dentro il grafico entrambi
     * come prima. Il perno e' il puntatore, non il centro: si stringe dove
     * si sta guardando.
     *
     * Lo zoom vero lo applica `zoomScale`, che e' del plugin: scrivere i
     * limiti a mano in `options.scales` funzionerebbe lo stesso, ma il
     * plugin non registrerebbe da dove si era partiti e il tasto "Reset
     * zoom" resterebbe senza niente a cui tornare.
     */
    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Su = si stringe, giu' = si allarga.
      const fattore = e.deltaY < 0 ? 0.85 : 1.18;

      const zooma = (sc: (typeof chart.scales)[string], pixel: number) => {
        const perno = sc.getValueForPixel(pixel);
        if (perno == null || !isFinite(perno)) return;
        chart.zoomScale(sc.id, {
          min: perno - (perno - sc.min) * fattore,
          max: perno + (sc.max - perno) * fattore,
        }, 'none');
      };

      // Gli assi non si cercano per nome: si prende quello sotto al
      // puntatore, qualunque sia. Le scale qui sono tre e cambiano con la
      // vista (xGex esiste solo in "Profile Bars"), quindi nominarle a mano
      // vuol dire sbagliare appena la vista cambia.
      const asse = Object.values(chart.scales).find(
        (sc) => px >= sc.left && px <= sc.right && py >= sc.top && py <= sc.bottom,
      );

      const area = chart.chartArea;
      const dentro = !!area && px >= area.left && px <= area.right && py >= area.top && py <= area.bottom;

      if (asse) {
        // Il profilo non si muove nemmeno con la rotella sopra la sua scala.
        if (asse.id === 'xGex') return;
        zooma(asse, asse.isHorizontal() ? px : py);
      } else if (dentro) {
        // Dentro il grafico si muovono insieme, come prima -- tranne il
        // profilo, che resta fermo.
        for (const sc of Object.values(chart.scales)) {
          if (sc.id === 'xGex') continue;
          zooma(sc, sc.isHorizontal() ? px : py);
        }
      } else {
        return;
      }

      e.preventDefault();
      isUserZoomedRef.current = true;
      setIsZoomed(true);
    };

    // `passive: false` o il browser ignora la preventDefault e scorre la pagina.
    canvas.addEventListener('wheel', onWheel, { passive: false });

    /**
     * Trascinamento verticale preso dalla scala degli strike.
     *
     * Premendo sulla scala e tirando su o giu' si sposta la finestra dei
     * prezzi: si muovono insieme il profilo e la linea del prezzo, perche'
     * condividono l'asse `y`. Dentro l'area del grafico il trascinamento
     * resta quello del plugin, che muove anche il tempo; qui invece il gesto
     * e' mirato, e non c'e' modo di spostare per sbaglio qualcos'altro.
     */
    let trascinamento: { daY: number; min: number; max: number } | null = null;

    const suGiu = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const sc = chart.scales.y;
      if (!sc || px < sc.left || px > sc.right || py < sc.top || py > sc.bottom) return;
      trascinamento = { daY: py, min: sc.min, max: sc.max };
      canvas.style.cursor = 'ns-resize';
      e.preventDefault();
    };

    const suMuovi = (e: MouseEvent) => {
      if (!trascinamento) return;
      const sc = chart.scales.y;
      if (!sc) return;
      const py = e.clientY - canvas.getBoundingClientRect().top;
      // Quanti punti di strike vale un pixel, sulla finestra di partenza.
      const perPixel = (trascinamento.max - trascinamento.min) / Math.max(1, sc.bottom - sc.top);
      // Tirando verso il basso si scende di prezzo, come afferrare il foglio.
      const scarto = (py - trascinamento.daY) * perPixel;
      chart.zoomScale('y', {
        min: trascinamento.min + scarto,
        max: trascinamento.max + scarto,
      }, 'none');
      isUserZoomedRef.current = true;
      setIsZoomed(true);
    };

    const suSu = () => {
      if (!trascinamento) return;
      trascinamento = null;
      canvas.style.cursor = '';
    };

    canvas.addEventListener('mousedown', suGiu);
    // Su window e non sul canvas: tirando in fretta il puntatore esce dal
    // grafico, e con i gestori sul canvas il trascinamento restava appeso.
    window.addEventListener('mousemove', suMuovi);
    window.addEventListener('mouseup', suSu);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', suGiu);
      window.removeEventListener('mousemove', suMuovi);
      window.removeEventListener('mouseup', suSu);
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginsReady, viewMode]);

  // ─── Imperative data update — preserves zoom/pan ───
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const newDatasets = buildDatasets(spxHistory, gexProfile);

    newDatasets.forEach((ds, i) => {
      if (chart.data.datasets[i]) {
        chart.data.datasets[i].data = ds.data as any;
        if ('backgroundColor' in ds) chart.data.datasets[i].backgroundColor = ds.backgroundColor as any;
        if ('borderColor' in ds) chart.data.datasets[i].borderColor = ds.borderColor as any;
      } else {
        chart.data.datasets[i] = ds as any;
      }
    });
    if (chart.data.datasets.length > newDatasets.length) {
      chart.data.datasets.length = newDatasets.length;
    }

    // Update annotations
    const annOpts = (chart.options.plugins as any)?.annotation;
    if (annOpts) annOpts.annotations = lineAnnotations;

    const currentLineMs = lineDate.getTime();
    const deltaMs = prevLineDateRef.current ? currentLineMs - prevLineDateRef.current : 0;
    prevLineDateRef.current = currentLineMs;

    const optXScale = (chart.options.scales as any)?.xTime;
    const realXScale = (chart.scales as any)?.xTime;

    if (isUserZoomedRef.current && optXScale && deltaMs > 0) {
      const getMs = (v: any) => {
        if (typeof v === 'number') return v;
        if (v instanceof Date) return v.getTime();
        if (typeof v === 'string') return new Date(v).getTime();
        return null;
      };

      const curMin = getMs(realXScale?.min) ?? getMs(optXScale?.min);
      const curMax = getMs(realXScale?.max) ?? getMs(optXScale?.max);

      if (curMin != null && curMax != null) {
        optXScale.min = new Date(curMin + deltaMs);
        optXScale.max = new Date(curMax + deltaMs);
      }
    } else if (!isUserZoomedRef.current) {
      const yScale = chart.options.scales?.y as any;
      if (yScale) { yScale.min = yLimits.min; yScale.max = yLimits.max; }

      if (optXScale) {
        if (timeWindow === 'all') {
          delete optXScale.min;
          delete optXScale.max;
        } else {
          const minDate = new Date(lineDate.getTime() - (timeWindow as number) * 60 * 1000);
          const paddingSeconds = Math.max(90, (timeWindow as number) * 0.25 * 60);
          const maxDateWithPadding = new Date(lineDate.getTime() + paddingSeconds * 1000);
          
          optXScale.min = minDate;
          optXScale.max = maxDateWithPadding;
        }
      }
    }

    chart.update('none');
  }, [spxHistory, gexProfile, lineAnnotations, yLimits, timeWindow, lineDate, buildDatasets]);

  // ─── Reset zoom ───
  const handleResetZoom = useCallback(() => {
    const chart = chartRef.current;
    if (chart) {
      chart.resetZoom();
      isUserZoomedRef.current = false;
      setIsZoomed(false);
      const yScale = chart.options.scales?.y as any;
      if (yScale) { yScale.min = yLimits.min; yScale.max = yLimits.max; }
      chart.update('none');
    }
  }, [yLimits]);

  return (
    <div className="w-full h-full bg-[#0c0d10] p-2 flex flex-col justify-between">
      {error && (
        <div className="text-red-400 bg-red-950/30 border border-red-900/50 p-2 rounded text-xs mb-2">⚠️ {error}</div>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-800/80">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 bg-slate-900/60 p-0.5 rounded-lg border border-slate-800">
            <button
              onClick={() => setViewMode('lines')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${viewMode === 'lines' ? 'bg-slate-800 text-teal-400 shadow-md border border-slate-700/60' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Heatmap Lines (Photo)
            </button>
            <button
              onClick={() => setViewMode('bars')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${viewMode === 'bars' ? 'bg-slate-800 text-teal-400 shadow-md border border-slate-700/60' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Profile Bars
            </button>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-900/60 p-0.5 rounded-lg border border-slate-800">
            <button
              onClick={() => setGexBasis('volume')}
              title="Gamma pesato sui contratti scambiati oggi: misura di flusso"
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${gexBasis === 'volume' ? 'bg-slate-800 text-teal-400 shadow-md border border-slate-700/60' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Volume
            </button>
            <button
              onClick={() => setGexBasis('oi')}
              title="Gamma pesato sulle posizioni aperte: il GEX canonico. L'open interest e' fermo alla chiusura del giorno prima"
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${gexBasis === 'oi' ? 'bg-slate-800 text-teal-400 shadow-md border border-slate-700/60' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Open Interest
            </button>
            {isZoomed && (
              <button
                onClick={handleResetZoom}
                className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 ml-1"
              >
                Reset Zoom
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 bg-slate-900/60 p-0.5 rounded-lg border border-slate-800">
            {(['5', '15', '30', 'all'] as const).map((w) => (
              <button
                key={w}
                onClick={() => handleTimeWindowChange(w === 'all' ? 'all' : Number(w))}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  (w === 'all' && timeWindow === 'all') || (w !== 'all' && timeWindow === Number(w))
                    ? 'bg-slate-800 text-teal-400 shadow-md border border-slate-700/60'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {w === 'all' ? 'Full Session' : `${w}m`}
              </button>
            ))}
          </div>
        </div>

        {viewMode === 'lines' && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium text-slate-300 bg-slate-900/60 px-4 py-2 rounded-lg border border-slate-700/80 shadow-sm">
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-blue-500/80 border border-blue-400" /> Addition (GEX+)</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-fuchsia-500/80 border border-fuchsia-400" /> Subtraction (GEX-)</span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400">Bubble size = Activity Volume</span>
            <span className="text-slate-500">|</span>
            <span className="flex items-center gap-2"><span className="w-4 h-1.5 bg-green-500 rounded-sm" /> Major Call Wall</span>
            <span className="flex items-center gap-2"><span className="w-4 h-1.5 bg-red-500 rounded-sm" /> Major Put Wall</span>
            {currentBasis !== 0 && (
              <>
                <span className="text-slate-500">|</span>
                <span className="text-amber-400/90 font-mono text-[10px]">
                  Basis: {currentBasis >= 0 ? `+${currentBasis.toFixed(2)}` : currentBasis.toFixed(2)} pts (SPX Ranges Active)
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-[340px] relative">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
