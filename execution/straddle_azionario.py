"""
Straddle ATM di un'azione sulle 3 scadenze piu' vicine, da IBKR.

    python execution/straddle_azionario.py AAPL

Stampa un solo JSON su stdout (anche per gli errori, nel campo `errore`): lo
legge /api/straddle-azionario, che salva la riga mostrata dalla pagina
/straddle-azionario.

Non e' un poller: si collega, legge e chiude. Le linee di market data si
aprono poche alla volta (1 per il sottostante, poi 2 per scadenza), perche' i
poller ne tengono gia' ~90 delle ~100 disponibili.
"""

import json
import math
import random
import sys
from datetime import date, datetime
from zoneinfo import ZoneInfo

from ib_insync import IB, Option, Stock

NEW_YORK = ZoneInfo('America/New_York')
N_SCADENZE = 3
ATTESA_QUOTE_S = 6.0
TIPI_DATI = {1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen'}


def valido(v) -> bool:
    return v is not None and not math.isnan(v) and v > 0


def prezzo(t) -> tuple[float | None, str]:
    """Mid se c'e' un bid/ask vero, altrimenti ultimo e chiusura, dichiarandolo."""
    if valido(t.bid) and valido(t.ask):
        return (t.bid + t.ask) / 2, 'mid'
    if valido(t.last):
        return t.last, 'last'
    if valido(t.close):
        return t.close, 'close'
    return None, 'nessuno'


def leggi(ib: IB, contratti: list) -> list:
    """Apre le linee, aspetta le quote (al massimo ATTESA_QUOTE_S) e le richiude."""
    tickers = [ib.reqMktData(c, '', False, False) for c in contratti]
    atteso = 0.0
    while atteso < ATTESA_QUOTE_S:
        ib.sleep(0.25)
        atteso += 0.25
        if all(valido(t.bid) and valido(t.ask) for t in tickers):
            break
    for c in contratti:
        ib.cancelMktData(c)
    return tickers


def catena_principale(ib: IB, azione: Stock):
    """La catena SMART standard: scarta le classi rettificate (2AAPL, ...)."""
    catene = [c for c in ib.reqSecDefOptParams(azione.symbol, '', azione.secType, azione.conId)
              if c.exchange == 'SMART' and c.multiplier == '100']
    if not catene:
        return None
    for c in catene:
        if c.tradingClass == azione.symbol:
            return c
    return max(catene, key=lambda c: len(c.expirations))


def ciclo_scadenze(scadenze, ora_ny: datetime) -> str:
    """Che scadenze ha il titolo, dalla distanza fra le prime quotate.

    La piu' breve delle prime due: le catene quotano fitto vicino e rado
    lontano (BCE: 28, 28, 63, 90 giorni), e una settimanale spostata al
    giovedi' da una festivita' fa 6 + 8 giorni, quindi resta settimanale.
    """
    oggi = ora_ny.strftime('%Y%m%d')
    vive = sorted(s for s in scadenze if s >= oggi)
    giorni = [date(int(s[:4]), int(s[4:6]), int(s[6:8])) for s in vive]
    distanze = [(b - a).days for a, b in zip(giorni, giorni[1:])][:2]
    if not distanze:
        return 'una sola scadenza quotata'
    tipica = min(distanze)
    if tipica <= 3:
        return 'piu\' volte a settimana'
    if tipica <= 8:
        return 'settimanale'
    mesi = max(1, round(tipica / 30.4))
    return {1: 'mensile', 3: 'trimestrale'}.get(mesi, f'ogni {mesi} mesi')


def prossime_scadenze(scadenze, ora_ny: datetime) -> list[str]:
    """Le piu' vicine ancora vive: quella di oggi vale solo fino alle 16:00 NY."""
    oggi = ora_ny.strftime('%Y%m%d')
    aperto = (ora_ny.hour, ora_ny.minute) < (16, 0)
    return sorted(s for s in scadenze if s > oggi or (s == oggi and aperto))[:N_SCADENZE]


def strike_atm(ib: IB, simbolo: str, scadenza: str, classe: str, spot: float):
    """Lo strike piu' vicino allo spot che in QUESTA scadenza esiste sia call sia put.

    reqSecDefOptParams da' l'unione degli strike di tutte le scadenze: una
    settimanale puo' non averne molti, quindi si chiedono i contratti veri.
    """
    lati = {}
    for lato in ('C', 'P'):
        filtro = Option(symbol=simbolo, lastTradeDateOrContractMonth=scadenza, right=lato,
                        exchange='SMART', currency='USD', tradingClass=classe)
        lati[lato] = {d.contract.strike: d.contract for d in ib.reqContractDetails(filtro)
                      if d.contract.multiplier == '100'}
    comuni = set(lati['C']) & set(lati['P'])
    if not comuni:
        return None, None, None, lati
    strike = min(comuni, key=lambda k: (abs(k - spot), k))
    return strike, lati['C'][strike], lati['P'][strike], lati


# Come L1/L2/L3 della pagina: spot -/+ straddle per questo moltiplicatore.
LIVELLI = (('L1', 1 / math.sqrt(3)), ('L2', 1.0), ('L3', math.sqrt(3)))


def opzioni_sui_livelli(ib: IB, lati: dict, spot: float, straddle: float) -> list[dict]:
    """Put allo strike piu' vicino al livello inferiore, call a quello superiore.

    Prezzo = BID (quanto si incassa vendendo), 0 dove non e' quotato: niente
    ripiego su mid/last/close, a differenza dello straddle. Due linee alla
    volta (una coppia per livello).
    """
    out = []
    for nome, molt in LIVELLI:
        giu, su = spot - straddle * molt, spot + straddle * molt
        k_put = min(lati['P'], key=lambda k: (abs(k - giu), k))
        k_call = min(lati['C'], key=lambda k: (abs(k - su), -k))
        t_put, t_call = leggi(ib, [lati['P'][k_put], lati['C'][k_call]])
        bid_put = quota(t_put.bid) or 0.0
        bid_call = quota(t_call.bid) or 0.0
        out.append({'nome': nome, 'strikePut': k_put, 'put': bid_put, 'fontePut': 'bid',
                    'strikeCall': k_call, 'call': bid_call, 'fonteCall': 'bid'})
    return out


def tondo(v, cifre=2):
    return None if v is None else round(v, cifre)


def quota(v):
    return tondo(v) if valido(v) else None


def calcola_scadenza(ib: IB, simbolo: str, scadenza: str, classe: str, spot: float, ora_ny: datetime) -> dict:
    giorno = date(int(scadenza[:4]), int(scadenza[4:6]), int(scadenza[6:8]))
    riga = {'scadenza': giorno.isoformat(), 'dte': (giorno - ora_ny.date()).days}

    strike, call, put, lati = strike_atm(ib, simbolo, scadenza, classe, spot)
    if strike is None:
        return {**riga, 'errore': 'nessuno strike con call e put'}

    t_call, t_put = leggi(ib, [call, put])
    p_call, fonte_call = prezzo(t_call)
    p_put, fonte_put = prezzo(t_put)
    riga.update({
        'strike': strike,
        'callBid': quota(t_call.bid), 'callAsk': quota(t_call.ask),
        'putBid': quota(t_put.bid), 'putAsk': quota(t_put.ask),
        'call': tondo(p_call), 'put': tondo(p_put),
        'fonteCall': fonte_call, 'fontePut': fonte_put,
        'tipoDati': TIPI_DATI.get(t_call.marketDataType, str(t_call.marketDataType)),
    })
    if p_call is None or p_put is None:
        return {**riga, 'errore': 'nessun prezzo da IBKR'}

    straddle = p_call + p_put
    return {
        **riga,
        'straddle': tondo(straddle),
        'pct': tondo(straddle / spot * 100),
        'breakevenGiu': tondo(strike - straddle),
        'breakevenSu': tondo(strike + straddle),
        'livelli': opzioni_sui_livelli(ib, lati, spot, straddle),
    }


def calcola(ib: IB, simbolo: str) -> dict:
    azione = Stock(simbolo, 'SMART', 'USD')
    if not ib.qualifyContracts(azione):
        return {'errore': f'Ticker {simbolo} non trovato su IBKR'}

    # Con il tipo 4 IBKR da' il live dove c'e' l'abbonamento, altrimenti il
    # ritardato: ogni scadenza dichiara quale ha ricevuto.
    ib.reqMarketDataType(4)
    t_azione = leggi(ib, [azione])[0]
    spot, fonte_spot = prezzo(t_azione)
    if spot is None:
        return {'errore': f'Nessun prezzo per {simbolo} da IBKR'}

    catena = catena_principale(ib, azione)
    if catena is None:
        return {'errore': f'Nessuna catena di opzioni per {simbolo}'}

    ora_ny = datetime.now(NEW_YORK)
    scadenze = prossime_scadenze(catena.expirations, ora_ny)
    if not scadenze:
        return {'errore': f'Nessuna scadenza viva per {simbolo}'}

    return {
        'ticker': simbolo,
        'ora': datetime.now().astimezone().isoformat(timespec='seconds'),
        'spot': tondo(spot),
        'fonteSpot': fonte_spot,
        'tipoDatiSpot': TIPI_DATI.get(t_azione.marketDataType, str(t_azione.marketDataType)),
        'ciclo': ciclo_scadenze(catena.expirations, ora_ny),
        'scadenze': [calcola_scadenza(ib, simbolo, s, catena.tradingClass, spot, ora_ny) for s in scadenze],
    }


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({'errore': 'Uso: straddle_azionario.py TICKER'}))
        return
    simbolo = sys.argv[1].strip().upper().replace('.', ' ')

    ib = IB()
    try:
        # Fascia propria: poller 1000-9999, studi 20000-29999, scanner 30000-39999.
        ib.connect('127.0.0.1', 7496, clientId=random.randint(40000, 49999), timeout=10, readonly=True)
        risultato = calcola(ib, simbolo)
    except Exception as e:
        risultato = {'errore': f'IBKR: {e or type(e).__name__}'}
    finally:
        ib.disconnect()
    print(json.dumps(risultato))


if __name__ == '__main__':
    main()
