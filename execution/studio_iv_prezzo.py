"""Il prezzo anticipa la IV ATM dello 0DTE? E il movimento si puo' operare?

Base: frontend/data/iv-monitor (bid/ask di 5 strike ATM ogni 5 s, dal 19/08/2026). La IV e' ricavata qui
dallo straddle mid (Black-76 sul forward della parita' put-call), cosi' e' uguale per tutti i giorni e prezzo
e IV vengono dalla stessa fotografia. Prima del 25/10 gli strike non si ricentravano: vale solo il minuto
con uno strike entro 5 punti dal forward.

Il predittore al minuto t usa dati fino a t; l'obiettivo parte da t+1, per non contare il rimbalzo del mid.

    python execution/studio_iv_prezzo.py [--dal YYYY-MM-DD] [--json percorso]

Solo dati locali. Parecchi minuti di calcolo.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from studio_ivmin import RADICE, RNG, bh, corr, null_circolare, senza_media, stampa  # noqa: E402
from studio_frecce import senza_ora  # noqa: E402

INIZIO, FINE, ULTIMO = 9 * 60 + 35, 15 * 60 + 30, 15 * 60 + 45
CHIUSURA = 16 * 60
ANNO = 525600.0
ORIZZONTI = [5, 15, 30, 60]
DISTANZA_MAX = 5.0
COSTO_ES = 0.125  # mezzo spread ES per unita' di delta scambiata
PASSO_COPERTURA = 5
GRANDE = '2026-11-05'


def phi(x):
    return np.exp(-0.5 * x * x) / np.sqrt(2 * np.pi)


def N(x):
    """Abramowitz-Stegun 26.2.17: basta e si puo' vettorizzare senza scipy."""
    a = np.abs(x)
    t = 1 / (1 + 0.2316419 * a)
    p = phi(a) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return np.where(x >= 0, 1 - p, p)


def straddle(F, K, s, T):
    v = s * np.sqrt(T)
    d1 = np.log(F / K) / v + v / 2
    return F * (2 * N(d1) - 1) - K * (2 * N(d1 - v) - 1), 2 * N(d1) - 1, 2 * F * phi(d1) * np.sqrt(T) * 0.01


def iv_straddle(prezzo, F, K, T):
    lo, hi = np.full(len(F), 0.01), np.full(len(F), 3.0)
    for _ in range(32):
        m = (lo + hi) / 2
        su = straddle(F, K, m, T)[0] < prezzo
        lo, hi = np.where(su, m, lo), np.where(su, hi, m)
    return (lo + hi) / 2 * 100


def buona(q):
    return q.get('bid') and q.get('ask') and q['bid'] > 0 and q['ask'] >= q['bid']


def carica(percorso):
    giorno = os.path.basename(percorso)[:10]
    try:
        with open(percorso, encoding='utf-8') as f:
            foto = json.load(f)
    except ValueError:
        return None
    righe, catene = [], {}
    for x in foto:
        if not x.get('timestamp'):
            continue
        c = {q['strike']: q for q in x.get('callsData') or [] if buona(q)}
        p = {q['strike']: q for q in x.get('putsData') or [] if buona(q)}
        ks = sorted(set(c) & set(p))
        if not ks:
            continue
        mid = {k: ((c[k]['bid'] + c[k]['ask']) / 2, (p[k]['bid'] + p[k]['ask']) / 2) for k in ks}
        F = float(np.median([k + mid[k][0] - mid[k][1] for k in ks]))
        k = min(ks, key=lambda v: abs(v - F))
        righe.append((x['timestamp'], F, k, sum(mid[k])))
        catene[len(righe) - 1] = {v: (c[v]['bid'], c[v]['ask'], p[v]['bid'], p[v]['ask']) for v in ks}
    if len(righe) < 500:
        return None
    a = pd.DataFrame(righe, columns=['ts', 'F', 'K', 'S'])
    et = pd.to_datetime(a['ts'], unit='s', utc=True).dt.tz_convert('America/New_York')
    a['min'] = et.dt.hour * 60 + et.dt.minute
    a = a[(a['min'] >= 9 * 60 + 30) & (a['min'] < CHIUSURA)]
    if a.empty:
        return None
    T = (CHIUSURA - a['min'].to_numpy(float)) / ANNO
    a['iv'] = iv_straddle(a['S'].to_numpy(), a['F'].to_numpy(), a['K'].to_numpy(), T)
    a.loc[(a['F'] - a['K']).abs() > DISTANZA_MAX, 'iv'] = np.nan
    gr = a.groupby('min')
    d = pd.DataFrame({'F': gr['F'].last(), 'iv': gr['iv'].median(), 'hi': gr['F'].max(), 'lo': gr['F'].min()})
    ultimo = gr.tail(1)
    d = d.reindex(pd.RangeIndex(9 * 60 + 30, CHIUSURA, name='min'))
    d['F'] = d['F'].ffill(limit=2)
    d['iv'] = d['iv'].ffill(limit=2)
    d['giorno'] = giorno
    d['fascia'] = d.index // 30
    d.attrs['catena'] = {int(m): catene[i] for i, m in zip(ultimo.index, ultimo['min'])}
    return d


