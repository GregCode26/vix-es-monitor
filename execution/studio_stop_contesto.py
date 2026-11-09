"""
Stop a contesto: quanto va contro una posizione, in multipli della volatilita' attesa?

    python execution/studio_stop_contesto.py

Barre 5m SPX + VIX1D (cache di studio_vol_intraday.py), maggio 2023 - oggi.
Per ogni barra fra le 9:45 e le 15:00 NY (ogni 15 minuti, per non contare
mille volte la stessa mossa) si guarda l'escursione CONTRO una posizione long e
una short nei 15/30/60 minuti dopo, sui massimi e minimi delle barre.

sigma_h = SPX x VIX1D/100 / sqrt(252) x sqrt(h / 390): il movimento di 1 sigma
che il VIX1D del momento prezza per h minuti.

1. Calibrazione 2023-24: multiplo di sigma_h che copre l'80/90/95% delle
   escursioni avverse, per fascia oraria.
2. Verifica 2025-26: quante volte uno stop a quel multiplo viene davvero
   toccato, per terzile di VIX1D. Confronto con uno stop FISSO in punti con la
   stessa frequenza media nel 2023-24: se il contesto serve, lo stop a contesto
   tiene la frequenza stabile fra giorni calmi e agitati, quello fisso no.
"""

import glob
import json
import math
import os
import statistics as st
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

CACHE = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_vol_intraday')
NY = ZoneInfo('America/New_York')
ORIZZONTI = (15, 30, 60)
COPERTURE = (0.80, 0.90, 0.95)
FASCE = ((585, 630, '9:45-10:30'), (630, 720, '10:30-12:00'), (720, 840, '12:00-14:00'), (840, 905, '14:00-15:00'))


def carica(simbolo):
    out = defaultdict(dict)
    for f in glob.glob(os.path.join(CACHE, f'{simbolo}_*.json')):
        for b in json.load(open(f)):
            d = datetime.fromtimestamp(b['t'], NY)
            m = d.hour * 60 + d.minute
            if 570 <= m < 960:
                out[d.date().isoformat()][m] = b
    return out


def quantile(v, q):
    s = sorted(v)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]


def fascia(m):
    for a, b, nome in FASCE:
        if a <= m < b:
            return nome
    return None


def main():
    spx, v1 = carica('SPX'), carica('VIX1D')
    campioni = []  # (giorno, minuto, fascia, vix1d, sigma_h per h, escursioni avverse in punti per h e lato)
    for g in sorted(spx):
        barre = spx[g]
        for m in range(585, 905, 15):
            if m not in barre:
                continue
            b1 = v1.get(g, {}).get(m) or v1.get(g, {}).get(m - 5)
            if not b1:
                continue
            vv = b1['c']
            p = barre[m]['c']
            sd = p * vv / 100 / math.sqrt(252)
            riga = {'g': g, 'm': m, 'fascia': fascia(m), 'vix1d': vv}
            ok = True
            for h in ORIZZONTI:
                dopo = [barre[x] for x in range(m + 5, m + h + 1, 5) if x in barre]
                if len(dopo) < h // 5 - 1:
                    ok = False
                    break
                riga[f's{h}'] = sd * math.sqrt(h / 390)
                riga[f'long{h}'] = max(0.0, p - min(b['l'] for b in dopo))
                riga[f'short{h}'] = max(0.0, max(b['h'] for b in dopo) - p)
            if ok:
                campioni.append(riga)

    cal = [c for c in campioni if c['g'] < '2025-01-01']
    ver = [c for c in campioni if c['g'] >= '2025-01-01']
    print(f'campioni ogni 15 min: calibrazione 2023-24 {len(cal)}, verifica 2025-26 {len(ver)}')

    # Terzili di VIX1D fissati sulla calibrazione.
    t1, t2 = quantile([c['vix1d'] for c in cal], 1 / 3), quantile([c['vix1d'] for c in cal], 2 / 3)
    terzile = lambda v: 'calmo' if v < t1 else 'medio' if v < t2 else 'agitato'
    print(f'terzili VIX1D (2023-24): calmo < {t1:.1f} <= medio < {t2:.1f} <= agitato\n')

    print('1. MULTIPLO DI SIGMA_h CHE COPRE L\'ESCURSIONE CONTRO (long e short insieme), calibrazione 2023-24')
    multipli = {}
    for h in ORIZZONTI:
        for _, _, nome in FASCE + ((0, 0, 'tutte'),):
            sel = [c for c in cal if nome == 'tutte' or c['fascia'] == nome]
            x = [c[f'{lato}{h}'] / c[f's{h}'] for c in sel for lato in ('long', 'short')]
            if not x:
                continue
            multipli[(h, nome)] = {q: quantile(x, q) for q in COPERTURE}
            punti = [c[f's{h}'] for c in sel]
            print(f'   {h:2d} min  {nome:12s}  80% {multipli[(h, nome)][0.8]:.2f}  90% {multipli[(h, nome)][0.9]:.2f}  '
                  f'95% {multipli[(h, nome)][0.95]:.2f}  sigma_h tipica {st.median(punti):.1f} pt')

    print('\n2. VERIFICA 2025-26: % di volte che lo stop viene TOCCATO (atteso: 20% / 10% / 5%)')
    for h in ORIZZONTI:
        for q in COPERTURE:
            k = {nome: multipli[(h, nome)][q] for _, _, nome in FASCE}
            # Stop fisso con la stessa frequenza media nel 2023-24.
            fisso = quantile([c[f'{lato}{h}'] for c in cal for lato in ('long', 'short')], q)
            righe = []
            for nome_t in ('calmo', 'medio', 'agitato', 'tutti'):
                sel = [c for c in ver if nome_t == 'tutti' or terzile(c['vix1d']) == nome_t]
                n = len(sel) * 2
                ctx = sum(c[f'{lato}{h}'] > k[c['fascia']] * c[f's{h}'] for c in sel for lato in ('long', 'short')) / n * 100
                fix = sum(c[f'{lato}{h}'] > fisso for c in sel for lato in ('long', 'short')) / n * 100
                righe.append(f'{nome_t} {ctx:4.1f}% / {fix:4.1f}%')
            print(f'   {h:2d} min, copertura {int(q * 100)}% (stop fisso {fisso:4.1f} pt) - contesto / fisso:  ' + '   '.join(righe))

    print('\n3. ESEMPIO: stop al 90% per 30 minuti, con il VIX1D di ogni giorno (2026)')
    es = [c for c in ver if c['g'] >= '2026-01-01' and c['fascia'] == '10:30-12:00']
    for v in (10, 13, 16, 20, 25):
        sel = [c for c in es if abs(c['vix1d'] - v) < 1.5]
        if sel:
            k = multipli[(30, '10:30-12:00')][0.9]
            print(f'   VIX1D ~{v:2d}: stop {k * st.median([c["s30"] for c in sel]):5.1f} pt SPX (ES uguale)')


if __name__ == '__main__':
    main()
