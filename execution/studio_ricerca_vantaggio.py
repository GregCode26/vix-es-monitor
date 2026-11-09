"""
Ricerca di un vantaggio operativo su SPX intraday, con verifica fuori campione.

    python execution/studio_ricerca_vantaggio.py [--costo 0.5] [--tutte]

Dati: barre da 5 minuti RTH di SPX, VIX, VIX1D da maggio 2023 (cache di
studio_vol_intraday.py in .tmp/studio_vol_intraday/), nessuna richiesta a IBKR.

Metodo (fissato PRIMA di guardare i risultati):
  - famiglie di regole classiche con griglie piccole di parametri;
  - RICERCA 2023-05..2024-12, CONFERMA 2025, TEST 2026 (mai usato per scegliere);
  - candidata = t >= 2 nella ricerca E stesso verso con t >= 1.5 nella conferma;
  - il test 2026 si stampa solo per le candidate, e non cambia la scelta;
  - P&L in punti SPX per trade, netto di `--costo` (andata e ritorno, su ES);
    entrata alla chiusura della barra che da' il segnale.
Il numero totale di regole provate e' stampato: con N prove, ~5% passa la
ricerca per caso, ~5% di quelle anche la conferma.
"""

import argparse
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


def carica(simbolo):
    barre = {}
    for f in sorted(glob.glob(os.path.join(CACHE, f'{simbolo}_*.json'))):
        for b in json.load(open(f)):
            barre[b['t']] = b
    giorni = defaultdict(list)
    for t in sorted(barre):
        d = datetime.fromtimestamp(t, NY)
        m = d.hour * 60 + d.minute
        if 570 <= m < 960:
            giorni[d.date().isoformat()].append({**barre[t], 'm': m})
    return giorni


def periodo(g):
    return 'R' if g < '2025-01-01' else 'C' if g < '2026-01-01' else 'T'


class Giorno:
    def __init__(self, g, spx, vix1d, vix, prec):
        self.g = g
        self.b = spx
        self.idx = {b['m']: i for i, b in enumerate(spx)}
        self.v1 = {b['m']: b['c'] for b in vix1d}
        self.vx = {b['m']: b['c'] for b in vix}
        self.prec = prec  # chiusura del giorno prima
        self.apertura = spx[0]['o']
        self.chiusura = spx[-1]['c']
        self.wd = datetime.fromisoformat(g).weekday()

    def c(self, m):
        """Chiusura della barra che inizia al minuto m (cioe' prezzo alle m+5)."""
        i = self.idx.get(m)
        return self.b[i]['c'] if i is not None else None

    def sigma_giorno(self, m):
        """1 sigma del giorno in punti dal VIX1D della barra prima (non si guarda avanti)."""
        v = None
        for mm in range(m, 560, -5):
            if mm in self.v1:
                v = self.v1[mm]
                break
        if v is None:
            return None
        return self.c(m) * v / 100 / math.sqrt(252) if self.c(m) else None

    def percorso(self, da_m, a_m):
        """Barre con inizio in (da_m, a_m)."""
        return [b for b in self.b if da_m < b['m'] < a_m]


def esegui(gg, entrata_m, verso, uscita_m, stop=None, target=None):
    """P&L lordo in punti. Entrata alla chiusura della barra entrata_m, uscita alla chiusura di uscita_m
    (o all'ultima barra), stop/target su massimi e minimi delle barre in mezzo (stop prima, prudente)."""
    e = gg.c(entrata_m)
    if e is None:
        return None
    for b in gg.b:
        if b['m'] <= entrata_m:
            continue
        if b['m'] > uscita_m:
            break
        if stop is not None:
            if (verso > 0 and b['l'] <= stop) or (verso < 0 and b['h'] >= stop):
                return (stop - e) * verso
        if target is not None:
            if (verso > 0 and b['h'] >= target) or (verso < 0 and b['l'] <= target):
                return (target - e) * verso
        u = b['c']
    else:
        u = gg.chiusura
    try:
        return (u - e) * verso
    except NameError:
        return None


