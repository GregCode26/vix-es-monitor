"""
Studio offline: confluenze dei dati Bookmap che si ripetono, come setup operativi.

Lo studio_direzione.py guardava un indicatore alla volta, ogni secondo. Qui
si cercano MOMENTI: istanti in cui piu' segnali si allineano, come li si
leggerebbe sulla pagina /bookmap, e da ciascuno si misura cosa fa ES dopo 1,
5 e 15 minuti, come se si entrasse a mercato in quell'istante.

    python execution/studio_confluenze.py

Regole per non ingannarsi:
- "estremo" = oltre il 90esimo (o sotto il 10mo) percentile dell'ULTIMA ORA,
  non della giornata: alle 15:00 non si sa ancora com'e' fatta la sera;
- dopo un evento lo stesso setup tace per PAUSA_SEC, cosi' gli eventi non si
  sovrappongono e si possono contare come prove separate;
- l'esito e' in tick nel verso del setup, al netto di COSTO_TICK (spread e
  commissioni di un'andata e ritorno);
- la direzione si giudica sul movimento LORDO (senza costo, esclusi i
  movimenti nulli): a 1 minuto ES si muove spesso meno di un tick, e contando
  il costo quasi ogni trade "perderebbe" anche con un segnale buono;
  la convenienza invece sul NETTO;
- p e' il test binomiale sui movimenti lordi nel verso giusto contro il 50%. Con tanti setup e tre
  orizzonti qualcosa esce "significativo" per caso: la soglia corretta e'
  0,05 / numero di prove (Bonferroni), e la riga lo dice.

Il cono (frontend/data/market/cono-YYYY-MM-DD.json) e' il movimento atteso
di ES fino alla chiusura, fissato alle 15:35 dall'IV ATM: il suo centro e' ES
a quell'ora. "Tirato" = oltre meta' semiampiezza dal centro.
"""

import glob
import json
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from studio_direzione import TICK, carica_giornata  # noqa: E402

CARTELLA_BM = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data', 'bookmap')
CARTELLA_MKT = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data', 'market')
USCITA = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_confluenze.md')

ORIZZONTI = [60, 300, 900]
FINESTRA_PCT = 3600      # percentili sull'ultima ora
MIN_STORIA = 1800        # prima di mezz'ora di dati un percentile non vuol dire niente
PAUSA_SEC = 300
COSTO_TICK = 1.0
# Secondi fra l'orario di un assorbimento e quando l'add-on lo ha mandato.
RITARDO_ABS_SEC = 2


def quantili_mobili(s, q):
    return s.rolling(FINESTRA_PCT, min_periods=MIN_STORIA).quantile(q)


def cono(giorno):
    p = os.path.join(CARTELLA_MKT, f'cono-{giorno}.json')
    if not os.path.exists(p):
        return None
    c = json.load(open(p, encoding='utf8'))
    return {'centro': (c['up'] + c['down']) / 2, 'semi': (c['up'] - c['down']) / 2, 'da': c['time']}


def segnali(df, giorno):
    """Colonne booleane, una per condizione elementare; tutte usano solo il passato."""
    s = pd.DataFrame(index=df.index)
    mid = df['mid']
    delta = df['buy'] - df['sell']
    cvd60 = delta.rolling(60, min_periods=30).sum()
    mom60 = (mid - mid.shift(60)) / TICK
    liq = ((df['bidLiq'] - df['askLiq']) / (df['bidLiq'] + df['askLiq'])).rolling(30, min_periods=15).mean()

    s['cvd_alto'] = cvd60 > quantili_mobili(cvd60, 0.9)
    s['cvd_basso'] = cvd60 < quantili_mobili(cvd60, 0.1)
    s['mom_alto'] = mom60 > quantili_mobili(mom60, 0.9)
    s['mom_basso'] = mom60 < quantili_mobili(mom60, 0.1)
    s['liq_bid'] = liq > quantili_mobili(liq, 0.9)      # molto piu' liquidita' sotto
    s['liq_ask'] = liq < quantili_mobili(liq, 0.1)      # molto piu' liquidita' sopra

    # Nuovo massimo/minimo dei 15 minuti, con il CVD dell'ultimo minuto che
    # non conferma (vendite nette sul massimo, acquisti netti sul minimo).
    max15 = mid.rolling(900, min_periods=600).max().shift(1)
    min15 = mid.rolling(900, min_periods=600).min().shift(1)
    s['max_nuovo'] = mid > max15
    s['min_nuovo'] = mid < min15
    s['cvd_neg'] = cvd60 < 0
    s['cvd_pos'] = cvd60 > 0

    c = cono(giorno)
    if c:
        dopo = df.index >= pd.Timestamp(f"{giorno} {c['da']}")
        s['tirato_su'] = dopo & (mid > c['centro'] + 0.5 * c['semi'])
        s['tirato_giu'] = dopo & (mid < c['centro'] - 0.5 * c['semi'])
    else:
        s['tirato_su'] = False
        s['tirato_giu'] = False
    return s.fillna(False).astype(bool)


