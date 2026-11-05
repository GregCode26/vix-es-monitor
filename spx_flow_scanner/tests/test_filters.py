import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from spx_flow_scanner.database.repository import Archivio
from spx_flow_scanner.scanner.atm_calculator import riferimento_atm
from spx_flow_scanner.scanner.filters import Filtro, contratti_filtrati, copertura
from spx_flow_scanner.scanner.volume_analyzer import aggiorna_ultimi, metriche
from spx_flow_scanner.tests.test_contracts import _catena

NY = ZoneInfo('America/New_York')
M = 60


class TestMetriche(unittest.TestCase):
    def test_finestre_esatte_a_10_minuti(self):
        letture = [(i * 10 * M, 100 * i) for i in range(8)]  # una ogni 10 minuti, +100 ciascuna
        m = metriche(letture)
        self.assertEqual((m['volume'], m['delta_last'], m['delta_last_window_s']), (700, 100, 600))
        self.assertEqual((m['inc_30m'], m['inc_30m_window_s']), (300, 1800))
        self.assertEqual((m['inc_60m'], m['inc_60m_window_s']), (600, 3600))

    def test_lettura_troppo_lontana_non_inventa_la_finestra(self):
        # Contratto in rotazione: letto alle 0 e dopo 90 minuti.
        m = metriche([(0, 100), (90 * M, 400)])
        self.assertEqual(m['delta_last'], 300)
        self.assertIsNone(m['inc_30m'])          # nessuna lettura fra 30 e 42 minuti prima
        self.assertIsNone(m['inc_60m'])          # 90 > 60 + 12
        m = metriche([(0, 100), (70 * M, 400)])
        self.assertEqual((m['inc_60m'], m['inc_60m_window_s']), (300, 70 * M))

    def test_volume_che_scende_annulla_la_finestra(self):
        m = metriche([(0, 100), (10 * M, 150), (20 * M, 50), (30 * M, 80)])
        self.assertIsNone(m['inc_30m'])
        self.assertEqual(m['delta_last'], 30)    # fra le ultime due, che salgono
        self.assertIsNone(metriche([(0, 100), (10 * M, 90)])['delta_last'])

    def test_nessuna_lettura(self):
        self.assertIsNone(metriche([])['volume'])


class TestFiltriSuDb(unittest.TestCase):
    def setUp(self):
        self.cartella = tempfile.TemporaryDirectory()
        self.a = Archivio(Path(self.cartella.name) / 't.db', blocco=10_000, ogni_s=999)
        self.contratti = _catena().contratti(dte_max=10_000)
        self.a.registra_contratti(self.contratti, '2026-11-05')
        self.inizio = int(datetime(2026, 11, 5, 9, 0, tzinfo=NY).timestamp())
        # Due letture a 10 minuti: volume = strike - 7000 (C) o metà (P).
        for i in range(2):
            ts = self.inizio + i * 600
            for c in self.contratti:
                v = int(c.strike - 7000) if c.right == 'C' else int((c.strike - 7000) / 2)
                self.a.aggiungi_lettura({'ts_epoch': ts, 'giorno': '2026-11-05', 'sessione': 'cash', 'conId': c.conId,
                                         'dte': c.dte(datetime(2026, 11, 5).date()), 'volume': v + i * 10,
                                         'bid': 1, 'ask': 2, 'last': None, 'tipo_dati': 'LIVE', 'stato': 'OK'})
        self.a.scarica()
        aggiorna_ultimi(self.a.db, '2026-11-05', 'cash')

    def tearDown(self):
        self.a.db.close()
        self.cartella.cleanup()

    def test_soglia_per_singolo_contratto_e_lato(self):
        righe = contratti_filtrati(self.a.db, '2026-11-05', 'cash', Filtro(volume_minimo=700, atm=7690, range_strike=2000))
        # 7700 C = 710 passa; 7700 P = 360 no: call e put non si sommano.
        chiavi = {(r['trading_class'], r['real_expiry'], r['strike'], r['opt_right']) for r in righe}
        self.assertIn(('SPXW', '20261105', 7700.0, 'C'), chiavi)
        self.assertNotIn(('SPXW', '20261105', 7700.0, 'P'), chiavi)
        # SPX AM e SPXW del 20/11 restano due righe.
        self.assertEqual(sum(1 for k in chiavi if k[1] == '20261120' and k[2] == 7700 and k[3] == 'C'), 2)
        self.assertTrue(all(r['volume'] >= 700 for r in righe))

    def test_tipo_dte_range(self):
        db, g = self.a.db, '2026-11-05'
        self.assertEqual({r['opt_right'] for r in contratti_filtrati(db, g, 'cash', Filtro(0, 'P', atm=7690))}, {'P'})
        self.assertTrue(all(r['dte'] <= 30 for r in contratti_filtrati(db, g, 'cash', Filtro(0, dte_max=30, atm=7690))))
        vicini = contratti_filtrati(db, g, 'cash', Filtro(0, atm=7690, range_strike=10))
        self.assertTrue(all(abs(r['strike'] - 7690) <= 10 for r in vicini))
        ordinati = [r['volume'] for r in contratti_filtrati(db, g, 'cash', Filtro(0, atm=7690))]
        self.assertEqual(ordinati, sorted(ordinati, reverse=True))

    def test_delta_e_copertura(self):
        r = contratti_filtrati(self.a.db, '2026-11-05', 'cash', Filtro(0, 'C', atm=7690, range_strike=0))[0]
        self.assertEqual((r['delta_last'], r['delta_last_window_s'], r['inc_30m']), (10, 600, None))
        cop = copertura(self.a.db, '2026-11-05', 'cash', Filtro(10_000, atm=7690), self.inizio + 700)
        self.assertEqual(cop['contratti_tentati'], len(self.contratti))  # la soglia non conta qui
        self.assertEqual(cop['letti_30min'], len(self.contratti))

    def test_riferimenti_atm(self):
        db = self.a.db
        for ora, atm, fonte in (((5, 0), 7690, 'close'), ((9, 31), 7700, 'last'), ((10, 30), 7720, 'last')):
            ts = int(datetime(2026, 11, 5, *ora, tzinfo=NY).timestamp())
            db.execute("INSERT INTO scan_history (giorno, numero, started_at, spx, spx_source, atm) "
                       "VALUES ('2026-11-05', 1, ?, ?, ?, ?)", (ts, atm, fonte, atm))
        db.execute("INSERT INTO scan_history (giorno, numero, started_at, spx, spx_source, atm) "
                   "VALUES ('2026-11-05', 1, ?, 7600, 'close', 7600)",
                   (int(datetime(2026, 11, 4, 21, 0, tzinfo=NY).timestamp()),))  # notturna del giorno prima
        self.assertEqual(riferimento_atm(db, '2026-11-05', 'corrente')['atm'], 7720)
        self.assertEqual(riferimento_atm(db, '2026-11-05', 'apertura')['atm'], 7700)
        self.assertEqual(riferimento_atm(db, '2026-11-05', 'storico', '10:00')['atm'], 7700)
        self.assertEqual(riferimento_atm(db, '2026-11-05', 'storico', '21:30')['atm'], 7600)
        self.assertIsNone(riferimento_atm(db, '2026-11-06', 'apertura'))
        with self.assertRaises(ValueError):
            riferimento_atm(db, '2026-11-05', 'storico')


if __name__ == '__main__':
    unittest.main()
