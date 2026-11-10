"""La linea IV MIN (vertice dello smile 0DTE) anticipa ES?

Legge solo file locali: `frontend/data/smile/*.ndjson` (letture v2, dal 27/10/2026),
`frontend/data/market/*.json` e, per il bordo della catena, `frontend/data/volumes/*.json`.
Griglia a 1 minuto in ora di New York.

  python execution/studio_ivmin.py [--dal YYYY-MM-DD] [--json percorso]

Le correlazioni si giudicano contro un null a slittamento circolare dentro ogni
giorno: conserva l'autocorrelazione delle serie, che con rendimenti sovrapposti e
un vertice a gradini renderebbe finti gli errori standard classici. Ogni risultato
viene anche ripetuto senza la giornata col movimento maggiore e togliendo la media
di ogni giorno: nel campione del 09/11/2026 il solo 05/11 (ES -308) faceva tutte le
correlazioni "predittive" aggregate.
"""

import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'data')
ORIZZONTI = [5, 15, 30, 60]
APERTURA, CHIUSURA = 9 * 60 + 30, 16 * 60
INIZIO_STUDIO = 9 * 60 + 35  # i primi minuti hanno spread larghi e vertice instabile
RNG = np.random.default_rng(20261109)
REPS = 300


def secondi(h):
    a, b, c = h.split(':')
    return int(a) * 3600 + int(b) * 60 + int(c)


def leggi_smile(giorno):
    letture = []
    with open(os.path.join(RADICE, 'smile', giorno + '.ndjson'), encoding='utf-8') as f:
        for riga in f:
            if riga.strip():
                r = json.loads(riga)
                if r.get('v') == 2 and r.get('vertice') and r.get('tEt'):
                    letture.append(r)
    return letture


