"""
Studio: quali parametri di un RSI classico si adattano meglio agli swing di ES?

    python execution/studio_rsi_swing.py [--dettaglio]

Due basi, nessuno scaricamento:
- ES locale al minuto (file di /market, Bookmap dove il file era tagliato a 100 punti), tutte le ore
  registrate; giorni divisi a meta': prima meta' ricerca, seconda conferma;
- SPX 5 minuti cash 2023-26 (cache di studio_vol_intraday), punti riportati a ES 7600; ricerca 2023-24,
  conferma 2025, prova 2026; qui swing da 15 e 25 punti (5-10 sono sotto la risoluzione di 5 minuti).

RSI di Wilder sulle chiusure di barre da 1/2/3/5 minuti (ES) o 5/10/15 (SPX), periodi 5-21, soglie
20/80 ... 35/65. Segnale classico all'uscita dalla zona: RSI che riscende sotto la soglia alta =
massimo, che risale sopra la bassa = minimo. Calcolato in tempo reale (niente dati futuri).

Swing = zigzag sui minuti/barre con soglia 5 e 10 punti ES. Un segnale "prende" uno swing se c'e' un
pivot dello stesso tipo entro 15 minuti e il prezzo del segnale e' entro il 30% della soglia dal
pivot. Precisione = segnali che prendono uno swing / segnali; richiamo = pivot presi / pivot; F1.
Confronto: segnali finti, stesso numero per giorno a orari casuali con la stessa proporzione
alto/basso (media di 20 estrazioni): se l'RSI non batte il caso, sta solo segnando prezzi qualsiasi.
In piu' il movimento di ES nel verso del segnale a 15 e 30 minuti (punti, media).
"""

import argparse
import glob
import json
import os
import random
import statistics as st
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

RADICE = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data')
CACHE = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_vol_intraday')
NY = ZoneInfo('America/New_York')

PERIODI = (5, 7, 9, 14, 21)
SOGLIE_RSI = ((10, 90), (20, 80), (25, 75), (30, 70), (35, 65))
SOGLIE_SWING = (5.0, 10.0)
TOLL_MIN = 15
TOLL_FRAZ = 0.3
ESTRAZIONI = 20


