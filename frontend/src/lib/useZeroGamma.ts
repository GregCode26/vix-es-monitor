'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Lo Zero Gamma di SPX per le pagine (/api/zero-gamma): il valore manuale
 * (GEXBot, inserito a mano), la traccia in tempo reale dal nostro poller (una
 * lettura al minuto, disegnata come la linea gialla tratteggiata di GEXBot) e,
 * solo quando la traccia manca, il calcolo dalla catena Cboe ritardata.
 * Prezzi SPX: chi disegna su ES aggiunge il proprio basis.
 */

export interface ZeroGammaStato {
  manuale: { ora: string; valore: number } | null;
  cboe: { ora: string; principale: number | null; spot: number } | null;
  /** [ora di Roma 'HH:MM:SS', Zero Gamma SPX], una al minuto dall'apertura cash. */
  traccia: [string, number][];
  /** L'ultimo della traccia, o il Cboe se la traccia non c'e' (poller fermo, Vercel). */
  attuale: { valore: number; fonte: 'poller' | 'cboe' } | null;
}

/** Colori condivisi: manuale pieno, Cboe tratteggiato, stessa tinta. */
export const COLORE_ZERO_GAMMA = '#fb923c';
export const COLORE_ZERO_GAMMA_CBOE = 'rgba(251, 146, 60, 0.75)';
/** La traccia dal poller: giallo oro tratteggiato, come la linea di GEXBot. */
export const COLORE_ZERO_GAMMA_TRACCIA = '#eab308';
export const TRATTO_ZERO_GAMMA_TRACCIA = [6, 3];

const REFRESH_MS = 60_000;

/** Un evento per avvisare le altre istanze nella stessa scheda dopo un inserimento. */
const EVENTO = 'zero-gamma-cambiato';

export function useZeroGamma(): ZeroGammaStato & { imposta: (v: number | null) => Promise<boolean> } {
  const [stato, setStato] = useState<ZeroGammaStato>({ manuale: null, cboe: null, traccia: [], attuale: null });

  const leggi = useCallback(async () => {
    try {
      const res = await fetch('/api/zero-gamma', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const traccia: [string, number][] = j.poller?.serie ?? [];
      const ultimo = traccia[traccia.length - 1];
      const cboe = j.cboe ? { ora: j.cboe.ora, principale: j.cboe.principale, spot: j.cboe.spot } : null;
      setStato({
        manuale: j.manuale ?? null,
        cboe,
        traccia,
        attuale: ultimo ? { valore: ultimo[1], fonte: 'poller' }
          : cboe?.principale != null ? { valore: cboe.principale, fonte: 'cboe' } : null,
      });
    } catch {
      // la dashboard non risponde: si tiene l'ultimo valore
    }
  }, []);

  useEffect(() => {
    // Il primo giro fuori dal corpo dell'effetto (regola react-hooks/set-state-in-effect).
    const primo = setTimeout(leggi, 0);
    const id = setInterval(leggi, REFRESH_MS);
    const suEvento = () => leggi();
    window.addEventListener(EVENTO, suEvento);
    // Un inserimento da un'altra scheda: localStorage fa da campanello.
    const suStorage = (e: StorageEvent) => { if (e.key === EVENTO) leggi(); };
    window.addEventListener('storage', suStorage);
    return () => {
      clearTimeout(primo);
      clearInterval(id);
      window.removeEventListener(EVENTO, suEvento);
      window.removeEventListener('storage', suStorage);
    };
  }, [leggi]);

  const imposta = useCallback(async (v: number | null) => {
    try {
      const res = await fetch('/api/zero-gamma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valore: v }),
      });
      if (!res.ok) return false;
      window.dispatchEvent(new Event(EVENTO));
      try { localStorage.setItem(EVENTO, String(Date.now())); } catch { /* niente */ }
      return true;
    } catch {
      return false;
    }
  }, []);

  return { ...stato, imposta };
}
