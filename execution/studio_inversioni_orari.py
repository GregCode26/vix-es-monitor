"""
Studio: in quali orari avvengono le inversioni di ES da oltre 20/30/40/50 punti.

    python execution/studio_inversioni_orari.py [--json percorso]

Inversione da X punti = un massimo o minimo dopo il quale il prezzo va di almeno X punti nel verso
opposto prima di superarlo (zigzag con ritorno X). Si conta l'ora del massimo/minimo (il punto di
svolta) e anche quella in cui il ritorno di X punti e' fatto (la conferma: prima non si sa che e'
un'inversione).

Dati
- SPX a 5 minuti in cache (.tmp/studio_vol_intraday/, maggio 2023 - oggi, nessuna richiesta IBKR),
  solo cash 9:30-16:00 NY. Punti riportati al livello di oggi (movimento % x 7600), come in
  studio_es_pomeriggio.py. Ricerca 2023-2024, verifica 2025-2026.
- ES vero dai file locali frontend/data/market (un punto ogni ~15 s, barre da 1 minuto), anche fuori
  dal cash (dalle ~10 alle ~22 di Roma): per vedere le ore prima dell'apertura.

Orari in ora di Roma "normale" (NY + 6 h): le settimane sfasate di marzo e ottobre/novembre sono
riportate alle stesse fasce, cosi' l'apertura cash e' sempre 15:30.

Limiti: la prima svolta della giornata cash ha il prezzo della notte alle spalle (SPX non lo vede);
quelle vicine alla chiusura sono contate meno perche' manca il tempo per fare X punti dopo.
"""

import argparse
import glob
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_vol_intraday')
MARKET = os.path.join(RADICE, 'frontend', 'data', 'market')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
LIVELLO = 7600.0
SOGLIE = [20, 30, 40, 50]


def hhmm(m):
    return f'{m // 60:02d}:{m % 60:02d}'


def zigzag(barre, x):
    """barre = [(minuto, h, l)]. -> [(minuto svolta, 'max'|'min', minuto conferma, ampiezza swing successivo)]"""
    out = []
    if not barre:
        return out
    hi, thi = barre[0][1], barre[0][0]
    lo, tlo = barre[0][2], barre[0][0]
    verso = 0
    for m, h, l in barre[1:]:
        if verso == 0:
            if h > hi:
                hi, thi = h, m
            if l < lo:
                lo, tlo = l, m
            if hi - l >= x and thi < m:
                out.append([thi, 'max', m, hi]); verso, ext, text = -1, l, m
            elif h - lo >= x and tlo < m:
                out.append([tlo, 'min', m, lo]); verso, ext, text = 1, h, m
        elif verso == 1:
            if h > ext:
                ext, text = h, m
            elif ext - l >= x:
                out.append([text, 'max', m, ext]); verso, ext, text = -1, l, m
        else:
            if l < ext:
                ext, text = l, m
            elif h - ext >= x:
                out.append([text, 'min', m, ext]); verso, ext, text = 1, h, m
    return out


def spx_giorni():
    righe = {}
    for f in glob.glob(os.path.join(CACHE, 'SPX_*.json')):
        for r in json.load(open(f)):
            righe[r['t']] = r
    giorni = defaultdict(list)
    for t in sorted(righe):
        b = righe[t]
        n = datetime.fromtimestamp(t, tz=timezone.utc).astimezone(NY)
        m = n.hour * 60 + n.minute
        if 9 * 60 + 30 <= m < 16 * 60:
            giorni[n.date().isoformat()].append((m + 360, b['h'], b['l'], b['c']))  # NY + 6 h
    return {g: b for g, b in giorni.items() if len(b) >= 70}


def es_giorni():
    giorni = {}
    for f in sorted(glob.glob(os.path.join(MARKET, '20*.json'))):
        g = os.path.basename(f)[:10]
        try:
            p = json.load(open(f))
        except Exception:
            continue
        if not isinstance(p, list):
            continue
        minuti = {}
        for x in p:
            if not x.get('esf'):
                continue
            dt = datetime.fromisoformat(f'{g}T{x["time"]}').replace(tzinfo=ROMA)
            n = dt.astimezone(NY)
            m = n.hour * 60 + n.minute + 360
            b = minuti.setdefault(m, [x['esf'], x['esf']])
            b[0] = max(b[0], x['esf']); b[1] = min(b[1], x['esf'])
        if len(minuti) >= 300:
            giorni[g] = [(m, h, l, None) for m, (h, l) in sorted(minuti.items())]
    return giorni


