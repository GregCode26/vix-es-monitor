"""Simulazione storica della strategia DAX e delle varianti di rischio (chiamato da studio_dax_strategia.py).

Modello prezzi (le ODAX scadute non si possono scaricare):
- IV ATM a T: VDAX-NEW (30 gg) che rientra verso la media di lungo periodo con T.
- IV ATM a T: VDAX/1,10 che rientra verso 17,5 con T (errore ~±1 punto sulle 7 date della lezione).
- Skew: differenza IV(K) - IV ATM della catena reale del 24/11/2026 in funzione di
  ln(K/F)/sqrt(T), scalata con (IV ATM / 19,48)^0,25.
- Black-76, tasso 0. Bid/ask: semi-spread (1 + 0,6% del prezzo) punti × max(1, IV/20) × livello/25.000.
- Commissioni 2 € a contratto per lato. Risultati in € riportati a DAX 25.000 (× 25.000 / DAX d'ingresso).
Prima del 28/01/2009 il VDAX non c'è su IBKR: è stimato dalla volatilità realizzata (regressione 2009-2026).
"""
import json, math, os, statistics
from datetime import date, timedelta
import numpy as np
from scipy.stats import norm

MOLT = 5
COMM = 2.0
RIF = 25000.0
CATENA_24_11 = [  # strike, iv  (scadenza 19/03/2027, 115 gg, spot 24961, forward 25292, ATM 19,48)
    (14000, 49.04), (14400, 47.25), (14800, 45.8), (15000, 45.16), (15200, 44.67), (15600, 43.56), (15800, 42.97),
    (16000, 42.51), (16200, 41.77), (16400, 41.12), (19000, 33.92), (19200, 33.41), (20000, 31.29), (20200, 30.91),
    (20500, 30.12), (21000, 28.78), (21500, 27.49), (22500, 25.01), (23000, 23.83), (23500, 22.68), (24000, 21.56),
    (25000, 19.48)]
F_RIF, T_RIF, ATM_RIF = 25292.0, 115 / 365, 19.48
_x = np.array([math.log(k / F_RIF) / math.sqrt(T_RIF) for k, _ in CATENA_24_11])
_d = np.array([v - ATM_RIF for _, v in CATENA_24_11])
_o = np.argsort(_x); SK_X, SK_D = _x[_o], _d[_o]
_PEND = (SK_D[1] - SK_D[0]) / (SK_X[1] - SK_X[0])
LUNGO = 17.5  # IV ATM di lungo periodo
VDAX_SU_ATM = 1.10  # il VDAX (varianza, come il VIX) sta sopra la IV ATM: tarato sulle 7 date della lezione


def skew(x):
    if x < SK_X[0]:
        return SK_D[0] + _PEND * (x - SK_X[0])
    if x > SK_X[-1]:
        return SK_D[-1] + 0.4 * (SK_D[-1] - SK_D[-2]) / (SK_X[-1] - SK_X[-2]) * (x - SK_X[-1])
    return float(np.interp(x, SK_X, SK_D))


def atm_t(vdax, T):
    k = 2.0
    f = (1 - math.exp(-k * T)) / (k * T) if T > 1e-6 else 1.0
    return LUNGO + (vdax / VDAX_SU_ATM - LUNGO) * f


def iv(K, S, T, vdax, shock=0.0):
    a = atm_t(vdax, max(T, 1 / 365))
    x = math.log(K / S) / math.sqrt(max(T, 1 / 365))
    v = a + skew(x) * (a / ATM_RIF) ** 0.25 + shock  # skew lontano ~+24 punti sia con ATM 15,9 sia 19,5
    return min(max(v, 5.0), 160.0) / 100


def put(S, K, T, sig):
    if T <= 0:
        return max(K - S, 0.0)
    s = sig * math.sqrt(T)
    d1 = (math.log(S / K) + s * s / 2) / s
    return K * norm.cdf(-d1 + s) - S * norm.cdf(-d1)


def semispread(prezzo, S, vdax):
    return (1.0 + 0.006 * prezzo) * max(1.0, vdax / 20.0) * S / RIF


