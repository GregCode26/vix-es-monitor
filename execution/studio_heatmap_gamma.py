"""
Studio: quale base della mappa di calore (/hedging-pressure, vista Mappa Calore)
e' stata la lettura piu' valida: Open Interest, Volume o Lee-Ready?

    python execution/studio_heatmap_gamma.py [--verifica]   # scrive .tmp/studio_heatmap_gamma.md

Dati: `serie` e `spot` di /api/gex?flow=0&date=YYYY-MM-DD, cioe' le stesse
fotografie ogni 2 minuti che la mappa colora (con ?date= la route legge solo i
file locali, mai Supabase; il dashboard deve essere acceso la prima volta, poi
resta la copia in .tmp/studio_heatmap/). Nessuna richiesta a IBKR. Ogni lettura
usa solo la fotografia gia' nota in quel minuto.

Stessi minuti per tutte e tre le basi: 10:00-16:00 NY, solo dove il Lee-Ready
ha dati. Le tre domande sono quelle che la mappa suggerisce guardandola:

A. CALAMITA  il prezzo va verso lo strike piu' forte entro +-50 punti? Tre
             livelli: massimo positivo (POS), massimo negativo (NEG), massimo in
             valore assoluto (ABS). Punti fatti verso il livello in finestre non
             sovrapposte di 15/30/60 min, e dalle 13/14/15 NY fino alla chiusura.
B. TENUTA    toccando uno strike forte il prezzo rimbalza piu' del solito? Eventi
             uguali per tutte le basi: ogni tocco di qualsiasi strike (armato a >=6
             punti, rimbalzo = 5 punti indietro prima di 5 punti oltre, entro 30
             min). Si confronta il quinto piu' forte col resto degli strike.
C. REGIME    con gamma netto negativo attorno allo spot il prezzo si muove di piu'?
             netto = somma(GEX)/somma(|GEX|) entro +-25 punti, contro il range dei
             30 minuti dopo, al netto di ora del giorno e range dei 30 minuti prima.

Regola decisa PRIMA di guardare i risultati. Una lettura e' valida solo se, nel
verso atteso: |t| >= 2 sulle medie giornaliere, stesso segno nelle due meta' delle
giornate, e p < 0.05 nella prova di permutazione (la mappa di un altro giorno sui
prezzi di oggi: stessa forma, nessuna informazione; per la tenuta B, che confronta
strike dello stesso giorno, basta il controllo interno col resto degli strike).
Test principali: A a 30 min, B e C. Sono 18 in tutto (6 per base): a caso se ne
aspetta circa uno che passi t >= 2.

Risultati del 09/11/2026 (20 giornate a tre basi, 01/10-06/11; 41 per OI e Volume):
- Nessuna base da' un segnale operabile. Due test su 18 passano la regola, e nessuno
  dei due regge alla verifica (--verifica).
- Tenuta: Volume passava (+20%, t +2.2), ma era la media dei giorni, che pesa uguale un
  giorno con un tocco e uno con trenta. Contando tutti i tocchi: 45% contro 44%; in
  nessuna base lo strike forte rimbalza piu' degli altri.
- Regime: Lee-Ready passava dentro la giornata (-0.15, t -2.6), ma sparisce con banda
  +-15 e con finestre di 15 o 60 minuti. Su tutti i dati insieme le tre basi si
  equivalgono: col netto alto il range dopo e' ~20% piu' basso, e nelle 21 giornate
  precedenti OI e Volume non lo confermano (-0.07 e +0.02).
- Calamita: POS di OI e Volume porta nel verso sbagliato (-1.89, -3.63 punti a 30 min),
  Lee-Ready nel verso giusto ma non abbastanza (+1.62, t +1.4).
"""

import glob
import json
import os
import sys
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_heatmap')
VOLUMI = os.path.join(RADICE, 'frontend', 'data', 'volumes')
USCITA = os.path.join(RADICE, '.tmp', 'studio_heatmap_gamma.md')
URL = 'http://localhost:3000/api/gex?flow=0&date={}'

BASI = {'gexOi': 'Open Interest', 'gex': 'Volume', 'gexLr': 'Lee-Ready'}
INIZIO, FINE = 600, 960        # minuti NY: 10:00-16:00. Prima il volume e' troppo poco.
BANDA, BANDA_NETTO = 50, 25    # punti attorno allo spot
ORIZZONTI = [15, 30, 60]
MIN_MINUTI = 180               # una giornata conta se ha almeno 3 ore utili
ARMA, ESITO, ATTESA = 6, 5, 30 # tocco: armato a 6 punti, esito a +-5, entro 30 minuti
N_PERM = 2000
rng = np.random.default_rng(0)
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')


def minuto_ny(giorno, ora):
    """Le ore dei file sono italiane: si convertono ogni volta (cambi d'ora diversi)."""
    t = datetime.fromisoformat(f'{giorno}T{ora}').replace(tzinfo=ROMA).astimezone(NY)
    return t.hour * 60 + t.minute + t.second / 60


