"""
Studio: la linea piu' alta della Serie Temporale di /hedging-pressure anticipa ES?

    python execution/studio_linea_alta.py [--dal YYYY-MM-DD] [--dettaglio]

Ipotesi dell'utente (12/11/2026): si prende la linea piu' in alto (la pressione
massima fra i top strike). Se il suo strike e' SOPRA l'ATM, quando la linea sale
il prezzo sale e quando scende il prezzo scende; se e' SOTTO l'ATM, al contrario.
Segnale = segno(variazione della linea su K minuti) x (+1 sopra, -1 sotto).

Serve la dashboard in locale: la serie di ogni giorno viene da
/api/hedging-pressure?storia=1&date=YYYY-MM-DD (solo file locali), come in
studio_rombi_serie.py. ES e SPX dal file di /market.

ATTENZIONE, perche' il confronto con il momentum e' obbligatorio: nella route
la pressione e' gex x (spot - spot di apertura) x vicinanza, quindi la linea
contiene il prezzo. Se il segnale coincide quasi sempre con "il prezzo ha fatto
lo stesso negli ultimi K minuti", allora e' il momentum del prezzo e non dice
niente di nuovo: per questo si misura anche il caso in cui i due NON coincidono.
"""

import argparse
import glob
import json
import os
import urllib.request
from bisect import bisect_left
from datetime import date, datetime
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
LOOKBACK = (1, 2, 5)
ORIZZONTI = (1, 3, 5, 10)
COSTO = 0.25  # punti ES a trade, come le altre verifiche


def sec(hhmmss):
    h, m, s = (int(x) for x in hhmmss.split(':'))
    return h * 3600 + m * 60 + s


def finestra_cash(giorno):
    """Apertura e chiusura del cash 9:30-16:00 NY in secondi dell'ora di Roma."""
    out = []
    for hh, mm in ((9, 30), (16, 0)):
        ny = datetime.fromisoformat(f'{giorno}T{hh:02d}:{mm:02d}:00').replace(tzinfo=NY)
        r = ny.astimezone(ROMA)
        out.append(r.hour * 3600 + r.minute * 60)
    return out


def serie_del_giorno(giorno):
    url = f'http://localhost:3000/api/hedging-pressure?storia=1&date={giorno}'
    with urllib.request.urlopen(url, timeout=180) as r:
        d = json.load(r)
    if d.get('date') != giorno:
        return None
    per_strike = {}
    for p in (d.get('storia') or []) + (d.get('pressureHistory') or []):
        m = sec(p['time']) // 60 * 60  # al minuto: l'ultimo valore del minuto
        per_strike.setdefault(p['strike'], {})[m] = p['totalPressure']
    return per_strike


