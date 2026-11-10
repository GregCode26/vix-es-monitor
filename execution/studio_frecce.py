"""Le frecce sulla curva dello smile (convexity ladder) danno un'informazione valida?

Le frecce di lib/smileChart.ts sono la gamma netta dei taker per strike, stimata con
Lee-Ready: conv = gamma x ((cb-cs)+(pb-ps)) x 100 x spot^2 x 0.01 / 1e6. Azzurra = taker
lunghi di convessita' (dealer corti), arancio = taker corti (dealer lunghi). NON misurano
lo spostamento della curva, che qui si confronta a parte.

Solo file locali: volumes/, market/, smile/ (nessuna richiesta a IBKR o Supabase).

  python execution/studio_frecce.py [--dal YYYY-MM-DD] [--json percorso]

Domande:
  1. Taker lunghi => mercato piu' mosso? (somma delle frecce contro la volatilita' dopo)
  2. Direzione: sbilanciamento sopra/sotto lo spot, netto, flusso recente, posizione della
     freccia maggiore, contro il rendimento dopo.
  3. La curva: il flusso di convessita' anticipa IV ATM e Tilt?
  4. Il tocco di uno strike con freccia grande: arancio rimbalza, azzurra rompe?
     Etichette permutate dentro il giorno come null; ogni tocco pesa uguale.
Ogni misura usa solo la fotografia gia' nota in quel minuto. Il flusso e' per strike e solo
fra strike presenti in entrambe le fotografie: i cali del totale sono ricentraggi della
catena, non azzeramenti. Per i controlli vedi studio_ivmin.py.
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from studio_ivmin import RADICE, null_circolare, bh, senza_media, secondi, stampa, corr, RNG


def parziale(g, x, y, ctrl):
    """Residuo di x sul controllo, dentro il giorno: la parte di x che il controllo non spiega."""
    a = g[[x, ctrl]].to_numpy(float)
    ok = ~np.isnan(a).any(axis=1)
    fuori = np.full(len(g), np.nan)
    if ok.sum() > 30 and a[ok, 1].std() > 0:
        fuori[ok] = a[ok, 0] - np.polyval(np.polyfit(a[ok, 1], a[ok, 0], 1), a[ok, 1])
    return fuori

APERTURA, CHIUSURA, INIZIO = 9 * 60 + 30, 16 * 60, 9 * 60 + 35
SOGLIA_GRANDE, SOGLIA_PICCOLA = 0.5, 0.05  # la pagina non disegna sotto il 5% della maggiore
ARMA, VICINO = 5.0, 1.0


def fuso(giorno):
    d = datetime.strptime(giorno, '%Y-%m-%d').replace(hour=12)
    a = d.replace(tzinfo=ZoneInfo('Europe/Rome')).utcoffset()
    b = d.replace(tzinfo=ZoneInfo('America/New_York')).utcoffset()
    return int((a - b).total_seconds())


def carica(giorno):
    off = fuso(giorno)
    with open(os.path.join(RADICE, 'volumes', giorno + '.json'), encoding='utf-8') as f:
        vol = json.load(f)
    foto = {}
    hi, lo, spot = {}, {}, {}
    for s in vol:
        m = (secondi(s['time']) - off) // 60
        if not APERTURA <= m <= CHIUSURA:
            continue
        sp = s.get('spxPrice')
        if not sp:
            continue
        spot[m] = sp
        hi[m] = max(hi.get(m, sp), sp)
        lo[m] = min(lo.get(m, sp), sp)
        r = {}
        for x in s.get('volumes') or []:
            if x.get('gamma') is None or x.get('cb') is None or x.get('ps') is None:
                continue
            r[x['strike']] = (x['gamma'], (x['cb'] - x['cs']) + (x['pb'] - x['ps']))
        if r:
            foto[m] = r  # l'ultima del minuto
    if len(foto) < 60:
        return None

    with open(os.path.join(RADICE, 'market', giorno + '.json'), encoding='utf-8') as f:
        mercato = json.load(f)
    es, stra = {}, {}
    for p in mercato:
        m = (secondi(p['time']) - off) // 60
        if p.get('esf') and p['esf'] > 0:
            es[m] = p['esf']
        c = [p.get(k) for k in ('callBid', 'callAsk', 'putBid', 'putAsk')]
        if all(v is not None and v > 0 for v in c):
            stra[m] = sum(c) / 2

    ind = pd.RangeIndex(APERTURA, CHIUSURA + 1, name='min')
    d = pd.DataFrame(index=ind)
    d['spot'] = pd.Series(spot).reindex(ind).ffill(limit=2)
    d['hi'] = pd.Series(hi).reindex(ind)
    d['lo'] = pd.Series(lo).reindex(ind)
    d['es'] = pd.Series(es).reindex(ind).ffill(limit=2)
    # 1 sigma alla chiusura dallo straddle ATM, liscio perche' lo straddle salta col centro strike.
    d['sig'] = (pd.Series(stra).reindex(ind).rolling(15, min_periods=3).median() * 1.2533).ffill(limit=5)
    rest = np.maximum(CHIUSURA - d.index.to_numpy(), 15)
    d['s1'] = d['sig'] / np.sqrt(rest)

    # Smile, dove c'e': per la domanda sulla curva.
    per = os.path.join(RADICE, 'smile', giorno + '.ndjson')
    d['iva'] = np.nan
    d['tiltN'] = np.nan
    if os.path.exists(per):
        ia, ti = {}, {}
        with open(per, encoding='utf-8') as f:
            for riga in f:
                if riga.strip():
                    r = json.loads(riga)
                    if r.get('v') == 2 and r.get('tEt'):
                        m = secondi(r['tEt']) // 60
                        ia[m], ti[m] = r.get('ivAtm'), r.get('tiltN')
        if ia:
            d['iva'] = pd.Series(ia, dtype=float).reindex(ind).ffill(limit=2)
            d['tiltN'] = pd.Series(ti, dtype=float).reindex(ind).ffill(limit=2)

    # Misure per minuto.
    col = {c: {} for c in ('netto', 'lordo', 'sopra', 'sotto', 'posMax', 'segnoMax')}
    conv_per = {}
    for m, r in foto.items():
        s = spot.get(m)
        if not s:
            continue
        conv = {k: g * n * 100 * s * s * 0.01 / 1e6 for k, (g, n) in r.items()}
        conv_per[m] = conv
        lordo = sum(abs(v) for v in conv.values())
        if lordo <= 0:
            continue
        col['netto'][m] = sum(conv.values()) / lordo
        col['lordo'][m] = lordo
        col['sopra'][m] = sum(v for k, v in conv.items() if k > s) / lordo
        col['sotto'][m] = sum(v for k, v in conv.items() if k < s) / lordo
        kmax = max(conv, key=lambda k: abs(conv[k]))
        sg = d.at[m, 'sig'] if m in d.index else np.nan
        col['posMax'][m] = (kmax - s) / sg if sg and sg > 0 else np.nan
        col['segnoMax'][m] = np.sign(conv[kmax])
    for c, v in col.items():
        d[c] = pd.Series(v, dtype=float).reindex(ind)
    d['sbil'] = d['sopra'] - d['sotto']
    # La freccia maggiore pesa col suo segno: azzurra sopra e arancio sotto spingono nello stesso verso.
    d['posFirm'] = d['posMax'] * d['segnoMax']

    # Flusso: variazione delle posizioni per strike, alla gamma di adesso, sul lordo di adesso.
    for h in (5, 15, 30):
        fl, fls = {}, {}
        for m, r in foto.items():
            pr = foto.get(m - h)
            s = spot.get(m)
            if pr is None or not s or col['lordo'].get(m, 0) <= 0:
                continue
            tot = up = dn = 0.0
            for k, (g, n) in r.items():
                if k in pr:
                    v = g * (n - pr[k][1]) * 100 * s * s * 0.01 / 1e6
                    tot += v
                    if k > s:
                        up += v
                    elif k < s:
                        dn += v
            fl[m] = tot / col['lordo'][m]
            fls[m] = (up - dn) / col['lordo'][m]
        d[f'fl{h}'] = pd.Series(fl, dtype=float).reindex(ind)
        d[f'fls{h}'] = pd.Series(fls, dtype=float).reindex(ind)

    # Obiettivi.
    r1 = (d['es'].diff() / d['s1'])
    for h in (15, 30, 60):
        d[f'fw{h}'] = (d['es'].shift(-h) - d['es']) / (d['s1'] * np.sqrt(h))
        d[f'fwp{h}'] = d['es'].shift(-h) - d['es']
        d[f'a{h}'] = d[f'fw{h}'].abs()
        # Volatilita' realizzata dopo, in unita' di quella attesa.
        d[f'rv{h}'] = np.sqrt((r1 ** 2).rolling(h, min_periods=int(h * .7)).mean().shift(-h))
        d[f'div{h}'] = d['iva'].shift(-h) - d['iva']
        d[f'dti{h}'] = d['tiltN'].shift(-h) - d['tiltN']
    d['rvPrima30'] = np.sqrt((r1 ** 2).rolling(30, min_periods=20).mean())
    d['pa15'] = d['es'] - d['es'].shift(15)
    d['pa30'] = d['es'] - d['es'].shift(30)
    d['divPrima15'] = d['iva'] - d['iva'].shift(15)
    d['absnetto'] = d['netto'].abs()
    d['fascia'] = (d.index // 30) * 30
    d['giorno'] = giorno
    d.attrs['conv'] = conv_per
    return d


def senza_ora(giorni, colonne):
    """Toglie la media di ogni fascia di 30 minuti, calcolata su tutti i giorni."""
    tutti = pd.concat(giorni)
    medie = {c: tutti.groupby('fascia')[c].mean() for c in colonne}
    fuori = []
    for g in giorni:
        t = g.copy()
        for c in colonne:
            t[c] = t[c] - t['fascia'].map(medie[c])
        fuori.append(t)
    return fuori


def prova(giorni, grande, x, y):
    gs = senza_ora(giorni, [x, y])
    r, n, p = null_circolare(gs, x, y)
    rs, _, ps = null_circolare([g for g in gs if g['giorno'].iloc[0] != grande], x, y)
    rd, _, pdd = null_circolare(senza_media(gs, [x, y]), x, y)
    per = [corr(g[x].to_numpy(float), g[y].to_numpy(float))[0] for g in senza_media(gs, [x, y])]
    return dict(x=x, y=y, n=n, r=r, p=p, rSenza=rs, pSenza=ps, rDentro=rd, pDentro=pdd,
                giorniPiu=sum(1 for v in per if v == v and v > 0), giorni=sum(1 for v in per if v == v))


def tocchi(g):
    """Ogni primo tocco di uno strike dopo esserne stati lontani >= ARMA, con la freccia nota al minuto prima."""
    conv_per = g.attrs['conv']
    righe = []
    armati = {}
    minuti = [m for m in g.index if m >= INIZIO and not np.isnan(g.at[m, 'spot']) and not np.isnan(g.at[m, 'hi'])]
    for m in minuti:
        s, h, l = g.at[m, 'spot'], g.at[m, 'hi'], g.at[m, 'lo']
        conv = conv_per.get(m - 1) or conv_per.get(m - 2)
        if not conv:
            continue
        mx = max((abs(v) for v in conv.values()), default=0)
        for k, v in conv.items():
            dd = s - k
            if abs(dd) >= ARMA:
                armati[k] = np.sign(dd)
                continue
            if k in armati and l - VICINO <= k <= h + VICINO and mx > 0:
                lato = armati.pop(k)
                q = abs(v) / mx
                if q >= SOGLIA_GRANDE:
                    tipo = 'azzurra grande' if v > 0 else 'arancio grande'
                elif q < SOGLIA_PICCOLA:
                    tipo = 'senza freccia'
                else:
                    tipo = 'media'
                r = {'giorno': g['giorno'].iloc[0], 'min': m, 'tipo': tipo}
                for hh in (15, 30):
                    r[f'oltre{hh}'] = -lato * g.at[m, f'fwp{hh}']
                    r[f'ampio{hh}'] = g.at[m, f'a{hh}']
                righe.append(r)
    return righe


def verifiche(sess, curva, tt, grande, out):
    """I tre indizi rimasti dalle prove, con controlli piu' stretti."""
    meta = len(sess) // 2

    # A. Netto -> volatilita' dopo, al netto di quella gia' vista.
    righe = []
    for y in ('rv30', 'rv60'):
        gs = senza_media(senza_ora(sess, ['netto', 'rvPrima30', y]), ['netto', 'rvPrima30', y])
        tmp = []
        for g in gs:
            t = g.copy()
            t['res'] = parziale(t, 'netto', y, 'rvPrima30')
            tmp.append(t)
        r, n, p = null_circolare(tmp, 'res', y)
        rs, _, ps = null_circolare([t for t in tmp if t['giorno'].iloc[0] != grande], 'res', y)
        ra, _, _ = null_circolare(tmp[:meta], 'res', y)
        rb, _, _ = null_circolare(tmp[meta:], 'res', y)
        righe.append(dict(prova='netto -> ' + y + ' al netto della rv passata', r=r, p=p, rSenza=rs, pSenza=ps, primaMeta=ra, secondaMeta=rb))
    # B. Netto -> IV ATM dopo, al netto del prezzo e della IV appena mossi.
    for y in ('div15', 'div30'):
        for ctrl in ('pa15', 'divPrima15'):
            gs = senza_media(senza_ora(curva, ['netto', ctrl, y]), ['netto', ctrl, y])
            tmp = []
            for g in gs:
                t = g.copy()
                t['res'] = parziale(t, 'netto', y, ctrl)
                tmp.append(t)
            r, n, p = null_circolare(tmp, 'res', y)
            rs, _, ps = null_circolare([t for t in tmp if t['giorno'].iloc[0] != grande], 'res', y)
            m = len(tmp) // 2
            ra, _, _ = null_circolare(tmp[:m], 'res', y)
            rb, _, _ = null_circolare(tmp[m:], 'res', y)
            righe.append(dict(prova=f'netto -> {y} al netto di {ctrl}', r=r, p=p, rSenza=rs, pSenza=ps, primaMeta=ra, secondaMeta=rb))
    # Il flusso sopra/sotto: il candidato piu' forte sulla direzione.
    for x, y in (('fls15', 'fw60'), ('fls30', 'fw30')):
        gs = senza_ora(sess, [x, y])
        r, _, p = null_circolare(gs, x, y)
        rs, _, ps = null_circolare([g for g in gs if g['giorno'].iloc[0] != grande], x, y)
        ra, _, _ = null_circolare(gs[:meta], x, y)
        rb, _, _ = null_circolare(gs[meta:], x, y)
        righe.append(dict(prova=f'{x} -> {y}', r=r, p=p, rSenza=rs, pSenza=ps, primaMeta=ra, secondaMeta=rb))
    stampa('6a. INDIZI CON I CONTROLLI', righe)
    out['verificheCorr'] = pd.DataFrame(righe).round(4).to_dict('records')

    # Grandezza: fasce fisse di netto, valori al netto dell'ora del giorno.
    gs = senza_ora(curva, ['div15', 'div30'])
    gv = senza_ora(sess, ['rv30', 'rv60'])
    fasce = []
    for nome, lo_, hi_ in (('arancio prevalente (netto <= -0.25)', -9, -.25), ('misto', -.25, .25), ('azzurra prevalente (netto >= +0.25)', .25, 9)):
        c = pd.concat(gs)
        v = pd.concat(gv)
        qc, qv = c[(c['netto'] > lo_) & (c['netto'] <= hi_)], v[(v['netto'] > lo_) & (v['netto'] <= hi_)]
        qcs, qvs = qc[qc['giorno'] != grande], qv[qv['giorno'] != grande]
        fasce.append(dict(fascia=nome, minuti=len(qv), giorni=qv['giorno'].nunique(), div15=qc['div15'].mean(), div15Senza=qcs['div15'].mean(), div30=qc['div30'].mean(), rv30=qv['rv30'].mean(), rv30Senza=qvs['rv30'].mean(), rv60=qv['rv60'].mean()))
    stampa('6b. GRANDEZZA PER FASCIA DI NETTO (IV in punti di vol, rv in multipli di quella attesa; 0 = media di quell ora)', fasce)
    out['fasceNetto'] = pd.DataFrame(fasce).round(3).to_dict('records')

    # C. Tocchi: ampiezza dopo, a parita' di giorno e di ora; prima ora esclusa a parte.
    tt = tt.copy()
    tt['ora60'] = tt['min'] // 60
    def scarto(df, a, b, col):
        return df[df.tipo == a][col].mean() - df[df.tipo == b][col].mean()
    conf = []
    for a, b in [('arancio grande', 'senza freccia'), ('arancio grande', 'media'), ('azzurra grande', 'arancio grande'), ('azzurra grande', 'senza freccia')]:
        for col in ('ampio15', 'ampio30'):
            for nome, base in (('tutti', tt), ('dalle 10:30', tt[tt['min'] >= 630])):
                q = base[base.tipo.isin([a, b])].dropna(subset=[col])
                reale = scarto(q, a, b, col)
                nulli = []
                for _ in range(2000):
                    c = q.copy()
                    c['tipo'] = c.groupby(['giorno', 'ora60'])['tipo'].transform(lambda s: RNG.permutation(s.to_numpy()))
                    nulli.append(scarto(c, a, b, col))
                nulli = np.array(nulli)
                giorni = sorted(q['giorno'].unique())
                m = len(giorni) // 2
                conf.append(dict(a=a, b=b, misura=col, campione=nome, nA=int((q.tipo == a).sum()), nB=int((q.tipo == b).sum()), scarto=reale,
                                 p=float(((np.abs(nulli - nulli.mean()) >= abs(reale - nulli.mean())).sum() + 1) / (len(nulli) + 1)),
                                 senza=scarto(q[q.giorno != grande], a, b, col), primaMeta=scarto(q[q.giorno.isin(giorni[:m])], a, b, col), secondaMeta=scarto(q[q.giorno.isin(giorni[m:])], a, b, col)))
    tc = pd.DataFrame(conf)
    tc['q'] = bh(tc['p'])
    stampa('6c. AMPIEZZA DOPO IL TOCCO, a parita di giorno e ora', tc)
    out['verificheTocchi'] = tc.round(4).to_dict('records')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dal', default='2026-10-21')
    ap.add_argument('--json')
    args = ap.parse_args()
    pd.set_option('display.width', 250, 'display.max_columns', 40)

    date = [os.path.basename(f)[:10] for f in sorted(glob.glob(os.path.join(RADICE, 'volumes', '2026-*.json')))]
    giorni = []
    for g in date:
        if g >= args.dal and os.path.exists(os.path.join(RADICE, 'market', g + '.json')):
            d = carica(g)
            if d is not None:
                giorni.append(d)
    sess = []
    for g in giorni:
        a = g[g.index >= INIZIO].copy()
        a.attrs['conv'] = g.attrs['conv']
        sess.append(a)
    out = {}

    desc = []
    for g in sess:
        v = g.dropna(subset=['es', 'netto'])
        desc.append(dict(giorno=g['giorno'].iloc[0], minuti=len(v), esVar=v['es'].iloc[-1] - v['es'].iloc[0], esRange=v['es'].max() - v['es'].min(),
                         nettoMed=v['netto'].median(), nettoMin=v['netto'].min(), nettoMax=v['netto'].max(), quotaAzzurra=(v['netto'] > 0).mean(),
                         maxAzzurra=(v['segnoMax'] > 0).mean(), rvMed=v['rv30'].median()))
    desc = pd.DataFrame(desc)
    stampa('0. SESSIONI', desc)
    out['sessioni'] = desc.round(3).to_dict('records')
    grande = desc.loc[desc['esVar'].abs().idxmax(), 'giorno']
    out['grande'] = grande
    print('giornata col movimento maggiore:', grande)

    prove = []
    # 1. Ampiezza: la tesi "dealer corti gamma = mercato piu' mosso"
    for x in ('netto', 'absnetto', 'rvPrima30'):
        for y in ('rv30', 'rv60', 'a30', 'a60'):
            prove.append(dict(gruppo='ampiezza', **prova(sess, grande, x, y)))
    # 2. Direzione
    for x in ('netto', 'sbil', 'posMax', 'posFirm', 'fl5', 'fl15', 'fl30', 'fls5', 'fls15', 'fls30', 'pa15', 'pa30'):
        for y in ('fw15', 'fw30', 'fw60'):
            prove.append(dict(gruppo='direzione', **prova(sess, grande, x, y)))
    # 3. La curva: variazioni future di IV ATM e Tilt normalizzato
    curva = [g for g in sess if g['iva'].notna().sum() > 60]
    for x in ('fl5', 'fl15', 'fl30', 'fls15', 'netto', 'sbil', 'pa15', 'divPrima15'):
        for y in ('div15', 'div30', 'dti15', 'dti30'):
            prove.append(dict(gruppo='curva', **prova(curva, grande, x, y)))
    tp = pd.DataFrame(prove)
    for gruppo, q in tp.groupby('gruppo'):
        tp.loc[q.index, 'qSenza'] = bh(q['pSenza'].fillna(1))
        tp.loc[q.index, 'qDentro'] = bh(q['pDentro'].fillna(1))
    for gruppo in ('ampiezza', 'direzione', 'curva'):
        stampa(f'PROVE: {gruppo} (ora del giorno tolta)', tp[tp.gruppo == gruppo].drop(columns='gruppo'))
    out['prove'] = tp.round(4).to_dict('records')

    # 4. Contemporaneo: il flusso delle frecce descrive il movimento passato?
    cont = []
    for x, y in [('fl15', 'pa15'), ('fls15', 'pa15'), ('fl30', 'pa30'), ('fls30', 'pa30'), ('netto', 'pa30'), ('sbil', 'pa30')]:
        cont.append(dict(gruppo='insieme', **prova(sess, grande, x, y)))
    stampa('4. CON IL MOVIMENTO GIA FATTO', cont)
    out['contemporaneo'] = pd.DataFrame(cont).round(4).to_dict('records')

    # 5. Tocchi per colore
    tt = pd.DataFrame([r for g in sess for r in tocchi(g)])
    per_tipo = []
    for tipo, q in tt.groupby('tipo'):
        r = dict(tipo=tipo, tocchi=len(q), giorni=q['giorno'].nunique())
        for hh in (15, 30):
            v = q[f'oltre{hh}'].dropna()
            r[f'oltre{hh}'] = v.mean()
            r[f'quotaOltre{hh}'] = (v > 0).mean()
            r[f'mediana{hh}'] = v.median()
            r[f'ampio{hh}'] = q[f'ampio{hh}'].mean()
        per_tipo.append(r)
    stampa('5. DOPO IL TOCCO: + prosegue oltre, - rimbalza (punti ES, ogni tocco pesa uguale)', per_tipo)
    out['tocchi'] = pd.DataFrame(per_tipo).round(3).to_dict('records')

    def scarto(df, a, b, col):
        return df[df.tipo == a][col].mean() - df[df.tipo == b][col].mean()

    conf = []
    for a, b in [('azzurra grande', 'arancio grande'), ('arancio grande', 'senza freccia'), ('azzurra grande', 'senza freccia')]:
        for col in ('oltre15', 'oltre30', 'ampio15', 'ampio30'):
            q = tt[tt.tipo.isin([a, b])].dropna(subset=[col])
            reale = scarto(q, a, b, col)
            nulli = []
            for _ in range(2000):
                c = q.copy()
                c['tipo'] = c.groupby('giorno')['tipo'].transform(lambda s: RNG.permutation(s.to_numpy()))
                nulli.append(scarto(c, a, b, col))
            nulli = np.array(nulli)
            senza = q[q.giorno != grande]
            conf.append(dict(a=a, b=b, misura=col, nA=int((q.tipo == a).sum()), nB=int((q.tipo == b).sum()), scarto=reale,
                             p=float(((np.abs(nulli) >= abs(reale)).sum() + 1) / (len(nulli) + 1)), scartoSenza=scarto(senza, a, b, col)))
    tc = pd.DataFrame(conf)
    tc['q'] = bh(tc['p'])
    stampa('5b. CONFRONTI FRA TOCCHI (etichette permutate dentro il giorno)', tc)
    out['confronti'] = tc.round(4).to_dict('records')

    verifiche(sess, curva, tt, grande, out)

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, default=float)


if __name__ == '__main__':
    sys.exit(main())