def scarica(giorno):
    p = os.path.join(CACHE, f'{giorno}.json')
    if not os.path.exists(p):
        os.makedirs(CACHE, exist_ok=True)
        try:
            with urllib.request.urlopen(URL.format(giorno), timeout=170) as r:
                open(p, 'wb').write(r.read())
        except Exception:
            return None
    return json.load(open(p))


def carica(giorno):
    d = scarica(giorno)
    if not d or not d.get('serie') or not d.get('spot'):
        return None
    strikes = np.array(d['strikes'], float)
    tf = np.array([minuto_ny(giorno, f['time']) for f in d['serie']])
    basi = {b: np.array([f.get(b) or [0] * len(strikes) for f in d['serie']], float) for b in BASI}
    ts = np.array([minuto_ny(giorno, p['time']) for p in d['spot']])
    ps = np.array([p['price'] for p in d['spot']], float)
    ok = (ts >= 570) & (ts <= 960) & (ps > 0)
    ts, ps = ts[ok], ps[ok]
    if len(ts) < 60:
        return None
    griglia = np.arange(INIZIO, FINE + 1)
    i = np.searchsorted(ts, griglia, side='right') - 1
    S = np.where((i >= 0) & (griglia - ts[np.clip(i, 0, None)] <= 3), ps[np.clip(i, 0, None)], np.nan)
    j = np.searchsorted(tf, griglia, side='right') - 1
    fresca = (j >= 0) & (griglia - tf[np.clip(j, 0, None)] <= 5)
    F = np.clip(j, 0, None)
    return dict(giorno=giorno, strikes=strikes, S=S, F=F, fresca=fresca, basi=basi, ts=ts, ps=ps,
                tf=tf, conLr=bool(d.get('conLr')))


def livelli(g, b):
    """Per ogni minuto: strike POS/NEG/ABS entro la banda e netto attorno allo spot."""
    n = len(g['S'])
    out = {k: np.full(n, np.nan) for k in ('POS', 'NEG', 'ABS', 'netto')}
    K = g['strikes']
    for m in range(n):
        s = g['S'][m]
        if not g['fresca'][m] or np.isnan(s):
            continue
        v = g['basi'][b][g['F'][m]]
        d = np.abs(K - s)
        vicini = (d <= BANDA) & (d >= 2.5)   # sopra lo spot o sotto: serve una direzione
        if vicini.any():
            w = np.where(vicini, v, np.nan)
            if np.nanmax(w) > 0:
                out['POS'][m] = K[np.nanargmax(w)]
            if np.nanmin(w) < 0:
                out['NEG'][m] = K[np.nanargmin(w)]
            a = np.abs(w)
            if np.nanmax(a) > 0:
                out['ABS'][m] = K[np.nanargmax(a)]
        z = d <= BANDA_NETTO
        tot = np.abs(v[z]).sum()
        if tot > 0:
            out['netto'][m] = v[z].sum() / tot
    return out


def t_giorni(x):
    x = np.array([v for v in x if np.isfinite(v)])
    if len(x) < 3 or x.std(ddof=1) == 0:
        return float('nan')
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))


def riga_giorni(x):
    """media, t, quota di giorni positivi, le due meta'."""
    x = np.array(x, float)
    v = x[np.isfinite(x)]
    meta = len(x) // 2
    return dict(media=np.nanmean(x), t=t_giorni(x), pos=(v > 0).mean(), n=len(v),
                prima=np.nanmean(x[:meta]), seconda=np.nanmean(x[meta:]))


# --- A. Calamita -------------------------------------------------------------

def direzioni(g, liv):
    return np.sign(liv - g['S'])


def stat_calamita(dirs, prezzi, h):
    """Medie giornaliere dei punti verso il livello, finestre non sovrapposte."""
    per_giorno = []
    for d, s in zip(dirs, prezzi):
        idx = np.arange(0, min(len(s), len(d)) - h, h)
        r = d[idx] * (s[idx + h] - s[idx])
        per_giorno.append(np.nanmean(r) if np.isfinite(r).sum() else np.nan)
    return per_giorno


def verso_chiusura(g, liv, ore=(780, 840, 900)):
    s = g['S']
    fin = s[np.isfinite(s)]
    if not len(fin):
        return np.nan
    chiusura = fin[-1]
    r = np.array([np.sign(liv[o - INIZIO] - s[o - INIZIO]) * (chiusura - s[o - INIZIO]) for o in ore])
    return np.nanmean(r) if np.isfinite(r).any() else np.nan


def perm_p(fn, dirs, prezzi, osservato, verso):
    """p a una coda con la mappa di un altro giorno sui prezzi di oggi."""
    n = len(dirs)
    conta = 0
    for _ in range(N_PERM):
        while True:
            q = rng.permutation(n)
            if (q != np.arange(n)).all():
                break
        v = np.nanmean(fn([dirs[i] for i in q], prezzi))
        if verso * v >= verso * osservato:
            conta += 1
    return (conta + 1) / (N_PERM + 1)


