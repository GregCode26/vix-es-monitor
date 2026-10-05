'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import GammaHeatmap, { type ContiLr, type FotografiaGamma } from './GammaHeatmap';

/**
 * La mappa del gamma dei market maker con i suoi dati: si monta solo quando
 * la vista e' aperta, quindi le altre viste della pagina non scaricano niente
 * in piu'.
 *
 * - /api/gex?flow=0: al primo giro la storia del profilo (una fotografia ogni
 *   due minuti, ~50 KB), poi solo quello che e' arrivato dopo (`since`); la
 *   storia la allunga il client, una fotografia ogni SERIE_STEP_SEC, dal
 *   profilo cumulato che la route manda comunque. Come fa /gex.
 * - /api/market: lo storico una volta (~0,8 MB), poi la sola ultima riga,
 *   per la linea dell'SPX cash.
 */

/**
 * Ogni due secondi, come /bookmap. I dati cambiano piu' piano (uno snapshot
 * del gamma ogni ~10 s, l'SPX ogni ~16 s), ma cosi' ogni novita' arriva
 * entro due secondi. Costa poco: con `since` la route del gamma legge solo
 * le righe nuove (quasi sempre nessuna, ~150 byte di risposta), e la riga
 * dell'SPX pesa ~400 byte.
 */
const REFRESH_MS = 2000;
/** Lo stesso passo con cui la route campiona la storia del profilo. */
const SERIE_STEP_SEC = 120;

type Base = 'gex' | 'gexOi' | 'gexLr';

interface RigaProfilo {
  strike: number;
  gex: number;
  gexOi: number;
  gexLr?: number;
  lr?: ContiLr;
}
type Finestra = 'all' | 60 | 30;

interface Prezzo {
  time: string;
  price: number;
}

function secondi(hhmmss: string) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function Selettore<T extends string | number>({ valore, opzioni, onChange }: {
  valore: T;
  opzioni: [T, string, string?][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-slate-700">
      {opzioni.map(([v, etichetta, titolo]) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          title={titolo}
          className={`px-2.5 py-1 text-xs transition-colors ${
            valore === v ? 'bg-blue-600/30 text-blue-300' : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
          }`}
        >
          {etichetta}
        </button>
      ))}
    </div>
  );
}

/**
 * `attiva`: la vista e' quella aperta. La pagina tiene montato il componente
 * anche quando si passa a un'altra vista (cosi' la sessione, ~6-17 MB da
 * Supabase, si legge una volta per apertura della pagina e non a ogni
 * ritorno sulla mappa); da nascosto non interroga il server, e quando torna
 * visibile riprende dal cursore, scaricando solo quello che e' arrivato nel
 * frattempo.
 */
