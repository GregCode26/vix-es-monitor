"""
Studio offline: gli assorbimenti dell'add-on Bookmap valgono qualcosa?

    python execution/studio_assorbimenti.py

Un assorbimento (vedi bookmap_addon.py) e': in una finestra di 5 s almeno
max(30, 2 x coda iniziale) contratti aggressivi su un solo prezzo, e il
livello passivo ancora al migliore 1 s dopo l'ultimo trade. Verso +1 =
compratori passivi sul bid che assorbono le vendite (ci si aspetta che il
prezzo regga e salga), -1 il contrario sull'ask.

Tre domande, ciascuna con il suo termine di paragone:

1. Il livello regge? "Rotto" = il mid passa oltre il prezzo di piu' di un
   tick (il livello e' stato attraversato tutto) entro l'orizzonte. Da solo
   il numero non dice niente: anche un miglior bid qualsiasi regge spesso a
   un minuto. Si confronta con lo stesso conto fatto su un miglior bid/ask
   preso a caso (ogni BASE_PASSO_SEC secondi della stessa giornata).
2. Il prezzo va nel verso di chi assorbe? Movimento del mid a 1/5/15 minuti
   nel verso dell'assorbimento, lordo e al netto di COSTO_TICK, e la quota
   di movimenti nel verso giusto contro il 50% (binomiale). Piu' MFE/MAE a
   5 minuti: quanto va a favore e quanto contro, al massimo.
3. Conta la dimensione? Le stesse misure per fasce di contratti, che e' il
   filtro che la pagina e Quantower fanno scegliere.

Regole per non ingannarsi (le stesse di studio_confluenze.py):
- si misura da RITARDO_ABS_SEC dopo l'orario dell'assorbimento: l'add-on lo
  data all'ultimo trade ma lo emette solo dopo 1 s di livello che regge;
- gli assorbimenti arrivano a grappoli (lo stesso livello difeso per piu'
  finestre da 5 s, o tre prezzi vicini nello stesso secondo): contarli uno
  per uno gonfia le prove. Si riportano sia grezzi sia raggruppati, un
  grappolo = stesso verso, entro GRAPPOLO_SEC e GRAPPOLO_TICK dal primo,
  rappresentato dal primo evento con il volume totale;
- con poche giornate e' solo descrittivo: i p valgono come ordine di grandezza.

La tenuta (passo 3 dell'add-on, ASS_TENUTA_SEC = 1 s) si prova anche piu'
lunga, da 1 a TENUTA_MAX secondi, simulandola sui dati al secondo: un
assorbimento con tenuta N vale solo se il livello resta al migliore (bid >=
prezzo per il verso +1, ask <= prezzo per il -1) in ogni secondo da quello
dell'ultimo trade a N secondi dopo. E' un filtro sugli eventi che l'add-on
ha gia' passato con 1 s, e non vede quello che succede dentro il secondo.
Si entra quando la palla sarebbe comparsa: N + 1 secondi dopo l'ultimo trade.
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
USCITA = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_assorbimenti.md')

ORIZZONTI = [60, 300, 900]
RITARDO_ABS_SEC = 2
COSTO_TICK = 1.0
GRAPPOLO_SEC = 60
GRAPPOLO_TICK = 4
BASE_PASSO_SEC = 10
FASCE = [(30, 60), (60, 100), (100, 200), (200, 10 ** 9)]
MFE_SEC = 300
TENUTA_MAX = 10


def binomiale(vinti, n):
    """p a due code contro il 50%; approssimazione normale sopra i 300 casi."""
    if n == 0:
        return float('nan')
    if n > 300:
        z = (vinti - n / 2) / math.sqrt(n / 4)
        return math.erfc(abs(z) / math.sqrt(2))
    return min(1.0, sum(math.comb(n, k) for k in range(n + 1) if abs(k - n / 2) >= abs(vinti - n / 2)) / 2 ** n)


def leggi_assorbimenti(percorso, giorno):
    righe = []
    for l in open(percorso, encoding='utf8'):
        try:
            d = json.loads(l)
        except ValueError:
            continue
        for e in d.get('abs') or []:
            if len(e) == 4:
                righe.append({'ts': pd.Timestamp(f'{giorno} {e[3]}'), 'prezzo': e[0], 'ct': e[1], 'verso': e[2]})
    a = pd.DataFrame(righe)
    return a.sort_values('ts').reset_index(drop=True) if not a.empty else a


def raggruppa(a):
    """Un evento per grappolo: il primo, con il volume del grappolo intero."""
    out = []
    aperti = {1: None, -1: None}
    for r in a.itertuples():
        g = aperti[r.verso]
        if g is not None and (r.ts - g['ts']).total_seconds() <= GRAPPOLO_SEC and abs(r.prezzo - g['prezzo']) <= GRAPPOLO_TICK * TICK:
            g['ct'] += r.ct
            g['n'] += 1
            continue
        g = {'ts': r.ts, 'prezzo': r.prezzo, 'ct': r.ct, 'verso': r.verso, 'n': 1}
        aperti[r.verso] = g
        out.append(g)
    return pd.DataFrame(out)


def tiene(df, ts, prezzo, verso, n):
    """Il livello e' rimasto al migliore in ogni secondo da ts a ts + n? I secondi mancanti non contano."""
    if ts not in df.index:
        return False
    i = df.index.get_loc(ts)
    lato = df['bid'].values if verso > 0 else df['ask'].values
    tratto = lato[i:i + n + 1]
    tratto = tratto[~np.isnan(tratto)]
    if len(tratto) == 0:
        return False
    return bool(np.all(tratto >= prezzo)) if verso > 0 else bool(np.all(tratto <= prezzo))


