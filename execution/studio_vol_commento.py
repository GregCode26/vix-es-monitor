"""Studio 13/11/2026: le letture del commento sulla vol del 12/11 valgono qualcosa?

Il commento (chiusure dell'11/11 e quadro del 12/11 a meta' seduta) usa sette
letture. Ognuna diventa un'ipotesi misurata su SPX giornaliero 2006-2026:

 H1 curva dei VIX "si allarga": VIX3M - VIX9D in punti (e la sua variazione)
 H2 SKEW basso ("il piu' basso da fine ottobre"): livello e minimo a 10 giorni
 H3 correlazione implicita COR1M sotto 10
 H4 "dopo tre chiusure in calo, oggi la vol e' sopra la chiusura di ieri":
    primo rialzo del VIX dopo >= 3 cali -> la vol ha smesso di scendere?
 H5 "rialzo proporzionalmente piu' forte dell'indice": dVIX% al netto di cio'
    che spiega il rendimento SPX (beta 250 giorni, solo passato)
 H6 "le code si muovono di piu'": dLTV% - dVIX% (put molto OTM contro VIX)
 H7 vola ATM 30 giorni (IBKR OPTION_IMPLIED_VOLATILITY di SPX) e VIX - ATM

Bersagli (tutti noti solo dopo, i predittori alla chiusura del giorno):
 range e C-C del giorno dopo in sigma VIX (come studio_vol.py), rendimento SPX
 a 5 giorni in sigma*sqrt(5), variazione % del VIX a 1 e 5 giorni.
Ricerca 2006-2019, verifica 2020-2021 e 2022+ (era 0DTE): conta solo cio' che
tiene lo stesso segno nei periodi.

Dati: CSV giornalieri gratuiti Cboe (cdn.cboe.com, nessun limite IBKR) per gli
indici; SPX OHLC dalla cache di studio_vol.py piu' 1 richiesta IBKR per i giorni
recenti; IV 30 giorni SPX: 4 richieste IBKR da 5 anni. Le richieste IBKR passano
da Ritmo di studio_vol.py e il piano si stampa prima di connettersi.

Risultati del 13/11/2026 (SPX 2007 -> 12/11/2026):
- nessuna lettura prevede la direzione del giorno dopo (|rho| C-C g+1 <= 0.10,
  segni instabili). Cio' che tiene in tutti i periodi e' AMPIEZZA e VIX futuro:
  curva larga (VIX3M-VIX9D) = giorno dopo piu' stretto (rho -0.24/-0.33 anche al
  netto del VIX) e VIX che risale (+0.11..+0.24 su 5 giorni); SKEW alto e
  VIX-ATM30 alto = giorno piu' stretto. E' la stessa cosa di studio_vol.py;
- H4 "primo rialzo dopo 3 cali": nessun segnale. A parita' di rialzo (+3..+8%)
  dVIX 5g +0.93% contro +0.39% (t ~0.6), SPX 5g simile. Smettere di scendere
  per un giorno non dice che la vol abbia girato;
- H5 VIX su piu' del dovuto, H6 code (dLTV-dVIX), H1 variazione della curva:
  nulla (|rho| < 0.07 o segni alterni);
- H3 COR1M < 10 (solo dal 2017, 24 episodi): SPX 5g -0.19 sigma*sqrt5 contro
  giorni con lo stesso VIX, VIX 5g +4.8 punti %; 16 episodi su 24 negativi
  (base 59% su: binomiale p 0.013; dal 2023 13 su 17, p 0.005). Unico candidato,
  in sample, soglia presa dal commento, ~35 punti SPX in 5 giorni: da seguire,
  non da operare.

Uso:
  python execution/studio_vol_commento.py --piano    # piano richieste, niente connessione
  python execution/studio_vol_commento.py --scarica  # Cboe + IBKR mancanti
  python execution/studio_vol_commento.py            # analisi -> .tmp/studio_vol_commento.md
"""
import io, json, math, os, random, sys, time, urllib.request
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import studio_vol as SV  # noqa: E402

RADICE = SV.RADICE
CACHE = os.path.join(RADICE, '.tmp', 'studio_vol_commento')
REPORT = os.path.join(RADICE, '.tmp', 'studio_vol_commento.md')
CBOE = ['VIX', 'VIX9D', 'VIX3M', 'VIX1D', 'COR1M', 'LTV', 'SKEW', 'VVIX']
URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/{}_History.csv'
IV_PEZZI = [('ultimo', ''), ('2021', '20211231-23:59:59'), ('2016', '20161231-23:59:59'),
            ('2011', '20111231-23:59:59')]


def f_ibkr(nome):
    return os.path.join(CACHE, f'{nome}.json')


