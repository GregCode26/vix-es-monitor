import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { giornoRichiesto, mezzogiornoDi } from '@/lib/giornoRichiesto';
import { minutiRomaDaNy } from '@/lib/orarioNy';

/**
 * Pagina di prova /flusso-greche (19/11/2026): la specifica "Comp/Vend + greche" dell'utente sul nostro
 * SPX 0DTE. Solo file locale `data/volumes/YYYY-MM-DD.json` (mai Supabase: e' 12-19 MB a fine giornata).
 *
 * Differenze dalla specifica, per i dati che abbiamo:
 *  - Comp/Vend: i conti Lee-Ready che il poller dei volumi fa trade per trade (cb/cs/pb/ps, quote
 *    prima del trade, tick test al mid). La stima della specifica (rapporto last/bid/ask fra due
 *    snapshot) richiederebbe lo storico di bid/ask per contratto, che non salviamo. Contano dall'avvio
 *    del poller (`inizioLr`), non dall'apertura.
 *  - Greche: gamma e delta call dallo snapshot IBKR (delta put = delta call - 1, r = q = 0). L'IV non
 *    e' nello snapshot: d1 = N^-1(delta call) e sigma*radq(T) = phi(d1) / (gamma*S), quindi vanna e
 *    charm vengono dalla stessa valutazione IBKR del gamma. Uno solo per strike (call e put uguali).
 *  - Niente modalita' 90d: il poller segue solo lo 0DTE.
 *
 * Il client fa tutti i conti per strike (selettori); qui gli ingredienti e, per il Max Change, il GEXP
 * degli snapshot piu' vicini a ultimo - 5/10/15 minuti (tolleranza +-150 s).
 */

interface RigaVol {
    strike: number;
    calls?: number;
    puts?: number;
    gamma?: number | null;
    delta?: number | null;
    callsOi?: number;
    putsOi?: number;
    cb?: number; cs?: number; pb?: number; ps?: number;
}
interface Snap { time: string; undPrice?: number | null; spxPrice?: number | null; volumes?: RigaVol[] }

export interface RigaGreche {
    strike: number;
    cb: number; cs: number; pb: number; ps: number;
    oiC: number; oiP: number;
    gamma: number;
    deltaC: number;
    deltaP: number;
    vanna: number;
    charm: number;
    /** sigma annua ricavata (per controllo). */
    iv: number | null;
}

export interface RiferimentoMaxChange {
    minuti: number;
    time: string;
    /** strike -> [GEXP netto, GEXP taglia] in $MM per 1%. */
    gexp: Record<string, [number, number]>;
}

const FINESTRE = [5, 10, 15];
const TOLLERANZA_SEC = 150;