# ---------------------------------------------------------------- famiglie
def regole():
    R = []

    # 1. Rottura del range di apertura (ORB), in entrambi i versi (segue / sfuma).
    for orm in (15, 30, 60):
        for uscita in ('chiusura', 60, 120):
            for con_stop in (False, True):
                for segno in (1, -1):
                    def f(gg, orm=orm, uscita=uscita, con_stop=con_stop, segno=segno):
                        rng = [b for b in gg.b if b['m'] < 570 + orm]
                        if len(rng) < orm // 5:
                            return None
                        hi, lo = max(b['h'] for b in rng), min(b['l'] for b in rng)
                        for b in gg.b:
                            if b['m'] < 570 + orm or b['m'] > 720:
                                continue
                            v = 1 if b['c'] > hi else -1 if b['c'] < lo else 0
                            if v:
                                v *= segno
                                usc = 955 if uscita == 'chiusura' else min(955, b['m'] + uscita)
                                stp = (lo if v > 0 else hi) if con_stop and segno == 1 else None
                                return esegui(gg, b['m'], v, usc, stop=stp)
                        return None
                    R.append((f'ORB {orm}m uscita {uscita}{" stop" if con_stop else ""} {"segue" if segno > 0 else "sfuma"}', f))

    # 2. Gap in sigma: sfuma (o segue) dall'apertura.
    for k in (0.25, 0.5, 1.0):
        for uscita in (600, 660, 955, 'chiude gap'):
            for segno in (-1, 1):
                def f(gg, k=k, uscita=uscita, segno=segno):
                    if gg.prec is None:
                        return None
                    s = gg.sigma_giorno(570)
                    if not s:
                        return None
                    gap = gg.c(570) - gg.prec
                    if abs(gap) < k * s:
                        return None
                    v = (1 if gap > 0 else -1) * segno
                    if uscita == 'chiude gap':
                        return esegui(gg, 570, v, 955, target=gg.prec if segno < 0 else None)
                    return esegui(gg, 570, v, uscita)
                R.append((f'gap >= {k} sigma {"sfuma" if segno < 0 else "segue"} uscita {uscita}', f))

    # 3. Momentum intraday (Gao et al.): prima mezz'ora (e/o 15:00-15:30) -> ultima mezz'ora.
    for base in ('prima', 'penultima', 'entrambe'):
        for segno in (1, -1):
            def f(gg, base=base, segno=segno):
                a, p1, p2 = gg.c(595), gg.c(895), gg.c(925)
                if None in (a, p1, p2) or gg.prec is None:
                    return None
                r1 = a - gg.prec  # dal close di ieri alle 10:00, come nell'articolo
                r2 = p2 - p1
                if base == 'prima':
                    v = r1
                elif base == 'penultima':
                    v = r2
                else:
                    if r1 * r2 <= 0:
                        return None
                    v = r1
                if v == 0:
                    return None
                return esegui(gg, 925, (1 if v > 0 else -1) * segno, 955)
            R.append((f'momentum intraday {base} -> ultima mezz\'ora {"segue" if segno > 0 else "contro"}', f))

    # 4. Movimento grande su 30 minuti in sigma: inversione o continuazione.
    for k in (1.0, 1.5, 2.0):
        for h in (30, 60):
            for segno in (-1, 1):
                def f(gg, k=k, h=h, segno=segno):
                    out = []
                    ultimo = -999
                    for b in gg.b:
                        m = b['m']
                        if m < 600 or m > 900 or m - ultimo < 30:
                            continue
                        p0, p1 = gg.c(m - 30), gg.c(m)
                        s = gg.sigma_giorno(m)
                        if None in (p0, p1) or not s:
                            continue
                        s30 = s * math.sqrt(30 / 390)
                        mossa = (p1 - p0) / s30
                        if abs(mossa) >= k:
                            r = esegui(gg, m, (1 if mossa > 0 else -1) * segno, min(955, m + h))
                            if r is not None:
                                out.append(r)
                                ultimo = m
                    return out or None
                R.append((f'mossa 30m >= {k} sigma {"inversione" if segno < 0 else "continua"} {h}m', f))

    # 5. Posizione nel range della giornata a un'ora fissa -> fino alla chiusura.
    for ora in (660, 780, 870):
        for quota in (0.1, 0.2):
            for segno in (1, -1):
                def f(gg, ora=ora, quota=quota, segno=segno):
                    fin = [b for b in gg.b if b['m'] <= ora]
                    if len(fin) < 6:
                        return None
                    hi, lo, p = max(b['h'] for b in fin), min(b['l'] for b in fin), gg.c(ora)
                    if p is None or hi - lo <= 0:
                        return None
                    pos = (p - lo) / (hi - lo)
                    if pos >= 1 - quota:
                        v = 1
                    elif pos <= quota:
                        v = -1
                    else:
                        return None
                    return esegui(gg, ora, v * segno, 955)
                R.append((f'vicino a max/min del giorno alle {ora // 60}:{ora % 60:02d} ({int(quota * 100)}%) {"segue" if segno > 0 else "contro"}', f))

    # 6. SPX e VIX nello stesso verso dall'apertura (anomalia): chi ha ragione?
    for ora in (630, 720, 840):
        for segno in (1, -1):
            def f(gg, ora=ora, segno=segno):
                p0, p1 = gg.c(570), gg.c(ora)
                v0, v1 = gg.vx.get(570), gg.vx.get(ora)
                s = gg.sigma_giorno(570)
                if None in (p0, p1, v0, v1) or not s:
                    return None
                dp, dv = (p1 - p0) / s, v1 - v0
                if dp > 0.25 and dv > 0.3:
                    v = -1   # SPX su ma VIX su: il VIX "non ci crede" -> giu'
                elif dp < -0.25 and dv < -0.3:
                    v = 1
                else:
                    return None
                return esegui(gg, ora, v * segno, 955)
            R.append((f'SPX e VIX concordi alle {ora // 60}:{ora % 60:02d} -> {"segue il VIX" if segno > 0 else "segue SPX"} fino a chiusura', f))

    # 7. Giorno prima molto mosso -> oggi apertura-chiusura.
    for k in (1.0, 1.5):
        for segno in (1, -1):
            def f(gg, k=k, segno=segno):
                if gg.prev_mossa is None:
                    return None
                if abs(gg.prev_mossa) < k:
                    return None
                return esegui(gg, 570, (1 if gg.prev_mossa > 0 else -1) * segno, 955)
            R.append((f'ieri mossa >= {k} sigma -> oggi {"segue" if segno > 0 else "inverte"} apertura-chiusura', f))

    # 8. Giorno della settimana, apertura-chiusura long.
    for wd, nome in enumerate(('lun', 'mar', 'mer', 'gio', 'ven')):
        R.append((f'long apertura-chiusura il {nome}', lambda gg, wd=wd: esegui(gg, 570, 1, 955) if gg.wd == wd else None))

    # 9. Ultima ora: trend della giornata alle 15:00 -> chiusura.
    for k in (0.5, 1.0):
        for segno in (1, -1):
            def f(gg, k=k, segno=segno):
                p0, p1, s = gg.c(570), gg.c(895), gg.sigma_giorno(570)
                if None in (p0, p1) or not s:
                    return None
                r = (p1 - p0) / s
                if abs(r) < k:
                    return None
                return esegui(gg, 895, (1 if r > 0 else -1) * segno, 955)
            R.append((f'giornata gia\' mossa >= {k} sigma alle 15:00 -> {"segue" if segno > 0 else "inverte"} fino a chiusura', f))

    # 10. VIX1D che sale con SPX fermo (+/- 0.25 sigma) entro le 12: tensione -> verso?
    for segno in (1, -1):
        def f(gg, segno=segno):
            p0, p1, s = gg.c(570), gg.c(720), gg.sigma_giorno(570)
            v0, v1 = gg.v1.get(570), gg.v1.get(720)
            if None in (p0, p1, v0, v1) or not s:
                return None
            if abs(p1 - p0) > 0.25 * s or v1 - v0 < 1.0:
                return None
            return esegui(gg, 720, -1 * segno, 955)
        R.append((f'VIX1D +1 con SPX fermo alle 12 -> {"short" if segno > 0 else "long"} fino a chiusura', f))
    return R


