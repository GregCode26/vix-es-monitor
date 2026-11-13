"""Studio 13/11/2026: ingressi per 2 punti di ES con tutto quello che l'app raccoglie.

Domanda dell'utente: trovare punti d'ingresso per un target di 2 punti ES, guardando tutta l'app,
con un riarmo di almeno 5 minuti fra due segnali della stessa regola.

Metodo
- Griglia al secondo per ogni seduta con Bookmap (frontend/data/bookmap), ingressi dalle 9:35 alle
  15:45 NY. Prezzo = mid Bookmap di ES. Tutte le letture sono causali (solo il passato).
- Esito: entrata al mid del secondo DOPO il segnale, target +2, stop 2 o 3, chiusura a mercato
  dopo 15 minuti. Costo 0,25 pt a operazione (mezzo tick per lato, come gli altri studi).
  Con target = stop un'entrata a caso vince ~50% e perde 0,25 a operazione: e' la base da battere.
- Regole, tutte nei due versi (seguire / andare contro):
  * flusso Bookmap: delta 30/60/300 s, OFI dei primi 5 livelli 10/60 s (in z sui 30 minuti prima),
    sbilanciamento del libro e della prima coda, centroidi;
  * prezzo: momento 30/60/300 s, distanza dal VWAP (calcolato dai trade Bookmap), nuovi massimi/minimi;
  * vol e opzioni: VIX e VIX1D a 1 e 5 minuti, Market Tide (ncp - npp) a 5 minuti;
  * livelli: tocco dei range OB, GEX+/GEX-, Zero Gamma (armato a 5 pt, tocco a 0,5), rimbalzo o rottura;
    la conferma dei range (stessa logica di studio_conferma_range.py) con target 2;
  * eventi: assorbimenti Bookmap (per taglia), frecce AI Livelli, blocchi di vertical >= 100.
  Soglie delle letture continue = quantili 90/95/98 (e 10/5/2) calcolati SOLO sulle giornate di ricerca.
- Riarmo: una regola non riscatta prima di 300 s dal suo segnale precedente.
- Giornate: prima meta' per cercare, seconda per verificare. Conta solo la verifica, e va confrontata
  col numero di regole provate (con centinaia di regole qualcuna "funziona" per caso).

Uso:
  python execution/studio_ingressi_2pt.py            # costruisce la cache (.tmp/studio_ingressi_2pt/) e analizza
  python execution/studio_ingressi_2pt.py --rifai    # ricostruisce la cache
Livelli GEX/0γ chiedono al server locale (npm run dev), come studio_conferma_range.py.
"""
import glob, json, math, os, sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import studio_conferma_range as CR  # noqa: E402

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATI = os.path.join(RADICE, 'frontend', 'data')
CACHE = os.path.join(RADICE, '.tmp', 'studio_ingressi_2pt')
REPORT = os.path.join(RADICE, '.tmp', 'studio_ingressi_2pt.md')
TARGET, DURATA, RIARMO, COSTO = 2.0, 900, 300, 0.25
# Stop sulla liquidita' Bookmap (richiesta dell'utente): LONG un tick sotto il primo muro bid sotto
# l'entrata, SHORT un tick sopra il primo muro ask, dal libro del secondo del segnale, fisso dopo.
# Muro = primo livello >= 100 contratti ('muro 100') o >= 2 volte la mediana dei livelli entro 8 pt
# ('muro 2x mediana'), fra 0,5 e 8 pt dal mid. Senza muro in quella fascia l'operazione non si fa.
MURI = ('muro 100', 'muro 2x mediana')
# Gestione dello stop (13/11, richiesta dell'utente "anche un trailing stop"), target sempre +2:
#  fisso    = resta dov'e' all'entrata;
#  trailing = segue il primo muro dietro al prezzo (LONG: muro bid sotto il mid, ogni secondo), solo a favore;
#  pareggio = va all'entrata quando l'operazione tocca +1.
GESTIONI = ('fisso', 'trailing', 'pareggio')
STOPS = tuple(f'{m} · {g}' for m in MURI for g in GESTIONI)
MURO_MIN, MURO_MAX, TICK = 0.5, 8.0, 0.25


def sec(t):
    return int(t[:2]) * 3600 + int(t[3:5]) * 60 + int(t[6:8])


def ffill(a):
    idx = np.where(np.isfinite(a), np.arange(len(a)), 0)
    np.maximum.accumulate(idx, out=idx)
    out = a[idx]
    return out