def piano_ibkr():
    oggi = date.today()
    serve = []
    for nome, fine in [('SPX_recente', '')] + [(f'SPXIV_{n}', e) for n, e in IV_PEZZI]:
        f = f_ibkr(nome)
        if not os.path.exists(f) or (fine == '' and date.fromtimestamp(os.path.getmtime(f)) < oggi):
            serve.append((nome, fine))
    print('Piano richieste:')
    print(f'  Cboe: {len(CBOE)} CSV giornalieri (non IBKR, nessun limite)')
    print(f'  IBKR storiche: {len(serve)} su 5 '
          f'(SPX 1 Y TRADES; SPX OPTION_IMPLIED_VOLATILITY 4 x 5 Y), in cache {5 - len(serve)}')
    print(f'  ritmo: almeno {SV.GAP_MIN:.0f} s fra richieste, max {SV.MAX_FINESTRA} in 10 min '
          f'-> ~{len(serve) * SV.STIMA_RISPOSTA / 60:.1f} min')
    return serve


def scarica():
    serve = piano_ibkr()
    os.makedirs(CACHE, exist_ok=True)
    for s in CBOE:
        req = urllib.request.Request(URL.format(s), headers={'User-Agent': 'Mozilla/5.0'})
        testo = urllib.request.urlopen(req, timeout=60).read().decode()
        with open(os.path.join(CACHE, f'{s}.csv'), 'w', encoding='utf-8') as f:
            f.write(testo)
        print(f'  Cboe {s}: {testo.count(chr(10))} righe')
    if not serve:
        return
    from ib_insync import IB, Index
    ib = IB()
    ib.connect('127.0.0.1', 7496, clientId=random.randint(20000, 29999), timeout=15, readonly=True)
    errori = []
    ib.errorEvent += lambda reqId, code, msg, c: errori.append((code, msg))
    spx = Index('SPX', 'CBOE', 'USD')
    ib.qualifyContracts(spx)
    ritmo = SV.Ritmo()
    for nome, fine in serve:
        cosa = 'TRADES' if nome == 'SPX_recente' else 'OPTION_IMPLIED_VOLATILITY'
        durata = '1 Y' if nome == 'SPX_recente' else '5 Y'
        for tentativo in (1, 2):
            ritmo.aspetta()
            errori.clear()
            barre = ib.reqHistoricalData(spx, endDateTime=fine, durationStr=durata, barSizeSetting='1 day',
                                         whatToShow=cosa, useRTH=True, formatDate=1, timeout=120)
            if tentativo == 1 and any(c in (162, 366) and 'pacing' in m.lower() for c, m in errori):
                print(f'  {nome}: violazione di ritmo, attendo {SV.ATTESA_PACING} s')
                time.sleep(SV.ATTESA_PACING)
                continue
            break
        righe = [{'d': str(b.date), 'o': b.open, 'h': b.high, 'l': b.low, 'c': b.close} for b in barre]
        print(f'  [{ritmo.fatte}] {nome}: {len(righe)} barre' + (f' ({righe[0]["d"]} -> {righe[-1]["d"]})' if righe else ''))
        if righe:
            with open(f_ibkr(nome), 'w') as f:
                json.dump(righe, f)
    ib.disconnect()


# ---------------------------------------------------------------- dati

def carica():
    import pandas as pd
    out = {}
    for s in CBOE:
        f = os.path.join(CACHE, f'{s}.csv')
        if not os.path.exists(f):
            continue
        df = pd.read_csv(f)
        df['DATE'] = pd.to_datetime(df.DATE, format='%m/%d/%Y')
        df = df.set_index('DATE')
        out[s] = df['CLOSE'] if 'CLOSE' in df else df.iloc[:, -1]
    # SPX OHLC: cache di studio_vol + recente
    righe = {}
    for nome, _ in SV.PEZZI:
        f = SV.file_pezzo('SPX', nome)
        if os.path.exists(f):
            for r in json.load(open(f)):
                righe[r['d']] = r
    if os.path.exists(f_ibkr('SPX_recente')):
        for r in json.load(open(f_ibkr('SPX_recente'))):
            righe[r['d']] = r
    spx = pd.DataFrame(sorted(righe.values(), key=lambda r: r['d'])).set_index('d')
    spx.index = pd.to_datetime(spx.index)
    iv = {}
    for n, _ in IV_PEZZI:
        f = f_ibkr(f'SPXIV_{n}')
        if os.path.exists(f):
            for r in json.load(open(f)):
                iv[r['d']] = r['c'] * 100
    ivs = pd.Series(iv, dtype=float)
    ivs.index = pd.to_datetime(ivs.index)
    out['ATM30'] = ivs.sort_index()
    return spx, out


