import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from spx_flow_scanner.scanner.atm_calculator import passo_vicino, strike_atm
from spx_flow_scanner.utils import market_calendar

CT = ZoneInfo('America/Chicago')
# Orari veri di un'opzione SPX il 05/11/2026 (notturna + cash), piu' una festivita'.
ORARI = ('20261104:1915-20261105:0825;20261105:0830-20261105:1600;'
         '20261105:1915-20261106:0825;20261106:0830-20261106:1600;20261126:CLOSED')


class TestAtm(unittest.TestCase):
    def test_strike_reale_piu_vicino(self):
        strikes = [7600, 7650, 7680, 7685, 7690, 7695, 7700, 7750]
        self.assertEqual(strike_atm(7688.62, strikes), 7690)
        self.assertEqual(strike_atm(7687.5, strikes), 7685)  # pari distanza: il piu' basso
        self.assertEqual(strike_atm(7620, [7600, 7650]), 7600)  # mai uno strike inventato
        self.assertIsNone(strike_atm(None, strikes))
        self.assertIsNone(strike_atm(7688, []))

    def test_passo(self):
        strikes = list(range(7500, 7900, 5)) + [8000, 8100]
        self.assertEqual(passo_vicino(7688, strikes), 5)


class TestCalendario(unittest.TestCase):
    def test_sessioni(self):
        aperte, chiuse = market_calendar.sessioni(ORARI, 'US/Central')
        self.assertEqual(len(aperte), 4)
        self.assertEqual(chiuse, {'20261126'})

    def test_aperto_chiuso(self):
        f = lambda *a: market_calendar.mercato_aperto(ORARI, 'US/Central', datetime(*a, tzinfo=CT))
        self.assertTrue(f(2026, 11, 5, 4, 44))    # notturna
        self.assertFalse(f(2026, 11, 5, 8, 27))   # pausa 08:25-08:30
        self.assertTrue(f(2026, 11, 5, 10, 0))    # cash
        self.assertFalse(f(2026, 11, 5, 17, 0))   # dopo la chiusura

    def test_prossima_apertura(self):
        s = market_calendar.stato(ORARI, 'US/Central', datetime(2026, 11, 5, 8, 27, tzinfo=CT))
        self.assertEqual(s['prossima_apertura'], '2026-11-05T08:30:00-06:00')


if __name__ == '__main__':
    unittest.main()
