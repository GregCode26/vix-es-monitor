"""
Quanto si muove un'azione nel periodo di una scadenza, per /livelli-azionari.

    python execution/livelli_statistica.py AAPL

Stampa un solo JSON su stdout (anche per gli errori, nel campo `errore`).
Con scadenze settimanali: apertura del lunedi' -> chiusura del venerdi', ultime
50 settimane complete. Altrimenti: chiusura di una scadenza -> chiusura della
successiva, ultimi 50 periodi (meno se il titolo ha meno storia).

IBKR da' solo le scadenze ancora quotate, quindi quelle passate di un titolo non
settimanale sono DEDOTTE: il terzo venerdi' del mese (o l'ultimo giorno di borsa
prima), con il passo in mesi della prima distanza fra le scadenze quotate.

Una sola richiesta storica per chiamata.
"""

import calendar
import json
import math
import random
import statistics
import sys
from datetime import date, datetime, timedelta

from ib_insync import IB, Stock

from straddle_azionario import NEW_YORK, catena_principale

N_PERIODI = 50
SOGLIE = (5, 10, 15, 20, 30)
GIORNI_MAX_SETTIMANALE = 8  # 8 e non 7: una settimanale spostata al giovedi' da una festivita'


def data_da_ibkr(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def mesi_del_ciclo(scadenze: list[date]) -> int:
    """0 = settimanale, altrimenti il passo in mesi fra una scadenza e l'altra."""
    distanze = [(b - a).days for a, b in zip(scadenze, scadenze[1:])][:2]
    if all(d <= GIORNI_MAX_SETTIMANALE for d in distanze):
        return 0
    # Solo la prima distanza: piu' in la' le catene quotano pochi mesi sparsi.
    return max(1, round(distanze[0] / 30.4))


def terzo_venerdi(anno: int, mese: int) -> date:
    primo = calendar.weekday(anno, mese, 1)
    return date(anno, mese, 1 + (calendar.FRIDAY - primo) % 7 + 14)


def scadenze_passate(riferimento: date, mesi: int, quante: int) -> list[date]:
    """Dal mese della prima scadenza quotata all'indietro, dalla piu' vecchia."""
    indice = riferimento.year * 12 + riferimento.month - 1
    tutte = [terzo_venerdi(i // 12, i % 12 + 1) for i in range(indice - mesi * quante, indice + 1, mesi)]
    return tutte


def periodi_settimanali(barre: list, ora_ny: datetime) -> list[dict]:
    settimane: dict[tuple, list] = {}
    for b in barre:
        settimane.setdefault(b.date.isocalendar()[:2], []).append(b)
    finita = ora_ny.weekday() > 4 or (ora_ny.weekday() == 4 and ora_ny.hour >= 16)
    corrente = ora_ny.date().isocalendar()[:2]
    chiavi = [k for k in sorted(settimane) if finita or k != corrente]
    return [riga(settimane[k][0].date, settimane[k][-1].date, settimane[k][0].open, settimane[k][-1].close)
            for k in chiavi[-N_PERIODI:]]


def periodi_fra_scadenze(barre: list, riferimento: date, mesi: int, ora_ny: datetime) -> list[dict]:
    per_data = {b.date: b for b in barre}

    def chiusura_entro(giorno: date):
        """La barra della scadenza, o dell'ultimo giorno di borsa prima (festivita')."""
        for indietro in range(4):
            b = per_data.get(giorno - timedelta(days=indietro))
            if b is not None:
                return b
        return None

    oggi_chiuso = ora_ny.hour >= 16
    date_scadenza = [d for d in scadenze_passate(riferimento, mesi, N_PERIODI + 1)
                     if d < ora_ny.date() or (d == ora_ny.date() and oggi_chiuso)]
    punti = [b for b in (chiusura_entro(d) for d in date_scadenza) if b is not None]
    return [riga(a.date, b.date, a.close, b.close) for a, b in zip(punti, punti[1:])][-N_PERIODI:]


def riga(da: date, a: date, inizio: float, fine: float) -> dict:
    return {
        'da': da.isoformat(), 'a': a.isoformat(), 'giorni': (a - da).days,
        'inizio': round(inizio, 2), 'fine': round(fine, 2),
        'pct': round((fine - inizio) / inizio * 100, 2),
    }


def riepilogo(periodi: list[dict]) -> dict:
    mosse = [p['pct'] for p in periodi]
    assolute = [abs(m) for m in mosse]
    su = [m for m in mosse if m > 0]
    giu = [m for m in mosse if m < 0]
    return {
        'n': len(mosse),
        'mediaAssoluta': round(statistics.mean(assolute), 2),
        'medianaAssoluta': round(statistics.median(assolute), 2),
        'mediaSegno': round(statistics.mean(mosse), 2),
        'su': len(su), 'mediaSu': round(statistics.mean(su), 2) if su else None,
        'giu': len(giu), 'mediaGiu': round(statistics.mean(giu), 2) if giu else None,
        'massimo': max(mosse, key=abs),
        'oltre': [{'soglia': s, 'n': sum(a > s for a in assolute)} for s in SOGLIE],
    }


def calcola(ib: IB, simbolo: str) -> dict:
    azione = Stock(simbolo, 'SMART', 'USD')
    if not ib.qualifyContracts(azione):
        return {'errore': f'Ticker {simbolo} non trovato su IBKR'}
    catena = catena_principale(ib, azione)
    if catena is None:
        return {'errore': f'Nessuna catena di opzioni per {simbolo}'}

    ora_ny = datetime.now(NEW_YORK)
    quotate = sorted(d for d in map(data_da_ibkr, catena.expirations) if d >= ora_ny.date())
    if len(quotate) < 2:
        return {'errore': f'Troppo poche scadenze quotate per {simbolo}'}

    mesi = mesi_del_ciclo(quotate)
    # La settimanale ha bisogno di un anno; le altre di N_PERIODI volte il loro passo.
    anni = 1 if mesi == 0 else min(20, math.ceil((N_PERIODI + 1) * mesi / 12) + 1)
    print(f'PIANO: 1 richiesta storica, TRADES giornaliero, {anni} Y', file=sys.stderr)
    barre = ib.reqHistoricalData(azione, '', f'{anni} Y', '1 day', 'TRADES', True)
    if not barre:
        return {'errore': f'Nessuno storico per {simbolo} da IBKR'}

    if mesi == 0:
        periodi = periodi_settimanali(barre, ora_ny)
    else:
        periodi = periodi_fra_scadenze(barre, quotate[0], mesi, ora_ny)
    if not periodi:
        return {'errore': f'Storico di {simbolo} troppo corto per un periodo completo'}

    return {
        'ticker': simbolo,
        'ora': datetime.now().astimezone().isoformat(timespec='seconds'),
        'mesi': mesi,
        'quotate': [d.isoformat() for d in quotate[:6]],
        'periodi': periodi,
        'riepilogo': riepilogo(periodi),
    }


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({'errore': 'Uso: livelli_statistica.py TICKER'}))
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
