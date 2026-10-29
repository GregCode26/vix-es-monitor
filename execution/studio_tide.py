"""Studio sul Market Tide (29/10/2026), sugli snapshot di frontend/data/volumes.

Domande: quanto del Tide versione 1 viene da gambe di vertical contate due
volte, e quanto le varie misure di flusso descrivono o anticipano SPX.
Risultati del 29/10 (14 sessioni con Lee-Ready, 904 fette da 5 minuti):

- il Tide v1 netto (NCP - NPP) aveva correlazione -0.28 con SPX nella stessa
  fetta: andava al contrario del mercato. A 10 s si vede che e' la
  classificazione: NPP +0.16, NCP -0.08 con il movimento, Lee-Ready (bid/ask
  di prima del trade) +/-0.04. Il bid/ask confrontato era gia' quello spostato;
- 32 dei 70 salti piu' grandi (5 per giorno) avevano due gambe con la stessa
  size nello stesso intervallo, e in media il 16% del Tide;
- nessuna misura anticipa SPX sui 15 minuti dopo (tutte fra -0.04 e -0.08):
  il flusso descrive chi compra cosa, non prevede.

Uso: python execution/studio_tide.py  (MINC=50 cambia la size minima di coppia)
"""
import glob, json, math, os, sys
from collections import defaultdict

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'data', 'volumes')
MIN_COPPIA = int(os.environ.get('MINC', '100'))      # contratti minimi per gamba per chiamarla coppia
TOLL_COPPIA = 0.01   # differenza relativa ammessa fra le due gambe
BUCKET = 300         # secondi
AVANTI = 900

def sec(t):
    h, m, s = map(int, t.split(':')); return h * 3600 + m * 60 + s

def delta_call(d):
    if d is None: return None
    return d if d > 0 else 1 + d

def coppie(inc):
    """inc: {strike: n} incrementi di volume su un lato. Ritorna gli strike in coppia."""
    ks = sorted(k for k, n in inc.items() if n >= MIN_COPPIA)
    usati = set()
    for i, a in enumerate(ks):
        if a in usati: continue
        best = None
        for b in ks[i + 1:]:
            if b in usati: continue
            na, nb = inc[a], inc[b]
            if abs(na - nb) <= TOLL_COPPIA * max(na, nb) and b - a <= 50:
                best = b; break
        if best is not None:
            usati.update((a, best))
    return usati

def rango(v):
    o = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
    for k, i in enumerate(o): r[i] = k
    return r

def spear(x, y): return corr(rango(x), rango(y))

def corr(x, y):
    n = len(x)
    if n < 10: return float('nan')
    mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else float('nan')

