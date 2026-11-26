"""Muri limit di Bookmap (ES) contro opzioni SPX 0DTE e GEX (04/11/2026).

Domanda: le grandi quantita' limit che compaiono nel book ES hanno a che fare
con l'operativita' in opzioni e con il gamma dei market maker?

Dati per giorno (solo cash 9:30-16:00 NY, giorni con Bookmap E poller volumi):
- frontend/data/bookmap/D.ndjson: book al secondo (livelli >= 20/50 contratti);
- frontend/data/volumes/D.json: per strike calls/puts cumulati, gamma IBKR,
  OI, Lee-Ready cb/cs/pb/ps, ogni ~10 s;
- frontend/data/market/D.json: ES e SPX, per la base ES-SPX.

Muro = livello con >= SOGLIA contratti. "Aggiunta" = il livello passa a
>= SOGLIA da < SOGLIA/2 (o assente) nei 30 s prima. Esito: "tolto" se scende
sotto SOGLIA/2 senza che il prezzo ci arrivi (entro 1 tick), "toccato" se il
prezzo lo raggiunge prima.

Analisi:
1. DOVE: un muro cade vicino a uno strike SPX con molta gamma (in prezzo ES
   con la base del momento), allo Zero Gamma, a un numero tondo ES? Confronto
   con i livelli NON muro del book nello stesso secondo (stessa distanza dal
   prezzo), cosi' la distanza dal mid non falsa il conto.
2. QUANDO: minuto per minuto, muri aggiunti contro volume opzioni, anche al
   netto del volume ES (residui), con ritardi -5..+5 min; e il volume opzioni
   sullo strike del muro nei 2 minuti prima/dopo contro un livello a caso.
3. REGIME: liquidita' grande nel book e muri aggiunti con spot sopra/sotto
   lo Zero Gamma e col gamma dei dealer (Lee-Ready) positivo/negativo.
4. TENUTA: i muri toccati tengono di piu' se sono su uno strike gamma?
5. ORARI: muri aggiunti e volume opzioni per mezz'ora.

Risultati del primo giro (04/11/2026, 18 giorni 28/09-04/11, 1.201 muri >= 150):
- DOVE: nessuna preferenza per gli strike SPX con piu' gamma (top-5 volume
  23,0% contro 25,6% del controllo; OI 17,2/19,1), ne' per lo Zero Gamma
  (2,7/3,2), ne' per gli strike in genere. Preferenza netta per i numeri tondi
  di ES: multipli di 5 39,5% contro 32,0% (z +3,7), di 10 22,9/17,3 (z +3,3).
- QUANDO: dentro ogni giorno muri e volume opzioni salgono insieme (rango
  +0,15, 16/18 giorni) solo perche' entrambi seguono l'attivita': al netto del
  volume ES -0,03 (8/18), nessun ritardo -5..+5 min sopra 0,03; sullo strike
  del muro il volume opzioni 2 min prima/dopo e' uguale a quello di un livello
  a caso (1.073/1.268 contro 1.101/1.276 di mediana).
- REGIME: dealer gamma Lee-Ready > 0 sembrava dare piu' liquidita' grande e
  meno range (7/9 e 8/9 giorni), ma a parita' di mezz'ora l'effetto quasi
  sparisce (range -0,12 punti, 18/32 celle; liquidita' +126, 20/32): era
  l'orario. Sopra/sotto Zero Gamma: niente.
- ESITO: 68% tolti senza essere toccati (mediana 8 s, 53% sotto 10 s); i
  toccati tengono 48%, 50% se su strike gamma, 58% vicino allo Zero Gamma
  (n 24, troppo pochi).
Conclusione: i muri ES grandi sono market making / algoritmi sul futuro, ai
numeri tondi, non coperture visibili delle opzioni SPX 0DTE.

    python execution/studio_muri_opzioni.py [giorno ...]
"""
import bisect, json, math, os, random, statistics, sys
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.stdout.reconfigure(encoding='utf-8')
RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATI = os.path.join(RADICE, 'frontend', 'data')
SOGLIA = 150
TICK = 0.25
random.seed(7)


def sec(t):
    h, m, *s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + (int(s[0]) if s else 0)


def finestra_cash(giorno):
    ny, roma = ZoneInfo('America/New_York'), ZoneInfo('Europe/Rome')
    d = datetime.fromisoformat(giorno)
    a = datetime(d.year, d.month, d.day, 9, 30, tzinfo=ny).astimezone(roma)
    c = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ny).astimezone(roma)
    return a.hour * 3600 + a.minute * 60, c.hour * 3600 + c.minute * 60


