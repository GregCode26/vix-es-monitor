"""Lo smile di volatilita' dello SPX 0DTE: le formule di Optix Smile, sezioni 1-6.

Una lettura parte dalle righe per strike che il poller dei volumi scrive in
`quote.json` (bid/ask, IV e delta di call e put) e restituisce IV ATM,
expected move, IV a 25 delta, Tilt, Curv e vertice. Z-score e regime
(sezioni 7-8) li calcola `/api/smile`, che ha lo storico delle letture.

Differenze dall'originale: i dati sono IBKR e non Cboe, e l'ora del dato e'
adesso -- l'originale toglieva 15 minuti perche' i dati Cboe erano in ritardo.

Versione 2 (27/10/2026), campo `v` di ogni lettura:
- l'IV e il delta si calcolano qui dal mid bid/ask (Black-76 sul forward della
  parita' put-call), non si prendono dai `modelGreeks` di IBKR: il 26/10 l'IV
  ATM era identica alla lettura prima in 1.720 letture su 2.227. I
  `modelGreeks` restano il ripiego sul lato senza un prezzo utilizzabile;
- l'IV ATM e' interpolata allo spot fra i due strike che lo racchiudono, non
  pesata sullo strike piu' vicino (faceva un gradino a ogni meta' strike);
- Tilt e Curv anche in % dell'IV ATM (`tiltN`, `curvN`): in punti di vol si
  schiacciano con il livello della vol (22 -> 12 il 26/10), e il regime
  leggeva RIBASSISTA nei rally con la vol in calo;
- `est25` dice se una IV a 25 delta e' stata presa fuori dai contratti che la
  racchiudono invece che interpolata;
- il vertice IV MIN cambia strike solo se il nuovo minimo e' piu' basso di
  ISTERESI_VERTICE (80 cambi il 26/10, spesso avanti e indietro di 5 punti).
"""

import math
from datetime import datetime
from statistics import median
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo('America/New_York')
VERSIONE = 2
RANGE_EM = 2.5
RANGE_MIN_PCT = 0.5
# Punti di vol (media a 3 strike) di cui il nuovo vertice deve stare sotto quello di prima.
ISTERESI_VERTICE = 0.1

# Il vertice della lettura prima, per l'isteresi: (scadenza, strike).
_vertice_prima = None


def _iv_valida(iv, ask):
    """Sezione 1: si scartano iv <= 0, iv > 5 (sopra il 500%) e ask <= 0."""
    return iv is not None and 0 < iv <= 5 and ask is not None and ask > 0


