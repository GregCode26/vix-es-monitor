"""Studio dei segnali di /market (29/10/2026): frecce AI Livelli e pallini IV.

Per ogni segnale guarda cosa ha fatto ES (frontend/data/market/<giorno>.json)
a 5, 15 e 30 minuti, piu' il massimo e il minimo della mezz'ora dopo.

- Frecce AI: le analisi con `innesco` in .tmp/ai-signals.jsonl. LONG/SHORT
  contano giusti/sbagliati e punti; NEUTRALE solo per vedere dove capitano.
  Per ogni livello dice anche da che parte e' arrivato ES (10 minuti prima) e
  se nella mezz'ora dopo ha tenuto (respinto di 5 punti) o e' stato rotto
  (oltrepassato di 3) -- quello che conta prima.
- Pallini IV: i cambi di regime RIALZISTA/RIBASSISTA, ricostruiti come fa
  /api/smile (`avanzaRegime`, z-score sezione 7, isteresi e conferma sezione
  8) su tutta la giornata, fino alle 15:15 ET. Tieni le costanti allineate
  con frontend/src/app/api/smile/route.ts.

Risultati del primo controllo (27-29/10, base z "provvisoria"):
- la pagina disegnava 133/236/67 pallini per 10/10/6 cambi veri: il regime
  si ricostruiva su una finestra mobile di 30 minuti che ripartiva vuota
  (corretto in route.ts il 29/10);
- i 21 pallini veri (fino alle 15:15 ET): 30 minuti 11 giusti / 10 sbagliati,
  -20 punti; 5 minuti 7/14. Correlazione z Tilt -> ES nei 15 minuti dopo
  -0.07/-0.15/-0.11: niente;
- frecce AI del 29/10: 19 analisi, 12 sullo stesso livello col prezzo fermo,
  11 NEUTRALE, LONG 0 su 4, SHORT 3 su 4 a 30 minuti (giornata in calo).
Dal 30/10 lo z si fa contro i giorni passati (3 giorni v2): rifare il conto.

Uso: python execution/studio_segnali.py [giorno ...]   (default: tutti i giorni con dati smile v2)
"""
import bisect, json, math, os, sys
from collections import Counter

RADICE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATI = os.path.join(RADICE, 'frontend', 'data')
LOG_AI = os.path.join(RADICE, '.tmp', 'ai-signals.jsonl')
ORIZZONTI = (300, 900, 1800)

# Come in /api/smile route.ts.
SOGLIA, USCITA, CONFERMA_SEC, QUOTA = 1.0, 0.5, 90, 0.7
MIN_SD = {'tiltN': 1.5, 'curvN': 1.0, 'ivAtm': 0.5}
FASCIA_SEC = 900
FINE_REGIME_ET = '15:15:00'
ORDINE = ['PIATTA + VOL ALTA', 'PIATTA + VOL BASSA', 'RIALZISTA', 'RIBASSISTA', 'RANGE A C', 'PIATTA']


def sec(t):
    h, m, *s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + (int(s[0]) if s else 0)


class Es:
    def __init__(self, giorno):
        f = os.path.join(DATI, 'market', f'{giorno}.json')
        m = json.load(open(f, encoding='utf-8')) if os.path.exists(f) else []
        m = m if isinstance(m, list) else m.get('data', [])
        self.p = sorted((sec(x['time']), x['esf']) for x in m if x.get('esf') is not None)
        self.t = [t for t, _ in self.p]

    def a(self, t):
        i = bisect.bisect_left(self.t, t)
        return self.p[i] if i < len(self.p) else None

    def fra(self, t0, t1):
        return [v for _, v in self.p[bisect.bisect_left(self.t, t0):bisect.bisect_right(self.t, t1)]]

    def esito(self, t, prezzo):
        out = {}
        for o in ORIZZONTI:
            x = self.a(t + o)
            out[o] = None if x is None or x[0] - (t + o) > 120 else round(x[1] - prezzo, 2)
        w = self.fra(t, t + 1800)
        out['max'] = round(max(w) - prezzo, 2) if w else None
        out['min'] = round(min(w) - prezzo, 2) if w else None
        return out


def fmt(v):
    return '' if v is None else f'{v:+.2f}'


def riga_esito(e):
    return ' '.join(f'{fmt(e[o]):>7}' for o in ORIZZONTI) + f" {fmt(e['max']):>7} {fmt(e['min']):>7}"


