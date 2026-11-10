"""
Candele giornaliere di un'azione da IBKR, per il grafico di /livelli-azionari.

    python execution/livelli_candele.py AAPL [anni]

Stampa un solo JSON su stdout (anche per gli errori, nel campo `errore`); il
piano delle richieste va su stderr. Una sola richiesta storica (TRADES, 1 day,
solo orario regolare), di `anni` anni (1 di base, massimo 5).
"""

import json
import random
import sys

from ib_insync import IB, Stock


def main() -> None:
    if len(sys.argv) not in (2, 3):
        print(json.dumps({'errore': 'Uso: livelli_candele.py TICKER [anni]'}))
        return
    simbolo = sys.argv[1].strip().upper().replace('.', ' ')
    anni = max(1, min(5, int(sys.argv[2]) if len(sys.argv) == 3 and sys.argv[2].isdigit() else 1))

    ib = IB()
    try:
        # Fascia propria: poller 1000-9999, studi 20000-29999, scanner 30000-39999.
        ib.connect('127.0.0.1', 7496, clientId=random.randint(40000, 49999), timeout=10, readonly=True)
        azione = Stock(simbolo, 'SMART', 'USD')
        if not ib.qualifyContracts(azione):
            risultato = {'errore': f'Ticker {simbolo} non trovato su IBKR'}
        else:
            print(f'PIANO: 1 richiesta storica, TRADES giornaliero, {anni} Y', file=sys.stderr)
            barre = ib.reqHistoricalData(azione, '', f'{anni} Y', '1 day', 'TRADES', True)
            if not barre:
                risultato = {'errore': f'Nessuno storico per {simbolo} da IBKR'}
            else:
                risultato = {
                    'ticker': simbolo,
                    'barre': [[b.date.isoformat(), b.open, b.high, b.low, b.close, int(b.volume)] for b in barre],
                }
    except Exception as e:
        risultato = {'errore': f'IBKR: {e or type(e).__name__}'}
    finally:
        ib.disconnect()
    print(json.dumps(risultato))


if __name__ == '__main__':
    main()