# ------------------------------------------------------------------ dati
def carica(cache):
    dax = {r[0]: r[4] for r in json.load(open(os.path.join(cache, 'DAX.json')))}
    vd = {r[0]: r[4] for r in json.load(open(os.path.join(cache, 'VDAX.json')))}
    giorni = sorted(dax)
    lr = {g: math.log(dax[g] / dax[p]) for p, g in zip(giorni, giorni[1:])}
    rv = {}
    for i, g in enumerate(giorni):
        a = [lr[x] for x in giorni[max(1, i - 20):i + 1] if x in lr]
        b = [lr[x] for x in giorni[max(1, i - 4):i + 1] if x in lr]
        if len(a) >= 15:
            rv[g] = (statistics.pstdev(a) * math.sqrt(252) * 100, statistics.pstdev(b) * math.sqrt(252) * 100 if len(b) > 2 else None)
    X, Y = [], []
    for g in giorni:
        if g in vd and g in rv and rv[g][1] is not None:
            X.append([1, rv[g][0], rv[g][1]]); Y.append(vd[g])
    coef = np.linalg.lstsq(np.array(X), np.array(Y), rcond=None)[0]
    pred = np.array(X) @ coef
    r2 = 1 - ((np.array(Y) - pred) ** 2).sum() / ((np.array(Y) - np.mean(Y)) ** 2).sum()
    vdax, stimato, ult = {}, set(), None
    for g in giorni:
        if g in vd:
            ult = vd[g]; vdax[g] = ult
        elif g < min(vd) and g in rv and rv[g][1] is not None:
            vdax[g] = max(10.0, coef[0] + coef[1] * rv[g][0] + coef[2] * rv[g][1]); stimato.add(g)
        elif ult is not None:
            vdax[g] = ult
    giorni = [g for g in giorni if g in vdax]
    return giorni, dax, vdax, stimato, (coef, r2)


def terzo_venerdi(a, m):
    d = date(a, m, 1)
    d += timedelta(days=(4 - d.weekday()) % 7)
    return d + timedelta(days=14)


def scadenze(da, a):
    out = []
    for y in range(da, a + 1):
        for m in (3, 6, 9, 12):
            out.append(terzo_venerdi(y, m))
    return out


# ------------------------------------------------------------------ strategia
def griglia(S):
    return 50 if S < 10000 else 100


def arrotonda(v, g):
    return int(round(v / g) * g)


def costruisci(S, T, vd, regola):
    g = griglia(S)
    k1 = arrotonda(S * 0.95, g); w1 = max(g, arrotonda(S * 0.02, g))
    k3 = arrotonda(S * 0.855, g); w2 = max(g, arrotonda(S * 0.052, g))
    ks = arrotonda(S * regola.get('dist_vendute', 0.62), g)
    lunghe = [(k1, 1), (k1 - w1, -1), (k3, 1), (k3 - w2, -1)]

    def costo(gambe):
        tot = 0.0
        for K, q in gambe:
            m = put(S, K, T, iv(K, S, T, vd)); h = semispread(m, S, vd)
            tot += q * (m + h if q > 0 else m - h)
        return tot  # >0 debito
    n = regola['vendute']
    if n == 'credito':
        base = costo(lunghe); p = put(S, ks, T, iv(ks, S, T, vd)); pv = p - semispread(p, S, vd)
        n = max(1, min(regola.get('max_vendute', 10), math.ceil((base + 5 * S / RIF) / pv))) if pv > 0 else 10
    gambe = lunghe + ([(ks, -n)] if n else [])
    if regola.get('ala'):
        gambe.append((arrotonda(ks * (1 - regola['ala']), g), n))
    return gambe, costo(gambe), n


def valuta(gambe, S, T, vd, uscita=False):
    """valore della posizione (punti, + = vale per noi); uscita=True a bid/ask."""
    tot = 0.0
    for K, q in gambe:
        m = put(S, K, T, iv(K, S, T, vd)) if T > 0 else max(K - S, 0.0)
        if uscita and T > 0:
            h = semispread(m, S, vd)
            m = m - h if q > 0 else m + h
        tot += q * m
    return tot