def somma_mobile(a, k):
    c = np.concatenate([[0.0], np.cumsum(np.nan_to_num(a))])
    # out[i] = somma di a[i-k+1..i]
    out = np.full(len(a), np.nan)
    i = np.arange(k - 1, len(a))
    out[i] = c[i + 1] - c[i + 1 - k]
    return out


def ritardo(a, k):
    out = np.full(len(a), np.nan)
    out[k:] = a[:-k]
    return out


def zeta(a, k=1800):
    """a diviso la sua deviazione standard sui k secondi prima (solo passato)."""
    x = np.nan_to_num(a)
    c1 = np.concatenate([[0.0], np.cumsum(x)])
    c2 = np.concatenate([[0.0], np.cumsum(x * x)])
    out = np.full(len(a), np.nan)
    i = np.arange(k, len(a))
    m = (c1[i] - c1[i - k]) / k
    v = (c2[i] - c2[i - k]) / k - m * m
    sd = np.sqrt(np.maximum(v, 1e-12))
    out[i] = a[i] / sd
    return out


# ---------------------------------------------------------------- costruzione per giornata

def costruisci(g):
    s0 = CR.locale_da_ny(g, 9, 30)
    s1 = CR.locale_da_ny(g, 16, 0)
    n = s1 - s0 + 1
    mid = np.full(n, np.nan); buy = np.zeros(n); sell = np.zeros(n); ofi5 = np.zeros(n)
    bl = np.full(n, np.nan); al = np.full(n, np.nan); q1b = np.full(n, np.nan); q1a = np.full(n, np.nan)
    cb = np.full(n, np.nan); ca = np.full(n, np.nan)
    pv = np.zeros(n)
    muri = {k: (np.full(n, np.nan), np.full(n, np.nan)) for k in MURI}   # (prezzo muro bid sotto, ask sopra)
    eventi = []   # (secondo, nome, verso)
    for riga in open(os.path.join(DATI, 'bookmap', f'{g}.ndjson'), encoding='utf-8'):
        try:
            r = json.loads(riga)
        except ValueError:
            continue
        t = r.get('t')
        if not t:
            continue
        i = sec(t) - s0
        for a in r.get('abs') or []:
            # [prezzo, taglia, lato (+1 compratori limite assorbono vendite), ora]
            try:
                j = sec(a[3]) - s0
            except Exception:
                j = i
            if 0 <= j < n and a[1]:
                eventi.append((j, 'assorbimento (tutti)', int(np.sign(a[2]))))
                if a[1] >= 80: eventi.append((j, 'assorbimento >= 80', int(np.sign(a[2]))))
                if a[1] >= 150: eventi.append((j, 'assorbimento >= 150', int(np.sign(a[2]))))
        if not (0 <= i < n):
            continue
        if r.get('bid') and r.get('ask'):
            mid[i] = m = (r['bid'] + r['ask']) / 2
            libro = r.get('book') or {}
            vicini = [s for p, s in (libro.get('b') or []) + (libro.get('a') or []) if abs(p - m) <= MURO_MAX]
            if vicini:
                soglie_muro = {'muro 100': 100, 'muro 2x mediana': 2 * float(np.median(vicini))}
                for k, th in soglie_muro.items():
                    sotto = [p for p, s in (libro.get('b') or []) if s >= th and MURO_MIN <= m - p <= MURO_MAX]
                    sopra = [p for p, s in (libro.get('a') or []) if s >= th and MURO_MIN <= p - m <= MURO_MAX]
                    if sotto: muri[k][0][i] = max(sotto)
                    if sopra: muri[k][1][i] = min(sopra)
        b, s = r.get('buy') or 0, r.get('sell') or 0
        buy[i] += b; sell[i] += s
        if r.get('price'):
            pv[i] += r['price'] * (b + s)
        o = r.get('ofi')
        if o:
            ofi5[i] = sum(x or 0 for x in o[:5])
        for arr, k in ((bl, 'bidLiq'), (al, 'askLiq'), (q1b, 'q1B'), (q1a, 'q1A'), (cb, 'cB'), (ca, 'cA')):
            if r.get(k) is not None:
                arr[i] = r[k]
    if np.isfinite(mid).sum() < 3600:
        return None
    mid = ffill(mid)
    vol = buy + sell
    vwap = np.cumsum(pv) / np.maximum(np.cumsum(vol), 1)
    vwap[np.cumsum(vol) < 500] = np.nan
    # mercato (5 s) e Tide (10 s)
    vix = np.full(n, np.nan); v1d = np.full(n, np.nan)
    try:
        m = json.load(open(os.path.join(DATI, 'market', f'{g}.json'), encoding='utf-8'))
        for p in (m if isinstance(m, list) else m.get('data', [])):
            i = sec(p.get('time') or '00:00:00') - s0
            if 0 <= i < n:
                if p.get('vix'): vix[i] = p['vix']
                if p.get('vix1d'): v1d[i] = p['vix1d']
    except (OSError, ValueError):
        pass
    tide = np.full(n, np.nan)
    try:
        import ast
        for p in json.load(open(os.path.join(DATI, 'volumes', f'{g}.json'), encoding='utf-8')):
            i = sec(p.get('time') or '00:00:00') - s0
            td = p.get('tide')
            if 0 <= i < n and td:
                td = ast.literal_eval(td) if isinstance(td, str) else td
                if td.get('ncp') is not None:
                    tide[i] = td['ncp'] - td['npp']
    except (OSError, ValueError):
        pass
    vix, v1d, tide = ffill(vix), ffill(v1d), ffill(tide)
    # livelli: range OB fissi, GEX+/GEX-/0γ mobili (dal server locale)
    livelli = {}
    for nome, L in (CR.range_ob(g) or {}).items():
        livelli[nome] = ('range', np.full(n, L))
    try:
        mob, _ = CR.livelli_mobili(g, s0, n)
        for nome, (tipo, Ls) in mob.items():
            livelli[nome] = (tipo, np.array([np.nan if v is None else v for v in Ls], dtype=float))
    except Exception as e:
        print(f'  {g}: livelli mobili non disponibili ({e})')
    # frecce AI
    try:
        for riga in open(os.path.join(RADICE, '.tmp', 'ai-signals.jsonl'), encoding='utf-8'):
            r = json.loads(riga)
            if str(r.get('creato', ''))[:10] != g or not r.get('innesco'):
                continue
            b = (r.get('segnale') or {}).get('bias')
            if b in ('LONG', 'SHORT'):
                eventi.append((sec(r['ora']) - s0, 'freccia AI', 1 if b == 'LONG' else -1))
    except OSError:
        pass
    # blocchi di vertical >= 100: call comprata / put venduta = rialzo
    try:
        for riga in open(os.path.join(DATI, 'verticali', f'{g}.ndjson'), encoding='utf-8'):
            r = json.loads(riga)
            if (r.get('size') or 0) < 100 or r.get('verso') not in ('comprato', 'venduto'):
                continue
            v = 1 if r['verso'] == 'comprato' else -1
            v = v if r.get('lato') == 'C' else -v
            eventi.append((sec(r['t']) - s0, 'vertical >= 100', v))
    except OSError:
        pass
    return dict(mid=mid, buy=buy, sell=sell, ofi5=ofi5, bl=bl, al=al, q1b=q1b, q1a=q1a, cb=cb, ca=ca,
                vwap=vwap, muri=muri, vix=vix, v1d=v1d, tide=tide, livelli=livelli, eventi=eventi, s0=s0)