def costruisci(d):
    d = d.copy()
    F, iv = d['F'], d['iv']
    s1 = F * iv / 100 / np.sqrt(ANNO)  # 1 sigma al minuto implicito, in punti
    em = F * iv / 100 * np.sqrt((CHIUSURA - d.index.to_numpy(float)) / ANNO)
    r1 = F.diff()
    for h in (5, 15, 30, 60):
        z = (F - F.shift(h)) / (s1 * np.sqrt(h))
        d[f'r{h}'] = z
        d[f'a{h}'] = z.abs()
        d[f'ivPassata{h}'] = iv - iv.shift(h)
    for h in (15, 30):
        d[f'giu{h}'] = d[f'r{h}'].clip(upper=0)
        d[f'su{h}'] = d[f'r{h}'].clip(lower=0)
    for h in (15, 30, 60):
        d[f'rv{h}'] = np.sqrt((r1 ** 2).rolling(h, min_periods=int(h * 0.8)).sum() / h) / s1
    for h in (30, 60):
        d[f'rng{h}'] = (d['hi'].rolling(h, min_periods=int(h * 0.8)).max() - d['lo'].rolling(h, min_periods=int(h * 0.8)).min()) / (s1 * np.sqrt(h))
    alto, basso = d['hi'].cummax(), d['lo'].cummin()
    d['pos'] = (F - basso) / (alto - basso).replace(0, np.nan)
    d['daAlto'] = (alto - F) / em
    d['daBasso'] = (F - basso) / em
    d['dallApertura'] = (F - F.dropna().iloc[0]) / em
    d['rangeGiorno'] = (alto - basso) / em
    d['eff30'] = (F - F.shift(30)).abs() / r1.abs().rolling(30, min_periods=24).sum().replace(0, np.nan)
    for h in ORIZZONTI:
        d[f'div{h}'] = iv.shift(-(h + 1)) - iv.shift(-1)
        d.loc[d.index + h + 1 > ULTIMO, f'div{h}'] = np.nan
    # Prezzo e IV insieme e con il prezzo dopo, per inquadrare il rapporto.
    d['divOra5'] = iv - iv.shift(5)
    d['fw5'] = (F.shift(-6) - F.shift(-1)) / (s1 * np.sqrt(5))
    fuori = (d.index < INIZIO) | (d.index > FINE)
    t = d.drop(columns=['hi', 'lo'])
    t.loc[fuori, [c for c in t.columns if c not in ('giorno', 'fascia', 'F', 'iv')]] = np.nan
    t.attrs = d.attrs
    return t


