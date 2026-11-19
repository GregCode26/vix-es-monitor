"""
Studio: come si comportano gli swing di ES quando SPX e' sopra lo Zero Gamma (gamma positivo)
e quando e' sotto (gamma negativo)?

    python execution/studio_zero_gamma_swing.py [--dal YYYY-MM-DD] [--json percorso]

Serve la dashboard in locale. Zero Gamma = traccia `poller` di /api/zero-gamma?date= (definizione
GEXBot "gex by volume", un valore al minuto dalle 9:30 NY, file locali). ES e SPX dal file di /market.

Teoria: sopra lo 0 gamma i dealer sono lunghi gamma e coprono contro il movimento (vendono i rialzi,
comprano i ribassi) -> swing piu' piccoli, piu' ritracciamenti; sotto sono corti gamma e coprono nel
verso del movimento -> swing piu' ampi e piu' trend.

Misure (solo cash 9:35-15:55 NY):
- swing: zigzag sui minuti di ES con soglia 3 e 6 punti; regime = lato al punto d'inizio dello swing;
- finestre di 15 minuti con regime costante: range, |movimento netto|, efficienza = netto / percorso,
  rapporto di varianza VR = var(rendimenti 5 min) / (5 var(rendimenti 1 min)): < 1 ritorno verso la
  media, > 1 trend. Il range e' anche diviso per il range mediano a 15 min DELLO STESSO GIORNO, per
  togliere la differenza fra giornate calme e agitate;
- controlli: lo stesso calcolo con lo 0 gamma spostato di +-7 e +-15 punti (livelli finti). Se la
  differenza fra sopra e sotto c'e' uguale anche con il livello finto, non e' lo 0 gamma: e' solo
  "dopo un ribasso il mercato e' piu' nervoso" (risultato della ricerca del 04/11/2026).
"""

import argparse
import glob
import json
import os
import statistics as st
import urllib.request
from datetime import date, datetime
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
SOGLIE = (3.0, 6.0)
FINESTRA = 15
SPOSTAMENTI = (0, -7, 7, -15, 15)