def carica_giorno(giorno):
    letture = leggi_smile(giorno)
    if not letture:
        return None
    s = pd.DataFrame({
        'loc': [secondi(r['t']) for r in letture],
        'et': [secondi(r['tEt']) for r in letture],
        'spot': [r['spot'] for r in letture],
        'k': [r['vertice']['strike'] for r in letture],
        'ivv': [r['vertice']['iv'] for r in letture],
        'iva': [r['ivAtm'] for r in letture],
        'em': [r['em'] for r in letture],
    })
    # Fuso: differenza fra orologio del PC e New York, alla mezz'ora (26-30/10 sono 5 ore, poi 6).
    fuso = round(((s['loc'] - s['et']).median()) / 1800) * 1800
    s['min'] = (s['et'] // 60).astype(int)
    grp = s.groupby('min')
    griglia = grp[['spot', 'k', 'ivv', 'iva', 'em']].last()
    griglia['hi'] = grp['spot'].max()
    griglia['lo'] = grp['spot'].min()

    with open(os.path.join(RADICE, 'market', giorno + '.json'), encoding='utf-8') as f:
        mercato = json.load(f)
    m = pd.DataFrame({'loc': [secondi(p['time']) for p in mercato], 'es': [p.get('esf') for p in mercato]}).dropna()
    m = m[m['es'] > 0]
    m['min'] = ((m['loc'] - fuso) // 60).astype(int)
    es = m.groupby('min')['es'].last()

    indice = pd.RangeIndex(APERTURA, CHIUSURA + 1, name='min')
    d = griglia.reindex(indice)
    d['es'] = es.reindex(indice)
    # Riempie solo buchi di 2 minuti: oltre e' un poller fermo, non si inventa un prezzo.
    for c in ('spot', 'k', 'ivv', 'iva', 'em', 'es'):
        d[c] = d[c].ffill(limit=2)
    d['giorno'] = giorno
    return d


def costruisci(d):
    """Predittori e obiettivi di un giorno."""
    d = d.copy()
    d['dist'] = d['k'] - d['spot']
    d['sigma'] = d['dist'] / d['em']
    d['prof'] = d['iva'] - d['ivv']
    d['s1min'] = d['spot'] * d['iva'] / 100 / np.sqrt(525600)  # 1 sigma al minuto, in punti
    for h in ORIZZONTI:
        d[f'fw{h}'] = (d['es'].shift(-h) - d['es']) / (d['s1min'] * np.sqrt(h))
        d[f'fwp{h}'] = d['es'].shift(-h) - d['es']
    for h in (5, 15, 30):
        d[f'dk{h}'] = d['k'] - d['k'].shift(h)
        d[f'pa{h}'] = d['es'] - d['es'].shift(h)
        d[f'dp{h}'] = d['prof'] - d['prof'].shift(h)
        # Il vertice al netto di quanto si e' mosso il prezzo: la parte "propria".
        d[f'rel{h}'] = d[f'dk{h}'] - (d['spot'] - d['spot'].shift(h))
    return d


def corr(x, y):
    ok = ~(np.isnan(x) | np.isnan(y))
    if ok.sum() < 30:
        return np.nan, int(ok.sum())
    xx, yy = x[ok], y[ok]
    if xx.std() == 0 or yy.std() == 0:
        return np.nan, int(ok.sum())
    return float(np.corrcoef(xx, yy)[0, 1]), int(ok.sum())


def null_circolare(giorni, xc, yc, reps=REPS):
    """(r, n, p a due code): x scorre circolarmente dentro ogni giorno. Il p misura la distanza dal centro del null."""
    xs = [g[xc].to_numpy(float) for g in giorni]
    y = np.concatenate([g[yc].to_numpy(float) for g in giorni])
    r, n = corr(np.concatenate(xs), y)
    if np.isnan(r):
        return r, n, np.nan
    nulli = []
    for _ in range(reps):
        sc = [np.roll(x, RNG.integers(30, len(x) - 30)) for x in xs]
        rn, _n = corr(np.concatenate(sc), y)
        if not np.isnan(rn):
            nulli.append(rn)
    nulli = np.array(nulli)
    c = nulli.mean()
    return r, n, float(((np.abs(nulli - c) >= abs(r - c)).sum() + 1) / (len(nulli) + 1))


def bh(ps):
    """q di Benjamini-Hochberg."""
    p = np.array(ps, float)
    ordine = np.argsort(p)
    q = np.empty(len(p))
    minimo = 1.0
    for i in range(len(p) - 1, -1, -1):
        minimo = min(minimo, p[ordine[i]] * len(p) / (i + 1))
        q[ordine[i]] = minimo
    return q


def senza_media(giorni, colonne):
    fuori = []
    for g in giorni:
        t = g.copy()
        for c in colonne:
            t[c] = t[c] - t[c].mean()
        fuori.append(t)
    return fuori


def bordo_catena(giorno):
    """Quota di letture col vertice sugli ultimi strike della catena del poller (37 strike, +/-90)."""
    with open(os.path.join(RADICE, 'volumes', giorno + '.json'), encoding='utf-8') as f:
        vol = json.load(f)
    righe = []
    for s in vol:
        ks = [x['strike'] for x in (s.get('volumes') or []) if x.get('strike') is not None]
        if ks:
            righe.append((secondi(s['time']), min(ks), max(ks)))
    if not righe:
        return {'giorno': giorno, 'entro10': None, 'entro5': None}
    a = pd.DataFrame(righe, columns=['s', 'lo', 'hi']).sort_values('s')
    letture = leggi_smile(giorno)
    b = pd.DataFrame({'s': [secondi(r['t']) for r in letture], 'k': [r['vertice']['strike'] for r in letture]}).sort_values('s')
    m = pd.merge_asof(b, a, on='s', tolerance=120).dropna()
    return {'giorno': giorno, 'entro10': float((m.k >= m.hi - 10).mean()), 'entro5': float((m.k >= m.hi - 5).mean())}


def salti_contro(giorni, soglia=5, finestra=1, riarmo=15, ritardo=1, shift=None, contro=True):
    """Salti del vertice (opzionalmente solo contro ES a 5 min). Entrata `ritardo` minuti dopo. + = ES va dove va il vertice."""
    fuori = []
    for g in giorni:
        a = g.reset_index()
        k = a['k'].to_numpy(float)
        if shift is not None:
            k = np.roll(k, shift[a['giorno'].iloc[0]])
        es = a['es'].to_numpy(float)
        pa = a['pa5'].to_numpy(float)
        ultimo = -999
        for i in range(max(finestra, 1), len(a) - 6 - ritardo):
            if i - ultimo < riarmo:
                continue
            dk = k[i] - k[i - finestra]
            if np.isnan(dk) or abs(dk) < soglia:
                continue
            if contro and (np.isnan(pa[i]) or pa[i] == 0 or np.sign(pa[i]) == np.sign(dk)):
                continue
            ultimo = i
            e0 = es[i + ritardo]
            r = {'giorno': a.at[i, 'giorno'], 'prima': np.sign(dk) * pa[i]}
            for h in (5, 10, 15):
                j = i + ritardo + h
                r[f'f{h}'] = np.sign(dk) * (es[j] - e0) if j < len(a) else np.nan
            fuori.append(r)
    return pd.DataFrame(fuori)


def tocco_controllato(giorni, fasce, appaia=False):
    """Il vertice viene raggiunto entro 60 min quanto un livello alla stessa distanza SOPRA lo spot, senza vertice?

    Il controllo e' lo stesso giorno, entro 45 minuti, in momenti in cui il vertice
    stava altrove (>10 punti). Con `appaia` anche con un movimento di ES nei 15 minuti
    prima simile (+/-5 punti), per togliere la selezione "il prezzo e' appena salito
    verso il vertice".
    """
    fuori = []
    for lo_, hi_ in fasce:
        con, base, per = [], [], {}
        for g in giorni:
            gg = g['giorno'].iloc[0]
            dd, hi, sp, pa = (g[c].to_numpy(float) for c in ('dist', 'hi', 'spot', 'pa15'))
            idx = [i for i in range(0, len(g) - 60, 5) if not np.isnan(sp[i]) and not np.all(np.isnan(hi[i:i + 61]))]
            massimo = {i: np.nanmax(hi[i:i + 61]) for i in idx}
            for i in idx:
                d = dd[i]
                if np.isnan(d) or not lo_ <= d < hi_:
                    continue
                ctr = [j for j in idx if abs(j - i) <= 45 and j != i and abs(dd[j] - d) > 10]
                if appaia:
                    ctr = [j for j in ctr if not np.isnan(pa[j]) and not np.isnan(pa[i]) and abs(pa[j] - pa[i]) <= 5]
                if not ctr:
                    continue
                t1 = float(massimo[i] >= sp[i] + d)
                t0 = float(np.mean([massimo[j] >= sp[j] + d for j in ctr]))
                con.append(t1)
                base.append(t0)
                per.setdefault(gg, []).append(t1 - t0)
        medie = {k: np.mean(v) for k, v in per.items()}
        fuori.append({'fascia': f'{lo_}-{hi_}', 'n': len(con), 'vertice': float(np.mean(con)) if con else None, 'controllo': float(np.mean(base)) if base else None,
                      'giorniPiu': sum(v > 0 for v in medie.values()), 'giorniMeno': sum(v < 0 for v in medie.values())})
    return fuori


def tocco_per_gruppi(giorni, grande):
    """Tocco contro la curva (vedi 7c), con la curva ricalcolata dentro ogni gruppo di campioni."""
    righe = []
    for g in giorni:
        v = g.dropna(subset=['es'])
        var = v['es'].iloc[-1] - v['es'].iloc[0]
        dd, hi, sp, s1 = (g[c].to_numpy(float) for c in ('dist', 'hi', 'spot', 's1min'))
        minuti = g.index.to_numpy()
        for i in range(0, len(g) - 60, 5):
            if np.isnan(sp[i]) or np.isnan(s1[i]) or np.isnan(dd[i]) or np.all(np.isnan(hi[i:i + 61])):
                continue
            righe.append((g['giorno'].iloc[0], var, minuti[i], sp[i], dd[i], s1[i] * np.sqrt(60), np.nanmax(hi[i:i + 61])))
    c = pd.DataFrame(righe, columns=['g', 'var', 'm', 'sp', 'd', 's', 'mx'])
    c['u'] = c.d / c.s
    gruppi = [('Giorni con ES su (>= +20)', c['var'] >= 20), ('Giorni con ES giu (<= -20)', c['var'] <= -20), ('Giorni piatti', c['var'].abs() < 20),
              ('Prima delle 12:30 ET', c.m < 750), ('Dalle 12:30 ET', c.m >= 750), ('Senza ' + grande, c.g != grande)]
    fuori = []
    for nome, q in gruppi:
        x = c[q]
        for lo_, hi_ in [(.25, .5), (.5, .75), (.75, 1.0), (1.0, 1.5)]:
            centro = (lo_ + hi_) / 2
            k = x[x.u.between(lo_, hi_, inclusive='left')]
            a = x[(x.d - centro * x.s).abs() > 10]
            fuori.append({'gruppo': nome, 'sigma60': f'{lo_}-{hi_}', 'n': len(k), 'giorni': int(k.g.nunique()),
                          'vertice': float((k.mx >= k.sp + k.d).mean()) if len(k) else None, 'curva': float((a.mx >= a.sp + centro * a.s).mean())})
    return fuori


def reazione_tocco(giorni, scarto=0.0, arma=5.0, vicino=1.0, specchio=False):
    """Primo tocco del livello dopo esserne stati lontani >= arma. + = il prezzo prosegue oltre, - = rimbalza."""
    righe = []
    for g in giorni:
        armato, lato = False, 0
        for m, r in g.iterrows():
            if np.isnan(r['k']) or np.isnan(r['spot']) or np.isnan(r['lo']):
                continue
            liv = r['k'] + scarto if not specchio else 2 * r['spot'] - r['k']
            dd = r['spot'] - liv
            if abs(dd) >= arma:
                armato, lato = True, np.sign(dd)
                continue
            if armato and r['lo'] - vicino <= liv <= r['hi'] + vicino:
                armato = False
                riga = {'giorno': r['giorno'], 'min': m}
                for h in ORIZZONTI:
                    riga[f'fw{h}'] = -lato * r[f'fwp{h}']
                righe.append(riga)
    return pd.DataFrame(righe)


def stampa(titolo, df=None):
    print('\n=== ' + titolo + ' ===')
    if df is not None:
        print(pd.DataFrame(df).round(3).to_string(index=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', default='2026-10-27')
    ap.add_argument('--json')
    args = ap.parse_args()
    pd.set_option('display.width', 250, 'display.max_columns', 40)

    date = [os.path.basename(f)[:10] for f in sorted(glob.glob(os.path.join(RADICE, 'smile', '*.ndjson')))]
    date = [g for g in date if g >= args.dal]
    giorni = [costruisci(d) for d in (carica_giorno(g) for g in date) if d is not None]
    sess = [g[g.index >= INIZIO_STUDIO] for g in giorni]
    out = {'giorni': [g['giorno'].iloc[0] for g in giorni]}

    # 1. Descrittiva e qualita'
    desc = []
    for g in sess:
        val = g.dropna(subset=['k', 'es', 'spot'])
        kk = val['k'].to_numpy()
        fine = val.iloc[-1]
        b = bordo_catena(g['giorno'].iloc[0])
        desc.append(dict(giorno=g['giorno'].iloc[0], copertura=len(val) / len(g), ultimoEt=int(val.index[-1]),
                         esApre=val['es'].iloc[0], esChiude=val['es'].iloc[-1], esVar=val['es'].iloc[-1] - val['es'].iloc[0], esRange=val['es'].max() - val['es'].min(),
                         kVar=kk[-1] - kk[0], cambi=int((kk[1:] != kk[:-1]).sum()), distMed=val['dist'].median(), sigmaMed=val['sigma'].median(),
                         quotaSotto=(val['dist'] < 0).mean(), finaleSpotK=fine['spot'] - fine['k'], bordo10=b['entro10'], bordo5=b['entro5'], iva0=val['iva'].iloc[0]))
    desc = pd.DataFrame(desc)
    stampa('1. DESCRITTIVA E BORDO CATENA', desc)
    out['descrittiva'] = desc.round(3).to_dict('records')
    grande = desc.loc[desc['esVar'].abs().idxmax(), 'giorno']
    resto = [g for g in sess if g['giorno'].iloc[0] != grande]
    out['grande'] = grande
    print('giornata col movimento maggiore:', grande)

    # 2. La discesa meccanica
    tutti = pd.concat(sess)
    tutti['ora'] = (tutti.index // 30) * 30
    tod = tutti.groupby('ora').agg(dist=('dist', 'median'), sigma=('sigma', 'median'), em=('em', 'median'), prof=('prof', 'median'), n=('dist', 'count')).reset_index()
    tod = tod[tod['n'] >= 50]
    stampa("2a. VERTICE PER ORA ET (mediane)", tod)
    out['oraGiorno'] = tod.round(3).to_dict('records')
    chiude = []
    for g in sess:
        v = g.loc[10 * 60:15 * 60 + 50].dropna(subset=['k', 'spot'])
        intera = v.index[-1] >= 15 * 60 + 35
        chiude.append(dict(giorno=g['giorno'].iloc[0], intera=intera, dist0=v['dist'].iloc[0], distF=v['dist'].iloc[-1], dK=v['k'].iloc[-1] - v['k'].iloc[0], dSpot=v['spot'].iloc[-1] - v['spot'].iloc[0]))
    chiude = pd.DataFrame(chiude)
    stampa('2b. DALLE 10:00 ALLE 15:50 ET: CHI CHIUDE LA DISTANZA', chiude)
    out['chiudeDistanza'] = chiude.round(2).to_dict('records')
    for nome, c in (('tutti', chiude), ('senza ' + grande, chiude[chiude.giorno != grande])):
        b, a = np.polyfit(c.dSpot, c.dK, 1)
        print(f'dK = {a:.1f} + {b:.2f} x dSpot  r={np.corrcoef(c.dSpot, c.dK)[0, 1]:.3f} ({nome}, n={len(c)})')
        out['regrK_' + ('tutti' if nome == 'tutti' else 'resto')] = {'a': a, 'b': b, 'r': float(np.corrcoef(c.dSpot, c.dK)[0, 1]), 'n': len(c)}

    # 3. Anticipo/ritardo. L>0 = variazione del vertice a t contro ES dopo t.
    def lag_tabella(gs, finestra, lags):
        fuori = []
        col_k, col_y = f'_dk{finestra}', f'_r{finestra}'
        for lag in lags:
            tmp = []
            for g in gs:
                t = g.copy()
                t[col_k] = t['k'] - t['k'].shift(finestra)
                t['_y'] = ((t['es'] - t['es'].shift(finestra)) / (t['s1min'] * np.sqrt(finestra))).shift(-lag)
                tmp.append(t)
            r, n, p = null_circolare(tmp, col_k, '_y')
            fuori.append({'L': lag, 'r': r, 'n': n, 'p': p})
        return fuori

    lag5 = [-30, -20, -15, -10, -5, 0, 5, 10, 15, 20, 30]
    lag1 = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
    out['lag5'] = lag_tabella(sess, 5, lag5)
    out['lag5resto'] = lag_tabella(resto, 5, lag5)
    out['lag1'] = lag_tabella(sess, 1, lag1)
    out['lag1resto'] = lag_tabella(resto, 1, lag1)
    stampa('3a. ANTICIPO a 5 min (tutti)', out['lag5'])
    stampa('3a. ANTICIPO a 5 min (senza ' + grande + ')', out['lag5resto'])
    stampa('3b. ANTICIPO a 1 min (tutti)', out['lag1'])
    stampa('3b. ANTICIPO a 1 min (senza ' + grande + ')', out['lag1resto'])
    pg = []
    for g in sess:
        x = g['dk5'].to_numpy(float)
        y = (g['pa5'] / (g['s1min'] * np.sqrt(5)))
        pg.append(dict(giorno=g['giorno'].iloc[0], esPrima=corr(x, y.shift(5).to_numpy(float))[0], insieme=corr(x, y.to_numpy(float))[0], verticePrima=corr(x, y.shift(-5).to_numpy(float))[0]))
    stampa('3c. PER GIORNO (5 min)', pg)
    out['lagGiorno'] = pd.DataFrame(pg).round(3).to_dict('records')

    # 4. Predittori di direzione
    pred = ['dist', 'sigma', 'prof', 'dk5', 'dk15', 'dk30', 'rel15', 'rel30', 'dp30', 'pa15', 'pa30']
    tab = []
    for x in pred:
        for h in (15, 30, 60):
            y = f'fw{h}'
            rt, n, pt = null_circolare(sess, x, y)
            rr, _, pr = null_circolare(resto, x, y)
            rd, _, pd_ = null_circolare(senza_media(sess, [x, y]), x, y)
            tab.append(dict(x=x, h=h, r=rt, p=pt, rSenza=rr, pSenza=pr, rDentro=rd, pDentro=pd_, n=n))
    tab = pd.DataFrame(tab)
    tab['qDentro'] = bh(tab['pDentro'].fillna(1))
    tab['qSenza'] = bh(tab['pSenza'].fillna(1))
    stampa('4. DIREZIONE: tutti / senza giornata grande / media del giorno tolta', tab)
    out['predittori'] = tab.round(4).to_dict('records')

    # 5. Salti
    righe = []
    for nome, kw in [('tutti i salti >=5', dict(contro=False)), ('>=5 contro ES, riarmo 15', dict()), ('>=5 in 2 min contro ES, riarmo 30', dict(finestra=2, riarmo=30)), ('>=10 in 5 min contro ES, riarmo 30', dict(soglia=10, finestra=5, riarmo=30))]:
        e = salti_contro(sess, **kw)
        nulli = {h: [] for h in (5, 10, 15)}
        for _ in range(200):
            sh = {g['giorno'].iloc[0]: int(RNG.integers(30, len(g) - 30)) for g in sess}
            x = salti_contro(sess, shift=sh, **kw)
            if len(x):
                for h in nulli:
                    nulli[h].append(np.nanmean(x[f'f{h}']))
        r = {'evento': nome, 'n': len(e), 'prima': e['prima'].mean()}
        for h in (5, 10, 15):
            nn = np.array(nulli[h])
            c = nn.mean()
            m = e[f'f{h}'].mean()
            per = e.groupby('giorno')[f'f{h}'].mean().dropna()
            r[f'f{h}'] = m
            r[f'pos{h}'] = (e[f'f{h}'].dropna() > 0).mean()
            r[f'gp{h}'] = int((per > 0).sum())
            r[f'null{h}'] = c
            r[f'p{h}'] = float(((np.abs(nn - c) >= abs(m - c)).sum() + 1) / (len(nn) + 1))
        righe.append(r)
    stampa('5. SALTI DEL VERTICE: entrata 1 min dopo, punti ES nel verso del salto', righe)
    out['salti'] = pd.DataFrame(righe).round(3).to_dict('records')

    # 6. La chiusura
    pin = []
    for ora in (10 * 60, 11 * 60, 12 * 60, 13 * 60, 14 * 60, 15 * 60):
        ek, es_, ok, tot = [], [], 0, 0
        for g in giorni:
            val = g.dropna(subset=['spot'])
            if val.index[-1] < CHIUSURA - 20 or np.isnan(g.at[ora, 'k']) or np.isnan(g.at[ora, 'spot']):
                continue
            ch = val['spot'].iloc[-1]
            s, k = g.at[ora, 'spot'], g.at[ora, 'k']
            ek.append(abs(ch - k))
            es_.append(abs(ch - s))
            if k != s and ch != s:
                tot += 1
                ok += int(np.sign(k - s) == np.sign(ch - s))
        ek, es_ = np.array(ek), np.array(es_)
        pin.append({'ora': f'{ora // 60:02d}:{ora % 60:02d}', 'giorni': len(ek), 'errVertice': ek.mean(), 'errSpot': es_.mean(), 'verticeMeglio': int((ek < es_).sum()), 'direzioneOk': ok, 'direzioneTot': tot})
    stampa('6. CHIUSURA: errore usando il vertice o lo spot come stima', pin)
    out['chiusura'] = pd.DataFrame(pin).round(2).to_dict('records')

    # 7. Tocchi
    fasce = [(3, 10), (10, 20), (20, 40)]
    for chiave, gs, kw in [('tocco', sess, {}), ('toccoAppaiato', sess, {'appaia': True}), ('toccoSenza', resto, {'appaia': True})]:
        out[chiave] = tocco_controllato(gs, fasce, **kw)
        stampa('7. RAGGIUNGE IL VERTICE ENTRO 60 MIN: ' + chiave, out[chiave])
    tc = []
    for nome, kw in [('vertice', {}), ('vertice -10', {'scarto': -10}), ('vertice -15', {'scarto': -15}), ('specchio sotto lo spot', {'specchio': True})]:
        e = reazione_tocco(sess, **kw)
        r = {'livello': nome, 'n': len(e), 'giorni': e['giorno'].nunique()}
        for h in (5, 15, 30):
            v = e[f'fw{h}'].dropna()
            r[f'm{h}'] = v.mean()
            r[f'pos{h}'] = (v > 0).mean()
        tc.append(r)
    stampa('7b. REAZIONE AL TOCCO: + prosegue, - rimbalza (punti ES)', tc)
    out['reazione'] = pd.DataFrame(tc).round(3).to_dict('records')

    # 8. Ampiezza
    con_abs = []
    for g in sess:
        t = g.copy()
        kk = t['k'].to_numpy(float)
        t['cambi30'] = pd.Series(np.r_[0, (kk[1:] != kk[:-1]).astype(float)], index=t.index).rolling(30).sum()
        t['absSigma'] = t['sigma'].abs()
        t['absDk30'] = t['dk30'].abs()
        t['absPa30'] = (t['pa30'] / (t['s1min'] * np.sqrt(30))).abs()
        for h in (30, 60):
            t[f'a{h}'] = t[f'fw{h}'].abs()
        con_abs.append(t)
    amp = []
    for x in ['absSigma', 'prof', 'cambi30', 'absDk30', 'absPa30']:
        for h in (30, 60):
            r, _, p = null_circolare(con_abs, x, f'a{h}')
            r2, _, p2 = null_circolare([t for t in con_abs if t['giorno'].iloc[0] != grande], x, f'a{h}')
            rd, _, pd2 = null_circolare(senza_media(con_abs, [x, f'a{h}']), x, f'a{h}')
            amp.append(dict(x=x, h=h, r=r, p=p, rSenza=r2, pSenza=p2, rDentro=rd, pDentro=pd2))
    stampa('8. AMPIEZZA: corr con |rendimento futuro| normalizzato', amp)
    out['ampiezza'] = pd.DataFrame(amp).round(4).to_dict('records')

    # 8b. Ampiezza tolta anche l'ora del giorno: |sigma| e prof calano col passare delle ore.
    amp2 = []
    for t in con_abs:
        t['fascia30'] = (t.index // 30) * 30
    for x in ['absSigma', 'prof', 'absDk30', 'absPa30']:
        for h in (30, 60):
            y = f'a{h}'
            tutti_abs = pd.concat(con_abs)
            medie_x = tutti_abs.groupby('fascia30')[x].mean()
            medie_y = tutti_abs.groupby('fascia30')[y].mean()
            tmp = []
            for t in con_abs:
                c = t.copy()
                c[x] = c[x] - c['fascia30'].map(medie_x)
                c[y] = c[y] - c['fascia30'].map(medie_y)
                tmp.append(c)
            r, _, p = null_circolare(tmp, x, y)
            rs, _, ps = null_circolare([c for c in tmp if c['giorno'].iloc[0] != grande], x, y)
            rd, _, pdd = null_circolare(senza_media(tmp, [x, y]), x, y)
            amp2.append(dict(x=x, h=h, r=r, p=p, rSenza=rs, pSenza=ps, rDentro=rd, pDentro=pdd))
    stampa("8b. AMPIEZZA tolta l'ora del giorno", amp2)
    out['ampiezzaOra'] = pd.DataFrame(amp2).round(4).to_dict('records')

    # 7c. Tocco contro una curva: per ogni campione, la distanza in sigma attese a 60 min.
    # La curva viene da TUTTI i livelli a quella distanza nei campioni in cui il vertice sta
    # altrove, su tutti i giorni: non c'e' la selezione "stesso giorno, prezzo piu' basso" di
    # `tocco_controllato`, che a parita' di vertice mette il controllo dove lo spot era piu' basso.
    celle = [(.25, .5), (.5, .75), (.75, 1.0), (1.0, 1.5), (1.5, 2.5)]
    campioni = []
    for g in sess:
        dd, hi, sp, s1 = (g[c].to_numpy(float) for c in ('dist', 'hi', 'spot', 's1min'))
        for i in range(0, len(g) - 60, 5):
            if np.isnan(sp[i]) or np.isnan(s1[i]) or np.isnan(dd[i]) or np.all(np.isnan(hi[i:i + 61])):
                continue
            campioni.append((g['giorno'].iloc[0], sp[i], dd[i], s1[i] * np.sqrt(60), np.nanmax(hi[i:i + 61])))
    camp = pd.DataFrame(campioni, columns=['giorno', 'sp', 'd', 's60', 'mx'])
    curva = []
    for lo_, hi_ in celle:
        centro = (lo_ + hi_) / 2
        c = camp[(camp['d'] / camp['s60']).between(lo_, hi_, inclusive='left')]
        al = camp[(camp['d'] - centro * camp['s60']).abs() > 10]
        tocca_al = al['mx'] >= al['sp'] + centro * al['s60']
        per_c = (c['mx'] >= c['sp'] + c['d']).groupby(c['giorno']).mean()
        per_a = tocca_al.groupby(al['giorno']).mean()
        comuni = per_c.index.intersection(per_a.index)
        curva.append({'sigma60': f'{lo_}-{hi_}', 'n': len(c), 'giorni': len(per_c), 'vertice': float((c['mx'] >= c['sp'] + c['d']).mean()) if len(c) else None, 'curva': float(tocca_al.mean()),
                      'giorniPiu': int((per_c[comuni] > per_a[comuni]).sum()), 'giorniMeno': int((per_c[comuni] < per_a[comuni]).sum())})
    stampa('7c. TOCCO ENTRO 60 MIN contro la curva di tutti i livelli a pari distanza in sigma', curva)
    out['toccoCurva'] = curva
    out['toccoGruppi'] = tocco_per_gruppi(sess, grande)
    stampa('7d. TOCCO PER GRUPPI', out['toccoGruppi'])

    if args.json:
        ser = {}
        for g in giorni:
            a = g[['es', 'spot', 'k']].dropna()
            a = a[a.index % 2 == 0]
            bas = g['es'] - g['spot']
            ser[g['giorno'].iloc[0]] = {
                'min': [int(i) for i in a.index],
                'es': [round(float(v), 2) for v in a['es']],
                'ivm': [round(float(k + bas.loc[i]), 2) for i, k in zip(a.index, a['k'])],
            }
        out['serie'] = ser
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, default=float)


if __name__ == '__main__':
    sys.exit(main())