const sec = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Inversa della normale standard (Acklam), errore relativo ~1e-9. */
function ninv(p: number): number {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function leggiFile(data: string): Snap[] | null {
    for (const p of [
        path.join(process.cwd(), 'data', 'volumes', `${data}.json`),
        path.join(process.cwd(), 'frontend', 'data', 'volumes', `${data}.json`),
    ]) {
        try {
            if (!fs.existsSync(p)) continue;
            const mtime = fs.statSync(p).mtimeMs;
            if (cache && cache.data === data && cache.mtime === mtime) return cache.snap;
            const snap = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (!Array.isArray(snap)) return null;
            cache = { data, mtime, snap };
            return snap;
        } catch { /* file a meta' scrittura: si riprova al giro dopo */ }
    }
    return null;
}
let cache: { data: string; mtime: number; snap: Snap[] } | null = null;

const r2 = (v: number) => Math.round(v * 100) / 100;
const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const conLr = (r: RigaVol) => r.cb != null && r.cs != null && r.pb != null && r.ps != null;
const spotDi = (s: Snap) => s.undPrice ?? s.spxPrice ?? null;

/** GEXP di uno snapshot per strike: [netto, taglia], call +1 e put -1, $MM per 1%. */
function gexpDi(s: Snap): Record<string, [number, number]> {
    const S = spotDi(s);
    const out: Record<string, [number, number]> = {};
    if (!S) return out;
    const gexK = S * S * 0.01 * 100;
    for (const r of s.volumes ?? []) {
        if (!conLr(r) || r.strike < 0.85 * S || r.strike > 1.15 * S) continue;
        const g = n(r.gamma);
        const ic = r.cb! - r.cs!, ip = r.pb! - r.ps!;
        out[String(r.strike)] = [r2((ic - ip) * g * gexK / 1e6), r2((Math.abs(ic) - Math.abs(ip)) * g * gexK / 1e6)];
    }
    return out;
}

export async function GET(request: NextRequest) {
    const { data } = giornoRichiesto(request.nextUrl.searchParams);
    const snap = leggiFile(data);
    if (!snap || snap.length === 0) {
        return NextResponse.json({ error: `Nessuno snapshot dei volumi per ${data} (il poller raccoglie 9:30-16:00 NY, solo in locale).` }, { status: 503 });
    }

    // L'ultimo snapshot con lo spot e i conti Lee-Ready.
    let i = snap.length - 1;
    while (i >= 0 && !(spotDi(snap[i]) && (snap[i].volumes ?? []).some(conLr))) i--;
    if (i < 0) return NextResponse.json({ error: 'Nessuno snapshot con i conti Lee-Ready.' }, { status: 503 });
    const ultimo = snap[i];
    const S = spotDi(ultimo)!;

    // Tempo alla scadenza: 16:00 NY in ora di Roma di quel giorno; almeno 30 s.
    const scadenzaSec = minutiRomaDaNy('16:00', mezzogiornoDi(data)) * 60;
    const T = Math.max(30, scadenzaSec - sec(ultimo.time)) / (365 * 86400);

    const righe: RigaGreche[] = [];
    for (const r of ultimo.volumes ?? []) {
        if (!conLr(r) || r.strike < 0.85 * S || r.strike > 1.15 * S) continue;
        const gamma = n(r.gamma);
        const deltaC = Math.min(1, Math.max(0, n(r.delta)));
        let vanna = 0, charm = 0, iv: number | null = null;
        if (gamma > 0 && deltaC > 1e-4 && deltaC < 1 - 1e-4) {
            const d1 = ninv(deltaC);
            const sigmaRadT = phi(d1) / (gamma * S);
            const sigma = sigmaRadT / Math.sqrt(T);
            const d2 = d1 - sigmaRadT;
            vanna = -phi(d1) * d2 / sigma;
            charm = phi(d1) * d2 / (2 * T);
            iv = sigma;
        }
        righe.push({
            strike: r.strike, cb: r.cb!, cs: r.cs!, pb: r.pb!, ps: r.ps!,
            oiC: n(r.callsOi), oiP: n(r.putsOi),
            gamma, deltaC, deltaP: deltaC - 1, vanna, charm, iv,
        });
    }
    righe.sort((a, b) => a.strike - b.strike);

    // Max Change: lo snapshot piu' vicino a ultimo - N minuti, entro +-150 s.
    const tUltimo = sec(ultimo.time);
    const riferimenti: RiferimentoMaxChange[] = [];
    for (const minuti of FINESTRE) {
        const obiettivo = tUltimo - minuti * 60;
        let migliore: Snap | null = null, dist = Infinity;
        for (let j = i; j >= 0; j--) {
            const t = sec(snap[j].time);
            if (t < obiettivo - TOLLERANZA_SEC) break;
            const dd = Math.abs(t - obiettivo);
            if (dd <= TOLLERANZA_SEC && dd < dist && spotDi(snap[j]) && (snap[j].volumes ?? []).some(conLr)) { migliore = snap[j]; dist = dd; }
        }
        if (migliore) riferimenti.push({ minuti, time: migliore.time, gexp: gexpDi(migliore) });
    }

    // Candele a 1 minuto dello spot (undPrice, il sottostante su cui IBKR valuta il gamma), dalle 9:30 NY.
    const aperturaSec = minutiRomaDaNy('09:30', mezzogiornoDi(data)) * 60;
    // Ogni candela porta anche `mm`: gli ES che il market maker ha dovuto comprare (+) o vendere (−) in quel
    // minuto per restare coperto = variazione del delta totale dei clienti (Lee-Ready, delta IBKR dello snapshot),
    // contratti SPX x 100 / 50 = ES. Comprende i nuovi scambi (`mmFlusso`, nuovi contratti x delta di prima) e
    // il movimento di prezzo/tempo/vol sulle posizioni gia' aperte (`mmGreche`). Delta mancante = l'ultimo noto
    // dello strike, delta negativo (put) riportato a quello della call per parita'.
    const candele: { t: string; o: number; h: number; l: number; c: number; mm?: number; mmFlusso?: number; mmGreche?: number }[] = [];
    const ultimoDelta = new Map<number, number>();
    // Per strike: n = call + put nette dei clienti, ip = put nette, d = delta call. Delta clienti = n*d - ip.
    type Pos = { n: number; ip: number; d: number };
    let prec: Map<number, Pos> | null = null;
    for (const sn of snap) {
        const px = spotDi(sn);
        if (!px || sec(sn.time) < aperturaSec) continue;
        const t = sn.time.slice(0, 5);
        let ult = candele[candele.length - 1];
        if (ult && ult.t === t) { ult.h = Math.max(ult.h, px); ult.l = Math.min(ult.l, px); ult.c = px; }
        else { ult = { t, o: px, h: px, l: px, c: px }; candele.push(ult); }

        if (!(sn.volumes ?? []).some(conLr)) continue;
        const ora = new Map<number, Pos>();
        for (const r of sn.volumes ?? []) {
            if (!conLr(r)) continue;
            let d = typeof r.delta === 'number' && Number.isFinite(r.delta) ? r.delta : ultimoDelta.get(r.strike);
            if (d == null) continue;
            if (d < 0) d += 1;
            d = Math.min(1, Math.max(0, d));
            ultimoDelta.set(r.strike, d);
            const ip = r.pb! - r.ps!;
            ora.set(r.strike, { n: (r.cb! - r.cs!) + ip, ip, d });
        }
        if (prec) {
            // Variazione di n*d - ip: nuovi contratti al delta di prima (flusso) + posizioni col delta cambiato (greche).
            let flusso = 0, greche = 0;
            for (const [k, x] of ora) {
                const p = prec.get(k);
                if (!p) { flusso += x.n * x.d - x.ip; continue; }
                flusso += (x.n - p.n) * p.d - (x.ip - p.ip);
                greche += x.n * (x.d - p.d);
            }
            ult.mmFlusso = (ult.mmFlusso ?? 0) + flusso * 2;
            ult.mmGreche = (ult.mmGreche ?? 0) + greche * 2;
            ult.mm = ult.mmFlusso + ult.mmGreche;
        }
        prec = ora;
    }
    for (const c of candele) {
        if (c.mm != null) { c.mm = Math.round(c.mm); c.mmFlusso = Math.round(c.mmFlusso!); c.mmGreche = Math.round(c.mmGreche!); }
    }

    const primoLr = snap.find((s) => (s.volumes ?? []).some(conLr))?.time ?? null;
    return NextResponse.json({ date: data, time: ultimo.time, spot: S, T, inizioLr: primoLr, righe, riferimenti, candele });
}
