"""Lo smile di volatilita' dello SPX 0DTE: le formule di Optix Smile, sezioni 1-6.

Una lettura parte dalle righe per strike che il poller dei volumi scrive in
`quote.json` (bid/ask, IV e delta di call e put) e restituisce IV ATM,
expected move, IV a 25 delta, Tilt, Curv e vertice. Z-score e regime
(sezioni 7-8) li calcola `/api/smile`, che ha lo storico delle letture.

Differenze dall'originale: i dati sono IBKR (modelGreeks) e non Cboe, e l'ora
del dato e' adesso -- l'originale toglieva 15 minuti perche' i dati Cboe
erano in ritardo.
"""

import math
from datetime import datetime
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo('America/New_York')
RANGE_EM = 2.5
RANGE_MIN_PCT = 0.5


def _iv_valida(iv, ask):
    """Sezione 1: si scartano iv <= 0, iv > 5 (sopra il 500%) e ask <= 0."""
    return iv is not None and 0 < iv <= 5 and ask is not None and ask > 0


def righe_iv(strikes):
    """Per strike: IV call/put in % (None se scartata), delta, MidIV."""
    out = []
    for r in strikes:
        civ = r.get("cIv") * 100 if _iv_valida(r.get("cIv"), r.get("cAsk")) else None
        piv = r.get("pIv") * 100 if _iv_valida(r.get("pIv"), r.get("pAsk")) else None
        if civ is None and piv is None:
            mid = None
        elif civ is None or piv is None:
            mid = civ if piv is None else piv
        else:
            mid = (civ + piv) / 2
        out.append({"strike": r["strike"], "callIv": civ, "putIv": piv, "midIv": mid,
                    "callDelta": r.get("cDelta") if civ is not None else None,
                    "putDelta": r.get("pDelta") if piv is not None else None})
    return out


def iv_otm(riga, spot):
    """La linea della curva: put sotto lo spot, call da lo spot in su; se manca, l'altra."""
    if riga["strike"] < spot:
        return riga["putIv"] if riga["putIv"] is not None else riga["callIv"]
    return riga["callIv"] if riga["callIv"] is not None else riga["putIv"]


def iv_atm(righe, spot):
    """Sezione 2: MidIV dello strike piu' vicino (0,50) e dei due accanto (0,25)."""
    if not righe:
        return None
    i = min(range(len(righe)), key=lambda j: abs(righe[j]["strike"] - spot))
    somma = pesi = 0.0
    for j, peso in ((i, 0.5), (i - 1, 0.25), (i + 1, 0.25)):
        if 0 <= j < len(righe) and righe[j]["midIv"] is not None:
            somma += peso * righe[j]["midIv"]
            pesi += peso
    return somma / pesi if pesi else None


def giorni_alla_scadenza(adesso, scadenza):
    """Sezione 3: dalle `adesso` alle 16:00 ET del giorno di scadenza, almeno 60 s, in giorni."""
    giorno = datetime.strptime(scadenza, '%Y%m%d')
    chiusura = datetime(giorno.year, giorno.month, giorno.day, 16, 0, tzinfo=NEW_YORK)
    return max(60.0, (chiusura - adesso).total_seconds()) / 86400


def iv_25(righe, lato, target):
    """Sezione 4: IV interpolata sul delta `target` fra i due contratti che lo racchiudono."""
    chiave_d, chiave_iv = (("putDelta", "putIv") if lato == 'P' else ("callDelta", "callIv"))
    punti = sorted((r[chiave_d], r[chiave_iv]) for r in righe
                   if r[chiave_d] is not None and r[chiave_iv] is not None and r[chiave_d] != 0 and abs(r[chiave_d]) < 1)
    lo = next((p for p in reversed(punti) if p[0] <= target), None)
    hi = next((p for p in punti if p[0] >= target), None)
    if lo is None or hi is None:
        # Solo un lato del target: si usa quello che c'e'.
        p = lo or hi
        return p[1] if p else None
    if hi[0] == lo[0]:
        return lo[1]
    return lo[1] + (hi[1] - lo[1]) * (target - lo[0]) / (hi[0] - lo[0])


def vertice(righe, spot, em):
    """Sezione 6: lo strike con la media mobile a 3 strike della IV OTM piu' bassa."""
    punti = [(r["strike"], iv_otm(r, spot)) for r in righe if abs(r["strike"] - spot) <= RANGE_EM * em]
    punti = [p for p in punti if p[1] is not None]
    if not punti:
        return None
    migliore = None
    for i, (k, v) in enumerate(punti):
        vicini = [punti[j][1] for j in (i - 1, i, i + 1) if 0 <= j < len(punti)]
        m = sum(vicini) / len(vicini)
        if migliore is None or m < migliore[0]:
            migliore = (m, k, v)
    _, k, v = migliore
    return {"strike": k, "iv": v, "sigma": (k - spot) / em if em else None}


def lettura(strikes, spot, scadenza, adesso=None):
    """Una lettura completa dello smile, o None se mancano spot o IV ATM."""
    if spot is None or spot != spot or spot <= 0:
        return None
    adesso = adesso or datetime.now(NEW_YORK)
    righe = sorted(righe_iv(strikes), key=lambda r: r["strike"])
    atm = iv_atm(righe, spot)
    if atm is None:
        return None
    dte = giorni_alla_scadenza(adesso, scadenza)
    em = spot * (atm / 100) * math.sqrt(dte / 365)
    put25 = iv_25(righe, 'P', -0.25)
    call25 = iv_25(righe, 'C', 0.25)
    # Sezione 5. Con un lato solo, l'altro vale lo stesso: Tilt 0, Curv sul lato presente.
    if put25 is None:
        put25 = call25
    if call25 is None:
        call25 = put25
    tilt = put25 - call25 if put25 is not None else None
    curv = (put25 + call25) / 2 - atm if put25 is not None else None
    v = vertice(righe, spot, em)
    r2 = lambda x: round(x, 4) if x is not None else None
    return {
        "tEt": adesso.strftime('%H:%M:%S'),
        "spot": round(spot, 2),
        "ivAtm": r2(atm),
        "em": r2(em),
        "dte": r2(dte),
        "put25": r2(put25),
        "call25": r2(call25),
        "tilt": r2(tilt),
        "curv": r2(curv),
        "vertice": v and {"strike": v["strike"], "iv": r2(v["iv"]), "sigma": r2(v["sigma"])},
        "range": round(max(RANGE_EM * em, spot * RANGE_MIN_PCT / 100), 2),
    }