def costruisci(spx, s):
    import numpy as np, pandas as pd
    d = pd.DataFrame(index=spx.index)
    d['O'], d['H'], d['L'], d['C'] = spx.o, spx.h, spx.l, spx.c
    for k, v in s.items():
        d[k] = v.reindex(d.index)
    d = d[d.VIX.notna() & (d.H > d.L)]
    Cp = d.C.shift(1)
    sig = d.C * d.VIX / 100 / math.sqrt(252)          # sigma prezzata alla chiusura di t
    r = np.log(d.C / Cp)
    # bersagli: giorno t+1 (e t+1..t+5), in unita' della sigma di t
    B = pd.DataFrame(index=d.index)
    B['range'] = ((d.H - d.L).shift(-1)) / sig
    B['cc1'] = (d.C.shift(-1) - d.C) / sig
    B['cc5'] = (d.C.shift(-5) - d.C) / (sig * math.sqrt(5))
    B['dVIX1%'] = (d.VIX.shift(-1) / d.VIX - 1) * 100
    B['dVIX5%'] = (d.VIX.shift(-5) / d.VIX - 1) * 100
    # predittori alla chiusura di t
    P = pd.DataFrame(index=d.index)
    P['H1 VIX3M-VIX9D'] = d.VIX3M - d.VIX9D
    P['H1 var. 1g curva'] = P['H1 VIX3M-VIX9D'].diff()
    P['H2 SKEW'] = d.SKEW
    P['H2 SKEW - min 10g'] = d.SKEW - d.SKEW.rolling(10).min().shift(1)
    P['H3 COR1M'] = d.COR1M
    P['H3 COR1M var. 1g'] = d.COR1M.diff()
    dv = d.VIX.pct_change() * 100
    # H5: residuo di dVIX% sul rendimento SPX, beta/alfa sui 250 giorni precedenti
    rr = r * 100
    cov = (dv * rr).rolling(250).mean() - dv.rolling(250).mean() * rr.rolling(250).mean()
    beta_t = cov / rr.rolling(250).var(ddof=0)
    alfa = (dv.rolling(250).mean() - beta_t * rr.rolling(250).mean()).shift(1)
    beta = beta_t.shift(1)
    res = dv - (alfa + beta * rr)
    P['H5 residuo dVIX% (sd)'] = res / res.rolling(250).std().shift(1)
    P['H6 dLTV% - dVIX%'] = d.LTV.pct_change() * 100 - dv
    P['H6 LTV/VIX'] = d.LTV / d.VIX
    P['H7 ATM30'] = d.ATM30
    P['H7 VIX - ATM30'] = d.VIX - d.ATM30
    # H4: cali consecutivi del VIX fino a ieri
    giu = (dv < 0).astype(int)
    serie_giu = giu.groupby((giu == 0).cumsum()).cumsum()
    d['cali_prima'] = serie_giu.shift(1)
    d['dVIX'] = dv
    d['ret'] = rr
    d['res'] = res
    return d, P, B


