"""Studio storico della strategia DAX (put spread finanziati da put vendute lontane).

--piano    stampa le richieste IBKR che servono (nessuna connessione)
--scarica  scarica DAX, VDAX-NEW e VSTOXX giornalieri (poche richieste, a ritmo)
(default)  simula la strategia e le varianti di rischio sui dati in cache

Le opzioni ODAX scadute non esistono su IBKR: i prezzi sono ricostruiti con Black-76
dalla IV ATM (VDAX-NEW) e da uno skew tarato sulla catena reale del 24/11/2026.
"""
import json, math, os, random, sys, time
from datetime import date, datetime, timedelta

QUI = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(QUI, '..', '.tmp', 'studio_dax_strategia')
os.makedirs(CACHE, exist_ok=True)

# simbolo cache -> (symbol, exchange)
SERIE = {'DAX': ('DAX', 'EUREX'), 'VDAX': ('V1X', 'EUREX'), 'VSTOXX': ('V2TX', 'EUREX')}
DURATA = '30 Y'
GAP_MIN = 3.0


def piano():
    mancano = [s for s in SERIE if not os.path.exists(os.path.join(CACHE, f'{s}.json'))]
    print('Piano richieste IBKR (storico giornaliero, TRADES, solo orario regolare):')
    for s in SERIE:
        sym, ex = SERIE[s]
        stato = 'da scaricare' if s in mancano else 'in cache'
        print(f'  {s:7s} IND {sym}@{ex}  durata {DURATA}  barre 1 giorno  -> {stato}')
    print(f'Totale: {len(mancano)} richieste (+ al massimo {len(mancano)} di ripiego con whatToShow=MIDPOINT/durata minore), '
          f'almeno {GAP_MIN:.0f} s fra una e l\'altra: molto sotto il limite di 50 ogni 10 minuti.')
    return mancano


def scarica():
    from ib_insync import IB, Index, util
    mancano = piano()
    if not mancano:
        return
    ib = IB()
    ib.connect('127.0.0.1', 7496, clientId=random.randint(30000, 39999), timeout=15, readonly=True)
    try:
        for s in mancano:
            sym, ex = SERIE[s]
            c = Index(sym, ex, 'EUR')
            ib.qualifyContracts(c)
            barre = None
            for wts, dur in (('TRADES', DURATA), ('TRADES', '20 Y'), ('MIDPOINT', '20 Y')):
                time.sleep(GAP_MIN)
                try:
                    barre = ib.reqHistoricalData(c, '', dur, '1 day', wts, useRTH=True, formatDate=1, timeout=120)
                except Exception as e:  # noqa
                    print('  errore', s, wts, dur, e)
                if barre:
                    break
            if not barre:
                print(f'  {s}: nessun dato')
                continue
            righe = [[b.date.isoformat(), b.open, b.high, b.low, b.close] for b in barre]
            json.dump(righe, open(os.path.join(CACHE, f'{s}.json'), 'w'))
            print(f'  {s}: {len(righe)} barre, {righe[0][0]} -> {righe[-1][0]}')
    finally:
        ib.disconnect()


if __name__ == '__main__':
    if '--piano' in sys.argv:
        piano()
    elif '--scarica' in sys.argv:
        scarica()
    else:
        import studio_dax_simula
        studio_dax_simula.main(CACHE)
