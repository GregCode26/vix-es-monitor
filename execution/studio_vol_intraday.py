"""Studio intraday sulla volatilita' (03/11/2026), barre da 5 minuti IBKR.

Seguito di studio_vol.py: a livello giornaliero la term structure prevede
l'ampiezza ma non la direzione. Qui le domande sono dentro la seduta, con
VIX1D (la vol a 1 giorno, il parente piu' vicino dell'IV 0DTE) e SPX:
- H1: la variazione di VIX1D degli ultimi 15/30 minuti, al netto di quanto
  spiega SPX stesso (residuo), anticipa SPX nei 15/30/60 minuti dopo?
- H2: divergenze. SPX scende e VIX1D non sale (o sale e VIX1D non scende):
  rimbalzo o continuazione?
- H3: movimento atteso consumato. Alle 10:30/12:00/14:00, quanto del movimento
  prezzato all'apertura e' gia' stato fatto: dice qualcosa sul resto della
  giornata (ampiezza e prosecuzione)?
- H4: VIX1D contro la vol realizzata fin li' oggi: prevede il range del resto?
Le misure sono in sigma di VIX1D del momento (sigma per barra =
SPX * VIX1D / 100 / sqrt(252 * 78)), le correlazioni su campioni NON
sovrapposti, e i periodi divisi in due meta' per vedere se l'effetto tiene.

Risultati del 03/11 (864 giornate, 05/2023-11/2026, 129 richieste):
- anche dentro la seduta VIX1D sovrastima: i rendimenti a 15-60 min hanno
  dev. std 0.73-0.78 sigma di VIX1D, il range del resto 1.26/1.10/0.97
  (10:30/12:00/14:00) contro ~1.6;
- H1: la variazione di VIX1D, grezza o al netto di SPX, non anticipa SPX
  (|rho| <= 0.034 a 15/30/60 min, in entrambe le meta');
- H2: l'unico candidato. SPX giu' > 1 sigma in 30 min con VIX1D che NON sale:
  +0.14 sigma a 60 min, 59% su (n 172; 58% e 61% nelle due meta'). Con VIX1D
  che sale piu' del solito: -0.10, 47% su (n 310). Il rovescio sul rialzo e'
  debole. Su 12 caselle testate: da confermare fuori campione;
- H3: il movimento atteso gia' consumato non dice nulla ne' sul resto del
  range (rho <= 0.04) ne' sulla prosecuzione. H4: la vol realizzata finora
  rispetto a VIX1D prevede il range del resto (+0.13/+0.13/+0.18), non la
  direzione.

Scarico: stessi limiti di studio_vol.py (classe Ritmo: 50 richieste ogni 10
min, 3 s fra due richieste, pausa di 10 min su violazione), un mese per
richiesta, cache in .tmp/studio_vol_intraday/ (il mese corrente si riscarica
se il file e' di un giorno precedente). --piano stampa le richieste e il tempo
senza connettersi.

Uso:
  python execution/studio_vol_intraday.py --piano
  python execution/studio_vol_intraday.py --scarica
  python execution/studio_vol_intraday.py          # -> .tmp/studio_vol_intraday.md
  python execution/studio_vol_intraday.py --calibra # -> frontend/src/lib/volCalibrazioneIntraday.ts (bande e divergenze di /api/vol)
"""
import calendar, json, math, os, random, sys, time
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from studio_vol import Ritmo, MAX_FINESTRA, FINESTRA, GAP_MIN, ATTESA_PACING  # noqa: E402

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE = os.path.join(RADICE, '.tmp', 'studio_vol_intraday')
REPORT = os.path.join(RADICE, '.tmp', 'studio_vol_intraday.md')
SIMBOLI = ['SPX', 'VIX1D', 'VIX']
INIZIO = (2023, 5)            # VIX1D esiste dal 24/04/2023
STIMA_RISPOSTA = 5.0
BARRE_GIORNO = 78


def mesi():
    a, m = INIZIO
    oggi = date.today()
    while (a, m) <= (oggi.year, oggi.month):
        yield a, m
        a, m = (a + 1, 1) if m == 12 else (a, m + 1)