def simula(d, e, h):
    """Straddle ATM comprato al minuto e, tenuto h minuti, coperto in delta ogni PASSO_COPERTURA. Valori per il compratore."""
    cat = d.attrs['catena']
    c0 = cat.get(e)
    x = e + h
    if not c0 or x > ULTIMO or x not in d.index:
        return None
    F0, iv0, Fx, ivx = d.at[e, 'F'], d.at[e, 'iv'], d.at[x, 'F'], d.at[x, 'iv']
    if np.isnan([F0, iv0, Fx, ivx]).any():
        return None
    K = min(c0, key=lambda v: abs(v - F0))
    if abs(K - F0) > DISTANZA_MAX:
        return None
    q = c0[K]
    S0, sp0 = (q[0] + q[1] + q[2] + q[3]) / 2, q[1] - q[0] + q[3] - q[2]
    cx = cat.get(x, {}).get(K)
    if cx:
        Sx, spx, reale = (cx[0] + cx[1] + cx[2] + cx[3]) / 2, cx[1] - cx[0] + cx[3] - cx[2], True
    else:
        Sx, spx, reale = float(straddle(Fx, K, ivx / 100, (CHIUSURA - x) / ANNO)[0]), sp0, False
    copertura, giro, prec = 0.0, 0.0, 0.0
    t = e
    while t < x:
        u = min(t + PASSO_COPERTURA, x)
        Ft, Fu, ivt = d.at[t, 'F'], d.at[u, 'F'], d.at[t, 'iv']
        if np.isnan([Ft, Fu]).any():
            return None
        if not np.isnan(ivt):
            prec_nuovo = float(straddle(Ft, K, ivt / 100, (CHIUSURA - t) / ANNO)[1])
        else:
            prec_nuovo = prec
        giro += abs(prec_nuovo - prec)
        prec = prec_nuovo
        copertura -= prec * (Fu - Ft)
        t = u
    giro += abs(prec)
    vega = float(straddle(F0, K, iv0 / 100, (CHIUSURA - e) / ANNO)[2])
    variazione = Sx - S0
    return dict(giorno=d['giorno'].iloc[0], m=e - 1, h=h, nudo=variazione, coperto=variazione + copertura,
                costoOpz=(sp0 + spx) / 2, costoEs=COSTO_ES * giro, vega=vega, S0=S0, sp0=sp0, reale=reale,
                dIv=ivx - iv0, pezzoVega=vega * (ivx - iv0), mosso=abs(Fx - F0))


def tutte_operazioni(giorni):
    righe = []
    for d in giorni:
        for m in d.index[(d.index >= INIZIO) & (d.index <= FINE)]:
            for h in (15, 30, 60):
                r = simula(d, int(m) + 1, h)
                if r:
                    righe.append(r)
    return pd.DataFrame(righe)


def per_giorno(serie, giorni):
    m = serie.groupby(giorni).mean().dropna()
    if len(m) < 3 or m.std() == 0:
        return float(serie.mean()), len(m), np.nan
    return float(m.mean()), len(m), float(m.mean() / (m.std(ddof=1) / np.sqrt(len(m))))


PREDITTORI = ['r5', 'r15', 'r30', 'r60', 'a5', 'a15', 'a30', 'a60', 'giu15', 'su15', 'giu30', 'su30',
              'rv15', 'rv30', 'rv60', 'rng30', 'rng60', 'pos', 'daAlto', 'daBasso', 'dallApertura', 'rangeGiorno', 'eff30']
MODELLO = ['r15', 'r60', 'a15', 'rv30', 'rv60', 'pos', 'dallApertura', 'rangeGiorno']
PROPRI = ['ivPassata15', 'ivPassata30']