def carica(rifai=False):
    import pickle
    os.makedirs(CACHE, exist_ok=True)
    giorni = {}
    for f in sorted(glob.glob(os.path.join(DATI, 'bookmap', '*.ndjson'))):
        g = os.path.basename(f)[:10]
        c = os.path.join(CACHE, f'{g}.pkl')
        oggi = g == CR.OGGI
        if os.path.exists(c) and not rifai and not oggi:
            giorni[g] = pickle.load(open(c, 'rb'))
            continue
        print(f'  costruisco {g}...', flush=True)
        d = costruisci(g)
        if d is not None and not oggi:
            pickle.dump(d, open(c, 'wb'))
        if d is not None:
            giorni[g] = d
    return {g: d for g, d in giorni.items() if d is not None}


# ---------------------------------------------------------------- letture

def letture(d):
    mid, buy, sell = d['mid'], d['buy'], d['sell']
    dl = buy - sell
    F = {}
    for k in (30, 60, 300):
        F[f'momento {k}s'] = mid - ritardo(mid, k)
        F[f'delta {k}s (z)'] = zeta(somma_mobile(dl, k))
    for k in (10, 60):
        F[f'OFI5 {k}s (z)'] = zeta(somma_mobile(d['ofi5'], k))
    bl, al = ffill(d['bl']), ffill(d['al'])
    F['libro bid-ask'] = (bl - al) / np.maximum(bl + al, 1)
    qb, qa = ffill(d['q1b']), ffill(d['q1a'])
    F['prima coda bid-ask'] = (qb - qa) / np.maximum(qb + qa, 1)
    F['centroide ask-bid'] = ffill(d['ca']) - ffill(d['cb'])
    F['dal VWAP'] = mid - d['vwap']
    hi = np.fmax.accumulate(mid); lo = np.fmin.accumulate(mid)
    F['dal massimo'] = mid - hi           # 0 = sul massimo del giorno
    F['dal minimo'] = mid - lo
    for k in (60, 300):
        F[f'VIX {k}s'] = d['vix'] - ritardo(d['vix'], k)
    F['VIX1D 300s'] = d['v1d'] - ritardo(d['v1d'], 300)
    F['Tide 300s'] = d['tide'] - ritardo(d['tide'], 300)
    return F


