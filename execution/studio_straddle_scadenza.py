"""
Vendere lo straddle SPX 0DTE e tenerlo a scadenza: con i prezzi veri, rende?

    python execution/studio_straddle_scadenza.py

Prezzi: snapshot del poller IV (frontend/data/iv-monitor/YYYY-MM-DD.json, bid/ask
di ATM +/- 2 strike ogni 5 s). Si vende al BID lo straddle dello strike quotato piu'
vicino allo spot (prima del 25/10 la finestra poteva essere fuori centro: il payoff
si calcola comunque sullo strike vero, quindi resta esatto). Scadenza = chiusura SPX
delle 16:00 NY (barre IBKR in .tmp/studio_vol_intraday, o l'ultimo punto SPX del
file di /market). P&L in punti SPX (x100 = dollari), commissioni escluse
(~0,03 pt per gamba).

Seconda parte: lo stesso su 3,5 anni con il prezzo dello straddle STIMATO dal VIX1D
(0,8 x S x VIX1D x sqrt(minuti rimasti / (390 x 252))), corretto col rapporto
prezzo vero / stima misurato sui giorni con i prezzi veri. E' un'approssimazione:
serve a vedere code e anni cattivi, non il centesimo.
"""

import glob
import json
import math
import os
import statistics as st
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..')
NY = ZoneInfo('America/New_York')
ENTRATE = [(10, 0), (11, 0), (12, 0), (13, 0), (14, 0), (15, 0), (15, 30)]


def chiusure_spx():
    out = {}
    for f in glob.glob(os.path.join(RADICE, '.tmp', 'studio_vol_intraday', 'SPX_*.json')):
        for b in json.load(open(f)):
            d = datetime.fromtimestamp(b['t'], NY)
            if d.hour == 15 and d.minute == 55:
                out[d.date().isoformat()] = b['c']
    for f in glob.glob(os.path.join(RADICE, 'frontend', 'data', 'market', '2026-*.json')):
        g = os.path.basename(f)[:10]
        if g in out:
            continue
        try:
            p = json.load(open(f, encoding='utf-8'))
            p = p if isinstance(p, list) else p.get('data', [])
            spx = [x for x in p if x.get('spx') and x.get('time', '') >= '21:5']
            if spx:
                out[g] = spx[-1]['spx']
        except Exception:
            pass
    return out


def vix1d_storico():
    """(giorno, minuto NY) -> VIX1D, e SPX 5m, per la seconda parte."""
    spx, v1 = defaultdict(dict), defaultdict(dict)
    for s, dst in (('SPX', spx), ('VIX1D', v1)):
        for f in glob.glob(os.path.join(RADICE, '.tmp', 'studio_vol_intraday', f'{s}_*.json')):
            for b in json.load(open(f)):
                d = datetime.fromtimestamp(b['t'], NY)
                dst[d.date().isoformat()][d.hour * 60 + d.minute] = b['c']
    return spx, v1


def riass(v):
    if len(v) < 3:
        return f'n {len(v)}'
    m, sd = st.mean(v), st.stdev(v)
    t = m / (sd / math.sqrt(len(v))) if sd else 0
    return (f'n {len(v):3d}  media {m:+6.2f} pt  mediana {st.median(v):+6.2f}  vincenti {sum(x > 0 for x in v) / len(v) * 100:3.0f}%  '
            f't {t:+4.1f}  peggiore {min(v):+7.2f}  migliore {max(v):+6.2f}')


