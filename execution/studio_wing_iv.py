"""
Studio: la "WING IV CHANGE" di /iv-monitor da' zone di ipercomprato/ipervenduto
su cui comprare o vendere volatilita'?

    python execution/studio_wing_iv.py [--lookback 60] [--dettaglio]

Solo file locali (frontend/data/iv-monitor/YYYY-MM-DD.json), oggi escluso.

Cosa misura la pagina: opzioni SPX 0DTE (non ES), ATM +/- 2 strike; "ala" =
media pesata delle IV IBKR (tick 106) di tutti gli strike tranne il piu' vicino
allo spot, quindi per le put anche quelle ITM. La variazione e' in % sul valore
di `lookback` secondi prima.

1. Qualita' dei dati: snapshot con la finestra di strike centrata sullo spot,
   IV ferme, salti dovuti al ricentramento (cambio degli strike sottoscritti).
2. Zone: soglie dai percentili 2,5/97,5 della variazione calcolati sui giorni
   PRECEDENTI (fuori campione), riarmo dopo 5 minuti.
3. Esiti a 5/15/30 minuti:
   a) l'IV dell'ala rientra? (variazione %, contro la media di tutti i momenti)
   b) straddle ATM 0DTE comprato all'ask e venduto al bid (o il contrario),
      coperto in delta con lo SPX (delta di Black-Scholes all'entrata): e'
      questo che direbbe se si guadagna davvero, costi compresi.
"""

import argparse
import glob
import json
import math
import os
import statistics as st
from bisect import bisect_left
from datetime import date, datetime
from zoneinfo import ZoneInfo

CARTELLA = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data', 'iv-monitor')
NY = ZoneInfo('America/New_York')
ORIZZONTI = (5, 15, 30)
RIARMO_S = 300


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def carica(percorso):
    try:
        with open(percorso, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'  {os.path.basename(percorso)}: illeggibile ({e})')
        return []


def minuti_ny(ts):
    t = datetime.fromtimestamp(ts, NY)
    return t.hour * 60 + t.minute + t.second / 60


def prepara(snap):
    """Righe del cash 9:30-16:00 NY con i campi che servono."""
    righe = []
    for s in snap:
        ts = s.get('timestamp')
        spot = s.get('esPrice')
        if not ts or not spot:
            continue
        m = minuti_ny(ts)
        if not (9 * 60 + 30 <= m < 16 * 60):
            continue
        puts = {o['strike']: o for o in (s.get('putsData') or [])}
        calls = {o['strike']: o for o in (s.get('callsData') or [])}
        strike = sorted(set(puts) & set(calls))
        if not strike:
            continue
        put_ala = s.get('putWingIV') if s.get('putWingIV') is not None else s.get('weightedPutIV')
        call_ala = s.get('callWingIV') if s.get('callWingIV') is not None else s.get('weightedCallIV')
        # Ala solo OTM (put sotto lo spot, call sopra): quella che il nome promette.
        otm_p = [puts[k]['iv'] for k in strike if k < spot - 2.5 and puts[k].get('iv')]
        otm_c = [calls[k]['iv'] for k in strike if k > spot + 2.5 and calls[k].get('iv')]
        righe.append({
            'ts': ts, 'min': m, 'spot': spot, 'strike': tuple(strike), 'puts': puts, 'calls': calls,
            'centrata': strike[0] < spot < strike[-1],
            'putAla': put_ala, 'callAla': call_ala,
            'ala': (put_ala + call_ala) / 2 if put_ala and call_ala else None,
            'otm': (st.mean(otm_p) + st.mean(otm_c)) / 2 if otm_p and otm_c else None,
            'atm': (s['putAtmIV'] + s['callAtmIV']) / 2 if s.get('putAtmIV') and s.get('callAtmIV') else None,
        })
    return righe


def indietro(righe, i, secondi, tolleranza=15):
    """Indice della riga `secondi` prima della i-esima (entro la tolleranza), altrimenti None."""
    obiettivo = righe[i]['ts'] - secondi
    j = bisect_left([r['ts'] for r in righe], obiettivo, 0, i)  # sostituito da tsl sotto per velocita'
    return j