def eventi_livelli(d, n):
    """Tocchi (armato a 5 pt, tocco 0,5) e conferme dei livelli: (secondo, nome, verso)."""
    mid = d['mid']
    out = []
    for nome, (tipo, Ls) in d['livelli'].items():
        armato, lato, s = False, 0, 1
        while s < n:
            L, P = Ls[s], Ls[s - 1]
            if not np.isfinite(L) or not np.isfinite(P) or abs(L - P) > 1:
                armato = False; s += 1; continue
            x = mid[s] - L
            if abs(x) >= CR.RIARMO:
                armato, lato = True, (1 if x > 0 else -1)
            elif armato and abs(x) <= CR.TOCCO:
                armato = False
                out.append((s, f'tocco {tipo} (rimbalzo)', lato))
                for t in range(s + 1, min(n - 1, s + CR.FINESTRA) + 1):
                    y = lato * (mid[t] - L)
                    if y <= -CR.CONF:
                        break
                    if y >= CR.CONF:
                        out.append((t, f'conferma {tipo}', lato))
                        break
            s += 1
    return out


# ---------------------------------------------------------------- esiti

def esito(d, i, verso, tipo_stop, distanza=None):
    """Punti netti. `distanza` (solo per il controllo) = stop fisso a quella distanza senza guardare il libro."""
    mid = d['mid']
    n = len(mid)
    if i + 1 >= n:
        return None
    ent = mid[i + 1]
    if not np.isfinite(ent):
        return None   # prima del primo dato Bookmap della giornata
    tipo_muro, gestione = tipo_stop.split(' · ')
    lato = 0 if verso > 0 else 1
    if distanza is None:
        muro = d['muri'][tipo_muro][lato][i]
        if not np.isfinite(muro):
            return None   # nessuna liquidita' dove mettere lo stop: niente operazione
        stop = verso * (ent - muro) + TICK      # distanza dello stop dall'entrata
        if stop <= TICK:
            return None   # il prezzo e' gia' sul muro
    else:
        stop = distanza
    fine = min(n, i + 2 + DURATA)
    w = verso * (mid[i + 2:fine] - ent)
    if not len(w):
        return None
    # livello dello stop nel tempo, in punti dall'entrata (negativo = in perdita)
    livello = np.full(len(w), -stop)
    if gestione == 'trailing' and distanza is None:
        m = d['muri'][tipo_muro][lato][i + 1:fine - 1]        # il muro visto il secondo prima
        nuovo = verso * (m - ent) - TICK                      # stop un tick oltre quel muro
        nuovo = np.where(np.isfinite(nuovo), nuovo, -np.inf)
        livello = np.maximum.accumulate(np.maximum(livello, nuovo))
        livello = np.minimum(livello, TARGET - TICK)
    elif gestione == 'pareggio':
        toccato = np.maximum.accumulate(w) >= 1.0
        prima = np.concatenate([[False], toccato[:-1]])       # si sposta dal secondo dopo
        livello = np.where(prima, 0.0, livello)
    su = np.argmax(w >= TARGET) if (w >= TARGET).any() else None
    colpito = w <= livello
    giu = np.argmax(colpito) if colpito.any() else None
    if su is not None and (giu is None or su < giu):
        return TARGET - COSTO
    if giu is not None:
        return float(livello[giu]) - COSTO
    if len(w) < DURATA - 1:
        return None   # finisce la seduta prima dei 15 minuti: niente esito
    return w[-1] - COSTO


