'use client';

import { useEffect, useState } from 'react';
import { COLORE_ZERO_GAMMA, COLORE_ZERO_GAMMA_TRACCIA, useZeroGamma } from '@/lib/useZeroGamma';

/**
 * Il campo dello Zero Gamma: il valore di GEXBot (prezzo SPX) da inserire a
 * mano, con accanto quello attuale della traccia del nostro poller (o, se la
 * traccia manca, della catena Cboe ritardata). Invio o "OK" salva, la × lo toglie.
 */
export default function ZeroGammaInput({ compatto = false }: { compatto?: boolean }) {
  const { manuale, cboe, attuale, imposta } = useZeroGamma();
  const [testo, setTesto] = useState('');
  const [esito, setEsito] = useState<'ok' | 'errore' | null>(null);

  useEffect(() => {
    if (!esito) return;
    const id = setTimeout(() => setEsito(null), 2000);
    return () => clearTimeout(id);
  }, [esito]);

  const salva = async () => {
    const v = parseFloat(testo.replace(',', '.'));
    if (!Number.isFinite(v)) { setEsito('errore'); return; }
    const ok = await imposta(v);
    setEsito(ok ? 'ok' : 'errore');
    if (ok) setTesto('');
  };

  return (
    <div className="flex items-center gap-2 text-xs whitespace-nowrap" title="Zero Gamma SPX: il valore di GEXBot inserito a mano (linea arancio piena) e la traccia in tempo reale dal nostro poller (gialla tratteggiata, stessa definizione di GEXBot)">
      <span className="font-bold" style={{ color: COLORE_ZERO_GAMMA }}>0γ</span>
      <input
        value={testo}
        onChange={(e) => setTesto(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') salva(); }}
        placeholder={manuale ? manuale.valore.toFixed(1) : 'GEXBot'}
        inputMode="decimal"
        className={`${compatto ? 'w-16' : 'w-20'} bg-slate-900 border rounded px-1.5 py-0.5 text-slate-100 tabular-nums ${esito === 'errore' ? 'border-red-500' : esito === 'ok' ? 'border-emerald-500' : 'border-slate-700'}`}
      />
      <button onClick={salva} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700">OK</button>
      {manuale && (
        <span className="flex items-center gap-1 text-slate-300 tabular-nums">
          {manuale.valore.toFixed(1)}
          <span className="text-slate-500">{manuale.ora.slice(0, 5)}</span>
          <button onClick={() => imposta(null)} className="text-slate-500 hover:text-red-400" title="Togli il valore manuale">×</button>
        </span>
      )}
      {!compatto && (attuale?.fonte === 'poller' ? (
        <span className="tabular-nums" style={{ color: COLORE_ZERO_GAMMA_TRACCIA }} title="Dal nostro poller volumi, in tempo reale: profilo per strike gamma × volume, come GEXBot">
          ora {attuale.valore.toFixed(1)}
        </span>
      ) : (
        <span className="text-slate-500 tabular-nums" title="Poller fermo: calcolato dalla catena Cboe completa (ritardo 15 minuti), profilo per strike pesato sul volume">
          Cboe {cboe?.principale != null ? cboe.principale.toFixed(1) : '—'}{cboe ? ` (${cboe.ora.slice(0, 5)})` : ''}
        </span>
      ))}
    </div>
  );
}
