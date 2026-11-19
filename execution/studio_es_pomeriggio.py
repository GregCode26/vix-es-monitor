"""
Studio: ES fra le 16:00 e le 21:30 (ora italiana). Quando partono i trend da oltre 19 punti, quando il
mercato sta in laterale, in quale fascia un'operazione ha il rischio/rendimento migliore.

    python execution/studio_es_pomeriggio.py [--json percorso]

Dati: le barre a 5 minuti di SPX (e VIX1D) gia' in cache in .tmp/studio_vol_intraday/ (maggio 2023 -
oggi, scaricate da studio_vol_intraday.py: nessuna richiesta a IBKR). ES segue SPX minuto per minuto a
meno della base, quindi i movimenti sono gli stessi; i punti sono riportati al livello di oggi
(movimento % x LIVELLO), perche' 19 punti nel 2023 con SPX a 4.200 non sono 19 punti di oggi.
Controllo: le stesse misure sulle ultime sedute di ES vero (frontend/data/market, un punto ogni ~15 s).

Fasce di 30 minuti in ora di Roma. Nelle 2-3 settimane l'anno in cui Italia e USA non hanno ancora
cambiato ora entrambe, il cash apre alle 14:30 e chiude alle 21:00 italiane: le fasce di quei giorni sono
spostate di un'ora rispetto al resto dell'anno (si vedono anche da sole, campo `sfasato`).

- Trend: zigzag su massimi e minimi a 5 minuti, inversione dopo RITORNO punti; un trend e' uno swing
  >= SOGLIA_TREND punti. Si conta l'ora d'inizio (il minimo o massimo da cui parte).
- Laterale: una mezz'ora con range <= LATERALE punti.
- Rischio/rendimento: per ogni fascia, entrata all'inizio; stop STOP e obiettivo OBIETTIVO punti (1:2),
  uscita a 60 minuti. Due versi: nel verso dei 30 minuti prima (momentum) e contro (fade). Ricerca
  2023-2024, verifica 2025-2026. Costo COSTO a trade.
"""

import argparse
import glob
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_vol_intraday')
MARKET = os.path.join(RADICE, 'frontend', 'data', 'market')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
LIVELLO = 7600.0
SOGLIA_TREND = 19.0
RITORNO = 8.0
LATERALE = 8.0
STOP, OBIETTIVO, COSTO = 6.0, 12.0, 0.25
INIZIO, FINE = 16 * 60, 21 * 60 + 30
FASCE = list(range(INIZIO, FINE, 30))
# Lo zigzag gira su tutto il cash (dall'apertura alla chiusura) e si contano solo i trend che partono
# fra le 16:00 e le 21:30: partendo alle 16:00 il primo swing "partirebbe" sempre alle 16:00.
CONTESTO_DA, CONTESTO_A = 14 * 60 + 30, 22 * 60


def hhmm(m):
    return f'{m // 60:02d}:{m % 60:02d}'


def carica_cache(simbolo):
    righe = {}
    for f in glob.glob(os.path.join(CACHE, f'{simbolo}_*.json')):
        for r in json.load(open(f)):
            righe[r['t']] = r
    return [righe[t] for t in sorted(righe)]


def per_giorno(barre):
    """{giorno: [(minuto Roma, o, h, l, c, sfasato)]} solo 16:00-21:30 Roma."""
    out = defaultdict(list)
    for b in barre:
        dt = datetime.fromtimestamp(b['t'], tz=timezone.utc)
        r, n = dt.astimezone(ROMA), dt.astimezone(NY)
        m = r.hour * 60 + r.minute
        if CONTESTO_DA <= m < CONTESTO_A:
            sfasato = (r.utcoffset() - n.utcoffset()).total_seconds() / 3600 != 6
            out[r.date().isoformat()].append((m, b['o'], b['h'], b['l'], b['c'], sfasato))
    return out