# (nome, condizioni del lato corto, condizioni del lato lungo, verso: -1 = contro il movimento)
# Ogni setup e' simmetrico: le condizioni "corte" danno un trade short, le
# speculari un trade long. La tesi e' scritta nel nome.
SETUP = [
    ('Flusso estremo -> inversione', ['cvd_alto', 'mom_alto'], ['cvd_basso', 'mom_basso']),
    ('Flusso estremo contro la liquidita\' -> inversione', ['cvd_alto', 'mom_alto', 'liq_ask'], ['cvd_basso', 'mom_basso', 'liq_bid']),
    ('Divergenza CVD sul nuovo estremo 15 min -> inversione', ['max_nuovo', 'cvd_neg'], ['min_nuovo', 'cvd_pos']),
    ('Prezzo tirato sul cono + flusso estremo -> inversione', ['tirato_su', 'cvd_alto'], ['tirato_giu', 'cvd_basso']),
    ('Liquidita\' sbilanciata (da sola) -> segue la liquidita\'', ['liq_ask'], ['liq_bid']),
    ('Nuovo estremo 15 min confermato dal CVD -> continuazione', ['min_nuovo', 'cvd_neg'], ['max_nuovo', 'cvd_pos']),
]


def eventi(sg, condizioni):
    """Istanti in cui tutte le condizioni sono vere, con una pausa dopo ciascuno."""
    attivo = sg[condizioni].all(axis=1).to_numpy()
    idx = sg.index
    out, ultimo = [], None
    for i in np.flatnonzero(attivo):
        t = idx[i]
        if ultimo is None or (t - ultimo).total_seconds() >= PAUSA_SEC:
            out.append(t)
            ultimo = t
    return out


def binomiale(vinti, n):
    """p a due code del test binomiale contro 0,5 (approssimazione normale sopra 30)."""
    if n == 0:
        return float('nan')
    if n > 30:
        z = (vinti - n / 2) / math.sqrt(n / 4)
        return math.erfc(abs(z) / math.sqrt(2))
    coda = sum(math.comb(n, k) for k in range(0, n + 1) if abs(k - n / 2) >= abs(vinti - n / 2)) / 2 ** n
    return min(1.0, coda)