def direzione(giorni):
    meta = len(giorni) // 2
    righe = []
    for h in ORIZZONTI:
        y = f'div{h}'
        for x in PREDITTORI:
            gs = senza_ora(giorni, [x, y])
            r, n, p = null_circolare(gs, x, y)
            rs, _, ps = null_circolare([g for g in gs if g['giorno'].iloc[0] != GRANDE], x, y)
            dentro = senza_media(gs, [x, y])
            rd, _, pd_ = null_circolare(dentro, x, y)
            un = corr(pd.concat(gs[:meta])[x].to_numpy(float), pd.concat(gs[:meta])[y].to_numpy(float))[0]
            du = corr(pd.concat(gs[meta:])[x].to_numpy(float), pd.concat(gs[meta:])[y].to_numpy(float))[0]
            per = [corr(g[x].to_numpy(float), g[y].to_numpy(float))[0] for g in dentro]
            per = [v for v in per if v == v]
            righe.append(dict(x=x, y=y, n=n, r=r, p=p, rSenza=rs, pSenza=ps, rDentro=rd, pDentro=pd_, primaMeta=un, secondaMeta=du,
                              giorniConcordi=sum(1 for v in per if np.sign(v) == np.sign(r)), giorni=len(per)))
    t = pd.DataFrame(righe)
    t['q'] = bh(t['p'].fillna(1))
    t['qDentro'] = bh(t['pDentro'].fillna(1))
    t['regge'] = (t['q'] < 0.1) & (t['qDentro'] < 0.1) & (t['pSenza'] < 0.05) & (np.sign(t['primaMeta']) == np.sign(t['secondaMeta'])) & (t['secondaMeta'].abs() >= 0.05)
    return t


def sull_iv_passata(giorni, candidati):
    """Il prezzo aggiunge qualcosa a quanto dice gia' la IV da sola? Correlazione parziale per fasce."""
    righe = []
    for x, y in candidati:
        gs = senza_ora(giorni, [x, y] + PROPRI)
        t = pd.concat(gs)[[x, y] + PROPRI].dropna()
        A = np.c_[np.ones(len(t)), t[PROPRI].to_numpy()]
        rx = t[x].to_numpy() - A @ np.linalg.lstsq(A, t[x].to_numpy(), rcond=None)[0]
        ry = t[y].to_numpy() - A @ np.linalg.lstsq(A, t[y].to_numpy(), rcond=None)[0]
        solo = corr(t[PROPRI[0]].to_numpy(), t[y].to_numpy())[0]
        righe.append(dict(x=x, y=y, r=corr(t[x].to_numpy(), t[y].to_numpy())[0], rParziale=corr(rx, ry)[0], ivPassata15SuY=solo))
    return pd.DataFrame(righe)


def in_avanti(giorni, h, colonne, minimo=15):
    """Addestra sui giorni precedenti, prevede il successivo. Base di confronto: media della fascia nei soli giorni passati."""
    y = f'div{h}'
    fuori = []
    for i in range(minimo, len(giorni)):
        pas = pd.concat(giorni[:i])[colonne + [y, 'fascia']].dropna()
        ogg = giorni[i][colonne + [y, 'fascia']].dropna()
        if len(ogg) < 20:
            continue
        media_f = pas.groupby('fascia')[y].mean()
        base_gen = pas[y].mean()
        mu, sd = pas[colonne].mean(), pas[colonne].std().replace(0, 1)
        A = np.c_[np.ones(len(pas)), ((pas[colonne] - mu) / sd).to_numpy()]
        ypas = pas[y].to_numpy() - pas['fascia'].map(media_f).to_numpy()
        pen = 1.0 * len(pas) * 0.01 * np.eye(A.shape[1])
        pen[0, 0] = 0
        beta = np.linalg.solve(A.T @ A + pen, A.T @ ypas)
        Ao = np.c_[np.ones(len(ogg)), ((ogg[colonne] - mu) / sd).to_numpy()]
        base = ogg['fascia'].map(media_f).fillna(base_gen).to_numpy()
        fuori.append(pd.DataFrame({'giorno': giorni[i]['giorno'].iloc[0], 'm': ogg.index, 'y': ogg[y].to_numpy(), 'base': base,
                                   'prev': base + Ao @ beta, 'punteggio': Ao @ beta,
                                   'sogliaSu': np.quantile(A @ beta, 0.8), 'sogliaGiu': np.quantile(A @ beta, 0.2)}))
    return pd.concat(fuori) if fuori else pd.DataFrame()


def r2_fuori(t):
    e1, e0 = ((t['y'] - t['prev']) ** 2).sum(), ((t['y'] - t['base']) ** 2).sum()
    return float(1 - e1 / e0)


