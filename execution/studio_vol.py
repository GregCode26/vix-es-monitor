"""Studio sulla volatilita' (03/11/2026): la struttura della vol prevede la giornata?

Domande, tutte su dati giornalieri IBKR (SPX e indici di vol CBOE):
- il VIX della sera prima prezza bene il range del giorno dopo, o lo
  sovrastima sempre (premio implicita/realizzata)?
- la pendenza della term structure (VIX9D/VIX, VIX/VIX3M, VIX1D/VIX), il VVIX,
  lo SKEW e il VRP (VIX - vol realizzata a 20 giorni) dicono se il giorno dopo
  sara' piu' ampio o piu' direzionale di quanto prezzato? E in che direzione?
Tutto in unita' di "movimento prezzato": sigma = SPX * VIX / 100 / sqrt(252)
della chiusura prima, quindi senza guardare avanti.

Risultati del 03/11 (SPX 2007-2026, 4988 giorni; 2022+ = 1213):
- il VIX sovrastima il giorno: range medio 0.94 sigma (moto browniano 1.6),
  |C-C| > 1 sigma nel 19% dei giorni (atteso 32%). Anche il VIX1D: 1.11 e 26%;
- la term structure prevede l'AMPIEZZA, non la direzione: VIX9D/VIX rho +0.34
  col range (2022+), VIX1D/VIX +0.42, VIX/VIX3M +0.30; quintile alto vs basso
  1.14 vs 0.80 sigma. Ma misurato in unita' di VIX1D l'effetto sparisce
  (VIX9D/VIX +0.05, VIX1D/VIX -0.06): dice solo "usa la vol piu' corta";
- SKEW alto = giornate piu' piccole (rho -0.27 nel 2022+); VRP e VVIX ~nulla;
- direzione (O-C): nessun predittore oltre |rho| 0.09. Il gap d'apertura ha
  +0.11 (2022+) ma l'open degli indici IBKR puo' essere una stampa vecchia:
  non fidarsi senza ricontrollarlo su ES.

Scarico: ogni richiesta storica passa da Ritmo, che rispetta i limiti IBKR
(max 60 richieste in 10 minuti -> qui 50; niente richieste identiche entro 15 s;
niente 6 richieste sullo stesso contratto in 2 s -> qui almeno 3 s fra due
richieste qualsiasi). Prima di connettersi stampa il piano: quante richieste,
quante gia' in cache, il tempo stimato. Ogni pezzo scaricato resta in
.tmp/studio_vol/ e non viene richiesto di nuovo (solo l'ultimo, che finisce
oggi, si riscarica se e' di un giorno precedente). Su una violazione di ritmo
(errore 162/366 "pacing") aspetta 10 minuti e riprova una volta.

Uso:
  python execution/studio_vol.py --piano     # solo il piano delle richieste, niente connessione
  python execution/studio_vol.py --scarica   # scarica cio' che manca
  python execution/studio_vol.py             # analisi sui file in cache -> .tmp/studio_vol.md
  python execution/studio_vol.py --calibra   # -> frontend/src/lib/volCalibrazioneGiorno.ts (contesto di /api/vol)
"""
import collections, json, math, os, random, sys, time
from datetime import date, datetime

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_vol')
REPORT = os.path.join(RADICE, '.tmp', 'studio_vol.md')

SIMBOLI = ['SPX', 'VIX', 'VIX9D', 'VIX3M', 'VVIX', 'SKEW', 'VIX1D']
# Pezzi da 5 anni: 'ultimo' finisce adesso, gli altri a fine anno fisso, cosi'
# i nomi in cache restano stabili da un giorno all'altro.
PEZZI = [('ultimo', ''), ('2021', '20211231-23:59:59'),
         ('2016', '20161231-23:59:59'), ('2011', '20111231-23:59:59')]
DURATA = '5 Y'

MAX_FINESTRA = 50        # richieste per finestra (IBKR: 60)
FINESTRA = 600           # secondi
GAP_MIN = 3.0            # secondi fra due richieste qualsiasi
ATTESA_PACING = 610
STIMA_RISPOSTA = 4.0     # secondi medi per una risposta da 5 anni giornalieri