def con_riarmo(secondi):
    out, ultimo = [], -10 ** 9
    for s in sorted(secondi):
        if s - ultimo >= RIARMO:
            out.append(s); ultimo = s
    return out


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    rifai = '--rifai' in sys.argv
    print('Carico le giornate (la prima volta legge ~1 GB di Bookmap)...', flush=True)
    G = carica(rifai)
    giorni = sorted(G)
    meta = len(giorni) // 2
    ricerca, verifica = giorni[:meta], giorni[meta:]
    print(f'{len(giorni)} giornate: ricerca {ricerca[0]}..{ricerca[-1]}, verifica {verifica[0]}..{verifica[-1]}')
    # finestra degli ingressi: 9:35-15:45 NY = secondi 300 .. 22500 dalla 9:30
    I0, I1 = 300, 6 * 3600 + 15 * 60
    letture_g = {g: letture(G[g]) for g in giorni}
    nomi = list(next(iter(letture_g.values())).keys())
    # soglie dalle sole giornate di ricerca
    soglie = {}
    for f in nomi:
        x = np.concatenate([letture_g[g][f][I0:I1] for g in ricerca])
        x = x[np.isfinite(x)]
        if len(x) > 1000:
            soglie[f] = {q: float(np.quantile(x, q / 100)) for q in (2, 5, 10, 90, 95, 98)}
    # segnali per regola: nome -> giorno -> [(secondo, verso_lettura)]
    regole = defaultdict(lambda: defaultdict(list))
    for g in giorni:
        F, d = letture_g[g], G[g]
        n = len(d['mid'])
        for f, q in soglie.items():
            x = F[f]
            for p in (90, 95, 98):
                idx = np.where((x >= q[p]))[0]
                regole[f'{f} >= p{p}'][g] = [(int(s), 1) for s in idx if I0 <= s < I1]
                idx = np.where((x <= q[100 - p]))[0]
                regole[f'{f} <= p{100 - p}'][g] = [(int(s), -1) for s in idx if I0 <= s < I1]
        for s, nome, v in eventi_livelli(d, n) + d['eventi']:
            if I0 <= s < I1:
                regole[nome][g].append((int(s), v))
    # esiti, con riarmo, nei due versi (segue = nel verso della lettura, contro = opposto)
    righe = []
    for nome, per_g in regole.items():
        for modo, segno in (('segue', 1), ('contro', -1)):
            for stop in STOPS:
                ris = {'ricerca': [], 'verifica': []}
                giorni_pos = {'ricerca': defaultdict(float), 'verifica': defaultdict(float)}
                for g, sig in per_g.items():
                    parte = 'ricerca' if g in ricerca else 'verifica'
                    versi = dict(sig)
                    for s in con_riarmo([s for s, _ in sig]):
                        e = esito(G[g], s, segno * versi[s], stop)
                        if e is not None:
                            ris[parte].append(e); giorni_pos[parte][g] += e
                righe.append(dict(regola=nome, modo=modo, stop=stop, **{
                    f'{p}_{k}': v for p in ris for k, v in stat(ris[p], giorni_pos[p]).items()}))
    # distanza media dello stop
    for stop in MURI:
        dist = []
        for g in giorni:
            d = G[g]
            for k in (0, 1):
                x = d['mid'][I0:I1] - d['muri'][stop][k][I0:I1]
                dist += list(np.abs(x[np.isfinite(x)][::30]) + TICK)
        print(f'{stop}: muro presente nel {len(dist) * 30 / (2 * sum(I1 - I0 for _ in giorni)):.0%} dei secondi, '
              f'stop medio {np.mean(dist):.2f} pt (mediana {np.median(dist):.2f})')
        STOP_MEDIO[stop] = (np.mean(dist), np.median(dist), len(dist) * 30 / (2 * sum(I1 - I0 for _ in giorni)))
    # base: ingressi a caso, uno ogni 5 minuti, nei due versi
    rng = np.random.default_rng(0)
    base = {}
    for stop in STOPS:
        for parte, gg in (('ricerca', ricerca), ('verifica', verifica)):
            r = []
            for g in gg:
                for s in range(I0 + int(rng.integers(0, 300)), I1, 300):
                    e = esito(G[g], s, int(rng.choice([-1, 1])), stop)
                    if e is not None: r.append(e)
            base[(stop, parte)] = stat(r, {})
    # controllo: stessa distanza di stop ma in momenti SENZA muro da quella parte (stop fisso)
    for m in MURI:
        distanze = []
        for g in giorni:
            for k in (0, 1):
                x = np.abs(G[g]['mid'][I0:I1] - G[g]['muri'][m][k][I0:I1]) + TICK
                distanze += list(x[np.isfinite(x)][::60])
        for parte, gg in (('ricerca', ricerca), ('verifica', verifica)):
            con, senza = [], []
            for g in gg:
                for s in range(I0 + int(rng.integers(0, 60)), I1, 60):
                    v = int(rng.choice([-1, 1]))
                    if np.isfinite(G[g]['muri'][m][0 if v > 0 else 1][s]):
                        e = esito(G[g], s, v, f'{m} · fisso')
                        if e is not None: con.append(e)
                    else:
                        e = esito(G[g], s, v, f'{m} · fisso', distanza=float(rng.choice(distanze)))
                        if e is not None: senza.append(e)
            CONTROLLO[(m, parte)] = (stat(con, {}), stat(senza, {}))
    scrivi(righe, base, ricerca, verifica, len(regole))


