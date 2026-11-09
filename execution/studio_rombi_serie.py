"""
Studio: dopo un rombo "Var Serie" di /market, SPX raggiunge lo strike del rombo?

    python execution/studio_rombi_serie.py [--dettaglio]

Serve la dashboard in locale: la serie di MARKET MAKER di ogni giorno passato
viene da /api/hedging-pressure?storia=1&date=YYYY-MM-DD (solo file locali).
SPX dal file di /market (frontend/data/market/YYYY-MM-DD.json, un punto ogni ~15 s).

I rombi sono ricalcolati con la stessa regola di lib/gexHeatmap.ts
(`trovaPicchi`, portata qui sotto): griglia a 30 s, |pressione| su 10 minuti,
media mobile, 98esimo percentile della sessione, eventi consecutivi uniti al picco.
ATTENZIONE: sul giorno intero, come li vede /market a fine giornata; dal vivo
la soglia cresce durante la sessione e i rombi possono essere diversi.

Confronto: lo stesso livello SPECCHIATO (spot - distanza, dall'altra parte),
nello stesso istante. Se il rombo "attira" il prezzo, il suo strike deve
essere toccato piu' spesso del livello specchiato alla stessa distanza.
"""

import argparse
import glob
import json
import math
import os
import urllib.request
from bisect import bisect_left, bisect_right
from datetime import date

RADICE = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data')
PASSO_MS = 30_000
BUCO_MS = 10 * 60_000
LOOKBACK_MIN = 10
ORIZZONTI = (5, 15, 30, 60)


def sec(hhmmss):
    h, m, s = (int(x) for x in hhmmss.split(':'))
    return h * 3600 + m * 60 + s


def trova_picchi(strikes, fotogrammi, lookback_min=LOOKBACK_MIN):
    """Porta di lib/gexHeatmap.ts grigliaEDelta + picchiDaDelta."""
    fot = sorted(fotogrammi, key=lambda f: f[0])
    t0, t1 = fot[0][0], fot[-1][0]
    n = max(1, round((t1 - t0) / PASSO_MS) + 1)
    nan = float('nan')
    griglia = [[nan] * n for _ in strikes]
    s = 0
    for c in range(n):
        t = t0 + c * PASSO_MS
        while s < len(fot) - 2 and fot[s + 1][0] < t:
            s += 1
        a, b = fot[s], fot[min(s + 1, len(fot) - 1)]
        if b[0] == a[0]:
            f = 0
        elif b[0] - a[0] > BUCO_MS:
            if t - a[0] <= PASSO_MS:
                f = 0
            elif b[0] - t <= PASSO_MS:
                f = 1
            else:
                continue
        else:
            f = max(0, min(1, (t - a[0]) / (b[0] - a[0])))
        for i in range(len(strikes)):
            va, vb = a[1][i], b[1][i]
            griglia[i][c] = va + (vb - va) * f
    passi = max(1, round(lookback_min * 60_000 / PASSO_MS))
    finestra = max(2, round(passi / 2))
    delta = []
    for riga in griglia:
        out = [nan] * n
        for c in range(n):
            if math.isnan(riga[c]):
                continue
            prima = nan
            d = max(0, c - passi)
            while d < c and math.isnan(prima):
                prima = riga[d]
                d += 1
            out[c] = 0 if math.isnan(prima) else abs(riga[c]) - abs(prima)
        liscia = [nan] * n
        somma, quanti = 0.0, 0
        for c in range(n):
            if not math.isnan(out[c]):
                somma += out[c]
                quanti += 1
            via = c - finestra
            if via >= 0 and not math.isnan(out[via]):
                somma -= out[via]
                quanti -= 1
            if not math.isnan(out[c]) and quanti > 0:
                liscia[c] = somma / quanti
        delta.append(liscia)
    campioni = sorted(abs(r[c]) for r in delta for c in range(0, n, 2) if not math.isnan(r[c]) and r[c] != 0)
    if not campioni:
        return []
    soglia = campioni[min(len(campioni) - 1, math.floor(0.98 * (len(campioni) - 1)))]
    picchi, corrente = [], None
    for c in range(n):
        migliore, massimo = -1, 0
        for i in range(len(strikes)):
            d = delta[i][c]
            if not math.isnan(d) and abs(d) > massimo:
                massimo, migliore = abs(d), i
        if migliore < 0 or massimo < soglia:
            if corrente:
                picchi.append(corrente)
            corrente = None
            continue
        d = delta[migliore][c]
        nuovo = {'t': t0 + c * PASSO_MS, 'strike': strikes[migliore], 'delta': d, 'forza': massimo / soglia}
        if corrente and corrente['strike'] == nuovo['strike'] and (corrente['delta'] > 0) == (d > 0):
            if massimo > abs(corrente['delta']):
                corrente = nuovo
        else:
            if corrente:
                picchi.append(corrente)
            corrente = nuovo
    if corrente:
        picchi.append(corrente)
    return picchi


