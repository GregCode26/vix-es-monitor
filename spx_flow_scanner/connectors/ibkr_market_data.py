"""Lettura dei prezzi da IBKR e utilita' per riconoscere i valori mancanti."""

import math
import time

from ib_insync import Index

from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr, tipo_dati


def valido(x) -> bool:
    """IBKR segnala un dato assente con NaN o -1: nessuno dei due e' uno zero."""
    return x is not None and isinstance(x, (int, float)) and not math.isnan(x) and x != -1


def num(x):
    return x if valido(x) else None


def qualifica_spx(cli: ClienteIbkr):
    spx = Index('SPX', 'CBOE', 'USD')
    cli.limitatore.attendi()
    cli.ib.qualifyContracts(spx)
    return spx


def prezzo_spx(cli: ClienteIbkr, spx=None, attesa: float = 8) -> tuple:
    """
    Prezzo SPX con la sua fonte. Prima dell'apertura del cash SPX non stampa
    (`last` vuoto): si usa la chiusura precedente e lo si dichiara.
    Una linea sola, chiusa subito.
    """
    ib = cli.ib
    spx = spx or qualifica_spx(cli)
    cli.limitatore.attendi()
    t = ib.reqMktData(spx, '', False, False)
    t.marketDataType = 0  # si sa solo se TWS lo comunica
    fine = time.monotonic() + attesa
    while time.monotonic() < fine and not (valido(t.last) or valido(t.close)):
        ib.sleep(0.25)
    ib.sleep(0.5)
    risultato = {'conId': spx.conId, 'last': num(t.last), 'close': num(t.close),
                 'bid': num(t.bid), 'ask': num(t.ask), 'tipo_dati': tipo_dati(t)}
    cli.limitatore.attendi()
    ib.cancelMktData(spx)
    risultato['riferimento'] = risultato['last'] or risultato['close']
    risultato['fonte_riferimento'] = ('last' if risultato['last']
                                      else 'close' if risultato['close'] else None)
    return spx, risultato