def zigzag(barre, ritorno):
    """Swing da pivot a pivot su massimi/minimi. barre = [(minuto, h, l)]. -> [(inizio, fine, ampiezza)]."""
    if not barre:
        return []
    swing = []
    t0, h0, l0 = barre[0]
    verso = 0
    mx, mn = (t0, h0), (t0, l0)
    piv = est = None
    for t, h, l in barre[1:]:
        if verso == 0:
            if h > mx[1]:
                mx = (t, h)
            if l < mn[1]:
                mn = (t, l)
            if mx[1] - mn[1] >= ritorno:
                if mn[0] <= mx[0]:
                    verso, piv, est = 1, mn, mx
                else:
                    verso, piv, est = -1, mx, mn
            continue
        if verso > 0:
            if h > est[1]:
                est = (t, h)
            elif est[1] - l >= ritorno:
                swing.append((piv[0], est[0], est[1] - piv[1]))
                piv, est, verso = est, (t, l), -1
        else:
            if l < est[1]:
                est = (t, l)
            elif h - est[1] >= ritorno:
                swing.append((piv[0], est[0], est[1] - piv[1]))
                piv, est, verso = est, (t, h), 1
    if piv and est and abs(est[1] - piv[1]) >= ritorno:
        swing.append((piv[0], est[0], est[1] - piv[1]))  # l'ultimo, ancora aperto alle 21:30
    return swing


def simula(barre, i, verso, stop, obiettivo, minuti=60):
    """Entrata alla chiusura della barra i-1 (= apertura della fascia). -> punti, al netto del costo."""
    entrata = barre[i - 1][4]
    fine = barre[i][0] + minuti
    ultimo = entrata
    for b in barre[i:]:
        if b[0] >= fine:
            break
        h, l = b[2], b[3]
        avverso = (entrata - l) if verso > 0 else (h - entrata)
        favorevole = (h - entrata) if verso > 0 else (entrata - l)
        if avverso >= stop:  # se nella stessa barra ci sono entrambi, vale lo stop (prudente)
            return -stop - COSTO
        if favorevole >= obiettivo:
            return obiettivo - COSTO
        ultimo = b[4]
    return (ultimo - entrata) * verso - COSTO


