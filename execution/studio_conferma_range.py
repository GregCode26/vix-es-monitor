"""Verifica della "conferma sui range OB", la regola disegnata dall'indicatore Quantower (in prova dal 04/11/2026).

La regola (stessi numeri di CalcolaConferme() in quantower/GregDashboard/GregDashboard.cs; cambiarli in tutti e due):
  - livelli: i sei range OB (R1/R2/R3 sopra e sotto), dal punto di /api/market delle 9:35 NY; dal 04/11/2026 anche
    GEX+ / GEX- (strike col GEX OI piu' positivo/negativo) e lo Zero Gamma del poller, in ES con la base ES-SPX del
    cash; un livello mobile che salta di oltre 1 pt (strike nuovo) si riarma da capo;
  - un livello si arma quando ES (mid Bookmap) e' ad almeno 5 pt; tocco = entro 0,5 pt, dalle 9:35 alle 15:59 NY;
  - se entro 120 s ES riparte di 1,5 pt dalla parte da cui era arrivato, prima di passare 1,5 pt oltre,
    si entra li' (a mercato): stop 3 pt, target 4 pt, chiusura a mercato dopo 30 minuti.

Da dove viene: ricerca del 04/11/2026 su 12 sessioni (13/10-04/11, prima i range non erano salvati), prime 6 per
cercare e ultime 6 per verificare. Netto di 0,25 pt a operazione: +0,64 e +0,97 pt, 56-60% vinte; la stessa regola
sui livelli finti (range +-7 pt) perdeva in 81 varianti su 81. t ~ 1,9: non ancora una prova. Questo script serve a
rifare il conto sulle sessioni arrivate DOPO, le uniche che contano davvero.

Uso:  python execution/studio_conferma_range.py            (tutte le giornate; GEX e 0γ chiedono al server locale,
                                                           npm run dev, i giorni passati con ?date=: solo file locali)
      python execution/studio_conferma_range.py --dal 2026-11-05
Range e prezzi dai file locali (frontend/data/bookmap e market); niente Supabase in nessun caso.
"""
import argparse, glob, json, math, os, statistics as st, urllib.request
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'data')
ROMA, NY = ZoneInfo('Europe/Rome'), ZoneInfo('America/New_York')
RIARMO, TOCCO, CONF, STOP, TARGET, FINESTRA, DURATA = 5.0, 0.5, 1.5, 3.0, 4.0, 120, 1800
COSTO = 0.25
FINE_RICERCA = '2026-11-04'
SERVER = 'http://localhost:3000'
OGGI = datetime.now(ROMA).strftime('%Y-%m-%d')


def sec(t):
    return int(t[:2]) * 3600 + int(t[3:5]) * 60 + int(t[6:8])


def locale_da_ny(giorno, h, m):
    d = datetime(*map(int, giorno.split('-')), h, m, tzinfo=NY).astimezone(ROMA)
    return d.hour * 3600 + d.minute * 60