# --- B. Tenuta ---------------------------------------------------------------

def tocchi(g, ESITO=ESITO):
    """Tutti i tocchi di tutti gli strike, uguali per le tre basi."""
    t, p = g['ts'], g['ps']
    eventi = []
    for K in g['strikes']:
        if K < np.nanmin(p) - 1 or K > np.nanmax(p) + 1:
            continue
        lato = 0
        for i in range(1, len(p)):
            d = p[i] - K
            if t[i] < INIZIO or t[i] > FINE - ATTESA:
                if abs(d) >= ARMA:
                    lato = np.sign(d)
                continue
            if abs(d) >= ARMA:
                lato = np.sign(d)
            elif lato != 0 and (abs(d) <= 1 or np.sign(d) != lato):
                esito, mossa = None, 0.0
                for k in range(i + 1, len(p)):
                    if t[k] - t[i] > ATTESA:
                        break
                    if t[k] - t[i] <= 15:
                        mossa = max(mossa, abs(p[k] - p[i]))
                    x = (p[k] - K) * lato
                    if esito is None and x >= ESITO:
                        esito = 1
                    elif esito is None and x <= -ESITO:
                        esito = 0
                eventi.append(dict(K=K, t=t[i], s=p[i], esito=esito, mossa=mossa, lato=lato))
                lato = 0
    return eventi


def tenuta(g, ev, b):
    """Per giorno: tenuta del quinto piu' forte (positivi e negativi) e del resto."""
    K = g['strikes']
    su, giu, resto, mp, mn, mr = [], [], [], [], [], []
    for e in ev:
        m = int(e['t']) - INIZIO
        if m < 0 or m >= len(g['F']) or not g['fresca'][m]:
            continue
        v = g['basi'][b][g['F'][m]]
        z = np.abs(K - e['s']) <= BANDA
        if not np.abs(v[z]).sum():
            continue
        valore = v[K == e['K']]
        if not len(valore):
            continue
        rango = (np.abs(v[z]) <= abs(valore[0])).mean()
        if rango >= 0.8 and valore[0] > 0:
            su.append(e['esito']); mp.append(e['mossa'])
        elif rango >= 0.8 and valore[0] < 0:
            giu.append(e['esito']); mn.append(e['mossa'])
        else:
            resto.append(e['esito']); mr.append(e['mossa'])

    def media(a):
        x = [q for q in a if q is not None]
        return float(np.mean(x)) if x else np.nan

    return dict(su=media(su), giu=media(giu), resto=media(resto), n_su=len(su), n_giu=len(giu), n_resto=len(resto),
                mp=media(mp), mn=media(mn), mr=media(mr))


# --- C. Regime ---------------------------------------------------------------