VARIANTI = ['tide', 'tideNoPicchi', 'lrContr', 'lrDelta', 'lrDeltaNoCoppie', 'lrDeltaNoCoppieBanda']
pool = {v: ([], [], []) for v in VARIANTI}   # (valore bucket, dSPX stesso bucket, dSPX avanti)
punte = []
quota_coppie = []
giorni = 0
for f in sorted(glob.glob(os.path.join(DIR, '*.json'))):
    try: s = json.load(open(f))
    except Exception: continue
    if not isinstance(s, list) or len(s) < 300: continue
    if not s[len(s) // 2].get('volumes') or 'cb' not in s[len(s) // 2]['volumes'][0]: continue
    giorni += 1
    giorno = os.path.basename(f)[:10]
    serie = []  # (t, spx, {variante: incremento})
    tot_tide_abs = 0; tot_tide_coppie = 0
    for a, b in zip(s, s[1:]):
        if not (a.get('tide') and b.get('tide') and a.get('volumes') and b.get('volumes')): continue
        ta, tb = sec(a['time']), sec(b['time'])
        if not 0 < tb - ta <= 30 or not b.get('spxPrice'): continue
        va = {r['strike']: r for r in a['volumes']}
        incC, incP, v = {}, {}, defaultdict(float)
        lr = []
        for r in b['volumes']:
            p = va.get(r['strike'])
            if not p or 'cb' not in r or 'cb' not in p: continue
            dc = r['calls'] - p['calls']; dp = r['puts'] - p['puts']
            if dc > 0: incC[r['strike']] = dc
            if dp > 0: incP[r['strike']] = dp
            dcb, dcs = r['cb'] - p['cb'], r['cs'] - p['cs']
            dpb, dps = r['pb'] - p['pb'], r['ps'] - p['ps']
            dlc = delta_call(r.get('delta'))
            lr.append((r['strike'], dcb - dcs, dpb - dps, dlc))
        if sum(incC.values()) + sum(incP.values()) > 50000:
            print('  riaggancio scartato', giorno, b['time'], int(sum(incC.values()) + sum(incP.values())))
            continue
        cC, cP = coppie(incC), coppie(incP)
        dt = (b['tide']['ncp'] - a['tide']['ncp']) - (b['tide']['npp'] - a['tide']['npp'])
        v['tide'] = dt
        for k, nc, np_, dlc in lr:
            v['lrContr'] += nc - np_
            if dlc is None: continue
            dlp = dlc - 1
            ec, ep = nc * dlc * 100, np_ * dlp * 100
            v['lrDelta'] += ec + ep
            ec2 = 0 if k in cC else ec
            ep2 = 0 if k in cP else ep
            v['lrDeltaNoCoppie'] += ec2 + ep2
            if 0.05 <= dlc <= 0.95: v['lrDeltaNoCoppieBanda'] += ec2
            if 0.05 <= -dlp <= 0.95: v['lrDeltaNoCoppieBanda'] += ep2
        tot_tide_abs += abs(dt)
        if cC or cP:
            tot_tide_coppie += abs(dt)
        serie.append((tb, b['spxPrice'], v, bool(cC or cP), b['time']))
    if not serie: continue
    # tide senza picchi: tolti gli intervalli con coppie
    for x in serie:
        x[2]['tideNoPicchi'] = 0 if x[3] else x[2]['tide']
    quota_coppie.append((giorno, tot_tide_coppie / tot_tide_abs if tot_tide_abs else 0,
                         sum(1 for x in serie if x[3]) / len(serie)))
    # i 5 salti di tide piu' grandi del giorno: quanti in intervalli con coppie
    for x in sorted(serie, key=lambda x: -abs(x[2]['tide']))[:5]:
        punte.append((giorno, x[4], round(x[2]['tide'] / 1e6, 2), x[3]))
    # bucket
    t0 = serie[0][0]
    bk = defaultdict(lambda: [None, None, defaultdict(float)])
    for t, spx, v, _, _ in serie:
        i = (t - t0) // BUCKET
        e = bk[i]
        if e[0] is None: e[0] = spx
        e[1] = spx
        for k, val in v.items(): e[2][k] += val
    idx = sorted(bk)
    passi = AVANTI // BUCKET
    for i in idx:
        if i + passi not in bk: continue
        dsame = bk[i][1] - bk[i][0]
        davanti = bk[i + passi][1] - bk[i][1]
        for var in VARIANTI:
            pool[var][0].append(bk[i][2][var]); pool[var][1].append(dsame); pool[var][2].append(davanti)

print(f'giorni con Lee-Ready: {giorni}')
print('\n== quota del |Tide| che cade in intervalli di 10 s con gambe appaiate (stessa size, stesso lato)')
for g, q, n in quota_coppie: print(f'  {g}: {q:5.1%} del Tide, in {n:5.1%} degli intervalli')
print('\n== 5 salti piu grandi del Tide per giorno (mln $): con coppia?')
con = sum(1 for p in punte if p[3]); print(f'  {con}/{len(punte)} hanno gambe appaiate')
for p in sorted(punte, key=lambda p: -abs(p[2]))[:15]: print('  ', p)
print(f'\n== bucket {BUCKET//60} min, {len(pool["tide"][0])} campioni: correlazione con SPX')
print(f'  {"misura":24s} {"stesso":>8s} {"avanti":>8s} {"rango st":>9s} {"rango av":>9s}  curtosi')
for var in VARIANTI:
    x, y, z = pool[var]
    n = len(x); m = sum(x) / n; sd = math.sqrt(sum((a - m) ** 2 for a in x) / n) or 1
    kurt = sum(((a - m) / sd) ** 4 for a in x) / n
    print(f'  {var:24s} {corr(x, y):8.3f} {corr(x, z):8.3f} {spear(x, y):9.3f} {spear(x, z):9.3f}  {kurt:7.1f}')