class Ritmo:
    """Limitatore delle richieste storiche: finestra mobile + distanza minima."""
    def __init__(self):
        self.storia = collections.deque()
        self.fatte = 0

    def aspetta(self):
        adesso = time.time()
        while self.storia and adesso - self.storia[0] > FINESTRA:
            self.storia.popleft()
        attesa = 0.0
        if self.storia:
            attesa = max(attesa, GAP_MIN - (adesso - self.storia[-1]))
        if len(self.storia) >= MAX_FINESTRA:
            attesa = max(attesa, FINESTRA - (adesso - self.storia[0]) + 1)
        if attesa > 0:
            if attesa > 10:
                print(f'  ritmo: {len(self.storia)} richieste negli ultimi 10 min, attendo {attesa:.0f} s')
            time.sleep(attesa)
        self.storia.append(time.time())
        self.fatte += 1


def file_pezzo(simbolo, nome):
    return os.path.join(CACHE, f'{simbolo}_{nome}.json')


def da_scaricare(simbolo, nome):
    f = file_pezzo(simbolo, nome)
    if not os.path.exists(f):
        return True
    if nome == 'ultimo':
        return date.fromtimestamp(os.path.getmtime(f)) < date.today()
    return False


def piano():
    mancanti = [(s, n, e) for s in SIMBOLI for n, e in PEZZI if da_scaricare(s, n)]
    in_cache = len(SIMBOLI) * len(PEZZI) - len(mancanti)
    n = len(mancanti)
    finestre = max(0, math.ceil(n / MAX_FINESTRA) - 1)
    stima = n * max(GAP_MIN, STIMA_RISPOSTA) + finestre * FINESTRA
    print(f'Piano: {len(SIMBOLI)} simboli x {len(PEZZI)} pezzi da {DURATA} giornalieri')
    print(f'  in cache: {in_cache}   da richiedere: al massimo {n}')
    print(f'  (meno se un indice ha storia piu\' corta: ci si ferma al primo pezzo vuoto)')
    print(f'  limite usato: {MAX_FINESTRA} ogni {FINESTRA // 60} min (IBKR 60), almeno {GAP_MIN:.0f} s fra due richieste')
    print(f'  tempo stimato: ~{stima / 60:.1f} min' + (f' (incluse {finestre} pause da 10 min)' if finestre else ''))
    print(f'  + {len(SIMBOLI)} richieste di dettagli contratto (non sono storiche, non contano nel limite)')
    return mancanti


def scarica():
    from ib_insync import IB, Index
    mancanti = piano()
    if not mancanti:
        print('Niente da scaricare.')
        return
    os.makedirs(CACHE, exist_ok=True)
    ib = IB()
    ib.connect('127.0.0.1', 7496, clientId=random.randint(20000, 29999), timeout=15, readonly=True)
    errori = []
    ib.errorEvent += lambda reqId, code, msg, c: errori.append((code, msg))
    ritmo = Ritmo()
    contratti = {}
    for s in SIMBOLI:
        c = Index(s, 'CBOE', 'USD')
        if ib.qualifyContracts(c):
            contratti[s] = c
        else:
            print(f'  {s}: contratto non trovato su CBOE, salto')
    finiti = set()   # simboli di cui abbiamo raggiunto l'inizio della storia
    for s, nome, fine in mancanti:
        if s not in contratti or s in finiti:
            continue
        for tentativo in (1, 2):
            ritmo.aspetta()
            errori.clear()
            barre = ib.reqHistoricalData(contratti[s], endDateTime=fine, durationStr=DURATA,
                                         barSizeSetting='1 day', whatToShow='TRADES',
                                         useRTH=True, formatDate=1, timeout=120)
            pacing = any(code in (162, 366) and 'pacing' in msg.lower() for code, msg in errori)
            if pacing and tentativo == 1:
                print(f'  {s} {nome}: violazione di ritmo, attendo {ATTESA_PACING} s')
                time.sleep(ATTESA_PACING)
                continue
            break
        righe = [{'d': str(b.date), 'o': b.open, 'h': b.high, 'l': b.low, 'c': b.close} for b in barre]
        msg = '; '.join(f'{c} {m[:80]}' for c, m in errori if c not in (2104, 2106, 2158))
        print(f'  [{ritmo.fatte}] {s} {nome}: {len(righe)} barre' + (f'  ({righe[0]["d"]} -> {righe[-1]["d"]})' if righe else '') + (f'  {msg}' if msg else ''))
        if not righe:
            # vuoto per fine della storia (o errore): non salvo, cosi' un errore si riprova
            finiti.add(s)
            continue
        with open(file_pezzo(s, nome), 'w') as f:
            json.dump(righe, f)
        # la storia inizia dentro questo pezzo (primo giorno ben dopo l'inizio
        # dei 5 anni): i pezzi precedenti sarebbero vuoti, non li chiedo
        inizio = date(date.today().year - 5, date.today().month, 1) if nome == 'ultimo' else date(int(nome) - 4, 1, 1)
        if date.fromisoformat(righe[0]['d'][:10]) > date(inizio.year, inizio.month, 1).replace(day=28):
            finiti.add(s)
    ib.disconnect()
    print(f'Fatte {ritmo.fatte} richieste storiche.')


