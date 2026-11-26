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
  const [minuti, setMinuti] = useState(3);
  const p = storia.filter((x) => x.indice != null && x.spot != null);
  if (p.length < 2) return <div className="text-xs text-slate-500">La storia si riempie mentre la pagina resta aperta (una lettura ogni 10 s).</div>;
  const W = 900, H = 220, SX = 44; // SX = spazio a sinistra per la scala dell'indice
  const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
  const t0 = sec(p[0].time), t1 = Math.max(sec(p[p.length - 1].time), t0 + 1);
  const x = (t: string) => SX + ((sec(t) - t0) / (t1 - t0)) * (W - SX - 4);
  // media mobile sugli ultimi `minuti` (a tempo, non a numero di letture: i buchi non la falsano)
  const morbido: number[] = [];
  let inizio = 0, somma = 0;
  for (let i = 0; i < p.length; i++) {
    somma += p[i].indice!;
    while (sec(p[i].time) - sec(p[inizio].time) > minuti * 60) somma -= p[inizio++].indice!;
    morbido.push(somma / (i - inizio + 1));
  }
  const media = p.reduce((t, q) => t + q.indice!, 0) / p.length;
  // scala dell'indice sempre con lo 0 dentro: e' il riferimento "bilanciate"
  const valori = [...morbido, 0];
  const lo = Math.min(...valori), hi = Math.max(...valori);
  const yi = (v: number) => H - 10 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (H - 20);
  const sLo = Math.min(...p.map((q) => q.spot!)), sHi = Math.max(...p.map((q) => q.spot!));
  const ys = (v: number) => H - 10 - ((v - sLo) / Math.max(sHi - sLo, 1e-9)) * (H - 20);
  const linea = (y: number[]) => y.map((v, i) => `${i ? 'L' : 'M'}${x(p[i].time).toFixed(1)},${v.toFixed(1)}`).join(' ');
  const passo = (hi - lo) > 60 ? 20 : (hi - lo) > 25 ? 10 : 5;
  const tacche: number[] = [];
  for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) tacche.push(v);
  const ultimo = morbido[morbido.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-56 bg-slate-900/60 rounded">
        {tacche.map((v) => (
          <g key={v}>
            <line x1={SX} x2={W} y1={yi(v)} y2={yi(v)} stroke="#1e293b" strokeWidth={1} />
            <text x={SX - 4} y={yi(v) + 3} fill="#64748b" fontSize={10} textAnchor="end">{v}%</text>
          </g>
        ))}
        <line x1={SX} x2={W} y1={yi(0)} y2={yi(0)} stroke="#e2e8f0" strokeWidth={1.2} />
        <text x={W - 6} y={yi(0) < 20 ? yi(0) + 13 : yi(0) - 4} fill="#e2e8f0" fontSize={10} textAnchor="end">0 = bilanciate · sopra call più care, sotto put più care</text>
        <line x1={SX} x2={W} y1={yi(media)} y2={yi(media)} stroke="#38bdf8" strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
        <text x={W - 6} y={yi(media) - 4} fill="#38bdf8" fontSize={10} textAnchor="end" opacity={0.8}>media di oggi {media.toFixed(1)}%</text>
        <path d={linea(p.map((q) => ys(q.spot!)))} fill="none" stroke="#facc15" strokeWidth={1.2} opacity={0.8} />
        <path d={linea(morbido.map(yi))} fill="none" stroke="#38bdf8" strokeWidth={2.2} />
      </svg>
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-slate-400 mt-1">
        <span>{p[0].time}</span>
        <span>
          <span className="text-sky-400">— scarto medio call/put, media mobile</span>{' '}
          {[1, 3, 5, 10].map((m) => (
            <button key={m} onClick={() => setMinuti(m)} className={`px-1.5 rounded ${m === minuti ? 'bg-sky-900 text-sky-200' : 'hover:text-slate-200'}`}>{m} min</button>
          ))}
          {' '}· adesso <b className="text-sky-300">{ultimo.toFixed(1)}%</b> ({ultimo >= media ? 'call più care' : 'put più care'} della media di oggi)
          {' '}· <span className="text-yellow-400">— SPX</span> (scala sua)
        </span>
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
            <h1 className="text-xl font-bold">Sbilanciamento vertical call / put <span className="text-xs font-normal text-amber-400 align-middle">IN PROVA</span></h1>
            <div className="text-xs text-slate-400">
              SPX 0DTE {dati?.expiry ?? ''} · vertical da 5 punti al mid, call sopra contro put sotto, stessa distanza dal centro · ogni 10 s
              {l && <> · dati delle {l.time} · SPX {fmt(l.spot)} · forward {fmt(l.fwd)} · centro {l.centro}</>}
            </div>
          </div>
        </div>

        {errore && <div className="p-3 rounded bg-amber-900/40 border border-amber-700 text-amber-200 text-sm">{errore}</div>}

        {l && (
          <div className="grid md:grid-cols-2 gap-3">
            <div className="p-4 rounded-lg bg-slate-900 border border-slate-800">
              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Ai prezzi di adesso</div>
              <div className="text-lg font-semibold">
                {l.inizio
                  ? <>Più care le <span style={{ color: l.inizio.lato === 'call' ? VERDE : ROSSO }}>{l.inizio.lato === 'call' ? 'CALL vertical (sopra)' : 'PUT vertical (sotto)'}</span>, {l.inizio.d === 0 ? "già dall'ATM" : `da ${l.inizio.d} punti`}</>
                  : <span className="text-slate-300">Bilanciate su tutte le distanze</span>}
              </div>
              <div className="text-sm text-slate-300 mt-1">
                {l.bilanciati} bilanciate su {l.confrontabili} · {l.put} con put più care · {l.call} con call più care · scarto medio{' '}
                <b style={{ color: (l.indice ?? 0) >= 0 ? VERDE : ROSSO }}>{fmt(l.indice, 1)}%</b>
              </div>
              <div className="text-[11px] text-slate-500 mt-2">Un vertical da 5 vale circa 5 × la probabilità che SPX chiuda oltre la sua metà: qui si confronta quanto il mercato paga arrivare a +d contro −d. Con lo skew SPX i vertical put lontani di solito costano di più.</div>
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
                  <th className="p-2 text-right">Put vertical</th><th className="p-2 text-right">bid / ask</th><th className="p-2 text-right">mid</th>
                  <th className="p-2 text-center">Dist.</th>
                  <th className="p-2 text-left">mid</th><th className="p-2 text-left">bid / ask</th><th className="p-2 text-left">Call vertical</th>
                  <th className="p-2 text-center w-56">Scarto (call − put)</th><th className="p-2 text-left">Stato</th>
                </tr>
              </thead>
              <tbody>
                {dati.righe.map((r) => {
                  const w = (Math.abs(r.scarto) / maxScarto) * 50;
                  const c = coloreStato(r.stato);
                  return (
                    <tr key={r.d} className="border-b border-slate-800/60">
                      <td className="p-2 text-right text-slate-300">{r.kPut} / {r.kPut2}</td>
                      <td className="p-2 text-right" style={{ color: r.stato === 'put' ? ROSSO : undefined }}>{fmt(r.put.bid)} / {fmt(r.put.ask)}</td>
                      <td className="p-2 text-right font-semibold" style={{ color: r.stato === 'put' ? ROSSO : undefined }}>{fmt(r.put.mid)}</td>
                      <td className="p-2 text-center font-semibold">±{r.d}</td>
                      <td className="p-2 text-left font-semibold" style={{ color: r.stato === 'call' ? VERDE : undefined }}>{fmt(r.call.mid)}</td>
                      <td className="p-2 text-left" style={{ color: r.stato === 'call' ? VERDE : undefined }}>{fmt(r.call.bid)} / {fmt(r.call.ask)}</td>
                      <td className="p-2 text-left text-slate-300">{r.kCall} / {r.kCall2}</td>
                      <td className="p-2">
                        <div className="relative h-3 bg-slate-800 rounded">
                          <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: '50%' }} />
                          <div className="absolute top-0 bottom-0 rounded" style={{ background: c, opacity: r.stato === 'economiche' ? 0.3 : 0.9,
                            left: r.scarto >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }} />
                        </div>
                        <div className="text-[10px] text-center text-slate-400">{r.scarto > 0 ? '+' : ''}{r.scarto.toFixed(1)}%</div>
                      </td>
                      <td className="p-2 text-xs" style={{ color: c }}>
                        {r.stato === 'bilanciati' ? 'bilanciati' : r.stato === 'economiche' ? 'troppo economiche' : r.stato === 'call' ? 'call più care' : 'put più care'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="p-2 text-[11px] text-slate-500">
              Vertical da 5 punti: put = P(vicino) − P(lontano), call = C(vicino) − C(lontano), al mid. Bilanciate = mid entro 0,05 (un tick). Bid/ask = prezzi naturali del vertical, solo indicativi.
              Strike SPX veri, a coppie simmetriche attorno al centro (lo strike o il punto fra due strike più vicino al forward); Dist. = dal centro allo strike vicino. Sotto 0,10 di mid il confronto non vale.
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