def file_mese(s, a, m):
    return os.path.join(CACHE, f'{s}_{a}-{m:02d}.json')


def da_scaricare(s, a, m):
    f = file_mese(s, a, m)
    if not os.path.exists(f):
        return True
    oggi = date.today()
    if (a, m) == (oggi.year, oggi.month):
        return date.fromtimestamp(os.path.getmtime(f)) < oggi
    return False


def piano():
    tutti = [(s, a, m) for s in SIMBOLI for a, m in mesi()]
    mancanti = [x for x in tutti if da_scaricare(*x)]
    n = len(mancanti)
    pause = max(0, math.ceil(n / MAX_FINESTRA) - 1)
    stima = n * max(GAP_MIN, STIMA_RISPOSTA) + pause * FINESTRA
    print(f'Piano: {len(SIMBOLI)} simboli x {len(tutti) // len(SIMBOLI)} mesi di barre da 5 min (solo RTH)')
    print(f'  in cache: {len(tutti) - n}   da richiedere: {n}')
    print(f'  limite usato: {MAX_FINESTRA} ogni {FINESTRA // 60} min (IBKR 60), almeno {GAP_MIN:.0f} s fra due richieste')
    print(f'  tempo stimato: ~{stima / 60:.0f} min' + (f' (incluse {pause} pause da 10 min)' if pause else ''))
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
    oggi = date.today()
    vuote = 0
    for s, a, m in mancanti:
        if s not in contratti:
            continue
        corrente = (a, m) == (oggi.year, oggi.month)
        fine = '' if corrente else f'{a}{m:02d}{calendar.monthrange(a, m)[1]:02d}-23:59:59'
        for tentativo in (1, 2):
            ritmo.aspetta()
            errori.clear()
            barre = ib.reqHistoricalData(contratti[s], endDateTime=fine, durationStr='1 M',
                                         barSizeSetting='5 mins', whatToShow='TRADES',
                                         useRTH=True, formatDate=2, timeout=180)
            if any(code in (162, 366) and 'pacing' in msg.lower() for code, msg in errori) and tentativo == 1:
                print(f'  {s} {a}-{m:02d}: violazione di ritmo, attendo {ATTESA_PACING} s')
                time.sleep(ATTESA_PACING)
                continue
            break
        # formatDate=2: datetime UTC; tengo solo le barre del mese richiesto
        righe = [{'t': int(b.date.timestamp()), 'o': b.open, 'h': b.high, 'l': b.low, 'c': b.close}
                 for b in barre if (b.date.year, b.date.month) == (a, m)]
        msg = '; '.join(f'{c} {t[:70]}' for c, t in errori if c not in (2104, 2106, 2158))
        print(f'  [{ritmo.fatte}] {s} {a}-{m:02d}: {len(righe)} barre' + (f'  {msg}' if msg else ''))
        if righe:
            vuote = 0
            with open(file_mese(s, a, m), 'w') as f:
                json.dump(righe, f)
        else:
            vuote += 1
            if vuote >= 3:
                print('  3 risposte vuote di fila: mi fermo per non sprecare richieste, controlla l\'errore sopra')
                break
    ib.disconnect()
    print(f'Fatte {ritmo.fatte} richieste storiche.')


# ---------------------------------------------------------------- analisi

def carica():
    import pandas as pd
    out = {}
    for s in SIMBOLI:
        righe = {}
        for a, m in mesi():
            f = file_mese(s, a, m)
            if os.path.exists(f):
                for r in json.load(open(f)):
                    righe[r['t']] = r
        if righe:
            df = pd.DataFrame(sorted(righe.values(), key=lambda r: r['t']))
            df.index = pd.to_datetime(df.t, unit='s', utc=True).dt.tz_convert('America/New_York')
            out[s] = df.drop(columns='t')
    return out