def num(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def range_ob(giorno):
    """Come livelliDa(puntoAllOra(storico, 9:35 NY)) in frontend/src/app/api/market/route.ts."""
    try:
        storico = json.load(open(os.path.join(RADICE, 'market', f'{giorno}.json'), encoding='utf-8'))
    except (OSError, ValueError):
        return None
    inizio = locale_da_ny(giorno, 9, 35)
    for p in storico:
        t = p.get('time') or ''
        if not t or sec(t) < inizio: continue
        if sec(t) > inizio + 1800: break
        es = num(p.get('esf'))
        q = [num(p.get(k)) for k in ('callBid', 'callAsk', 'putBid', 'putAsk')]
        if es is None or None in q: continue
        spot = num(p.get('spx')) or num(p.get('spxRef')) or es - 15
        basis = es - spot
        s = (q[0] + q[1]) / 2 + (q[2] + q[3]) / 2
        r3 = math.sqrt(3)
        # nomi come li mostrano le pagine: la chiave r2 (straddle/rad3) e' R1, la r1 (straddle) e' R2
        return {'R2↑': spot + s + basis, 'R2↓': spot - s + basis, 'R1↑': spot + s / r3 + basis,
                'R1↓': spot - s / r3 + basis, 'R3↑': spot + s * r3 + basis, 'R3↓': spot - s * r3 + basis}
    return None


def mid_al_secondo(giorno):
    righe = []
    with open(os.path.join(RADICE, 'bookmap', f'{giorno}.ndjson'), encoding='utf-8') as f:
        for r in f:
            try:
                p = json.loads(r)
            except ValueError:
                continue
            if p.get('bid') and p.get('ask') and p['ask'] > p['bid']:
                righe.append((p.get('alias'), sec(p['t']), (p['bid'] + p['ask']) / 2))
    if not righe: return None, None
    alias = Counter(a for a, _, _ in righe).most_common(1)[0][0]
    punti = sorted((s, m) for a, s, m in righe if a == alias)
    s0, s1 = punti[0][0], punti[-1][0]
    mid, j = [0.0] * (s1 - s0 + 1), 0
    for s in range(s0, s1 + 1):
        while j + 1 < len(punti) and punti[j + 1][0] <= s: j += 1
        mid[s - s0] = punti[j][1]
    return s0, mid


def api(percorso):
    """Il server locale (npm run dev), solo per giorni passati: con ?date= legge solo i file locali, mai Supabase."""
    try:
        with urllib.request.urlopen(SERVER + percorso, timeout=120) as r:
            return json.load(r)
    except Exception:
        return None


def base_al_secondo(giorno, s0, n):
    """ES - SPX del cash, mediana degli ultimi 5 minuti di letture (come BaseCorrente() nell'indicatore)."""
    try:
        storico = json.load(open(os.path.join(RADICE, 'market', f'{giorno}.json'), encoding='utf-8'))
    except (OSError, ValueError):
        return None
    da, a = locale_da_ny(giorno, 9, 30), locale_da_ny(giorno, 16, 0)
    letture = [(sec(p['time']), p['esf'] - p['spx']) for p in storico
               if p.get('time') and num(p.get('esf')) and num(p.get('spx')) and da <= sec(p['time']) <= a]
    if len(letture) < 5: return None
    out, j = [None] * n, 0
    for k in range(n):
        s = s0 + k
        while j < len(letture) and letture[j][0] <= s: j += 1
        if j == 0: continue
        fin = [v for t, v in letture[max(0, j - 200):j] if t >= letture[j - 1][0] - 300]
        out[k] = st.median(fin)
    return out


def a_gradini(punti, s0, n, eta_max, base):
    """[(sec, prezzo SPX)] -> prezzo ES al secondo: l'ultimo valore entro eta_max secondi, piu' la base."""
    out, j = [None] * n, 0
    punti = sorted(punti)
    for k in range(n):
        s = s0 + k
        while j < len(punti) and punti[j][0] <= s: j += 1
        if j == 0 or s - punti[j - 1][0] > eta_max or base[k] is None or punti[j - 1][1] is None: continue
        out[k] = punti[j - 1][1] + base[k]
    return out


def livelli_mobili(giorno, s0, n):
    """GEX+ / GEX- (strike col GEX OI piu' positivo/negativo, serie a 2 minuti) e Zero Gamma del poller, in ES."""
    out = {}
    if giorno >= OGGI:
        return out, 'oggi: GEX e 0γ si verificano dal giorno dopo (senza ?date= il server leggerebbe Supabase)'
    base = base_al_secondo(giorno, s0, n)
    if base is None:
        return out, 'niente base ES-SPX'
    gx = api(f'/api/gex?flow=0&date={giorno}')
    if gx and gx.get('serie') and gx.get('strikes'):
        pos, neg = [], []
        for fr in gx['serie']:
            v = fr['gexOi']; t = sec(fr['time'])
            ip = max(range(len(v)), key=lambda i: v[i]); ineg = min(range(len(v)), key=lambda i: v[i])
            pos.append((t, gx['strikes'][ip] if v[ip] > 0 else None))
            neg.append((t, gx['strikes'][ineg] if v[ineg] < 0 else None))
        out['GEX+'] = ('gex', a_gradini(pos, s0, n, 300, base))
        out['GEX-'] = ('gex', a_gradini(neg, s0, n, 300, base))
    zg = api(f'/api/zero-gamma?date={giorno}')
    if zg and zg.get('poller'):
        out['0γ'] = ('zero gamma', a_gradini([(sec(t), v) for t, v in zg['poller']['serie']], s0, n, 180, base))
    return out, None if out else 'server locale non raggiungibile o senza dati GEX'


def conferme(giorno):
    s0, mid = mid_al_secondo(giorno)
    if mid is None: return None, 'niente Bookmap'
    n = len(mid); s1 = s0 + n - 1
    livelli = {nome: ('range', [L] * n) for nome, L in (range_ob(giorno) or {}).items()}
    mobili, nota = livelli_mobili(giorno, s0, n)
    livelli.update(mobili)
    if not livelli: return None, 'niente livelli'
    da = max(s0, locale_da_ny(giorno, 9, 35)); fine = min(s1, locale_da_ny(giorno, 16, 0) - 60)
    out = []
    for nome, (tipo, Ls) in livelli.items():
        armato, lato, s = False, 0, da
        while s <= fine:
            L = Ls[s - s0]; prima = Ls[s - s0 - 1] if s > s0 else None
            # livello assente, o saltato su uno strike nuovo: si riarma da capo (un salto sul prezzo non e' un tocco)
            if L is None or prima is None or abs(L - prima) > 1:
                armato = False
                s += 1
                continue
            x = mid[s - s0] - L
            if abs(x) >= RIARMO:
                armato, lato = True, (1 if x > 0 else -1)
            elif armato and abs(x) <= TOCCO:
                armato = False
                k = None
                for t in range(s + 1, min(s1, s + FINESTRA) + 1):
                    y = lato * (mid[t - s0] - L)
                    if y <= -CONF: break
                    if y >= CONF: k = t; break
                if k is not None:
                    ent, esito = mid[k - s0], None
                    for t in range(k + 1, s1 + 1):
                        z = lato * (mid[t - s0] - ent)
                        if z >= TARGET: esito = TARGET; break
                        if z <= -STOP: esito = -STOP; break
                        if t - k >= DURATA: esito = z; break
                    out.append(dict(giorno=giorno, tipo=tipo, livello=nome, prezzo=round(L, 2), ora=f'{k // 3600:02}:{k % 3600 // 60:02}:{k % 60:02}',
                                    verso='LONG' if lato > 0 else 'SHORT', entrata=ent, esito=esito))
            s += 1
    return out, nota


def riassunto(nome, ops):
    chiuse = [o for o in ops if o['esito'] is not None]
    if not chiuse:
        print(f'{nome}: nessuna operazione chiusa'); return
    r = [o['esito'] - COSTO for o in chiuse]
    per_g = Counter()
    for o, x in zip(chiuse, r): per_g[o['giorno']] += x
    se = st.pstdev(r) / math.sqrt(len(r)) if len(r) > 1 else float('nan')
    print(f"{nome}: {len(r)} operazioni in {len(per_g)} giornate, vinte {sum(o['esito'] > 0 for o in chiuse) / len(r):.0%}, "
          f"netto {sum(r):+.2f} pt ({st.mean(r):+.2f} a operazione, t {st.mean(r) / se:+.1f}), "
          f"giornate positive {sum(v > 0 for v in per_g.values())}/{len(per_g)}")


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')  # le frecce dei nomi R1↑... sulla console di Windows
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', help='solo le giornate da questa data (YYYY-MM-DD)')
    ap.add_argument('--dettaglio', action='store_true', help='stampa ogni operazione')
    a = ap.parse_args()
    tutte = []
    for f in sorted(glob.glob(os.path.join(RADICE, 'bookmap', '*.ndjson'))):
        g = os.path.basename(f)[:10]
        if a.dal and g < a.dal: continue
        ops, nota = conferme(g)
        if ops is None:
            print(f'{g}: {nota}'); continue
        per_tipo = Counter()
        for o in ops:
            if o['esito'] is not None: per_tipo[o['tipo']] += o['esito'] - COSTO
        print(f"{g}: {len(ops)} operazioni, netto " + ', '.join(f'{t} {v:+.2f}' for t, v in sorted(per_tipo.items())) + (f'  ({nota})' if nota else ''))
        if a.dettaglio:
            for o in ops:
                es = 'aperta' if o['esito'] is None else f"{o['esito']:+.2f}"
                print(f"    {o['ora']} {o['verso']:5} {o['livello']:5} {o['prezzo']:.2f} entrata {o['entrata']:.2f} -> {es}")
        tutte += ops
    for tipo in ('range', 'gex', 'zero gamma'):
        print(f'\n== {tipo}')
        riassunto(f'Giornate della ricerca (fino al {FINE_RICERCA})', [o for o in tutte if o['tipo'] == tipo and o['giorno'] <= FINE_RICERCA])
        riassunto(f'Giornate NUOVE (dopo il {FINE_RICERCA}) - quelle che contano', [o for o in tutte if o['tipo'] == tipo and o['giorno'] > FINE_RICERCA])
