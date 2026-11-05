"""
Singoli trade dallo storico tick di IBKR (reqHistoricalTicks, TRADES).

Perche': il volume letto dallo scanner ogni 10 minuti e' cumulativo, e un
incremento di 3.000 puo' essere un blocco o 300 trade da 10. Lo storico tick
da' ogni stampa con secondo, quantita', prezzo e borsa (provato il 05/11/2026:
7400P 1DTE, 2.000 contratti alle 10:29:19 a 24,40).

Quali contratti leggere: un trade >= N puo' esserci solo dove il volume della
sessione e' salito di almeno N da quando i trade sono stati letti l'ultima
volta. Quindi i candidati vengono da `volume_latest` (lo scanner dei volumi)
e la soglia di base `trade_minimo` decide quanti sono (~200 per ciclo a 100,
~95 a 500, misurato il 05/11).

Ritmo: IBKR non ha dato errori di pacing a 1 richiesta/s per 60 richieste,
ma dopo ~20 rallenta da solo a 5-12 s l'una (~280 richieste ogni 10 minuti).
Le richieste vanno quindi una alla volta, in sequenza; su errore 162 di
pacing si fa una pausa di 10 minuti.

Le stampe si contano una per una, senza unire quelle dello stesso secondo:
un ordine da 1.000 eseguito come 400+200+200+200 sono quattro trade.
"""

import time
from datetime import date, datetime, time as ora, timedelta, timezone

from ib_insync import Contract

from spx_flow_scanner.utils.logger import prendi_logger
from spx_flow_scanner.utils.market_calendar import (APERTURA_CASH_NY, APERTURA_NOTTURNA_NY, NEW_YORK,
                                                     sessione_di_borsa)

log = prendi_logger('trade')
PAGINA = 1000
PAUSA_PACING_S = 600


def inizio_sessione(giorno: str, sessione: str) -> datetime:
    g = date.fromisoformat(giorno)
    if sessione == 'cash':
        return datetime.combine(g, ora(*APERTURA_CASH_NY), NEW_YORK)
    return datetime.combine(g - timedelta(days=1), ora(*APERTURA_NOTTURNA_NY), NEW_YORK)


def sessioni_da_leggere(db, quante: int = 2) -> list[tuple[str, str]]:
    """Le ultime sessioni con volumi: quella in corso e la precedente (per finire i candidati rimasti)."""
    righe = db.execute("SELECT giorno, sessione, MAX(updated_at) u FROM volume_latest GROUP BY giorno, sessione "
                       "ORDER BY u DESC LIMIT ?", (quante,)).fetchall()
    return [(r[0], r[1]) for r in righe]


def candidati(db, giorno: str, sessione: str, soglia: int) -> list[dict]:
    righe = db.execute(
        """SELECT l.con_id, l.volume, l.ts, c.fino_ts, COALESCE(c.n_nel_secondo, 0) n_nel_secondo,
                  COALESCE(c.vol_rif, 0) vol_rif
           FROM volume_latest l
           LEFT JOIN trade_cursor c ON c.giorno = l.giorno AND c.sessione = l.sessione AND c.con_id = l.con_id
           WHERE l.giorno = ? AND l.sessione = ? AND l.volume IS NOT NULL
             AND l.volume - COALESCE(c.vol_rif, 0) >= ?
           ORDER BY l.volume - COALESCE(c.vol_rif, 0) DESC""", (giorno, sessione, soglia)).fetchall()
    return [dict(r) for r in righe]


def scorri_stampe(ticks, cur_s: int | None, cur_n: int):
    """
    Toglie da una pagina le stampe gia' viste e numera le altre nel loro
    secondo. La pagina riparte dal secondo `cur_s`, di cui `cur_n` stampe sono
    gia' state lette. Restituisce ([(ts, seq, tick)], cur_s, cur_n).
    """
    nuove = []
    prec_s, seq = None, -1
    for t in ticks:
        s = int(t.time.timestamp())
        seq = seq + 1 if s == prec_s else 0
        prec_s = s
        if cur_s is not None and (s < cur_s or (s == cur_s and seq < cur_n)):
            continue
        nuove.append((s, seq, t))
        if s == cur_s:
            cur_n = seq + 1
        else:
            cur_s, cur_n = s, seq + 1
    return nuove, cur_s, cur_n


