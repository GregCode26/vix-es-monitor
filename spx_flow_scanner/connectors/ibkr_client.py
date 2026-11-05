"""
Connessione a TWS per lo scanner.

Regole che valgono per tutto lo scanner:
  - clientId in una fascia propria (30000-39999) e `readonly=True`: lo
    scanner legge soltanto, non deve poter mandare ordini.
  - ogni richiesta passa dal limitatore (`self.limitatore.attendi()`).
  - gli errori IBKR non si perdono: finiscono nel log e restano contati in
    `self.errori` per codice, cosi' chi chiama puo' reagire (101 = linee
    finite, 354/10167 = niente abbonamento / dati delayed, 321 = richiesta
    non valida, ad esempio generic tick su uno snapshot).
"""

import random
import time
from collections import Counter, deque
from datetime import datetime, timezone

from ib_insync import IB

from spx_flow_scanner.config.settings import IMPOSTAZIONI, Impostazioni
from spx_flow_scanner.utils.logger import prendi_logger
from spx_flow_scanner.utils.rate_limiter import LimitatoreRichieste

log = prendi_logger('ibkr')

# Messaggi informativi che TWS manda a ogni connessione.
_INNOCUI = {2104, 2106, 2107, 2108, 2119, 2158, 2100, 2103, 2105, 2157}
# Connessione persa / ripresa fra TWS e i server IBKR.
_CONNESSIONE = {1100, 1101, 1102}

TIPI_DATI = {0: 'NON_COMUNICATO', 1: 'LIVE', 2: 'FROZEN', 3: 'DELAYED', 4: 'DELAYED_FROZEN'}


class ClienteIbkr:
    def __init__(self, impostazioni: Impostazioni = IMPOSTAZIONI):
        self.cfg = impostazioni
        self.ib = IB()
        self.client_id: int | None = None
        self.errori: Counter = Counter()
        self.ultimi_errori: deque = deque(maxlen=200)
        self.limitatore = LimitatoreRichieste(impostazioni.messaggi_al_secondo,
                                              dormi=self._dormi)
        self.ib.errorEvent += self._su_errore
        self.ib.disconnectedEvent += self._su_disconnessione

    # -- eventi -----------------------------------------------------------

    def _dormi(self, secondi: float) -> None:
        if self.ib.isConnected():
            self.ib.sleep(secondi)
        else:
            time.sleep(secondi)

    def _su_errore(self, req_id, codice, messaggio, contratto) -> None:
        if codice in _INNOCUI:
            return
        self.errori[codice] += 1
        dettaglio = ''
        if contratto is not None and getattr(contratto, 'strike', None):
            dettaglio = (f' [{contratto.tradingClass or contratto.symbol} '
                         f'{contratto.lastTradeDateOrContractMonth} {contratto.strike} {contratto.right}]')
        self.ultimi_errori.append({
            'ora': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'req': req_id, 'codice': codice, 'messaggio': messaggio, 'contratto': dettaglio.strip(' []'),
        })
        livello = log.warning if codice in _CONNESSIONE else log.error
        livello('IBKR %s (req %s): %s%s', codice, req_id, messaggio, dettaglio)

    def _su_disconnessione(self) -> None:
        log.warning('disconnesso da TWS')

    # -- connessione ------------------------------------------------------

    def connetti(self) -> bool:
        """Prova a collegarsi con attese crescenti; False se TWS non risponde."""
        for tentativo in range(1, self.cfg.tentativi_connessione + 1):
            self.client_id = random.randint(self.cfg.client_id_min, self.cfg.client_id_max)
            try:
                log.info('connessione a %s:%s clientId %s (tentativo %s/%s)', self.cfg.host,
                         self.cfg.porta, self.client_id, tentativo, self.cfg.tentativi_connessione)
                self.ib.connect(self.cfg.host, self.cfg.porta, clientId=self.client_id,
                                timeout=self.cfg.timeout_connessione, readonly=True)
                self.ib.reqMarketDataType(self.cfg.tipo_dati_richiesto)
                log.info('collegato (server version %s)', self.ib.client.serverVersion())
                return True
            except Exception as e:  # ConnectionRefusedError, TimeoutError, ...
                log.warning('connessione fallita: %s: %s', type(e).__name__, e)
                try:
                    self.ib.disconnect()
                except Exception:
                    pass
                if tentativo < self.cfg.tentativi_connessione:
                    time.sleep(min(60, 5 * 2 ** (tentativo - 1)))
        return False

    def assicura_connessione(self) -> bool:
        return self.ib.isConnected() or self.connetti()

    def disconnetti(self) -> None:
        try:
            if self.ib.isConnected():
                self.ib.disconnect()
        except Exception:
            pass

    # -- diagnostica ------------------------------------------------------

    def stato(self) -> dict:
        collegato = self.ib.isConnected()
        stato = {'collegato': collegato, 'client_id': self.client_id,
                 'host': self.cfg.host, 'porta': self.cfg.porta}
        if not collegato:
            return stato
        stato['server_version'] = self.ib.client.serverVersion()
        stato['conti'] = self.ib.managedAccounts()
        try:
            self.limitatore.attendi()
            ora_tws = self.ib.reqCurrentTime()
            scarto = (datetime.now(timezone.utc) - ora_tws).total_seconds()
            stato['ora_tws_utc'] = ora_tws.isoformat(timespec='seconds')
            stato['scarto_orologio_s'] = round(scarto, 1)
        except Exception as e:
            stato['ora_tws_utc'] = f'errore: {e}'
        return stato


def tipo_dati(ticker) -> str:
    return TIPI_DATI.get(getattr(ticker, 'marketDataType', 0), 'SCONOSCIUTO')