def statistiche(v):
    if len(v) < 8:
        return None
    m = st.mean(v)
    sd = st.stdev(v)
    return {'n': len(v), 'm': m, 't': m / (sd / math.sqrt(len(v))) if sd else 0, 'hit': sum(x > 0 for x in v) / len(v)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--costo', type=float, default=0.5, help='punti per trade, andata e ritorno')
    ap.add_argument('--tutte', action='store_true', help='stampa tutte le regole, non solo le candidate')
    a = ap.parse_args()

    spx, v1, vx = carica('SPX'), carica('VIX1D'), carica('VIX')
    nomi = sorted(g for g in spx if len(spx[g]) >= 70)
    giorni, prec, prec_s = [], None, None
    for g in nomi:
        gg = Giorno(g, spx[g], v1.get(g, []), vx.get(g, []), prec)
        s = gg.sigma_giorno(570)
        gg.prev_mossa = prec_s
        giorni.append(gg)
        prec = gg.chiusura
        prec_s = (gg.chiusura - gg.apertura) / s if s else None
    print(f'giorni: {len(giorni)} ({giorni[0].g} .. {giorni[-1].g}); '
          f'ricerca {sum(periodo(x.g) == "R" for x in giorni)}, conferma {sum(periodo(x.g) == "C" for x in giorni)}, '
          f'test {sum(periodo(x.g) == "T" for x in giorni)}; costo {a.costo} pt per trade')

    R = regole()
    print(f'regole provate: {R.__len__()}  (per puro caso ne passano la ricerca ~{len(R) * 0.05:.0f}, '
          f'e la conferma ~{len(R) * 0.05 * 0.07:.1f})\n')
    candidate = []
    righe = []
    for nome, f in R:
        per = {'R': [], 'C': [], 'T': []}
        for gg in giorni:
            try:
                r = f(gg)
            except Exception:
                r = None
            if r is None:
                continue
            for x in (r if isinstance(r, list) else [r]):
                per[periodo(gg.g)].append(x - a.costo)
        sR, sC, sT = statistiche(per['R']), statistiche(per['C']), statistiche(per['T'])
        righe.append((nome, sR, sC, sT))
        if sR and sC and sR['t'] >= 2 and sC['t'] >= 1.5:
            candidate.append((nome, sR, sC, sT))

    def fmt(s):
        return '        n.d.          ' if not s else f"n {s['n']:4d} {s['m']:+6.2f} t {s['t']:+4.1f} {s['hit'] * 100:3.0f}%"

    if a.tutte:
        print(f'{"regola":78s} | {"RICERCA 2023-24":24s} | {"CONFERMA 2025":24s}')
        for nome, sR, sC, _ in sorted(righe, key=lambda x: -(x[1]['t'] if x[1] else -9)):
            print(f'{nome:78s} | {fmt(sR)} | {fmt(sC)}')
        print()
    passate_r = sum(1 for _, sR, _, _ in righe if sR and sR['t'] >= 2)
    print(f'passano la ricerca (t >= 2): {passate_r}; anche la conferma (t >= 1.5): {len(candidate)}\n')
    print(f'{"CANDIDATA":78s} | {"RICERCA 2023-24":24s} | {"CONFERMA 2025":24s} | {"TEST 2026 (mai usato)":24s}')
    for nome, sR, sC, sT in candidate:
        print(f'{nome:78s} | {fmt(sR)} | {fmt(sC)} | {fmt(sT)}')


if __name__ == '__main__':
    main()