class LettoreTrade:
    def __init__(self, cli, db, cfg):
        self.cli, self.db, self.cfg = cli, db, cfg
        self.richieste = 0
        self.pagina = PAGINA

    def _pagina(self, con_id: int, da: datetime):
        prima = len(self.cli.ultimi_errori)
        self.richieste += 1
        ticks = self.cli.ib.reqHistoricalTicks(Contract(conId=con_id, exchange='SMART'), da, '', self.pagina,
                                               'TRADES', useRth=False)
        nuovi = list(self.cli.ultimi_errori)[prima:] if len(self.cli.ultimi_errori) > prima else []
        if any(e['codice'] == 162 and 'pacing' in e['messaggio'].lower() for e in nuovi):
            raise PacingIbkr(nuovi[-1]['messaggio'])
        return ticks or []

    def leggi(self, giorno: str, sessione: str, c: dict) -> dict:
        """Legge i trade nuovi di un contratto, fino al presente o a `trade_pagine_per_giro` pagine."""
        cur_s, cur_n = c['fino_ts'], c['n_nel_secondo']
        stampe = salvati = pagine = contratti = 0
        in_pari = False
        da = datetime.fromtimestamp(cur_s, timezone.utc) if cur_s else inizio_sessione(giorno, sessione)
        righe = []
        while pagine < self.cfg.trade_pagine_per_giro:
            ticks = self._pagina(c['con_id'], da)
            pagine += 1
            nuove, cur_s, cur_n = scorri_stampe(ticks, cur_s, cur_n)
            fuori = False
            for s, seq, t in nuove:
                g, ses = sessione_di_borsa(t.time)
                if (g.isoformat(), ses) != (giorno, sessione):
                    fuori = True  # stampa della sessione dopo: questa e' finita
                    break
                stampe += 1
                contratti += int(t.size)
                if t.size >= self.cfg.trade_minimo:
                    righe.append((c['con_id'], s, seq, giorno, sessione, int(t.size), t.price, t.exchange,
                                  t.specialConditions or None))
            if fuori or len(ticks) < self.pagina:
                in_pari = True
                break
            if not nuove:
                # Un solo secondo con piu' di 1000 stampe: si passa oltre, segnalandolo.
                log.warning('con_id %s: secondo %s con >%d stampe, salto al successivo', c['con_id'], cur_s, self.pagina)
                cur_s, cur_n = cur_s + 1, 0
            da = datetime.fromtimestamp(cur_s, timezone.utc)
        adesso = int(time.time())
        self.db.executemany('INSERT OR IGNORE INTO trades (con_id, ts, seq, giorno, sessione, size, price, exchange, '
                            'conditions) VALUES (?,?,?,?,?,?,?,?,?)', righe)
        self.db.execute(
            """INSERT INTO trade_cursor (giorno, sessione, con_id, fino_ts, n_nel_secondo, vol_rif, vol_rif_ts, in_pari,
                                         stampe_lette, contratti_letti, pagine, soglia, aggiornato)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT (giorno, sessione, con_id) DO UPDATE SET
                 fino_ts = excluded.fino_ts, n_nel_secondo = excluded.n_nel_secondo,
                 vol_rif = CASE WHEN excluded.in_pari = 1 THEN excluded.vol_rif ELSE trade_cursor.vol_rif END,
                 vol_rif_ts = CASE WHEN excluded.in_pari = 1 THEN excluded.vol_rif_ts ELSE trade_cursor.vol_rif_ts END,
                 in_pari = excluded.in_pari,
                 stampe_lette = trade_cursor.stampe_lette + excluded.stampe_lette,
                 contratti_letti = trade_cursor.contratti_letti + excluded.contratti_letti,
                 pagine = trade_cursor.pagine + excluded.pagine,
                 soglia = excluded.soglia, aggiornato = excluded.aggiornato""",
            (giorno, sessione, c['con_id'], cur_s, cur_n, c['volume'] if in_pari else c['vol_rif'], c['ts'],
             int(in_pari), stampe, contratti, pagine, self.cfg.trade_minimo, adesso))
        self.db.commit()
        return {'pagine': pagine, 'stampe': stampe, 'salvati': len(righe), 'in_pari': in_pari}

    def giro(self, budget_s: float) -> dict:
        """Un giro sui candidati delle ultime sessioni, entro `budget_s` secondi."""
        t0 = time.monotonic()
        tot = {'candidati': 0, 'letti': 0, 'in_pari': 0, 'pagine': 0, 'stampe': 0, 'salvati': 0, 'rimasti': 0}
        for giorno, sessione in sessioni_da_leggere(self.db):
            lista = candidati(self.db, giorno, sessione, self.cfg.trade_minimo)
            tot['candidati'] += len(lista)
            for c in lista:
                if time.monotonic() - t0 > budget_s:
                    tot['rimasti'] += 1
                    continue
                r = self.leggi(giorno, sessione, c)
                tot['letti'] += 1
                tot['in_pari'] += r['in_pari']
                for k in ('pagine', 'stampe', 'salvati'):
                    tot[k] += r[k]
        tot['secondi'] = round(time.monotonic() - t0, 1)
        return tot


class PacingIbkr(Exception):
    pass