def regola(prev, ops, h):
    """Compra lo straddle se il modello vede la IV salire, vende se la vede scendere. Una operazione alla volta."""
    o = ops[ops['h'] == h].set_index(['giorno', 'm'])
    righe = []
    for g, t in prev.groupby('giorno'):
        libero = -1
        for r in t.itertuples():
            if r.m < libero:
                continue
            lato = 1 if r.punteggio > r.sogliaSu else -1 if r.punteggio < r.sogliaGiu else 0
            if not lato or (g, r.m) not in o.index:
                continue
            a = o.loc[(g, r.m)]
            lordo = lato * a['coperto']
            righe.append(dict(giorno=g, m=r.m, lato=lato, lordo=lordo, netto=lordo - a['costoOpz'] - a['costoEs'], dIv=lato * a['dIv'], nudoLordo=lato * a['nudo'],
                              nudoNetto=lato * a['nudo'] - a['costoOpz']))
            libero = r.m + h
    return pd.DataFrame(righe)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', default='2026-08-01')
    ap.add_argument('--json')
    a = ap.parse_args()

    giorni, scarti = [], []
    for f in sorted(glob.glob(os.path.join(RADICE, 'iv-monitor', '*.json'))):
        if os.path.basename(f)[:10] < a.dal:
            continue
        d = carica(f)
        if d is None:
            scarti.append((os.path.basename(f)[:10], 'file vuoto o illeggibile'))
            continue
        validi = d.loc[(d.index >= INIZIO) & (d.index <= FINE), 'iv'].notna().sum()
        mediana = d['iv'].median()
        if validi < 120 or not 3 < mediana < 100:
            scarti.append((d['giorno'].iloc[0], f'minuti validi {validi}, IV mediana {mediana:.1f}'))
            continue
        giorni.append(costruisci(d))
    print(f'Sessioni usate {len(giorni)}: {giorni[0]["giorno"].iloc[0]} .. {giorni[-1]["giorno"].iloc[0]}')
    print('Scartate:', scarti)
    esito = {'sessioni': [g['giorno'].iloc[0] for g in giorni], 'scartate': scarti}

    # Controllo: la nostra IV contro quella dello smile v2.
    conf = []
    for g in giorni:
        p = os.path.join(RADICE, 'smile', g['giorno'].iloc[0] + '.ndjson')
        if not os.path.exists(p) or g['giorno'].iloc[0] < '2026-10-27':
            continue
        with open(p, encoding='utf-8') as f:
            let = [json.loads(x) for x in f if x.strip()]
        s = {}
        for r in let:
            if r.get('v') == 2 and r.get('tEt'):
                hh, mm, _ = r['tEt'].split(':')
                s[int(hh) * 60 + int(mm)] = r['ivAtm']
        x = pd.Series(s).reindex(g.index)
        ok = x.notna() & g['iv'].notna() & (g.index >= INIZIO) & (g.index <= FINE)
        conf.append(dict(giorno=g['giorno'].iloc[0], n=int(ok.sum()), corr=float(np.corrcoef(x[ok], g['iv'][ok])[0, 1]),
                         corr5=corr(x.diff(5)[ok].to_numpy(float), g['iv'].diff(5)[ok].to_numpy(float))[0], scarto=float((g['iv'][ok] - x[ok]).median())))
    stampa('0. IV DA STRADDLE CONTRO IV ATM DELLO SMILE', pd.DataFrame(conf))

    gi = pd.concat(giorni)
    # 1. Il quadro: livello per ora, rapporto contemporaneo.
    orario = gi.groupby('fascia').agg(iv=('iv', 'median'), div15=('div15', 'mean'), sdDiv15=('div15', 'std')).reset_index()
    orario['ora'] = orario['fascia'].map(lambda f: f'{f // 2:02d}:{(f % 2) * 30:02d}')
    stampa('1a. IV PER FASCIA (ora New York)', orario[['ora', 'iv', 'div15', 'sdDiv15']])
    insieme = []
    gs = senza_ora(giorni, ['r5', 'divOra5', 'div5', 'fw5'])
    insieme.append(dict(cosa='IV e prezzo negli stessi 5 min', **dict(zip(('r', 'n', 'p'), null_circolare(gs, 'r5', 'divOra5')))))
    insieme.append(dict(cosa='prezzo prima, IV dopo (5 min)', **dict(zip(('r', 'n', 'p'), null_circolare(gs, 'r5', 'div5')))))
    insieme.append(dict(cosa='IV prima, prezzo dopo (5 min)', **dict(zip(('r', 'n', 'p'), null_circolare(gs, 'divOra5', 'fw5')))))
    stampa('1b. CHI VA PER PRIMO', pd.DataFrame(insieme))
    esito['orario'] = orario.to_dict('records')
    esito['insieme'] = insieme

    # 2. Prove singole.
    t = direzione(giorni)
    colonne = ['x', 'y', 'n', 'r', 'p', 'q', 'rSenza', 'pSenza', 'rDentro', 'qDentro', 'primaMeta', 'secondaMeta', 'giorniConcordi', 'giorni', 'regge']
    stampa(f'2a. PREZZO -> IV: prove {len(t)}, reggono {int(t["regge"].sum())}. LE PIU FORTI', t.reindex(t['r'].abs().sort_values(ascending=False).index)[colonne].head(25))
    esito['prove'] = t.to_dict('records')
    cand = [(r.x, r.y) for r in t.reindex(t['r'].abs().sort_values(ascending=False).index).head(12).itertuples()]
    par = sull_iv_passata(giorni, cand)
    stampa('2b. AL NETTO DELLA IV PASSATA', par)
    esito['parziali'] = par.to_dict('records')

    # 3. Grandezza: fasce di movimento recente.
    tutti = pd.concat(senza_ora(giorni, ['div15', 'div30', 'div60']))
    fasce = pd.cut(tutti['r15'], [-np.inf, -2, -1, -0.5, 0.5, 1, 2, np.inf])
    gr = tutti.groupby(fasce, observed=True).agg(minuti=('div15', 'size'), div15=('div15', 'mean'), div30=('div30', 'mean'), div60=('div60', 'mean'), giorni=('giorno', 'nunique')).reset_index()
    gr['r15'] = gr['r15'].astype(str)
    stampa('3a. IV DOPO, PER MOVIMENTO DEGLI ULTIMI 15 MIN (r15 in sigma; 0 = media di quell ora)', gr)
    esito['fasceR15'] = gr.to_dict('records')
    fasce = pd.cut(tutti['rv30'], [0, 0.5, 0.75, 1, 1.25, 1.5, 2, np.inf])
    gr = tutti.groupby(fasce, observed=True).agg(minuti=('div15', 'size'), div15=('div15', 'mean'), div30=('div30', 'mean'), div60=('div60', 'mean'), giorni=('giorno', 'nunique')).reset_index()
    gr['rv30'] = gr['rv30'].astype(str)
    stampa('3b. IV DOPO, PER VOLATILITA REALIZZATA / IMPLICITA DEGLI ULTIMI 30 MIN', gr)
    esito['fasceRv30'] = gr.to_dict('records')

    # 4. Previsione fuori campione.
    ops = tutte_operazioni(giorni)
    righe, regole = [], []
    for h in (15, 30, 60):
        solo_iv = in_avanti(giorni, h, PROPRI)
        prezzo = in_avanti(giorni, h, MODELLO)
        ins = in_avanti(giorni, h, MODELLO + PROPRI)
        righe.append(dict(h=h, giorni=prezzo['giorno'].nunique(), n=len(prezzo), r2SoloIv=r2_fuori(solo_iv), r2SoloPrezzo=r2_fuori(prezzo), r2Insieme=r2_fuori(ins),
                          rPrezzo=corr(prezzo['punteggio'].to_numpy(), (prezzo['y'] - prezzo['base']).to_numpy())[0],
                          rInsieme=corr(ins['punteggio'].to_numpy(), (ins['y'] - ins['base']).to_numpy())[0],
                          segnoPrezzo=float((np.sign(prezzo['punteggio']) == np.sign(prezzo['y'] - prezzo['base'])).mean())))
        for nome, pv in (('prezzo', prezzo), ('prezzo + IV passata', ins)):
            g = regola(pv, ops, h)
            if g.empty:
                continue
            lo, _, tl = per_giorno(g['lordo'], g['giorno'])
            ne, gg, tn = per_giorno(g['netto'], g['giorno'])
            nu, _, tu = per_giorno(g['nudoNetto'], g['giorno'])
            regole.append(dict(modello=nome, h=h, operazioni=len(g), giorni=gg, comprati=int((g['lato'] > 0).sum()), lordoCoperto=lo, tLordo=tl, nettoCoperto=ne, tNetto=tn,
                               nudoNetto=nu, tNudo=tu, ivAFavore=float(g['dIv'].mean()), segnoIv=float((g['dIv'] > 0).mean()),
                               nettoSenza=float(g.loc[g['giorno'] != GRANDE, 'netto'].mean())))
    stampa('4a. PREVISIONE DELLA IV FUORI CAMPIONE (R2 sopra la media di fascia; negativo = peggio di niente)', pd.DataFrame(righe))
    stampa('4b. REGOLA: COMPRO O VENDO LO STRADDLE SECONDO IL MODELLO (punti SPX per operazione)', pd.DataFrame(regole))
    esito['fuoriCampione'] = righe
    esito['regole'] = regole

    # 5. Un segnale esatto sulla IV basterebbe?
    costi, oracolo = [], []
    ops['fascia'] = ((ops['m'] + 1) // 30)
    for h in (15, 30, 60):
        o = ops[ops['h'] == h].copy()
        for nome, s in (('10:00-11:30', o[o['m'] < 11 * 60 + 30]), ('11:30-13:30', o[(o['m'] >= 11 * 60 + 30) & (o['m'] < 13 * 60 + 30)]), ('13:30-15:30', o[o['m'] >= 13 * 60 + 30])):
            costi.append(dict(h=h, ore=nome, n=len(s), straddle=s['S0'].median(), vegaPerPunto=s['vega'].median(), spread=s['sp0'].median(), costoOpz=s['costoOpz'].median(), costoEs=s['costoEs'].median(),
                              puntiVolPerPareggio=((s['costoOpz'] + s['costoEs']) / s['vega']).median(), dIvTipico=s['dIv'].abs().median()))
        rv = corr(o['coperto'].to_numpy(), o['pezzoVega'].to_numpy())[0]
        q = o.groupby('giorno')['dIv'].transform(lambda v: v.rank(pct=True))
        netta = lambda v: v['coperto'] - v['costoOpz'] - v['costoEs']
        al, _, tal = per_giorno(o['coperto'], o['giorno'])
        lungo = o[o['dIv'] >= o['dIv'].quantile(0.8)]
        corto = o[o['dIv'] <= o['dIv'].quantile(0.2)]
        oracolo.append(dict(h=h, n=len(o), rPnlConDIv=rv, compraSempreLordo=al, tSempre=tal, compraSempreNetto=float(netta(o).mean()), vendiSempreNetto=float((-o['coperto'] - o['costoOpz'] - o['costoEs']).mean()),
                            indovinoIvSuNetto=float(netta(lungo).mean()), indovinoIvGiuNetto=float((-corto['coperto'] - corto['costoOpz'] - corto['costoEs']).mean()),
                            quotaRealeUscita=float(o['reale'].mean())))
    stampa('5a. QUANTO COSTA: punti di vol da guadagnare per pagare spread e copertura', pd.DataFrame(costi))
    stampa('5b. E SE SI SAPESSE LA IV IN ANTICIPO (20% maggiori rialzi / ribassi, punti SPX)', pd.DataFrame(oracolo))
    esito['costi'] = costi
    esito['oracolo'] = oracolo

    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(esito, f, ensure_ascii=False, indent=1, default=lambda v: None if isinstance(v, float) and v != v else (float(v) if isinstance(v, np.floating) else int(v) if isinstance(v, np.integer) else bool(v) if isinstance(v, np.bool_) else str(v)))


if __name__ == '__main__':
    main()
