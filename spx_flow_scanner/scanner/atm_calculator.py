"""
ATM: lo strike quotato piu' vicino al prezzo di riferimento SPX.

Lo strike non viene mai spostato o arrotondato a un passo teorico: si sceglie
fra quelli che esistono davvero (la catena 0DTE ha passo 5 vicino al prezzo,
piu' largo lontano).
"""

from collections import Counter


def strike_atm(prezzo: float, strikes) -> float | None:
    strikes = list(strikes)
    if prezzo is None or not strikes:
        return None
    # A parita' di distanza si prende lo strike piu' basso: deterministico.
    return min(strikes, key=lambda k: (abs(k - prezzo), k))


def passo_vicino(prezzo: float, strikes, quanti: int = 20) -> float | None:
    """Passo prevalente fra i `quanti` strike piu' vicini al prezzo."""
    vicini = sorted(sorted(set(strikes), key=lambda k: abs(k - prezzo))[:quanti])
    differenze = [round(b - a, 4) for a, b in zip(vicini, vicini[1:])]
    if not differenze:
        return None
    return Counter(differenze).most_common(1)[0][0]


# -- riferimento ATM dalla storia dei cicli -----------------------------------

MODI_ATM = ('corrente', 'apertura', 'storico')


def riferimento_atm(db, giorno: str, modo: str = 'corrente', ora_ny: str | None = None,
                    sessione: str | None = None) -> dict | None:
    """
    L'ATM come lo ha visto lo scanner, da `scan_history`:
      - corrente: l'ultimo ciclo (della `sessione`, se data);
      - apertura: il primo ciclo dopo le 9:30 NY con SPX da `last` (cash
        aperto). Prima dell'apertura non esiste: None, non l'ATM della notte;
      - storico: l'ultimo ciclo iniziato entro `ora_ny` ('HH:MM', New York).
    """
    from datetime import datetime, time as ora, timedelta
    from zoneinfo import ZoneInfo

    ny = ZoneInfo('America/New_York')
    base = datetime.fromisoformat(giorno).replace(tzinfo=ny)
    if modo == 'corrente':
        sql, par = 'WHERE giorno = ? ORDER BY started_at DESC', [giorno]
        if sessione:
            sql, par = 'WHERE giorno = ? AND sessione = ? ORDER BY started_at DESC', [giorno, sessione]
    elif modo == 'apertura':
        apertura = int(datetime.combine(base.date(), ora(9, 30), ny).timestamp())
        sql, par = "WHERE giorno = ? AND started_at >= ? AND spx_source = 'last' ORDER BY started_at", [giorno, apertura]
    elif modo == 'storico':
        if not ora_ny:
            raise ValueError("modo 'storico' vuole ora_ny='HH:MM'")
        hh, mm = (int(x) for x in ora_ny.split(':'))
        # Le ore dopo le 20:15 appartengono alla notturna, cioe' al giorno prima di calendario.
        giorno_cal = base.date() if (hh, mm) < (20, 15) else base.date() - timedelta(days=1)
        limite = int(datetime.combine(giorno_cal, ora(hh, mm), ny).timestamp())
        sql, par = 'WHERE giorno = ? AND started_at <= ? ORDER BY started_at DESC', [giorno, limite]
    else:
        raise ValueError(f'modo ATM sconosciuto: {modo}')
    riga = db.execute(f'SELECT scan_id, started_at, spx, spx_source, atm FROM scan_history {sql} LIMIT 1',
                      par).fetchone()
    if riga is None or riga[4] is None:
        return None
    return {'modo': modo, 'scan_id': riga[0], 'ts': riga[1], 'spx': riga[2], 'fonte_spx': riga[3], 'atm': riga[4]}