def sec(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 3600 + m * 60 + s


def cash(giorno):
    out = []
    for hh, mm in ((9, 35), (15, 55)):
        r = datetime.fromisoformat(f'{giorno}T{hh:02d}:{mm:02d}:00').replace(tzinfo=NY).astimezone(ROMA)
        out.append((r.hour * 60 + r.minute) * 60)
    return out


def zero_gamma(giorno):
    with urllib.request.urlopen(f'http://localhost:3000/api/zero-gamma?date={giorno}', timeout=120) as r:
        j = json.load(r)
    serie = (j.get('poller') or {}).get('serie') or []
    return {sec(t) // 60: v for t, v in serie if v is not None}


def minuti_market(giorno):
    try:
        with open(os.path.join(RADICE, 'market', f'{giorno}.json'), encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        d = []
    punti = d if isinstance(d, list) else d.get('data') or d.get('points') or []
    es, spx, hi, lo, vix1d = {}, {}, {}, {}, {}
    for p in punti:
        if not p.get('time') or not p.get('esf'):
            continue
        m = sec(p['time']) // 60
        e = p['esf']
        es[m] = e
        hi[m] = max(hi.get(m, e), e)
        lo[m] = min(lo.get(m, e), e)
        if p.get('spx'):
            spx[m] = p['spx']
        if p.get('vix1d'):
            vix1d[m] = p['vix1d']
    # Fino al 13/10/2026 il file di /market teneva solo gli ultimi 100 punti: dove manca, ES dal
    # mid di Bookmap (un campione al secondo) e SPX dall'undPrice del poller dei volumi.
    try:
        with open(os.path.join(RADICE, 'bookmap', f'{giorno}.ndjson'), encoding='utf-8') as f:
            bm = {}
            for riga in f:
                try:
                    q = json.loads(riga)
                except Exception:
                    continue
                b, a_ = q.get('bid'), q.get('ask')
                if not b or not a_ or not q.get('t'):
                    continue
                m = sec(q['t']) // 60
                if m in es and m not in bm:
                    continue
                e = (b + a_) / 2
                bm[m] = e
                es[m] = e
                hi[m] = max(hi.get(m, e), e)
                lo[m] = min(lo.get(m, e), e)
    except FileNotFoundError:
        pass
    try:
        with open(os.path.join(RADICE, 'volumes', f'{giorno}.json'), encoding='utf-8') as f:
            vol = json.load(f)
        snaps = vol if isinstance(vol, list) else vol.get('snapshots') or vol.get('data') or []
        for sn in snaps:
            u = sn.get('undPrice') or sn.get('spxPrice')
            if u and sn.get('time'):
                spx.setdefault(sec(sn['time']) // 60, u)
    except Exception:
        pass
    return es, spx, hi, lo, vix1d


def regime_al_minuto(zg, spx, m, spost):
    """+1 sopra lo 0 gamma (gamma positivo), -1 sotto; None senza dati (0 gamma fino a 3 min prima)."""
    z = None
    for k in range(4):
        if m - k in zg:
            z = zg[m - k]
            break
    if z is None or m not in spx:
        return None
    return 1 if spx[m] > z + spost else -1


def zigzag(prezzi, soglia):
    """prezzi = [(minuto, valore)]; swing completati (inizio, fine, ampiezza con segno), da pivot a pivot."""
    if len(prezzi) < 2:
        return []
    swing = []
    t0, v0 = prezzi[0]
    mx, mn = (t0, v0), (t0, v0)
    verso, piv, est = 0, None, None
    for t, v in prezzi[1:]:
        if verso == 0:
            if v > mx[1]:
                mx = (t, v)
            if v < mn[1]:
                mn = (t, v)
            if v - mn[1] >= soglia:
                verso, piv, est = 1, mn, (t, v)
            elif mx[1] - v >= soglia:
                verso, piv, est = -1, mx, (t, v)
            continue
        if (v - est[1]) * verso > 0:
            est = (t, v)
        elif (est[1] - v) * verso >= soglia:
            swing.append((piv[0], est[0], est[1] - piv[1]))
            piv, est, verso = est, (t, v), -verso
    return swing


def mediana(xs):
    return st.median(xs) if xs else float('nan')


def media(xs):
    return sum(xs) / len(xs) if xs else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', default='2026-09-01')
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    oggi = date.today().isoformat()
    giorni = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'volumes', '????-??-??.json'))
                    if a.dal <= os.path.basename(f)[:10] < oggi)

    dati = []
    for g in giorni:
        mk = minuti_market(g)
        if not mk:
            continue
        try:
            zg = zero_gamma(g)
        except Exception as e:
            print(f'{g}: 0 gamma non disponibile ({e})')
            continue
        if len(zg) < 120:
            continue
        dati.append((g, zg, mk))
    print(f'Giorni con 0 gamma e ES: {len(dati)} ({dati[0][0]} .. {dati[-1][0]})\n')

    risultati = {'giorni': [g for g, _, _ in dati], 'spostamenti': {}}
    for spost in SPOSTAMENTI:
        sw = {s: {1: [], -1: []} for s in SOGLIE}
        fin = {1: [], -1: []}
        minuti_reg = {1: 0, -1: 0}
        r1 = {1: [], -1: []}
        r5 = {1: [], -1: []}
        per_giorno = {}
        for g, zg, (es, spx, hi, lo, vix1d) in dati:
            apre, chiude = cash(g)
            mins = [m for m in sorted(es) if apre // 60 <= m <= chiude // 60]
            reg = {m: regime_al_minuto(zg, spx, m, spost) for m in mins}
            for m in mins:
                if reg[m]:
                    minuti_reg[reg[m]] += 1
            # swing
            prezzi = [(m, es[m]) for m in mins]
            for s in SOGLIE:
                for t0, t1, amp in zigzag(prezzi, s):
                    r = reg.get(t0)
                    if r:
                        sw[s][r].append((abs(amp), t1 - t0))
            # finestre di 15 min a regime costante
            ranges_giorno = []
            finestre_giorno = []
            for i in range(0, len(mins) - FINESTRA, FINESTRA):
                blocco = mins[i:i + FINESTRA + 1]
                if blocco[-1] - blocco[0] != FINESTRA:
                    continue
                regs = {reg[m] for m in blocco}
                rng = max(hi[m] for m in blocco) - min(lo[m] for m in blocco)
                ranges_giorno.append(rng)
                if len(regs) != 1 or None in regs:
                    continue
                r = regs.pop()
                netto = es[blocco[-1]] - es[blocco[0]]
                percorso = sum(abs(es[blocco[k + 1]] - es[blocco[k]]) for k in range(FINESTRA))
                ret1 = [es[blocco[k + 1]] - es[blocco[k]] for k in range(FINESTRA)]
                ret5 = [es[blocco[k + 5]] - es[blocco[k]] for k in range(0, FINESTRA, 5)]
                r1[r].extend(ret1)
                r5[r].extend(ret5)
                finestre_giorno.append((r, rng, abs(netto), abs(netto) / percorso if percorso else 0))
            med = mediana(ranges_giorno)
            for r, rng, net, eff in finestre_giorno:
                fin[r].append({'range': rng, 'netto': net, 'eff': eff, 'rel': rng / med if med else float('nan'), 'g': g})
                per_giorno.setdefault(g, {1: [], -1: []})[r].append(rng / med if med else float('nan'))

        def vr(r):
            v1 = st.pvariance(r1[r]) if len(r1[r]) > 2 else float('nan')
            v5 = st.pvariance(r5[r]) if len(r5[r]) > 2 else float('nan')
            return v5 / (5 * v1) if v1 else float('nan')

        # giorni con entrambi i regimi: in quanti il range relativo e' maggiore sotto
        misti = [(media(v[-1]), media(v[1])) for v in per_giorno.values() if len(v[1]) >= 2 and len(v[-1]) >= 2]
        sotto_maggiore = sum(1 for s_, p_ in misti if s_ > p_)

        ris = {'minuti': minuti_reg, 'swing': {}, 'finestre': {}, 'vr': {1: vr(1), -1: vr(-1)},
               'giorniMisti': len(misti), 'sottoMaggiore': sotto_maggiore}
        for s in SOGLIE:
            ris['swing'][s] = {}
            for r in (1, -1):
                xs = sw[s][r]
                ris['swing'][s][r] = {
                    'n': len(xs), 'ampMed': mediana([x[0] for x in xs]), 'ampMedia': media([x[0] for x in xs]),
                    'p90': sorted(x[0] for x in xs)[int(0.9 * (len(xs) - 1))] if xs else float('nan'),
                    'durMed': mediana([x[1] for x in xs]),
                    'velMed': mediana([x[0] / max(1, x[1]) for x in xs]),
                    'perOra': len(xs) / (minuti_reg[r] / 60) if minuti_reg[r] else float('nan'),
                }
        for r in (1, -1):
            xs = fin[r]
            ris['finestre'][r] = {
                'n': len(xs), 'rangeMed': mediana([x['range'] for x in xs]), 'nettoMed': mediana([x['netto'] for x in xs]),
                'eff': media([x['eff'] for x in xs]), 'rel': mediana([x['rel'] for x in xs]),
            }
        risultati['spostamenti'][spost] = ris

        nome = '0 gamma vero' if spost == 0 else f'livello finto 0 gamma {spost:+d}'
        print(f'=== {nome}: minuti sopra {minuti_reg[1]}, sotto {minuti_reg[-1]}')
        for s in SOGLIE:
            for r, lab in ((1, 'sopra (gamma +)'), (-1, 'sotto (gamma -)')):
                x = ris['swing'][s][r]
                print(f'  swing >= {s:.0f} pt {lab:<16} n {x["n"]:>5}  ampiezza mediana {x["ampMed"]:5.2f}  media {x["ampMedia"]:5.2f}  '
                      f'p90 {x["p90"]:5.2f}  durata {x["durMed"]:4.0f} min  vel {x["velMed"]:.2f} pt/min  {x["perOra"]:.1f}/ora')
        for r, lab in ((1, 'sopra (gamma +)'), (-1, 'sotto (gamma -)')):
            x = ris['finestre'][r]
            print(f'  finestre 15 min {lab:<16} n {x["n"]:>4}  range {x["rangeMed"]:5.2f}  netto {x["nettoMed"]:5.2f}  '
                  f'efficienza {x["eff"]:.2f}  range/mediana del giorno {x["rel"]:.2f}  VR {ris["vr"][r]:.2f}')
        print(f'  giorni con entrambi i regimi: {len(misti)}, range relativo maggiore sotto in {sotto_maggiore}\n')

    # Per giorno (0 gamma vero): quota di minuti sotto, range del cash, swing da 6 pt l'ora, quanto del
    # range e' diventato movimento netto. Nei giorni con entrambi i regimi, il confronto dentro lo stesso
    # giorno: swing da 3 pt l'ora e range a 15 min sopra e sotto.
    print('=== per giorno (0 gamma vero)')
    tab = []
    for g, zg, (es, spx, hi, lo, _) in dati:
        apre, chiude = cash(g)
        mins = [m for m in sorted(es) if apre // 60 <= m <= chiude // 60]
        reg = {m: regime_al_minuto(zg, spx, m, 0) for m in mins}
        validi = [m for m in mins if reg[m]]
        if len(validi) < 180:
            continue
        sotto = sum(1 for m in validi if reg[m] < 0) / len(validi)
        rng = max(hi[m] for m in mins) - min(lo[m] for m in mins)
        netto = es[mins[-1]] - es[mins[0]]
        sw6 = zigzag([(m, es[m]) for m in mins], 6.0)
        sw3 = zigzag([(m, es[m]) for m in mins], 3.0)
        dentro = {}
        for r in (1, -1):
            mr = sum(1 for m in validi if reg[m] == r)
            n3 = sum(1 for t0, _, _ in sw3 if reg.get(t0) == r)
            a3 = [abs(x) for t0, _, x in sw3 if reg.get(t0) == r]
            dentro[r] = {'minuti': mr, 'swing3Ora': n3 / (mr / 60) if mr >= 30 else None,
                         'amp3': mediana(a3) if len(a3) >= 3 else None}
        riga = {'g': g, 'sotto': sotto, 'range': rng, 'netto': netto, 'eff': abs(netto) / rng if rng else 0,
                'swing6Ora': len(sw6) / (len(mins) / 60), 'amp6': mediana([abs(x[2]) for x in sw6]), 'dentro': dentro}
        tab.append(riga)
        print(f'  {g}  sotto {sotto:4.0%}  range {rng:6.2f}  netto {netto:+7.2f}  efficienza {riga["eff"]:.2f}  '
              f'swing6/ora {riga["swing6Ora"]:.1f}  amp6 {riga["amp6"]:.2f}')
    for nome, f in (('quasi sempre sopra (<20% sotto)', lambda r: r['sotto'] < 0.2),
                    ('misti', lambda r: 0.2 <= r['sotto'] <= 0.8),
                    ('quasi sempre sotto (>80% sotto)', lambda r: r['sotto'] > 0.8)):
        x = [r for r in tab if f(r)]
        if x:
            print(f'  {nome:<32} giorni {len(x):>2}  range mediano {mediana([r["range"] for r in x]):6.2f}  '
                  f'efficienza {mediana([r["eff"] for r in x]):.2f}  swing6/ora {mediana([r["swing6Ora"] for r in x]):.1f}  '
                  f'amp6 {mediana([r["amp6"] for r in x]):.2f}')
    coppie = [(r['dentro'][1], r['dentro'][-1]) for r in tab
              if r['dentro'][1]['swing3Ora'] is not None and r['dentro'][-1]['swing3Ora'] is not None]
    if coppie:
        piu = sum(1 for p_, s_ in coppie if s_['swing3Ora'] > p_['swing3Ora'])
        amp = [(p_['amp3'], s_['amp3']) for p_, s_ in coppie if p_['amp3'] and s_['amp3']]
        print(f'  stesso giorno, almeno 30 min per lato: {len(coppie)} giorni; swing da 3 pt piu frequenti sotto in {piu}; '
              f'ampiezza mediana piu grande sotto in {sum(1 for p_, s_ in amp if s_ > p_)} di {len(amp)}')
        print(f'    swing3/ora mediana sopra {mediana([p_["swing3Ora"] for p_, _ in coppie]):.1f}  sotto {mediana([s_["swing3Ora"] for _, s_ in coppie]):.1f}; '
              f'ampiezza sopra {mediana([p_ for p_, _ in amp]):.2f}  sotto {mediana([s_ for _, s_ in amp]):.2f}')
    risultati['perGiorno'] = tab

    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(risultati, f, default=str)


if __name__ == '__main__':
    main()