class Giorno:
    def __init__(self, nome, righe):
        self.nome = nome
        self.r = righe
        self.ts = [x['ts'] for x in righe]

    def a(self, ts, tolleranza=15):
        """Riga piu' vicina a ts, se entro la tolleranza."""
        j = bisect_left(self.ts, ts)
        migliori = [k for k in (j - 1, j) if 0 <= k < len(self.ts)]
        if not migliori:
            return None
        k = min(migliori, key=lambda k: abs(self.ts[k] - ts))
        return k if abs(self.ts[k] - ts) <= tolleranza else None


def variazioni(g: Giorno, campo, lookback):
    """(indice, variazione %) dove la riga di prima esiste, ha lo stesso set di strike e il valore."""
    out = []
    for i, x in enumerate(g.r):
        j = g.a(x['ts'] - lookback)
        if j is None or j == i:
            continue
        p = g.r[j]
        if x[campo] and p[campo] and x['strike'] == p['strike']:
            out.append((i, (x[campo] - p[campo]) / p[campo] * 100))
    return out


def straddle(riga, k):
    c, p = riga['calls'].get(k), riga['puts'].get(k)
    if not c or not p or not all(v and v > 0 for v in (c.get('bid'), c.get('ask'), p.get('bid'), p.get('ask'))):
        return None
    return {'bid': c['bid'] + p['bid'], 'ask': c['ask'] + p['ask'], 'ivc': c.get('iv'), 'ivp': p.get('iv')}


def delta_straddle(spot, k, iv, minuti_alla_chiusura):
    t = max(minuti_alla_chiusura, 1) / (365 * 24 * 60)
    if not iv or iv <= 0:
        return 0.0
    d1 = (math.log(spot / k) + 0.5 * iv * iv * t) / (iv * math.sqrt(t))
    return phi(d1) - phi(-d1)  # delta call + delta put = N(d1) + (N(d1) - 1)


def bs_straddle(spot, k, iv, minuti_alla_chiusura):
    t = max(minuti_alla_chiusura, 0.5) / (365 * 24 * 60)
    s = iv * math.sqrt(t)
    d1 = (math.log(spot / k) + 0.5 * s * s) / s
    d2 = d1 - s
    call = spot * phi(d1) - k * phi(d2)
    return call + (call - spot + k)


STIMATE = {'n': 0}


def esito_straddle(g: Giorno, i, minuti, compra: bool):
    """P&L in $ per 1 straddle (x100) coperto in delta, costi bid/ask compresi. None se non misurabile.

    Se all'uscita lo strike non e' piu' fra i 5 sottoscritti (SPX si e' spostato di
    oltre ~12 punti) il prezzo di uscita e' STIMATO con Black-Scholes all'IV di
    entrata, con lo stesso spread relativo dell'entrata: scartarli toglierebbe
    proprio i casi peggiori per chi vende.
    """
    x = g.r[i]
    k = min(x['strike'], key=lambda s: abs(s - x['spot']))
    e = straddle(x, k)
    j = g.a(x['ts'] + minuti * 60)
    if e is None or j is None or j <= i:
        return None
    iv = st.mean([v for v in (e['ivc'], e['ivp']) if v]) if (e['ivc'] or e['ivp']) else None
    u = straddle(g.r[j], k)
    if u is None:
        if not iv:
            return None
        mezzo = (e['ask'] - e['bid']) / (e['ask'] + e['bid'])
        teorico = bs_straddle(g.r[j]['spot'], k, iv, 16 * 60 - g.r[j]['min'])
        u = {'bid': teorico * (1 - mezzo), 'ask': teorico * (1 + mezzo)}
        STIMATE['n'] += 1
    d = delta_straddle(x['spot'], k, iv, 16 * 60 - x['min'])
    ds = g.r[j]['spot'] - x['spot']
    if compra:
        pnl = (u['bid'] - e['ask']) - d * ds
    else:
        pnl = (e['bid'] - u['ask']) + d * ds
    return pnl * 100