def conta(tot, chiave, e, verso):
    for o in ORIZZONTI:
        if e[o] is None:
            continue
        tot[(chiave, o, 'ok' if e[o] * verso > 0 else 'ko')] += 1
        tot[(chiave, o, 'pt')] += e[o] * verso


def riepilogo(tot, chiave):
    return '  '.join(f"{o // 60}m {tot[(chiave, o, 'ok')]}/{tot[(chiave, o, 'ko')]} {tot[(chiave, o, 'pt')]:+.1f}pt" for o in ORIZZONTI)


# ------------------------------------------------------------------ frecce AI

def frecce(giorno, es, tot):
    if not os.path.exists(LOG_AI):
        return
    righe = []
    for l in open(LOG_AI, encoding='utf-8'):
        try:
            r = json.loads(l)
        except ValueError:
            continue
        if r.get('innesco') and r.get('creato', '')[:10] == giorno:
            righe.append(r)
    if not righe:
        return
    print(f'\nFrecce AI ({len(righe)})')
    print(f"  {'ora':8} {'livello':10} {'lv':>8} {'arrivo':8} {'bias':8} cf  {'+5':>7} {'+15':>7} {'+30':>7} {'max30':>7} {'min30':>7}  livello")
    for r in righe:
        t = sec(r['ora'])
        inn, s = r['innesco'], r['segnale']
        lv = inn['prezzoLivello']
        p = inn.get('esf') or r.get('esf')
        e = es.esito(t, p)
        prima = es.a(t - 600)
        sotto = (inn.get('lato') == 'da sotto') if inn.get('lato') else (prima is not None and prima[1] < lv)
        verso_rottura = 1 if sotto else -1
        tenuta = '?'
        for v in es.fra(t, t + 1800):
            if (v - lv) * verso_rottura >= 3:
                tenuta = 'rotto'
                break
            if (lv - v) * verso_rottura >= 5:
                tenuta = 'tenuto'
                break
        print(f"  {r['ora']:8} {inn['livello'][:10]:10} {lv:8.2f} {'da sotto' if sotto else 'da sopra':8} "
              f"{s['bias']:8} {s.get('confidenza', 0):2}  {riga_esito(e)}  {tenuta}")
        tot[('livello', tenuta)] += 1
        if s['bias'] in ('LONG', 'SHORT'):
            conta(tot, 'ai ' + s['bias'], e, 1 if s['bias'] == 'LONG' else -1)
        tot[('ai bias', s['bias'])] += 1


# ------------------------------------------------------------------ pallini IV

def leggi(f):
    out = []
    for l in open(f, encoding='utf-8'):
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return out


def senza_ripetute(L):
    return [l for i, l in enumerate(L)
            if i == 0 or any(L[i - 1].get(k) != l.get(k) for k in ('spot', 'ivAtm', 'tilt', 'curv'))]


def zf(x, vals, msd):
    if x is None or not vals:
        return None
    mu = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals))
    return (x - mu) / max(sd, msd)


def vale(r, z, s):
    t, c, v = z['tilt'], z['curv'], z['ivAtm']
    return {
        'PIATTA + VOL ALTA': c is not None and c <= -s and v is not None and v >= s,
        'PIATTA + VOL BASSA': c is not None and c <= -s and v is not None and v <= -s / 2,
        'RIALZISTA': t is not None and t >= s,
        'RIBASSISTA': t is not None and t <= -s,
        'RANGE A C': c is not None and c >= s,
        'PIATTA': c is not None and c <= -s,
    }.get(r, False)


def regime(z, confermato):
    if confermato and confermato != 'NEUTRO' and vale(confermato, z, USCITA):
        return confermato
    return next((r for r in ORDINE if vale(r, z, SOGLIA)), 'NEUTRO')


