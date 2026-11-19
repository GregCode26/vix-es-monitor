"""
Studio: alle 13:00 di Roma ES inverte piu' spesso che nelle altre ore? (domanda dell'utente, 16/11/2026)

    python execution/studio_inversione_13.py --piano     # richieste IBKR e tempo, senza connettersi
    python execution/studio_inversione_13.py --scarica   # barre ES 5 min, 24 ore, contratti trimestrali
    python execution/studio_inversione_13.py             # report su stdout

Dati: barre ES a 5 minuti con useRTH=False (tutta la notte), per ogni contratto trimestrale solo nel
periodo in cui era il primo (rollover 8 giorni prima della scadenza). IBKR tiene i futures scaduti
per circa 2 anni. Una richiesta = 1 mese di un contratto; ritmo della classe Ritmo di studio_vol.py.
Cache in .tmp/studio_inversione_13/.

Misure, per mezz'ora di Roma (ora vera, quella che l'utente guarda), 9:00-15:30, giorni lun-ven:
1. Svolte zigzag da 5/10/15/20 punti ogni 100 sedute, per ora del massimo/minimo.
2. Lo stesso diviso per il range medio della mezz'ora: piu' svolte dove il mercato si muove di piu'
   e' scontato, conta se una fascia gira piu' di quanto si muove.
3. Inversione dell'ora: il movimento dell'ora prima di H contro quello dell'ora dopo H. Correlazione
   negativa = a H il prezzo tende a girare. Anche la quota di ore con segni opposti e il caso in cui
   l'ora prima ha fatto almeno 10 punti.
Il tutto anche per ora di New York (le settimane sfasate di marzo e ottobre/novembre spostano le 13:00
di Roma dalle 7:00 alle 8:00 di NY) e diviso in due meta' per vedere se tiene.
"""

import json
import math
import os
import random
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from studio_vol import Ritmo, MAX_FINESTRA, FINESTRA, GAP_MIN, ATTESA_PACING  # noqa: E402

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_inversione_13')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
STIMA_RISPOSTA = 6.0
SOGLIE = [5, 10, 15, 20]
DA, A = 9 * 60, 15 * 60 + 30


def terzo_venerdi(a, m):
    d = date(a, m, 15)
    return d + timedelta(days=(4 - d.weekday()) % 7)


def contratti():
    """[(mese 'YYYYMM', inizio primo, fine primo)] dal dicembre 2024 al contratto attuale."""
    trimestri = []
    for a in (2024, 2025, 2026, 2027):
        for m in (3, 6, 9, 12):
            trimestri.append((a, m))
    out = []
    for i in range(1, len(trimestri)):
        a, m = trimestri[i]; pa, pm = trimestri[i - 1]
        inizio = terzo_venerdi(pa, pm) - timedelta(days=8)
        fine = terzo_venerdi(a, m) - timedelta(days=8)
        if fine < date(2024, 12, 20) or inizio > date.today():
            continue
        out.append((f'{a}{m:02d}', max(inizio, date(2024, 11, 18)), min(fine, date.today())))
    return out


def pezzi():
    """[(contratto, fine richiesta)] un mese per volta dentro il periodo da primo."""
    out = []
    for c, ini, fin in contratti():
        e = fin
        while True:
            out.append((c, e))
            if e - timedelta(days=30) <= ini:
                break
            e -= timedelta(days=30)
    return out


def file_pezzo(c, e):
    return os.path.join(CACHE, f'ES_{c}_{e.isoformat()}.json')


def da_scaricare(c, e):
    f = file_pezzo(c, e)
    if not os.path.exists(f):
        return True
    return e >= date.today() and datetime.fromtimestamp(os.path.getmtime(f)).date() < date.today()


def piano():
    p = pezzi(); n = sum(1 for c, e in p if da_scaricare(c, e))
    pause = max(0, math.ceil(n / MAX_FINESTRA) - 1)
    stima = n * max(GAP_MIN, STIMA_RISPOSTA) + pause * FINESTRA
    print(f'Piano richieste IBKR: {n} da fare su {len(p)} (le altre in cache)')
    print(f'  contratti: {", ".join(f"ES {c} {i}..{f}" for c, i, f in contratti())}')
    print(f'  ogni richiesta: barre 5 min, 1 mese, TRADES, useRTH=False')
    print(f'  limite usato: {MAX_FINESTRA} ogni {FINESTRA // 60} min (IBKR 60), almeno {GAP_MIN:.0f} s fra due richieste')
    print(f'  tempo stimato: ~{stima / 60:.0f} min')
    return n