NOTA = """## Nota: cosa e' questo studio e come leggerlo

**Cosa fa.** Un commento sulla volatilita' (12/11/2026) leggeva il mercato con sette misure: curva dei VIX,
SKEW, correlazione implicita COR1M, LTV (put molto OTM), "primo rialzo della vol dopo tre cali", rialzo del VIX
"piu' forte del dovuto" rispetto a SPX, vola ATM a 30 giorni. Qui ognuna diventa un'ipotesi (H1-H7) e si guarda
cosa e' successo **dopo** in 20 anni di SPX: se quella lettura avesse valore, i giorni successivi dovrebbero
essere diversi dal solito in modo ripetibile.

**Le letture (alla chiusura del giorno, quindi note la sera prima):**
- H1 `VIX3M-VIX9D`: larghezza della curva in punti (positiva = contango, la normalita'). `var. 1g` = quanto si e' allargata oggi.
- H2 `SKEW`: prezzo delle code a sinistra. `SKEW - min 10g` = quanto sta sopra il minimo degli ultimi 10 giorni.
- H3 `COR1M`: correlazione implicita fra i titoli dell'indice a 1 mese (bassa = titoli che vanno ognuno per conto suo).
- H4 primo rialzo del VIX dopo >= 3 chiusure in calo (tabella a parte).
- H5 `residuo dVIX%`: quanto il VIX e' salito oltre cio' che spiega il movimento di SPX, in deviazioni standard (+1 = molto piu' del solito).
- H6 `dLTV% - dVIX%`: le code si muovono piu' del VIX; `LTV/VIX`: quanto pesano le code.
- H7 `ATM30`: vol implicita a 30 giorni di SPX (IBKR); `VIX - ATM30`: quanto il VIX sta sopra l'ATM, cioe' il peso dello skew.

**Cosa si misura dopo (i "bersagli"):**
- `range g+1`: escursione massimo-minimo del giorno dopo, in sigma del VIX (1 sigma = SPX x VIX / 100 / 16, il movimento
  giornaliero che il VIX prezza; con SPX 7600 e VIX 18 sono ~86 punti). La media storica e' ~0.95.
- `C-C g+1`: chiusura del giorno dopo meno quella di oggi, in sigma, **con segno**: e' la direzione.
- `SPX 5g`: lo stesso su 5 giorni, in sigma x radice di 5 (0.1 ~ 19 punti SPX). `% su5` = quante volte SPX era piu' alto.
- `dVIX g+1 %`, `dVIX 5g %`: variazione percentuale del VIX dopo 1 e 5 giorni.

**Come leggere le tabelle:**
- *Spearman*: correlazione di rango fra lettura e bersaglio, da -1 a +1. Positiva = lettura alta, bersaglio alto. Qui
  valori intorno a 0.05-0.10 sono gia' "qualcosa", sotto ~0.04 (con ~3000 giorni) o ~0.09 (con ~500) e' caso.
- *Tre periodi*: 2006-2019 per cercare, 2020-21 e 2022+ per verificare. Conta solo cio' che ha **lo stesso segno in
  tutti e tre** (elenco "Stabili"); un effetto che cambia segno fra un periodo e l'altro e' rumore.
- *Al netto del VIX*: molte letture sono il livello del VIX travestito (curva larga e COR1M basso arrivano quando il
  VIX e' basso, e un VIX basso tende a risalire). Questa tabella toglie il VIX e mostra cio' che la lettura **aggiunge**.
  Se un effetto c'e' sopra e sparisce qui, non era della lettura ma del VIX.
- *Quintili*: i giorni divisi in 5 gruppi dalla lettura piu' bassa (1) alla piu' alta (5), con la media del dopo. Un
  effetto vero cresce o cala in modo ordinato da 1 a 5; un salto in un solo gruppo e' sospetto.
- *Eventi (H3, H4, H5)*: confronti fra giorni con e senza la condizione. Guardare n: con poche decine di casi, o
  pochi **episodi** indipendenti (giorni consecutivi contano come uno), una differenza grande puo' essere un caso.
  I bersagli a 5 giorni si sovrappongono: n effettivo ~ n/5.
- *Giorni simili al 12/11*: solo descrizione, troppo pochi casi per concludere.

**Cosa dice, in breve (13/11/2026):**
- Nessuna lettura prevede la **direzione** del giorno dopo. Il commento le usa come se lo facessero; i dati no.
- Prevedono l'**ampiezza**: curva larga, SKEW alto, VIX-ATM30 alto = giornata dopo piu' stretta; e il VIX che risale
  dopo una curva larga. Ma VIX1D/VIX, gia' in /api/vol, contiene la stessa informazione: aggiungerle non migliora la
  previsione fuori campione (`--contesto`: 0.40 da solo, 0.38-0.40 con tutte).
- "Dopo tre cali la vol risale" non annuncia nulla; "VIX su piu' del dovuto" e "le code si muovono di piu'" nemmeno.
- Unico candidato: **COR1M sotto 10** (dal 2017, 24 episodi, 16 con SPX piu' basso dopo 5 giorni, ~-35 punti rispetto a
  giorni con lo stesso VIX). Soglia presa dal commento, stimato sugli stessi dati: avviso arancione nell'intestazione
  dello smile su /market e Quantower, **in prova**, non un segnale operativo.
- La conferma sui range OB non va meglio nelle giornate previste strette (`--conferma`, 16 sedute: semmai il contrario,
  ma e' rumore).

**In pratica:** usare il contesto per dimensionare (target, attese sul range), non per scegliere LONG o SHORT; trattare
COR1M < 10 come "meno fiducia nei LONG a qualche giorno", da ricontrollare quando ci saranno nuovi episodi.
Rilanciare con `python execution/studio_vol_commento.py --scarica` e poi senza argomenti.
"""


PERIODI = [('2006-2019 (ricerca)', '2006-01-01', '2019-12-31'), ('2020-2021', '2020-01-01', '2021-12-31'),
           ('2022+ (0DTE)', '2022-01-01', '2099-01-01')]
NOMI_B = {'range': 'range g+1', 'cc1': 'C-C g+1', 'cc5': 'SPX 5g', 'dVIX1%': 'dVIX g+1 %', 'dVIX5%': 'dVIX 5g %'}


