"""
Fase 2 - scoperta della catena SPX 0-90 DTE, con cache giornaliera.

Cosa tiene distinto:
  - trading class: SPX (mensili AM, settlement all'apertura del venerdi') e
    SPXW (PM, giornaliere/settimanali/fine mese). Il terzo venerdi' esistono
    entrambe con la stessa data di scadenza reale: sono contratti diversi.
  - due date per contratto: `scadenza` = lastTradeDateOrContractMonth di
    IBKR (per le SPX AM e' il giovedi' prima, es. 20261119) e
    `scadenza_reale` = realExpirationDate (20261120). Il DTE si conta sulla
    scadenza reale, cosi' SPX e SPXW dello stesso venerdi' stanno sulla
    stessa X del grafico.
  - SPXO e altre classi: ignorate (il 05/11/2026 SPXO non aveva strike
    entro +/-2000 dall'ATM).

La cache contiene *tutti* gli strike di ogni scadenza, non solo quelli nel
range: il range si cambia dalla dashboard (fino a +/-5000) e non deve
costare nuove richieste. File: `.tmp/spx_flow_scanner/catena/YYYY-MM-DD.json`
(data di New York), salvato dopo ogni scadenza letta, cosi' un'interruzione
riparte da dove si era fermata.

Aggiornamento incrementale: le scadenze gia' in cache non si richiedono;
quelle vicine (DTE <= `dte_rinfresco`) si rileggono dopo
`rinfresco_minuti`, perche' il Cboe aggiunge strike in giornata quando il
mercato si muove molto.
"""

import json
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from ib_insync import Option

from spx_flow_scanner.config.settings import CARTELLA_DATI, IMPOSTAZIONI
from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr
from spx_flow_scanner.connectors.ibkr_contracts import catene_opzioni, dettagli_scadenza
from spx_flow_scanner.utils.logger import prendi_logger
from spx_flow_scanner.utils.market_calendar import giorno_di_borsa

log = prendi_logger('catena')
NEW_YORK = ZoneInfo('America/New_York')
CLASSI = ('SPXW', 'SPX')
CARTELLA_CATENA = CARTELLA_DATI / 'catena'


def oggi_ny() -> date:
    """Il giorno di borsa, non quello di calendario: dalle 20:15 NY e' gia' domani."""
    return giorno_di_borsa()


def giorni_a(data_yyyymmdd: str, oggi: date | None = None) -> int:
    return (datetime.strptime(data_yyyymmdd, '%Y%m%d').date() - (oggi or oggi_ny())).days


@dataclass(frozen=True)
class ContrattoOpzione:
    conId: int
    classe: str
    scadenza: str          # lastTradeDateOrContractMonth
    scadenza_reale: str    # realExpirationDate
    strike: float
    right: str             # 'C' / 'P'
    local_symbol: str

    def dte(self, oggi: date | None = None) -> int:
        return giorni_a(self.scadenza_reale, oggi)

    def per_ibkr(self) -> Option:
        return Option('SPX', self.scadenza, self.strike, self.right, exchange='SMART',
                      currency='USD', multiplier='100', tradingClass=self.classe, conId=self.conId,
                      localSymbol=self.local_symbol)


@dataclass
class Scadenza:
    classe: str
    scadenza: str
    scadenza_reale: str
    letta_alle: str        # ISO, ora di questo PC
    contratti: list        # [ContrattoOpzione]

    @property
    def chiave(self) -> str:
        return f'{self.classe}|{self.scadenza}'


class Catena:
    def __init__(self, data_ny: str):
        self.data_ny = data_ny
        self.scadenze: dict[str, Scadenza] = {}
        self.orari = {'tradingHours': '', 'liquidHours': '', 'timeZoneId': ''}

    # -- interrogazione ---------------------------------------------------

    def contratti(self, atm: float | None = None, rng: float | None = None,
                  dte_min: int = 0, dte_max: int = 90, classi=CLASSI, oggi: date | None = None) -> list:
        fuori = []
        for s in self.scadenze.values():
            if s.classe not in classi:
                continue
            d = giorni_a(s.scadenza_reale, oggi)
            if not dte_min <= d <= dte_max:
                continue
            for c in s.contratti:
                if atm is not None and rng is not None and abs(c.strike - atm) > rng:
                    continue
                fuori.append(c)
        return fuori

    def strike_vicina(self) -> list:
        """Strike della scadenza piu' vicina (SPXW): la base per l'ATM."""
        candidate = [s for s in self.scadenze.values() if s.classe == 'SPXW' and giorni_a(s.scadenza_reale) >= 0]
        if not candidate:
            return []
        prima = min(candidate, key=lambda s: s.scadenza_reale)
        return sorted({c.strike for c in prima.contratti})

    # -- persistenza ------------------------------------------------------

    def a_dict(self) -> dict:
        return {
            'data_ny': self.data_ny, 'orari': self.orari,
            'scadenze': {k: {'classe': s.classe, 'scadenza': s.scadenza, 'scadenza_reale': s.scadenza_reale,
                             'letta_alle': s.letta_alle,
                             'contratti': [[c.conId, c.strike, c.right, c.local_symbol] for c in s.contratti]}
                         for k, s in self.scadenze.items()},
        }

    @classmethod
    def da_dict(cls, d: dict) -> 'Catena':
        catena = cls(d['data_ny'])
        catena.orari = d.get('orari') or catena.orari
        for k, s in d.get('scadenze', {}).items():
            contratti = [ContrattoOpzione(conId, s['classe'], s['scadenza'], s['scadenza_reale'], strike, right, ls)
                         for conId, strike, right, ls in s['contratti']]
            catena.scadenze[k] = Scadenza(s['classe'], s['scadenza'], s['scadenza_reale'], s['letta_alle'], contratti)
        return catena

    def salva(self, cartella=CARTELLA_CATENA):
        cartella.mkdir(parents=True, exist_ok=True)
        percorso = cartella / f'{self.data_ny}.json'
        temporaneo = percorso.with_suffix('.tmp')
        temporaneo.write_text(json.dumps(self.a_dict(), separators=(',', ':')), encoding='utf-8')
        temporaneo.replace(percorso)  # mai un file a meta' se il processo muore qui
        return percorso

    @classmethod
    def carica(cls, data_ny: str, cartella=CARTELLA_CATENA) -> 'Catena':
        percorso = cartella / f'{data_ny}.json'
        if not percorso.exists():
            return cls(data_ny)
        try:
            return cls.da_dict(json.loads(percorso.read_text(encoding='utf-8')))
        except (ValueError, KeyError, TypeError) as e:
            log.warning('cache catena %s illeggibile (%s): si riparte da zero', percorso, e)
            return cls(data_ny)


