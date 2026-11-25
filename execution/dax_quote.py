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
BLOCCO = 8
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


def spot_stimato(t_idx, t_fut) -> tuple[float | None, str]:
    """Indice DAX: se IBKR lo da' ritardato e il future e' live, future - base di ieri."""
    idx = t_idx.last if positivo(t_idx.last) else t_idx.close
    ritardato = t_idx.marketDataType in (3, 4)
    if t_fut is not None and ritardato and t_fut.marketDataType == 1:
        fut = t_fut.last if positivo(t_fut.last) else ((t_fut.bid + t_fut.ask) / 2 if positivo(t_fut.bid) and positivo(t_fut.ask) else None)
        if fut and positivo(t_fut.close) and positivo(t_idx.close):
            return fut - (t_fut.close - t_idx.close), 'future - base di ieri'
    return (idx, 'indice ritardato' if ritardato else 'indice') if positivo(idx) else (None, 'nessuno')


def trimestrale(s: str) -> bool:
    """Terzo venerdi' di marzo/giugno/settembre/dicembre (le scadenze del video)."""
    d = date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    return d.month in (3, 6, 9, 12) and d.weekday() == 4 and 15 <= d.day <= 21


# Zone degli strike in frazione dello spot e passo, come le gambe della strategia (lezione 18/11/2026):
# V1 largo 500 a ~-3,5/-7% (comprata e venduta), V2 comprata a ~-13/-20%, put vendute a ~-35/-44% (e 200 sotto).
ZONE = ((0.90, 0.97, 250), (0.80, 0.87, 250), (0.55, 0.66, 200))
# V2 largo 1000-1500 (1300 nell'ultima versione, 21500/20200): le vendute del V2 sono comprata - larghezza, anche fuori dal passo 250.
LARGHEZZE_V2 = (1000, 1300, 1500)


def catena(ib: IB, richiesta: dict) -> dict:
    """Put delle scadenze trimestrali tra dteMin e dteMax, sugli strike delle tre zone, piu' l'ATM."""
    ib.reqMarketDataType(4)
    indice = Index('DAX', 'EUREX', 'EUR')
    if not ib.qualifyContracts(indice):
        return {'errore': 'Indice DAX non trovato su IBKR'}
    fut = future_vicino(ib, richiesta.get('classeFuture') or 'FDXM')
    t = leggi(ib, [indice] + ([fut] if fut else []))
    spot, fonte = spot_stimato(t[0], t[1] if fut else None)
    if not spot:
        return {'errore': 'Nessun prezzo per il DAX'}

    catene = ib.reqSecDefOptParams('DAX', '', 'IND', indice.conId)
    odax = next((c for c in catene if c.tradingClass == 'ODAX' and c.exchange == 'EUREX'), None)
    if not odax:
        return {'errore': 'Catena ODAX non trovata'}
    oggi = date.today()
    dte_min, dte_max = int(richiesta.get('dteMin', 70)), int(richiesta.get('dteMax', 150))
    scadenze = []
    for s in sorted(odax.expirations):
        dte = (date(int(s[:4]), int(s[4:6]), int(s[6:8])) - oggi).days
        if trimestrale(s) and dte_min <= dte <= dte_max:
            scadenze.append((s, dte))
    scadenze = scadenze[:2]
    if not scadenze:
        return {'errore': f'Nessuna scadenza trimestrale tra {dte_min} e {dte_max} giorni'}

    strike_disp = set(odax.strikes)
    out = []
    for s, dte in scadenze:
        iso = f'{s[:4]}-{s[4:6]}-{s[6:8]}'
        ks = set()
        for lo, hi, passo in ZONE:
            k = int(spot * lo // passo * passo)
            while k <= spot * hi:
                if k in strike_disp and k >= spot * lo:
                    ks.add(k)
                k += passo
        lo_v2, hi_v2 = ZONE[1][0], ZONE[1][1]
        for k3 in [k for k in ks if spot * lo_v2 <= k <= spot * hi_v2]:
            ks.update(k3 - w for w in LARGHEZZE_V2 if k3 - w in strike_disp)
        # ATM per la parita' sul passo 100 (24950/24975 non esistono su tutte le scadenze, la parita' saltava)
        k_atm = round(spot / 100) * 100
        richieste = [{'id': f'P{k}', 'tipo': 'P', 'strike': k, 'scadenza': iso} for k in sorted(ks)]
        richieste += [{'id': 'atmP', 'tipo': 'P', 'strike': k_atm, 'scadenza': iso},
                      {'id': 'atmC', 'tipo': 'C', 'strike': k_atm, 'scadenza': iso}]
        quote = {q['id']: q for q in quota_opzioni(ib, richieste)}
        put = [{k: q.get(k) for k in ('strike', 'bid', 'ask', 'mid', 'iv', 'delta')}
               for i, q in quote.items() if i.startswith('P') and not q.get('errore') and (q.get('bid') or q.get('mid'))]
        a_p, a_c = quote.get('atmP', {}), quote.get('atmC', {})
        ivs = [x['iv'] for x in (a_p, a_c) if x.get('iv')]
        out.append({'scadenza': iso, 'dte': dte, 'put': put,
                    'atm': {'strike': k_atm, 'put': a_p.get('mid'), 'call': a_c.get('mid'),
                            'iv': tondo(sum(ivs) / len(ivs)) if ivs else None}})
    return {'spot': tondo(spot), 'fonteSpot': fonte, 'future': base(t[1]) if fut else None,
            'indiceIbkr': base(t[0]), 'catene': out}


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
        risultato = catena(ib, richiesta) if richiesta.get('modo') == 'catena' else calcola(ib, richiesta)
    except Exception as e:
        risultato = {'errore': f'IBKR: {e or type(e).__name__}'}
    finally:
        ib.disconnect()
    print(json.dumps(risultato))


if __name__ == '__main__':
    main()