def market_del_giorno(giorno):
    try:
        with open(os.path.join(RADICE, 'market', f'{giorno}.json'), encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return None, None
    punti = d if isinstance(d, list) else d.get('data') or d.get('points') or []
    es = sorted((sec(p['time']), p['esf']) for p in punti if p.get('time') and p.get('esf'))
    spx = sorted((sec(p['time']), p['spx']) for p in punti if p.get('time') and p.get('spx'))
    return es, spx


def valore_a(serie, t, tolleranza=45):
    tempi = [x[0] for x in serie]
    i = bisect_left(tempi, t)
    migliore = None
    for k in (i - 1, i):
        if 0 <= k < len(serie) and abs(serie[k][0] - t) <= tolleranza:
            if migliore is None or abs(serie[k][0] - t) < abs(migliore[0] - t):
                migliore = serie[k]
    return migliore[1] if migliore else None


def segno(x):
    return (x > 0) - (x < 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', default='2026-09-01')
    ap.add_argument('--dettaglio', action='store_true')
    a = ap.parse_args()
    oggi = date.today().isoformat()
    giorni = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'volumes', '????-??-??.json'))
                    if a.dal <= os.path.basename(f)[:10] < oggi)

    # eventi[k] = lista di dict con segnale, momentum e ritorni futuri
    eventi = {k: [] for k in LOOKBACK}
    per_giorno = {}
    for g in giorni:
        es, spx = market_del_giorno(g)
        if not es or not spx:
            continue
        try:
            ps = serie_del_giorno(g)
        except Exception as e:
            print(f'{g}: route non disponibile ({e})')
            continue
        if not ps:
            continue
        apre, chiude = finestra_cash(g)
        minuti = sorted({m for v in ps.values() for m in v})
        for t in minuti:
            if t < apre + 5 * 60 or t > chiude - 10 * 60:
                continue
            ora = {k: v[t] for k, v in ps.items() if t in v}
            if not ora:
                continue
            alto = max(ora, key=lambda k: ora[k])
            s0, e0 = valore_a(spx, t), valore_a(es, t)
            if s0 is None or e0 is None:
                continue
            lato = 1 if alto > s0 else -1
            for k in LOOKBACK:
                prima = ps[alto].get(t - k * 60)
                ep = valore_a(es, t - k * 60)
                if prima is None or ep is None:
                    continue
                dv = ora[alto] - prima
                if dv == 0:
                    continue
                fut = {}
                for h in ORIZZONTI:
                    eh = valore_a(es, t + h * 60)
                    if eh is not None:
                        fut[h] = eh - e0
                if not fut:
                    continue
                ev = {'g': g, 't': t, 'seg': segno(dv) * lato, 'mom': segno(e0 - ep), 'passato': e0 - ep,
                      'fut': fut, 'lato': lato}
                eventi[k].append(ev)
                if k == 2:
                    per_giorno.setdefault(g, []).append(ev)

    def riga(nome, evs, h):
        xs = [e['seg'] * e['fut'][h] for e in evs if h in e['fut']]
        if not xs:
            return f'  {nome:<34} {h:>3}m      n 0'
        giusti = sum(1 for x in xs if x > 0) / len(xs)
        media = sum(xs) / len(xs)
        sd = (sum((x - media) ** 2 for x in xs) / max(1, len(xs) - 1)) ** 0.5
        t = media / (sd / len(xs) ** 0.5) if sd > 0 else 0
        return f'  {nome:<34} {h:>3}m  n {len(xs):>6}  giusti {giusti:5.1%}  media {media:+6.2f} pt  t {t:+5.1f}'

    print(f'Giorni: {len(per_giorno)}  ({min(per_giorno) if per_giorno else "-"} .. {max(per_giorno) if per_giorno else "-"})')
    print('Ogni minuto del cash (9:35-15:50 NY), linea = strike con la pressione piu\' alta in quel minuto.\n')
    for k in LOOKBACK:
        evs = eventi[k]
        if not evs:
            continue
        conc = sum(1 for e in evs if e['mom'] != 0 and e['seg'] == e['mom']) / max(1, sum(1 for e in evs if e['mom'] != 0))
        print(f'=== variazione della linea su {k} min: il segnale coincide con il movimento di ES '
              f'degli stessi {k} min nel {conc:.0%} dei casi')
        for h in ORIZZONTI:
            print(riga('regola utente (tutti)', evs, h))
        for h in ORIZZONTI:
            print(riga('  linea sopra l\'ATM', [e for e in evs if e['lato'] > 0], h))
        for h in ORIZZONTI:
            print(riga('  linea sotto l\'ATM', [e for e in evs if e['lato'] < 0], h))
        mom = [dict(e, seg=e['mom']) for e in evs if e['mom'] != 0]
        for h in ORIZZONTI:
            print(riga('confronto: solo momentum ES', mom, h))
        diversi = [e for e in evs if e['mom'] != 0 and e['seg'] != e['mom']]
        for h in ORIZZONTI:
            print(riga('regola quando DISCORDA dal momentum', diversi, h))
        for h in ORIZZONTI:
            print(riga('  discorda, linea sotto ATM', [e for e in diversi if e['lato'] < 0], h))
        meta = sorted({e['g'] for e in evs})
        meta = meta[len(meta) // 2] if meta else ''
        for h in (5, 10):
            print(riga('  prima meta dei giorni', [e for e in evs if e['g'] < meta], h))
            print(riga('  seconda meta dei giorni', [e for e in evs if e['g'] >= meta], h))
        print()

    # Operabile? Ingresso al cambio di segnale (k=2), uscita dopo 5 min, costo.
    print('=== operabile: ingresso quando il segnale (2 min) cambia verso, uscita a 5 min, '
          f'costo {COSTO} pt')
    tot, giorni_pos = 0.0, 0
    for g, evs in sorted(per_giorno.items()):
        prec, ultimo_t, pnl, n = 0, -10 ** 9, 0.0, 0
        for e in evs:
            if e['seg'] != prec and e['t'] >= ultimo_t + 5 * 60 and 5 in e['fut']:
                pnl += e['seg'] * e['fut'][5] - COSTO
                n += 1
                ultimo_t = e['t']
            prec = e['seg']
        tot += pnl
        giorni_pos += pnl > 0
        if a.dettaglio:
            print(f'  {g}: {n:>3} trade  {pnl:+7.2f} pt')
    print(f'  totale {tot:+.2f} pt su {len(per_giorno)} giorni, positivi {giorni_pos}')


if __name__ == '__main__':
    main()