def scarica():
    from ib_insync import IB, Future
    os.makedirs(CACHE, exist_ok=True)
    if not piano():
        return
    ib = IB(); ritmo = Ritmo()
    ib.connect('127.0.0.1', 7496, clientId=random.randint(20000, 29999), timeout=15, readonly=True)
    errori = []
    ib.errorEvent += lambda reqId, code, msg, c=None: errori.append((code, msg))
    qual = {}
    try:
        for c, e in pezzi():
            if not da_scaricare(c, e):
                continue
            if c not in qual:
                fut = Future('ES', c, 'CME', currency='USD', includeExpired=True)
                q = ib.qualifyContracts(fut)
                if not q:
                    print(f'  ES {c}: contratto non trovato, salto'); qual[c] = None; continue
                qual[c] = q[0]
            if qual[c] is None:
                continue
            fine = datetime(e.year, e.month, e.day, 23, 59, 0, tzinfo=timezone.utc).strftime('%Y%m%d-%H:%M:%S')
            for tentativo in (1, 2):
                ritmo.aspetta(); errori.clear()
                barre = ib.reqHistoricalData(qual[c], endDateTime=fine, durationStr='1 M', barSizeSetting='5 mins',
                                             whatToShow='TRADES', useRTH=False, formatDate=2, timeout=120)
                if any(code in (162, 366) and 'pacing' in msg.lower() for code, msg in errori) and tentativo == 1:
                    print(f'  violazione di ritmo, attendo {ATTESA_PACING // 60} min'); import time; time.sleep(ATTESA_PACING); continue
                break
            righe = [{'t': int(b.date.timestamp()), 'o': b.open, 'h': b.high, 'l': b.low, 'c': b.close} for b in (barre or [])]
            json.dump(righe, open(file_pezzo(c, e), 'w'))
            print(f'  [{ritmo.fatte}] ES {c} fino al {e}: {len(righe)} barre' + (f' ({errori[-1][1][:80]})' if not righe and errori else ''))
    finally:
        ib.disconnect()


def carica():
    barre = {}
    finestre = {c: (i, f) for c, i, f in contratti()}
    for c, e in pezzi():
        f = file_pezzo(c, e)
        if not os.path.exists(f):
            continue
        ini, fin = finestre[c]
        for r in json.load(open(f)):
            d = datetime.fromtimestamp(r['t'], tz=timezone.utc).astimezone(ROMA).date()
            if ini <= d < fin or (fin >= date.today() and d <= fin):
                barre[r['t']] = r
    return [barre[t] for t in sorted(barre)]


def zigzag(b, x):
    out = []
    hi, thi, lo, tlo = b[0][1], b[0][0], b[0][2], b[0][0]; verso = 0
    for m, h, l in b[1:]:
        if verso == 0:
            if h > hi: hi, thi = h, m
            if l < lo: lo, tlo = l, m
            if hi - l >= x and thi < m: out.append(thi); verso, ext, te = -1, l, m
            elif h - lo >= x and tlo < m: out.append(tlo); verso, ext, te = 1, h, m
        elif verso == 1:
            if h > ext: ext, te = h, m
            elif ext - l >= x: out.append(te); verso, ext, te = -1, l, m
        else:
            if l < ext: ext, te = l, m
            elif h - ext >= x: out.append(te); verso, ext, te = 1, h, m
    return out


def corr(xs, ys):
    n = len(xs)
    if n < 10: return float('nan')
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else float('nan')


def hhmm(m):
    return f'{m // 60:02d}:{m % 60:02d}'


