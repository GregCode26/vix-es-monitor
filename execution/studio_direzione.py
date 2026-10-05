"""
Studio offline: quali indicatori di Bookmap anticipano la direzione di ES?

Legge i campioni al secondo salvati dalla route /api/bookmap
(frontend/data/bookmap/YYYY-MM-DD.ndjson), calcola per ogni secondo una serie
di indicatori e li confronta con il movimento del mid nei secondi successivi.

    python execution/studio_direzione.py              # tutte le giornate
    python execution/studio_direzione.py 2026-09-30   # solo alcune

Il prezzo e' il mid ((bid+ask)/2), non l'ultimo trade: col last un secondo di
vendite chiude sul bid e uno di acquisti sull'ask, e quel rimbalzo da solo
farebbe sembrare predittivo il CVD (al contrario) senza che il mercato si sia
mosso.

Misure, per indicatore e orizzonte:
- IC: correlazione di rango (Spearman) tra indicatore e rendimento futuro,
  calcolata giornata per giornata. Positivo = l'indicatore alto anticipa salite.
- giorni +/-: in quante giornate l'IC ha lo stesso segno della media. Con
  poche giornate e' la misura che conta di piu': un IC medio che viene da un
  giorno solo non e' un segnale.
- top-bot: rendimento futuro medio (in tick) nel 10% dei secondi con
  l'indicatore piu' alto meno quello nel 10% piu' basso.
- hit: nei due decili estremi, quota dei movimenti non nulli nel verso
  indicato dall'indicatore (0,50 = moneta).
- corr mom: correlazione con il movimento degli ultimi 60 s. Un indicatore
  molto correlato al momentum non aggiunge informazione: dice la stessa cosa.

I secondi si sovrappongono (l'indicatore a 60 s di due secondi vicini e'
quasi uguale), quindi non ci sono p-value: sarebbero gonfiati. Il controllo e'
la coerenza tra giornate.

Stop e assorbimenti non ci sono: l'add-on li registra da troppo poco.
"""

import glob
import json
import os
import sys

import numpy as np
import pandas as pd

TICK = 0.25
ORIZZONTI = [10, 30, 60, 300]   # secondi in avanti
FINESTRE = [10, 30, 60]         # secondi all'indietro per gli indicatori di flusso
BUCO_MAX = 5                    # secondi mancanti oltre i quali la serie si spezza
MIN_SECONDI_GIORNO = 1800       # giornate (o indicatori) con meno dati non si valutano

CARTELLA = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data', 'bookmap')
USCITA = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_direzione.md')


def carica_giornata(percorso):
    righe = []
    with open(percorso, encoding='utf8') as f:
        for l in f:
            try:
                d = json.loads(l)
            except ValueError:
                continue
            ofi = d.get('ofi')
            righe.append({
                't': d['t'], 'bid': d.get('bid'), 'ask': d.get('ask'),
                'buy': d.get('buy') or 0, 'sell': d.get('sell') or 0,
                'bidLiq': d.get('bidLiq'), 'askLiq': d.get('askLiq'),
                'addB': d.get('addB'), 'remB': d.get('remB'),
                'addA': d.get('addA'), 'remA': d.get('remA'),
                'ofi1': ofi[0] if ofi else None,
                'mlofi': float(np.sum(ofi)) if ofi else None,
                'qm': d.get('qm'), 'q1B': d.get('q1B'), 'q1A': d.get('q1A'),
                'cB': d.get('cB'), 'cA': d.get('cA'),
            })
    df = pd.DataFrame(righe)
    if df.empty:
        return df
    giorno = os.path.basename(percorso)[:10]
    df.index = pd.to_datetime(giorno + ' ' + df['t'])
    df = df.drop(columns='t')
    df = df[~df.index.duplicated(keep='last')].sort_index()
    df = df.apply(pd.to_numeric, errors='coerce')
    # Griglia al secondo: i secondi mancanti diventano righe vuote, cosi' le
    # finestre "60 s" sono davvero 60 s e non 60 campioni.
    df = df.reindex(pd.date_range(df.index[0], df.index[-1], freq='s'))
    mid = (df['bid'] + df['ask']) / 2
    mid[(df['ask'] - df['bid']) <= 0] = np.nan  # book incrociato o vuoto
    df['mid'] = mid.ffill(limit=BUCO_MAX)
    for c in ('buy', 'sell'):
        df[c] = df[c].fillna(0)
    return df


