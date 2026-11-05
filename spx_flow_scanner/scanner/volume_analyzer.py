"""
Fase 6 - incrementi per contratto, scritti in `volume_latest`.

Per ogni contratto, dalle sue letture OK della sessione (notturna o cash:
IBKR azzera il volume all'apertura di ciascuna):
  - volume: l'ultimo letto (cumulativo giornaliero di IBKR);
  - delta_last: rispetto alla lettura OK precedente;
  - inc_30m / inc_60m: rispetto alla lettura OK piu' recente che sia almeno
    30 (60) minuti prima dell'ultima, purche' non oltre 30 (60) + TOLLERANZA
    minuti. Altrimenti NULL: per un contratto letto ogni 90 minuti un
    "incremento a 30 minuti" non esiste, e scriverci 0 sarebbe inventarlo.

Se il volume scende dentro una finestra (azzeramento o dato sbagliato)
l'incremento di quella finestra e' NULL.

Nessun incremento e' una singola esecuzione: e' la somma di tutto il volume
passato fra due letture.
"""

import time
from collections import defaultdict

TOLLERANZA_S = 12 * 60  # un ciclo da 10 minuti piu' margine
FINESTRE = {'inc_30m': 30 * 60, 'inc_60m': 60 * 60}


def _differenza(letture: list, finestra_s: int) -> tuple:
    """(incremento, finestra vera in s) fra l'ultima lettura e una ~finestra_s prima."""
    ts_ult, vol_ult = letture[-1]
    base = None
    for ts, vol in reversed(letture[:-1]):
        if ts <= ts_ult - finestra_s:
            base = (ts, vol)
            break
    if base is None or ts_ult - base[0] > finestra_s + TOLLERANZA_S:
        return None, None
    # Volume che scende dentro la finestra: nessun incremento affidabile.
    dentro = [v for t, v in letture if t >= base[0]]
    if any(b < a for a, b in zip(dentro, dentro[1:])):
        return None, ts_ult - base[0]
    return vol_ult - base[1], ts_ult - base[0]


def metriche(letture_ok: list) -> dict:
    """`letture_ok` = [(ts, volume)] in ordine di tempo, solo letture OK."""
    if not letture_ok:
        return {'volume': None, 'ts': None, 'delta_last': None, 'delta_last_window_s': None,
                **{k: None for k in FINESTRE}, **{f'{k}_window_s': None for k in FINESTRE}}
    ts, vol = letture_ok[-1]
    fuori = {'volume': vol, 'ts': ts, 'delta_last': None, 'delta_last_window_s': None}
    if len(letture_ok) > 1:
        ts0, vol0 = letture_ok[-2]
        fuori['delta_last'] = vol - vol0 if vol >= vol0 else None
        fuori['delta_last_window_s'] = ts - ts0
    for nome, finestra in FINESTRE.items():
        fuori[nome], fuori[f'{nome}_window_s'] = _differenza(letture_ok, finestra)
    return fuori


