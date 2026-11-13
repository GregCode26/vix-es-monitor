"""
Studio: il segnale RSI (uscita dalla zona, lib/rsi.ts) vale qualcosa quando ES e' vicino a un livello?

    python execution/studio_rsi_livelli.py [--dettaglio]

Serve il server locale (GEX e 0γ dei giorni passati con ?date=, solo file locali, come studio_conferma_range.py).

- Prezzo: mid Bookmap al secondo, preso ogni 15 s come i punti di /market (Quantower usa lo stesso mid).
- RSI di Wilder su barre da 1 minuto, segnale "immediato" (il punto in cui l'RSI provvisorio esce dalla zona) o a
  barra chiusa: segnali_punti() di studio_rsi_swing.py, uguale a lib/rsi.ts e a CalcolaRsi() dell'indicatore.
- Livelli come CalcolaConferme() in Quantower e studio_conferma_range.py: i sei range OB (dalle 9:35 NY), GEX+/GEX-
  (GEX OI) e lo 0γ del poller, in ES con la base del cash, valore AL SECONDO del segnale (niente livelli futuri).
  "Vicino" = entro 2 punti. Solo 9:35-15:59 NY, quando i livelli esistono.
- Controllo: gli stessi segnali vicino a livelli finti (tutti i livelli spostati di +-7 pt), e quelli lontani da tutto.
- Esito: primo fra target e stop dal prezzo del segnale (4/3 come la conferma, 2/2, 4/4), chiusura dopo 30 min;
  netto di 0,25 pt. Movimento a 5/15/30 min nel verso del segnale.
"""

import argparse
import glob
import math
import os
import statistics as st
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import studio_conferma_range as cr  # noqa: E402
from studio_rsi_swing import segnali_punti  # noqa: E402

VICINO = 2.0
FINTO = 7.0
COSTO = 0.25
USCITE = ((4, 3), (2, 2), (4, 4))
DURATA = 1800
CONFIG = ((5, 10, 90, True), (5, 10, 90, False), (5, 20, 80, True), (5, 25, 75, True), (7, 20, 80, True))


def giorni_disponibili():
    out = []
    for f in sorted(glob.glob(os.path.join(cr.RADICE, 'bookmap', '*.ndjson'))):
        g = os.path.basename(f)[:10]
        if g < cr.OGGI and cr.range_ob(g):
            out.append(g)
    return out


def carica(g):
    s0, mid = cr.mid_al_secondo(g)
    if mid is None:
        return None
    n = len(mid)
    livelli = {nome: ('range', [L] * n) for nome, L in cr.range_ob(g).items()}
    mobili, nota = cr.livelli_mobili(g, s0, n)
    livelli.update(mobili)
    return dict(s0=s0, mid=mid, livelli=livelli, nota=nota)


def esito(mid, s0, k, verso, target, stop):
    ent = mid[k - s0]
    for t in range(k + 1, min(len(mid) + s0, k + DURATA + 1)):
        z = verso * (mid[t - s0] - ent)
        if z >= target:
            return target
        if z <= -stop:
            return -stop
    t = min(len(mid) + s0 - 1, k + DURATA)
    return verso * (mid[t - s0] - ent) if t > k else None


def vicino(d, sec, prezzo, spost):
    """(tipo, nome) del livello piu' vicino entro VICINO pt al secondo `sec`, livelli spostati di `spost`."""
    migliore = None
    for nome, (tipo, serie) in d['livelli'].items():
        L = serie[sec - d['s0']]
        if L is None:
            continue
        dist = abs(prezzo - (L + spost))
        if dist <= VICINO and (migliore is None or dist < migliore[0]):
            migliore = (dist, tipo, nome)
    return migliore[1:] if migliore else None


def riga(nome, ops):
    if not ops:
        return f'    {nome:30} nessuno'
    parti = [f'    {nome:30} n {len(ops):4}']
    for tg, sp in USCITE:
        r = [o[f'{tg}/{sp}'] - COSTO for o in ops if o[f'{tg}/{sp}'] is not None]
        if r:
            se = st.pstdev(r) / math.sqrt(len(r)) if len(r) > 1 else float('nan')
            parti.append(f'{tg}/{sp} {sum(x > 0 for x in r) / len(r):3.0%} {st.mean(r):+.2f} (t {st.mean(r) / se:+.1f})' if se else '')
    for m in (5, 15, 30):
        v = [o[f'm{m}'] for o in ops if o[f'm{m}'] is not None]
        parti.append(f'm{m} {st.mean(v):+.2f}' if v else f'm{m} -')
    return '  '.join(parti)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dettaglio', action='store_true')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    giorni = giorni_disponibili()
    dati = {}
    for g in giorni:
        d = carica(g)
        if d:
            dati[g] = d
            if d['nota']:
                print(f'{g}: {d["nota"]}')
    gg = sorted(dati)
    meta = len(gg) // 2
    print(f'{len(gg)} giornate ({gg[0]} -> {gg[-1]}), prima meta\' fino al {gg[meta - 1]}')

    for n, basso, alto, imm in CONFIG:
        print(f'\n=== 1m RSI {n} {basso}/{alto} {"immediato" if imm else "a chiusura"} ===')
        gruppi = defaultdict(list)
        for g in gg:
            d = dati[g]
            s0, mid = d['s0'], d['mid']
            da = max(s0, cr.locale_da_ny(g, 9, 35))
            fine = min(s0 + len(mid) - 1, cr.locale_da_ny(g, 16, 0) - 60)
            punti = [(s, mid[s - s0]) for s in range(s0 - s0 % 15 + 15, s0 + len(mid), 15)]
            for tm, prezzo, tipo in segnali_punti(punti, 1, n, basso, alto, imm):
                sec = int(round(tm * 60))
                if sec < da or sec > fine:
                    continue
                o = dict(giorno=g, sec=sec, verso=tipo, prezzo=prezzo)
                for tg, sp in USCITE:
                    o[f'{tg}/{sp}'] = esito(mid, s0, sec, tipo, tg, sp)
                for m in (5, 15, 30):
                    t = sec + m * 60
                    o[f'm{m}'] = tipo * (mid[t - s0] - prezzo) if t - s0 < len(mid) else None
                vero = vicino(d, sec, prezzo, 0)
                finto = vicino(d, sec, prezzo, FINTO) or vicino(d, sec, prezzo, -FINTO)
                parte = 'A' if g <= gg[meta - 1] else 'B'
                gruppi[('tutti', parte)].append(o)
                if vero:
                    gruppi[('livello', parte)].append(o)
                    gruppi[(f'livello {vero[0]}', parte)].append(o)
                    if a.dettaglio:
                        h = sec
                        print(f'      {g} {h // 3600:02}:{h % 3600 // 60:02}:{h % 60:02} {"LONG " if tipo > 0 else "SHORT"} '
                              f'{vero[1]:5} {prezzo:.2f}  4/3 {o["4/3"]}')
                elif finto:
                    gruppi[('livello finto +-7', parte)].append(o)
                else:
                    gruppi[('lontano da tutto', parte)].append(o)
        for nome in ('tutti', 'livello', 'livello range', 'livello gex', 'livello zero gamma', 'livello finto +-7', 'lontano da tutto'):
            for parte, etichetta in (('A', '1a meta\''), ('B', '2a meta\'')):
                print(riga(f'{nome} [{etichetta}]', gruppi[(nome, parte)]))


if __name__ == '__main__':
    main()
