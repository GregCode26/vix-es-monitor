"""
Vendita opzioni: per ogni azione in portafoglio, le put e le call a ~45 giorni
attorno a delta 0,20, con la IV di oggi rispetto al suo ultimo anno.

    python execution/vendita_opzioni.py            # i titoli in portafoglio
    python execution/vendita_opzioni.py MARA IREN  # solo questi

Scrive `frontend/data/vendita-opzioni/ultimo.json` alla fine e
`stato.json` durante il calcolo (titolo in corso, n/N), letti da
/api/vendita-opzioni e dalla pagina /vendita-opzioni. Sola lettura
(readonly=True): non manda ordini.

Linee di market data: i poller ne usano ~90 delle ~100, quindi si aprono al
massimo 10 linee alla volta (5 put + 5 call di una scadenza).

Richieste storiche: 2 per titolo (IV 30gg e volatilita' storica, 1 anno
giornaliero), a >= 3 s l'una dall'altra; il piano viene stampato su stderr
prima di partire.
"""

import json
import math
import random
import sys
import time
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ib_insync import IB, Option, Stock

NEW_YORK = ZoneInfo('America/New_York')
CARTELLA = Path(__file__).resolve().parent.parent / 'frontend' / 'data' / 'vendita-opzioni'
DTE_OBIETTIVO = 45
DTE_MIN, DTE_MAX = 25, 60
DELTA_OBIETTIVO = 0.20
DELTA_BANDA = (0.15, 0.30)
N_STRIKE = 5
ATTESA_QUOTE_S = 8.0
PAUSA_STORICO_S = 3.0
TIPI_DATI = {1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen'}
Z_DELTA_20 = 0.8416  # N^-1(0.80): strike a delta ~0,20 = spot * exp(-/+ z * sigma * sqrt(T))


def valido(v) -> bool:
    return v is not None and not math.isnan(v) and v > 0


def tondo(v, cifre=2):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(v, cifre)


def scrivi(nome: str, dati: dict) -> None:
    CARTELLA.mkdir(parents=True, exist_ok=True)
    tmp = CARTELLA / f'{nome}.tmp'
    tmp.write_text(json.dumps(dati, ensure_ascii=False), encoding='utf-8')
    tmp.replace(CARTELLA / f'{nome}.json')


class Ritmo:
    """Distanzia le richieste storiche (stessa idea di `Ritmo` in studio_vol.py)."""

    def __init__(self, pausa: float):
        self.pausa, self.ultimo = pausa, 0.0

    def aspetta(self, ib: IB) -> None:
        resto = self.pausa - (time.monotonic() - self.ultimo)
        if resto > 0:
            ib.sleep(resto)
        self.ultimo = time.monotonic()


def leggi(ib: IB, contratti: list, greche: bool = False) -> list:
    """Apre le linee, aspetta bid/ask (e le greche se servono), le richiude."""
    tickers = [ib.reqMktData(c, '', False, False) for c in contratti]
    atteso = 0.0
    while atteso < ATTESA_QUOTE_S:
        ib.sleep(0.25)
        atteso += 0.25
        pronti = all(valido(t.bid) and valido(t.ask) for t in tickers)
        if greche:
            pronti = pronti and all(t.modelGreeks and t.modelGreeks.delta is not None for t in tickers)
        if pronti:
            break
    for c in contratti:
        ib.cancelMktData(c)
    return tickers


def prezzo_azione(t) -> tuple[float | None, str]:
    if valido(t.bid) and valido(t.ask):
        return (t.bid + t.ask) / 2, 'mid'
    if valido(t.last):
        return t.last, 'last'
    if valido(t.close):
        return t.close, 'close'
    return None, 'nessuno'


def catena_principale(ib: IB, azione: Stock):
    catene = [c for c in ib.reqSecDefOptParams(azione.symbol, '', azione.secType, azione.conId)
              if c.exchange == 'SMART' and c.multiplier == '100']
    if not catene:
        return None
    for c in catene:
        if c.tradingClass == azione.symbol:
            return c
    return max(catene, key=lambda c: len(c.expirations))


def giorno(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def scegli_scadenza(scadenze, oggi: date) -> str | None:
    """La scadenza piu' vicina a 45 giorni fra 25 e 60; se non c'e', la piu' vicina a 45."""
    vive = [s for s in scadenze if giorno(s) > oggi]
    if not vive:
        return None
    dentro = [s for s in vive if DTE_MIN <= (giorno(s) - oggi).days <= DTE_MAX]
    return min(dentro or vive, key=lambda s: abs((giorno(s) - oggi).days - DTE_OBIETTIVO))


def storia_vol(ib: IB, azione: Stock, ritmo: Ritmo) -> dict:
    """IV 30gg di oggi, suo rank/percentile sull'anno, volatilita' storica 30gg."""
    out = {}
    ritmo.aspetta(ib)
    iv = [b.close for b in ib.reqHistoricalData(azione, '', '1 Y', '1 day', 'OPTION_IMPLIED_VOLATILITY', True)
          if valido(b.close)]
    if iv:
        oggi, lo, hi = iv[-1], min(iv), max(iv)
        out.update({
            'iv30': tondo(oggi * 100, 1),
            'ivMin': tondo(lo * 100, 1), 'ivMax': tondo(hi * 100, 1),
            'ivRank': tondo((oggi - lo) / (hi - lo) * 100 if hi > lo else None, 0),
            'ivPercentile': tondo(sum(v < oggi for v in iv) / len(iv) * 100, 0),
            'ivGiorni': len(iv),
        })
    ritmo.aspetta(ib)
    hv = [b.close for b in ib.reqHistoricalData(azione, '', '1 M', '1 day', 'HISTORICAL_VOLATILITY', True)
          if valido(b.close)]
    if hv:
        out['hv30'] = tondo(hv[-1] * 100, 1)
    return out


def contratti_lato(ib: IB, simbolo: str, scadenza: str, classe: str, lato: str) -> dict:
    filtro = Option(symbol=simbolo, lastTradeDateOrContractMonth=scadenza, right=lato,
                    exchange='SMART', currency='USD', tradingClass=classe)
    return {d.contract.strike: d.contract for d in ib.reqContractDetails(filtro)
            if d.contract.multiplier == '100'}


def strike_vicini(disponibili, obiettivo: float, spot: float, lato: str) -> list[float]:
    """I 5 strike OTM piu' vicini allo strike teorico a delta 0,20."""
    otm = [k for k in disponibili if (k < spot if lato == 'P' else k > spot)]
    return sorted(sorted(otm, key=lambda k: abs(k - obiettivo))[:N_STRIKE])


TASSO = 0.04


def _n(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(spot: float, k: float, anni: float, iv: float, lato: str) -> tuple[float, float, float, float]:
    """Black-Scholes senza dividendi: prezzo, |delta|, theta USD/giorno e vega per punto di IV, per azione."""
    rad = iv * math.sqrt(anni)
    d1 = (math.log(spot / k) + (TASSO + iv * iv / 2) * anni) / rad
    d2 = d1 - rad
    dens = math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi)
    sconto = k * math.exp(-TASSO * anni)
    if lato == 'P':
        prezzo, delta = sconto * _n(-d2) - spot * _n(-d1), 1 - _n(d1)
        theta = -spot * dens * iv / (2 * math.sqrt(anni)) + TASSO * sconto * _n(-d2)
    else:
        prezzo, delta = spot * _n(d1) - sconto * _n(d2), _n(d1)
        theta = -spot * dens * iv / (2 * math.sqrt(anni)) - TASSO * sconto * _n(d2)
    return prezzo, delta, abs(theta) / 365, spot * dens * math.sqrt(anni) / 100


def iv_da_prezzo(prezzo: float, spot: float, k: float, anni: float, lato: str) -> float | None:
    """IV implicita per bisezione (1%-500%); None se il prezzo e' sotto l'intrinseco o fuori scala."""
    lo, hi = 0.01, 5.0
    if not bs(spot, k, anni, lo, lato)[0] <= prezzo <= bs(spot, k, anni, hi, lato)[0]:
        return None
    for _ in range(60):
        mezzo = (lo + hi) / 2
        if bs(spot, k, anni, mezzo, lato)[0] < prezzo:
            lo = mezzo
        else:
            hi = mezzo
    return (lo + hi) / 2


def riga_opzione(t, lato: str, spot: float, dte: int) -> dict:
    """Prezzo = bid (si incassa quello). Senza bid/ask (cash chiusa) la chiusura di ieri,
    e allora delta/IV/theta/vega li ricalcola Black-Scholes da quel prezzo: fonte 'chiusura'."""
    k = t.contract.strike
    g = t.modelGreeks
    bid = t.bid if valido(t.bid) else None
    ask = t.ask if valido(t.ask) else None
    mid = (bid + ask) / 2 if bid and ask else None
    anni = max(dte, 1) / 365
    if bid:
        premio, fonte = bid, 'bid'
        delta = abs(g.delta) if g and g.delta is not None else None
        iv = g.impliedVol if g and g.impliedVol else None
        theta = abs(g.theta) if g and g.theta is not None else None
        vega = g.vega if g and g.vega is not None else None
    else:
        premio, fonte = (t.close, 'chiusura') if valido(t.close) else (None, 'nessuno')
        delta = iv = theta = vega = None
    if iv is None and premio:
        iv = iv_da_prezzo(premio, spot, k, anni, lato)
    if iv and delta is None:
        _, delta, theta, vega = bs(spot, k, anni, iv, lato)
    sigma = math.log(k / spot) / (iv * math.sqrt(anni)) if iv else None
    r = {
        'strike': k, 'bid': tondo(bid), 'ask': tondo(ask), 'mid': tondo(mid),
        'fonte': fonte, 'prezzo': tondo(premio),
        'delta': tondo(delta), 'iv': tondo(iv * 100, 1) if iv else None,
        'theta': tondo(theta * 100) if theta is not None else None,   # USD/giorno per contratto
        'vega': tondo(vega * 100) if vega is not None else None,      # USD per punto di IV, per contratto
        'distanzaPct': tondo((k / spot - 1) * 100, 1),
        'sigma': tondo(abs(sigma), 2) if sigma is not None else None,
        'spreadPct': tondo((ask - bid) / mid * 100, 0) if mid else None,
        'nellaBanda': delta is not None and DELTA_BANDA[0] <= delta <= DELTA_BANDA[1],
        'tipoDati': TIPI_DATI.get(t.marketDataType, str(t.marketDataType)),
    }
    if premio:
        r['premioContratto'] = tondo(premio * 100)
        if lato == 'P':
            r['pareggio'] = tondo(k - premio)
            r['contantiAssegnazione'] = tondo(k * 100)
            r['rendAnnuo'] = tondo(premio / k * 365 / dte * 100, 1) if dte > 0 else None
        else:
            r['pareggio'] = tondo(k + premio)
            r['rendAnnuo'] = tondo(premio / spot * 365 / dte * 100, 1) if dte > 0 else None
    return r


def analizza(ib: IB, simbolo: str, posizione: dict, ritmo: Ritmo) -> dict:
    azione = Stock(simbolo, 'SMART', 'USD')
    if not ib.qualifyContracts(azione):
        return {'ticker': simbolo, 'errore': 'ticker non trovato su IBKR'}

    t_az = leggi(ib, [azione])[0]
    spot, fonte_spot = prezzo_azione(t_az)
    if spot is None:
        return {'ticker': simbolo, 'errore': 'nessun prezzo'}

    out = {'ticker': simbolo, 'spot': tondo(spot), 'fonteSpot': fonte_spot, **posizione}
    out.update(storia_vol(ib, azione, ritmo))

    catena = catena_principale(ib, azione)
    if catena is None:
        return {**out, 'errore': 'nessuna catena di opzioni'}
    oggi = datetime.now(NEW_YORK).date()
    scadenza = scegli_scadenza(catena.expirations, oggi)
    if scadenza is None:
        return {**out, 'errore': 'nessuna scadenza viva'}
    dte = (giorno(scadenza) - oggi).days
    out.update({'scadenza': giorno(scadenza).isoformat(), 'dte': dte})

    # Strike teorico a delta 0,20 dalla IV 30gg (60% se manca), poi i 5 reali intorno.
    sig = (out.get('iv30') or 60) / 100 * math.sqrt(dte / 365)
    obiettivi = {'P': spot * math.exp(-Z_DELTA_20 * sig), 'C': spot * math.exp(Z_DELTA_20 * sig)}
    scelti = {}
    for lato in ('P', 'C'):
        disponibili = contratti_lato(ib, simbolo, scadenza, catena.tradingClass, lato)
        scelti[lato] = [disponibili[k] for k in strike_vicini(disponibili, obiettivi[lato], spot, lato)]

    tickers = leggi(ib, scelti['P'] + scelti['C'], greche=True)
    out['put'] = [riga_opzione(t, 'P', spot, dte) for t in tickers[:len(scelti['P'])]]
    out['call'] = [riga_opzione(t, 'C', spot, dte) for t in tickers[len(scelti['P']):]]
    for lato in ('put', 'call'):
        nella = [r for r in out[lato] if r['nellaBanda'] and r.get('premioContratto')]
        if nella:
            min(nella, key=lambda r: abs(r['delta'] - DELTA_OBIETTIVO))['consigliata'] = True
    return out


def posizioni(ib: IB) -> tuple[dict, dict]:
    """Per titolo: azioni, prezzo di carico, opzioni gia' vendute/comprate. Piu' il riepilogo conto."""
    per_titolo: dict = {}
    for p in ib.portfolio():
        c = p.contract
        if c.secType not in ('STK', 'OPT') or c.currency != 'USD':
            continue
        r = per_titolo.setdefault(c.symbol, {'azioni': 0, 'carico': None, 'opzioni': []})
        if c.secType == 'STK':
            r['azioni'] = p.position
            r['carico'] = tondo(p.averageCost)
        else:
            r['opzioni'].append({
                'lato': c.right, 'strike': c.strike, 'scadenza': giorno(c.lastTradeDateOrContractMonth).isoformat(),
                'quantita': p.position, 'prezzoMedio': tondo(p.averageCost / 100),
                'prezzo': tondo(p.marketPrice), 'pnl': tondo(p.unrealizedPNL),
            })
    for r in per_titolo.values():
        call_vendute = -sum(o['quantita'] for o in r['opzioni'] if o['lato'] == 'C' and o['quantita'] < 0)
        call_comprate = sum(o['quantita'] for o in r['opzioni'] if o['lato'] == 'C' and o['quantita'] > 0)
        # Le call comprate coprono call vendute (spread): restano scoperte solo quelle in piu'.
        r['callCoperteLibere'] = max(0, int(r['azioni'] // 100) - max(0, call_vendute - call_comprate))
        r['impegnoPut'] = tondo(sum(-o['quantita'] * o['strike'] * 100 for o in r['opzioni']
                                    if o['lato'] == 'P' and o['quantita'] < 0))

    conto = {}
    voci = {'NetLiquidation': 'valoreNetto', 'TotalCashValue': 'contanti', 'AvailableFunds': 'fondiDisponibili',
            'ExcessLiquidity': 'liquiditaEccesso', 'MaintMarginReq': 'margineMantenimento'}
    for v in ib.accountSummary():
        if v.tag in voci and v.currency:
            conto[voci[v.tag]] = tondo(float(v.value))
            conto['valuta'] = v.currency
    # Valore di 1 USD nella valuta del conto, per confrontare impegni in USD con fondi in EUR.
    for v in ib.accountValues():
        if v.tag == 'ExchangeRate' and v.currency == 'USD' and valido(float(v.value or 0)):
            conto['usdInBase'] = float(v.value)
    conto['impegnoPutTotale'] =tondo(sum(r['impegnoPut'] or 0 for r in per_titolo.values()))
    return per_titolo, conto


def main() -> None:
    richiesti = [a.strip().upper() for a in sys.argv[1:] if a.strip()]
    ib = IB()
    inizio = datetime.now().astimezone().isoformat(timespec='seconds')
    try:
        # Fascia propria degli strumenti a richiesta: 40000-49999.
        ib.connect('127.0.0.1', 7496, clientId=random.randint(40000, 49999), timeout=15, readonly=True)
        ib.reqMarketDataType(4)  # live dove c'e' l'abbonamento, altrimenti ultimo/ritardato, dichiarato per riga
        ib.sleep(2)
        per_titolo, conto = posizioni(ib)
        titoli = richiesti or sorted(s for s, r in per_titolo.items() if r['azioni'] > 0)

        print(f'Piano: {len(titoli)} titoli, {2 * len(titoli)} richieste storiche a >= {PAUSA_STORICO_S:.0f} s, '
              f'10 linee di market data alla volta. Titoli: {", ".join(titoli)}', file=sys.stderr, flush=True)

        ritmo = Ritmo(PAUSA_STORICO_S)
        risultati = []
        for i, simbolo in enumerate(titoli):
            scrivi('stato', {'inCorso': True, 'inizio': inizio, 'titolo': simbolo, 'fatti': i, 'totale': len(titoli)})
            vuota = {'azioni': 0, 'carico': None, 'opzioni': [], 'callCoperteLibere': 0, 'impegnoPut': 0}
            try:
                risultati.append(analizza(ib, simbolo, per_titolo.get(simbolo, vuota), ritmo))
            except Exception as e:
                risultati.append({'ticker': simbolo, 'errore': f'{e or type(e).__name__}'})
            print(f'{i + 1}/{len(titoli)} {simbolo}', file=sys.stderr, flush=True)

        scrivi('ultimo', {
            'ora': datetime.now().astimezone().isoformat(timespec='seconds'),
            'conto': conto, 'titoli': risultati,
            'parametri': {'dteObiettivo': DTE_OBIETTIVO, 'deltaObiettivo': DELTA_OBIETTIVO, 'deltaBanda': DELTA_BANDA},
        })
        scrivi('stato', {'inCorso': False, 'inizio': inizio, 'fine': datetime.now().astimezone().isoformat(timespec='seconds')})
    except Exception as e:
        scrivi('stato', {'inCorso': False, 'inizio': inizio, 'errore': f'IBKR: {e or type(e).__name__}'})
        raise
    finally:
        ib.disconnect()


if __name__ == '__main__':
    main()
