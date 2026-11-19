import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { giornoRichiesto } from '@/lib/giornoRichiesto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pressione-corretta[?date=YYYY-MM-DD] — la serie temporale di
 * /hedging-pressure rifatta con le correzioni del 13/11/2026 (pagina di prova
 * /pressione-corretta). Differenze dalla serie originale:
 *  a/b) posizione dei dealer dai lati Lee-Ready (cb/cs/pb/ps), non dal volume
 *       senza lato con "call +, put -": dealer = -((cb-cs) + (pb-ps)). Le due
 *       gambe di un vertical si compensano invece di sommarsi.
 *  c)   copertura in contratti ES: G = gamma x N x 100 / 50 (ES per punto SPX),
 *       e il ribilanciamento di ogni intervallo = -G x (S_t - S_t-1), sommato
 *       nel tempo con la posizione di quel momento (non GEX x spostamento
 *       dall'apertura, che era un'unita' ibrida).
 *  d)   nessun peso di vicinanza: la gamma cala gia' da sola lontano dallo spot.
 *  e/f) nessuna vanna: gli snapshot non hanno la IV per strike, e sommarla a
 *       un'unita' diversa non aveva significato.
 * Accanto, il delta aggressivo ES di Bookmap (buy - sell) minuto per minuto,
 * per vedere se il ribilanciamento previsto compare davvero nel flusso.
 * Solo file locali (nessuna lettura da Supabase), quindi solo in locale.
 */

const ES_PER_INDICE = 50; // un ES = 50 x indice; un'opzione SPX = 100 x indice
const NUM_STRIKE = 20;

interface Riga {
    strike: number; gamma?: number | null;
    cb?: number; cs?: number; pb?: number; ps?: number;
}
interface Snapshot { time: string; spxPrice?: number | null; undPrice?: number | null; volumes?: Riga[] }

const DIR = path.join(process.cwd(), 'data');

function percorso(sotto: string, nome: string): string | null {
    for (const base of [DIR, path.join(process.cwd(), 'frontend', 'data')]) {
        const p = path.join(base, sotto, nome);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/* ---- Bookmap: delta per minuto, letto a pezzi (il file arriva a ~40 MB). ---- */
const cacheBookmap = new Map<string, { offset: number; resto: string; perMinuto: Map<string, number>; esPx: Map<string, number> }>();

function deltaBookmap(giorno: string) {
    const p = percorso('bookmap', `${giorno}.ndjson`);
    if (!p) return null;
    let c = cacheBookmap.get(giorno);
    const size = fs.statSync(p).size;
    if (!c || size < c.offset) {
        c = { offset: 0, resto: '', perMinuto: new Map(), esPx: new Map() };
        cacheBookmap.set(giorno, c);
    }
    if (size > c.offset) {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(size - c.offset);
        fs.readSync(fd, buf, 0, buf.length, c.offset);
        fs.closeSync(fd);
        c.offset = size;
        const righe = (c.resto + buf.toString('utf-8')).split('\n');
        c.resto = righe.pop() ?? '';
        for (const r of righe) {
            if (!r) continue;
            try {
                const x = JSON.parse(r);
                const m = String(x.t ?? '').slice(0, 5);
                if (!m) continue;
                c.perMinuto.set(m, (c.perMinuto.get(m) ?? 0) + (Number(x.buy) || 0) - (Number(x.sell) || 0));
                if (Number.isFinite(x.price)) c.esPx.set(m, x.price);
            } catch { /* riga a meta' o rovinata */ }
        }
    }
    return c;
}

/* ---- Volumi: il file del poller, riletto solo quando cambia. ---- */
const cacheVolumi = new Map<string, { mtime: number; size: number; snaps: Snapshot[] }>();

function snapshots(giorno: string): Snapshot[] | null {
    const p = percorso('volumes', `${giorno}.json`);
    if (!p) return null;
    const st = fs.statSync(p);
    const c = cacheVolumi.get(giorno);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.snaps;
    try {
        const snaps = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(snaps)) return null;
        cacheVolumi.clear();
        cacheVolumi.set(giorno, { mtime: st.mtimeMs, size: st.size, snaps });
        return snaps;
    } catch {
        // Il poller lo sta riscrivendo: si tiene l'ultima lettura buona.
        return c?.snaps ?? null;
    }
}

function pearson(x: number[], y: number[]): { r: number; n: number } | null {
    const n = x.length;
    if (n < 10) return null;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (x[i] - mx) * (y[i] - my);
        sxx += (x[i] - mx) ** 2;
        syy += (y[i] - my) ** 2;
    }
    if (sxx === 0 || syy === 0) return null;
    return { r: Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000, n };
}