# ---------------------------------------------------------------- analisi

def carica():
    import pandas as pd
    serie = {}
    for s in SIMBOLI:
        righe = {}
        for nome, _ in PEZZI:
            f = file_pezzo(s, nome)
            if os.path.exists(f):
                for r in json.load(open(f)):
                    righe[r['d']] = r
        if righe:
            df = pd.DataFrame(sorted(righe.values(), key=lambda r: r['d'])).set_index('d')
            df.index = pd.to_datetime(df.index)
            serie[s] = df
    return serie


def costruisci(serie):
    import numpy as np, pandas as pd
    spx = serie['SPX']
    d = pd.DataFrame(index=spx.index)
    d['O'], d['H'], d['L'], d['C'] = spx.o, spx.h, spx.l, spx.c
    for s in SIMBOLI[1:]:
        if s in serie:
            d[s] = serie[s].c.reindex(d.index)
            d[s + '_o'] = serie[s].o.reindex(d.index)
    d = d[d.VIX.notna()]
    Cp = d.C.shift(1)
    sig = Cp * d.VIX.shift(1) / 100 / math.sqrt(252)          # movimento prezzato ieri sera, in punti
    # bersagli del giorno t
    d['range'] = (d.H - d.L) / sig
    d['oc'] = (d.C - d.O) / sig
    d['aoc'] = d.oc.abs()
    d['cc'] = (d.C - Cp) / sig
    d['acc'] = d.cc.abs()
    d['trend'] = (d.C - d.O).abs() / (d.H - d.L)
    # predittori noti alla chiusura di t-1
    r = np.log(d.C / Cp)
    rv20 = r.rolling(20).std() * math.sqrt(252) * 100
    P = pd.DataFrame(index=d.index)
    P['VIX'] = d.VIX
    if 'VIX9D' in d: P['VIX9D/VIX'] = d.VIX9D / d.VIX
    if 'VIX3M' in d: P['VIX/VIX3M'] = d.VIX / d.VIX3M
    if 'VIX1D' in d: P['VIX1D/VIX'] = d.VIX1D / d.VIX
    if 'VVIX' in d: P['VVIX'] = d.VVIX
    if 'SKEW' in d: P['SKEW'] = d.SKEW
    P['VRP (VIX-RV20)'] = d.VIX - rv20
    P['dVIX 1g %'] = d.VIX.pct_change() * 100
    P['rendimento 1g (sigma)'] = d.cc
    oggi = P.iloc[-1].copy()
    P = P.shift(1)
    # predittori all'apertura di t (l'"open" degli indici CBOE e' la prima stampa delle 9:30)
    P['gap apertura (sigma)'] = (d.O - Cp) / sig
    if 'VIX9D_o' in d: P['VIX9D/VIX apertura'] = d.VIX9D_o / d.VIX_o
    return d, P, oggi