def analizza():
    import numpy as np, pandas as pd
    spx, s = carica()
    d, P, B = costruisci(spx, s)
    out = []
    w = out.append
    w(f'# Studio sul commento vol del 12/11 - {datetime.now():%d/%m/%Y %H:%M}\n')
    w(NOTA)
    w(f'SPX {d.index[0]:%d/%m/%Y} -> {d.index[-1]:%d/%m/%Y}, {len(d)} giorni. ' +
      'Serie: ' + ', '.join(f'{k} da {v.dropna().index[0]:%Y}' for k, v in s.items() if len(v.dropna())) + '\n')
    w('Unita\': sigma = SPX*VIX/100/sqrt(252) alla chiusura del giorno del segnale. Range medio atteso con '
      'VIX corretto ~1.6 sigma; lo storico sta a ~0.95 (il VIX sovrastima). SPX 5g in sigma*sqrt(5).\n')

    # --- dove siamo
    w('## Le chiusure dell\'11/11 e del 12/11 (percentile 2006+ / 2022+)\n')
    w('| lettura | 11/11 | 12/11 | perc. 12/11 tutto | perc. 2022+ |')
    w('|---|---|---|---|---|')
    for col in P.columns:
        st = P[col].dropna()
        try:
            a, b = P[col].loc['2026-11-11'], P[col].loc['2026-11-12']
        except KeyError:
            a = b = float('nan')
        if pd.isna(b):
            w(f'| {col} | {a:.2f} | n.d. | | |')
            continue
        w(f'| {col} | {a:.2f} | {b:.2f} | {(st < b).mean() * 100:.0f} | {(st.loc["2022":] < b).mean() * 100:.0f} |')
    w('')

    # --- correlazioni
    w('## Spearman lettura -> dopo, per periodo\n')
    w('Con n ~ 3000 conta sopra ~0.04, con n ~ 500 sopra ~0.09; SPX 5g e dVIX 5g si sovrappongono '
      '(n effettivo /5). Un effetto vale solo se ha lo stesso segno nei tre periodi.\n')
    w('| lettura | periodo | n | ' + ' | '.join(NOMI_B.values()) + ' |')
    w('|---|---|---|' + '---|' * len(NOMI_B))
    stab = {}
    for col in P.columns:
        for nome, a, b in PERIODI:
            m = pd.concat([P[col].loc[a:b].rename('x'), B.loc[a:b]], axis=1).dropna()
            if len(m) < 150:
                continue
            c = m.corr(method='spearman')['x']
            stab.setdefault(col, []).append(c)
            w(f'| {col} | {nome} | {len(m)} | ' + ' | '.join(f'{c[k]:+.3f}' for k in NOMI_B) + ' |')
    w('')
    w('### Stabili (stesso segno in tutti i periodi disponibili, |rho| >= 0.05 in ognuno)\n')
    trovati = 0
    for col, cs in stab.items():
        if len(cs) < 2:
            continue
        for k in NOMI_B:
            v = [c[k] for c in cs]
            if all(x >= 0.05 for x in v) or all(x <= -0.05 for x in v):
                trovati += 1
                w(f'- {col} -> {NOMI_B[k]}: ' + ', '.join(f'{x:+.3f}' for x in v))
    if not trovati:
        w('- nessuno')
    w('')

    # --- al netto del livello del VIX
    w('## Al netto del livello del VIX\n')
    w('Molte letture sono il VIX travestito (curva larga e COR1M basso = VIX basso, e il VIX basso tende a '
      'risalire). Qui il rango della lettura e quello del bersaglio sono ripuliti dal rango del VIX '
      '(regressione lineare per periodo), poi correlati: e\' cio\' che la lettura aggiunge al VIX.\n')
    w('| lettura | periodo | n | ' + ' | '.join(NOMI_B.values()) + ' |')
    w('|---|---|---|' + '---|' * len(NOMI_B))
    stab_n = {}
    for col in P.columns:
        for nome, a, b in PERIODI:
            m = pd.concat([P[col].loc[a:b].rename('x'), d.VIX.loc[a:b].rename('v'), B.loc[a:b]], axis=1).dropna()
            if len(m) < 150:
                continue
            R = m.rank()

            def netto(y):
                k = np.polyfit(R.v, R[y], 1)
                return R[y] - np.polyval(k, R.v)
            xr = netto('x')
            c = {k: float(np.corrcoef(xr, netto(k))[0, 1]) for k in NOMI_B}
            stab_n.setdefault(col, []).append(c)
            w(f'| {col} | {nome} | {len(m)} | ' + ' | '.join(f'{c[k]:+.3f}' for k in NOMI_B) + ' |')
    w('\n### Stabili al netto del VIX (stesso segno, |rho| >= 0.05 in ogni periodo)\n')
    trovati = 0
    for col, cs in stab_n.items():
        for k in NOMI_B:
            v = [c[k] for c in cs]
            if len(v) >= 2 and (all(x >= 0.05 for x in v) or all(x <= -0.05 for x in v)):
                trovati += 1
                w(f'- {col} -> {NOMI_B[k]}: ' + ', '.join(f'{x:+.3f}' for x in v))
    if not trovati:
        w('- nessuno')
    w('')

    # --- quintili
    w('## Quintili (2006+ e 2022+)\n')
    w('Medie del dopo per quintile della lettura. `% su5` = SPX piu\' alto dopo 5 giorni.\n')
    for col in P.columns:
        for nome, a, b in [('2006+', '1900', '2099'), ('2022+', '2022-01-01', '2099')]:
            m = pd.concat([P[col].loc[a:b].rename('x'), B.loc[a:b]], axis=1).dropna()
            if len(m) < 250:
                continue
            m['q'] = pd.qcut(m.x, 5, labels=False, duplicates='drop') + 1
            g = m.groupby('q')
            w(f'### {col} - {nome}\n')
            w('| q | da | a | n | range g+1 | C-C g+1 | SPX 5g | % su5 | dVIX g+1 % | dVIX 5g % |')
            w('|---|---|---|---|---|---|---|---|---|---|')
            for q, x in g:
                w(f'| {q} | {x.x.min():.2f} | {x.x.max():.2f} | {len(x)} | {x.range.mean():.2f} | {x.cc1.mean():+.3f} | '
                  f'{x.cc5.mean():+.3f} | {(x.cc5 > 0).mean() * 100:.0f} | {x["dVIX1%"].mean():+.2f} | {x["dVIX5%"].mean():+.2f} |')
            w('')

    # --- H3 soglia 10
    w('## H3: COR1M sotto 10\n')
    m = pd.concat([P['H3 COR1M'].rename('x'), B], axis=1).dropna()
    for nome, sel in [('COR1M < 10', m.x < 10), ('COR1M 10-15', (m.x >= 10) & (m.x < 15)), ('COR1M >= 15', m.x >= 15)]:
        x = m[sel]
        if len(x):
            w(f'- {nome}: n {len(x)} (dal {x.index[0]:%m/%Y}), range g+1 {x.range.mean():.2f}, SPX 5g {x.cc5.mean():+.3f} '
              f'({(x.cc5 > 0).mean() * 100:.0f}% su), dVIX 5g {x["dVIX5%"].mean():+.2f}%')
    w('\nCOR1M < 10 esiste solo dal 2017. Per episodi (giorni consecutivi sotto 10, a meno di 5 giorni di '
      'distanza = stesso episodio) e a parita\' di VIX (stessi giorni contro giorni 2017+ con VIX entro +-1 punto):\n')
    x = m.loc['2017':]
    sotto = x[x.x < 10]
    if len(sotto):
        ep = (sotto.index.to_series().diff().dt.days > 7).cumsum()
        w(f'- episodi: {ep.nunique()}; SPX 5g per episodio (media dei giorni): ' +
          ', '.join(f'{g.index[0]:%m/%Y} ({len(g)}g) {g.cc5.mean():+.2f}' for _, g in sotto.groupby(ep)))
        vx = d.VIX.reindex(x.index)
        ctrl = []
        for i in sotto.index:
            simili = x[(x.x >= 10) & ((vx - vx[i]).abs() <= 1)]
            if len(simili):
                ctrl.append((sotto.cc5[i] - simili.cc5.mean(), sotto['dVIX5%'][i] - simili['dVIX5%'].mean()))
        if ctrl:
            a1 = np.array(ctrl)
            w(f'- differenza contro giorni con lo stesso VIX e COR1M >= 10: SPX 5g {a1[:, 0].mean():+.3f} sigma, '
              f'dVIX 5g {a1[:, 1].mean():+.2f} punti % (n {len(a1)}, ma solo {ep.nunique()} episodi indipendenti)')
    w('')

    # --- H4 evento
    w('## H4: primo rialzo del VIX dopo almeno 3 cali\n')
    w('Evento = il VIX chiude sopra la chiusura di ieri dopo >= N cali di fila. Confronto: tutti i giorni di '
      'rialzo del VIX con meno cali prima (stessa ampiezza del rialzo in quintile). Domanda del commento: '
      'la vol ha smesso di scendere? -> dVIX nei giorni dopo, e SPX.\n')
    E = pd.concat([d[['cali_prima', 'dVIX', 'ret', 'res']], B], axis=1).dropna(subset=['cali_prima', 'dVIX', 'cc5', 'dVIX5%'])
    su = E[E.dVIX > 0]
    w('| caso | periodo | n | dVIX oggi % | dVIX g+1 % | dVIX 5g % | % VIX 5g sopra | SPX 5g | % su5 | range g+1 |')
    w('|---|---|---|---|---|---|---|---|---|---|')
    for nome, a, b in [('2006+', '1900', '2099')] + PERIODI:
        x = su.loc[a:b]
        for caso, sel in [('>= 3 cali', x.cali_prima >= 3), ('>= 4 cali', x.cali_prima >= 4), ('0-2 cali', x.cali_prima < 3)]:
            y = x[sel]
            if len(y) < 10:
                continue
            w(f'| {caso} | {nome} | {len(y)} | {y.dVIX.mean():+.2f} | {y["dVIX1%"].mean():+.2f} | {y["dVIX5%"].mean():+.2f} | '
              f'{(y["dVIX5%"] > 0).mean() * 100:.0f} | {y.cc5.mean():+.3f} | {(y.cc5 > 0).mean() * 100:.0f} | {y.range.mean():.2f} |')
    # a parita' di ampiezza del rialzo: rialzo 3-6% (come il 12/11, +6.9% in chiusura)
    w('\nA parita\' di rialzo (VIX tra +3% e +8% nel giorno):\n')
    z = su[(su.dVIX >= 3) & (su.dVIX <= 8)]
    for caso, sel in [('>= 3 cali', z.cali_prima >= 3), ('0-2 cali', z.cali_prima < 3)]:
        y = z[sel]
        if len(y) >= 10:
            t = y['dVIX5%'].mean() / (y['dVIX5%'].std() / math.sqrt(len(y) / 2))
            w(f'- {caso}: n {len(y)}, dVIX 5g {y["dVIX5%"].mean():+.2f}% (t~{t:.1f}, n eff. /2), SPX 5g {y.cc5.mean():+.3f}, '
              f'{(y.cc5 > 0).mean() * 100:.0f}% su, range g+1 {y.range.mean():.2f}')
    w(f'\nBase (tutti i giorni 2006+): dVIX 5g {E["dVIX5%"].mean():+.2f}%, SPX 5g {E.cc5.mean():+.3f}, '
      f'{(E.cc5 > 0).mean() * 100:.0f}% su, range g+1 {E.range.mean():.2f}\n')

    # --- H5 a soglie
    w('## H5: VIX su "piu\' del dovuto" rispetto a SPX (residuo in sd)\n')
    m = pd.concat([P['H5 residuo dVIX% (sd)'].rename('x'), B], axis=1).dropna()
    w('| residuo | periodo | n | range g+1 | C-C g+1 | SPX 5g | % su5 | dVIX 5g % |')
    w('|---|---|---|---|---|---|---|---|')
    for nome, a, b in PERIODI:
        x = m.loc[a:b]
        for caso, sel in [('> +1 sd', x.x > 1), ('-1..+1', x.x.abs() <= 1), ('< -1 sd', x.x < -1)]:
            y = x[sel]
            if len(y) >= 10:
                w(f'| {caso} | {nome} | {len(y)} | {y.range.mean():.2f} | {y.cc1.mean():+.3f} | {y.cc5.mean():+.3f} | '
                  f'{(y.cc5 > 0).mean() * 100:.0f} | {y["dVIX5%"].mean():+.2f} |')
    w('')

    # --- il caso di oggi: giorni simili
    w('## Giorni simili al 12/11\n')
    w('Stessa combinazione: VIX su dopo >= 3 cali, SPX giu\' meno di 1 sigma, COR1M nel quintile basso, '
      'SKEW sotto la mediana 2022+. Pochi casi: e\' una descrizione, non una prova.\n')
    sig_oggi = d.C.shift(1) * d.VIX.shift(1) / 100 / math.sqrt(252)
    ret_s = (d.C - d.C.shift(1)) / sig_oggi
    Q = pd.concat([d.cali_prima, d.dVIX, ret_s.rename('rs'), d.COR1M, d.SKEW, B], axis=1)
    lim_cor = d.COR1M.loc['2022':].quantile(0.2)
    lim_sk = d.SKEW.loc['2022':].median()
    sel = (Q.cali_prima >= 3) & (Q.dVIX > 0) & (Q.rs < 0) & (Q.rs > -1)
    w(f'- solo VIX/SPX: n {sel.sum()} (2006+), SPX 5g {Q[sel].cc5.mean():+.3f}, {(Q[sel].cc5 > 0).mean() * 100:.0f}% su, '
      f'dVIX 5g {Q[sel]["dVIX5%"].mean():+.2f}%')
    sel2 = sel & (Q.COR1M < lim_cor) & (Q.SKEW < lim_sk)
    y = Q[sel2]
    w(f'- + COR1M < {lim_cor:.1f} e SKEW < {lim_sk:.1f}: n {len(y)}' +
      (f', SPX 5g {y.cc5.mean():+.3f}, {(y.cc5 > 0).mean() * 100:.0f}% su, dVIX 5g {y["dVIX5%"].mean():+.2f}%' if len(y) else ''))
    for i, r in y.tail(12).iterrows():
        w(f'  - {i:%d/%m/%Y}: VIX {r.dVIX:+.1f}% dopo {int(r.cali_prima)} cali, SPX {r.rs:+.2f} sigma -> '
          f'g+1 {r.cc1:+.2f}, 5g {r.cc5:+.2f}, dVIX 5g {r["dVIX5%"]:+.1f}%')
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    print(f'Scritto {REPORT}')