def prepara(serie):
    import numpy as np, pandas as pd
    d = pd.DataFrame({'S': serie['SPX'].c, 'H': serie['SPX'].h, 'L': serie['SPX'].l})
    d['V1'] = serie['VIX1D'].c.reindex(d.index)
    d = d[(d.index.time >= datetime.strptime('09:30', '%H:%M').time()) &
          (d.index.time < datetime.strptime('16:00', '%H:%M').time())]
    d['giorno'] = d.index.date
    conta = d.groupby('giorno').S.transform('size')
    d = d[(conta >= 76) & d.V1.notna() & (d.V1 > 0)].copy()     # giornate intere (niente mezze sedute)
    d['i'] = d.groupby('giorno').cumcount()                     # barra 0 = 9:30-9:35
    d['sig'] = d.S * d.V1 / 100 / math.sqrt(252 * BARRE_GIORNO)  # sigma per barra, in punti
    g = d.groupby('giorno')
    for k in (3, 6):
        d[f'dS{k}'] = (d.S - g.S.shift(k)) / (d.sig * math.sqrt(k))
        d[f'dV{k}'] = d.V1 - g.V1.shift(k)
    for h in (3, 6, 12):
        d[f'f{h}'] = (g.S.shift(-h) - d.S) / (d.sig * math.sqrt(h))
    # resto della giornata
    d['Cgiorno'] = g.S.transform('last')
    d['Hres'] = g.H.transform(lambda x: x[::-1].cummax()[::-1].shift(-1))
    d['Lres'] = g.L.transform(lambda x: x[::-1].cummin()[::-1].shift(-1))
    d['Hfin'] = g.H.cummax()
    d['Lfin'] = g.L.cummin()
    d['Oday'] = g.S.transform('first')
    d['V1open'] = g.V1.transform(lambda x: x.iloc[1])           # VIX1D alle 9:40 (la prima stampa e' rumorosa)
    r = np.log(d.S / g.S.shift(1))
    d['rv'] = r.pow(2).groupby(d.giorno).cumsum()
    return d


def corr_tab(w, d, xcol, ycols, filtro, passo, titolo):
    import pandas as pd
    w(f'### {titolo}\n')
    w('| periodo | n | ' + ' | '.join(ycols) + ' |')
    w('|---|---|' + '---|' * len(ycols))
    x = d[filtro & (d.i % passo == 0)]
    for nome, sub in [('tutto', x), ('2023-24', x[x.index.year <= 2024]), ('2025-26', x[x.index.year >= 2025])]:
        m = sub[[xcol] + ycols].dropna()
        c = m.corr(method='spearman')[xcol]
        w(f'| {nome} | {len(m)} | ' + ' | '.join(f'{c[y]:+.3f}' for y in ycols) + ' |')
    w('')


def quint(w, d, xcol, ycols, filtro, passo, titolo):
    import pandas as pd
    x = d[filtro & (d.i % passo == 0)][[xcol] + ycols].dropna()
    x['q'] = pd.qcut(x[xcol], 5, labels=False, duplicates='drop') + 1
    g = x.groupby('q')
    w(f'### {titolo}\n')
    w('| q | da | a | n | ' + ' | '.join(f'{y} medio' for y in ycols) + ' | % ' + ycols[0] + ' > 0 |')
    w('|---|---|---|---|' + '---|' * (len(ycols) + 1))
    for q, s in g:
        w(f'| {q} | {s[xcol].min():+.2f} | {s[xcol].max():+.2f} | {len(s)} | ' +
          ' | '.join(f'{s[y].mean():+.3f}' for y in ycols) + f' | {(s[ycols[0]] > 0).mean() * 100:.0f} |')
    w('')