def quintili(x, y_df, bersagli):
    import pandas as pd
    m = pd.concat([x.rename('x'), y_df[bersagli]], axis=1).dropna()
    if len(m) < 100:
        return None
    m['q'] = pd.qcut(m.x, 5, labels=False, duplicates='drop') + 1
    g = m.groupby('q')
    t = pd.DataFrame({'da': g.x.min(), 'a': g.x.max(), 'n': g.size()})
    t['range'] = g['range'].mean()
    t['range>1.5'] = g['range'].apply(lambda v: (v > 1.5).mean() * 100)
    t['|O-C|'] = g['aoc'].mean()
    t['|C-C|>1'] = g['acc'].apply(lambda v: (v > 1).mean() * 100)
    t['trend'] = g['trend'].mean()
    t['O-C'] = g['oc'].mean()
    t['% su'] = g['oc'].apply(lambda v: (v > 0).mean() * 100)
    return t


PERIODI = [('2012-2019', '2012-01-01', '2019-12-31'), ('2020-2021', '2020-01-01', '2021-12-31'),
           ('2022+ (era 0DTE)', '2022-01-01', '2099-01-01')]


def tabella_md(t, cifre=2):
    righe = ['| ' + ' | '.join(['q'] + list(t.columns)) + ' |', '|' + '---|' * (len(t.columns) + 1)]
    for q, r in t.iterrows():
        vals = []
        for c, v in r.items():
            vals.append(str(int(v)) if c == 'n' else (f'{v:.0f}' if c.startswith('%') or '>' in c else f'{v:.{cifre}f}'))
        righe.append('| ' + ' | '.join([str(q)] + vals) + ' |')
    return '\n'.join(righe)


def analizza():
    import pandas as pd
    serie = carica()
    if 'SPX' not in serie or 'VIX' not in serie:
        print('Mancano SPX o VIX in cache: lancia prima --scarica')
        return
    d, P, oggi = costruisci(serie)
    d = d[d.range.notna() & (d.H > d.L)]
    P = P.reindex(d.index)
    out = []
    w = out.append
    w(f'# Studio vol - {datetime.now():%d/%m/%Y %H:%M}\n')
    w(f'Giorni SPX: {len(d)} ({d.index[0]:%d/%m/%Y} -> {d.index[-1]:%d/%m/%Y}). Serie: ' +
      ', '.join(f'{s} da {serie[s].index[0]:%Y}' for s in serie) + '\n')
    w('Unita\': sigma = SPX * VIX / 100 / sqrt(252) della sera prima (il movimento giornaliero prezzato). '
      'Sotto moto browniano un range medio vale ~1.6 sigma, |O-C| ~0.8.\n')
    w('## Base: quanto prezza bene il VIX\n')
    for nome, a, b in [('tutto', '1900', '2099')] + PERIODI:
        x = d.loc[a:b]
        if len(x):
            w(f'- {nome}: n {len(x)}, range medio {x.range.mean():.2f} (mediana {x.range.median():.2f}), '
              f'|O-C| {x.aoc.mean():.2f}, |C-C| {x.acc.mean():.2f}, giorni con |C-C|>1 sigma {(x.acc > 1).mean() * 100:.0f}% (BM: 32%)')
    w('')
    bers = ['range', 'aoc', 'acc', 'trend', 'oc']
    w('## Correlazioni di rango (Spearman) predittore -> giorno dopo\n')
    w('| predittore | periodo | n | range | abs(O-C) | abs(C-C) | trend | O-C (direzione) |')
    w('|---|---|---|---|---|---|---|---|')
    for col in P.columns:
        for nome, a, b in [('tutto', '1900', '2099')] + PERIODI:
            m = pd.concat([P[col].loc[a:b].rename('x'), d.loc[a:b, bers]], axis=1).dropna()
            if len(m) < 100:
                continue
            c = m.corr(method='spearman')['x']
            w(f'| {col} | {nome} | {len(m)} | ' + ' | '.join(f'{c[k]:+.3f}' for k in bers) + ' |')
    w('\nCon n ~ 1000 una correlazione sotto ~0.06 in valore assoluto non si distingue dal caso; con n ~ 3500 sotto ~0.035.\n')
    w('## Quintili per predittore (tutto il periodo e 2022+)\n')
    w('Colonne: range medio, % giorni con range > 1.5 sigma, |O-C| medio, % giorni con |C-C| > 1 sigma, '
      'trend = |O-C|/range, O-C medio con segno, % giorni chiusi sopra l\'apertura.\n')
    for col in P.columns:
        for nome, a, b in [('tutto', '1900', '2099'), PERIODI[-1]]:
            t = quintili(P[col].loc[a:b], d.loc[a:b], bers)
            if t is not None:
                w(f'### {col} - {nome}\n')
                w(tabella_md(t))
                w('')
    # term structure invertita: tabella a due vie col livello del VIX
    for col, soglia in [('VIX9D/VIX', 1.0), ('VIX/VIX3M', 1.0)]:
        if col not in P:
            continue
        w(f'## {col} > {soglia} (invertita) a parita\' di livello VIX\n')
        m = pd.concat([P[col].rename('x'), P['VIX'].rename('v'), d[bers]], axis=1).dropna()
        m['terzile VIX'] = pd.qcut(m.v, 3, labels=['basso', 'medio', 'alto'])
        m['invertita'] = m.x > soglia
        g = m.groupby(['terzile VIX', 'invertita'], observed=True)
        w('| VIX | invertita | n | range | abs(O-C) | trend | O-C | % su |')
        w('|---|---|---|---|---|---|---|---|')
        for (tv, inv), x in g:
            w(f'| {tv} | {"si" if inv else "no"} | {len(x)} | {x.range.mean():.2f} | {x.aoc.mean():.2f} | '
              f'{x.trend.mean():.2f} | {x.oc.mean():+.2f} | {(x.oc > 0).mean() * 100:.0f} |')
        w('')
    w('## Dove siamo (ultima chiusura in cache) - percentile su tutto lo storico\n')
    Pt = P.shift(-1)   # riporta i valori alla loro data
    for col, v in oggi.items():
        if pd.notna(v) and col in Pt:
            st = Pt[col].dropna()
            w(f'- {col}: {v:.3f}  (percentile {(st < v).mean() * 100:.0f}, 2022+: {(st.loc["2022":] < v).mean() * 100:.0f})')
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    print(f'Scritto {REPORT}')


