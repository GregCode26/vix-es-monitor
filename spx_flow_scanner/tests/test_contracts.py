"""Catena e cache, senza IBKR. `python -m unittest discover spx_flow_scanner/tests`"""

import tempfile
import unittest
from datetime import date
from pathlib import Path

from spx_flow_scanner.scanner.chain_discovery import Catena, ContrattoOpzione, Scadenza

OGGI = date(2026, 11, 5)


def _scadenza(classe, scad, reale, strikes):
    contratti = [ContrattoOpzione(hash((classe, scad, k, r)) & 0xFFFFFFF, classe, scad, reale, k, r, f'{classe} {k}{r}')
                 for k in strikes for r in ('C', 'P')]
    return Scadenza(classe, scad, reale, '2026-11-05T10:00:00', contratti)


def _catena():
    c = Catena('2026-11-05')
    for s in (_scadenza('SPXW', '20261105', '20261105', [7680, 7685, 7690, 7695, 7700, 9000]),
              # Terzo venerdi': stessa scadenza reale, due classi, due contratti diversi.
              _scadenza('SPXW', '20261120', '20261120', [7690, 7700]),
              _scadenza('SPX', '20261119', '20261120', [7690, 7700]),
              _scadenza('SPXW', '20270129', '20270129', [7700])):
        c.scadenze[s.chiave] = s
    return c


class TestCatena(unittest.TestCase):
    def test_spx_e_spxw_restano_distinti(self):
        c = _catena()
        stessa_data = [x for x in c.contratti(oggi=OGGI) if x.scadenza_reale == '20261120' and x.strike == 7700
                       and x.right == 'C']
        self.assertEqual(sorted(x.classe for x in stessa_data), ['SPX', 'SPXW'])
        self.assertEqual(len({x.conId for x in stessa_data}), 2)

    def test_dte_sulla_scadenza_reale(self):
        spx_am = _catena().scadenze['SPX|20261119'].contratti[0]
        self.assertEqual(spx_am.dte(OGGI), 15)  # non 14: il venerdi', non il giovedi'

    def test_filtri_range_e_dte(self):
        c = _catena()
        self.assertEqual(len(c.contratti(oggi=OGGI)), 12 + 4 + 4 + 2)
        nel_range = c.contratti(atm=7690, rng=10, oggi=OGGI)
        self.assertTrue(all(abs(x.strike - 7690) <= 10 for x in nel_range))
        self.assertNotIn(9000, {x.strike for x in nel_range})
        self.assertTrue(all(x.dte(OGGI) <= 30 for x in c.contratti(dte_max=30, oggi=OGGI)))
        self.assertEqual({x.classe for x in c.contratti(classi=('SPX',), oggi=OGGI)}, {'SPX'})

    def test_call_e_put_separate(self):
        c = _catena()
        k = [x for x in c.contratti(oggi=OGGI) if x.classe == 'SPXW' and x.scadenza == '20261105' and x.strike == 7690]
        self.assertEqual(sorted(x.right for x in k), ['C', 'P'])

    def test_cache_andata_e_ritorno(self):
        c = _catena()
        with tempfile.TemporaryDirectory() as cartella:
            c.salva(Path(cartella))
            letta = Catena.carica('2026-11-05', Path(cartella))
        self.assertEqual(set(letta.scadenze), set(c.scadenze))
        self.assertEqual(letta.contratti(oggi=OGGI), c.contratti(oggi=OGGI))

    def test_cache_illeggibile_riparte_vuota(self):
        with tempfile.TemporaryDirectory() as cartella:
            (Path(cartella) / '2026-11-05.json').write_text('{rotto', encoding='utf-8')
            self.assertEqual(Catena.carica('2026-11-05', Path(cartella)).scadenze, {})

    def test_contratto_per_ibkr(self):
        x = _catena().scadenze['SPX|20261119'].contratti[0]
        o = x.per_ibkr()
        self.assertEqual((o.conId, o.tradingClass, o.lastTradeDateOrContractMonth, o.exchange),
                         (x.conId, 'SPX', '20261119', 'SMART'))


if __name__ == '__main__':
    unittest.main()
