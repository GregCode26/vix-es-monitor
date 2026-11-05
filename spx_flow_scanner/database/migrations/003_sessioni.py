"""Riempie `sessione` sulle righe esistenti e ricalcola gli incrementi."""

from datetime import datetime
from zoneinfo import ZoneInfo

from spx_flow_scanner.utils.market_calendar import sessione_di_borsa

NY = ZoneInfo('America/New_York')


def migra(db) -> None:
    from spx_flow_scanner.scanner.volume_analyzer import aggiorna_ultimi, ricalcola_incrementi

    for tabella, colonna in (('volume_snapshots', 'ts'), ('scan_history', 'started_at')):
        chiave = 'id' if tabella == 'volume_snapshots' else 'scan_id'
        righe = db.execute(f'SELECT {chiave}, {colonna} FROM {tabella} WHERE sessione IS NULL').fetchall()
        db.executemany(f'UPDATE {tabella} SET sessione = ? WHERE {chiave} = ?',
                       [(sessione_di_borsa(datetime.fromtimestamp(ts, NY))[1], k) for k, ts in righe])
    db.commit()
    for giorno, sessione in db.execute('SELECT DISTINCT giorno, sessione FROM volume_snapshots').fetchall():
        ricalcola_incrementi(db, giorno, sessione)
        aggiorna_ultimi(db, giorno, sessione)