def main():
    giornate = {}
    for p in sorted(glob.glob(os.path.join(CARTELLA_BM, '*.ndjson'))):
        g = os.path.basename(p)[:10]
        df = carica_giornata(p)
        if df['mid'].notna().sum() >= 3600:
            giornate[g] = df
    righe, dettagli = [], []
    for nome, corto, lungo in SETUP:
        per_h = {h: [] for h in ORIZZONTI}
        per_giorno = {}
        for g, df in giornate.items():
            sg = segnali(df, g)
            mid = df['mid']
            for verso, cond in ((-1, corto), (1, lungo)):
                for t in eventi(sg, cond):
                    i = df.index.get_loc(t)
                    for h in ORIZZONTI:
                        if i + h < len(mid) and not np.isnan(mid.iloc[i + h]):
                            lordo = verso * (mid.iloc[i + h] - mid.iloc[i]) / TICK
                            per_h[h].append(lordo)
                            if h == 300:
                                per_giorno.setdefault(g, []).append(lordo)
                                dettagli.append((nome, g, t.strftime('%H:%M:%S'), verso, round(lordo, 2)))
        for h in ORIZZONTI:
            x = np.array(per_h[h])
            mossi = x[x != 0]
            vinti = int((mossi > 0).sum())
            righe.append({
                'setup': nome, 'orizzonte': f'{h // 60} min', 'trade': len(x),
                'verso giusto %': 100 * vinti / len(mossi) if len(mossi) else float('nan'),
                'lordo (tick)': x.mean() if len(x) else float('nan'),
                'netto (tick)': x.mean() - COSTO_TICK if len(x) else float('nan'),
                'p': binomiale(vinti, len(mossi)),
                'giorni positivi (5 min)': (f"{sum(np.mean(v) > 0 for v in per_giorno.values())}/{len(per_giorno)}" if h == 300 else ''),
            })
    ris = pd.DataFrame(righe)
    soglia = 0.05 / len(ris)

    pd.set_option('display.width', 220)
    pd.set_option('display.max_colwidth', 60)
    print(f"Giornate: {', '.join(giornate)} · costo {COSTO_TICK} tick a trade · soglia Bonferroni p < {soglia:.4f}\n")
    print(ris.to_string(index=False, float_format=lambda v: f'{v:.3f}' if v < 0.01 and v > 0 else f'{v:.2f}'))

    # Assorbimenti: solo dove l'add-on li registra (dal 05/10/2026), quindi
    # solo descrittivo; con la stessa pausa degli altri setup, per lato.
    righe_abs = []
    for g, df in giornate.items():
        p = os.path.join(CARTELLA_BM, f'{g}.ndjson')
        ultimo = {1: None, -1: None}
        for l in open(p, encoding='utf8'):
            d = json.loads(l)
            for prezzo, ct, verso, t in d.get('abs') or []:
                ts = pd.Timestamp(f'{g} {t}')
                if ct < 100 or ts not in df.index:
                    continue
                if ultimo[verso] is not None and (ts - ultimo[verso]).total_seconds() < PAUSA_SEC:
                    continue
                ultimo[verso] = ts
                # L'add-on data l'assorbimento all'ultimo trade ma lo emette solo
                # dopo ASS_TENUTA_SEC (1 s) di livello che regge: misurare da li'
                # regalerebbe il primo secondo. Si entra quando era visibile.
                i = df.index.get_loc(ts) + RITARDO_ABS_SEC
                for h in ORIZZONTI:
                    if i + h < len(df) and not np.isnan(df['mid'].iloc[i + h]) and not np.isnan(df['mid'].iloc[i]):
                        righe_abs.append((h, verso * (df['mid'].iloc[i + h] - df['mid'].iloc[i]) / TICK))
    if righe_abs:
        a = pd.DataFrame(righe_abs, columns=['h', 'lordo'])
        print('\nAssorbimenti >= 100 contratti, nel verso di chi assorbe (una sola giornata: solo descrittivo):')
        for h, x in a.groupby('h')['lordo']:
            mossi = x[x != 0]
            v = int((mossi > 0).sum())
            print(f"  {h // 60} min: {len(x)} eventi, verso giusto {100 * v / max(1, len(mossi)):.0f}%, "
                  f"lordo {x.mean():+.2f} tick, netto {x.mean() - COSTO_TICK:+.2f}, p {binomiale(v, len(mossi)):.2f}")

    os.makedirs(os.path.dirname(USCITA), exist_ok=True)
    with open(USCITA, 'w', encoding='utf8') as f:
        f.write(f"# Confluenze Bookmap — {', '.join(giornate)}\n\n")
        try:
            f.write(ris.to_markdown(index=False, floatfmt='.3f'))
        except ImportError:  # to_markdown vuole il pacchetto tabulate
            f.write('```\n' + ris.to_string(index=False) + '\n```')
        f.write('\n\n## Eventi (esito lordo a 5 min, tick)\n\n')
        for d in dettagli:
            f.write(f'- {d[0]} · {d[1]} {d[2]} · {"long" if d[3] > 0 else "short"} · {d[4]:+}\n')
    print(f'\nDettagli in {os.path.normpath(USCITA)}')


if __name__ == '__main__':
    main()
