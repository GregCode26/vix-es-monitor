"""
Orari e festivita' presi da IBKR, non da un calendario scritto a mano.

Ogni ContractDetails porta `tradingHours` (tutte le sessioni, compresa la
notturna GTH delle SPX) e `liquidHours` (solo il cash), nel fuso
`timeZoneId` (per le SPX `US/Central`). Formato:

    20261105:0830-20261105:1500;20261106:0830-20261106:1500
    20261126:CLOSED                       <- festivita'

Il 05/11/2026 un'opzione SPX dava
    20261104:1915-20261105:0825;20261105:0830-20261105:1600;...
cioe' notturna 19:15-08:25 CT e cash 08:30-15:00/16:00 CT.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

_ALIAS_FUSI = {'US/Central': 'America/Chicago', 'US/Eastern': 'America/New_York'}


def _fuso(nome: str) -> ZoneInfo:
    return ZoneInfo(_ALIAS_FUSI.get(nome, nome or 'America/Chicago'))


def sessioni(orari: str, fuso: str) -> tuple[list, set]:
    """(lista di (inizio, fine) aware, insieme delle date YYYYMMDD chiuse)."""
    tz = _fuso(fuso)
    aperte, chiuse = [], set()
    for pezzo in filter(None, (orari or '').split(';')):
        if pezzo.endswith(':CLOSED'):
            chiuse.add(pezzo.split(':')[0])
            continue
        try:
            inizio, fine = pezzo.split('-')
            a = datetime.strptime(inizio, '%Y%m%d:%H%M').replace(tzinfo=tz)
            b = datetime.strptime(fine, '%Y%m%d:%H%M').replace(tzinfo=tz)
        except ValueError:
            continue
        aperte.append((a, b))
    aperte.sort()
    return aperte, chiuse


def stato(orari: str, fuso: str, adesso: datetime | None = None) -> dict:
    adesso = adesso or datetime.now(_fuso(fuso))
    aperte, chiuse = sessioni(orari, fuso)
    corrente = next(((a, b) for a, b in aperte if a <= adesso < b), None)
    prossima = next(((a, b) for a, b in aperte if a > adesso), None)
    return {
        'aperto': corrente is not None,
        'fine_sessione': corrente[1].isoformat() if corrente else None,
        'prossima_apertura': prossima[0].isoformat() if prossima else None,
        'giorni_chiusi': sorted(chiuse),
    }


def mercato_aperto(orari: str, fuso: str, adesso: datetime | None = None) -> bool:
    return stato(orari, fuso, adesso)['aperto']


NEW_YORK = ZoneInfo('America/New_York')
# La sessione notturna delle SPX apre alle 20:15 di New York e appartiene al
# giorno di borsa successivo: da li' il volume riparte da zero e la 0DTE e'
# la scadenza di domani.
APERTURA_NOTTURNA_NY = (20, 15)


def giorno_di_borsa(adesso: datetime | None = None):
    """Data del giorno di borsa in corso (o del prossimo), a New York."""
    from datetime import timedelta
    ny = (adesso or datetime.now(NEW_YORK)).astimezone(NEW_YORK)
    giorno = ny.date()
    if (ny.hour, ny.minute) >= APERTURA_NOTTURNA_NY:
        giorno += timedelta(days=1)
    while giorno.weekday() >= 5:  # sabato/domenica -> lunedi'
        giorno += timedelta(days=1)
    return giorno


# IBKR azzera il volume giornaliero delle opzioni SPX a ogni sessione: alle
# 9:30 NY il 05/11/2026 la 7700C 0DTE e' passata da 5.475 (notturna) a 2.020
# (primi 4 minuti di cash). Il volume della notturna non e' nel volume del
# cash, quindi ogni lettura appartiene a una sessione e gli incrementi si
# calcolano solo dentro la stessa.
APERTURA_CASH_NY = (9, 30)
SESSIONI = ('notturna', 'cash')


def sessione_di_borsa(adesso: datetime | None = None) -> tuple:
    """(giorno di borsa, 'notturna' | 'cash'). Il cash va dalle 9:30 alle 20:15 NY."""
    ny = (adesso or datetime.now(NEW_YORK)).astimezone(NEW_YORK)
    giorno = giorno_di_borsa(ny)
    ora = (ny.hour, ny.minute)
    nel_cash = ny.date() == giorno and APERTURA_CASH_NY <= ora < APERTURA_NOTTURNA_NY
    return giorno, 'cash' if nel_cash else 'notturna'