def _da_dettagli(classe: str, dettagli: list) -> Scadenza | None:
    contratti = []
    reali = set()
    for d in dettagli:
        c = d.contract
        if c.tradingClass != classe or c.right not in ('C', 'P'):
            continue
        reale = d.realExpirationDate or c.lastTradeDateOrContractMonth
        reali.add(reale)
        contratti.append(ContrattoOpzione(c.conId, classe, c.lastTradeDateOrContractMonth, reale,
                                          float(c.strike), c.right, c.localSymbol))
    if not contratti:
        return None
    if len(reali) > 1:
        log.warning('%s: piu\' date di scadenza reale nella stessa richiesta: %s', classe, sorted(reali))
    contratti.sort(key=lambda c: (c.strike, c.right))
    primo = contratti[0]
    return Scadenza(classe, primo.scadenza, primo.scadenza_reale,
                    datetime.now().isoformat(timespec='seconds'), contratti)


def aggiorna_catena(cli: ClienteIbkr, spx, dte_max: int = IMPOSTAZIONI.dte_max, forza: bool = False,
                    dte_rinfresco: int = 7, rinfresco_minuti: int = 60) -> tuple[Catena, dict]:
    oggi = oggi_ny()
    catena = Catena(oggi.isoformat()) if forza else Catena.carica(oggi.isoformat())
    statistiche = {'richieste': 0, 'nuove': 0, 'rinfrescate': 0, 'dalla_cache': 0, 'vuote': [], 'ignorate': {}}
    t0 = time.monotonic()

    lista = catene_opzioni(cli, spx)
    statistiche['richieste'] += 1
    # Margine di un giorno sulla data di ultimo trade: per le SPX AM la
    # scadenza reale e' il giorno dopo.
    voluti = []
    for c in lista:
        if c.tradingClass not in CLASSI:
            statistiche['ignorate'][c.tradingClass] = len(c.expirations)
            continue
        voluti += [(c.tradingClass, s) for s in c.expirations if 0 <= giorni_a(s, oggi) <= dte_max + 1]
    voluti.sort(key=lambda x: (x[1], x[0]))  # prima le vicine: sono quelle che servono subito

    for classe, scadenza in voluti:
        chiave = f'{classe}|{scadenza}'
        esistente = catena.scadenze.get(chiave)
        if esistente and not forza:
            eta_min = (datetime.now() - datetime.fromisoformat(esistente.letta_alle)).total_seconds() / 60
            if giorni_a(esistente.scadenza_reale, oggi) > dte_rinfresco or eta_min < rinfresco_minuti:
                statistiche['dalla_cache'] += 1
                continue
        dettagli = dettagli_scadenza(cli, classe, scadenza)
        statistiche['richieste'] += 1
        nuova = _da_dettagli(classe, dettagli)
        if nuova is None:
            statistiche['vuote'].append(chiave)
            continue
        if giorni_a(nuova.scadenza_reale, oggi) > dte_max:
            continue  # il margine di un giorno ha preso una scadenza oltre il limite
        # Orari da una scadenza non imminente: la 0DTE elenca solo le sessioni
        # fino alla propria scadenza, quindi non la notturna successiva.
        if dettagli and (not catena.orari['tradingHours'] or giorni_a(nuova.scadenza_reale, oggi) >= 2):
            d = dettagli[0]
            catena.orari = {'tradingHours': d.tradingHours, 'liquidHours': d.liquidHours,
                            'timeZoneId': d.timeZoneId}
        if esistente:
            aggiunti = len(nuova.contratti) - len(esistente.contratti)
            if aggiunti:
                log.info('%s: %+d contratti rispetto alla lettura precedente', chiave, aggiunti)
            statistiche['rinfrescate'] += 1
        else:
            statistiche['nuove'] += 1
        catena.scadenze[nuova.chiave] = nuova
        catena.salva()

    # Fuori le scadenze passate o non piu' elencate da IBKR.
    elencate = {f'{c}|{s}' for c, s in voluti}
    for chiave in [k for k, s in catena.scadenze.items()
                   if k not in elencate or giorni_a(s.scadenza_reale, oggi) < 0]:
        del catena.scadenze[chiave]
    catena.salva()
    statistiche['secondi'] = round(time.monotonic() - t0, 1)
    return catena, statistiche