def sec(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 3600 + m * 60 + s


# ---------------------------------------------------------------- dati

def es_locale():
    """{giorno: [(minuto, chiusura)]} dai file di /market, Bookmap dove mancano minuti."""
    out = {}
    giorni = sorted({os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'market', '2026-??-??.json'))}
                    | {os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'bookmap', '2026-??-??.ndjson'))})
    oggi = datetime.now().date().isoformat()
    for g in giorni:
        if g >= oggi:
            continue
        es = {}
        try:
            with open(os.path.join(RADICE, 'market', f'{g}.json'), encoding='utf-8') as f:
                d = json.load(f)
            for p in d if isinstance(d, list) else []:
                if p.get('time') and p.get('esf'):
                    es[sec(p['time']) // 60] = p['esf']
        except Exception:
            pass
        try:
            with open(os.path.join(RADICE, 'bookmap', f'{g}.ndjson'), encoding='utf-8') as f:
                bm = {}
                for riga in f:
                    try:
                        q = json.loads(riga)
                    except Exception:
                        continue
                    b, a = q.get('bid'), q.get('ask')
                    if b and a and q.get('t'):
                        bm[sec(q['t']) // 60] = (b + a) / 2
            for m, v in bm.items():
                es.setdefault(m, v)
        except FileNotFoundError:
            pass
        if len(es) >= 240:
            out[g] = sorted(es.items())
    return out


def spx_cache():
    barre = {}
    for f in sorted(glob.glob(os.path.join(CACHE, 'SPX_*.json'))):
        for b in json.load(open(f)):
            barre[b['t']] = b
    giorni = defaultdict(list)
    for t in sorted(barre):
        d = datetime.fromtimestamp(t, NY)
        m = d.hour * 60 + d.minute
        if 570 <= m < 960:
            giorni[d.date().isoformat()].append((m + 5, barre[t]['c']))  # minuto di chiusura della barra
    out = {}
    for g, v in giorni.items():
        if len(v) < 60:
            continue
        k = 7600.0 / v[0][1]
        out[g] = [(m, c * k) for m, c in v]
    return out


def ricampiona(serie, b, passo):
    """Chiusure di barre da b minuti (serie gia' a passo `passo` minuti)."""
    if b == passo:
        return serie
    out = {}
    for m, c in serie:
        out[(m - 1) // b * b + b] = c   # ultima chiusura dentro la barra, marcata alla fine
    return sorted(out.items())


# ---------------------------------------------------------------- calcoli

def rsi(chiusure, n):
    out = [None] * len(chiusure)
    if len(chiusure) <= n:
        return out
    su = giu = 0.0
    for i in range(1, n + 1):
        d = chiusure[i] - chiusure[i - 1]
        su += max(d, 0)
        giu += max(-d, 0)
    su /= n
    giu /= n
    for i in range(n, len(chiusure)):
        if i > n:
            d = chiusure[i] - chiusure[i - 1]
            su = (su * (n - 1) + max(d, 0)) / n
            giu = (giu * (n - 1) + max(-d, 0)) / n
        out[i] = 100.0 if giu == 0 else 100 - 100 / (1 + su / giu)
    return out


def segnali(barre, n, basso, alto):
    """[(minuto, prezzo, +1 minimo / -1 massimo)] all'uscita dalla zona, dopo 2n barre di rodaggio."""
    c = [v for _, v in barre]
    r = rsi(c, n)
    out = []
    for i in range(max(2 * n, 1), len(c)):
        if r[i] is None or r[i - 1] is None:
            continue
        if r[i - 1] >= alto > r[i]:
            out.append((barre[i][0], c[i], -1))
        elif r[i - 1] <= basso < r[i]:
            out.append((barre[i][0], c[i], 1))
    return out


def zigzag(prezzi, soglia):
    """Pivot confermati [(minuto, prezzo, +1 minimo / -1 massimo)]."""
    if len(prezzi) < 2:
        return []
    piv = []
    t0, v0 = prezzi[0]
    mx, mn = (t0, v0), (t0, v0)
    verso, est = 0, None
    for t, v in prezzi[1:]:
        if verso == 0:
            if v > mx[1]:
                mx = (t, v)
            if v < mn[1]:
                mn = (t, v)
            if v - mn[1] >= soglia:
                verso, est = 1, (t, v)
                piv.append((mn[0], mn[1], 1))
            elif mx[1] - v >= soglia:
                verso, est = -1, (t, v)
                piv.append((mx[0], mx[1], -1))
            continue
        if (v - est[1]) * verso > 0:
            est = (t, v)
        elif (est[1] - v) * verso >= soglia:
            piv.append((est[0], est[1], -verso))
            est, verso = (t, v), -verso
    return piv


def abbina(seg, piv, soglia):
    """(segnali che prendono un pivot, pivot presi)."""
    presi_s, presi_p = 0, set()
    toll = TOLL_FRAZ * soglia
    for t, v, tipo in seg:
        buono = False
        for k, (tp, vp, tipop) in enumerate(piv):
            if tipop == tipo and abs(tp - t) <= TOLL_MIN and abs(vp - v) <= toll:
                buono = True
                presi_p.add(k)
        presi_s += buono
    return presi_s, len(presi_p)


def avanti(serie_d, t, minuti):
    for k in range(minuti, minuti + 6):
        if t + k in serie_d:
            return serie_d[t + k]
    return None


def valuta(giorni, dati, b, passo, n, basso, alto, rng, soglie=SOGLIE_SWING):
    """Somme su un gruppo di giorni, per ogni soglia di swing."""
    tot = {s: dict(seg=0, ok_s=0, piv=0, ok_p=0, caso_s=0.0, caso_p=0.0) for s in soglie}
    mov15, mov30 = [], []
    for g in giorni:
        serie = dati[g]
        barre = ricampiona(serie, b, passo)
        seg = segnali(barre, n, basso, alto)
        d = dict(serie)
        for t, v, tipo in seg:
            for mins, lst in ((15, mov15), (30, mov30)):
                f = avanti(d, t, mins)
                if f is not None:
                    lst.append((f - v) * tipo)
        # segnali finti: stessi numeri, orari casuali fra le barre utilizzabili
        usabili = barre[2 * n:]
        for s in soglie:
            piv = zigzag(serie, s)
            ok_s, ok_p = abbina(seg, piv, s)
            r = tot[s]
            r['seg'] += len(seg)
            r['ok_s'] += ok_s
            r['piv'] += len(piv)
            r['ok_p'] += ok_p
            if seg and usabili:
                cs = cp = 0
                for _ in range(ESTRAZIONI):
                    finti = [(m, c, tipo) for (m, c), (_, _, tipo)
                             in zip(rng.sample(usabili, min(len(seg), len(usabili))), seg)]
                    a, p = abbina(finti, piv, s)
                    cs += a
                    cp += p
                r['caso_s'] += cs / ESTRAZIONI
                r['caso_p'] += cp / ESTRAZIONI
    return tot, mov15, mov30


def f1(p, r):
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def riassunto(tot, s):
    r = tot[s]
    if not r['seg'] or not r['piv']:
        return None
    p, rc = r['ok_s'] / r['seg'], r['ok_p'] / r['piv']
    pc, rcc = r['caso_s'] / r['seg'], r['caso_p'] / r['piv']
    return dict(nseg=r['seg'], piv=r['piv'], prec=p, rich=rc, f1=f1(p, rc), f1caso=f1(pc, rcc), precCaso=pc)


def media(x):
    return sum(x) / len(x) if x else float('nan')


def studio(nome, dati, passo, barre_min, gruppi, dettaglio, soglie=SOGLIE_SWING):
    print(f'\n=== {nome}: {len(dati)} giorni ===')
    for etichetta, gg in gruppi:
        print(f'  {etichetta}: {len(gg)} giorni ({gg[0]} -> {gg[-1]})' if gg else f'  {etichetta}: vuoto')
    ricerca = gruppi[0][1]
    righe = []
    rng = random.Random(7)
    for b in barre_min:
        for n in PERIODI:
            for basso, alto in SOGLIE_RSI:
                tot, m15, m30 = valuta(ricerca, dati, b, passo, n, basso, alto, rng, soglie)
                for s in soglie:
                    r = riassunto(tot, s)
                    if r:
                        righe.append(dict(b=b, n=n, basso=basso, alto=alto, s=s, m15=media(m15), m30=media(m30), **r))
    risultati = {}
    for s in soglie:
        rs = sorted((r for r in righe if r['s'] == s and r['nseg'] >= len(ricerca)), key=lambda r: r['f1'] - r['f1caso'], reverse=True)
        print(f'\n  swing {s:g} pt, ricerca - migliori per F1 sopra il caso:')
        print('    barra  RSI  soglie   segnali/g  prec  (caso)  richiamo   F1   F1caso   mov15  mov30')
        for r in rs[:8 if not dettaglio else 40]:
            print(f"    {r['b']:>3}m  {r['n']:>3}  {r['basso']}/{r['alto']}   {r['nseg'] / len(ricerca):7.1f}"
                  f"   {r['prec']:.2f}  ({r['precCaso']:.2f})   {r['rich']:.2f}    {r['f1']:.3f}  {r['f1caso']:.3f}"
                  f"   {r['m15']:+.2f}  {r['m30']:+.2f}")
        migliore = rs[0]
        risultati[s] = migliore
        print(f"\n  scelta swing {s:g}: barra {migliore['b']}m, RSI {migliore['n']}, {migliore['basso']}/{migliore['alto']} - verifica:")
        for etichetta, gg in gruppi:
            if not gg:
                continue
            tot, m15, m30 = valuta(gg, dati, migliore['b'], passo, migliore['n'], migliore['basso'], migliore['alto'], rng, soglie)
            r = riassunto(tot, s)
            if r:
                print(f"    {etichetta:10} segnali {r['nseg']:5}  prec {r['prec']:.2f} (caso {r['precCaso']:.2f})  richiamo {r['rich']:.2f}"
                      f"  F1 {r['f1']:.3f} vs caso {r['f1caso']:.3f}  mov15 {media(m15):+.2f}  mov30 {media(m30):+.2f}  (n {len(m15)})")
        # anche il classico 14 30/70 sulla barra scelta, come riferimento
        for etichetta, gg in gruppi:
            if not gg:
                continue
            tot, m15, m30 = valuta(gg, dati, migliore['b'], passo, 14, 30, 70, rng, soglie)
            r = riassunto(tot, s)
            if r:
                print(f"    classico 14 30/70 {etichetta:10} prec {r['prec']:.2f} (caso {r['precCaso']:.2f})  F1 {r['f1']:.3f} vs {r['f1caso']:.3f}"
                      f"  mov15 {media(m15):+.2f}")
    return risultati


# ---------------------------------------------------------------- segnale immediato (13/11/2026)

def es_secondi():
    """{giorno: [(secondo, prezzo)]} a passo ~15 s: punti del file di /market, Bookmap campionato ogni
    15 s dove il file era tagliato."""
    out = {}
    oggi = datetime.now().date().isoformat()
    giorni = sorted({os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'market', '2026-??-??.json'))}
                    | {os.path.basename(f)[:10] for f in glob.glob(os.path.join(RADICE, 'bookmap', '2026-??-??.ndjson'))})
    for g in giorni:
        if g >= oggi:
            continue
        pt = {}
        try:
            with open(os.path.join(RADICE, 'market', f'{g}.json'), encoding='utf-8') as f:
                d = json.load(f)
            for p in d if isinstance(d, list) else []:
                if p.get('time') and p.get('esf'):
                    pt[sec(p['time'])] = p['esf']
        except Exception:
            pass
        if len(pt) < 1000:
            try:
                with open(os.path.join(RADICE, 'bookmap', f'{g}.ndjson'), encoding='utf-8') as f:
                    for riga in f:
                        try:
                            q = json.loads(riga)
                        except Exception:
                            continue
                        b, a = q.get('bid'), q.get('ask')
                        if b and a and q.get('t'):
                            pt.setdefault(sec(q['t']) // 15 * 15, (b + a) / 2)
            except FileNotFoundError:
                pass
        if len(pt) >= 960:
            out[g] = sorted(pt.items())
    return out


def _rr(u, d):
    return (50.0 if u == 0 else 100.0) if d == 0 else 100 - 100 / (1 + u / d)


def segnali_punti(punti, b, n, basso, alto, immediato):
    """Come lib/rsi.ts: RSI di Wilder su barre da b minuti, valore provvisorio a ogni punto.
    immediato=False: segnale solo a barra chiusa (ultimo punto della barra);
    immediato=True: segnale al punto in cui l'RSI provvisorio riesce dalla zona, al massimo uno per tipo
    per barra. Tempi in minuti con decimali."""
    out = []
    barra = chius = prec = t_ult = rsi_chiuso = rsi_punto = None
    chiuse = 0
    ss = sg = ms = mg = 0.0
    fatti = set()
    for t, v in punti:
        bb = (t // 60) // b
        if barra is not None and bb != barra:
            if prec is not None:
                d = chius - prec
                if chiuse <= n:
                    ss += max(d, 0)
                    sg += max(-d, 0)
                    if chiuse == n:
                        ms, mg = ss / n, sg / n
                else:
                    ms = (ms * (n - 1) + max(d, 0)) / n
                    mg = (mg * (n - 1) + max(-d, 0)) / n
                if chiuse >= n:
                    r = _rr(ms, mg)
                    if not immediato and rsi_chiuso is not None and chiuse >= 2 * n:
                        if rsi_chiuso >= alto > r:
                            out.append((t_ult / 60, chius, -1))
                        elif rsi_chiuso <= basso < r:
                            out.append((t_ult / 60, chius, 1))
                    rsi_chiuso = r
            prec = chius
            chiuse += 1
            fatti = set()
        barra, chius, t_ult = bb, v, t
        if prec is not None and chiuse > n:
            r = _rr((ms * (n - 1) + max(v - prec, 0)) / n, (mg * (n - 1) + max(prec - v, 0)) / n)
            if immediato and rsi_punto is not None and chiuse >= 2 * n:
                if rsi_punto >= alto > r and -1 not in fatti:
                    out.append((t / 60, v, -1))
                    fatti.add(-1)
                elif rsi_punto <= basso < r and 1 not in fatti:
                    out.append((t / 60, v, 1))
                    fatti.add(1)
            rsi_punto = r
    return out


def avanti_s(d, t, minuti):
    base = int(t * 60)
    for k in range(minuti * 60, minuti * 60 + 120):
        if base + k in d:
            return d[base + k]
    return None


def confronto_immediato():
    dati = es_secondi()
    gg = sorted(dati)
    meta = len(gg) // 2
    gruppi = [('ricerca', gg[:meta]), ('conferma', gg[meta:])]
    print(f'\n=== segnale a barra chiusa vs immediato (punti da ~15 s, {len(gg)} giorni) ===')
    for e, g in gruppi:
        print(f'  {e}: {len(g)} giorni ({g[0]} -> {g[-1]})')
    print('  swing 10 pt: prec = segnali su un pivot (caso fra parentesi); mov = punti ES nel verso del segnale '
          'a 5/15/30 min; 4/4 = arriva prima +4 o -4 dal prezzo del segnale (% vinte, punti medi netti di 0.25)')
    rng = random.Random(11)
    for b, n, basso, alto in ((1, 5, 20, 80), (1, 5, 10, 90), (1, 5, 25, 75), (1, 7, 20, 80), (1, 7, 10, 90),
                              (1, 9, 20, 80), (1, 9, 10, 90), (2, 5, 20, 80), (2, 5, 10, 90), (1, 14, 30, 70)):
        for imm in (False, True):
            print(f'  {b}m RSI {n:>2} {basso}/{alto} {"immediato" if imm else "chiusura"}')
            for e, g in gruppi:
                ns = oks = npv = okp = 0
                cs = cp = 0.0
                m5, m15, m30, esiti = [], [], [], []
                for giorno in g:
                    punti = dati[giorno]
                    seg = segnali_punti(punti, b, n, basso, alto, imm)
                    minuti = {}
                    for t, v in punti:
                        minuti[t // 60] = v
                    piv = zigzag(sorted(minuti.items()), 10.0)
                    a, p_ = abbina(seg, piv, 10.0)
                    ns += len(seg)
                    oks += a
                    npv += len(piv)
                    okp += p_
                    if seg:
                        usabili = [(t / 60, v) for t, v in punti[len(punti) // 20:]]
                        for _ in range(ESTRAZIONI):
                            finti = [(m, c, tipo) for (m, c), (_, _, tipo)
                                     in zip(rng.sample(usabili, min(len(seg), len(usabili))), seg)]
                            x, y = abbina(finti, piv, 10.0)
                            cs += x / ESTRAZIONI
                            cp += y / ESTRAZIONI
                    d = dict(punti)
                    for t, v, tipo in seg:
                        for mins, lst in ((5, m5), (15, m15), (30, m30)):
                            f = avanti_s(d, t, mins)
                            if f is not None:
                                lst.append((f - v) * tipo)
                        for tt, vv in punti:
                            if tt <= t * 60:
                                continue
                            if tt > t * 60 + 3600:
                                break
                            m = (vv - v) * tipo
                            if m >= 4 or m <= -4:
                                esiti.append((4 if m > 0 else -4) - 0.25)
                                break
                pr = oks / ns if ns else 0
                rc = okp / npv if npv else 0
                prc = cs / ns if ns else 0
                rcc = cp / npv if npv else 0
                vinte = sum(1 for x in esiti if x > 0) / len(esiti) if esiti else 0
                print(f'      {e:8} n {ns:4}  prec {pr:.2f} ({prc:.2f})  F1 {f1(pr, rc):.2f} ({f1(prc, rcc):.2f})'
                      f'  mov {media(m5):+.2f} {media(m15):+.2f} {media(m30):+.2f}  4/4 {vinte:.0%} {media(esiti):+.2f}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dettaglio', action='store_true')
    ap.add_argument('--immediato', action='store_true', help='solo il confronto barra chiusa / segnale immediato')
    a = ap.parse_args()
    if a.immediato:
        confronto_immediato()
        return

    es = es_locale()
    gg = sorted(es)
    meta = len(gg) // 2
    studio('ES locale al minuto', es, 1, (1, 2, 3, 5), [('ricerca', gg[:meta]), ('conferma', gg[meta:])], a.dettaglio)

    spx = spx_cache()
    gs = sorted(spx)
    studio('SPX 5 minuti cash 2023-26 (scala ES 7600)', spx, 5, (5, 10, 15),
           [('ricerca', [g for g in gs if g < '2025-01-01']),
            ('conferma', [g for g in gs if '2025' <= g < '2026']),
            ('prova', [g for g in gs if g >= '2026'])], a.dettaglio, soglie=(15.0, 25.0))


if __name__ == '__main__':
    main()