def analizza():
    import numpy as np, pandas as pd
    serie = carica()
    if not all(s in serie for s in ('SPX', 'VIX1D')):
        print('Mancano SPX o VIX1D: lancia prima --scarica')
        return
    d = prepara(serie)
    giorni = d.giorno.nunique()
    out = []
    w = out.append
    w(f'# Studio vol intraday - {datetime.now():%d/%m/%Y %H:%M}\n')
    w(f'Barre da 5 min RTH, {giorni} giornate intere ({d.giorno.min()} -> {d.giorno.max()}). '
      'Rendimenti in sigma di VIX1D del momento; correlazioni di Spearman su campioni non sovrapposti '
      '(una barra ogni orizzonte). Con n ~ 2000 sotto |0.045| e\' rumore, con n ~ 8000 sotto |0.022|.\n')
    finestra = (d.i >= 3) & (d.i <= 66)       # 9:45 - 15:00 ET: VIX1D vicino alla chiusura cambia natura
    w('## Base\n')
    for h in (3, 6, 12):
        x = d[finestra & (d.i % h == 0)][f'f{h}'].dropna()
        w(f'- {h * 5} min: dev. std dei rendimenti futuri in sigma VIX1D = {x.std():.2f} (1.00 = VIX1D prezza giusto), n {len(x)}')
    w('')

    # H1: residuo di VIX1D rispetto a SPX
    w('## H1 - variazione di VIX1D al netto di SPX -> SPX dopo\n')
    for k in (3, 6):
        m = d[finestra & d[f'dS{k}'].notna() & d[f'dV{k}'].notna()]
        tr = m[m.index.year <= 2024]
        beta = np.polyfit(tr[f'dS{k}'], tr[f'dV{k}'], 1)       # stimato solo sulla prima meta'
        d[f'res{k}'] = d[f'dV{k}'] - np.polyval(beta, d[f'dS{k}'])
        w(f'- {k * 5} min: dVIX1D = {beta[0]:+.3f} x dSPX(sigma) {beta[1]:+.3f} (stimato 2023-24)')
    w('')
    for k in (3, 6):
        corr_tab(w, d, f'res{k}', ['f3', 'f6', 'f12'], finestra, 6, f'residuo VIX1D {k * 5} min -> SPX tra 15/30/60 min')
        corr_tab(w, d, f'dV{k}', ['f3', 'f6', 'f12'], finestra, 6, f'dVIX1D grezzo {k * 5} min -> SPX tra 15/30/60 min')
        corr_tab(w, d, f'dS{k}', ['f3', 'f6', 'f12'], finestra, 6, f'(controllo) SPX ultimi {k * 5} min -> SPX dopo')
    quint(w, d, 'res6', ['f6', 'f12'], finestra, 6, 'quintili del residuo VIX1D 30 min')

    # H2: divergenze sui 30 minuti
    w('## H2 - divergenze SPX / VIX1D sui 30 minuti\n')
    x = d[finestra & (d.i % 6 == 0)].dropna(subset=['dS6', 'res6', 'f6', 'f12']).copy()
    sdv = x.res6.std()
    x['caso'] = np.select(
        [(x.dS6 < -1) & (x.res6 < -0.5 * sdv), (x.dS6 < -1) & (x.res6 > 0.5 * sdv),
         (x.dS6 > 1) & (x.res6 > 0.5 * sdv), (x.dS6 > 1) & (x.res6 < -0.5 * sdv),
         (x.dS6 < -1), (x.dS6 > 1)],
        ['SPX giu, vol NON sale (div.)', 'SPX giu, vol sale piu\' del solito', 'SPX su, vol NON scende (div.)',
         'SPX su, vol scende piu\' del solito', 'SPX giu, vol normale', 'SPX su, vol normale'], 'SPX fermo')
    w(f'SPX "giu/su" = oltre 1 sigma in 30 min; vol "non sale/sale" = residuo oltre mezza dev. std ({0.5 * sdv:.2f} punti).\n')
    w('| caso | periodo | n | SPX 30 min dopo | SPX 60 min dopo | % su a 60 min |')
    w('|---|---|---|---|---|---|')
    for caso, s in x.groupby('caso'):
        for nome, sub in [('tutto', s), ('2023-24', s[s.index.year <= 2024]), ('2025-26', s[s.index.year >= 2025])]:
            if len(sub):
                w(f'| {caso} | {nome} | {len(sub)} | {sub.f6.mean():+.3f} | {sub.f12.mean():+.3f} | {(sub.f12 > 0).mean() * 100:.0f} |')
    w('')

    # H3 / H4: a orari fissi
    w('## H3/H4 - movimento consumato e vol realizzata, a orari fissi\n')
    w('consumato = range fatto dall\'apertura / movimento atteso all\'apertura (SPX x VIX1D delle 9:40 / sqrt(252)); '
      'resto = range da li\' alla chiusura / movimento atteso del resto (VIX1D del momento x sqrt(barre rimaste/78)); '
      'prosegue = (chiusura - prezzo) nella direzione del movimento fatto, in sigma del resto; '
      'RV/IV = vol realizzata finora (annualizzata) / VIX1D.\n')
    righe = []
    for ora, i in [('10:30', 11), ('12:00', 29), ('14:00', 53)]:
        x = d[d.i == i].copy()
        rimaste = BARRE_GIORNO - 1 - i
        em_open = x.Oday * x.V1open / 100 / math.sqrt(252)
        em_res = x.S * x.V1 / 100 / math.sqrt(252) * math.sqrt(rimaste / BARRE_GIORNO)
        x['consumato'] = (x.Hfin - x.Lfin) / em_open
        x['resto'] = (np.maximum(x.Hres, x.S) - np.minimum(x.Lres, x.S)) / em_res
        x['prosegue'] = np.sign(x.S - x.Oday) * (x.Cgiorno - x.S) / em_res
        x['RV/IV'] = np.sqrt(x.rv * 252 * BARRE_GIORNO / (i + 1)) * 100 / x.V1
        x['ora'] = ora
        righe.append(x)
    t = pd.concat(righe)
    for ora, x in t.groupby('ora'):
        c = x[['consumato', 'RV/IV', 'resto', 'prosegue']].dropna().corr(method='spearman')
        w(f'### {ora} ET (n {len(x)})\n')
        w(f'- resto medio {x.resto.mean():.2f} (moto browniano ~1.6), prosegue medio {x.prosegue.mean():+.3f}')
        w(f'- Spearman consumato -> resto {c.loc["consumato", "resto"]:+.3f}, -> prosegue {c.loc["consumato", "prosegue"]:+.3f}; '
          f'RV/IV -> resto {c.loc["RV/IV", "resto"]:+.3f}, -> prosegue {c.loc["RV/IV", "prosegue"]:+.3f}\n')
        x = x.dropna(subset=['consumato', 'resto', 'prosegue'])
        x['q'] = pd.qcut(x.consumato, 5, labels=False, duplicates='drop') + 1
        w('| quintile consumato | da | a | n | resto | prosegue | % prosegue > 0 |')
        w('|---|---|---|---|---|---|---|')
        for q, s in x.groupby('q'):
            w(f'| {q} | {s.consumato.min():.2f} | {s.consumato.max():.2f} | {len(s)} | {s.resto.mean():.2f} | '
              f'{s.prosegue.mean():+.3f} | {(s.prosegue > 0).mean() * 100:.0f} |')
        w('')
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    print(f'Scritto {REPORT}')