const arrot = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export async function GET(request: Request) {
    if (process.env.VERCEL) return NextResponse.json({ errore: 'Funziona solo in locale' }, { status: 400 });
    const { data: giorno } = giornoRichiesto(new URL(request.url).searchParams);

    const snaps = snapshots(giorno);
    if (!snaps || snaps.length === 0) {
        return NextResponse.json({ errore: `Nessun file dei volumi per ${giorno}` }, { status: 503 });
    }

    // G per strike: contratti ES che i dealer hanno in gamma per punto di SPX.
    const G = new Map<number, number>();
    const cumulato = new Map<number, number>();
    let prevS: number | null = null;

    interface Minuto { t: string; spx: number; gTot: number; flusso: number; cum: number; g: Map<number, number>; c: Map<number, number> }
    const minuti: Minuto[] = [];
    let cumTot = 0;
    let conLr = false;

    for (const snap of snaps) {
        // SPX vero prima: undPrice (il sottostante del modello IBKR) cambia circa una volta al
        // minuto, e con lui il flusso restava a 0 per minuti interi e poi saltava.
        const S = snap.spxPrice ?? snap.undPrice ?? null;
        if (!S || !Number.isFinite(S) || !Array.isArray(snap.volumes) || snap.volumes.length === 0) continue;

        // Ribilanciamento dell'intervallo con la posizione che c'era durante l'intervallo.
        let flusso = 0;
        if (prevS != null) {
            const dS = S - prevS;
            for (const [k, g] of G) {
                const f = -g * dS;
                flusso += f;
                cumulato.set(k, (cumulato.get(k) ?? 0) + f);
            }
        }
        cumTot += flusso;
        prevS = S;

        // Posizione aggiornata a questo snapshot. Gamma 0 = dopo la chiusura: si tiene l'ultima.
        for (const r of snap.volumes) {
            if (r.cb == null || r.cs == null || r.pb == null || r.ps == null) continue;
            if (r.gamma == null || !Number.isFinite(r.gamma) || r.gamma === 0) continue;
            conLr = true;
            const dealer = -((r.cb - r.cs) + (r.pb - r.ps));
            G.set(r.strike, (r.gamma * dealer * 100) / ES_PER_INDICE);
        }

        const t = snap.time.slice(0, 5);
        const ultimo = minuti[minuti.length - 1];
        const gTot = [...G.values()].reduce((a, b) => a + b, 0);
        if (ultimo && ultimo.t === t) {
            ultimo.spx = S; ultimo.gTot = gTot; ultimo.flusso += flusso; ultimo.cum = cumTot;
            ultimo.g = new Map(G); ultimo.c = new Map(cumulato);
        } else {
            minuti.push({ t, spx: S, gTot, flusso, cum: cumTot, g: new Map(G), c: new Map(cumulato) });
        }
    }

    if (!conLr || minuti.length === 0) {
        return NextResponse.json({ errore: `Nessun dato Lee-Ready con gamma per ${giorno}` }, { status: 503 });
    }

    // Le linee: gli strike con la gamma dei dealer piu' grande adesso.
    const strike = [...G.entries()]
        .filter(([, g]) => g !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, NUM_STRIKE)
        .map(([k]) => k)
        .sort((a, b) => a - b);

    const bm = deltaBookmap(giorno);
    const righe = minuti.map((m) => ({
        t: m.t,
        spx: arrot(m.spx, 2),
        gTot: arrot(m.gTot),
        flusso: arrot(m.flusso),
        cum: arrot(m.cum),
        delta: bm?.perMinuto.get(m.t) ?? null,
        es: bm?.esPx.get(m.t) ?? null,
    }));

    // Il ribilanciamento previsto contro il delta ES dello stesso minuto e del successivo.
    // L'ultimo minuto e' ancora a meta': fuori.
    const completi = righe.slice(0, -1);
    const stesso = completi.filter((r) => r.delta != null);
    const succ = completi.slice(0, -1).map((r, i) => ({ f: r.flusso, d: completi[i + 1].delta })).filter((x) => x.d != null);
    // Il prezzo spiega da solo il delta: lo stesso confronto con la variazione di SPX del minuto.
    const varSpx = completi.map((r, i) => (i > 0 ? r.spx - completi[i - 1].spx : 0));
    const conVar = completi.map((r, i) => ({ v: varSpx[i], d: r.delta })).filter((x, i) => i > 0 && x.d != null);

    // Il test vero: il flusso previsto aggiunge qualcosa al delta ES oltre alla variazione di SPX?
    // Correlazione parziale flusso-delta al netto della variazione di SPX, sugli stessi minuti.
    const tripla = completi.map((r, i) => ({ f: r.flusso, d: r.delta, v: varSpx[i] })).filter((x, i) => i > 0 && x.d != null);
    const rfd = pearson(tripla.map((x) => x.f), tripla.map((x) => x.d!));
    const rfv = pearson(tripla.map((x) => x.f), tripla.map((x) => x.v));
    const rdv = pearson(tripla.map((x) => x.d!), tripla.map((x) => x.v));
    const parziale = rfd && rfv && rdv && Math.abs(rfv.r) < 1 && Math.abs(rdv.r) < 1
        ? { r: Math.round(((rfd.r - rfv.r * rdv.r) / Math.sqrt((1 - rfv.r ** 2) * (1 - rdv.r ** 2))) * 1000) / 1000, n: rfd.n }
        : null;

    const ultimo = minuti[minuti.length - 1];
    return NextResponse.json({
        date: giorno,
        time: snaps[snaps.length - 1]?.time ?? null,
        spot: righe[righe.length - 1].spx,
        gTot: righe[righe.length - 1].gTot,
        cum: righe[righe.length - 1].cum,
        bookmap: bm != null,
        correlazioni: {
            stessoMinuto: pearson(stesso.map((r) => r.flusso), stesso.map((r) => r.delta!)),
            minutoDopo: pearson(succ.map((x) => x.f), succ.map((x) => x.d!)),
            spxStessoMinuto: pearson(conVar.map((x) => x.v), conVar.map((x) => x.d!)),
            alNettoDelPrezzo: parziale,
            // Ampiezze: quanto prevede il modello e quanto si vede, in media assoluta per minuto.
            mediaFlusso: stesso.length ? arrot(stesso.reduce((a, r) => a + Math.abs(r.flusso), 0) / stesso.length) : null,
            mediaDelta: stesso.length ? arrot(stesso.reduce((a, r) => a + Math.abs(r.delta!), 0) / stesso.length) : null,
        },
        minuti: righe,
        strike,
        linee: strike.map((k) => ({
            strike: k,
            gAdesso: arrot(ultimo.g.get(k) ?? 0),
            cum: minuti.map((m) => arrot(m.c.get(k) ?? 0)),
            g: minuti.map((m) => arrot(m.g.get(k) ?? 0)),
        })),
    });
}