def rombi_del_giorno(giorno):
    with urllib.request.urlopen(f'http://localhost:3000/api/hedging-pressure?storia=1&date={giorno}', timeout=180) as r:
        j = json.load(r)
    d = j.get('data', j)
    if d.get('date') != giorno:
        return None
    punti = {}
    for p in (d.get('storia') or []) + (d.get('pressureHistory') or []):
        punti[(p['time'], p['strike'])] = p['totalPressure']
    strikes = sorted({k for _, k in punti})
    idx = {k: i for i, k in enumerate(strikes)}
    per_ora = {}
    for (t, k), v in punti.items():
        per_ora.setdefault(t, [float('nan')] * len(strikes))[idx[k]] = v
    fot = [(sec(t) * 1000, v) for t, v in per_ora.items()]
    return trova_picchi(strikes, fot) if fot else []


def spx_del_giorno(giorno):
    try:
        with open(os.path.join(RADICE, 'market', f'{giorno}.json'), encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return None
    punti = d if isinstance(d, list) else d.get('data') or d.get('points') or []
    serie = sorted((sec(p['time']), p['spx']) for p in punti if p.get('time') and p.get('spx'))
    return serie or None


def toccato(serie, t, livello, minuti):
    """SPX ha toccato il livello in (t, t + minuti]? None se la serie non copre."""
    tempi = [x[0] for x in serie]
    i, j = bisect_right(tempi, t), bisect_right(tempi, t + minuti * 60)
    if j <= i or tempi[j - 1] < t + minuti * 60 - 60:
        return None
    lo = min(x[1] for x in serie[i:j])
    hi = max(x[1] for x in serie[i:j])
    return lo <= livello <= hi


def spot_a(serie, t):
    tempi = [x[0] for x in serie]
    i = bisect_left(tempi, t)
    for k in (i, i - 1):
        if 0 <= k < len(serie) and abs(serie[k][0] - t) <= 60:
            return serie[k][1]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dettaglio', action='store_true')
    a = ap.parse_args()
    oggi = date.today().isoformat()
    giorni = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'volumes', '????-??-??.json'))
                    if os.path.basename(f)[:10] < oggi)
    eventi = []
    for g in giorni:
        spx = spx_del_giorno(g)
        if not spx:
            continue
        try:
            rombi = rombi_del_giorno(g)
        except Exception as e:
            print(f'{g}: route non disponibile ({e})')
            continue
        if not rombi:
            continue
        n0 = len(eventi)
        for r in rombi:
            t = round(r['t'] / 1000)
            s0 = spot_a(spx, t)
            if s0 is None:
                continue
            dist = r['strike'] - s0
            ev = {'g': g, 't': t, 'k': r['strike'], 'dist': dist, 'su': r['delta'] > 0, 'forza': r['forza']}
            for h in ORIZZONTI:
                ev[h] = toccato(spx, t, r['strike'], h)
                ev[f'f{h}'] = toccato(spx, t, s0 - dist, h)
            eventi.append(ev)
        if a.dettaglio:
            print(f'{g}: {len(rombi)} rombi, {len(eventi) - n0} con SPX')

    print(f'\nrombi con SPX: {len(eventi)} in {len({e["g"] for e in eventi})} giorni')

    def riga(sel, nome):
        out = f'  {nome:34s} n {len(sel):4d}'
        for h in ORIZZONTI:
            v = [e for e in sel if e[h] is not None and e[f'f{h}'] is not None]
            if not v:
                continue
            p = sum(e[h] for e in v) / len(v) * 100
            q = sum(e[f'f{h}'] for e in v) / len(v) * 100
            out += f' | {h:2d}m {p:3.0f}% vs {q:3.0f}%'
        print(out)

    print('  (% di rombi il cui strike viene toccato  vs  stesso livello specchiato dall\'altra parte dello spot)')
    riga(eventi, 'tutti')
    riga([e for e in eventi if abs(e['dist']) >= 3], 'distanza >= 3 punti')
    for lo, hi in ((0, 3), (3, 7), (7, 15), (15, 1e9)):
        riga([e for e in eventi if lo <= abs(e['dist']) < hi], f'distanza {lo}-{hi if hi < 1e9 else "oltre"}')
    riga([e for e in eventi if e['su']], 'pressione che cresce (fucsia)')
    riga([e for e in eventi if not e['su']], 'pressione che cala (lime)')
    riga([e for e in eventi if e['forza'] >= 1.5], 'forza >= 1,5')
    mediana = sorted(abs(e['dist']) for e in eventi)[len(eventi) // 2] if eventi else 0
    print(f'  distanza mediana strike-spot: {mediana:.1f} punti')
    # Per giorno, a 15 minuti, distanza >= 3: rombo meglio dello specchio?
    pg = {}
    for e in eventi:
        if abs(e['dist']) >= 3 and e[15] is not None and e['f15'] is not None:
            pg.setdefault(e['g'], [0, 0])
            pg[e['g']][0] += e[15]
            pg[e['g']][1] += e['f15']
    meglio = sum(v[0] > v[1] for v in pg.values())
    peggio = sum(v[0] < v[1] for v in pg.values())
    print(f'  giorni (dist >= 3, 15 min): rombo meglio {meglio}, peggio {peggio}, pari {len(pg) - meglio - peggio}')


if __name__ == '__main__':
    main()