def analizza():
    barre = carica()
    giorni = defaultdict(list)    # giorno Roma -> [(minuto Roma, h, l, c, minuto NY)]
    for r in barre:
        dt = datetime.fromtimestamp(r['t'], tz=timezone.utc)
        ro, ny = dt.astimezone(ROMA), dt.astimezone(NY)
        if ro.weekday() >= 5: continue
        giorni[ro.date().isoformat()].append((ro.hour * 60 + ro.minute, r['h'], r['l'], r['c'], ny.hour * 60 + ny.minute,
                                              (ro.utcoffset() - ny.utcoffset()).total_seconds() / 3600 != 6))
    giorni = {g: v for g, v in giorni.items() if sum(1 for x in v if DA <= x[0] < A) >= 70}
    tutti = sorted(giorni)
    meta = tutti[len(tutti) // 2]
    print(f'# Inversioni ES alle 13:00 di Roma\n\n{len(tutti)} sedute lun-ven {tutti[0]} - {tutti[-1]}, barre 5 min 24 h, '
          f'fasce in ora di Roma; prima meta\' fino al {meta}.\n')

    fasce = list(range(DA, A, 30))
    for nome, sel in (('tutte', tutti), ('prima meta\'', [g for g in tutti if g < meta]), ('seconda meta\'', [g for g in tutti if g >= meta])):
        cnt = {x: defaultdict(int) for x in SOGLIE}; rng = defaultdict(list)
        for g in sel:
            b = [x for x in giorni[g] if DA - 60 <= x[0] < A + 60]
            for x in SOGLIE:
                for t in zigzag([(m, h, l) for m, h, l, *_ in b], x):
                    if DA <= t < A: cnt[x][t // 30 * 30] += 1
            per = defaultdict(list)
            for m, h, l, *_ in b:
                if DA <= m < A: per[m // 30 * 30].append((h, l))
            for f, v in per.items():
                rng[f].append(max(h for h, _ in v) - min(l for _, l in v))
        n = len(sel)
        print(f'\n## Svolte ogni 100 sedute per mezz\'ora ({nome}, {n} sedute)\n')
        print('| fascia Roma | range medio (pt) | ' + ' | '.join(f'>={x}' for x in SOGLIE) + ' | >=10 per punto di range |')
        print('|---|---|' + '---|' * len(SOGLIE) + '---|')
        for f in fasce:
            r = sum(rng[f]) / len(rng[f]) if rng[f] else float('nan')
            print(f'| {hhmm(f)} | {r:.1f} | ' + ' | '.join(f'{100 * cnt[x][f] / n:.0f}' for x in SOGLIE) +
                  f' | {100 * cnt[10][f] / n / r:.1f} |')

    print('\n## L\'ora prima contro l\'ora dopo (inversione dell\'ora)\n')
    print('Correlazione fra il movimento di ES nei 60 minuti prima di H e nei 60 dopo; quota di casi con segno opposto; '
          'stessa cosa solo quando l\'ora prima ha fatto almeno 10 punti (ritorno medio dopo, in punti, nel verso opposto = positivo).\n')
    print('| H Roma | n | rho | segno opposto | n (>=10 pt prima) | opposto | ritorno medio (pt) | rho 1a meta\' | rho 2a meta\' |')
    print('|---|---|---|---|---|---|---|---|---|')
    for H in range(10 * 60, 15 * 60 + 1, 30):
        righe = []
        for g in tutti:
            px = {m: c for m, h, l, c, *_ in giorni[g]}
            a, b, c = px.get(H - 65), px.get(H - 5), px.get(H + 55)   # chiusura della barra prima di H-60, H, H+60
            if None not in (a, b, c):
                righe.append((g, b - a, c - b))
        if not righe: continue
        def rho(rr): return corr([p for _, p, _ in rr], [d for _, _, d in rr])
        opp = sum(1 for _, p, d in righe if p * d < 0) / len(righe)
        big = [(g, p, d) for g, p, d in righe if abs(p) >= 10]
        rit = sum(-d * (1 if p > 0 else -1) for _, p, d in big) / len(big) if big else float('nan')
        oppb = sum(1 for _, p, d in big if p * d < 0) / len(big) if big else float('nan')
        print(f'| {hhmm(H)} | {len(righe)} | {rho(righe):+.3f} | {100 * opp:.0f}% | {len(big)} | {100 * oppb:.0f}% | {rit:+.1f} | '
              f'{rho([r for r in righe if r[0] < meta]):+.3f} | {rho([r for r in righe if r[0] >= meta]):+.3f} |')

    print('\n## Settimane sfasate: le 13:00 di Roma sono le 8:00 di NY invece delle 7:00\n')
    for nome, filtro in (('normali (13:00 Roma = 7:00 NY)', False), ('sfasate (13:00 Roma = 8:00 NY)', True)):
        sel = [g for g in tutti if giorni[g][len(giorni[g]) // 2][5] == filtro]
        c = defaultdict(int)
        for g in sel:
            b = [x for x in giorni[g] if DA - 60 <= x[0] < A + 60]
            for t in zigzag([(m, h, l) for m, h, l, *_ in b], 10):
                if 12 * 60 <= t < 14 * 60 + 30: c[t // 30 * 30] += 1
        if sel:
            print(f'- {nome}: {len(sel)} sedute; svolte >=10 ogni 100 sedute: ' +
                  ', '.join(f'{hhmm(f)} {100 * c[f] / len(sel):.0f}' for f in range(12 * 60, 14 * 60 + 30, 30)))


if __name__ == '__main__':
    if '--piano' in sys.argv:
        piano()
    elif '--scarica' in sys.argv:
        scarica()
    else:
        analizza()