def riassunto(valori):
    v = [x for x in valori if x is not None]
    if len(v) < 3:
        return f'n {len(v):4d}'
    m = st.mean(v)
    sd = st.stdev(v)
    t = m / (sd / math.sqrt(len(v))) if sd else 0
    pos = sum(x > 0 for x in v) / len(v) * 100
    return f'n {len(v):4d}  media {m:+8.2f}  mediana {st.median(v):+8.2f}  >0 {pos:4.0f}%  t {t:+5.1f}  min {min(v):+8.1f}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lookback', type=int, default=60, help='secondi della variazione (pagina: 60 di base)')
    ap.add_argument('--dettaglio', action='store_true')
    a = ap.parse_args()

    oggi = date.today().isoformat()
    file = sorted(f for f in glob.glob(os.path.join(CARTELLA, '*.json')) if os.path.basename(f)[:10] < oggi)
    giorni = []
    print('1. QUALITA\' DEI DATI (solo cash 9:30-16:00 NY)')
    for f in file:
        r = prepara(carica(f))
        if len(r) < 500:
            print(f'  {os.path.basename(f)[:10]}: {len(r)} snapshot nel cash, scartato')
            continue
        centr = sum(x['centrata'] for x in r) / len(r) * 100
        ferme = sum(1 for p, q in zip(r, r[1:]) if p['putAla'] == q['putAla']) / max(1, len(r) - 1) * 100
        cambi = sum(1 for p, q in zip(r, r[1:]) if p['strike'] != q['strike'])
        if a.dettaglio:
            print(f'  {os.path.basename(f)[:10]}: {len(r)} snapshot, centrati {centr:3.0f}%, ala put ferma {ferme:3.0f}%, cambi strike {cambi}')
        giorni.append((os.path.basename(f)[:10], Giorno(os.path.basename(f)[:10], r), centr, ferme, cambi))
    print(f'  giorni usabili {len(giorni)}; centrati in media {st.mean(g[2] for g in giorni):.0f}%, '
          f'ala put identica allo snapshot prima {st.mean(g[3] for g in giorni):.0f}% delle volte')
    print(f'  giorni con finestra centrata >= 90%: {sum(g[2] >= 90 for g in giorni)} '
          f'(gli altri sono quelli prima del ricentramento del 25/10)')

    # Solo righe centrate: con gli strike tutti sopra o sotto lo spot "ATM" e "ala" non lo sono.
    for campo, nome in (('ala', 'ALA come la pagina (put+call)/2'), ('otm', 'ALA solo OTM'), ('putAla', 'ALA PUT'), ('callAla', 'ALA CALL')):
        print(f'\n=== {nome}, variazione su {a.lookback}s ===')
        storico = []  # variazioni dei giorni precedenti, per le soglie fuori campione
        eventi = {'alto': [], 'basso': []}
        base = {h: [] for h in ORIZZONTI}
        base_str = {h: {'compra': [], 'vendi': []} for h in ORIZZONTI}
        for nome_g, g, centr, _, _ in giorni:
            var = [(i, v) for i, v in variazioni(g, campo, a.lookback) if g.r[i]['centrata'] and g.r[i]['min'] < 15 * 60 + 30]
            # Base: ogni minuto, esito senza condizioni.
            ultimo = -1e9
            for i, _ in var:
                if g.r[i]['ts'] - ultimo < 60:
                    continue
                ultimo = g.r[i]['ts']
                for h in ORIZZONTI:
                    j = g.a(g.r[i]['ts'] + h * 60)
                    if j is not None and g.r[j][campo] and g.r[j]['strike'] == g.r[i]['strike']:
                        base[h].append((g.r[j][campo] - g.r[i][campo]) / g.r[i][campo] * 100)
                    if campo == 'ala':
                        base_str[h]['compra'].append(esito_straddle(g, i, h, True))
                        base_str[h]['vendi'].append(esito_straddle(g, i, h, False))
            if len(storico) >= 2000:
                s = sorted(storico)
                basso, alto = s[int(len(s) * 0.025)], s[int(len(s) * 0.975)]
                riarmo = {'alto': -1e9, 'basso': -1e9}
                for i, v in var:
                    lato = 'alto' if v >= alto else 'basso' if v <= basso else None
                    if not lato or g.r[i]['ts'] - riarmo[lato] < RIARMO_S:
                        continue
                    riarmo[lato] = g.r[i]['ts']
                    ev = {'giorno': nome_g, 'ora': datetime.fromtimestamp(g.r[i]['ts'], NY).strftime('%H:%M'), 'v': v}
                    for h in ORIZZONTI:
                        j = g.a(g.r[i]['ts'] + h * 60)
                        ok = j is not None and g.r[j][campo] and g.r[j]['strike'] == g.r[i]['strike']
                        ev[h] = (g.r[j][campo] - g.r[i][campo]) / g.r[i][campo] * 100 if ok else None
                        ev[f'spx{h}'] = g.r[j]['spot'] - g.r[i]['spot'] if j is not None else None
                        # Ipercomprato -> vendo vol; ipervenduto -> compro.
                        ev[f's{h}'] = esito_straddle(g, i, h, compra=(lato == 'basso'))
                    eventi[lato].append(ev)
                soglie = f'soglie {basso:+.1f}% / {alto:+.1f}%'
            else:
                soglie = 'soglie non ancora (servono giorni precedenti)'
            storico += [v for _, v in var]
            if a.dettaglio and campo == 'ala':
                print(f'  {nome_g}: {len(var)} variazioni, {soglie}')

        print(f'  base (ogni minuto):')
        for h in ORIZZONTI:
            print(f'    IV a {h:2d} min  {riassunto(base[h])}')
        for lato, nome_l, azione in (('alto', 'IPERCOMPRATO (variazione >= 97,5 pct)', 'VENDO vol'),
                                     ('basso', 'IPERVENDUTO (variazione <= 2,5 pct)', 'COMPRO vol')):
            ev = eventi[lato]
            print(f'  {nome_l}: {len(ev)} segnali in {len({e["giorno"] for e in ev})} giorni -> {azione}')
            for h in ORIZZONTI:
                print(f'    IV a {h:2d} min  {riassunto([e[h] for e in ev])}')
            for h in ORIZZONTI:
                print(f'    SPX a {h:2d} min {riassunto([e[f"spx{h}"] for e in ev])}')
            if campo == 'ala':
                for h in ORIZZONTI:
                    print(f'    straddle coperto, $ a {h:2d} min  {riassunto([e[f"s{h}"] for e in ev])}')
        if campo == 'ala':
            print('  base straddle coperto ($, ogni minuto, costi compresi):')
            for h in ORIZZONTI:
                print(f'    compro a {h:2d} min  {riassunto(base_str[h]["compra"])}')
                print(f'    vendo  a {h:2d} min  {riassunto(base_str[h]["vendi"])}')
            # Distribuzione per giorno dei segnali e del P&L a 15 min.
            per_giorno = {}
            for lato in eventi:
                for e in eventi[lato]:
                    if e['s15'] is not None:
                        per_giorno.setdefault(e['giorno'], []).append(e['s15'])
            pos = sum(sum(v) > 0 for v in per_giorno.values())
            print(f'  giorni con P&L a 15 min positivo: {pos} su {len(per_giorno)}')
            for lato in ('alto', 'basso'):
                pg = {}
                for e in eventi[lato]:
                    if e['s15'] is not None:
                        pg.setdefault(e['giorno'], []).append(e['s15'])
                print(f'  {lato}: giorni positivi a 15 min {sum(sum(v) > 0 for v in pg.values())} su {len(pg)}; '
                      f'segnali con esito a 15 min stimato (strike uscito) inclusi')
            print(f'  uscite stimate con Black-Scholes in tutto: {STIMATE["n"]}')
            # Quanti estremi della PAGINA (nessun filtro sul cambio di strike) sono salti da ricentramento.
            tot = artef = 0
            for _, g, _, _, _ in giorni:
                for i, x in enumerate(g.r):
                    j = g.a(x['ts'] - a.lookback)
                    if j is None or j == i or not x['ala'] or not g.r[j]['ala'] or not x['centrata']:
                        continue
                    v = (x['ala'] - g.r[j]['ala']) / g.r[j]['ala'] * 100
                    if v >= 3.4 or v <= -2.8:
                        tot += 1
                        artef += x['strike'] != g.r[j]['strike']
            print(f'  letture della pagina oltre le soglie: {tot}, di cui dovute a un cambio di strike nel minuto: {artef} ({artef / max(1, tot) * 100:.0f}%)')


if __name__ == '__main__':
    main()
