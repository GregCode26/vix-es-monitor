"""
Studio offline: il regime gamma cambia il modo in cui si muove SPX?

Legge gli snapshot del poller dei volumi (frontend/data/volumes/YYYY-MM-DD.json,
uno ogni ~10 s con gamma, open interest e volumi per strike e il sottostante
`undPrice`) e verifica le due cose che la teoria del dealer hedging promette:

1. Volatilita': con gamma positivo i dealer comprano i ribassi e vendono i
   rialzi, quindi il prezzo dovrebbe muoversi MENO.
2. Inversione/continuazione: con gamma positivo il movimento degli ultimi N
   minuti dovrebbe tendere a rientrare, con gamma negativo a proseguire.

    python execution/studio_gamma.py

Il GEX e' quello della dashboard (app/api/gex/route.ts e lib/zeroGamma.ts):

    GEX strike = gamma * (call - put) * 100 * S^2 * 0.01   [$M per 1%]

con le call positive e le put negative ("dealer lunghi call, corti put": e'
un'ipotesi, non un dato osservato), pesato sull'open interest (posizionamento)
o sul volume del giorno (flusso). Quattro definizioni di regime:

- GEX OI totale: segno della somma su tutti gli strike seguiti.
- spot vs ZG OI: sopra lo Zero Gamma = positivo, come lo disegna /spx-gamma.
- GEX vol totale, spot vs ZG vol: le stesse sul volume.

Limiti da tenere a mente leggendo i numeri:
- solo 0DTE e solo i 37 strike attorno all'ATM che il poller segue: il GEX
  vero comprende tutte le scadenze;
- l'open interest e' quello della chiusura precedente, fermo tutto il giorno;
- ogni finestra si valuta col regime del suo PRIMO minuto (niente sbirciate
  avanti), quindi un cambio di regime a meta' finestra sporca la misura.

Le finestre non si sovrappongono e l'incertezza si stima ricampionando le
GIORNATE (bootstrap): i minuti di uno stesso giorno non sono indipendenti tra
loro, e trattarli come tali darebbe intervalli molto piu' stretti del vero.
"""

import glob
import json
import os

import numpy as np
import pandas as pd

CARTELLA = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'data', 'volumes')
USCITA = os.path.join(os.path.dirname(__file__), '..', '.tmp', 'studio_gamma.md')

INIZIO, FINE = '15:31:00', '21:59:00'   # cash americano, ora italiana
MIN_MINUTI_GIORNO = 60
FINESTRE = [5, 15, 30]                  # minuti: passato e futuro hanno la stessa lunghezza
FASCIA_MIN = 30                         # minuti per normalizzare la volatilita' sull'ora del giorno
N_BOOT = 2000
REGIMI = ['GEX OI totale', 'spot vs ZG OI', 'GEX vol totale', 'spot vs ZG vol']

rng = np.random.default_rng(0)


def zero_gamma(strike, gex):
    """Stessa logica di lib/zeroGamma.ts: prima inversione della somma cumulata, interpolata."""
    cum = np.cumsum(gex)
    for i in range(1, len(cum)):
        a, b = cum[i - 1], cum[i]
        if a != 0 and ((a < 0 <= b) or (a > 0 >= b)):
            salto = b - a
            if salto == 0:
                return strike[i]
            return strike[i - 1] + (strike[i] - strike[i - 1]) * (-a / salto)
    return None


def regime_da_zg(spot, zg, totale):
    # Senza inversione il profilo ha un segno solo: il regime e' quello.
    if zg is None:
        return np.sign(totale)
    return 1.0 if spot > zg else -1.0


def carica_giornata(percorso):
    giorno = os.path.basename(percorso)[:10]
    try:
        snap = json.load(open(percorso, encoding='utf8'))
    except ValueError:
        return None
    righe = []
    for s in snap:
        t = s.get('time', '')
        S = s.get('undPrice')
        if not (INIZIO <= t <= FINE) or not S:
            continue
        v = [x for x in s.get('volumes', []) if x.get('gamma')]
        if len(v) < 2:
            continue
        v.sort(key=lambda x: x['strike'])
        k = np.array([x['strike'] for x in v], float)
        g = np.array([x['gamma'] for x in v], float)
        oi = np.array([(x.get('callsOi') or 0) - (x.get('putsOi') or 0) for x in v], float)
        vol = np.array([(x.get('calls') or 0) - (x.get('puts') or 0) for x in v], float)
        scala = 100 * S * S * 0.01 / 1e6
        gex_oi, gex_vol = g * oi * scala, g * vol * scala
        tot_oi, tot_vol = gex_oi.sum(), gex_vol.sum()
        righe.append({
            'ts': pd.Timestamp(f'{giorno} {t}'), 'S': S,
            'GEX OI totale': np.sign(tot_oi),
            'spot vs ZG OI': regime_da_zg(S, zero_gamma(k, gex_oi), tot_oi),
            'GEX vol totale': np.sign(tot_vol),
            'spot vs ZG vol': regime_da_zg(S, zero_gamma(k, gex_vol), tot_vol),
        })
    if not righe:
        return None
    df = pd.DataFrame(righe).set_index('ts').sort_index()
    df = df[~df.index.duplicated(keep='last')]
    # Griglia al minuto, ultimo valore del minuto; buchi oltre 3 minuti restano vuoti.
    m = df.resample('1min').last()
    m = m.ffill(limit=3)
    return m if m['S'].notna().sum() >= MIN_MINUTI_GIORNO else None