def analizza(giorni, scala_di, etichetta):
    trend_inizio = defaultdict(int)
    trend_fine = defaultdict(int)
    durate, ampiezze = [], []
    giorni_con_trend = 0
    lat = {f: [0, 0] for f in FASCE}
    rng = {f: [] for f in FASCE}
    eff = {f: [] for f in FASCE}
    tr = {f: {'mom': defaultdict(list), 'fade': defaultdict(list)} for f in FASCE}
    vix_trend = defaultdict(lambda: [0, 0])
    n_giorni = 0
    for g, barre in sorted(giorni.items()):
        if sum(1 for x in barre if INIZIO <= x[0] < FINE) < (FINE - INIZIO) // 5 * 0.8:
            continue
        n_giorni += 1
        k = scala_di(barre)  # da prezzo del giorno a punti ES di oggi
        b = [(m, o * k, h * k, l * k, c * k, s) for m, o, h, l, c, s in barre]
        sw = [x for x in zigzag([(m, h, l) for m, _, h, l, _, _ in b], RITORNO)
              if abs(x[2]) >= SOGLIA_TREND and INIZIO <= x[0] < FINE]
        if sw:
            giorni_con_trend += 1
        for t0, t1, amp in sw:
            trend_inizio[t0 // 30 * 30] += 1
            trend_fine[t1 // 30 * 30] += 1
            durate.append(t1 - t0)
            ampiezze.append(abs(amp))
        per_m = {x[0]: x for x in b}
        for f in FASCE:
            dentro = [per_m[m] for m in range(f, f + 30, 5) if m in per_m]
            if len(dentro) < 5:
                continue
            r = max(x[2] for x in dentro) - min(x[3] for x in dentro)
            rng[f].append(r)
            # efficienza dell'ora che parte qui: |netto| / range (vicino a 1 = andata in una direzione)
            ora = [per_m[m] for m in range(f, f + 60, 5) if m in per_m]
            if len(ora) >= 10:
                r60 = max(x[2] for x in ora) - min(x[3] for x in ora)
                if r60 > 0:
                    eff[f].append(abs(ora[-1][4] - ora[0][1]) / r60)
            lat[f][0] += r <= LATERALE
            lat[f][1] += 1
        anno = g[:4]
        periodo = 'ricerca' if anno in ('2023', '2024') else 'verifica'
        for f in FASCE:
            idx = next((i for i, x in enumerate(b) if x[0] == f), None)
            if idx is None or idx < 6:
                continue
            prima = b[idx - 1][4] - b[idx - 6][1]  # i 30 minuti prima: apertura di 6 barre fa -> ultima chiusura
            if prima == 0:
                continue
            verso = 1 if prima > 0 else -1
            tr[f]['mom'][periodo].append(simula(b, idx, verso, STOP, OBIETTIVO))
            tr[f]['fade'][periodo].append(simula(b, idx, -verso, STOP, OBIETTIVO))
        if 'v1d' in giorni.get('_extra', {}):
            pass
    return {
        'etichetta': etichetta, 'giorni': n_giorni, 'giorniConTrend': giorni_con_trend,
        'trendInizio': dict(trend_inizio), 'trendFine': dict(trend_fine),
        'duraMediana': sorted(durate)[len(durate) // 2] if durate else None,
        'ampMediana': sorted(ampiezze)[len(ampiezze) // 2] if ampiezze else None,
        'nTrend': len(ampiezze), 'lat': lat, 'rng': rng, 'tr': tr, 'eff': eff,
    }


def mediana(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else float('nan')


def p90(xs):
    s = sorted(xs)
    return s[int(0.9 * (len(s) - 1))] if s else float('nan')


def stampa(r):
    print(f"=== {r['etichetta']}: {r['giorni']} giorni, trend >= {SOGLIA_TREND:.0f} pt: {r['nTrend']} "
          f"(giorni con almeno uno {r['giorniConTrend']}, {r['giorniConTrend'] / max(1, r['giorni']):.0%}); "
          f"ampiezza mediana {r['ampMediana']}, durata mediana {r['duraMediana']} min")
    print('  fascia  trend partiti  /100 giorni  finiti   range mediano  p90 range  % laterale  efficienza 60 min')
    for f in FASCE:
        n = r['trendInizio'].get(f, 0)
        lat = r['lat'][f]
        print(f"  {hhmm(f)}  {n:>8}  {100 * n / max(1, r['giorni']):>10.1f}  {r['trendFine'].get(f, 0):>8}  "
              f"{mediana(r['rng'][f]):>12.2f}  {p90(r['rng'][f]):>9.2f}  {lat[0] / max(1, lat[1]):>9.0%}  "
              f"{(sum(r['eff'][f]) / len(r['eff'][f])) if r['eff'][f] else float('nan'):>10.2f}")


def stampa_rr(r):
    print(f'  rischio/rendimento: stop {STOP:.0f}, obiettivo {OBIETTIVO:.0f}, uscita 60 min, costo {COSTO} pt; '
          'punti medi per trade (ricerca 2023-24 | verifica 2025-26), % obiettivi')
    for f in FASCE:
        riga = f'  {hhmm(f)}'
        for verso in ('mom', 'fade'):
            for p in ('ricerca', 'verifica'):
                xs = r['tr'][f][verso][p]
                if xs:
                    m = sum(xs) / len(xs)
                    sd = (sum((x - m) ** 2 for x in xs) / max(1, len(xs) - 1)) ** 0.5
                    t = m / (sd / len(xs) ** 0.5) if sd else 0
                    vinti = sum(1 for x in xs if x > OBIETTIVO - 1) / len(xs)
                    riga += f'  {verso[:4]} {p[:3]} {m:+5.2f} (t {t:+4.1f}, {vinti:4.0%})'
        print(riga)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', default=None)
    a = ap.parse_args()

    spx = per_giorno(carica_cache('SPX'))
    v1d = {}
    for b in carica_cache('VIX1D'):
        dt = datetime.fromtimestamp(b['t'], tz=timezone.utc).astimezone(ROMA)
        if dt.hour == 16 and dt.minute == 0:
            v1d[dt.date().isoformat()] = b['o']

    def scala(barre):
        return LIVELLO / barre[0][1]

    tutti = analizza(spx, scala, 'SPX 5 min, maggio 2023 - oggi, punti al livello di oggi')
    stampa(tutti)
    stampa_rr(tutti)

    # Solo i giorni con gli orari normali, e solo quelli sfasati (cash 14:30-21:00 italiane).
    normali = {g: b for g, b in spx.items() if not any(x[5] for x in b)}
    sfasati = {g: b for g, b in spx.items() if any(x[5] for x in b)}
    print()
    stampa(analizza(sfasati, scala, 'solo settimane con il cambio d\'ora sfasato'))

    # VIX1D alle 16:00: terzili; giorni con almeno un trend e numero di trend.
    print('\n=== trend per VIX1D alle 16:00 (terzili)')
    vals = sorted(v for g, v in v1d.items() if g in normali)
    terz = [vals[len(vals) // 3], vals[2 * len(vals) // 3]] if vals else [0, 0]
    gruppi = {}
    for nome, f in (('basso', lambda v: v < terz[0]), ('medio', lambda v: terz[0] <= v < terz[1]), ('alto', lambda v: v >= terz[1])):
        sel = {g: b for g, b in normali.items() if g in v1d and f(v1d[g])}
        r = analizza(sel, scala, f'VIX1D {nome}')
        gruppi[nome] = {'giorni': r['giorni'], 'conTrend': r['giorniConTrend'], 'nTrend': r['nTrend'],
                        'limiti': terz, 'rangeMediano': {hhmm(k): mediana(v) for k, v in r['rng'].items()},
                        'lateraleMedio': sum(x[0] for x in r['lat'].values()) / max(1, sum(x[1] for x in r['lat'].values()))}
        print(f"  VIX1D {nome:<6} (<{terz[0]:.1f} / {terz[0]:.1f}-{terz[1]:.1f} / >={terz[1]:.1f}): {r['giorni']} giorni, "
              f"con trend {r['giorniConTrend'] / max(1, r['giorni']):.0%}, trend per giorno {r['nTrend'] / max(1, r['giorni']):.2f}, "
              f"mezz'ore laterali {gruppi[nome]['lateraleMedio']:.0%}")

    # Controllo su ES vero, ultime sedute (file di /market dal 13/10/2026).
    es = defaultdict(list)
    for f in sorted(glob.glob(os.path.join(MARKET, '????-??-??.json'))):
        g = os.path.basename(f)[:10]
        try:
            d = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        punti = d if isinstance(d, list) else d.get('data') or []
        barre = {}
        for p in punti:
            if not p.get('time') or not p.get('esf'):
                continue
            hh, mm, _ = (int(x) for x in p['time'].split(':'))
            m = hh * 60 + mm
            if not CONTESTO_DA <= m < CONTESTO_A:
                continue
            k = m // 5 * 5
            e = p['esf']
            o, h, l, c = barre.get(k, (e, e, e, e))
            barre[k] = (o, max(h, e), min(l, e), e)
        if len(barre) >= 50:
            es[g] = [(k, *barre[k], False) for k in sorted(barre)]
    vero = analizza(es, lambda b: 1.0, f'ES vero, file locali ({min(es) if es else "-"} .. {max(es) if es else "-"})')
    print()
    stampa(vero)

    if a.json:
        def pulisci(r):
            return {
                'etichetta': r['etichetta'], 'giorni': r['giorni'], 'giorniConTrend': r['giorniConTrend'], 'nTrend': r['nTrend'],
                'ampMediana': r['ampMediana'], 'duraMediana': r['duraMediana'],
                'fasce': [{
                    'fascia': hhmm(f), 'trendPartiti': r['trendInizio'].get(f, 0), 'trendFiniti': r['trendFine'].get(f, 0),
                    'trendOgni100Giorni': round(100 * r['trendInizio'].get(f, 0) / max(1, r['giorni']), 2),
                    'rangeMediano': round(mediana(r['rng'][f]), 2) if r['rng'][f] else None,
                    'rangeP90': round(p90(r['rng'][f]), 2) if r['rng'][f] else None,
                    'efficienza60': round(sum(r['eff'][f]) / len(r['eff'][f]), 3) if r['eff'][f] else None,
                    'quotaLaterale': round(r['lat'][f][0] / max(1, r['lat'][f][1]), 3),
                    **{f'{v}_{p}': (round(sum(r['tr'][f][v][p]) / len(r['tr'][f][v][p]), 3) if r['tr'][f][v][p] else None)
                       for v in ('mom', 'fade') for p in ('ricerca', 'verifica')},
                    **{f'{v}_{p}_n': len(r['tr'][f][v][p]) for v in ('mom', 'fade') for p in ('ricerca', 'verifica')},
                    **{f'{v}_{p}_obiettivi': (round(sum(1 for x in r['tr'][f][v][p] if x > OBIETTIVO - 1) / len(r['tr'][f][v][p]), 3)
                                              if r['tr'][f][v][p] else None) for v in ('mom', 'fade') for p in ('ricerca', 'verifica')},
                } for f in FASCE],
            }
        with open(a.json, 'w', encoding='utf-8') as fh:
            json.dump({'tutti': pulisci(tutti), 'esVero': pulisci(vero), 'vix1d': gruppi,
                       'parametri': {'livello': LIVELLO, 'sogliaTrend': SOGLIA_TREND, 'ritorno': RITORNO, 'laterale': LATERALE,
                                     'stop': STOP, 'obiettivo': OBIETTIVO, 'costo': COSTO}}, fh)


if __name__ == '__main__':
    main()