def simula(giorni, dax, vdax, regola):
    idx = {g: i for i, g in enumerate(giorni)}
    sc = [s for s in scadenze(2005, 2027) if s.isoformat() > giorni[0]]
    operazioni = []
    for prima, scad in zip(sc, sc[1:]):
        ingresso = (prima - timedelta(days=regola.get('anticipo', 30))).isoformat()
        cand = [g for g in giorni if g >= ingresso]
        if not cand or scad.isoformat() > giorni[-1]:
            continue
        g0 = cand[0]; i0 = idx[g0]; S0 = dax[g0]; vd0 = vdax[g0]
        if regola.get('filtro_vdax') and vd0 > regola['filtro_vdax']:
            operazioni.append(dict(ingresso=g0, saltata=True)); continue
        T0 = (scad - date.fromisoformat(g0)).days / 365
        gambe, costo, n = costruisci(S0, T0, vd0, regola)
        norm_ = RIF / S0
        comm_in = sum(abs(q) for _, q in gambe) * COMM
        prezzo_vend = {K: put(S0, K, T0, iv(K, S0, T0, vd0)) for K, q in gambe if q < 0}
        serie, uscita, motivo = [], None, 'scadenza'
        ricomprate = False
        realizzato = 0.0
        for g in giorni[i0 + 1:]:
            T = (scad - date.fromisoformat(g)).days / 365
            S, vd = dax[g], vdax[g]
            if T <= 0:
                v = valuta(gambe, S, 0, vd)
                pnl = (v - costo) * MOLT * norm_ - comm_in + realizzato
                serie.append((g, pnl)); uscita = g; break
            mtm = (valuta(gambe, S, T, vd) - costo) * MOLT * norm_ - comm_in + realizzato
            chiudi = (valuta(gambe, S, T, vd, True) - costo) * MOLT * norm_ - comm_in + realizzato \
                - sum(abs(q) for _, q in gambe) * COMM
            serie.append((g, mtm))
            # ricompra le vendute (lasciando gli spread)
            if not ricomprate and regola.get('ricompra_x') or (not ricomprate and regola.get('ricompra_calo')):
                vend = [(K, q) for K, q in gambe if q < 0 and K < S0 * 0.8]
                prezzo_ora = {K: put(S, K, T, iv(K, S, T, vd)) for K, q in vend}
                scatta = False
                if regola.get('ricompra_x') and vend and any(prezzo_ora[K] >= regola['ricompra_x'] * prezzo_vend[K] for K, _ in vend):
                    scatta = True
                if regola.get('ricompra_calo') and S <= S0 * (1 - regola['ricompra_calo']):
                    scatta = True
                if scatta and vend:
                    for K, q in vend:
                        m = prezzo_ora[K]; a = m + semispread(m, S, vd)
                        realizzato += q * a * MOLT * norm_ - abs(q) * COMM  # q<0: paghi
                    gambe = [(K, q) for K, q in gambe if not (q < 0 and K < S0 * 0.8)]
                    ricomprate = True
            if regola.get('ricompra_resto') and not ricomprate:
                vend = [(K, q) for K, q in gambe if q < 0 and K < S0 * 0.8]
                if vend and all(put(S, K, T, iv(K, S, T, vd)) <= regola['ricompra_resto'] * prezzo_vend[K] for K, _ in vend):
                    for K, q in vend:
                        m = put(S, K, T, iv(K, S, T, vd)); a = m + semispread(m, S, vd)
                        realizzato += q * a * MOLT * norm_ - abs(q) * COMM
                    gambe = [(K, q) for K, q in gambe if not (q < 0 and K < S0 * 0.8)]
                    ricomprate = True
            if regola.get('tp') and chiudi >= regola['tp']:
                serie[-1] = (g, chiudi); uscita = g; motivo = 'obiettivo'; break
            if regola.get('stop') and chiudi <= -regola['stop']:
                serie[-1] = (g, chiudi); uscita = g; motivo = 'stop'; break
            if regola.get('stop_calo') and S <= S0 * (1 - regola['stop_calo']):
                serie[-1] = (g, chiudi); uscita = g; motivo = 'stop calo'; break
        if uscita is None:
            continue
        operazioni.append(dict(ingresso=g0, uscita=uscita, S0=S0, vdax=vd0, n=n, gambe=gambe, motivo=motivo,
                               pnl=serie[-1][1], peggiore=min(p for _, p in serie), serie=serie, ricomprate=ricomprate))
    return operazioni


