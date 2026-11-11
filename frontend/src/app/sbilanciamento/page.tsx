'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { Lettura, Riga } from '../api/sbilanciamento/route';

/**
 * Pagina di prova (11/11/2026): call sopra e put sotto alla stessa distanza dal forward, dai bid/ask che il
 * poller dei volumi gia' scarica (`/api/sbilanciamento`). Ipotesi dell'utente, non verificata: put economiche
 * sotto e call care sopra = prezzo verso l'alto. Sulle SPX le put lontane costano quasi sempre di piu'
 * (skew), quindi il confronto "rispetto al solito" usa lo z del tilt di `/api/smile` (put25 - call25 contro i
 * giorni passati alla stessa ora).
 */

const REFRESH_MS = 10000;
const VERDE = '#34d399';
const ROSSO = '#f43f5e';
const GRIGIO = '#64748b';

type Risposta = { date: string; expiry: string; ivAtm: number | null; em: number | null; righe: Riga[]; lettura: Lettura; storia: Lettura[]; error?: string };
type Smile = { smile?: { tilt?: number; put25?: number; call25?: number; base?: string; z?: { tilt?: number } } };

const fmt = (x: number | null | undefined, n = 2) => (x == null ? '-' : x.toFixed(n));

function coloreStato(s: Riga['stato']) {
  return s === 'call' ? VERDE : s === 'put' ? ROSSO : GRIGIO;
}

