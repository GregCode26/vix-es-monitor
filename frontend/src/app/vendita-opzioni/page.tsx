'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

/**
 * VENDITA OPZIONI: per ogni titolo in portafoglio, put e call a ~45 giorni
 * attorno a delta 0,20 (5 strike per lato), con la IV di oggi rispetto al suo
 * anno. I dati vengono da `execution/vendita_opzioni.py` (sola lettura IBKR).
 * Le put selezionate sommano l'impegno in caso di assegnazione, da
 * confrontare con i fondi del conto.
 */

interface Opzione {
    strike: number; bid: number | null; ask: number | null; mid: number | null;
    fonte: 'bid' | 'chiusura' | 'nessuno'; prezzo: number | null;
    delta: number | null; iv: number | null; theta: number | null; vega: number | null;
    distanzaPct: number; sigma: number | null; spreadPct: number | null;
    nellaBanda: boolean; consigliata?: boolean;
    premioContratto?: number; pareggio?: number; contantiAssegnazione?: number; rendAnnuo?: number | null;
}
interface Posseduta {
    lato: 'P' | 'C'; strike: number; scadenza: string; quantita: number;
    prezzoMedio: number | null; prezzo: number | null; pnl: number | null;
}
interface Titolo {
    ticker: string; errore?: string; spot?: number; fonteSpot?: string;
    azioni: number; carico: number | null; opzioni: Posseduta[];
    callCoperteLibere: number; impegnoPut: number | null;
    iv30?: number; ivMin?: number; ivMax?: number; ivRank?: number | null; ivPercentile?: number; hv30?: number;
    scadenza?: string; dte?: number; put?: Opzione[]; call?: Opzione[];
}
interface Conto {
    valoreNetto?: number; contanti?: number; fondiDisponibili?: number; liquiditaEccesso?: number;
    margineMantenimento?: number; valuta?: string; usdInBase?: number; impegnoPutTotale?: number;
}
interface Ultimo { ora: string; conto: Conto; titoli: Titolo[] }
interface Stato { inCorso: boolean; titolo?: string; fatti?: number; totale?: number; errore?: string }

const num = (v: number | null | undefined, cifre = 2) => v == null ? '–' :
    v.toLocaleString('it-IT', { minimumFractionDigits: cifre, maximumFractionDigits: cifre });
const intero = (v: number | null | undefined) => num(v, 0);
const dataBreve = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const oraIt = (iso: string) => new Date(iso).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** IV alta = sopra la meta' del suo range annuo o sopra il 70% dei giorni dell'anno. */
function giudizioIv(t: Titolo): { testo: string; classe: string } {
    const rank = t.ivRank ?? null, perc = t.ivPercentile ?? null;
    if (rank == null && perc == null) return { testo: 'IV n.d.', classe: 'bg-slate-800 text-slate-400' };
    if ((rank ?? 0) >= 50 || (perc ?? 0) >= 70) return { testo: 'IV ALTA: premi ricchi', classe: 'bg-emerald-900/60 text-emerald-300 border border-emerald-700' };
    if ((rank ?? 100) < 25 && (perc ?? 100) < 40) return { testo: 'IV BASSA: premi magri', classe: 'bg-slate-800 text-slate-400 border border-slate-700' };
    return { testo: 'IV nella media', classe: 'bg-amber-900/40 text-amber-300 border border-amber-800' };
}