def metriche(ops, giorni):
    fatte = [o for o in ops if not o.get('saltata')]
    if not fatte:
        return {}
    pnl = [o['pnl'] for o in fatte]
    # equity giornaliera: somma del P&L aperto/chiuso di tutte le operazioni
    eq = {}
    for o in fatte:
        ultimo = 0.0; mappa = dict(o['serie'])
        for g in giorni:
            if g < o['ingresso']:
                continue
            if g in mappa:
                ultimo = mappa[g]
            eq[g] = eq.get(g, 0.0) + ultimo
            if g > o['uscita'] and g not in mappa:
                pass
    # le operazioni chiuse restano col loro P&L finale (già in 'ultimo')
    serie_eq = [eq[g] for g in sorted(eq)]
    picco, dd = -1e18, 0.0
    for v in serie_eq:
        picco = max(picco, v); dd = min(dd, v - picco)
    return dict(n=len(fatte), saltate=len(ops) - len(fatte), vinte=sum(p > 0 for p in pnl) / len(pnl) * 100,
                totale=sum(pnl), media=statistics.mean(pnl), mediana=statistics.median(pnl), peggiore=min(pnl),
                migliore=max(pnl), peggior_aperto=min(o['peggiore'] for o in fatte), maxdd=dd,
                n_medio=statistics.mean(o['n'] for o in fatte))


VARIANTI = [
    ('A  regola lezione: vendute per credito, +700, nessuno stop', dict(vendute='credito', tp=700)),
    ('A1 come A, obiettivo +1.000', dict(vendute='credito', tp=1000)),
    ('A2 come A, tenuta a scadenza (nessun obiettivo)', dict(vendute='credito')),
    ('B5 5 vendute fisse, +700', dict(vendute=5, tp=700)),
    ('B4 4 vendute, +700', dict(vendute=4, tp=700)),
    ('B3 3 vendute, +700', dict(vendute=3, tp=700)),
    ('B2 2 vendute, +700', dict(vendute=2, tp=700)),
    ('B0 solo V1+V2 comprati, +700', dict(vendute=0, tp=700)),
    ('A6 vendute per credito ma al massimo 6 (regola 71:46)', dict(vendute='credito', tp=700, max_vendute=6)),
    ('M1 A con chiusura forzata a -10.000 € (conto 10k)', dict(vendute='credito', tp=700, stop=10000)),
    ('M2 B5 con chiusura forzata a -10.000 €', dict(vendute=5, tp=700, stop=10000)),
    ('M3 B3 con chiusura forzata a -10.000 €', dict(vendute=3, tp=700, stop=10000)),
    ('C1 A + stop a -3.000 €', dict(vendute='credito', tp=700, stop=3000)),
    ('C2 A + stop a -2.000 €', dict(vendute='credito', tp=700, stop=2000)),
    ('C3 A + chiudi tutto se DAX -12% dall\'ingresso', dict(vendute='credito', tp=700, stop_calo=0.12)),
    ('C4 A + chiudi tutto se DAX -18%', dict(vendute='credito', tp=700, stop_calo=0.18)),
    ('D1 A + ricompra vendute se valgono 3x', dict(vendute='credito', tp=700, ricompra_x=3)),
    ('D2 A + ricompra vendute se DAX -15% (tieni spread)', dict(vendute='credito', tp=700, ricompra_calo=0.15)),
    ('D3 A + ricompra vendute a 30% del prezzo', dict(vendute='credito', tp=700, ricompra_resto=0.3)),
    ('D4 A + ricompra vendute se DAX -10%', dict(vendute='credito', tp=700, ricompra_calo=0.10)),
    ('D5 A + ricompra vendute se DAX -20%', dict(vendute='credito', tp=700, ricompra_calo=0.20)),
    ('G6 max 6 vendute + ricompra se DAX -15%', dict(vendute='credito', tp=700, max_vendute=6, ricompra_calo=0.15)),
    ('G5 5 vendute + ricompra se DAX -15%', dict(vendute=5, tp=700, ricompra_calo=0.15)),
    ('G4 4 vendute + ricompra se DAX -15%', dict(vendute=4, tp=700, ricompra_calo=0.15)),
    ('G4b 4 vendute + ricompra se DAX -12%', dict(vendute=4, tp=700, ricompra_calo=0.12)),
    ('G4c 4 vendute + ricompra -15% + obiettivo 1.000', dict(vendute=4, tp=1000, ricompra_calo=0.15)),
    ('E1 A ma non aprire con VDAX > 25', dict(vendute='credito', tp=700, filtro_vdax=25)),
    ('F1 3 vendute + ricompra se DAX -15%', dict(vendute=3, tp=700, ricompra_calo=0.15)),
    ('F2 3 vendute + ricompra 3x + VDAX<=25', dict(vendute=3, tp=700, ricompra_x=3, filtro_vdax=25)),
    ('F3 credito + ricompra 3x + VDAX<=25', dict(vendute='credito', tp=700, ricompra_x=3, filtro_vdax=25)),
]

