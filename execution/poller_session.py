"""
Tiene in piedi un poller senza che nessuno lo riavvii a mano.

I tre poller avevano tutti la stessa forma: `main()` si collegava a TWS,
sceglieva la catena 0DTE di *quel* momento, si abbonava ai contratti e poi
girava per sempre. Bastava una qualsiasi delle tre cose qui sotto per
lasciare la giornata senza dati:

  - mezzanotte. Il file su cui scrivere veniva ricalcolato a ogni giro, ma
    la scadenza 0DTE no: restava quella scelta all'avvio. Dal giorno dopo il
    poller sembrava vivo e scriveva sul file giusto, solo che era abbonato a
    opzioni scadute.
  - TWS che si riavvia la notte. `ConnectionError: Socket disconnect` usciva
    da `main()` e il processo moriva.
  - dati non ancora disponibili all'avvio. Ogni "CRITICAL: ..." era un
    `return`, cioe' una morte definitiva: il poller IV riavviato alle 08:27
    non trovava il prezzo SPX (il cash apre alle 15:30) e chiudeva li'.

Qui la sessione diventa una cosa che finisce: quando il giorno cambia il
poller esce dal suo giro, e questo modulo lo rifa' partire da capo, con una
connessione nuova e la catena del giorno nuovo.
"""

import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo('America/New_York')

# Connessione della sessione in corso, da chiudere prima di aprirne un'altra:
# senza questo TWS si ritrova un client fantasma per ogni tentativo.
_connessione = None


def giorno_corrente() -> str:
    return datetime.now().strftime('%Y-%m-%d')


def minuti_locali_da_ny(ore: int, minuti: int) -> int:
    """Un orario di New York di oggi, in minuti da mezzanotte sull'ora di questo PC.

    Gli orari del cash (apertura 9:30, range alle 9:35, chiusura 16:00) sono
    di New York, e Italia e Stati Uniti non cambiano ora lo stesso giorno: fra
    l'ultima domenica di ottobre e la prima di novembre (e due-tre settimane
    a marzo) il cash apre alle 14:30 italiane e non alle 15:30. Scritti fissi
    in ora italiana, quei giorni la finestra e il range erano un'ora avanti.
    """
    oggi = datetime.now(NEW_YORK)
    ny = oggi.replace(hour=ore, minute=minuti, second=0, microsecond=0)
    locale = ny.astimezone()
    return locale.hour * 60 + locale.minute


# Codici che TWS manda a ogni connessione per dire che va tutto bene: se si
# stampassero, il log sarebbe pieno di righe che non vogliono dire niente.
_INNOCUI = {
    1100, 1101, 1102,        # connessione persa e ripresa
    2104, 2106, 2107, 2108,  # "market data farm connection is OK"
    2119, 2158,              # "sec-def data farm connection is OK"
    2100, 2103, 2105, 2157,  # farm scollegate: le riprende da sola
}


def _stampa_errore(reqId, code, msg, contract) -> None:
    if code in _INNOCUI:
        return
    dettaglio = ''
    if contract is not None:
        strike = getattr(contract, 'strike', None)
        right = getattr(contract, 'right', None)
        if strike:
            dettaglio = f' [{getattr(contract, "symbol", "?")} {strike} {right}]'
    print(f'IBKR errore {code} (req {reqId}): {msg}{dettaglio}', file=sys.stderr)


def registra_connessione(ib) -> None:
    """
    Affida la connessione al modulo, che la chiude a fine sessione, e le
    attacca un ascoltatore per gli errori.

    Senza l'ascoltatore ib_insync manda gli errori al logging di Python, che
    qui non e' configurato: finivano nel nulla. Il 21/08/2026 il poller dei
    volumi ha raccolto per ore volumi a zero su una decina di strike contigui
    -- il gamma arrivava, le quotazioni no -- e non c'era una sola riga di log
    da cui capire cosa TWS avesse risposto. Meglio qualche riga di troppo che
    diagnosi fatte a indovinare.
    """
    global _connessione
    _connessione = ib
    try:
        ib.errorEvent += _stampa_errore
    except Exception as e:
        print(f'[poller] impossibile ascoltare gli errori IBKR: {e}', file=sys.stderr)


def _chiudi_connessione() -> None:
    global _connessione
    if _connessione is None:
        return
    try:
        if _connessione.isConnected():
            _connessione.disconnect()
    except Exception:
        pass
    _connessione = None


def esegui_a_oltranza(sessione, nome: str, pausa: int = 30) -> None:
    """
    Chiama `sessione` per sempre: quando ritorna (giorno cambiato, dati non
    pronti) o solleva (TWS caduto) si aspetta `pausa` secondi e si ricomincia.

    L'unica uscita e' KeyboardInterrupt, cioe' qualcuno che ferma il processo.
    """
    while True:
        inizio = giorno_corrente()
        try:
            sessione()
            motivo = 'sessione conclusa'
        except KeyboardInterrupt:
            _chiudi_connessione()
            raise
        except Exception as e:
            motivo = f'{type(e).__name__}: {e}'
            print(f"[{nome}] sessione interrotta -> {motivo}", file=sys.stderr)

        _chiudi_connessione()

        if giorno_corrente() != inizio:
            print(f"[{nome}] giorno cambiato ({inizio} -> {giorno_corrente()}): "
                  f"nuova sessione con la catena di oggi")

        print(f"[{nome}] {motivo}, si riparte fra {pausa}s", flush=True)
        time.sleep(pausa)
