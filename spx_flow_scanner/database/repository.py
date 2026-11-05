"""
Archivio SQLite dello scanner (`frontend/data/spx-scanner/scanner.db`).

  - WAL: lo scanner scrive mentre la pagina (Node, `node:sqlite`) legge.
  - Migrazioni in `migrations/NNN_*.sql`, applicate in ordine e tracciate con
    `PRAGMA user_version`.
  - Le letture si accumulano in memoria e si scrivono a blocchi (ogni
    `blocco` righe o `ogni_s` secondi): una transazione per lettura
    rallenterebbe tutto per niente.
  - Deduplica: UNIQUE(con_id, ts) su letture e quotazioni, INSERT OR IGNORE.
"""

import json
import sqlite3
import time
from pathlib import Path

from spx_flow_scanner.config.settings import RADICE_PROGETTO
from spx_flow_scanner.utils.logger import prendi_logger

log = prendi_logger('db')
PERCORSO_DB = RADICE_PROGETTO / 'frontend' / 'data' / 'spx-scanner' / 'scanner.db'
CARTELLA_MIGRAZIONI = Path(__file__).resolve().parent / 'migrations'


class Archivio:
    def __init__(self, percorso: Path = PERCORSO_DB, blocco: int = 200, ogni_s: float = 5):
        percorso = Path(percorso)
        percorso.parent.mkdir(parents=True, exist_ok=True)
        self.percorso = percorso
        self.db = sqlite3.connect(percorso, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self._migra()
        self.blocco, self.ogni_s = blocco, ogni_s
        self._letture: list[tuple] = []
        self._quote: list[tuple] = []
        self._scritto = time.monotonic()

    def _migra(self) -> None:
        """
        Applica le migrazioni non ancora fatte: per ogni numero prima
        `NNN_*.sql` (schema), poi `NNN_*.py` se c'e' (dati: funzione migra(db)).
        """
        import importlib.util

        versione = self.db.execute('PRAGMA user_version').fetchone()[0]
        numeri = sorted({int(f.name[:3]) for f in CARTELLA_MIGRAZIONI.glob('[0-9][0-9][0-9]_*.*')
                         if f.suffix in ('.sql', '.py')})
        for numero in numeri:
            if numero <= versione:
                continue
            for file in sorted(CARTELLA_MIGRAZIONI.glob(f'{numero:03d}_*.sql')):
                log.info('migrazione %s', file.name)
                self.db.executescript(file.read_text(encoding='utf-8'))
            for file in sorted(CARTELLA_MIGRAZIONI.glob(f'{numero:03d}_*.py')):
                log.info('migrazione %s', file.name)
                spec = importlib.util.spec_from_file_location(f'_migrazione_{numero}', file)
                modulo = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(modulo)
                modulo.migra(self.db)
            self.db.execute(f'PRAGMA user_version = {numero}')
            self.db.commit()

    def chiudi(self) -> None:
        self.scarica()
        self.db.close()

    # -- contratti -----------------------------------------------------------

    def registra_contratti(self, contratti, giorno: str) -> None:
        self.db.executemany(
            '''INSERT INTO options_contracts
                   (con_id, trading_class, expiry, real_expiry, strike, opt_right, local_symbol, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (con_id) DO UPDATE SET last_seen = excluded.last_seen''',
            [(c.conId, c.classe, c.scadenza, c.scadenza_reale, c.strike, c.right, c.local_symbol, giorno, giorno)
             for c in contratti])
        self.db.commit()

    # -- cicli ---------------------------------------------------------------

    def inizia_ciclo(self, giorno: str, numero: int, meta: dict, sessione: str | None = None) -> int:
        cur = self.db.execute(
            '''INSERT INTO scan_history (giorno, sessione, numero, started_at, spx, spx_source, atm, universe,
                                         priority, lines, params)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (giorno, sessione, numero, int(time.time()), meta.get('spx'), meta.get('fonte_spx'), meta.get('atm'),
             meta.get('universo'), meta.get('priorita'), meta.get('parametri', {}).get('linee'),
             json.dumps(meta.get('parametri', {}))))
        self.db.commit()
        return cur.lastrowid

    def chiudi_ciclo(self, scan_id: int, r: dict) -> None:
        self.scarica()
        p, q = r['priorita_letti'], r['rotazione_letti']
        self.db.execute(
            '''UPDATE scan_history SET finished_at = ?, read_ok = ?, unavailable = ?, errors = ?, not_read = ?,
                   priority_not_read = ?, rate = ?, fresh_60min = ?, never_read = ?, lines = ?
               WHERE scan_id = ?''',
            (int(time.time()), p['ok'] + q['ok'], p['non_disponibili'] + q['non_disponibili'],
             p['errori'] + q['errori'], p['non_letti'] + q['non_letti'], p['non_letti'],
             r.get('contratti_al_secondo'), r.get('copertura_60min'), r.get('mai_letti'), r.get('linee'), scan_id))
        self.db.commit()

    # -- letture -------------------------------------------------------------

    def aggiungi_lettura(self, r: dict) -> None:
        self._letture.append((
            r['ts_epoch'], r['giorno'], r.get('sessione'), r['conId'], r.get('scan_id'), r['dte'], r['volume'], r.get('prev_volume'),
            r.get('prev_ts'), r.get('volume_delta'), r['tipo_dati'], r['stato'], r.get('errore'), r.get('gruppo'),
            r.get('anomalia')))
        self._quote.append((r['conId'], r['ts_epoch'], r['bid'], r['ask'], r['last'], r['tipo_dati']))
        if len(self._letture) >= self.blocco or time.monotonic() - self._scritto >= self.ogni_s:
            self.scarica()

    def scarica(self) -> None:
        if self._letture:
            with self.db:
                self.db.executemany(
                    '''INSERT OR IGNORE INTO volume_snapshots
                           (ts, giorno, sessione, con_id, scan_id, dte, volume, prev_volume, prev_ts,
                            volume_delta, data_type, status, error_code, scan_group, anomaly)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', self._letture)
                self.db.executemany(
                    'INSERT OR IGNORE INTO market_quotes (con_id, ts, bid, ask, last_price, data_type) VALUES (?, ?, ?, ?, ?, ?)',
                    self._quote)
            self._letture, self._quote = [], []
        self._scritto = time.monotonic()

    def ultime_letture(self, giorno: str, sessione: str) -> dict:
        """
        Per ogni contratto letto nella sessione: l'ultimo tentativo (per la
        rotazione) e l'ultima lettura OK (base dell'incremento).
        """
        self.scarica()
        ultimo = {}
        for riga in self.db.execute(
                '''SELECT con_id, MAX(ts) AS ts FROM volume_snapshots WHERE giorno = ? AND sessione = ?
                   GROUP BY con_id''', (giorno, sessione)):
            ultimo[riga['con_id']] = {'ts_epoch': riga['ts']}
        for riga in self.db.execute(
                '''SELECT v.con_id, v.ts, v.volume FROM volume_snapshots v
                   JOIN (SELECT con_id, MAX(ts) AS ts FROM volume_snapshots
                         WHERE giorno = ? AND sessione = ? AND status = 'OK' GROUP BY con_id) u
                     ON u.con_id = v.con_id AND u.ts = v.ts''', (giorno, sessione)):
            u = ultimo.setdefault(riga['con_id'], {'ts_epoch': riga['ts']})
            u.update({'ok_ts': riga['ts'], 'ok_volume': riga['volume']})
        return ultimo

    # -- stato ---------------------------------------------------------------

    def imposta_stato(self, chiave: str, valore: dict) -> None:
        self.scarica()
        self.db.execute(
            '''INSERT INTO system_status (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at''',
            (chiave, json.dumps(valore, separators=(',', ':')), int(time.time())))
        self.db.commit()