def tabella_sera(spx, s):
    """Letture della sera t e range del giorno t+1 in sigma VIX (come /api/vol)."""
    import pandas as pd
    d, P, B = costruisci(spx, s)
    X = pd.DataFrame(index=d.index)
    X['VIX1D/VIX'] = d.VIX1D / d.VIX
    X['VIX9D/VIX'] = d.VIX9D / d.VIX
    X['VIX/VIX3M'] = d.VIX / d.VIX3M
    X['SKEW'] = d.SKEW
    X['VIX'] = d.VIX
    X['VIX3M-VIX9D'] = d.VIX3M - d.VIX9D
    X['COR1M'] = d.COR1M
    X['VIX-ATM30'] = d.VIX - d.ATM30
    X['LTV/VIX'] = d.LTV / d.VIX
    return X, B


def valore_aggiunto():
    """Punto 1: le letture nuove aggiungono qualcosa a quelle gia' in /api/vol?
    Regressione sui ranghi, stimata 2022-2024, provata 2025-2026."""
    import numpy as np, pandas as pd
    spx, s = carica()
    X, B = tabella_sera(spx, s)
    base = ['VIX1D/VIX', 'VIX9D/VIX', 'VIX/VIX3M', 'SKEW', 'VIX']
    m = pd.concat([X, B.range], axis=1).loc['2022-06':].dropna()
    st_, te = m.loc[:'2024-12-31'], m.loc['2025-01-01':]

    def prova(cols):
        # ranghi calcolati sul campione di stima, applicati al test (niente sguardo avanti)
        def rk(df, ref):
            return pd.DataFrame({c: np.searchsorted(np.sort(ref[c].values), df[c].values) / len(ref) for c in cols}, index=df.index)
        A = np.column_stack([rk(st_, st_).values, np.ones(len(st_))])
        k, *_ = np.linalg.lstsq(A, st_.range.rank(pct=True).values, rcond=None)
        prev = np.column_stack([rk(te, st_).values, np.ones(len(te))]) @ k
        rho = pd.Series(prev, index=te.index).corr(te.range, method='spearman')
        return rho, dict(zip(cols, np.round(k[:-1], 3)))
    print(f'Stima {st_.index[0]:%m/%Y}-{st_.index[-1]:%m/%Y} (n {len(st_)}), prova {te.index[0]:%m/%Y}-{te.index[-1]:%m/%Y} (n {len(te)})')
    print('Spearman previsione -> range del giorno dopo, sul periodo di prova:')
    for nome, cols in [('solo VIX1D/VIX (guida attuale)', ['VIX1D/VIX']),
                       ('le 5 di /api/vol', base)] + \
                      [(f'5 + {c}', base + [c]) for c in ['VIX3M-VIX9D', 'COR1M', 'VIX-ATM30', 'LTV/VIX']] + \
                      [('5 + tutte e 4', base + ['VIX3M-VIX9D', 'COR1M', 'VIX-ATM30', 'LTV/VIX'])]:
        rho, k = prova(cols)
        print(f'  {nome:34s} rho {rho:+.3f}   pesi {k}')
    for c in X.columns:
        print(f'  da sola {c:12s} 2022-24 {st_[c].corr(st_.range, method="spearman"):+.3f}  2025-26 {te[c].corr(te.range, method="spearman"):+.3f}')