def cambi_regime(giorno):
    """I cambiRegime di /api/smile per la giornata: [(ora italiana, regime, base)]."""
    dir_s = os.path.join(DATI, 'smile')
    passato = []
    for f in sorted(os.listdir(dir_s))[-31:]:
        if f.endswith('.ndjson') and f[:10] < giorno:
            passato += [(f[:10], l) for l in senza_ripetute([l for l in leggi(os.path.join(dir_s, f)) if l.get('v', 1) >= 2])]
    oggi = senza_ripetute([l for l in leggi(os.path.join(dir_s, f'{giorno}.ndjson')) if l.get('v', 1) >= 2])
    t_oggi = [sec(l['tEt']) for l in oggi]
    t_pass = sorted(((sec(l['tEt']), g, l) for g, l in passato), key=lambda x: x[0])
    chiavi_pass = [x[0] for x in t_pass]
    confermato, recenti, cambi = None, [], []
    for i, o in enumerate(oggi):
        t = t_oggi[i]
        vicini = [(g, l) for _, g, l in t_pass[bisect.bisect_left(chiavi_pass, t - FASCIA_SEC):bisect.bisect_right(chiavi_pass, t + FASCIA_SEC)]]
        if len({g for g, _ in vicini}) >= 3 and len(vicini) >= 15:
            base, camp = 'storico', [l for _, l in vicini]
        else:
            camp = oggi[bisect.bisect_right(t_oggi, t - 3600):bisect.bisect_left(t_oggi, t)]
            base = 'provvisoria' if len(camp) >= 10 else None
        z = None
        if base:
            di = lambda k: [c[k] for c in camp if c.get(k) is not None]
            z = {'tilt': zf(o.get('tiltN'), di('tiltN'), MIN_SD['tiltN']),
                 'curv': zf(o.get('curvN'), di('curvN'), MIN_SD['curvN']),
                 'ivAtm': zf(o['ivAtm'], di('ivAtm'), MIN_SD['ivAtm'])}
        grezzo = regime(z, confermato) if z else None
        recenti.append((t, grezzo))
        while t - recenti[0][0] > CONFERMA_SEC:
            recenti.pop(0)
        if t - recenti[0][0] < CONFERMA_SEC - 10:
            continue
        n = Counter(r for _, r in recenti if r)
        for r, k in n.items():
            if r != confermato and k >= QUOTA * len(recenti):
                confermato = r
                if o.get('t') and o['tEt'] < FINE_REGIME_ET:
                    cambi.append((o['t'], r, base))
    return cambi


def pallini(giorno, es, tot):
    if not os.path.exists(os.path.join(DATI, 'smile', f'{giorno}.ndjson')):
        return
    dir_ = [(t, r, b) for t, r, b in cambi_regime(giorno) if r in ('RIALZISTA', 'RIBASSISTA')]
    # Riarmo di 30 s, come conRiarmo() in /market.
    tenuti = []
    for c in dir_:
        if tenuti and sec(c[0]) - sec(tenuti[-1][0]) < 30:
            continue
        tenuti.append(c)
    print(f'\nPallini IV ({len(tenuti)})')
    print(f"  {'ora':8} {'regime':10} {'base':11} {'ES':>8} {'10m prima':>9}  {'+5':>7} {'+15':>7} {'+30':>7} {'max30':>7} {'min30':>7}")
    for t, r, b in tenuti:
        x = es.a(sec(t))
        if x is None:
            continue
        prima = es.a(x[0] - 600)
        e = es.esito(x[0], x[1])
        print(f"  {t:8} {r[:10]:10} {b:11} {x[1]:8.2f} {fmt(x[1] - prima[1]) if prima else '':>9}  {riga_esito(e)}")
        conta(tot, 'iv ' + b, e, 1 if r == 'RIALZISTA' else -1)


def main():
    giorni = sys.argv[1:] or sorted(
        f[:10] for f in os.listdir(os.path.join(DATI, 'smile'))
        if f.endswith('.ndjson') and any(l.get('v', 1) >= 2 for l in leggi(os.path.join(DATI, 'smile', f))[:50]))
    tot = Counter()
    for g in giorni:
        print('=' * 100)
        print(g)
        es = Es(g)
        if not es.p:
            print('  niente ES')
            continue
        frecce(g, es, tot)
        pallini(g, es, tot)
    print('=' * 100)
    print('TOTALE (giusti/sbagliati, punti nel verso del segnale)')
    for k in sorted({k[0] for k in tot if k[0].startswith(('ai L', 'ai S', 'iv '))}):
        print(f'  {k:16} {riepilogo(tot, k)}')
    print('  bias AI:', {k[1]: v for k, v in tot.items() if k[0] == 'ai bias'})
    print('  livelli dopo l\'innesco:', {k[1]: v for k, v in tot.items() if k[0] == 'livello'})


if __name__ == '__main__':
    main()