def corr(x, y):
    n = len(x)
    if n < 10:
        return float('nan')
    mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else float('nan')


def residui(y, x):
    """y meno la sua regressione lineare su x."""
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    vx = sum((a - mx) ** 2 for a in x)
    b = sum((a - mx) * (c - my) for a, c in zip(x, y)) / vx if vx else 0
    return [c - (my + b * (a - mx)) for a, c in zip(x, y)]


def zero_gamma(spot, righe):
    prof = {r['strike']: r['gamma'] * ((r.get('calls') or 0) - (r.get('puts') or 0)) for r in righe if r.get('gamma')}
    ks = sorted(k for k in prof if abs(k - spot) <= 60)
    best = None
    for a, b in zip(ks, ks[1:]):
        x, y = prof[a], prof[b]
        if x == 0 or y == 0 or (x < 0) == (y < 0):
            continue
        z = a + (b - a) * -x / (y - x)
        if best is None or abs(z - spot) < abs(best - spot):
            best = z
    return best


class Giorno:
    def __init__(self, g):
        self.g = g
        self.t0, self.t1 = finestra_cash(g)
        # Base ES-SPX al minuto (mediana), dal file market.
        m = json.load(open(os.path.join(DATI, 'market', f'{g}.json'), encoding='utf-8'))
        m = m if isinstance(m, list) else m.get('data', [])
        perm = defaultdict(list)
        for x in m:
            if x.get('esf') and x.get('spx') and self.t0 <= sec(x['time']) <= self.t1:
                perm[sec(x['time']) // 60].append(x['esf'] - x['spx'])
        self.base_min = sorted((k, statistics.median(v)) for k, v in perm.items())
        self.base_k = [k for k, _ in self.base_min]
        # Snapshot opzioni.
        v = json.load(open(os.path.join(DATI, 'volumes', f'{g}.json'), encoding='utf-8'))
        self.snap = []
        for s in v:
            t = sec(s['time'])
            if not (self.t0 - 60 <= t <= self.t1) or not s.get('volumes'):
                continue
            spot = s.get('spxPrice') or s.get('undPrice')
            if not spot:
                continue
            righe = {r['strike']: r for r in s['volumes']}
            self.snap.append((t, spot, righe, zero_gamma(spot, s['volumes'])))
        self.snap_t = [x[0] for x in self.snap]
        # Book al secondo.
        self.sec = {}
        with open(os.path.join(DATI, 'bookmap', f'{g}.ndjson'), encoding='utf-8') as f:
            for l in f:
                if '"t":"' not in l:
                    continue
                t = sec(l.split('"t":"', 1)[1][:8])
                if not (self.t0 <= t <= self.t1):
                    continue
                try:
                    r = json.loads(l)
                except ValueError:
                    continue  # riga troncata (Bookmap chiuso a meta' scrittura)
                bid, ask = r.get('bid'), r.get('ask')
                mid = (bid + ask) / 2 if bid and ask and bid < ask else r.get('price')
                if mid is None:
                    continue
                self.sec[t] = (mid, r.get('book') or {}, (r.get('buy') or 0) + (r.get('sell') or 0))
        self.tempi = sorted(self.sec)

    def base(self, t):
        if not self.base_min:
            return None
        i = bisect.bisect_right(self.base_k, t // 60) - 1
        return self.base_min[max(i, 0)][1]

    def snapshot(self, t, eta_max=45):
        """L'ultimo snapshot non successivo a t, se non piu' vecchio di eta_max s: dopo un
        buco del poller l'incremento cumulato comprenderebbe tutto il volume del buco."""
        i = bisect.bisect_right(self.snap_t, t) - 1
        if i < 0 or t - self.snap_t[i] > eta_max:
            return None
        return self.snap[i]

    def volume_strike(self, k, t_a, t_b):
        """Contratti (call+put) scambiati sullo strike k fra t_a e t_b."""
        a, b = self.snapshot(t_a), self.snapshot(t_b)
        if not a or not b or k not in a[2] or k not in b[2]:
            return None
        tot = lambda r: (r.get('calls') or 0) + (r.get('puts') or 0)
        return max(0, tot(b[2][k]) - tot(a[2][k]))


def strike_gamma(snap, quanti=5):
    """Gli strike con piu' gamma esposta: per volume di oggi e per OI."""
    _, spot, righe, _ = snap
    vol = sorted(righe, key=lambda k: -abs((righe[k].get('gamma') or 0) * ((righe[k].get('calls') or 0) + (righe[k].get('puts') or 0))))
    oi = sorted(righe, key=lambda k: -abs((righe[k].get('gamma') or 0) * ((righe[k].get('callsOi') or 0) + (righe[k].get('putsOi') or 0))))
    return vol[:quanti], oi[:quanti]


def gamma_dealer(snap, larghezza=25):
    """Gamma netta dei dealer vicino allo spot da Lee-Ready: i clienti comprano, i dealer sono corti."""
    _, spot, righe, _ = snap
    tot = 0.0
    for k, r in righe.items():
        if abs(k - spot) <= larghezza and r.get('gamma'):
            tot += -r['gamma'] * (((r.get('cb') or 0) - (r.get('cs') or 0)) + ((r.get('pb') or 0) - (r.get('ps') or 0)))
    return tot


def eventi_muri(G):
    """Aggiunte di muri (>= SOGLIA) con esito; e livelli di controllo nello stesso secondo."""
    storia = {}  # (lato, prezzo) -> deque di (t, q) recenti: basta l'ultimo t in cui era >= SOGLIA/2
    ultimo_alto = {}  # (lato, prezzo) -> ultimo t con q >= SOGLIA/2
    attivi = {}  # (lato, prezzo) -> evento aperto
    eventi, controlli = [], []
    for t in G.tempi:
        mid, book, _ = G.sec[t]
        presenti = {}
        for lato in ('b', 'a'):
            for p, q, *_ in book.get(lato, []):
                presenti[(lato, p)] = q
        # chiusura degli attivi
        for key, ev in list(attivi.items()):
            q = presenti.get(key, 0)
            lato, p = key
            raggiunto = (mid <= p + TICK) if lato == 'b' else (mid >= p - TICK)
            if raggiunto and ev['esito'] is None:
                ev['esito'] = 'toccato'
                ev['t_tocco'] = t
            if q < SOGLIA / 2:
                if ev['esito'] is None:
                    ev['esito'] = 'tolto'
                ev['durata'] = t - ev['t']
                del attivi[key]
        for key, q in presenti.items():
            lato, p = key
            if q >= SOGLIA and key not in attivi:
                prima = ultimo_alto.get(key)
                if prima is None or t - prima > 30:
                    ev = {'t': t, 'lato': lato, 'p': p, 'q': q, 'dist': abs(p - mid), 'mid': mid, 'esito': None, 'durata': None}
                    eventi.append(ev)
                    attivi[key] = ev
                    # controllo: un livello non-muro dello stesso lato, il piu' simile per distanza
                    cand = [(abs(abs(pp - mid) - ev['dist']), pp) for (ll, pp), qq in presenti.items() if ll == lato and qq < SOGLIA / 2]
                    if cand:
                        cand.sort()
                        controlli.append({'t': t, 'lato': lato, 'p': cand[0][1], 'mid': mid})
                    else:
                        controlli.append(None)
            if q >= SOGLIA / 2:
                ultimo_alto[key] = t
    for ev in attivi.values():
        ev['durata'] = G.tempi[-1] - ev['t']
    return eventi, controlli


def dopo_tocco(G, ev):
    """Tenuta: dopo il tocco, nei 60 s il prezzo non va oltre il muro di 1 punto."""
    t = ev.get('t_tocco')
    if t is None:
        return None
    for s in range(t, t + 61):
        x = G.sec.get(s)
        if not x:
            continue
        mid = x[0]
        if ev['lato'] == 'b' and mid < ev['p'] - 1:
            return False
        if ev['lato'] == 'a' and mid > ev['p'] + 1:
            return False
    return True


def caratteristiche(G, t, p):
    """Distanze di un prezzo ES dagli strike gamma, dallo Zero Gamma e dai tondi."""
    b = G.base(t)
    sn = G.snapshot(t)
    if b is None or not sn:
        return None
    spx = p - b
    top_vol, top_oi = strike_gamma(sn)
    zg = sn[3]
    return {
        'strike5': abs(spx - 5 * round(spx / 5)),
        'topVol': min(abs(spx - k) for k in top_vol),
        'topOi': min(abs(spx - k) for k in top_oi),
        'zg': abs(spx - zg) if zg else None,
        'es5': abs(p - 5 * round(p / 5)),
        'es10': abs(p - 10 * round(p / 10)),
        'strikeVicino': 5 * round(spx / 5),
    }


def main():
    giorni = sys.argv[1:] or sorted(
        f[:-7] for f in os.listdir(os.path.join(DATI, 'bookmap'))
        if f.endswith('.ndjson') and os.path.exists(os.path.join(DATI, 'volumes', f[:-7] + '.json'))
        and os.path.exists(os.path.join(DATI, 'market', f[:-7] + '.json')))
    tutti_ev, tutti_ctrl, per_min = [], [], []
    regime = defaultdict(list)
    fasce = defaultdict(lambda: [0, 0.0, 0])
    lag_tot = defaultdict(list)
    per_giorno = defaultdict(list)
    corr_giorno = defaultdict(list)
    for g in giorni:
        G = Giorno(g)
        if len(G.tempi) < 3600 or len(G.snap) < 300 or not G.base_min:
            print(f'{g}: dati insufficienti (book {len(G.tempi)} s, snapshot {len(G.snap)}), saltato')
            continue
        ev, ctrl = eventi_muri(G)
        for e, c in zip(ev, ctrl):
            e['f'] = caratteristiche(G, e['t'], e['p'])
            e['tiene'] = dopo_tocco(G, e)
            e['g'] = g
            if e['f']:
                k = e['f']['strikeVicino']
                e['volPrima'] = G.volume_strike(k, e['t'] - 120, e['t'])
                e['volDopo'] = G.volume_strike(k, e['t'], e['t'] + 120)
            if c:
                c['f'] = caratteristiche(G, c['t'], c['p'])
                if c['f']:
                    k = c['f']['strikeVicino']
                    c['volPrima'] = G.volume_strike(k, c['t'] - 120, c['t'])
                    c['volDopo'] = G.volume_strike(k, c['t'], c['t'] + 120)
            tutti_ev.append(e)
            tutti_ctrl.append(c)
        # Serie al minuto.
        minuti = range(G.t0 // 60, G.t1 // 60)
        add_min = defaultdict(int)
        for e in ev:
            add_min[e['t'] // 60] += 1
        serie = []
        for mnt in minuti:
            secs = [G.sec[s] for s in range(mnt * 60, mnt * 60 + 60) if s in G.sec]
            a, b = G.snapshot(mnt * 60), G.snapshot(mnt * 60 + 60)
            if len(secs) < 30 or not a or not b:
                continue
            vol_es = sum(x[2] for x in secs)
            vol_opz = sum(max(0, (b[2][k].get('calls') or 0) + (b[2][k].get('puts') or 0) - (a[2][k].get('calls') or 0) - (a[2][k].get('puts') or 0)) for k in b[2] if k in a[2])
            mids = [x[0] for x in secs if x[0] is not None]
            if len(mids) < 30:
                continue
            liq = 0
            mid = mids[-1]
            for lato in ('b', 'a'):
                for p, q, *_ in secs[-1][1].get(lato, []):
                    if q >= SOGLIA and abs(p - mid) <= 10:
                        liq += q
            zg = b[3]
            spot = b[1]
            gd = gamma_dealer(b)
            serie.append({'m': mnt, 'add': add_min[mnt], 'volEs': vol_es, 'volOpz': vol_opz,
                          'range': max(mids) - min(mids), 'liq': liq, 'sopraZg': (spot > zg) if zg else None, 'gd': gd})
        per_min.extend(serie)
        for chiave, filtro in [('zg', lambda x: x['sopraZg']), ('lr', lambda x: x['gd'] > 0)]:
            sopra = [x for x in serie if x['sopraZg'] is not None and filtro(x)]
            sotto = [x for x in serie if x['sopraZg'] is not None and not filtro(x)]
            if len(sopra) >= 30 and len(sotto) >= 30:
                per_giorno[chiave].append(tuple(statistics.mean(x[c] for x in sopra) - statistics.mean(x[c] for x in sotto) for c in ('liq', 'range', 'add', 'volEs')))
        for x in serie:
            if x['sopraZg'] is not None:
                regime['zg_' + ('sopra' if x['sopraZg'] else 'sotto')].append(x)
            regime['lr_' + ('pos' if x['gd'] > 0 else 'neg')].append(x)
            fascia = ((x['m'] * 60 - G.t0) // 1800)
            fasce[fascia][0] += x['add']
            fasce[fascia][1] += x['volOpz']
            fasce[fascia][2] += 1
        # Ritardi nel giorno (residui sul volume ES).
        if len(serie) > 60:
            add = [x['add'] for x in serie]
            opz = [x['volOpz'] for x in serie]
            es = [x['volEs'] for x in serie]
            ra, ro = residui(add, es), residui(opz, es)
            rk = lambda v: [sorted(v).index(x) for x in v]
            corr_giorno['muri~opz'].append(corr(rk(add), rk(opz)))
            corr_giorno['muri~ES'].append(corr(rk(add), rk(es)))
            corr_giorno['opz~ES'].append(corr(rk(opz), rk(es)))
            corr_giorno['muri~opz netto ES'].append(corr(ra, ro))
            corr_giorno['liq grande~range'].append(corr(rk([x['liq'] for x in serie]), rk([x['range'] for x in serie])))
            for lag in range(-5, 6):
                if lag >= 0:
                    xa, xo = ra[lag:], ro[:len(ro) - lag]
                else:
                    xa, xo = ra[:lag], ro[-lag:]
                lag_tot[lag].append(corr(xa, xo))
        print(f'{g}: {len(ev)} muri aggiunti >= {SOGLIA}, {len(serie)} minuti')

    ok = [(e, c) for e, c in zip(tutti_ev, tutti_ctrl) if e.get('f') and c and c.get('f')]
    print(f'\nTotale: {len(tutti_ev)} muri, {len(ok)} con controllo e opzioni\n')

    print('1. DOVE stanno i muri (quota entro 1 punto; muri vs livelli di controllo stessa distanza)')
    for chiave, nome in [('topVol', 'strike top-5 gamma x volume'), ('topOi', 'strike top-5 gamma x OI'),
                         ('zg', 'Zero Gamma'), ('strike5', 'qualunque strike SPX (multiplo di 5)'),
                         ('es5', 'ES multiplo di 5'), ('es10', 'ES multiplo di 10')]:
        soglia = 1.0 if chiave not in ('strike5', 'es5', 'es10') else 0.5
        m = [e['f'][chiave] for e, _ in ok if e['f'][chiave] is not None]
        c = [c['f'][chiave] for _, c in ok if c['f'][chiave] is not None]
        qm = sum(1 for x in m if x <= soglia) / len(m)
        qc = sum(1 for x in c if x <= soglia) / len(c)
        se = math.sqrt(qc * (1 - qc) / len(c) + qm * (1 - qm) / len(m))
        print(f'   {nome:38} entro {soglia}: muri {qm:5.1%}  controllo {qc:5.1%}  diff {qm - qc:+.1%} (z {(qm - qc) / se if se else 0:+.1f})')
    print('   per lato (strike top-5 volume, entro 1):')
    for lato in ('b', 'a'):
        m = [e['f']['topVol'] for e, _ in ok if e['lato'] == lato]
        c = [c['f']['topVol'] for e, c in ok if e['lato'] == lato]
        print(f"     {'bid' if lato == 'b' else 'ask'}: muri {sum(x <= 1 for x in m) / len(m):.1%}  controllo {sum(x <= 1 for x in c) / len(c):.1%}  (n {len(m)})")

    print('\n2. QUANDO')
    add = [x['add'] for x in per_min]
    opz = [x['volOpz'] for x in per_min]
    es = [x['volEs'] for x in per_min]
    rng = [x['range'] for x in per_min]
    print(f'   correlazione al minuto (tutti i giorni, {len(per_min)} minuti):')
    print(f'     muri aggiunti ~ volume opzioni      {corr(add, opz):+.2f}')
    print(f'     muri aggiunti ~ volume ES           {corr(add, es):+.2f}')
    print(f'     volume opzioni ~ volume ES          {corr(opz, es):+.2f}')
    print(f'     muri ~ opzioni al netto del vol ES  {corr(residui(add, es), residui(opz, es)):+.2f}')
    print('   correlazione di rango al minuto DENTRO ogni giorno (media, giorni con segno +):')
    for k, v in corr_giorno.items():
        v = [x for x in v if not math.isnan(x)]
        print(f'     {k:22} {statistics.mean(v):+.2f}   positivi {sum(x > 0 for x in v)}/{len(v)}')
    print('   ritardi (residui sul vol ES, media dei giorni; lag>0 = le opzioni vengono PRIMA dei muri):')
    print('     ' + '  '.join(f'{lag:+d}:{statistics.mean([v for v in lag_tot[lag] if not math.isnan(v)]):+.2f}' for lag in range(-5, 6)))
    vp = [(e['volPrima'], e['volDopo'], c['volPrima'], c['volDopo']) for e, c in ok
          if None not in (e.get('volPrima'), e.get('volDopo'), c.get('volPrima'), c.get('volDopo'))]
    if vp:
        med = lambda i: statistics.median(x[i] for x in vp)
        mea = lambda i: statistics.mean(x[i] for x in vp)
        print(f'   volume opzioni sullo strike del livello, 2 min (mediana / media), n {len(vp)}:')
        print(f'     muro:      prima {med(0):6.0f} / {mea(0):6.0f}   dopo {med(1):6.0f} / {mea(1):6.0f}')
        print(f'     controllo: prima {med(2):6.0f} / {mea(2):6.0f}   dopo {med(3):6.0f} / {mea(3):6.0f}')

    print('\n3. REGIME (medie al minuto)')
    for chiave, nome in [('zg_sopra', 'spot SOPRA Zero Gamma'), ('zg_sotto', 'spot SOTTO Zero Gamma'),
                         ('lr_pos', 'dealer gamma LR > 0'), ('lr_neg', 'dealer gamma LR < 0')]:
        xs = regime[chiave]
        if not xs:
            continue
        print(f"   {nome:24} n {len(xs):5}  muri/min {statistics.mean(x['add'] for x in xs):5.2f}  "
              f"liq grande +-10pt {statistics.mean(x['liq'] for x in xs):6.0f}  range 1m {statistics.mean(x['range'] for x in xs):5.2f}  "
              f"vol ES {statistics.mean(x['volEs'] for x in xs):6.0f}  vol opz {statistics.mean(x['volOpz'] for x in xs):6.0f}")
    for chiave, nome in [('zg', 'sopra - sotto Zero Gamma'), ('lr', 'dealer LR + meno -')]:
        d = per_giorno[chiave]
        if d:
            print(f"   per giorno, {nome}: liq piu' alta in {sum(x[0] > 0 for x in d)}/{len(d)} giorni (media {statistics.mean(x[0] for x in d):+.0f}), "
                  f"range piu' basso in {sum(x[1] < 0 for x in d)}/{len(d)} (media {statistics.mean(x[1] for x in d):+.2f}), "
                  f"vol ES piu' basso in {sum(x[3] < 0 for x in d)}/{len(d)}")
    print(f"   corr liq grande ~ range 1m: {corr([x['liq'] for x in per_min], rng):+.2f}   "
          f"muri ~ range: {corr(add, rng):+.2f}")

    print('\n4. ESITO e TENUTA')
    esiti = defaultdict(int)
    for e in tutti_ev:
        esiti[e['esito'] or 'aperto'] += 1
    print('   ' + '  '.join(f'{k} {v} ({v / len(tutti_ev):.0%})' for k, v in esiti.items()))
    dur = [e['durata'] for e in tutti_ev if e['esito'] == 'tolto' and e['durata'] is not None]
    if dur:
        print(f'   tolti senza tocco: durata mediana {statistics.median(dur):.0f} s, sotto 10 s {sum(d < 10 for d in dur) / len(dur):.0%}')
    for nome, filtro in [('su strike top-5 volume (<=1pt)', lambda e: e['f']['topVol'] <= 1),
                         ('lontani da strike top', lambda e: e['f']['topVol'] > 1),
                         ('vicino Zero Gamma (<=2pt)', lambda e: e['f']['zg'] is not None and e['f']['zg'] <= 2)]:
        xs = [e for e in tutti_ev if e.get('f') and e['tiene'] is not None and filtro(e)]
        if xs:
            print(f"   toccati {nome:32} n {len(xs):4}  tengono {sum(e['tiene'] for e in xs) / len(xs):.0%}")
    xs = [e for e in tutti_ev if e['tiene'] is not None]
    print(f"   toccati tutti                            n {len(xs):4}  tengono {sum(e['tiene'] for e in xs) / len(xs):.0%}")

    print('\n5. ORARI (per mezz\'ora dall\'apertura cash, medie al minuto)')
    for f in sorted(fasce):
        a, o, n = fasce[f]
        if n:
            h = 9 * 60 + 30 + f * 30
            print(f'   {h // 60:02d}:{h % 60:02d} ET  muri/min {a / n:5.2f}  volume opzioni/min {o / n:7.0f}')


if __name__ == '__main__':
    main()