def misura(df, ts, prezzo, verso, ritardo=RITARDO_ABS_SEC):
    """Esiti di un livello difeso a `prezzo` nel verso `verso`, entrando a ts + ritardo."""
    if ts not in df.index:
        return None
    i = df.index.get_loc(ts) + ritardo
    mid = df['mid'].values
    if i >= len(mid) or np.isnan(mid[i]):
        return None
    r = {}
    for h in ORIZZONTI:
        if i + h >= len(mid):
            continue
        tratto = mid[i:i + h + 1]
        tratto = tratto[~np.isnan(tratto)]
        # Rotto: il mid oltre il livello di piu' di un tick, contro chi assorbe.
        r[f'rotto{h}'] = bool(np.any(verso * (tratto - prezzo) < -TICK))
        if not np.isnan(mid[i + h]):
            r[f'mossa{h}'] = verso * (mid[i + h] - mid[i]) / TICK
    if i + MFE_SEC < len(mid):
        tratto = verso * (mid[i:i + MFE_SEC + 1] - mid[i]) / TICK
        tratto = tratto[~np.isnan(tratto)]
        if len(tratto):
            r['mfe'] = float(tratto.max())
            r['mae'] = float(-tratto.min())
    return r


def base_casuale(df, tenuta=None):
    """
    Lo stesso conto 'regge?' su un miglior bid (verso +1) e ask (-1) ogni
    BASE_PASSO_SEC secondi. Con `tenuta` solo i livelli rimasti al migliore
    per quei secondi, misurati da tenuta + 1: un livello che ha gia' retto N
    secondi regge di piu' anche senza assorbimento, e il confronto va fatto
    alla pari.
    """
    righe = []
    for ts in df.index[::BASE_PASSO_SEC]:
        b, a = df.at[ts, 'bid'], df.at[ts, 'ask']
        if np.isnan(b) or np.isnan(a) or a <= b:
            continue
        for verso, prezzo in ((1, b), (-1, a)):
            if tenuta is not None and not tiene(df, ts, prezzo, verso, tenuta):
                continue
            m = misura(df, ts, prezzo, verso, ritardo=RITARDO_ABS_SEC if tenuta is None else tenuta + 1)
            if m:
                righe.append(m)
    return pd.DataFrame(righe)


def riassunto(esiti, base, titolo):
    righe = []
    n = len(esiti)
    righe.append(f'### {titolo} — {n} eventi\n')
    if n == 0:
        return righe
    righe.append('| orizzonte | rotto (assorb.) | rotto (livello a caso) | verso giusto | p | lordo medio | netto medio | mediana |')
    righe.append('|---|---|---|---|---|---|---|---|')
    for h in ORIZZONTI:
        if f'rotto{h}' not in esiti:
            continue
        rotto = esiti[f'rotto{h}'].dropna()
        rb = base[f'rotto{h}'].dropna() if f'rotto{h}' in base else pd.Series(dtype=float)
        x = esiti[f'mossa{h}'].dropna() if f'mossa{h}' in esiti else pd.Series(dtype=float)
        mossi = x[x != 0]
        v = int((mossi > 0).sum())
        righe.append(
            f'| {h // 60} min | {100 * rotto.mean():.0f}% | {100 * rb.mean():.0f}% | '
            f'{100 * v / max(1, len(mossi)):.0f}% ({v}/{len(mossi)}) | {binomiale(v, len(mossi)):.3f} | '
            f'{x.mean():+.2f} | {x.mean() - COSTO_TICK:+.2f} | {x.median():+.2f} |'
        )
    if 'mfe' in esiti:
        righe.append(f'\nA 5 minuti: a favore al massimo {esiti["mfe"].mean():.1f} tick in media '
                     f'(mediana {esiti["mfe"].median():.1f}), contro {esiti["mae"].mean():.1f} '
                     f'(mediana {esiti["mae"].median():.1f}).')
    righe.append('')
    return righe