def indicatori(df):
    """Una colonna per indicatore; tutte usano solo il passato (niente sbirciate avanti)."""
    f = pd.DataFrame(index=df.index)
    delta = df['buy'] - df['sell']
    # Rimosso al netto dell'eseguito: dal bid sparisce anche cio' che i
    # venditori aggressivi hanno colpito, e quello non e' un ritiro.
    netto_b = df['addB'] - (df['remB'] - df['sell']).clip(lower=0)
    netto_a = df['addA'] - (df['remA'] - df['buy']).clip(lower=0)

    for w in FINESTRE:
        mp = max(1, w // 2)
        mom = (df['mid'] - df['mid'].shift(w)) / TICK
        f[f'momentum {w}s'] = mom
        cvd = delta.rolling(w, min_periods=mp).sum()
        f[f'CVD {w}s'] = cvd
        # Divergenza: aggressioni che spingono piu' di quanto il prezzo si sia
        # mosso. Scale diverse (contratti e tick), quindi in z-score.
        f[f'div CVD-prezzo {w}s'] = _z(cvd) - _z(mom)
        f[f'limit netti B-A {w}s'] = (netto_b - netto_a).rolling(w, min_periods=mp).sum()
        f[f'OFI L1 {w}s'] = df['ofi1'].rolling(w, min_periods=mp).sum()
        # MLOFI normalizzato per la profondita' media, come in Xu-Gould-Howison:
        # 100 contratti su un book sottile pesano piu' che su uno spesso.
        f[f'MLOFI/qm {w}s'] = (df['mlofi'] / df['qm']).rolling(w, min_periods=mp).sum()

    liq = (df['bidLiq'] - df['askLiq']) / (df['bidLiq'] + df['askLiq'])
    f['liq B-A (10 liv.)'] = liq
    f['liq B-A media 30s'] = liq.rolling(30, min_periods=15).mean()
    q1 = (df['q1B'] - df['q1A']) / (df['q1B'] + df['q1A'])
    f['coda best B-A'] = q1
    f['coda best B-A media 5s'] = q1.rolling(5, min_periods=3).mean()
    # Baricentro: un lato che si allontana dal mid si "ritira". cA - cB > 0
    # = gli ask stanno piu' lontani dei bid, cioe' resistenza che si ritira.
    f['baricentro A-B'] = df['cA'] - df['cB']
    return f


def _spearman(a, b):
    # pandas lo farebbe con method='spearman', ma vuole scipy: ranghi + Pearson e' lo stesso.
    return a.rank().corr(b.rank())


def _z(s):
    return (s - s.mean()) / s.std()


def futuri(df):
    return {h: (df['mid'].shift(-h) - df['mid']) / TICK for h in ORIZZONTI}


def valuta(giornate):
    """Ritorna una riga per (indicatore, orizzonte) con le misure descritte sopra."""
    per_giorno = []   # (indicatore, orizzonte, giorno, ic)
    pool = {}         # (indicatore, orizzonte) -> lista di (x, y)
    corr_mom = {}     # indicatore -> lista di correlazioni con momentum 60s
    for giorno, df in giornate.items():
        f = indicatori(df)
        fut = futuri(df)
        for col in f.columns:
            x = f[col]
            if x.notna().sum() < MIN_SECONDI_GIORNO:
                continue
            m = pd.concat([x, f['momentum 60s']], axis=1).dropna()
            if len(m) > MIN_SECONDI_GIORNO:
                corr_mom.setdefault(col, []).append(_spearman(m.iloc[:, 0], m.iloc[:, 1]))
            for h, y in fut.items():
                xy = pd.concat([x, y], axis=1).dropna()
                if len(xy) < MIN_SECONDI_GIORNO:
                    continue
                ic = _spearman(xy.iloc[:, 0], xy.iloc[:, 1])
                per_giorno.append((col, h, giorno, ic))
                # Standardizzato per giornata prima di unirle: CVD e liquidita'
                # cambiano scala da un giorno all'altro, e i decili sul pool
                # finirebbero tutti nella giornata piu' agitata.
                arr = xy.to_numpy().copy()
                arr[:, 0] = (arr[:, 0] - arr[:, 0].mean()) / (arr[:, 0].std() or 1)
                pool.setdefault((col, h), []).append(arr)

    righe = []
    ic_df = pd.DataFrame(per_giorno, columns=['ind', 'h', 'giorno', 'ic'])
    for (col, h), g in ic_df.groupby(['ind', 'h']):
        ic_medio = g['ic'].mean()
        stesso_segno = int((np.sign(g['ic']) == np.sign(ic_medio)).sum())
        xy = np.vstack(pool[(col, h)])
        x, y = xy[:, 0], xy[:, 1]
        alto, basso = np.quantile(x, 0.9), np.quantile(x, 0.1)
        y_alto, y_basso = y[x >= alto], y[x <= basso]
        top_bot = y_alto.mean() - y_basso.mean()
        verso = np.sign(ic_medio) or 1
        mosse = np.concatenate([np.sign(y_alto) * verso, -np.sign(y_basso) * verso])
        mosse = mosse[mosse != 0]
        hit = (mosse > 0).mean() if len(mosse) else np.nan
        righe.append({
            'indicatore': col, 'orizzonte': f'{h}s', 'giorni': len(g),
            'IC medio': ic_medio, 'IC min': g['ic'].min(), 'IC max': g['ic'].max(),
            'giorni stesso segno': f'{stesso_segno}/{len(g)}',
            'top-bot (tick)': top_bot, 'hit estremi': hit,
            'corr mom 60s': np.nanmean(corr_mom.get(col, [np.nan])),
            '_ord': ORIZZONTI.index(h),
        })
    return pd.DataFrame(righe), ic_df


def tabella_md(df):
    cols = [c for c in df.columns if not c.startswith('_')]
    out = ['| ' + ' | '.join(cols) + ' |', '|' + '---|' * len(cols)]
    for _, r in df.iterrows():
        celle = []
        for c in cols:
            v = r[c]
            celle.append(f'{v:+.3f}' if isinstance(v, float) and c != 'hit estremi'
                         else f'{v:.2f}' if c == 'hit estremi' else str(v))
        out.append('| ' + ' | '.join(celle) + ' |')
    return '\n'.join(out)


def main():
    scelti = set(sys.argv[1:])
    giornate = {}
    for p in sorted(glob.glob(os.path.join(CARTELLA, '*.ndjson'))):
        giorno = os.path.basename(p)[:10]
        if scelti and giorno not in scelti:
            continue
        df = carica_giornata(p)
        if df['mid'].notna().sum() < MIN_SECONDI_GIORNO:
            print(f'{giorno}: troppo pochi secondi, saltata')
            continue
        giornate[giorno] = df
        print(f"{giorno}: {df['mid'].notna().sum()} secondi con mid, "
              f"{df.index[0]:%H:%M}-{df.index[-1]:%H:%M}")

    ris, ic_df = valuta(giornate)
    ris = ris.sort_values(['_ord', 'IC medio'], key=lambda s: s.abs() if s.name == 'IC medio' else s,
                          ascending=[True, False])

    testo = [f'# Studio direzione ES — {", ".join(giornate)}', '']
    for h in ORIZZONTI:
        testo += [f'## Orizzonte {h}s', '', tabella_md(ris[ris['orizzonte'] == f'{h}s']), '']
    testo += ['## IC per giornata', '',
              tabella_md(ic_df.pivot_table(index=['ind', 'h'], columns='giorno', values='ic').reset_index())]
    os.makedirs(os.path.dirname(USCITA), exist_ok=True)
    with open(USCITA, 'w', encoding='utf8') as f:
        f.write('\n'.join(testo))

    pd.set_option('display.width', 220)
    pd.set_option('display.max_rows', 200)
    print()
    print(ris.drop(columns='_ord').to_string(index=False, float_format=lambda v: f'{v:+.3f}'))
    print(f'\nTabelle complete in {os.path.normpath(USCITA)}')


if __name__ == '__main__':
    main()