export default function GammaHeatmapLive({ attiva = true }: { attiva?: boolean }) {
  const [strikes, setStrikes] = useState<number[]>([]);
  const [serie, setSerie] = useState<FotografiaGamma[]>([]);
  const [profilo, setProfilo] = useState<RigaProfilo[]>([]);
  /** Da quando la route vede i conti Lee-Ready; si tiene il primo visto nella giornata. */
  const [inizioLr, setInizioLr] = useState<string | null>(null);
  const [spot, setSpot] = useState<Prezzo[]>([]);
  const [spx, setSpx] = useState<Prezzo[]>([]);
  const [base, setBase] = useState<Base>('gexOi');
  const [finestra, setFinestra] = useState<Finestra>('all');
  const [errore, setErrore] = useState<string | null>(null);

  const cursore = useRef<string | null>(null);
  const giorno = useRef<string | null>(null);
  const strikesRef = useRef<number[]>([]);
  const storicoSpx = useRef(false);
  const attivaRef = useRef(attiva);
  /** Il giro di aggiornamento, per ripartire subito quando la vista torna aperta. */
  const giroRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let vivo = true;

    const caricaGamma = async () => {
      try {
        const q = new URLSearchParams({ flow: '0' });
        if (cursore.current) q.set('since', cursore.current);
        const res = await fetch(`/api/gex?${q}`, { cache: 'no-store' });
        if (!vivo) return;
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          // 503 la mattina e' la risposta normale: il poller dei volumi raccoglie dalle 13:30.
          setErrore(body?.error ?? 'Gamma non disponibile');
          return;
        }
        const json = await res.json();
        if (!vivo) return;
        // Cambio di giornata: si riparte senza cursore, dalla storia intera.
        if (json.date && giorno.current && json.date !== giorno.current) {
          giorno.current = json.date;
          cursore.current = null;
          strikesRef.current = [];
          setStrikes([]);
          setSerie([]);
          setSpot([]);
          setProfilo([]);
          setInizioLr(null);
          storicoSpx.current = false;
          setSpx([]);
          return;
        }
        if (json.date) giorno.current = json.date;
        const primo = cursore.current == null;
        if (json.lastTime) cursore.current = json.lastTime;
        setErrore(null);

        const spotIn: Prezzo[] = Array.isArray(json.spot) ? json.spot : [];
        const profiloIn: RigaProfilo[] = json.profile ?? [];
        if (profiloIn.length > 0) setProfilo(profiloIn);
        if (json.inizioLr) setInizioLr((prec) => prec ?? json.inizioLr);

        if (primo) {
          if (Array.isArray(json.strikes)) {
            strikesRef.current = json.strikes;
            setStrikes(json.strikes);
          }
          if (Array.isArray(json.serie)) setSerie(json.serie);
          setSpot(spotIn);
          return;
        }
        if (spotIn.length > 0) {
          setSpot((prec) => {
            const ultimo = prec[prec.length - 1]?.time ?? '';
            const nuovi = spotIn.filter((p) => p.time > ultimo);
            return nuovi.length > 0 ? [...prec, ...nuovi] : prec;
          });
          const ora = spotIn[spotIn.length - 1].time;
          const ks = strikesRef.current;
          if (profiloIn.length > 0 && ks.length > 0) {
            setSerie((prec) => {
              const ultima = prec[prec.length - 1];
              if (ultima && secondi(ora) - secondi(ultima.time) < SERIE_STEP_SEC) return prec;
              const mappa = new Map(profiloIn.map((r) => [r.strike, r]));
              return [
                ...prec,
                {
                  time: ora,
                  gex: ks.map((k) => Math.round(mappa.get(k)?.gex ?? 0)),
                  gexOi: ks.map((k) => Math.round(mappa.get(k)?.gexOi ?? 0)),
                  gexLr: ks.map((k) => Math.round(mappa.get(k)?.gexLr ?? 0)),
                },
              ];
            });
          }
        }
      } catch (e) {
        if (vivo) setErrore(e instanceof Error ? e.message : 'Errore');
      }
    };

    const caricaSpx = async () => {
      try {
        if (!storicoSpx.current) {
          const res = await fetch('/api/market?history=true', { cache: 'no-store' });
          if (!res.ok || !vivo) return;
          const json = await res.json();
          const storia: { time?: string; spx?: number | null }[] = json.history ?? [];
          // Solo l'SPX cash: dove manca, /api/market ha l'ES, ~50 punti sopra.
          setSpx(storia.flatMap((p) => (p.time && p.spx != null && p.spx > 0 ? [{ time: p.time, price: p.spx }] : [])));
          storicoSpx.current = true;
          return;
        }
        const res = await fetch('/api/market', { cache: 'no-store' });
        if (!res.ok || !vivo) return;
        const json = await res.json();
        const ora: string | null = json.sourceTime ?? null;
        if (!ora || json.spx == null || !(json.spx > 0)) return;
        setSpx((prec) => (prec.length > 0 && ora <= prec[prec.length - 1].time ? prec : [...prec, { time: ora, price: json.spx }]));
      } catch (e) {
        console.error('SPX per la mappa del gamma:', e);
      }
    };

    /**
     * Un giro parte solo se il precedente e' finito. Il primo carico del
     * gamma legge l'intera sessione e dura ~10 s: senza questo, a un giro
     * ogni due secondi ne partivano altri quattro o cinque completi (il
     * cursore `since` arriva solo con la prima risposta), ognuno con la sua
     * lettura di tutta la giornata da Supabase.
     */
    const inCorso = { gamma: false, spx: false };
    const unaVolta = (chiave: keyof typeof inCorso, carica: () => Promise<void>) => {
      if (inCorso[chiave]) return;
      inCorso[chiave] = true;
      carica().finally(() => {
        inCorso[chiave] = false;
      });
    };
    const giro = () => {
      if (!attivaRef.current) return;
      unaVolta('gamma', caricaGamma);
      unaVolta('spx', caricaSpx);
    };
    giroRef.current = giro;
    giro();
    const id = setInterval(giro, REFRESH_MS);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, []);

  // Tornando sulla mappa non si aspetta il prossimo giro: si recupera subito.
  useEffect(() => {
    attivaRef.current = attiva;
    if (attiva) giroRef.current?.();
  }, [attiva]);

  const profiloBase = useMemo(() => profilo.map((r) => ({ strike: r.strike, gex: r[base] ?? 0 })), [profilo, base]);
  const conti = useMemo(() => new Map(profilo.flatMap((r) => (r.lr ? [[r.strike, r.lr] as [number, ContiLr]] : []))), [profilo]);

  /**
   * La storia piu' la colonna di adesso: le fotografie si fissano ogni due
   * minuti, ma il bordo destro della mappa deve mostrare il profilo appena
   * arrivato, come l'ultimo campione in /bookmap. Questa non si salva: al
   * giro dopo si rifa' col profilo nuovo.
   */
  const serieLive = useMemo(() => {
    const ora = spot[spot.length - 1]?.time;
    const ultima = serie[serie.length - 1];
    if (!ora || strikes.length === 0 || profilo.length === 0 || (ultima && ora <= ultima.time)) return serie;
    const mappa = new Map(profilo.map((r) => [r.strike, r]));
    return [
      ...serie,
      {
        time: ora,
        gex: strikes.map((k) => Math.round(mappa.get(k)?.gex ?? 0)),
        gexOi: strikes.map((k) => Math.round(mappa.get(k)?.gexOi ?? 0)),
        gexLr: strikes.map((k) => Math.round(mappa.get(k)?.gexLr ?? 0)),
      },
    ];
  }, [serie, spot, strikes, profilo]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-3 mb-2 text-xs">
        <span className="font-bold text-slate-200">SPX Gamma Exposure · Market Makers</span>
        <Selettore<Base>
          valore={base}
          opzioni={[
            ['gexOi', 'Open Interest', "Gamma pesato sulle posizioni aperte: il GEX canonico, per tutta la giornata. L'OI e' fermo alla chiusura di ieri"],
            ['gex', 'Volume', "Gamma pesato sui contratti scambiati oggi. IBKR azzera il volume all'apertura del cash, quindi parte da li'"],
            [
              'gexLr',
              'Lee-Ready',
              "Posizione dei dealer ricavata dal flusso: ogni trade classificato come comprato o venduto dal cliente (Lee-Ready), e il dealer ha l'opposto. Non una convenzione sul segno, ma solo i contratti visti dal poller, senza le posizioni aperte prima",
            ],
          ]}
          onChange={setBase}
        />
        <Selettore<Finestra>
          valore={finestra}
          opzioni={[['all', 'Sessione'], [60, '60m'], [30, '30m']]}
          onChange={setFinestra}
        />
        <span className="text-slate-500">
          {base === 'gexLr'
            ? 'Segno: posizione dei dealer dal flusso Lee-Ready (opposta a quella dei clienti)'
            : 'Segno: dealer lunghi le call e corti le put (convenzione, non un dato osservato)'} · rotella sulla mappa = zoom sul tempo · rotella sull&apos;asse dei prezzi = zoom sui prezzi · trascina = guarda indietro · doppio clic = torna live
        </span>
        {errore && <span className="text-amber-400">{errore}</span>}
      </div>
      <div className="relative flex-1 min-h-0">
        {/* `key`: scegliere una finestra riparte da LIVE, con zoom e scala azzerati, come in /bookmap. */}
        <GammaHeatmap
          key={String(finestra)}
          strikes={strikes}
          serie={serieLive}
          base={base}
          profilo={profiloBase}
          spot={spot}
          spx={spx}
          finestraMin={finestra}
          inizioLr={inizioLr}
          conti={conti}
        />
      </div>
    </div>
  );
}