STOP_MEDIO = {}
CONTROLLO = {}


def stat(r, per_g):
    if not r:
        return dict(n=0, media=float('nan'), vinte=float('nan'), t=float('nan'), giorni_pos='-')
    a = np.array(r)
    t = a.mean() / (a.std(ddof=1) / math.sqrt(len(a))) if len(a) > 2 and a.std() > 0 else float('nan')
    gp = f'{sum(v > 0 for v in per_g.values())}/{len(per_g)}' if per_g else '-'
    return dict(n=len(a), media=a.mean(), vinte=(a > 0).mean() * 100, t=t, giorni_pos=gp)


def scrivi(righe, base, ricerca, verifica, n_regole):
    import pandas as pd
    T = pd.DataFrame(righe)
    out = []
    w = out.append
    w('# Ingressi per 2 punti ES - tutta l\'app\n')
    w(NOTA)
    w(f'Giornate di ricerca: {len(ricerca)} ({ricerca[0]} -> {ricerca[-1]}); di verifica: {len(verifica)} '
      f'({verifica[0]} -> {verifica[-1]}). Regole: {n_regole} letture/eventi x 2 versi x {len(STOPS)} stop = {len(T)} prove.\n')
    w("## Lo stop sulla liquidita'\n")
    for k, (media, med, pres) in STOP_MEDIO.items():
        w(f"- {k}: c'e' un muro utilizzabile nel {pres:.0%} dei secondi (per lato); distanza dello stop media "
          f"{media:.2f} pt, mediana {med:.2f}. Con stop fisso, per pareggiare servono vinte > (stop + 0,25) / (stop + 2): "
          f"{(med + 0.25) / (med + 2) * 100:.0f}% alla mediana.")
    w('')
    w("### Il muro conta? Ingressi a caso (uno al minuto) con lo stop fisso dietro un muro vero, contro la stessa distanza senza muro\n")
    w("Se la liquidita' protegge lo stop, la prima colonna deve stare sopra la seconda.\n")
    for (m, parte), (con, senza) in CONTROLLO.items():
        w(f"- {m}, {parte}: dietro il muro n {con['n']} media {con['media']:+.3f} vinte {con['vinte']:.0f}% | "
          f"stessa distanza senza muro n {senza['n']} media {senza['media']:+.3f} vinte {senza['vinte']:.0f}%")
    w('')
    w('## Base: ingressi a caso (uno ogni 5 minuti, verso a caso)\n')
    for (stop, parte), b in base.items():
        w(f'- {stop}, {parte}: n {b["n"]}, media {b["media"]:+.3f} pt, vinte {b["vinte"]:.0f}%')
    w('')
    for stop in STOPS:
        x = T[(T.stop == stop) & (T.ricerca_n >= 30)].sort_values('ricerca_media', ascending=False)
        w(f'## Stop {stop}: le 20 migliori nella ricerca (almeno 30 operazioni) e come vanno in verifica\n')
        w('| regola | verso | ric. n | ric. media | ric. vinte | ric. t | ver. n | ver. media | ver. vinte | ver. t | ver. giorni + |')
        w('|---|---|---|---|---|---|---|---|---|---|---|')
        for _, r in x.head(20).iterrows():
            w(f'| {r.regola} | {r.modo} | {r.ricerca_n} | {r.ricerca_media:+.3f} | {r.ricerca_vinte:.0f}% | {r.ricerca_t:+.1f} | '
              f'{r.verifica_n} | {r.verifica_media:+.3f} | {r.verifica_vinte:.0f}% | {r.verifica_t:+.1f} | {r.verifica_giorni_pos} |')
        top = x.head(20)
        w(f'\nDi queste 20, positive in verifica: {(top.verifica_media > 0).sum()}; con t >= 2 in verifica: '
          f'{(top.verifica_t >= 2).sum()}. Su tutte le prove con stop {stop} (>= 30 operazioni in entrambe): '
          f'{((x.verifica_media > 0) & (x.verifica_n >= 30)).sum()} positive in verifica su {(x.verifica_n >= 30).sum()}.\n')
        both = x[(x.verifica_n >= 30) & (x.ricerca_media > 0) & (x.verifica_media > 0)]
        both = both.assign(minimo=both[['ricerca_t', 'verifica_t']].min(axis=1)).sort_values('minimo', ascending=False)
        w(f'### Stop {stop}: positive in ENTRAMBE le meta\' (ordinate per il t peggiore delle due)\n')
        w('| regola | verso | ric. n | ric. media | ric. t | ver. n | ver. media | ver. vinte | ver. t | ver. giorni + |')
        w('|---|---|---|---|---|---|---|---|---|---|')
        for _, r in both.head(15).iterrows():
            w(f'| {r.regola} | {r.modo} | {r.ricerca_n} | {r.ricerca_media:+.3f} | {r.ricerca_t:+.1f} | {r.verifica_n} | '
              f'{r.verifica_media:+.3f} | {r.verifica_vinte:.0f}% | {r.verifica_t:+.1f} | {r.verifica_giorni_pos} |')
        w('')
    w('## Segnali gia\' presenti nell\'app (tutti, senza selezione)\n')
    app = T[T.regola.str.startswith(('tocco', 'conferma', 'assorbimento', 'freccia', 'vertical'))].sort_values(['regola', 'modo', 'stop'])
    w('| regola | verso | stop | ric. n | ric. media | ric. vinte | ver. n | ver. media | ver. vinte | ver. t |')
    w('|---|---|---|---|---|---|---|---|---|---|')
    for _, r in app.iterrows():
        w(f'| {r.regola} | {r.modo} | {r.stop} | {r.ricerca_n} | {r.ricerca_media:+.3f} | {r.ricerca_vinte:.0f}% | '
          f'{r.verifica_n} | {r.verifica_media:+.3f} | {r.verifica_vinte:.0f}% | {r.verifica_t:+.1f} |')
    T.to_csv(os.path.join(RADICE, '.tmp', 'studio_ingressi_2pt.csv'), index=False)
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    print(f'Scritto {REPORT}')