def per_tenuta(giornate, base):
    """Una riga per tenuta da 1 a TENUTA_MAX secondi, sui grappoli degli eventi che la superano."""
    testo = ['## Tenuta da 1 a 10 secondi (grappoli)\n',
             'Eventi = grappoli che superano la tenuta. Ingresso a tenuta + 1 s. "Rotto a caso" = un miglior '
             'bid/ask qualsiasi che ha retto gli stessi secondi, misurato allo stesso modo.\n',
             '| tenuta | grappoli | bid / ask | rotto 5 min | rotto a caso | verso giusto 1 min | 5 min | p 5 min | 15 min | lordo 5 min | lordo 15 min | netto 15 min |',
             '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for n in range(1, TENUTA_MAX + 1):
        esiti = []
        for g, df, a in giornate:
            ok = a[[tiene(df, r.ts, r.prezzo, r.verso, n) for r in a.itertuples()]]
            if ok.empty:
                continue
            for r in raggruppa(ok).itertuples():
                m = misura(df, r.ts, r.prezzo, r.verso, ritardo=n + 1)
                if m:
                    m.update({'verso': r.verso})
                    esiti.append(m)
        e = pd.DataFrame(esiti)
        if e.empty:
            continue
        rb = pd.concat([base_casuale(df, n) for _, df, _ in giornate], ignore_index=True)['rotto300'].mean()
        celle = []
        for h in ORIZZONTI:
            x = e[f'mossa{h}'].dropna()
            mossi = x[x != 0]
            v = int((mossi > 0).sum())
            celle.append((x, v, len(mossi)))
        (x1, v1, n1), (x5, v5, n5), (x15, v15, n15) = celle
        testo.append(
            f'| {n} s | {len(e)} | {(e.verso > 0).sum()} / {(e.verso < 0).sum()} | {100 * e["rotto300"].mean():.0f}% | {100 * rb:.0f}% | '
            f'{100 * v1 / max(1, n1):.0f}% | {100 * v5 / max(1, n5):.0f}% | {binomiale(v5, n5):.2f} | {100 * v15 / max(1, n15):.0f}% | '
            f'{x5.mean():+.2f} | {x15.mean():+.2f} | {x15.mean() - COSTO_TICK:+.2f} |'
        )
    testo.append('')
    return testo


def main():
    giornate = []
    for p in sorted(glob.glob(os.path.join(CARTELLA_BM, '*.ndjson'))):
        g = os.path.basename(p)[:10]
        a = leggi_assorbimenti(p, g)
        if a.empty:
            continue
        giornate.append((g, carica_giornata(p), a))
    if not giornate:
        print('Nessuna giornata con assorbimenti.')
        return

    testo = [f"# Studio assorbimenti — {', '.join(g for g, _, _ in giornate)}\n"]
    testo.append(f'Esiti dal secondo +{RITARDO_ABS_SEC} dopo l\'assorbimento, in tick nel verso di chi assorbe; '
                 f'costo {COSTO_TICK} tick. "Rotto" = mid oltre il livello di piu\' di un tick entro l\'orizzonte.\n')

    grezzi, gruppi, basi = [], [], []
    for g, df, a in giornate:
        gr = raggruppa(a)
        testo.append(f'- {g}: {len(a)} assorbimenti ({(a.verso > 0).sum()} sul bid, {(a.verso < 0).sum()} sull\'ask), '
                     f'{len(gr)} grappoli; contratti mediana {a.ct.median():.0f}, 90° pct {a.ct.quantile(0.9):.0f}, max {a.ct.max():.0f}; '
                     f'dalle {a.ts.min():%H:%M} alle {a.ts.max():%H:%M}')
        for nome, eventi, dest in (('grezzi', a, grezzi), ('grappoli', gr, gruppi)):
            for r in eventi.itertuples():
                m = misura(df, r.ts, r.prezzo, r.verso)
                if m:
                    m.update({'giorno': g, 'ct': r.ct, 'verso': r.verso})
                    dest.append(m)
        b = base_casuale(df)
        b['giorno'] = g
        basi.append(b)
    testo.append('')

    grezzi, gruppi, base = pd.DataFrame(grezzi), pd.DataFrame(gruppi), pd.concat(basi, ignore_index=True)
    testo += riassunto(grezzi, base, 'Tutti, uno per uno')
    testo += riassunto(gruppi, base, 'Raggruppati (un evento per grappolo)')
    for lato, nome in ((1, 'sul bid (compratori assorbono)'), (-1, "sull'ask (venditori assorbono)")):
        testo += riassunto(gruppi[gruppi.verso == lato], base, f'Grappoli {nome}')
    for da, a in FASCE:
        etichetta = f'{da}+' if a > 10 ** 8 else f'{da}-{a - 1}'
        testo += riassunto(gruppi[(gruppi.ct >= da) & (gruppi.ct < a)], base, f'Grappoli da {etichetta} contratti')
    for g, _, _ in giornate:
        testo += riassunto(gruppi[gruppi.giorno == g], base[base.giorno == g], f'Grappoli del {g}')

    testo += per_tenuta(giornate, base)

    uscita = '\n'.join(testo)
    print(uscita)
    os.makedirs(os.path.dirname(USCITA), exist_ok=True)
    with open(USCITA, 'w', encoding='utf8') as f:
        f.write(uscita)
    print(f'\nScritto in {os.path.normpath(USCITA)}')


if __name__ == '__main__':
    main()
