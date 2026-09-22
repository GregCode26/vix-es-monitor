'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bias, Segnale } from '@/lib/aiSignal';

interface Risposta {
    creato: string;
    ora: string;
    esf: number | null;
    modello: string;
    via: string;
    fonti: Record<string, boolean>;
    segnale: Segnale;
}

const AUTO_MS = 5 * 60_000;

const COLORE: Record<Bias, string> = {
    LONG: 'text-green-400 border-green-500/50 bg-green-500/10',
    SHORT: 'text-red-400 border-red-500/50 bg-red-500/10',
    NEUTRALE: 'text-slate-300 border-slate-500/50 bg-slate-500/10',
};
const FRECCIA: Record<Bias, string> = { LONG: '▲', SHORT: '▼', NEUTRALE: '◆' };

/** Pannello "AI Signal": chiede a /api/ai-signal un bias su ES. Solo studio. */
export default function AiSignalPanel({ onClose }: { onClose: () => void }) {
    const [dati, setDati] = useState<Risposta | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [inCorso, setInCorso] = useState(false);
    const [auto, setAuto] = useState(false);
    const inCorsoRef = useRef(false);

    const analizza = useCallback(async () => {
        if (inCorsoRef.current) return;
        inCorsoRef.current = true;
        setInCorso(true);
        setErrore(null);
        try {
            const res = await fetch('/api/ai-signal', { method: 'POST' });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
            setDati(json);
        } catch (e) {
            setErrore((e as Error).message);
        } finally {
            inCorsoRef.current = false;
            setInCorso(false);
        }
    }, []);

    useEffect(() => {
        if (!auto) return;
        const id = setInterval(analizza, AUTO_MS);
        return () => clearInterval(id);
    }, [auto, analizza]);

    const s = dati?.segnale;

    return (
        <div className="fixed right-4 top-24 z-50 w-[380px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-120px)] overflow-y-auto bg-[#12141a] border border-slate-700 rounded-lg shadow-2xl p-4 text-sm">
            <div className="flex items-center justify-between mb-3">
                <span className="font-bold text-purple-300 tracking-tight">AI SIGNAL · ES</span>
                <button onClick={onClose} className="text-slate-500 hover:text-white px-1" title="Chiudi">✕</button>
            </div>

            <div className="flex items-center gap-2 mb-3">
                <button
                    onClick={analizza}
                    disabled={inCorso}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border bg-purple-600/30 text-purple-200 border-purple-500/50 hover:bg-purple-600/40 disabled:opacity-50"
                >
                    {inCorso ? 'Analisi in corso…' : 'Analizza ora'}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                    <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                    auto ogni 5 min
                </label>
            </div>

            {errore && <div className="mb-3 p-2 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-xs">{errore}</div>}

            {!s && !errore && !inCorso && (
                <p className="text-slate-500 text-xs">
                    Legge market, GEX, IV monitor, market tide e pressione MM, e chiede a Claude un bias su ES per i prossimi 15–60 minuti.
                </p>
            )}

            {s && dati && (
                <div className={inCorso ? 'opacity-60' : ''}>
                    <div className={`flex items-center justify-between p-3 rounded-lg border ${COLORE[s.bias]}`}>
                        <div className="text-2xl font-bold">{FRECCIA[s.bias]} {s.bias}</div>
                        <div className="text-right">
                            <div className="text-lg font-bold">{s.confidenza}%</div>
                            <div className="text-[10px] text-slate-400">confidenza</div>
                        </div>
                    </div>

                    <div className="mt-2 text-[11px] text-slate-500">
                        {dati.ora} · ES {dati.esf ?? '—'} · {s.orizzonte}
                    </div>

                    <p className="mt-3 text-slate-200">{s.sintesi}</p>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        {([['Rif.', s.livelli.riferimento], ['Invalida', s.livelli.invalidazione], ['Obiettivo', s.livelli.obiettivo]] as const).map(([nome, v]) => (
                            <div key={nome} className="p-1.5 rounded bg-slate-800/60">
                                <div className="text-[10px] text-slate-500">{nome}</div>
                                <div className="font-bold text-slate-200">{v ?? '—'}</div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-3 space-y-1.5">
                        {s.motivi.map((m, i) => (
                            <div key={i} className="text-xs flex gap-2">
                                <span className={COLORE[m.direzione].split(' ')[0]}>{FRECCIA[m.direzione]}</span>
                                <span><span className="text-slate-400 font-bold">{m.fonte}:</span> <span className="text-slate-300">{m.osservazione}</span></span>
                            </div>
                        ))}
                    </div>

                    {s.rischi.length > 0 && (
                        <div className="mt-3 text-xs text-amber-300/80">
                            <div className="font-bold mb-1">Rischi</div>
                            <ul className="list-disc pl-4 space-y-0.5">{s.rischi.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        </div>
                    )}

                    <div className="mt-3 text-[10px] text-slate-600">
                        Fonti: {Object.entries(dati.fonti).map(([k, ok]) => `${k} ${ok ? '✓' : '✗'}`).join(' · ')} · {dati.modello} via {dati.via}
                    </div>
                </div>
            )}

            <div className="mt-3 pt-2 border-t border-slate-800 text-[10px] text-slate-600">
                Esercizio di studio, non un consiglio operativo. Ogni segnale è registrato in .tmp/ai-signals.jsonl per verificarlo a posteriori.
            </div>
        </div>
    );
}
