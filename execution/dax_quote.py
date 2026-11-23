"""
Quote DAX da IBKR per la pagina /dax (strategia put su ODAX).

    python execution/dax_quote.py '{"gambe":[{"tipo":"P","strike":25000,"scadenza":"2027-03-19"}], "classeFuture":"FDXM"}'

Stampa un solo JSON su stdout (anche per gli errori, nel campo `errore`):
indice DAX (last/close), future DAX piu' vicino della classe chiesta
(FDAX 25 EUR, FDXM 5 EUR, FDXS 1 EUR), e per ogni opzione bid/ask/mid, IV e
greche del modello IBKR. Aggiunge le scadenze ODAX quotate (per scegliere
quella a ~90 giorni).

Non e' un poller: si collega, legge e chiude. Poche linee alla volta, perche'
i poller ne tengono gia' ~90 delle ~100 disponibili.
"""

import json
import math
import random
import sys
from datetime import date

from ib_insync import IB, Future, Index, Option

ATTESA_QUOTE_S = 6.0
BLOCCO = 6
TIPI_DATI = {1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen'}


def valido(v) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def positivo(v) -> bool:
    return valido(v) and v > 0


def tondo(v, cifre=2):
    return round(v, cifre) if valido(v) else None


def leggi(ib: IB, contratti: list, opzioni: bool = False) -> list:
    """Apre le linee, aspetta le quote (al massimo ATTESA_QUOTE_S) e le richiude."""
    tickers = [ib.reqMktData(c, '', False, False) for c in contratti]
    atteso = 0.0
    while atteso < ATTESA_QUOTE_S:
        ib.sleep(0.25)
        atteso += 0.25
        pronte = all((positivo(t.bid) and positivo(t.ask)) or positivo(t.last) for t in tickers)
        if pronte and (not opzioni or all(t.modelGreeks for t in tickers)):
            break
    for c in contratti:
        ib.cancelMktData(c)
    return tickers


def base(t) -> dict:
    return {
        'bid': tondo(t.bid) if positivo(t.bid) else None,
        'ask': tondo(t.ask) if positivo(t.ask) else None,
        'last': tondo(t.last) if positivo(t.last) else None,
        'close': tondo(t.close) if positivo(t.close) else None,
        'tipoDati': TIPI_DATI.get(t.marketDataType, str(t.marketDataType)),
    }


def future_vicino(ib: IB, classe: str):
    filtro = Future(symbol='DAX', exchange='EUREX', currency='EUR', tradingClass=classe)
    dettagli = ib.reqContractDetails(filtro)
    oggi = date.today().strftime('%Y%m%d')
    vivi = sorted((d.contract for d in dettagli if d.contract.lastTradeDateOrContractMonth >= oggi),
                  key=lambda c: c.lastTradeDateOrContractMonth)
    return vivi[0] if vivi else None


def quota_opzioni(ib: IB, gambe: list) -> list:
    contratti, out = [], []
    for g in gambe:
        scad = str(g.get('scadenza', '')).replace('-', '')
        c = Option('DAX', scad, float(g['strike']), g['tipo'], 'EUREX',
                   multiplier='5', currency='EUR', tradingClass='ODAX')
        contratti.append(c)
    qualificati = ib.qualifyContracts(*contratti)
    trovati = {(c.lastTradeDateOrContractMonth[:8], c.strike, c.right) for c in qualificati}

    vivi = [c for c in contratti if c.conId]
    tickers = {}
    for i in range(0, len(vivi), BLOCCO):
        blocco = vivi[i:i + BLOCCO]
        for c, t in zip(blocco, leggi(ib, blocco, opzioni=True)):
            tickers[c.conId] = t

    for g, c in zip(gambe, contratti):
        riga = {'id': g.get('id'), 'tipo': g['tipo'], 'strike': g['strike'], 'scadenza': g.get('scadenza')}
        if not c.conId or (c.lastTradeDateOrContractMonth[:8], c.strike, c.right) not in trovati:
            out.append({**riga, 'errore': 'contratto non trovato'})
            continue
        t = tickers.get(c.conId)
        q = base(t)
        mid = (q['bid'] + q['ask']) / 2 if q['bid'] and q['ask'] else None
        g_mod = t.modelGreeks
        out.append({
            **riga, **q, 'mid': tondo(mid),
            'iv': tondo(g_mod.impliedVol * 100, 2) if g_mod and valido(g_mod.impliedVol) else None,
            'delta': tondo(g_mod.delta, 4) if g_mod and valido(g_mod.delta) else None,
            'gamma': tondo(g_mod.gamma, 6) if g_mod and valido(g_mod.gamma) else None,
            'theta': tondo(g_mod.theta, 3) if g_mod and valido(g_mod.theta) else None,
            'vega': tondo(g_mod.vega, 3) if g_mod and valido(g_mod.vega) else None,
        })
    return out


def calcola(ib: IB, richiesta: dict) -> dict:
    ib.reqMarketDataType(4)  # live dove c'e' l'abbonamento, altrimenti ritardato
    indice = Index('DAX', 'EUREX', 'EUR')
    if not ib.qualifyContracts(indice):
        return {'errore': 'Indice DAX non trovato su IBKR'}

    classe = richiesta.get('classeFuture') or 'FDXM'
    fut = future_vicino(ib, classe)
    contratti = [indice] + ([fut] if fut else [])
    t = leggi(ib, contratti)
    risultato = {'indice': base(t[0])}
    if fut:
        risultato['future'] = {**base(t[1]), 'classe': classe,
                               'scadenza': fut.lastTradeDateOrContractMonth}

    try:
        catene = ib.reqSecDefOptParams('DAX', '', 'IND', indice.conId)
        odax = next((c for c in catene if c.tradingClass == 'ODAX' and c.exchange == 'EUREX'), None)
        if odax:
            risultato['scadenze'] = sorted(odax.expirations)
            risultato['strikeMin'] = min(odax.strikes)
            risultato['strikeMax'] = max(odax.strikes)
    except Exception:
        pass

    # IV ATM della scadenza chiesta: put e call allo strike (multiplo di 50) piu' vicino all'indice
    scad_atm = str(richiesta.get('scadenzaAtm') or '')
    spot = t[0].last if positivo(t[0].last) else t[0].close
    if scad_atm and positivo(spot):
        k = round(spot / 50) * 50
        atm = quota_opzioni(ib, [{'id': 'atmP', 'tipo': 'P', 'strike': k, 'scadenza': scad_atm},
                                 {'id': 'atmC', 'tipo': 'C', 'strike': k, 'scadenza': scad_atm}])
        ivs = [a['iv'] for a in atm if a.get('iv')]
        risultato['atm'] = {'strike': k, 'scadenza': scad_atm, 'iv': tondo(sum(ivs) / len(ivs)) if ivs else None,
                            'put': atm[0].get('mid'), 'call': atm[1].get('mid')}

    gambe = [g for g in richiesta.get('gambe', []) if g.get('tipo') in ('C', 'P')]
    risultato['gambe'] = quota_opzioni(ib, gambe) if gambe else []
    return risultato


def main() -> None:
    try:
        richiesta = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except json.JSONDecodeError:
        print(json.dumps({'errore': 'JSON non valido'}))
        return

    ib = IB()
    try:
        # Fascia propria: poller 1000-9999, studi 20000-29999, scanner 30000-39999.
        ib.connect('127.0.0.1', 7496, clientId=random.randint(40000, 49999), timeout=10, readonly=True)
        risultato = calcola(ib, richiesta)
    except Exception as e:
        risultato = {'errore': f'IBKR: {e or type(e).__name__}'}
    finally:
        ib.disconnect()
    print(json.dumps(risultato))


if __name__ == '__main__':
    main()
