import unittest
from datetime import date

from spx_flow_scanner.config.settings import Impostazioni
from spx_flow_scanner.scanner.volume_scanner import priorita, rotazione
from spx_flow_scanner.tests.test_contracts import OGGI, _catena
from spx_flow_scanner.utils.market_calendar import giorno_di_borsa, sessione_di_borsa
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo('America/New_York')


class TestPriorita(unittest.TestCase):
    def setUp(self):
        self.cfg = Impostazioni(prio_scadenze=2, prio_range=2000, range_strike=2000, dte_max=90)
        self.catena = _catena()

    def test_priorita_prime_due_scadenze_reali(self):
        p = priorita(self.catena, 7690, self.cfg, oggi=OGGI)
        # 05/11 e 20/11 (la 20/11 ha sia SPX AM che SPXW: entrambe dentro)
        self.assertEqual({c.scadenza_reale for c in p}, {'20261105', '20261120'})
        self.assertEqual({c.classe for c in p if c.scadenza_reale == '20261120'}, {'SPX', 'SPXW'})

    def test_rotazione_esclude_priorita_e_parte_dai_mai_letti(self):
        p = priorita(self.catena, 7690, self.cfg, oggi=OGGI)
        resto = rotazione(self.catena, 7690, self.cfg, {c.conId for c in p}, {}, oggi=OGGI)
        self.assertFalse({c.conId for c in p} & {c.conId for c in resto})
        self.assertEqual({c.scadenza_reale for c in resto}, {'20270129'})
        letto = resto[0]
        ultimo = {letto.conId: {'ts_epoch': 1_000}}
        di_nuovo = rotazione(self.catena, 7690, self.cfg, {c.conId for c in p}, ultimo, oggi=OGGI)
        self.assertEqual(di_nuovo[-1].conId, letto.conId)  # il gia' letto va in fondo


class TestGiornoDiBorsa(unittest.TestCase):
    def test_notturna_e_weekend(self):
        f = lambda *a: giorno_di_borsa(datetime(*a, tzinfo=NY))
        self.assertEqual(f(2026, 11, 5, 5, 44), date(2026, 11, 5))
        self.assertEqual(f(2026, 11, 5, 17, 0), date(2026, 11, 5))   # dopo il cash, prima della notturna
        self.assertEqual(f(2026, 11, 5, 20, 15), date(2026, 11, 6))  # notturna = giorno dopo
        self.assertEqual(f(2026, 11, 6, 21, 0), date(2026, 11, 9))   # venerdi' sera -> lunedi'
        self.assertEqual(f(2026, 11, 8, 20, 30), date(2026, 11, 9))  # domenica sera -> lunedi'


class TestSessione(unittest.TestCase):
    def test_confini(self):
        f = lambda *a: sessione_di_borsa(datetime(*a, tzinfo=NY))
        self.assertEqual(f(2026, 11, 5, 5, 44), (date(2026, 11, 5), 'notturna'))
        self.assertEqual(f(2026, 11, 5, 9, 29), (date(2026, 11, 5), 'notturna'))
        self.assertEqual(f(2026, 11, 5, 9, 30), (date(2026, 11, 5), 'cash'))
        self.assertEqual(f(2026, 11, 5, 17, 0), (date(2026, 11, 5), 'cash'))      # volume finale del cash
        self.assertEqual(f(2026, 11, 5, 20, 15), (date(2026, 11, 6), 'notturna'))
        self.assertEqual(f(2026, 11, 8, 21, 0), (date(2026, 11, 9), 'notturna'))  # domenica sera
        self.assertEqual(f(2026, 11, 7, 12, 0), (date(2026, 11, 9), 'notturna'))  # sabato: niente cash


if __name__ == '__main__':
    unittest.main()
