"""
Fase 6 - filtri sulla situazione per contratto (`volume_latest`).

Tutto vale dentro una sessione (notturna o cash): IBKR azzera il volume
all'apertura di ciascuna, quindi i due volumi non si confrontano ne' sommano.

Il filtro sul volume minimo vale per il singolo contratto (scadenza + strike
+ CALL/PUT, e trading class): CALL e PUT non si sommano mai, scadenze diverse
nemmeno, SPX AM e SPXW dello stesso venerdi' restano due righe.

La stessa logica la replichera' la pagina Next in SQL: qui c'e' la versione
di riferimento, coperta dai test, usata dalla riga di comando e dagli alert.
"""

from dataclasses import dataclass

from spx_flow_scanner.config.settings import IMPOSTAZIONI

TIPI = {'C': ('C',), 'P': ('P',), 'CP': ('C', 'P')}


@dataclass(frozen=True)
class Filtro:
    volume_minimo: int = IMPOSTAZIONI.volume_minimo
    tipo: str = 'CP'                   # 'C', 'P', 'CP'
    dte_min: int = 0
    dte_max: int = IMPOSTAZIONI.dte_max
    range_strike: int = IMPOSTAZIONI.range_strike
    atm: float | None = None           # riferimento scelto (vedi riferimento_atm)
    eta_max_s: int | None = None       # scarta letture piu' vecchie (None = tutte)

    def sql(self, giorno: str, sessione: str, adesso: int | None = None, soglia: bool = True) -> tuple[str, list]:
        """WHERE + parametri per `volume_latest`; `soglia=False` toglie il volume minimo."""
        condizioni = ['giorno = ?', 'sessione = ?', 'dte BETWEEN ? AND ?']
        parametri: list = [giorno, sessione, self.dte_min, self.dte_max]
        if soglia:
            condizioni += ['volume IS NOT NULL', 'volume >= ?']
            parametri.append(self.volume_minimo)
        tipi = TIPI[self.tipo]
        condizioni.append(f"opt_right IN ({', '.join('?' * len(tipi))})")
        parametri += list(tipi)
        if self.atm is not None:
            condizioni.append('strike BETWEEN ? AND ?')
            parametri += [self.atm - self.range_strike, self.atm + self.range_strike]
        if self.eta_max_s is not None and adesso is not None:
            condizioni.append('ts >= ?')
            parametri.append(adesso - self.eta_max_s)
        return ' AND '.join(condizioni), parametri

    def passa(self, r: dict, adesso: int | None = None) -> bool:
        if r.get('volume') is None or r['volume'] < self.volume_minimo:
            return False
        if r['opt_right'] not in TIPI[self.tipo] or not self.dte_min <= r['dte'] <= self.dte_max:
            return False
        if self.atm is not None and abs(r['strike'] - self.atm) > self.range_strike:
            return False
        if self.eta_max_s is not None and adesso is not None and r['ts'] < adesso - self.eta_max_s:
            return False
        return True


def contratti_filtrati(db, giorno: str, sessione: str, filtro: Filtro, adesso: int | None = None) -> list[dict]:
    dove, parametri = filtro.sql(giorno, sessione, adesso)
    db_righe = db.execute(f'SELECT * FROM volume_latest WHERE {dove} ORDER BY volume DESC', parametri)
    colonne = [d[0] for d in db_righe.description]
    return [dict(zip(colonne, r)) for r in db_righe]


def copertura(db, giorno: str, sessione: str, filtro: Filtro, adesso: int) -> dict:
    """
    Quanto dell'universo filtrato (senza la soglia di volume) e' stato letto
    davvero: la dashboard deve dire "N di M contratti letti", non dare per
    coperta la catena intera. Conta solo i contratti tentati almeno una volta
    oggi; i mai letti sono in `scan_history.never_read`.
    """
    dove, parametri = filtro.sql(giorno, sessione, soglia=False)
    r = db.execute(
        f'''SELECT COUNT(*), SUM(volume IS NOT NULL), SUM(volume IS NOT NULL AND ts >= ?),
                   SUM(volume IS NOT NULL AND ts >= ?) FROM volume_latest WHERE {dove}''',
        [adesso - 1800, adesso - 3600, *parametri]).fetchone()
    return {'contratti_tentati': r[0] or 0, 'con_volume': r[1] or 0,
            'letti_30min': r[2] or 0, 'letti_60min': r[3] or 0}