# ---------------------------------------------------------------- calibrazione per l'app

TS_INTRADAY = os.path.join(RADICE, 'frontend', 'src', 'lib', 'volCalibrazioneIntraday.ts')
FASCIA = 6          # barre per fascia oraria (30 minuti)


def _quantili(d, i_min, i_max):
    """Per fascia di 30 min e terzile RV/IV: quantili 68/95% di |chiusura - S| / movimento atteso del resto."""
    import numpy as np, pandas as pd
    x = d[(d.i >= i_min) & (d.i <= i_max)].copy()
    rimaste = BARRE_GIORNO - 1 - x.i
    em_res = x.S * x.V1 / 100 / math.sqrt(252) * np.sqrt(rimaste / BARRE_GIORNO)
    x['z'] = (x.Cgiorno - x.S).abs() / em_res
    x['rviv'] = np.sqrt(x.rv * 252 * BARRE_GIORNO / (x.i + 1)) * 100 / x.V1
    x['fascia'] = x.i // FASCIA
    return x.dropna(subset=['z', 'rviv'])


def calibra():
    import numpy as np, pandas as pd
    d = prepara(carica())
    x = _quantili(d, 3, 74)            # 9:45 - 15:50 ET
    tr, te = x[x.index.year <= 2024], x[x.index.year >= 2025]

    def tabella(base):
        fasce = []
        for f, g in base.groupby('fascia'):
            bordi = list(np.quantile(g.rviv, [1 / 3, 2 / 3]))
            g = g.assign(b=np.digitize(g.rviv, bordi))
            celle = [[round(float(np.quantile(c.z, 0.68)), 3), round(float(np.quantile(c.z, 0.95)), 3)]
                     for _, c in g.groupby('b')]
            fasce.append({'fascia': int(f), 'bordiRvIv': [round(b, 3) for b in bordi], 'q': celle})
        return fasce

    def copertura(fasce, base):
        dentro68 = dentro95 = sigma1 = n = 0
        per = {t['fascia']: t for t in fasce}
        for f, g in base.groupby('fascia'):
            t = per[f]
            b = np.digitize(g.rviv, t['bordiRvIv'])
            q68 = np.array([t['q'][k][0] for k in b]); q95 = np.array([t['q'][k][1] for k in b])
            dentro68 += (g.z <= q68).sum(); dentro95 += (g.z <= q95).sum(); sigma1 += (g.z <= 1).sum(); n += len(g)
        return dentro68 / n * 100, dentro95 / n * 100, sigma1 / n * 100, n

    c = copertura(tabella(tr), te)
    print(f'Fuori campione (stima 2023-24, prova 2025-26, n {c[3]}): banda 68% contiene la chiusura nel {c[0]:.1f}%, '
          f'banda 95% nel {c[1]:.1f}%; il vecchio +-1 sigma di VIX1D nel {c[2]:.1f}%')

    # divergenze: beta/alfa/dev. std del residuo sui 30 minuti, stimati sulla prima meta' come nello studio
    m = d[(d.i >= 3) & (d.i <= 66) & d.dS6.notna() & d.dV6.notna()]
    m1 = m[m.index.year <= 2024]
    beta, alfa = np.polyfit(m1.dS6, m1.dV6, 1)
    sd = float((m1.dV6 - np.polyval([beta, alfa], m1.dS6)).std())
    fasce = tabella(x)                  # quella usata dall'app: su tutto lo storico
    oggi = datetime.now().strftime('%d/%m/%Y')
    with open(TS_INTRADAY, 'w', encoding='utf-8') as f:
        f.write(f'''/**
 * Generato da `python execution/studio_vol_intraday.py --calibra` il {oggi}: non
 * modificare a mano, rilanciare lo script.
 *
 * Barre da 5 minuti SPX e VIX1D, {d.giorno.min()} -> {d.giorno.max()} ({d.giorno.nunique()} giornate).
 * - `fasce`: per fascia di 30 minuti dalle 9:30 ET (fascia = barra // 6) e per
 *   terzile di RV/IV (vol realizzata da inizio giornata / VIX1D), i quantili 68% e
 *   95% di |chiusura - SPX| in unita' di movimento atteso del resto da VIX1D.
 *   Fuori campione (stima 2023-24, prova 2025-26): la banda 68% conteneva la
 *   chiusura nel {c[0]:.1f}% dei casi, la 95% nel {c[1]:.1f}%; il +-1 sigma di VIX1D nel {c[2]:.1f}%.
 * - `divergenze`: dVIX1D(30 min) = beta x dSPX(30 min, in sigma) + alfa, dev. std
 *   del residuo (stimati 2023-24).
 */
export const VOL_INTRADAY = {json.dumps({'fasce': fasce, 'barreGiorno': BARRE_GIORNO, 'barrePerFascia': FASCIA,
         'divergenze': {'beta': round(float(beta), 4), 'alfa': round(float(alfa), 4), 'sdResiduo': round(sd, 4),
                        'sogliaSpx': 1.0, 'sogliaResiduo': 0.5, 'barre': 6, 'barraMin': 6, 'barraMax': 66, 'riarmoBarre': 6}},
         )} as const;
''')
    print(f'Scritto {TS_INTRADAY}')


if __name__ == '__main__':
    if '--piano' in sys.argv:
        piano()
    elif '--scarica' in sys.argv:
        scarica()
    elif '--calibra' in sys.argv:
        calibra()
    else:
        analizza()