def finestre_giornata(m, n):
    """Blocchi di n minuti non sovrapposti: regime all'inizio, passato e futuro di n minuti."""
    righe = []
    r1 = m['S'].diff()
    for i in range(n, len(m) - n, n):
        t = m.index[i]
        S0, Sp, Sf = m['S'].iloc[i], m['S'].iloc[i - n], m['S'].iloc[i + n]
        fut = r1.iloc[i + 1:i + n + 1]
        if np.isnan([S0, Sp, Sf]).any() or fut.isna().sum() > n // 3:
            continue
        riga = {'ts': t, 'passato': S0 - Sp, 'futuro': Sf - S0,
                'vol': fut.std() * np.sqrt(n),   # deviazione standard dei rendimenti al minuto, scalata sulla finestra
                'fascia': (t.hour * 60 + t.minute) // FASCIA_MIN}
        for r in REGIMI:
            riga[r] = m[r].iloc[i]
        righe.append(riga)
    return pd.DataFrame(righe)


def misure(df):
    """Per un insieme di finestre (gia' filtrate per regime)."""
    if len(df) < 5:
        return dict(n=len(df), vol_rel=np.nan, autocorr=np.nan, continua=np.nan, segue=np.nan)
    mosse = np.sign(df['passato']) * np.sign(df['futuro'])
    mosse = mosse[mosse != 0]
    return dict(
        n=len(df),
        vol_rel=df['vol_rel'].mean(),
        autocorr=np.corrcoef(df['passato'], df['futuro'])[0, 1],
        continua=(mosse > 0).mean() if len(mosse) else np.nan,
        # punti SPX guadagnati seguendo il movimento passato: > 0 momentum, < 0 inversione
        segue=(np.sign(df['passato']) * df['futuro']).mean(),
    )


def bootstrap_diff(df, regime, chiave):
    """Intervallo al 90% di (misura con gamma positivo) - (misura con gamma negativo), ricampionando i giorni."""
    giorni = df['giorno'].unique()
    per_giorno = {g: d for g, d in df.groupby('giorno')}
    diffs = []
    for _ in range(N_BOOT):
        camp = pd.concat([per_giorno[g] for g in rng.choice(giorni, len(giorni))])
        pos, neg = camp[camp[regime] > 0], camp[camp[regime] < 0]
        if len(pos) < 5 or len(neg) < 5:
            continue
        diffs.append(misure(pos)[chiave] - misure(neg)[chiave])
    if not diffs:
        return np.nan, np.nan
    return np.percentile(diffs, 5), np.percentile(diffs, 95)


def main():
    giornate = {}
    for p in sorted(glob.glob(os.path.join(CARTELLA, '2026-*.json'))):
        m = carica_giornata(p)
        if m is not None:
            giornate[os.path.basename(p)[:10]] = m
    print(f'{len(giornate)} giornate: {", ".join(giornate)}\n')

    testo = [f'# Studio regime gamma - {len(giornate)} giornate ({min(giornate)} -> {max(giornate)})', '']

    # Quanto tempo si passa in ciascun regime: un regime che non si vede mai non si puo' valutare.
    quota = pd.DataFrame({g: {r: (m[r] > 0).mean() for r in REGIMI} for g, m in giornate.items()}).T
    testo += ['## Quota di minuti in gamma positivo', '',
              '| regime | media | giorni sempre + | giorni sempre - |', '|---|---|---|---|']
    for r in REGIMI:
        testo.append(f'| {r} | {quota[r].mean():.0%} | {(quota[r] > 0.99).sum()} | {(quota[r] < 0.01).sum()} |')
    testo.append('')
    print('\n'.join(testo[2:]))

    for n in FINESTRE:
        tutte = []
        for g, m in giornate.items():
            f = finestre_giornata(m, n)
            if len(f):
                f['giorno'] = g
                tutte.append(f)
        df = pd.concat(tutte, ignore_index=True)
        # Volatilita' relativa all'ora del giorno: l'apertura e' sempre piu'
        # agitata del primo pomeriggio, a prescindere dal gamma.
        df['vol_rel'] = df['vol'] / df.groupby('fascia')['vol'].transform('mean')

        testo += [f'## Finestre di {n} minuti ({len(df)} finestre)', '',
                  '| regime | lato | finestre | vol relativa | autocorr | continua | punti seguendo |',
                  '|---|---|---|---|---|---|---|']
        sintesi = []
        for r in REGIMI:
            for lato, sel in (('gamma +', df[r] > 0), ('gamma -', df[r] < 0)):
                x = misure(df[sel])
                testo.append(f"| {r} | {lato} | {x['n']} | {x['vol_rel']:.2f} | {x['autocorr']:+.3f} | "
                             f"{x['continua']:.2f} | {x['segue']:+.2f} |")
            v_lo, v_hi = bootstrap_diff(df, r, 'vol_rel')
            a_lo, a_hi = bootstrap_diff(df, r, 'autocorr')
            sintesi.append(f'| {r} | {v_lo:+.2f} .. {v_hi:+.2f} | {a_lo:+.3f} .. {a_hi:+.3f} |')
        testo += ['', 'Differenza (gamma + meno gamma -), intervallo al 90% ricampionando i giorni. '
                  'Se non contiene lo zero, l\'effetto regge.', '',
                  '| regime | vol relativa | autocorr |', '|---|---|---|'] + sintesi + ['']
        print('\n'.join(testo[-(len(REGIMI) * 2 + len(REGIMI) + 9):]))

    os.makedirs(os.path.dirname(USCITA), exist_ok=True)
    with open(USCITA, 'w', encoding='utf8') as f:
        f.write('\n'.join(testo))
    print(f'Tabelle in {os.path.normpath(USCITA)}')


if __name__ == '__main__':
    main()