def conferma_per_giornata():
    """Punto 2: la conferma sui range OB va meglio nelle giornate previste strette?"""
    import pandas as pd
    import studio_conferma_range as CR
    spx, s = carica()
    X, B = tabella_sera(spx, s)
    st_ = X.loc['2022':]
    righe = []
    for f in sorted(os.listdir(os.path.join(CR.RADICE, 'bookmap'))):
        g = f[:10]
        if not f.endswith('.ndjson'):
            continue
        prima = X.index[X.index < pd.Timestamp(g)]
        if not len(prima):
            continue
        sera = X.loc[prima[-1]]
        ops, nota = CR.conferme(g)
        if ops is None:
            continue
        r = [o['esito'] - CR.COSTO for o in ops if o['tipo'] == 'range' and o['esito'] is not None]
        rng = B.range.get(prima[-1])
        righe.append(dict(giorno=g, n=len(r), netto=sum(r), vinte=sum(x > 0 for x in r), range_vero=rng,
                          **{f'p {c}': (st_[c].dropna() < sera[c]).mean() * 100 for c in ['VIX1D/VIX', 'VIX3M-VIX9D', 'SKEW', 'COR1M']}))
    T = pd.DataFrame(righe).set_index('giorno')
    T = T[T.n > 0]   # prima del 13/10 i range non erano salvati
    pd.set_option('display.width', 200)
    print(T.round(2).to_string())
    print(f'\nSpearman fra giornate (n {len(T)}): netto della conferma contro')
    for c in [c for c in T.columns if c.startswith('p ')] + ['range_vero']:
        print(f'  {c:16s} {T.netto.corr(T[c], method="spearman"):+.2f}')
    for c in ['p VIX1D/VIX', 'p VIX3M-VIX9D', 'p SKEW']:
        # giornata prevista stretta: VIX1D/VIX basso, curva larga, SKEW alto
        # divisi alla mediana di queste giornate (lo SKEW e' stato sopra il 50 percentile in tutte)
        stretta = T[c] < T[c].median() if c == 'p VIX1D/VIX' else T[c] >= T[c].median()
        for nome, x in [('prevista stretta', T[stretta]), ('prevista ampia', T[~stretta])]:
            if len(x):
                print(f'  {c:16s} {nome:16s} giornate {len(x):2d}  operazioni {int(x.n.sum()):3d}  netto {x.netto.sum():+7.2f}  '
                      f'a operazione {x.netto.sum() / max(1, x.n.sum()):+.2f}  vinte {x.vinte.sum() / max(1, x.n.sum()):.0%}')


if __name__ == '__main__':
    if '--piano' in sys.argv:
        piano_ibkr()
    elif '--scarica' in sys.argv:
        scarica()
    elif '--contesto' in sys.argv:
        valore_aggiunto()
    elif '--conferma' in sys.argv:
        sys.stdout.reconfigure(encoding='utf-8')
        conferma_per_giornata()
    else:
        analizza()
