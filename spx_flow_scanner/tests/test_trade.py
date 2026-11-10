import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from spx_flow_scanner.database.repository import Archivio
from spx_flow_scanner.scanner.trade_scanner import (LettoreTrade, candidati, inizio_sessione, scorri_stampe,
                                                    verso_da_quota)
from spx_flow_scanner.utils.market_calendar import NEW_YORK

T0 = int(datetime(2026, 11, 5, 10, 0, tzinfo=NEW_YORK).timestamp())


def _tick(s, size, price=1.0):
    return SimpleNamespace(time=datetime.fromtimestamp(s, timezone.utc), size=size, price=price,
                           exchange='CBOE', specialConditions='')


class TestScorriStampe(unittest.TestCase):
    def test_pagina_che_riparte_dal_secondo_gia_visto(self):
        p1 = [_tick(T0, 1), _tick(T0 + 1, 400), _tick(T0 + 1, 200)]
        nuove, s, n = scorri_stampe(p1, None, 0)
        self.assertEqual([(x[0] - T0, x[1]) for x in nuove], [(0, 0), (1, 0), (1, 1)])
        self.assertEqual((s - T0, n), (1, 2))
        # La pagina dopo riparte da T0+1 e ripete le due stampe gia' lette, piu' una nuova.
        p2 = [_tick(T0 + 1, 400), _tick(T0 + 1, 200), _tick(T0 + 1, 200), _tick(T0 + 2, 5)]
        nuove, s, n = scorri_stampe(p2, s, n)
        self.assertEqual([(x[0] - T0, x[1], x[2].size) for x in nuove], [(1, 2, 200), (2, 0, 5)])
        self.assertEqual((s - T0, n), (2, 1))

    def test_inizio_sessioni(self):
        self.assertEqual(inizio_sessione('2026-11-05', 'cash').strftime('%m-%d %H:%M'), '11-05 09:30')
        self.assertEqual(inizio_sessione('2026-11-05', 'notturna').strftime('%m-%d %H:%M'), '11-04 20:15')


class FintoIb:
    """Restituisce le stampe a pagine da `pagina` a partire da `da`, come reqHistoricalTicks."""
    def __init__(self, stampe, pagina):
        self.stampe, self.pagina, self.chiamate = stampe, pagina, 0

    def reqHistoricalTicks(self, contratto, da, fine, quante, cosa, useRth):
        self.chiamate += 1
        da_s = int(da.timestamp())
        dopo = [t for t in self.stampe if int(t.time.timestamp()) >= da_s][:self.pagina]
        if dopo:  # IBKR completa l'ultimo secondo
            ultimo = int(dopo[-1].time.timestamp())
            resto = [t for t in self.stampe if int(t.time.timestamp()) == ultimo]
            dopo = [t for t in dopo if int(t.time.timestamp()) < ultimo] + resto
        return dopo


class TestLettore(unittest.TestCase):
    def setUp(self):
        self.cartella = tempfile.TemporaryDirectory()
        self.a = Archivio(Path(self.cartella.name) / 't.db')
        db = self.a.db
        db.execute("INSERT INTO volume_latest (giorno, sessione, con_id, trading_class, real_expiry, dte, strike, "
                   "opt_right, volume, ts, readings_ok, last_attempt_ts, last_attempt_status, updated_at) "
                   "VALUES ('2026-11-05', 'cash', 1, 'SPXW', '20261105', 0, 7500, 'P', 2000, ?, 1, ?, 'OK', ?)",
                   (T0 + 600,) * 3)
        db.execute("INSERT INTO volume_latest (giorno, sessione, con_id, trading_class, real_expiry, dte, strike, "
                   "opt_right, volume, ts, readings_ok, last_attempt_ts, last_attempt_status, updated_at) "
                   "VALUES ('2026-11-05', 'cash', 2, 'SPXW', '20261105', 0, 7600, 'P', 50, ?, 1, ?, 'OK', ?)",
                   (T0 + 600,) * 3)
        db.commit()

    def tearDown(self):
        self.a.db.close()
        self.cartella.cleanup()

    def test_candidati_salvataggio_e_cursore(self):
        db = self.a.db
        self.assertEqual([c['con_id'] for c in candidati(db, '2026-11-05', 'cash', 100)], [1])  # 50 < soglia
        stampe = [_tick(T0 + i, 3) for i in range(20)] + [_tick(T0 + 30, 400), _tick(T0 + 30, 200),
                                                         _tick(T0 + 30, 200), _tick(T0 + 31, 150)]
        ib = FintoIb(stampe, pagina=7)
        cli = SimpleNamespace(ib=ib, ultimi_errori=[])
        cfg = SimpleNamespace(trade_minimo=100, trade_pagine_per_giro=50)
        lettore = LettoreTrade(cli, db, cfg)
        lettore.pagina = 7
        r = lettore.leggi('2026-11-05', 'cash', candidati(db, '2026-11-05', 'cash', 100)[0])
        self.assertTrue(r['in_pari'])
        self.assertEqual(r['stampe'], len(stampe))           # nessuna stampa contata due volte fra le pagine
        salvati = db.execute('SELECT size FROM trades ORDER BY ts, seq').fetchall()
        self.assertEqual([x[0] for x in salvati], [400, 200, 200, 150])  # stampe separate, non unite
        # In pari: il contratto non e' piu' candidato finche' il volume non sale di altri 100.
        self.assertEqual(candidati(db, '2026-11-05', 'cash', 100), [])
        db.execute("UPDATE volume_latest SET volume = 2100 WHERE con_id = 1")
        self.assertEqual([c['con_id'] for c in candidati(db, '2026-11-05', 'cash', 100)], [1])


    def test_classifica_verso(self):
        db = self.a.db
        db.executemany("INSERT INTO trades (con_id, ts, seq, giorno, sessione, size, price) VALUES (1, ?, 0, '2026-11-05', 'cash', 300, ?)",
                       [(T0 + 10, 2.05), (T0 + 20, 1.90), (T0 + 30, 1.975), (T0 + 40, 1.95)])
        quote = {T0 + 10: [(T0 + 9, 1.95, 2.0)], T0 + 20: [(T0 + 19, 1.95, 2.0)], T0 + 30: [(T0 + 29, 1.95, 2.0)],
                 T0 + 40: [(T0 + 40, 1.95, 2.0)]}  # solo una quota nello stesso secondo: non vale

        class Ib:
            def reqHistoricalTicks(self, contratto, da, fine, quante, cosa, useRth):
                return [SimpleNamespace(time=datetime.fromtimestamp(s, timezone.utc), priceBid=b, priceAsk=a)
                        for s, b, a in quote[int(fine.timestamp())]]
        lettore = LettoreTrade(SimpleNamespace(ib=Ib(), ultimi_errori=[]), db, SimpleNamespace())
        self.assertEqual(lettore.classifica(60, [('2026-11-05', 'cash')]), 4)
        versi = [r[0] for r in db.execute('SELECT verso FROM trades ORDER BY ts')]
        self.assertEqual(versi, ['C', 'V', 'I', 'N'])
        self.assertEqual(verso_da_quota(1.96, 1.95, 2.0), 'V')


if __name__ == '__main__':
    unittest.main()