def aggiorna_ultimi(db, giorno: str, sessione: str, con_ids=None) -> int:
    """
    Ricalcola `volume_latest` per `con_ids` (tutti i contratti letti nel
    giorno se None). Si leggono tutte le letture del giorno dei contratti
    toccati, non solo l'ultima ora: l'ultima lettura OK di un contratto in
    rotazione puo' essere di ore prima.
    """
    filtro, parametri = '', [giorno, sessione]
    if con_ids is not None:
        con_ids = list(con_ids)
        if not con_ids:
            return 0
        db.execute('CREATE TEMP TABLE IF NOT EXISTS _toccati (con_id INTEGER PRIMARY KEY)')
        db.execute('DELETE FROM _toccati')
        db.executemany('INSERT OR IGNORE INTO _toccati VALUES (?)', [(c,) for c in con_ids])
        filtro = 'AND v.con_id IN (SELECT con_id FROM _toccati)'

    ok = defaultdict(list)
    tentativo = {}
    contati = defaultdict(int)
    anomalie = {}
    for con_id, ts, volume, stato, anomalia in db.execute(
            f'''SELECT v.con_id, v.ts, v.volume, v.status, v.anomaly FROM volume_snapshots v
                WHERE v.giorno = ? AND v.sessione = ? {filtro} ORDER BY v.con_id, v.ts''', parametri):
        tentativo[con_id] = (ts, stato)
        if stato == 'OK' and volume is not None:
            ok[con_id].append((ts, volume))
            contati[con_id] += 1
        if anomalia:
            anomalie[con_id] = anomalia

    quote = {}
    for con_id, ts, bid, ask, last, tipo in db.execute(
            f'''SELECT q.con_id, q.ts, q.bid, q.ask, q.last_price, q.data_type FROM market_quotes q
                JOIN (SELECT v.con_id, MAX(v.ts) AS ts FROM volume_snapshots v
                      WHERE v.giorno = ? AND v.sessione = ? AND v.status = 'OK' {filtro} GROUP BY v.con_id) u
                  ON u.con_id = q.con_id AND u.ts = q.ts''', parametri):
        quote[con_id] = (bid, ask, last, tipo)

    contratti = {r[0]: r[1:] for r in db.execute(
        'SELECT con_id, trading_class, real_expiry, strike, opt_right FROM options_contracts')}
    dte = {}
    for con_id, valore in db.execute(
            f'''SELECT v.con_id, v.dte FROM volume_snapshots v
                JOIN (SELECT v.con_id, MAX(v.ts) AS ts FROM volume_snapshots v WHERE v.giorno = ? AND v.sessione = ? {filtro}
                      GROUP BY v.con_id) u ON u.con_id = v.con_id AND u.ts = v.ts''', parametri):
        dte[con_id] = valore

    adesso = int(time.time())
    righe = []
    for con_id, (ts_t, stato_t) in tentativo.items():
        if con_id not in contratti:
            continue
        classe, reale, strike, right = contratti[con_id]
        m = metriche(ok.get(con_id, []))
        bid, ask, last, tipo = quote.get(con_id, (None, None, None, None))
        righe.append((giorno, sessione, con_id, classe, reale, dte.get(con_id, 0), strike, right, m['volume'], m['ts'],
                      m['delta_last'], m['delta_last_window_s'], m['inc_30m'], m['inc_30m_window_s'],
                      m['inc_60m'], m['inc_60m_window_s'], bid, ask, last, tipo, contati[con_id], ts_t, stato_t,
                      anomalie.get(con_id), adesso))
    with db:
        db.executemany(
            '''INSERT OR REPLACE INTO volume_latest
                   (giorno, sessione, con_id, trading_class, real_expiry, dte, strike, opt_right, volume, ts, delta_last,
                    delta_last_window_s, inc_30m, inc_30m_window_s, inc_60m, inc_60m_window_s, bid, ask,
                    last_price, data_type, readings_ok, last_attempt_ts, last_attempt_status, anomaly, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', righe)
    return len(righe)


def ricalcola_incrementi(db, giorno: str, sessione: str) -> int:
    """
    Riscrive prev_volume/prev_ts/volume_delta/anomaly delle letture di una
    sessione, in ordine di tempo per contratto. Serve dopo una correzione
    (es. le letture del cash del 05/11/2026 avevano come base la notturna).
    """
    from spx_flow_scanner.scanner.volume_scanner import incremento

    aggiornamenti = []
    precedente: dict[int, dict] = {}
    for rid, con_id, ts, volume, stato in db.execute(
            '''SELECT id, con_id, ts, volume, status FROM volume_snapshots
               WHERE giorno = ? AND sessione = ? ORDER BY con_id, ts''', (giorno, sessione)):
        inc = incremento(volume, precedente.get(con_id))
        aggiornamenti.append((inc['prev_volume'], inc['prev_ts'], inc['volume_delta'], inc['anomalia'], rid))
        if stato == 'OK' and volume is not None:
            precedente[con_id] = {'ok_volume': volume, 'ok_ts': ts}
    with db:
        db.executemany('''UPDATE volume_snapshots SET prev_volume = ?, prev_ts = ?, volume_delta = ?, anomaly = ?
                          WHERE id = ?''', aggiornamenti)
    return len(aggiornamenti)
