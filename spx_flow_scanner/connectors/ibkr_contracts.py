"""
Richieste di definizione dei contratti (nessuna linea di market data).

`reqSecDefOptParams` da' per ogni trading class l'*unione* di scadenze e
strike: incrociarle produce contratti che non esistono (49.500 combinazioni
contro ~16.400 contratti reali il 05/11/2026). I contratti veri arrivano solo
da `reqContractDetails`, una richiesta per scadenza senza strike ne' right.
"""

import time

from ib_insync import Option

from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr
from spx_flow_scanner.utils.logger import prendi_logger

log = prendi_logger('contratti')


def catene_opzioni(cli: ClienteIbkr, spx) -> list:
    cli.limitatore.attendi()
    tutte = cli.ib.reqSecDefOptParams(spx.symbol, '', spx.secType, spx.conId)
    smart = [c for c in tutte if c.exchange == 'SMART']
    return smart or tutte


def dettagli_scadenza(cli: ClienteIbkr, classe: str, scadenza: str, tentativi: int = 3) -> list:
    """
    Tutti i ContractDetails di una scadenza. Una lista vuota e' ambigua
    (scadenza sparita o richiesta andata a vuoto), quindi si riprova prima di
    accettarla.
    """
    for tentativo in range(1, tentativi + 1):
        cli.limitatore.attendi()
        t0 = time.monotonic()
        try:
            dettagli = cli.ib.reqContractDetails(
                Option('SPX', scadenza, exchange='SMART', currency='USD', tradingClass=classe))
        except Exception as e:
            log.warning('contractDetails %s %s fallita (%s/%s): %s', classe, scadenza,
                        tentativo, tentativi, e)
            dettagli = []
        if dettagli:
            log.info('contractDetails %s %s: %s contratti in %.1fs', classe, scadenza,
                     len(dettagli), time.monotonic() - t0)
            return dettagli
        cli.ib.sleep(2 * tentativo)
    log.error('contractDetails %s %s: nessun contratto dopo %s tentativi', classe, scadenza, tentativi)
    return []