def main():
    chiusa = chiusure_spx()
    reali = defaultdict(list)       # entrata -> [P&L]
    rapporto = defaultdict(list)    # entrata -> prezzo vero / stima VIX1D
    per_giorno = {}
    spx5, v1 = vix1d_storico()
    for f in sorted(glob.glob(os.path.join(RADICE, 'frontend', 'data', 'iv-monitor', '*.json'))):
        g = os.path.basename(f)[:10]
        if g not in chiusa or g >= datetime.now().date().isoformat():
            continue
        try:
            snap = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        for hh, mm in ENTRATE:
            obiettivo = datetime(int(g[:4]), int(g[5:7]), int(g[8:10]), hh, mm, tzinfo=NY).timestamp()
            vicini = [s for s in snap if s.get('timestamp') and abs(s['timestamp'] - obiettivo) <= 60]
            if not vicini:
                continue
            s = min(vicini, key=lambda x: abs(x['timestamp'] - obiettivo))
            spot = s.get('esPrice')
            calls = {o['strike']: o for o in s.get('callsData') or []}
            puts = {o['strike']: o for o in s.get('putsData') or []}
            ks = [k for k in calls if k in puts and calls[k].get('bid') and puts[k].get('bid') and calls[k].get('ask') and puts[k].get('ask')]
            if not ks or not spot:
                continue
            k = min(ks, key=lambda x: abs(x - spot))
            premio = calls[k]['bid'] + puts[k]['bid']
            pnl = premio - abs(chiusa[g] - k)
            reali[(hh, mm)].append(pnl)
            per_giorno.setdefault(g, {})[(hh, mm)] = pnl
            # Stima VIX1D per lo stesso istante (solo se lo strike e' quasi ATM).
            m = hh * 60 + mm
            vv = v1.get(g, {}).get(m - 5)
            if vv and abs(k - spot) <= 2.5:
                stima = 0.8 * spot * vv / 100 * math.sqrt((960 - m) / (390 * 252))
                mid = (calls[k]['bid'] + calls[k]['ask'] + puts[k]['bid'] + puts[k]['ask']) / 2
                rapporto[(hh, mm)].append(mid / stima)

    print('1. VENDITA STRADDLE 0DTE AL BID, TENUTO A SCADENZA - PREZZI VERI')
    print(f'   giorni: {len(per_giorno)} ({min(per_giorno)} .. {max(per_giorno)})')
    for e in ENTRATE:
        print(f'   entrata {e[0]:2d}:{e[1]:02d} NY  {riass(reali[e])}')
    print('   per giorno, entrata 12:00:', ' '.join(f'{g[5:]} {v[(12, 0)]:+.1f}' for g, v in sorted(per_giorno.items()) if (12, 0) in v))

    print('\n2. RAPPORTO PREZZO VERO (mid) / STIMA DA VIX1D, stesso istante, strike entro 2,5 pt dallo spot')
    for e in ENTRATE:
        r = rapporto[e]
        if r:
            print(f'   {e[0]:2d}:{e[1]:02d}  n {len(r):3d}  mediana {st.median(r):.2f}  (min {min(r):.2f} max {max(r):.2f})')

    print('\n3. STESSA VENDITA SU 3,5 ANNI CON IL PREZZO STIMATO DAL VIX1D x RAPPORTO MEDIANO, meno 10% (il bid)')
    anni = defaultdict(lambda: defaultdict(list))
    for g in sorted(spx5):
        ch = spx5[g].get(955)
        if ch is None:
            continue
        for hh, mm in ENTRATE:
            m = hh * 60 + mm
            r = rapporto[(hh, mm)]
            if len(r) < 5:
                continue
            spot = spx5[g].get(m - 5)
            vv = v1.get(g, {}).get(m - 5)
            if not spot or not vv:
                continue
            premio = 0.9 * st.median(r) * 0.8 * spot * vv / 100 * math.sqrt((960 - m) / (390 * 252))
            anni[(hh, mm)][g[:4]].append(premio - abs(ch - spot))
    for e in ENTRATE:
        if not anni[e]:
            continue
        print(f'   entrata {e[0]:2d}:{e[1]:02d}')
        for a in sorted(anni[e]):
            print(f'      {a}  {riass(anni[e][a])}')


if __name__ == '__main__':
    main()