PERIODI = [('2008 (Lehman)', '2008-01-01', '2009-03-31'), ('2011 (debito UE)', '2011-06-01', '2011-12-31'),
           ('2015-16', '2015-06-01', '2016-03-31'), ('2018 Q4', '2018-09-01', '2019-01-31'),
           ('2020 (Covid)', '2020-01-01', '2020-06-30'), ('2022', '2022-01-01', '2022-12-31'),
           ('2025 (dazi)', '2025-02-01', '2025-06-30')]


def e(v):
    return f"{v:,.0f}".replace(',', '.')


def main(cache):
    giorni, dax, vdax, stimato, (coef, r2) = carica(cache)
    print(f"DAX {giorni[0]} -> {giorni[-1]} ({len(giorni)} giorni); VDAX stimato su {len(stimato)} giorni "
          f"(prima del 2009, R² {r2:.2f})")
    # verifica del modello sulla catena reale del 24/11/2026
    S, T = 24961.0, 115 / 365
    vd = vdax.get('2026-11-24')
    print(f"\nControllo modello 24/11/2026 (VDAX {vd}): strike  IV modello / IBKR")
    for K, v in CATENA_24_11[::3]:
        print(f"   {K}: {iv(K, S, T, vd)*100:5.1f} / {v:5.1f}")
    risultati = []
    for nome, r in VARIANTI:
        ops = simula(giorni, dax, vdax, r)
        m = metriche(ops, giorni)
        per = {}
        for pn, a, b in PERIODI:
            per[pn] = sum(o['pnl'] for o in ops if not o.get('saltata') and a <= o['ingresso'] <= b)
        meta = '2016-01-01'
        m['prima'] = sum(o['pnl'] for o in ops if not o.get('saltata') and o['ingresso'] < meta)
        m['dopo'] = sum(o['pnl'] for o in ops if not o.get('saltata') and o['ingresso'] >= meta)
        risultati.append((nome, r, m, per, ops))
    print(f"\n{'variante':52s} {'op':>3s} {'vinte':>6s} {'totale €':>9s} {'media':>6s} {'peggiore':>9s} {'peggior aperto':>14s} "
          f"{'max DD':>8s} {'2005-15':>8s} {'2016-26':>8s} {'N':>4s}")
    for nome, r, m, per, _ in risultati:
        print(f"{nome:52s} {m['n']:3d} {m['vinte']:5.0f}% {e(m['totale']):>9s} {e(m['media']):>6s} {e(m['peggiore']):>9s} "
              f"{e(m['peggior_aperto']):>14s} {e(m['maxdd']):>8s} {e(m['prima']):>8s} {e(m['dopo']):>8s} {m['n_medio']:4.1f}")
    print(f"\nRisultato delle operazioni aperte nei periodi di crisi (€):")
    print(f"{'variante':52s} " + ' '.join(f"{p[0][:12]:>12s}" for p in PERIODI))
    for nome, r, m, per, _ in risultati:
        print(f"{nome:52s} " + ' '.join(f"{e(per[p[0]]):>12s}" for p in PERIODI))
    # dettaglio regola base
    for k in (0, 3):  # A e B5
        print(f"\nLe 10 operazioni con il minimo aperto peggiore — {risultati[k][0]}:")
        for o in sorted([o for o in risultati[k][4] if not o.get('saltata')], key=lambda o: o['peggiore'])[:10]:
            print(f"  {o['ingresso']} DAX {o['S0']:6.0f} VDAX {o['vdax']:5.1f} vendute {o['n']:2d} -> {o['uscita']} "
                  f"{o['motivo']:9s} finale {e(o['pnl']):>7s}  minimo aperto {e(o['peggiore']):>8s}")
    print("\nOperazioni della regola A (ingresso, DAX, VDAX, vendute, uscita, motivo, P&L, peggior aperto):")
    for o in risultati[0][4]:
        if o.get('saltata'):
            continue
        print(f"  {o['ingresso']} {o['S0']:8.0f} {o['vdax']:5.1f} {o['n']:2d}  {o['uscita']} {o['motivo']:9s} "
              f"{e(o['pnl']):>8s} {e(o['peggiore']):>8s}")
    json.dump([dict(nome=n, metriche=m, periodi=p) for n, _, m, p, _ in risultati],
              open(os.path.join(cache, 'risultati.json'), 'w'), indent=1)