TS_GIORNO = os.path.join(RADICE, 'frontend', 'src', 'lib', 'volCalibrazioneGiorno.ts')
CONTESTO = ['VIX9D/VIX', 'VIX1D/VIX', 'VIX/VIX3M', 'SKEW', 'VIX']


def calibra():
    """Percentili 2022+ e range relativo per quintile, per il contesto di /api/vol."""
    import numpy as np, pandas as pd
    d, P, _ = costruisci(carica())
    d = d[d.range.notna() & (d.H > d.L)].loc['2022':]
    P = P.reindex(d.index)
    media = d.range.mean()
    out = {}
    for col in CONTESTO:
        m = pd.concat([P[col].rename('x'), d.range], axis=1).dropna()
        bordi = list(np.quantile(m.x, [0.2, 0.4, 0.6, 0.8]))
        q = np.digitize(m.x, bordi)
        rel = [round(float(m.range[q == k].mean() / media), 3) for k in range(5)]
        out[col] = {'percentili': [round(float(v), 4) for v in np.quantile(m.x, np.linspace(0, 1, 101))],
                    'bordiQuintili': [round(float(b), 4) for b in bordi], 'rangeRelativo': rel,
                    'rho': round(float(m.corr(method='spearman').iloc[0, 1]), 3), 'n': len(m)}
    with open(TS_GIORNO, 'w', encoding='utf-8') as f:
        f.write(f"""/**
 * Generato da `python execution/studio_vol.py --calibra` il {datetime.now():%d/%m/%Y}: non modificare a mano.
 *
 * Giorni SPX dal 2022 ({d.index[0]:%d/%m/%Y} -> {d.index[-1]:%d/%m/%Y}). Per ogni misura
 * della sera prima: i percentili 0..100, i bordi dei quintili e il range medio
 * del giorno dopo in ogni quintile, relativo alla media (1 = giornata normale
 * in unita' di VIX). `rho` = Spearman col range del giorno dopo. Prevedono
 * l'ampiezza, non la direzione (studio del 03/11/2026).
 */
export const VOL_GIORNO = {json.dumps(out)} as const;
""")
    print(f'Scritto {TS_GIORNO}')


if __name__ == '__main__':
    if '--piano' in sys.argv:
        piano()
    elif '--scarica' in sys.argv:
        scarica()
    elif '--calibra' in sys.argv:
        calibra()
    else:
        analizza()