def righe_regime(g, netto, h=30):
    s = g['S']
    out = []
    for m in range(h, len(s) - h, h):
        a, b = s[m - h:m + 1], s[m:m + h + 1]
        if np.isnan(netto[m]) or np.isnan(a).sum() > 5 or np.isnan(b).sum() > 5:
            continue
        rp, rf = np.nanmax(a) - np.nanmin(a), np.nanmax(b) - np.nanmin(b)
        if rp <= 0 or rf <= 0:
            continue
        out.append((m // 30, np.log(rp), np.log(rf), netto[m]))
    return out


def residui_regime(tabelle):
    """log(range dopo) al netto di fascia oraria e range prima: OLS su tutte le giornate."""
    tutte = np.array([r for t in tabelle for r in t])
    fasce = sorted(set(tutte[:, 0]))
    X = np.column_stack([tutte[:, 1]] + [(tutte[:, 0] == f).astype(float) for f in fasce])
    beta = np.linalg.lstsq(X, tutte[:, 2], rcond=None)[0]
    res = tutte[:, 2] - X @ beta
    uscita, i = [], 0
    for t in tabelle:
        uscita.append(res[i:i + len(t)])
        i += len(t)
    return uscita


def corr_giorno(netto, res):
    if len(netto) < 5 or np.std(netto) == 0 or np.std(res) == 0:
        return np.nan
    # Spearman: Pearson sui ranghi (qui i pareggi sono rarissimi).
    return np.corrcoef(np.argsort(np.argsort(netto)), np.argsort(np.argsort(res)))[0, 1]


# --- Descrizione delle letture ----------------------------------------------

def descrizione(g, liv):
    """Quanto e' stabile il livello e quanto sta incollato allo spot."""
    k = liv['ABS']
    ok = np.isfinite(k)
    if ok.sum() < 30:
        return None
    v = k[ok]
    cambi = (np.diff(v) != 0).sum()
    return dict(durata=ok.sum() / (cambi + 1), dist=np.median(np.abs(v - g['S'][ok])),
                vicino=(np.abs(v - g['S'][ok]) <= 5).mean())


def qualita_lr(giorno):
    """Quota del volume classificata e azzeramenti veri: un conto che cala sullo stesso
    strike. Il totale cala anche quando il poller ricentra la catena (escono degli
    strike e ne entrano di nuovi, da zero): quello non e' un azzeramento."""
    p = os.path.join(VOLUMI, f'{giorno}.json')
    try:
        righe = json.load(open(p))
    except Exception:
        return None
    tot, azzerati, prima = [], 0, {}
    for r in righe:
        vv = [x for x in r.get('volumes', []) if x.get('cb') is not None]
        if not vv:
            continue
        lr = sum(x['cb'] + x['cs'] + x['pb'] + x['ps'] for x in vv)
        vol = sum((x.get('calls') or 0) + (x.get('puts') or 0) for x in vv)
        ora = {x['strike']: x['cb'] + x['cs'] + x['pb'] + x['ps'] for x in vv}
        if any(k in prima and n < prima[k] * 0.9 for k, n in ora.items()):
            azzerati += 1
        prima = ora
        tot.append((lr, vol))
    if not tot:
        return None
    return dict(quota=tot[-1][0] / tot[-1][1] if tot[-1][1] else np.nan, azzerati=azzerati)


# --- Una corsa completa su un elenco di giornate ----------------------------

def analisi(giornate, basi, con_perm=True):
    ris = {}
    prezzi = [g['S'] for g in giornate]
    ev = [tocchi(g) for g in giornate]
    liv = {b: [livelli(g, b) for g in giornate] for b in basi}
    for b in basi:
        r = {}
        for nome in ('POS', 'NEG', 'ABS'):
            dirs = [direzioni(g, l[nome]) for g, l in zip(giornate, liv[b])]
            for h in ORIZZONTI:
                x = stat_calamita(dirs, prezzi, h)
                r[f'A {nome} {h}'] = riga_giorni(x)
                if con_perm and h == 30:
                    verso = 1 if nome != 'NEG' else (np.sign(np.nanmean(x)) or 1)
                    r[f'A {nome} {h}']['p'] = perm_p(lambda d, s: stat_calamita(d, s, h), dirs, prezzi, np.nanmean(x), verso)
            r[f'A {nome} chiusura'] = riga_giorni([verso_chiusura(g, l[nome]) for g, l in zip(giornate, liv[b])])
        tn = [tenuta(g, e, b) for g, e in zip(giornate, ev)]
        r['B pos'] = riga_giorni([x['su'] - x['resto'] for x in tn])
        r['B neg'] = riga_giorni([x['giu'] - x['resto'] for x in tn])
        r['B dett'] = {k: np.nansum([x[k] for x in tn]) for k in ('n_su', 'n_giu', 'n_resto')}
        r['B tassi'] = {k: np.nanmean([x[k] for x in tn]) for k in ('su', 'giu', 'resto', 'mp', 'mn', 'mr')}
        r['B mossa neg'] = riga_giorni([x['mn'] - x['mr'] for x in tn])
        tab = [righe_regime(g, l['netto']) for g, l in zip(giornate, liv[b])]
        res = residui_regime(tab)
        netti = [np.array([q[3] for q in t]) for t in tab]
        corr = [corr_giorno(n, e) for n, e in zip(netti, res)]
        r['C'] = riga_giorni(corr)
        if con_perm:
            osservato = np.nanmean(corr)
            conta, n = 0, len(tab)
            for _ in range(N_PERM):
                q = rng.permutation(n)
                v = []
                for i in range(n):
                    # Stessa fascia oraria: la prima riga di ogni giorno non e' la stessa ora.
                    da = {riga[0]: riga[3] for riga in tab[q[i]]}
                    coppie = [(da[riga[0]], e) for riga, e in zip(tab[i], res[i]) if riga[0] in da]
                    if coppie:
                        a, e = np.array(coppie).T
                        v.append(corr_giorno(a, e))
                if np.nanmean(v) <= osservato:
                    conta += 1
            r['C']['p'] = (conta + 1) / (N_PERM + 1)
        n_tutti, e_tutti = np.concatenate(netti), np.concatenate(res)
        q1, q2 = np.quantile(n_tutti, [1 / 3, 2 / 3])
        r['C terzili'] = (np.exp(e_tutti[n_tutti <= q1].mean()), np.exp(e_tutti[n_tutti >= q2].mean()))
        r['C quota neg'] = (n_tutti < 0).mean()
        des = [d for d in (descrizione(g, l) for g, l in zip(giornate, liv[b])) if d]
        r['descr'] = {k: np.median([d[k] for d in des]) for k in ('durata', 'dist', 'vicino')}
        ris[b] = r
    return ris


def fmt(r):
    p = f"{r['p']:.3f}" if 'p' in r else '-'
    return f"{r['media']:+.2f} | {r['t']:+.1f} | {r['pos'] * 100:.0f}% | {r['prima']:+.2f} / {r['seconda']:+.2f} | {p}"


def passa(r, verso):
    return (np.isfinite(r['t']) and verso * r['t'] >= 2 and verso * r['prima'] > 0 and verso * r['seconda'] > 0
            and r.get('p', 0) < 0.05)


def tabella_basi(out, ris, basi):
    out.append('| lettura | base | media | t | giorni + | 1a / 2a meta | p perm |')
    out.append('|---|---|---|---|---|---|---|')
    for chiave, titolo in [('A POS 30', 'A POS 30 min (punti verso)'), ('A NEG 30', 'A NEG 30 min (punti verso)'), ('A ABS 30', 'A ABS 30 min (punti verso)')]:
        for b in basi:
            out.append(f"| {titolo} | {BASI[b]} | {fmt(ris[b][chiave])} |")
    for b in basi:
        out.append(f"| B tenuta strike forte + meno resto | {BASI[b]} | {fmt(ris[b]['B pos'])} |")
    for b in basi:
        out.append(f"| B tenuta strike forte - meno resto | {BASI[b]} | {fmt(ris[b]['B neg'])} |")
    for b in basi:
        out.append(f"| C corr netto / range dopo | {BASI[b]} | {fmt(ris[b]['C'])} |")


# --- Verifica delle letture che passano la regola (--verifica) -----------------

def classe(g, K, s, m, b, soglia=0.8):
    """1 = strike forte positivo, 2 = forte negativo, 0 = resto, None = mappa assente."""
    if m < 0 or m >= len(g['F']) or not g['fresca'][m]:
        return None
    ks = g['strikes']
    v = g['basi'][b][g['F'][m]]
    z = np.abs(ks - s) <= BANDA
    i = np.argmin(np.abs(ks - K))
    if abs(ks[i] - K) > 2.5 or not np.abs(v[z]).sum():
        return None
    if (np.abs(v[z]) <= abs(v[i])).mean() < soglia or v[i] == 0:
        return 0
    return 1 if v[i] > 0 else 2


def diff_tenuta(eventi_classi, filtro=None):
    """Per giorno: rimbalzo sugli strike forti positivi meno il resto."""
    x = []
    for ev, cl in eventi_classi:
        su, re = [], []
        for e, c in zip(ev, cl):
            if e['esito'] is None or c is None or (filtro and not filtro(e)):
                continue
            if c == 1:
                su.append(e['esito'])
            elif c == 0:
                re.append(e['esito'])
        x.append(np.mean(su) - np.mean(re) if su and re else np.nan)
    return x


def riga_v(nome, x):
    r = riga_giorni(x)
    return f"| {nome} | {r['media']:+.3f} | {r['t']:+.1f} | {r['n']} | {r['pos'] * 100:.0f}% |"


def classi_di(giornate, eventi, b, soglia=0.8):
    return [[classe(g, e['K'], e['s'], int(e['t']) - INIZIO, b, soglia) for e in es] for g, es in zip(giornate, eventi)]


def verifica_tenuta(giornate, lunghe, b='gex'):
    out = ['## Verifica: tenuta sugli strike forti positivi (Volume)\n',
           '| variante | rimbalzo forte+ meno resto | t | giorni | giorni + |', '|---|---|---|---|---|']
    ev = [tocchi(g) for g in giornate]
    classi = classi_di(giornate, ev, b)
    coppie = list(zip(ev, classi))
    base = diff_tenuta(coppie)
    out.append(riga_v('base (tocchi uguali al test)', base))
    out.append(riga_v('arrivando da sotto', diff_tenuta(coppie, lambda e: e['lato'] < 0)))
    out.append(riga_v('arrivando da sopra', diff_tenuta(coppie, lambda e: e['lato'] > 0)))
    out.append(riga_v('prima delle 13 NY', diff_tenuta(coppie, lambda e: e['t'] < 780)))
    out.append(riga_v('dalle 13 NY', diff_tenuta(coppie, lambda e: e['t'] >= 780)))
    out.append(riga_v('strike tondi (multipli di 25)', diff_tenuta(coppie, lambda e: e['K'] % 25 == 0)))
    out.append(riga_v('strike non tondi', diff_tenuta(coppie, lambda e: e['K'] % 25 != 0)))
    for soglia in (0.7, 0.9):
        out.append(riga_v(f'quinto forte -> soglia {soglia}', diff_tenuta(list(zip(ev, classi_di(giornate, ev, b, soglia))))))
    for esito in (3, 4, 7):
        ev2 = [tocchi(g, esito) for g in giornate]
        out.append(riga_v(f'esito a {esito} punti invece di 5', diff_tenuta(list(zip(ev2, classi_di(giornate, ev2, b))))))
    prime = [g for g in lunghe if g['giorno'] < giornate[0]['giorno']]
    ev3 = [tocchi(g) for g in prime]
    out.append(riga_v(f'giornate indipendenti, prima del Lee-Ready ({len(prime)})', diff_tenuta(list(zip(ev3, classi_di(prime, ev3, b))))))

    # Placebo: la mappa di un altro giorno, alla stessa ora e alla stessa distanza dallo spot.
    n = len(giornate)
    osservato = np.nanmean(base)
    tab = {}
    for i, es in enumerate(ev):
        for j, d in enumerate(giornate):
            if i == j:
                continue
            cl = []
            for e in es:
                m = int(e['t']) - INIZIO
                s = d['S'][m] if 0 <= m < len(d['S']) else np.nan
                cl.append(None if np.isnan(s) else classe(d, s + e['K'] - e['s'], s, m, b))
            tab[(i, j)] = cl
    conta = 0
    for _ in range(N_PERM):
        while True:
            q = rng.permutation(n)
            if (q != np.arange(n)).all():
                break
        if np.nanmean(diff_tenuta([(ev[i], tab[(i, q[i])]) for i in range(n)])) >= osservato:
            conta += 1
    out.append(f"\nPlacebo (mappa di un altro giorno, stessa ora e distanza): p = {(conta + 1) / (N_PERM + 1):.3f}")

    # Il conto in punti: rimbalzo = +esito, sfondamento = -esito, senza esito = fuori.
    su, re, tocchi_forti, senza = [], [], 0, 0
    for es, cl in coppie:
        for e, c in zip(es, cl):
            if c == 1:
                tocchi_forti += 1
                if e['esito'] is None:
                    senza += 1
                else:
                    su.append(e['esito'])
            elif c == 0 and e['esito'] is not None:
                re.append(e['esito'])
    out.append(f"\nTocchi forti positivi: {tocchi_forti}, senza esito {senza}; rimbalzo {np.mean(su) * 100:.0f}% "
               f"(resto {np.mean(re) * 100:.0f}%, {len(re)} tocchi); in punti, senza costi: {(2 * np.mean(su) - 1) * ESITO:+.2f} per tocco.")
    togli = [np.nanmean([v for k, v in enumerate(base) if k != i]) for i in range(n)]
    out.append(f"\nTogliendo un giorno alla volta la media resta fra {min(togli):+.3f} e {max(togli):+.3f}.")
    return out


def verifica_regime(giornate, basi):
    out = ['\n## Verifica: gamma netto e range dopo (corr per giorno, atteso negativo)\n',
           '| variante | ' + ' | '.join(BASI[b] for b in basi) + ' |', '|---' * (len(basi) + 1) + '|']

    def corsa(banda=BANDA_NETTO, h=30, controllo_ritorno=False, tieni=None):
        celle = []
        scelte = [g for g in giornate if tieni is None or tieni(g)]
        for b in basi:
            tab = []
            for g in scelte:
                n = len(g['S'])
                netto = np.full(n, np.nan)
                ks = g['strikes']
                for m in range(n):
                    s = g['S'][m]
                    if not g['fresca'][m] or np.isnan(s):
                        continue
                    v = g['basi'][b][g['F'][m]]
                    z = np.abs(ks - s) <= banda
                    tot = np.abs(v[z]).sum()
                    if tot > 0:
                        netto[m] = v[z].sum() / tot
                righe = []
                for m in range(h, n - h, h):
                    a, c = g['S'][m - h:m + 1], g['S'][m:m + h + 1]
                    if np.isnan(netto[m]) or np.isnan(a).sum() > 5 or np.isnan(c).sum() > 5:
                        continue
                    rp, rf = np.nanmax(a) - np.nanmin(a), np.nanmax(c) - np.nanmin(c)
                    if rp <= 0 or rf <= 0 or np.isnan(g['S'][m]):
                        continue
                    ritorno = g['S'][m] - a[np.isfinite(a)][0]
                    righe.append((m // 30, np.log(rp), np.log(rf), netto[m], ritorno / rp))
                tab.append(righe)
            tutte = np.array([r for t in tab for r in t])
            fasce = sorted(set(tutte[:, 0]))
            col = [tutte[:, 1]] + [(tutte[:, 0] == f).astype(float) for f in fasce]
            if controllo_ritorno:
                col.append(tutte[:, 4])
            X = np.column_stack(col)
            res = tutte[:, 2] - X @ np.linalg.lstsq(X, tutte[:, 2], rcond=None)[0]
            x, i = [], 0
            for t in tab:
                x.append(corr_giorno(np.array([q[3] for q in t]), res[i:i + len(t)]))
                i += len(t)
            r = riga_giorni(x)
            celle.append(f"{r['media']:+.2f} (t {r['t']:+.1f})")
        return celle

    var = [('base', {}), ('+ controllo sul ritorno dei 30 min prima', {'controllo_ritorno': True}),
           ('banda +-15 punti', {'banda': 15}), ('banda +-40 punti', {'banda': 40}),
           ('finestra 15 min', {'h': 15}), ('finestra 60 min', {'h': 60}),
           ("solo poller acceso all'apertura", {'tieni': lambda g: (g['tf'] <= 575).any()})]
    for nome, kw in var:
        out.append(f"| {nome} | " + ' | '.join(corsa(**kw)) + ' |')
    return out


def boot(giorni_valori, stat, n=4000):
    """Intervallo al 90% ricampionando le GIORNATE: i dati di uno stesso giorno non sono indipendenti."""
    k = len(giorni_valori)
    v = []
    for _ in range(n):
        x = stat([giorni_valori[i] for i in rng.integers(0, k, k)])
        if np.isfinite(x):
            v.append(x)
    return np.quantile(v, [0.05, 0.95])


def verifica_cumulata(titolo, giornate, basi):
    """Le stesse due misure contando tutti i dati insieme: la media dei giorni pesa
    uguale un giorno con un solo tocco e uno con trenta."""
    out = [f'\n## Tutti i dati insieme, {titolo}: {len(giornate)} giornate\n',
           '| base | rimbalzo forte+ | resto | differenza [90%] | tocchi forti con esito | range netto basso / alto | log(alto/basso) [90%] |',
           '|---|---|---|---|---|---|---|']
    ev = [tocchi(g) for g in giornate]
    for b in basi:
        righe = []
        for g, es in zip(giornate, ev):
            su, re = [], []
            for e, c in zip(es, classi_di([g], [es], b)[0]):
                if e['esito'] is None or c is None:
                    continue
                if c == 1:
                    su.append(e['esito'])
                elif c == 0:
                    re.append(e['esito'])
            righe.append((su, re))

        def diff(rr):
            a = [x for s, _ in rr for x in s]
            c = [x for _, s in rr for x in s]
            return np.mean(a) - np.mean(c) if a and c else np.nan

        a = [x for s, _ in righe for x in s]
        c = [x for _, s in righe for x in s]
        lo, hi = boot(righe, diff)

        tab = [righe_regime(g, livelli(g, b)['netto']) for g in giornate]
        res = residui_regime(tab)
        netti = np.concatenate([np.array([q[3] for q in r]) for r in tab if r])
        q1, q2 = np.quantile(netti, [1 / 3, 2 / 3])
        coppie = [(np.array([q[3] for q in r]), e) for r, e in zip(tab, res) if r]

        def ampiezza(cc):
            n = np.concatenate([x for x, _ in cc])
            e = np.concatenate([x for _, x in cc])
            if not (n <= q1).any() or not (n >= q2).any():
                return np.nan
            return e[n >= q2].mean() - e[n <= q1].mean()

        basso = np.exp(np.concatenate([e[n <= q1] for n, e in coppie]).mean())
        alto = np.exp(np.concatenate([e[n >= q2] for n, e in coppie]).mean())
        lo2, hi2 = boot(coppie, ampiezza)
        out.append(f"| {BASI[b]} | {np.mean(a) * 100:.0f}% | {np.mean(c) * 100:.0f}% | {(np.mean(a) - np.mean(c)) * 100:+.0f} [{lo * 100:+.0f}, {hi * 100:+.0f}] | {len(a)} | "
                   f"{basso:.2f} / {alto:.2f} | {ampiezza(coppie):+.2f} [{lo2:+.2f}, {hi2:+.2f}] |")
    return out


def main():
    giorni = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(VOLUMI, '2026-*.json')))
    giorni = [g for g in giorni if g < datetime.now().strftime('%Y-%m-%d')]
    tutte = [g for g in (carica(x) for x in giorni) if g]

    def utili(g, basi):
        m = np.isfinite(g['S']) & g['fresca']
        for b in basi:
            m = m & (np.abs(g['basi'][b][g['F']]).sum(axis=1) > 0)
        return int(m.sum())

    tre = list(BASI)
    con_lr = [g for g in tutte if g['conLr'] and utili(g, tre) >= MIN_MINUTI]
    due = ['gexOi', 'gex']
    lunghe = [g for g in tutte if utili(g, due) >= MIN_MINUTI]
    lunghe = [dict(g) for g in lunghe]
    # Per lo stesso confronto: i minuti senza Lee-Ready si tolgono a tutte le basi.
    for g in con_lr:
        vuoto = np.abs(g['basi']['gexLr'][g['F']]).sum(axis=1) == 0
        g['fresca'] = g['fresca'] & ~vuoto
    completi = [g for g in con_lr if (g['tf'] <= 575).any()]

    out = ['# Studio mappa di calore: OI, Volume, Lee-Ready\n']
    out.append(f"Tre basi, stessi minuti: {len(con_lr)} giornate ({con_lr[0]['giorno']} -> {con_lr[-1]['giorno']}): "
               + ', '.join(g['giorno'][5:] for g in con_lr))
    out.append(f"\nDi cui col poller gia' acceso all'apertura ({len(completi)}): " + ', '.join(g['giorno'][5:] for g in completi))
    q = [(g['giorno'], qualita_lr(g['giorno'])) for g in con_lr]
    q = [(a, b) for a, b in q if b]
    out.append(f"\nQuota del volume coperta dal Lee-Ready a fine giornata, mediana: {np.median([b['quota'] for _, b in q]) * 100:.0f}% "
               f"(min {min(b['quota'] for _, b in q) * 100:.0f}%). Giornate con conti azzerati a meta': "
               + (', '.join(f"{a[5:]} ({b['azzerati']})" for a, b in q if b['azzerati']) or 'nessuna'))

    ris = analisi(con_lr, tre)
    out.append('\n## Test principali (verso atteso: A POS/ABS +, B forte+ +, B forte- -, C -)\n')
    tabella_basi(out, ris, tre)
    attesi = {'A POS 30': 1, 'A ABS 30': 1, 'B pos': 1, 'B neg': -1, 'C': -1}
    out.append('\n## Chi passa la regola\n')
    for b in tre:
        ok = [k for k, v in attesi.items() if passa(ris[b][k], v)]
        if passa(ris[b]['A NEG 30'], 1) or passa(ris[b]['A NEG 30'], -1):
            ok.append('A NEG 30')
        out.append(f"- {BASI[b]}: {', '.join(ok) if ok else 'nessuna'}")

    out.append('\n## Calamita agli altri orizzonti (punti verso il livello, t)\n')
    out.append('| livello | base | 15 min | 60 min | fino alla chiusura (dalle 13/14/15 NY) |')
    out.append('|---|---|---|---|---|')
    for nome in ('POS', 'NEG', 'ABS'):
        for b in tre:
            r = ris[b]
            c = lambda k: f"{r[k]['media']:+.2f} (t {r[k]['t']:+.1f})"
            out.append(f"| {nome} | {BASI[b]} | {c(f'A {nome} 15')} | {c(f'A {nome} 60')} | {c(f'A {nome} chiusura')} |")

    out.append('\n## Tocchi: tassi di rimbalzo e mossa nei 15 min dopo\n')
    out.append('| base | tocchi forte+ / forte- / resto | rimbalzo forte+ | forte- | resto | mossa 15m forte+ | forte- | resto |')
    out.append('|---|---|---|---|---|---|---|---|')
    for b in tre:
        d, t = ris[b]['B dett'], ris[b]['B tassi']
        out.append(f"| {BASI[b]} | {d['n_su']:.0f} / {d['n_giu']:.0f} / {d['n_resto']:.0f} | {t['su'] * 100:.0f}% | {t['giu'] * 100:.0f}% | {t['resto'] * 100:.0f}% | {t['mp']:.1f} | {t['mn']:.1f} | {t['mr']:.1f} |")

    out.append('\n## Regime: range relativo nei 30 min dopo, per terzile del netto\n')
    out.append('| base | netto basso | netto alto | quota letture con netto < 0 |')
    out.append('|---|---|---|---|')
    for b in tre:
        a, c = ris[b]['C terzili']
        out.append(f"| {BASI[b]} | {a:.2f} | {c:.2f} | {ris[b]['C quota neg'] * 100:.0f}% |")

    out.append("\n## Che lettura e' (mediana delle giornate, livello ABS)\n")
    out.append('| base | minuti sullo stesso strike | distanza dallo spot | quota entro 5 punti |')
    out.append('|---|---|---|---|')
    for b in tre:
        d = ris[b]['descr']
        out.append(f"| {BASI[b]} | {d['durata']:.0f} | {d['dist']:.0f} | {d['vicino'] * 100:.0f}% |")

    out.append(f"\n## Controllo: solo le {len(completi)} giornate col poller acceso all'apertura\n")
    tabella_basi(out, analisi(completi, tre, con_perm=False), tre)

    out.append(f"\n## Controllo: OI contro Volume su tutte le {len(lunghe)} giornate ({lunghe[0]['giorno']} -> {lunghe[-1]['giorno']})\n")
    tabella_basi(out, analisi(lunghe, due), due)

    if '--verifica' in sys.argv:
        out += ['\n'] + verifica_tenuta(con_lr, lunghe) + verifica_regime(con_lr, tre)
        out += verifica_cumulata('tre basi', con_lr, tre)
        out += verifica_cumulata('OI e Volume, tutto il campione', lunghe, due)
        out += verifica_cumulata('OI e Volume, solo le giornate prima del Lee-Ready',
                                 [g for g in lunghe if g['giorno'] < con_lr[0]['giorno']], due)

    testo = '\n'.join(out)
    open(USCITA, 'w', encoding='utf-8').write(testo)
    print(testo)


if __name__ == '__main__':
    main()