NOTA = """## Nota: come leggere

- **media** = punti netti a operazione (gia' tolti 0,25 di costo). Un ingresso a caso con target 2 / stop 2
  fa ~-0,25: una regola utile deve stare sopra zero, non solo sopra la base.
- **stop** = un tick oltre il primo muro di liquidita' Bookmap dalla parte opposta al target (sotto per LONG,
  sopra per SHORT), fissato al momento del segnale. Le operazioni senza un muro fra 0,5 e 8 pt non si fanno,
  quindi ogni regola ha meno operazioni dei suoi segnali.
- **vinte** = % di operazioni chiuse in utile. Lo stop e' quasi sempre piu' lontano del target, quindi per
  pareggiare servono molte piu' vinte del 50% (vedi sotto la soglia alla distanza mediana).
- **t** = media / errore standard. Sotto 2 e' compatibile col caso. Con centinaia di regole provate, nella
  ricerca qualcuna arriva a t 3 per caso: per questo conta solo la **verifica**, su giornate mai usate per scegliere.
- **giorni +** = giornate di verifica in utile su quelle con almeno un'operazione: un risultato fatto da 1-2
  giornate non e' una regola.
- **segue** = entra nel verso della lettura (delta alto -> LONG); **contro** = verso opposto (delta alto -> SHORT).
  Per livelli e conferme "segue" = rimbalzo dalla parte da cui arriva ES, "contro" = rottura.
"""

if __name__ == '__main__':
    main()