function Tabella({ t, lato, scelte, scegli }: {
    t: Titolo; lato: 'put' | 'call';
    scelte: Set<string>; scegli: (chiave: string) => void;
}) {
    const righe = t[lato] ?? [];
    const isPut = lato === 'put';
    const scoperte = !isPut && t.callCoperteLibere === 0;
    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 mb-1">
                <h3 className={`text-sm font-bold ${isPut ? 'text-rose-300' : 'text-sky-300'}`}>
                    {isPut ? 'PUT da vendere' : 'CALL coperte da vendere'}
                </h3>
                {!isPut && (
                    <span className="text-xs text-slate-400">
                        contratti coperti liberi: <b className={scoperte ? 'text-red-400' : 'text-slate-200'}>{t.callCoperteLibere}</b>
                    </span>
                )}
            </div>
            {scoperte && (
                <p className="text-xs text-red-400 mb-1">
                    Nessuna call coperta: servono 100 azioni per contratto non già impegnate. Vendere queste call sarebbe scoperto.
                </p>
            )}
            <div className="overflow-x-auto border border-slate-800 rounded">
                <table className="w-full text-xs tabular-nums">
                    <thead className="bg-slate-900 text-slate-400">
                        <tr className="text-right">
                            {isPut && <th className="px-1.5 py-1"><span className="sr-only">Scegli</span></th>}
                            <th className="px-1.5 py-1 text-left">Strike</th>
                            <th className="px-1.5 py-1" title="Probabilità approssimata di finire ITM a scadenza">Δ</th>
                            <th className="px-1.5 py-1" title="Bid (quanto incassi vendendo) o chiusura di ieri se la cash è chiusa">Prezzo</th>
                            <th className="px-1.5 py-1" title="Incasso per 1 contratto (100 azioni)">Incasso</th>
                            <th className="px-1.5 py-1" title="Prezzo dell'azione a scadenza oltre cui perdi">Pareggio</th>
                            <th className="px-1.5 py-1" title="Distanza dello strike dal prezzo attuale">Dist.</th>
                            <th className="px-1.5 py-1" title="Distanza in deviazioni standard fino a scadenza">σ</th>
                            <th className="px-1.5 py-1" title="Theta: USD al giorno che incassi dal tempo, per contratto">Θ $/g</th>
                            <th className="px-1.5 py-1" title="Vega: USD per contratto per ogni punto di IV che scende">Vega</th>
                            <th className="px-1.5 py-1" title={isPut ? 'Premio / strike, annualizzato' : 'Premio / prezzo azione, annualizzato'}>Annuo</th>
                            <th className="px-1.5 py-1">{isPut ? 'Se assegnata' : 'vs carico'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {righe.map(r => {
                            const chiave = `${t.ticker}|${r.strike}`;
                            const sotto = !isPut && t.carico != null && r.strike < t.carico;
                            const classe = r.consigliata ? 'bg-emerald-950/60 outline outline-1 outline-emerald-700'
                                : r.nellaBanda ? 'bg-slate-900/60' : '';
                            return (
                                <tr key={r.strike} className={`border-t border-slate-800 text-right ${classe}`}>
                                    {isPut && (
                                        <td className="px-1.5 py-1 text-center">
                                            <input
                                                type="checkbox" aria-label={`Seleziona put ${r.strike}`}
                                                checked={scelte.has(chiave)} onChange={() => scegli(chiave)}
                                                disabled={!r.contantiAssegnazione}
                                                className="accent-emerald-500"
                                            />
                                        </td>
                                    )}
                                    <td className="px-1.5 py-1 text-left font-bold text-slate-100">
                                        {r.strike}{r.consigliata && <span className="ml-1 text-emerald-400" title="Più vicina a delta 0,20 nella banda 0,15-0,30">★</span>}
                                    </td>
                                    <td className="px-1.5 py-1">{num(r.delta)}</td>
                                    <td className={`px-1.5 py-1 ${r.fonte === 'chiusura' ? 'text-amber-400' : 'text-slate-100'}`}
                                        title={r.fonte === 'bid' ? `bid ${num(r.bid)} / ask ${num(r.ask)}${r.spreadPct != null ? ` · spread ${r.spreadPct}% del mid` : ''}` : 'chiusura di ieri: niente bid/ask adesso'}>
                                        {num(r.prezzo)}
                                    </td>
                                    <td className="px-1.5 py-1 text-slate-100">{intero(r.premioContratto)}</td>
                                    <td className="px-1.5 py-1">{num(r.pareggio)}</td>
                                    <td className="px-1.5 py-1">{num(r.distanzaPct, 1)}%</td>
                                    <td className="px-1.5 py-1">{num(r.sigma, 1)}</td>
                                    <td className="px-1.5 py-1">{num(r.theta)}</td>
                                    <td className="px-1.5 py-1">{num(r.vega)}</td>
                                    <td className="px-1.5 py-1">{num(r.rendAnnuo, 0)}%</td>
                                    <td className={`px-1.5 py-1 ${sotto ? 'text-red-400' : 'text-slate-400'}`}
                                        title={sotto ? 'Strike sotto il prezzo di carico: se assegnata vendi le azioni in perdita' : undefined}>
                                        {isPut ? `${intero(r.contantiAssegnazione)} $`
                                            : t.carico == null ? '–' : sotto ? 'sotto carico' : 'sopra carico'}
                                    </td>
                                </tr>
                            );
                        })}
                        {righe.length === 0 && (
                            <tr><td colSpan={12} className="px-2 py-2 text-slate-500">Nessuno strike</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function SchedaTitolo({ t, scelte, scegli }: { t: Titolo; scelte: Set<string>; scegli: (c: string) => void }) {
    const g = giudizioIv(t);
    const ivHv = t.iv30 && t.hv30 ? t.iv30 / t.hv30 : null;
    return (
        <section className="border border-slate-800 rounded-lg p-3 bg-slate-950">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-lg font-bold">{t.ticker}</h2>
                <span className="text-sm tabular-nums">Spot <b>{num(t.spot)}</b></span>
                {t.azioni > 0 && (
                    <span className="text-xs text-slate-400 tabular-nums">{intero(t.azioni)} azioni · carico {num(t.carico)}</span>
                )}
                {t.scadenza && <span className="text-xs text-violet-300">Scadenza {dataBreve(t.scadenza)} · {t.dte} gg</span>}
                <span className={`text-xs px-2 py-0.5 rounded ${g.classe}`}>{g.testo}</span>
            </div>
            {t.errore ? (
                <p className="text-sm text-red-400 mt-2">{t.errore}</p>
            ) : (
                <>
                    <div className="mt-1 text-xs text-slate-400 tabular-nums">
                        IV 30gg <b className="text-slate-200">{num(t.iv30, 1)}%</b>
                        {' '}(anno {num(t.ivMin, 0)}–{num(t.ivMax, 0)}%) · rank <b className="text-slate-200">{num(t.ivRank, 0)}</b>
                        {' '}· percentile <b className="text-slate-200">{num(t.ivPercentile, 0)}</b>
                        {' '}· vol. storica 30gg {num(t.hv30, 1)}%
                        {ivHv != null && <> · IV/storica <b className={ivHv > 1 ? 'text-emerald-300' : 'text-slate-200'}>{num(ivHv)}</b></>}
                    </div>
                    {t.opzioni.length > 0 && (
                        <div className="mt-1 text-xs text-slate-500 tabular-nums">
                            Già aperte: {t.opzioni.map(o => (
                                <span key={`${o.lato}${o.strike}${o.scadenza}`} className="mr-3">
                                    {o.quantita > 0 ? '+' : ''}{o.quantita} {o.strike}{o.lato} {dataBreve(o.scadenza)}
                                    <span className={(o.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}> {o.pnl != null && o.pnl > 0 ? '+' : ''}{intero(o.pnl)}$</span>
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="mt-2 grid gap-3 xl:grid-cols-2">
                        <Tabella t={t} lato="put" scelte={scelte} scegli={scegli} />
                        <Tabella t={t} lato="call" scelte={scelte} scegli={scegli} />
                    </div>
                </>
            )}
        </section>
    );
}

export default function VenditaOpzioniPage() {
    const [locale, setLocale] = useState(true);
    const [ultimo, setUltimo] = useState<Ultimo | null>(null);
    const [stato, setStato] = useState<Stato | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [scelte, setScelte] = useState<Set<string>>(new Set());

    const carica = useCallback(() => fetch('/api/vendita-opzioni').then(r => r.json()).then(d => {
        setLocale(d.local);
        if (d.ultimo) setUltimo(d.ultimo);
        setStato(d.stato ?? null);
    }).catch(e => setErrore(String(e))), []);

    useEffect(() => {
        fetch('/api/vendita-opzioni').then(r => r.json()).then(d => {
            setLocale(d.local);
            if (d.ultimo) setUltimo(d.ultimo);
            setStato(d.stato ?? null);
        }).catch(e => setErrore(String(e)));
    }, []);
    // Durante il calcolo si rilegge lo stato ogni 3 s; alla fine arriva il nuovo `ultimo`.
    useEffect(() => {
        if (!stato?.inCorso) return;
        const id = setInterval(carica, 3000);
        return () => clearInterval(id);
    }, [stato?.inCorso, carica]);

    async function aggiorna() {
        setErrore(null);
        const r = await fetch('/api/vendita-opzioni', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) setErrore((await r.json().catch(() => ({}))).errore ?? `Errore ${r.status}`);
        carica();
    }

    function scegli(chiave: string) {
        setScelte(prima => {
            const nuovo = new Set(prima);
            if (nuovo.has(chiave)) nuovo.delete(chiave); else nuovo.add(chiave);
            return nuovo;
        });
    }

    const titoli = useMemo(() => [...(ultimo?.titoli ?? [])]
        .sort((a, b) => (b.ivRank ?? -1) - (a.ivRank ?? -1)), [ultimo]);

    const conto = ultimo?.conto ?? {};
    const valuta = conto.valuta ?? '';
    const cambio = conto.usdInBase ?? null;
    const nuovoImpegno = useMemo(() => {
        let usd = 0, incasso = 0;
        for (const t of ultimo?.titoli ?? []) for (const r of t.put ?? []) {
            if (scelte.has(`${t.ticker}|${r.strike}`)) { usd += r.contantiAssegnazione ?? 0; incasso += r.premioContratto ?? 0; }
        }
        return { usd, incasso };
    }, [scelte, ultimo]);
    const impegnoTotUsd = (conto.impegnoPutTotale ?? 0) + nuovoImpegno.usd;
    const inBase = (usd: number) => cambio ? usd * cambio : null;
    const daChiusura = titoli.some(t => [...(t.put ?? []), ...(t.call ?? [])].some(r => r.fonte === 'chiusura'));

    return (
        <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
            <div className="flex items-center justify-between gap-4">
                <h1 className="text-xl font-bold tracking-wide">VENDITA OPZIONI</h1>
                <Link href="/market" className="px-3 py-1.5 text-xs font-bold rounded border border-slate-600 text-slate-200 hover:bg-slate-800 hover:border-slate-400">
                    ← MARKET
                </Link>
            </div>
            <p className="text-sm text-slate-400 mt-1 max-w-4xl">
                Per ogni titolo in portafoglio: put e call a circa 45 giorni intorno a delta 0,20 (★ = la più vicina nella banda 0,15–0,30).
                Conviene vendere quando la IV è alta rispetto al suo anno: il premio scende sia col tempo (theta) sia col rientro della IV (vega).
                Prezzo = bid; le call solo se coperte da azioni. Sola lettura da IBKR, nessun ordine.
            </p>

            {!locale && <p className="mt-4 text-sm text-amber-400">Funziona solo in locale, con TWS aperto.</p>}

            <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={aggiorna}
                    disabled={!locale || !!stato?.inCorso}
                    className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 rounded-lg text-sm font-bold"
                >
                    Aggiorna da IBKR
                </button>
                {stato?.inCorso && (
                    <span className="text-sm text-slate-300">
                        Leggo {stato.titolo}{stato.totale ? ` (${(stato.fatti ?? 0) + 1}/${stato.totale})` : ''}… circa 15 s per titolo
                    </span>
                )}
                {stato?.errore && <span className="text-sm text-red-400">{stato.errore}</span>}
                {ultimo && !stato?.inCorso && <span className="text-xs text-slate-500">Dati delle {oraIt(ultimo.ora)}</span>}
            </div>
            {errore && <p className="mt-2 text-sm text-red-400">{errore}</p>}
            {daChiusura && (
                <p className="mt-2 text-xs text-amber-400">
                    Prezzi in giallo = chiusura di ieri (opzioni non quotate adesso, la cash USA apre alle 15:30): delta e IV sono ricalcolati da quel prezzo. Riaggiorna a mercato aperto per i bid veri.
                </p>
            )}

            {ultimo && (
                <div className="mt-4 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 text-sm tabular-nums">
                    {[
                        ['Valore netto', `${intero(conto.valoreNetto)} ${valuta}`],
                        ['Contanti', `${intero(conto.contanti)} ${valuta}`],
                        ['Fondi disponibili', `${intero(conto.fondiDisponibili)} ${valuta}`],
                        ['Liquidità in eccesso', `${intero(conto.liquiditaEccesso)} ${valuta}`],
                        ['Impegno put aperte', `${intero(conto.impegnoPutTotale)} $`],
                        ['Impegno con le scelte', `${intero(impegnoTotUsd)} $${inBase(impegnoTotUsd) != null ? ` ≈ ${intero(inBase(impegnoTotUsd))} ${valuta}` : ''}`],
                    ].map(([nome, valore], i) => (
                        <div key={nome} className={`rounded border px-3 py-2 ${i === 5 && nuovoImpegno.usd ? 'border-emerald-700 bg-emerald-950/40' : 'border-slate-800 bg-slate-900'}`}>
                            <div className="text-xs text-slate-400">{nome}</div>
                            <div className="font-bold">{valore}</div>
                        </div>
                    ))}
                </div>
            )}
            {nuovoImpegno.usd > 0 && (
                <p className="mt-2 text-sm text-slate-300">
                    Put selezionate: incassi <b className="text-emerald-300">{intero(nuovoImpegno.incasso)} $</b>, impegno in caso di assegnazione
                    {' '}<b>{intero(nuovoImpegno.usd)} $</b>.
                    {cambio && conto.contanti != null && inBase(impegnoTotUsd)! > conto.contanti && (
                        <span className="text-amber-400"> Con tutte le put aperte servirebbero {intero(inBase(impegnoTotUsd))} {valuta} contro {intero(conto.contanti)} {valuta} di contanti: le assegnazioni andrebbero a margine.</span>
                    )}
                    <button onClick={() => setScelte(new Set())} className="ml-3 text-xs text-slate-500 hover:text-slate-300">azzera</button>
                </p>
            )}

            {!ultimo && !stato?.inCorso && (
                <p className="mt-6 text-sm text-slate-500">Nessun dato ancora: premi Aggiorna da IBKR (TWS aperto).</p>
            )}

            <div className="mt-5 space-y-4">
                {titoli.map(t => <SchedaTitolo key={t.ticker} t={t} scelte={scelte} scegli={scegli} />)}
            </div>

            {ultimo && (
                <p className="mt-6 text-xs text-slate-500 max-w-4xl">
                    Δ ≈ probabilità di finire ITM. σ = distanza dello strike in deviazioni standard fino a scadenza, con la IV dell&apos;opzione.
                    Rank IV = posizione della IV di oggi fra il minimo e il massimo dell&apos;anno; percentile = quota di giorni dell&apos;anno con IV più bassa.
                    Prima di vendere controlla la data della trimestrale: se cade prima della scadenza, la IV alta è dovuta a quella e dopo il dato il prezzo può saltare.
                </p>
            )}
        </main>
    );
}
