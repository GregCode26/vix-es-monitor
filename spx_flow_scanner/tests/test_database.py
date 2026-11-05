import sqlite3
import tempfile
import unittest
from pathlib import Path

from spx_flow_scanner.database.repository import Archivio
from spx_flow_scanner.scanner.volume_scanner import incremento
from spx_flow_scanner.tests.test_contracts import _catena


def _lettura(con_id, ts, volume, stato='OK', **altro):
    return {'ts_epoch': ts, 'giorno': '2026-11-05', 'sessione': 'cash', 'conId': con_id, 'dte': 0, 'volume': volume,
            'bid': 1.0, 'ask': 1.1, 'last': None, 'tipo_dati': 'LIVE', 'stato': stato, **altro}


class TestIncremento(unittest.TestCase):
    def test_casi(self):
        self.assertEqual(incremento(100, None)['volume_delta'], None)
        self.assertEqual(incremento(150, {'ok_volume': 100, 'ok_ts': 1})['volume_delta'], 50)
        self.assertEqual(incremento(100, {'ok_volume': 100, 'ok_ts': 1})['volume_delta'], 0)
        sceso = incremento(80, {'ok_volume': 100, 'ok_ts': 1})
        self.assertIsNone(sceso['volume_delta'])
        self.assertIn('sceso', sceso['anomalia'])
        mancante = incremento(None, {'ok_volume': 100, 'ok_ts': 1})
        self.assertIsNone(mancante['volume_delta'])
        self.assertEqual(mancante['prev_volume'], 100)


class TestArchivio(unittest.TestCase):
    def setUp(self):
        self.cartella = tempfile.TemporaryDirectory()
        self.percorso = Path(self.cartella.name) / 't.db'
        self.a = Archivio(self.percorso, blocco=1000, ogni_s=999)
        self.contratti = _catena().contratti(dte_max=10_000)
        self.a.registra_contratti(self.contratti, '2026-11-05')

    def tearDown(self):
        self.a.db.close()
        self.cartella.cleanup()

    def test_schema_e_versione(self):
        tabelle = {r[0] for r in self.a.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for t in ('options_contracts', 'volume_snapshots', 'market_quotes', 'scanner_alerts',
                  'scan_history', 'system_status', 'volume_latest'):
            self.assertIn(t, tabelle)
        self.assertEqual(self.a.db.execute('PRAGMA user_version').fetchone()[0], 4)
        # Riaprire non riapplica le migrazioni.
        Archivio(self.percorso).db.close()

    def test_spx_e_spxw_due_righe(self):
        n = self.a.db.execute("SELECT COUNT(*) FROM options_contracts WHERE real_expiry='20261120' "
                              "AND strike=7700 AND opt_right='C'").fetchone()[0]
        self.assertEqual(n, 2)

    def test_deduplica_e_ultime_letture(self):
        c = self.contratti[0].conId
        self.a.aggiungi_lettura(_lettura(c, 100, 10))
        self.a.aggiungi_lettura(_lettura(c, 100, 10))           # doppione: ignorato
        self.a.aggiungi_lettura(_lettura(c, 200, 25, volume_delta=15))
        self.a.aggiungi_lettura(_lettura(c, 300, None, stato='NON_DISPONIBILE'))
        u = self.a.ultime_letture('2026-11-05', 'cash')[c]
        self.assertEqual((u['ts_epoch'], u['ok_ts'], u['ok_volume']), (300, 200, 25))
        righe = self.a.db.execute('SELECT ts, volume FROM volume_snapshots ORDER BY ts').fetchall()
        self.assertEqual([tuple(r) for r in righe], [(100, 10), (200, 25), (300, None)])  # NULL, non 0
        self.assertEqual(self.a.db.execute('SELECT COUNT(*) FROM market_quotes').fetchone()[0], 3)

    def test_sessioni_separate_e_ricalcolo(self):
        from spx_flow_scanner.scanner.volume_analyzer import aggiorna_ultimi, ricalcola_incrementi
        c = self.contratti[0].conId
        for ts, vol, sess in ((100, 5000, 'notturna'), (200, 5400, 'notturna'), (300, 2000, 'cash'), (400, 2600, 'cash')):
            self.a.aggiungi_lettura({**_lettura(c, ts, vol), 'sessione': sess})
        self.a.scarica()
        ricalcola_incrementi(self.a.db, '2026-11-05', 'cash')
        ricalcola_incrementi(self.a.db, '2026-11-05', 'notturna')
        righe = self.a.db.execute('SELECT sessione, prev_volume, volume_delta, anomaly FROM volume_snapshots '
                                  'ORDER BY ts').fetchall()
        # La prima del cash non ha base: la notturna non conta, e non e' un'anomalia.
        self.assertEqual([tuple(r) for r in righe], [('notturna', None, None, None), ('notturna', 5000, 400, None),
                                                     ('cash', None, None, None), ('cash', 2000, 600, None)])
        aggiorna_ultimi(self.a.db, '2026-11-05', 'cash')
        aggiorna_ultimi(self.a.db, '2026-11-05', 'notturna')
        vol = dict(self.a.db.execute('SELECT sessione, volume FROM volume_latest').fetchall())
        self.assertEqual(vol, {'notturna': 5400, 'cash': 2600})
        self.assertEqual(self.a.ultime_letture('2026-11-05', 'cash')[c]['ok_volume'], 2600)

    def test_ciclo_e_stato(self):
        sid = self.a.inizia_ciclo('2026-11-05', 1, {'spx': 7688.6, 'atm': 7690, 'parametri': {'linee': 4}})
        vuoto = {'ok': 0, 'non_disponibili': 0, 'errori': 0, 'non_letti': 0}
        self.a.chiudi_ciclo(sid, {'priorita_letti': {**vuoto, 'ok': 5}, 'rotazione_letti': {**vuoto, 'non_letti': 7},
                                  'contratti_al_secondo': 5.0})
        r = self.a.db.execute('SELECT read_ok, not_read, priority_not_read FROM scan_history').fetchone()
        self.assertEqual(tuple(r), (5, 7, 0))
        self.a.imposta_stato('scanner', {'stato': 'x'})
        self.a.imposta_stato('scanner', {'stato': 'y'})
        self.assertEqual(self.a.db.execute('SELECT value FROM system_status').fetchall()[0][0], '{"stato":"y"}')

    def test_lettore_concorrente_in_wal(self):
        self.assertEqual(self.a.db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        altro = sqlite3.connect(self.percorso)
        self.assertEqual(altro.execute('SELECT COUNT(*) FROM options_contracts').fetchone()[0], len(self.contratti))
        altro.close()


if __name__ == '__main__':
    unittest.main()
