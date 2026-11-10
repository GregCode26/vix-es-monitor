import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
// @ts-ignore -- node:sqlite c'e' in Node 24, ma i @types/node installati non lo dichiarano ancora
import { DatabaseSync } from 'node:sqlite';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SPX Options Volume Scanner: l'ultimo stato di ogni contratto letto dallo
 * scanner Python (`spx_flow_scanner/`), da `frontend/data/spx-scanner/scanner.db`.
 *
 * `?giorno=YYYY-MM-DD` (default: l'ultimo giorno nel DB), `?sessione=cash|notturna`
 * (default: la sessione dell'ultimo ciclo), `?min=N` (default 200): soglia del
 * singolo trade, `?leggero=1`: senza l'elenco dei contratti. Volume NULL = non disponibile: viene restituito come null,
 * mai come 0. Solo locale: niente Supabase.
 */

const PERCORSO = path.join(process.cwd(), 'data', 'spx-scanner', 'scanner.db');

export async function GET(req: NextRequest) {
    if (!fs.existsSync(PERCORSO)) {
        return NextResponse.json({ error: 'database dello scanner non trovato', percorso: PERCORSO }, { status: 503 });
    }
    const db = new DatabaseSync(PERCORSO, { readOnly: true });
    try {
        const q = req.nextUrl.searchParams;
        const ultimo = db.prepare('SELECT giorno, sessione FROM scan_history ORDER BY started_at DESC LIMIT 1').get() as
            { giorno: string; sessione: string } | undefined;
        const giorno = q.get('giorno') || ultimo?.giorno;
        if (!giorno) return NextResponse.json({ error: 'nessun ciclo nel database' }, { status: 503 });
        const sessioni = (db.prepare('SELECT DISTINCT sessione FROM volume_latest WHERE giorno = ?').all(giorno) as { sessione: string }[])
            .map(r => r.sessione);
        const sessione = q.get('sessione') || (ultimo?.giorno === giorno ? ultimo.sessione : sessioni[0]) || 'cash';

        const ciclo = db.prepare(
            `SELECT scan_id, numero, started_at, finished_at, spx, spx_source, atm, universe, priority, read_ok,
                    unavailable, fresh_60min, never_read, rate
             FROM scan_history WHERE giorno = ? AND sessione = ? ORDER BY started_at DESC LIMIT 1`).get(giorno, sessione);
        // `?leggero=1`: solo i trade (per i pentagoni su /hedging-pressure), senza i ~7.000 contratti.
        const leggero = q.get('leggero') === '1';
        const contratti = leggero ? [] : db.prepare(
            `SELECT con_id, trading_class, real_expiry, dte, strike, opt_right, volume, ts, delta_last,
                    inc_30m, inc_60m, bid, ask, last_price, data_type, last_attempt_status, anomaly
             FROM volume_latest WHERE giorno = ? AND sessione = ?`).all(giorno, sessione);
        const giorni = (db.prepare('SELECT DISTINCT giorno FROM volume_latest ORDER BY giorno DESC LIMIT 30').all() as { giorno: string }[])
            .map(r => r.giorno);

        // Singoli trade (python -m spx_flow_scanner.main trade): per contratto la somma dei soli trade
        // >= min, ogni stampa presa da sola. Il DB tiene solo le stampe >= la soglia di base.
        const haTrade = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trades'").get();
        let trade: unknown[] = [], perContratto: unknown[] = [], verifica = null, sogliaBase: number | null = null;
        let precedente: { giorno: string; perContratto: unknown[] } | null = null;
        const richiesto = Math.max(1, Number(q.get('min') ?? 200) || 200);
        if (haTrade) {
            sogliaBase = (db.prepare('SELECT MAX(soglia) s FROM trade_cursor WHERE giorno = ? AND sessione = ?')
                .get(giorno, sessione) as { s: number | null })?.s ?? null;
            const min = Math.max(richiesto, sogliaBase ?? 0);
            perContratto = db.prepare(
                `SELECT t.con_id, SUM(t.size) somma, COUNT(*) n, MAX(t.size) massimo, MAX(t.ts) ultimo
                 FROM trades t WHERE t.giorno = ? AND t.sessione = ? AND t.size >= ? GROUP BY t.con_id`).all(giorno, sessione, min);
            // verso/bid/ask dal 10/11/2026 (migrazione 005 dello scanner): finche' lo scanner
            // non l'ha applicata la colonna non c'e' e si manda null.
            const conVerso = (db.prepare("SELECT COUNT(*) n FROM pragma_table_info('trades') WHERE name = 'verso'")
                .get() as { n: number }).n > 0;
            trade = db.prepare(
                `SELECT t.con_id, t.ts, t.seq, t.size, t.price, t.exchange, t.conditions,
                        ${conVerso ? 't.verso, t.bid, t.ask' : 'NULL verso, NULL bid, NULL ask'},
                        o.trading_class, o.real_expiry, o.strike, o.opt_right
                 FROM trades t JOIN options_contracts o ON o.con_id = t.con_id
                 WHERE t.giorno = ? AND t.sessione = ? AND t.size >= ? ORDER BY t.size DESC, t.ts DESC LIMIT 400`)
                .all(giorno, sessione, min);
            // Contratti che potrebbero avere trade >= min non ancora letti: volume salito di >= min
            // rispetto a quanto gia' verificato.
            verifica = db.prepare(
                `SELECT COUNT(*) da_leggere,
                        (SELECT COUNT(*) FROM trade_cursor WHERE giorno = ? AND sessione = ?) letti,
                        (SELECT MAX(aggiornato) FROM trade_cursor WHERE giorno = ? AND sessione = ?) aggiornato
                 FROM volume_latest l LEFT JOIN trade_cursor c
                   ON c.giorno = l.giorno AND c.sessione = l.sessione AND c.con_id = l.con_id
                 WHERE l.giorno = ? AND l.sessione = ? AND l.volume IS NOT NULL
                   AND l.volume - COALESCE(c.vol_rif, 0) >= ?`)
                .get(giorno, sessione, giorno, sessione, giorno, sessione, min) ?? null;

            // `?precedente=1`: la stessa sessione del giorno prima, solo per i contratti che oggi
            // lo scanner non ha ancora letto (nessuna riga in volume_latest). Dopo l'apertura le
            // scadenze lontane arrivano solo dopo 1-1,5 ore: la pagina le mostra in grigio
            // intanto, e ognuna sparisce appena viene letta.
            if (q.get('precedente') === '1') {
                const prima = (db.prepare('SELECT MAX(giorno) g FROM trades WHERE giorno < ? AND sessione = ?')
                    .get(giorno, sessione) as { g: string | null })?.g;
                if (prima) {
                    precedente = {
                        giorno: prima,
                        perContratto: db.prepare(
                            `SELECT t.con_id, SUM(t.size) somma, COUNT(*) n, MAX(t.size) massimo, MAX(t.ts) ultimo,
                                    o.trading_class, o.real_expiry, o.strike, o.opt_right
                             FROM trades t JOIN options_contracts o ON o.con_id = t.con_id
                             WHERE t.giorno = ? AND t.sessione = ? AND t.size >= ? AND o.real_expiry >= ?
                               AND t.con_id NOT IN (SELECT con_id FROM volume_latest WHERE giorno = ? AND sessione = ?)
                             GROUP BY t.con_id`)
                            .all(prima, sessione, min, giorno.replaceAll('-', ''), giorno, sessione),
                    };
                }
            }
        }

        return NextResponse.json({ giorno, sessione, sessioni, giorni, ciclo: ciclo ?? null, contratti,
            min: Math.max(richiesto, sogliaBase ?? 0), sogliaBase, perContratto, trade, verifica, precedente });
    } finally {
        db.close();
    }
}