def _n(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _black(f, k, t, iv, call):
    """Prezzo Black-76 senza sconto (poche ore alla scadenza: lo sconto non si vede)."""
    v = iv * math.sqrt(t)
    d1 = (math.log(f / k) + v * v / 2) / v
    d2 = d1 - v
    return f * _n(d1) - k * _n(d2) if call else k * _n(-d2) - f * _n(-d1)


def _delta(f, k, t, iv, call):
    d1 = (math.log(f / k) + iv * iv * t / 2) / (iv * math.sqrt(t))
    return _n(d1) if call else _n(d1) - 1


def iv_da_prezzo(prezzo, f, k, t, call):
    """IV (decimale) che rende `prezzo` con Black-76, per bisezione; None se il prezzo non ha valore temporale."""
    intrinseco = max(f - k, 0) if call else max(k - f, 0)
    if prezzo <= intrinseco + 1e-6 or prezzo >= (f if call else k):
        return None
    lo, hi = 1e-4, 5.0
    if _black(f, k, t, hi, call) < prezzo:
        return None
    for _ in range(60):
        m = (lo + hi) / 2
        if _black(f, k, t, m, call) < prezzo:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def _mid(r, lato):
    """Mid bid/ask, solo con un bid vero (> 0): bid 0 / ask 0,05 non e' un prezzo."""
    bid, ask = r.get(lato + "Bid"), r.get(lato + "Ask")
    if bid is None or ask is None or bid <= 0 or ask < bid:
        return None
    return (bid + ask) / 2


def forward(strikes, spot):
    """Il forward dalla parita' put-call (K + C - P) sui 3 strike piu' vicini allo spot; lo spot se non si puo'."""
    stime = []
    for r in sorted(strikes, key=lambda r: abs(r["strike"] - spot)):
        c, p = _mid(r, "c"), _mid(r, "p")
        if c is not None and p is not None:
            stime.append(r["strike"] + c - p)
        if len(stime) == 3:
            break
    return median(stime) if stime else spot


def righe_iv(strikes, spot, t):
    """Per strike: IV call/put in % (None se scartata), delta, MidIV e se l'IV e' nostra.

    `t` e' il tempo alla scadenza in anni. L'IV si calcola dal mid; senza un
    mid utilizzabile si ripiega sui `modelGreeks` di IBKR.
    """
    f = forward(strikes, spot)
    out = []
    proprie = 0
    for r in strikes:
        riga = {"strike": r["strike"]}
        for lato, call, nome in (("c", True, "call"), ("p", False, "put")):
            iv = delta = None
            mid = _mid(r, lato)
            if mid is not None:
                iv = iv_da_prezzo(mid, f, r["strike"], t, call)
            if iv is not None:
                delta = _delta(f, r["strike"], t, iv, call)
                proprie += 1
            elif _iv_valida(r.get(lato + "Iv"), r.get(lato + "Ask")):
                iv, delta = r[lato + "Iv"], r.get(lato + "Delta")
            riga[nome + "Iv"] = iv * 100 if iv is not None else None
            riga[nome + "Delta"] = delta if iv is not None else None
        civ, piv = riga["callIv"], riga["putIv"]
        if civ is None and piv is None:
            riga["midIv"] = None
        elif civ is None or piv is None:
            riga["midIv"] = civ if piv is None else piv
        else:
            riga["midIv"] = (civ + piv) / 2
        out.append(riga)
    quota = proprie / (2 * len(strikes)) if strikes else 0
    return out, f, quota


def iv_otm(riga, spot):
    """La linea della curva: put sotto lo spot, call da lo spot in su; se manca, l'altra."""
    if riga["strike"] < spot:
        return riga["putIv"] if riga["putIv"] is not None else riga["callIv"]
    return riga["callIv"] if riga["callIv"] is not None else riga["putIv"]


def iv_atm(righe, spot):
    """Sezione 2: MidIV interpolata allo spot fra i due strike che lo racchiudono (righe in ordine di strike)."""
    validi = [(r["strike"], r["midIv"]) for r in righe if r["midIv"] is not None]
    if not validi:
        return None
    sotto = next((p for p in reversed(validi) if p[0] <= spot), None)
    sopra = next((p for p in validi if p[0] >= spot), None)
    if sotto is None or sopra is None:
        return (sotto or sopra)[1]
    if sopra[0] == sotto[0]:
        return sotto[1]
    return sotto[1] + (sopra[1] - sotto[1]) * (spot - sotto[0]) / (sopra[0] - sotto[0])


def giorni_alla_scadenza(adesso, scadenza):
    """Sezione 3: dalle `adesso` alle 16:00 ET del giorno di scadenza, almeno 60 s, in giorni."""
    giorno = datetime.strptime(scadenza, '%Y%m%d')
    chiusura = datetime(giorno.year, giorno.month, giorno.day, 16, 0, tzinfo=NEW_YORK)
    return max(60.0, (chiusura - adesso).total_seconds()) / 86400


def iv_25(righe, lato, target):
    """Sezione 4: IV interpolata sul delta `target` fra i due contratti che lo racchiudono.

    Restituisce (iv, estrapolata): estrapolata se c'era un lato solo del target.
    """
    chiave_d, chiave_iv = (("putDelta", "putIv") if lato == 'P' else ("callDelta", "callIv"))
    punti = sorted((r[chiave_d], r[chiave_iv]) for r in righe
                   if r[chiave_d] is not None and r[chiave_iv] is not None and r[chiave_d] != 0 and abs(r[chiave_d]) < 1)
    lo = next((p for p in reversed(punti) if p[0] <= target), None)
    hi = next((p for p in punti if p[0] >= target), None)
    if lo is None or hi is None:
        # Solo un lato del target: si usa quello che c'e'.
        p = lo or hi
        return (p[1], True) if p else (None, True)
    if hi[0] == lo[0]:
        return lo[1], False
    return lo[1] + (hi[1] - lo[1]) * (target - lo[0]) / (hi[0] - lo[0]), False


def vertice(righe, spot, em, scadenza=None):
    """Sezione 6: lo strike con la media mobile a 3 strike della IV OTM piu' bassa.

    Con isteresi: resta lo strike della lettura prima finche' la sua media non
    supera quella del nuovo minimo di ISTERESI_VERTICE.
    """
    global _vertice_prima
    punti = [(r["strike"], iv_otm(r, spot)) for r in righe if abs(r["strike"] - spot) <= RANGE_EM * em]
    punti = [p for p in punti if p[1] is not None]
    if not punti:
        return None
    medie = []
    for i, (k, v) in enumerate(punti):
        vicini = [punti[j][1] for j in (i - 1, i, i + 1) if 0 <= j < len(punti)]
        medie.append((sum(vicini) / len(vicini), k, v))
    migliore = min(medie)
    if _vertice_prima and _vertice_prima[0] == scadenza:
        prima = next((m for m in medie if m[1] == _vertice_prima[1]), None)
        if prima and prima[0] - migliore[0] < ISTERESI_VERTICE:
            migliore = prima
    _, k, v = migliore
    _vertice_prima = (scadenza, k)
    return {"strike": k, "iv": v, "sigma": (k - spot) / em if em else None}


def lettura(strikes, spot, scadenza, adesso=None):
    """Una lettura completa dello smile, o None se mancano spot o IV ATM. Vedi `calcola`."""
    return calcola(strikes, spot, scadenza, adesso)[1]


def calcola(strikes, spot, scadenza, adesso=None):
    """(righe per strike con le IV usate, lettura o None): le righe servono alla curva di /api/smile."""
    if spot is None or spot != spot or spot <= 0:
        return [], None
    adesso = adesso or datetime.now(NEW_YORK)
    dte = giorni_alla_scadenza(adesso, scadenza)
    righe, f, quota = righe_iv(sorted(strikes, key=lambda r: r["strike"]), spot, dte / 365)
    atm = iv_atm(righe, spot)
    if atm is None:
        return righe, None
    em = spot * (atm / 100) * math.sqrt(dte / 365)
    put25, est_p = iv_25(righe, 'P', -0.25)
    call25, est_c = iv_25(righe, 'C', 0.25)
    # Sezione 5. Con un lato solo, l'altro vale lo stesso: Tilt 0, Curv sul lato presente.
    if put25 is None:
        put25 = call25
    if call25 is None:
        call25 = put25
    tilt = put25 - call25 if put25 is not None else None
    curv = (put25 + call25) / 2 - atm if put25 is not None else None
    v = vertice(righe, spot, em, scadenza)
    r2 = lambda x: round(x, 4) if x is not None else None
    return righe, {
        "v": VERSIONE,
        "tEt": adesso.strftime('%H:%M:%S'),
        "spot": round(spot, 2),
        "fwd": round(f, 2),
        "ivAtm": r2(atm),
        "em": r2(em),
        "dte": r2(dte),
        "put25": r2(put25),
        "call25": r2(call25),
        "tilt": r2(tilt),
        "curv": r2(curv),
        # Tilt e Curv in % dell'IV ATM: su questi lavora il regime.
        "tiltN": r2(tilt / atm * 100) if tilt is not None and atm > 0 else None,
        "curvN": r2(curv / atm * 100) if curv is not None and atm > 0 else None,
        "est25": est_p or est_c,
        # Quota di IV calcolate da noi sul totale (call + put), il resto da modelGreeks.
        "ivProprie": round(quota, 2),
        "vertice": v and {"strike": v["strike"], "iv": r2(v["iv"]), "sigma": r2(v["sigma"])},
        "range": round(max(RANGE_EM * em, spot * RANGE_MIN_PCT / 100), 2),
    }