function Storia({ storia }: { storia: Lettura[] }) {
  const p = storia.filter((x) => x.indice != null && x.spot != null);
  if (p.length < 2) return <div className="text-xs text-slate-500">La storia si riempie mentre la pagina resta aperta (una lettura ogni 10 s).</div>;
  const W = 900, H = 160;
  const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
  const t0 = sec(p[0].time), t1 = Math.max(sec(p[p.length - 1].time), t0 + 1);
  const x = (t: string) => ((sec(t) - t0) / (t1 - t0)) * W;
  const scala = (v: number[]) => { const lo = Math.min(...v), hi = Math.max(...v); return (y: number) => H - 8 - ((y - lo) / Math.max(hi - lo, 1e-9)) * (H - 16); };
  const yi = scala(p.map((q) => q.indice!)), ys = scala(p.map((q) => q.spot!));
  const linea = (f: (q: Lettura) => number) => p.map((q, i) => `${i ? 'L' : 'M'}${x(q.time).toFixed(1)},${f(q).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40 bg-slate-900/60 rounded">
        <path d={linea((q) => ys(q.spot!))} fill="none" stroke="#facc15" strokeWidth={1.5} />
        <path d={linea((q) => yi(q.indice!))} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
      </svg>
      <div className="flex justify-between text-[11px] text-slate-400 mt-1">
        <span>{p[0].time}</span>
        <span><span className="text-sky-400">— indice scarto call/put</span> · <span className="text-yellow-400">— SPX</span> (scale proprie)</span>
        <span>{p[p.length - 1].time}</span>
      </div>
    </div>
  );
}

export default function SbilanciamentoPage() {
  const router = useRouter();
  const autorizzato = useSyncExternalStore(() => () => {}, () => localStorage.getItem('market_auth') === 'true', () => false);
  const [dati, setDati] = useState<Risposta | null>(null);
  const [smile, setSmile] = useState<Smile['smile'] | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    if (localStorage.getItem('market_auth') !== 'true') router.replace('/login');
  }, [router]);

  useEffect(() => {
    if (!autorizzato) return;
    let attivo = true;
    const carica = async () => {
      try {
        const r = await fetch('/api/sbilanciamento', { cache: 'no-store' });
        const j = await r.json();
        if (!attivo) return;
        if (j.error) setErrore(j.error); else { setDati(j); setErrore(null); }
      } catch (e) { if (attivo) setErrore(String(e)); }
      try {
        const r = await fetch('/api/smile', { cache: 'no-store' });
        if (r.ok) { const j: Smile = await r.json(); if (attivo) setSmile(j.smile ?? null); }
      } catch { /* lo z resta quello di prima */ }
    };
    carica();
    const id = setInterval(carica, REFRESH_MS);
    return () => { attivo = false; clearInterval(id); };
  }, [autorizzato]);

  if (!autorizzato) return null;
  const l = dati?.lettura;
  const z = smile?.z?.tilt;
  // tilt = IV put25 - IV call25: z negativo = put meno care del solito rispetto alle call
  const relativo = z == null ? null : z <= -1 ? 'long' : z >= 1 ? 'short' : 'neutro';
  const maxScarto = Math.max(1, ...(dati?.righe ?? []).map((r) => Math.abs(r.scarto)));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">Sbilanciamento call / put <span className="text-xs font-normal text-amber-400 align-middle">IN PROVA</span></h1>
            <div className="text-xs text-slate-400">
              SPX 0DTE {dati?.expiry ?? ''} · call sopra contro put sotto, stessa distanza dal centro · ogni 10 s
              {l && <> · dati delle {l.time} · SPX {fmt(l.spot)} · forward {fmt(l.fwd)} · centro {l.centro}</>}
            </div>
          </div>
          <button onClick={() => router.push('/market')} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs">MARKET</button>
        </div>

        {errore && <div className="p-3 rounded bg-amber-900/40 border border-amber-700 text-amber-200 text-sm">{errore}</div>}

        {l && (
          <div className="grid md:grid-cols-2 gap-3">
            <div className="p-4 rounded-lg bg-slate-900 border border-slate-800">
              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Ai prezzi di adesso</div>
              <div className="text-lg font-semibold">
                {l.inizio
                  ? <>Più care le <span style={{ color: l.inizio.lato === 'call' ? VERDE : ROSSO }}>{l.inizio.lato === 'call' ? 'CALL (sopra)' : 'PUT (sotto)'}</span>, da {l.inizio.d} punti</>
                  : <span className="text-slate-300">Bilanciate su tutte le distanze</span>}
              </div>
              <div className="text-sm text-slate-300 mt-1">
                {l.bilanciati} bilanciate su {l.confrontabili} · {l.put} con put più care · {l.call} con call più care · scarto medio{' '}
                <b style={{ color: (l.indice ?? 0) >= 0 ? VERDE : ROSSO }}>{fmt(l.indice, 1)}%</b>
              </div>
              <div className="text-[11px] text-slate-500 mt-2">Sulle SPX le put lontane costano quasi sempre più delle call (skew): questa riga da sola dice &quot;put più care&quot; quasi ogni giorno.</div>
            </div>
            <div className="p-4 rounded-lg bg-slate-900 border border-slate-800">
              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Rispetto al solito (giorni passati, stessa ora)</div>
              <div className="text-lg font-semibold">
                {relativo == null ? <span className="text-slate-400">in attesa di /api/smile</span>
                  : relativo === 'long' ? <span style={{ color: VERDE }}>Put economiche, call care → ipotesi LONG</span>
                  : relativo === 'short' ? <span style={{ color: ROSSO }}>Put care, call economiche → ipotesi SHORT</span>
                  : <span className="text-slate-300">Nella norma</span>}
              </div>
              <div className="text-sm text-slate-300 mt-1">
                z {fmt(z)} (soglia ±1) · IV put 25Δ {fmt(smile?.put25)} − call 25Δ {fmt(smile?.call25)} = {fmt(smile?.tilt)}
                {smile?.base && smile.base !== 'storico' && <span className="text-amber-400"> · base {smile.base}</span>}
              </div>
              <div className="text-[11px] text-slate-500 mt-2">Ipotesi non verificata: le letture vengono salvate (data/sbilanciamento) per controllarla dopo qualche seduta.</div>
            </div>
          </div>
        )}

        {dati && (
          <div className="rounded-lg bg-slate-900 border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-slate-400">
                <tr className="border-b border-slate-800">
                  <th className="p-2 text-right">Put a</th><th className="p-2 text-right">bid / ask</th><th className="p-2 text-right">IV</th>
                  <th className="p-2 text-center">Dist.</th>
                  <th className="p-2 text-left">IV</th><th className="p-2 text-left">bid / ask</th><th className="p-2 text-left">Call a</th>
                  <th className="p-2 text-center w-56">Scarto (call − put)</th><th className="p-2 text-left">Stato</th>
                </tr>
              </thead>
              <tbody>
                {dati.righe.map((r) => {
                  const w = (Math.abs(r.scarto) / maxScarto) * 50;
                  const c = coloreStato(r.stato);
                  return (
                    <tr key={r.d} className="border-b border-slate-800/60">
                      <td className="p-2 text-right text-slate-300">{r.kPut}</td>
                      <td className="p-2 text-right" style={{ color: r.stato === 'put' ? ROSSO : undefined }}>{fmt(r.put.bid)} / {fmt(r.put.ask)}</td>
                      <td className="p-2 text-right text-slate-500">{fmt(r.put.iv, 1)}</td>
                      <td className="p-2 text-center font-semibold">±{r.d}</td>
                      <td className="p-2 text-left text-slate-500">{fmt(r.call.iv, 1)}</td>
                      <td className="p-2 text-left" style={{ color: r.stato === 'call' ? VERDE : undefined }}>{fmt(r.call.bid)} / {fmt(r.call.ask)}</td>
                      <td className="p-2 text-left text-slate-300">{r.kCall}</td>
                      <td className="p-2">
                        <div className="relative h-3 bg-slate-800 rounded">
                          <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} />
                          <div className="absolute top-0 bottom-0 rounded" style={{ background: c, opacity: r.stato === 'economiche' ? 0.3 : 0.9,
                            left: r.scarto >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }} />
                        </div>
                        <div className="text-[10px] text-center text-slate-400">{r.scarto > 0 ? '+' : ''}{r.scarto.toFixed(1)}%</div>
                      </td>
                      <td className="p-2 text-xs" style={{ color: c }}>
                        {r.stato === 'bilanciati' ? 'bilanciate' : r.stato === 'economiche' ? 'troppo economiche' : r.stato === 'call' ? 'call più care' : 'put più care'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="p-2 text-[11px] text-slate-500">
              Bilanciate = gli intervalli bid-ask si sovrappongono (con quei prezzi non si può dire quale costi di più). Strike SPX veri, a coppie simmetriche attorno al centro (lo strike o il punto fra due strike più vicino al forward).
              Sotto 0,10 di prezzo il confronto non vale.
            </div>
          </div>
        )}

        {dati && (
          <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Oggi</div>
            <Storia storia={dati.storia} />
          </div>
        )}
      </div>
    </div>
  );
}
