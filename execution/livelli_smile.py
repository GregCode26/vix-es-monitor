"""
Curva di volatilita' implicita di oggi (smile) di un'azione, 1a e 2a scadenza.

    python execution/livelli_smile.py AAPL

Stampa un solo JSON su stdout (anche per gli errori, nel campo `errore`).

Per ogni scadenza: fino a STRIKE_MAX strike entro +/-RAGGIO dallo spot, i piu'
vicini; sotto lo spot la put, sopra la call (le OTM, che sono le liquide e le
usano gli smile standard). IV = quella del MODELLO IBKR (modelGreeks), su
richiesta dell'utente (10/11/2026); solo dove manca si ricava dal mid con
Black-Scholes europeo (tasso TASSO, niente dividendi), dichiarandolo.

Linee di market data: LOTTO alla volta, poi chiuse (i poller ne tengono ~90).
"""

import json
import math
import random
import sys
from datetime import date, datetime

from ib_insync import IB, Option, Stock

from straddle_azionario import NEW_YORK, catena_principale, leggi, prezzo, prossime_scadenze, valido

STRIKE_MAX = 16
RAGGIO = 0.25
LOTTO = 4
TASSO = 0.04


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(spot, k, t, iv, lato):
    s = iv * math.sqrt(t)
    d1 = (math.log(spot / k) + (TASSO + 0.5 * iv * iv) * t) / s
    d2 = d1 - s
    if lato == 'C':
        return spot * phi(d1) - k * math.exp(-TASSO * t) * phi(d2)
    return k * math.exp(-TASSO * t) * phi(-d2) - spot * phi(-d1)


def iv_da_prezzo(p, spot, k, t, lato):
    """Bisezione fra 1% e 500%; None se il prezzo e' sotto il valore intrinseco o fuori scala."""
    if bs(spot, k, t, 0.01, lato) > p or bs(spot, k, t, 5.0, lato) < p:
        return None
    lo, hi = 0.01, 5.0
    for _ in range(60):
        m = (lo + hi) / 2
        if bs(spot, k, t, m, lato) > p:
            hi = m
        else:
            lo = m
    return (lo + hi) / 2


ATTESA_MODELLO_S = 10.0


def leggi_con_modello(ib: IB, contratti: list) -> list:
    """Come `leggi` di straddle_azionario, ma aspetta l'IV del MODELLO (non il bid/ask):
    fuori orario IBKR la manda in ritardo, e dopo 6 s spesso non era ancora arrivata."""
    tickers = [ib.reqMktData(c, '106', False, False) for c in contratti]
    atteso = 0.0
    while atteso < ATTESA_MODELLO_S:
        ib.sleep(0.25)
        atteso += 0.25
        if all(t.modelGreeks and valido(t.modelGreeks.impliedVol) for t in tickers):
            break
    for c in contratti:
        ib.cancelMktData(c)
    return tickers


def anni_alla_scadenza(scadenza: str, ora_ny: datetime) -> float:
    fine = datetime(int(scadenza[:4]), int(scadenza[4:6]), int(scadenza[6:8]), 16, 0, tzinfo=NEW_YORK)
    return max((fine - ora_ny).total_seconds(), 3600) / (365 * 24 * 3600)


def curva(ib: IB, simbolo: str, scadenza: str, classe: str, spot: float, ora_ny: datetime) -> dict:
    lati = {}
    for lato in ('C', 'P'):
        filtro = Option(symbol=simbolo, lastTradeDateOrContractMonth=scadenza, right=lato,
                        exchange='SMART', currency='USD', tradingClass=classe)
        lati[lato] = {d.contract.strike: d.contract for d in ib.reqContractDetails(filtro)
                      if d.contract.multiplier == '100'}
    strike = sorted(k for k in set(lati['C']) | set(lati['P']) if abs(k / spot - 1) <= RAGGIO)
    strike = sorted(sorted(strike, key=lambda k: abs(k - spot))[:STRIKE_MAX])
    # OTM: put sotto lo spot, call sopra (allo strike dello spot entrambe, e si fa la media).
    voci = []
    for k in strike:
        for lato in ('P', 'C'):
            if k in lati[lato] and ((lato == 'P' and k <= spot) or (lato == 'C' and k >= spot)):
                voci.append((k, lato, lati[lato][k]))
    t = anni_alla_scadenza(scadenza, ora_ny)
    letti = []
    for i in range(0, len(voci), LOTTO):
        lotto = voci[i:i + LOTTO]
        for (k, lato, _), tk in zip(lotto, leggi_con_modello(ib, [c for _, _, c in lotto])):
            p, fonte_p = prezzo(tk)
            iv, fonte = None, 'modello IBKR'
            if tk.modelGreeks and valido(tk.modelGreeks.impliedVol):
                iv = tk.modelGreeks.impliedVol
            elif p is not None and fonte_p == 'mid':
                iv, fonte = iv_da_prezzo(p, spot, k, t, lato), 'dal mid'
            letti.append({'strike': k, 'lato': lato, 'iv': round(iv * 100, 2) if iv else None,
                          'mid': round(p, 2) if p else None, 'fonte': fonte})
    # Uno strike con put e call (quello dello spot): la media delle due.
    per_strike = {}
    for x in letti:
        if x['iv'] is None:
            continue
        per_strike.setdefault(x['strike'], []).append(x)
    punti = [{'strike': k, 'iv': round(sum(y['iv'] for y in v) / len(v), 2), 'lato': '+'.join(y['lato'] for y in v),
              'fonte': ', '.join(sorted({y['fonte'] for y in v}))} for k, v in sorted(per_strike.items())]
    giorno = date(int(scadenza[:4]), int(scadenza[4:6]), int(scadenza[6:8]))
    return {'scadenza': giorno.isoformat(), 'dte': (giorno - ora_ny.date()).days, 'punti': punti,
            'mancanti': sum(1 for x in letti if x['iv'] is None)}


def calcola(ib: IB, simbolo: str) -> dict:
    azione = Stock(simbolo, 'SMART', 'USD')
    if not ib.qualifyContracts(azione):
        return {'errore': f'Ticker {simbolo} non trovato su IBKR'}
    ib.reqMarketDataType(4)
    spot, _ = prezzo(leggi(ib, [azione])[0])
    if spot is None:
        return {'errore': f'Nessun prezzo per {simbolo} da IBKR'}
    catena = catena_principale(ib, azione)
    if catena is None:
        return {'errore': f'Nessuna catena di opzioni per {simbolo}'}
    ora_ny = datetime.now(NEW_YORK)
    scadenze = prossime_scadenze(catena.expirations, ora_ny)[:2]
    if not scadenze:
        return {'errore': f'Nessuna scadenza viva per {simbolo}'}
    return {
        'ticker': simbolo, 'spot': round(spot, 2),
        'ora': datetime.now().astimezone().isoformat(timespec='seconds'),
        'curve': [curva(ib, simbolo, s, catena.tradingClass, spot, ora_ny) for s in scadenze],
    }


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({'errore': 'Uso: livelli_smile.py TICKER'}))
        return
    simbolo = sys.argv[1].strip().upper().replace('.', ' ')
    ib = IB()
    try:
        ib.connect('127.0.0.1', 7496, clientId=random.randint(40000, 49999), timeout=10, readonly=True)
        risultato = calcola(ib, simbolo)
    except Exception as e:
        risultato = {'errore': f'IBKR: {e or type(e).__name__}'}
    finally:
        ib.disconnect()
    print(json.dumps(risultato))


if __name__ == '__main__':
    main()