def conta(giorni, scala, fascia=30):
    """{soglia: {'svolte': {fascia: n}, 'conferme': {...}, 'max'/'min': {...}, 'ritardi': [...], 'sedute': n}}"""
    res = {}
    for x in SOGLIE:
        r = {'svolte': defaultdict(int), 'conferme': defaultdict(int), 'max': defaultdict(int), 'min': defaultdict(int),
             'ritardi': defaultdict(list), 'sedute': len(giorni), 'prima': defaultdict(int), 'per_seduta': [],
             'apertura': 0}
        for g, b in giorni.items():
            k = scala(b)
            sw = zigzag([(m, h * k, l * k) for m, h, l, _ in b], x)
            if sw and sw[0][0] == b[0][0]:
                # il primo prezzo della seduta e' il massimo/minimo prima di X punti: non e' un'inversione
                # vista nei dati (la notte non c'e'), si conta a parte
                r['apertura'] += 1
                sw = sw[1:]
            r['per_seduta'].append(len(sw))
            for i, (t, tipo, tc, _) in enumerate(sw):
                f = t // fascia * fascia
                r['svolte'][f] += 1; r[tipo][f] += 1
                r['conferme'][tc // fascia * fascia] += 1
                r['ritardi'][f].append(tc - t)
                if i == 0:
                    r['prima'][f] += 1
        res[x] = r
    return res


def mediana(v):
    v = sorted(v)
    return v[len(v) // 2] if v else None


def tabella(titolo, res, fasce):
    print(f'\n## {titolo}\n')
    print('Svolte ogni 100 sedute per fascia di 30 min (ora di Roma), per soglia; tra parentesi max/min.\n')
    print('| fascia | ' + ' | '.join(f'>={x} pt' for x in SOGLIE) + ' |')
    print('|---|' + '---|' * len(SOGLIE))
    for f in fasce:
        celle = []
        for x in SOGLIE:
            r = res[x]; n = r['sedute']
            celle.append(f"{100 * r['svolte'][f] / n:.0f} ({100 * r['max'][f] / n:.0f}/{100 * r['min'][f] / n:.0f})")
        print(f'| {hhmm(f)} | ' + ' | '.join(celle) + ' |')
    print('| primo prezzo = estremo (escluso) | ' + ' | '.join(f"{100 * res[x]['apertura'] / res[x]['sedute']:.0f}" for x in SOGLIE) + ' |')
    print('| per seduta | ' + ' | '.join(f"{sum(res[x]['per_seduta']) / res[x]['sedute']:.2f}" for x in SOGLIE) + ' |')
    print('| sedute con almeno una | ' + ' | '.join(
        f"{100 * sum(1 for v in res[x]['per_seduta'] if v) / res[x]['sedute']:.0f}%" for x in SOGLIE) + ' |')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json')
    a = ap.parse_args()
    spx = spx_giorni()
    scala = lambda b: LIVELLO / b[0][3]  # movimento % x 7600, dal primo prezzo della seduta
    fasce_cash = list(range(15 * 60 + 30, 22 * 60, 30))
    tutti = conta(spx, scala)
    ric = conta({g: b for g, b in spx.items() if g < '2025'}, scala)
    ver = conta({g: b for g, b in spx.items() if g >= '2025'}, scala)
    print(f'# Inversioni per orario\n\nSPX 5 min: {len(spx)} sedute {min(spx)} - {max(spx)}, punti scalati a {LIVELLO:.0f}.')
    tabella(f'SPX cash, tutte le {len(spx)} sedute', tutti, fasce_cash)
    tabella(f"Ricerca 2023-2024 ({ric[20]['sedute']} sedute)", ric, fasce_cash)
    tabella(f"Verifica 2025-2026 ({ver[20]['sedute']} sedute)", ver, fasce_cash)
    print('\n## Minuti dalla svolta alla conferma (mediana), tutte le sedute\n')
    print('| fascia | ' + ' | '.join(f'>={x}' for x in SOGLIE) + ' |')
    print('|---|' + '---|' * len(SOGLIE))
    for f in fasce_cash:
        print(f'| {hhmm(f)} | ' + ' | '.join(str(mediana(tutti[x]['ritardi'][f])) for x in SOGLIE) + ' |')
    print('\n## Quota delle svolte che sono la prima della seduta, per fascia (>=20 / >=30)\n')
    for f in fasce_cash[:4]:
        print(f"- {hhmm(f)}: {tutti[20]['prima'][f]}/{tutti[20]['svolte'][f]}, {tutti[30]['prima'][f]}/{tutti[30]['svolte'][f]}")
    es = es_giorni()
    fasce_es = sorted({f for r in conta(es, lambda b: 1.0).values() for f in r['svolte']})
    res_es = conta(es, lambda b: 1.0)
    tabella(f'ES vero, file locali ({len(es)} sedute {min(es)} - {max(es)}), anche fuori dal cash', res_es, fasce_es)
    if a.json:
        def ser(r):
            return {str(x): {k: ({hhmm(f): v for f, v in r[x][k].items()} if isinstance(r[x][k], dict) else r[x][k])
                             for k in ('svolte', 'conferme', 'max', 'min', 'sedute', 'per_seduta', 'apertura')} for x in SOGLIE}
        ritardi = {str(x): {hhmm(f): mediana(v) for f, v in tutti[x]['ritardi'].items()} for x in SOGLIE}
        json.dump({'spx': ser(tutti), 'ricerca': ser(ric), 'verifica': ser(ver), 'es': ser(res_es), 'ritardi': ritardi,
                   'periodo': [min(spx), max(spx)], 'es_periodo': [min(es), max(es)]}, open(a.json, 'w'))


if __name__ == '__main__':
    main()
