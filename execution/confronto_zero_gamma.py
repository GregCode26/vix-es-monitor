"""Quale variante Cboe dello Zero Gamma segue GEXBot?

Legge frontend/data/zero-gamma/*.ndjson (scritti da /api/zero-gamma): ogni
valore inserito a mano (GEXBot) porta con se' le varianti Cboe di quel
momento. Per ogni variante stampa lo scarto medio, mediano e massimo dal
valore di GEXBot, giorno per giorno e in totale.

Attenzione all'orario: la catena Cboe e' ritardata di 15 minuti, GEXBot no,
quindi su una giornata mossa uno scarto di qualche punto e' atteso anche con
la definizione giusta.

    python execution/confronto_zero_gamma.py
"""
import json
import statistics
from pathlib import Path

CARTELLA = Path(__file__).resolve().parent.parent / 'frontend' / 'data' / 'zero-gamma'
VARIANTI = ['poller', 'volStrike', 'volStrike0dte', 'volSweep', 'oiSweep', 'oiSweep0dte']


def main():
    scarti = {v: [] for v in VARIANTI}
    for file in sorted(CARTELLA.glob('*.ndjson')):
        giorno = {v: [] for v in VARIANTI}
        for riga in file.read_text(encoding='utf-8').splitlines():
            if not riga.strip():
                continue
            r = json.loads(riga)
            if r.get('tipo') != 'manuale' or r.get('valore') is None:
                continue
            # 'poller' = la traccia in tempo reale (dal 04/11/2026), le altre dalla catena Cboe.
            varianti = dict((r.get('cboe') or {}).get('varianti') or {})
            if r.get('poller'):
                varianti['poller'] = r['poller'][1]
            for v in VARIANTI:
                c = varianti.get(v)
                if c is not None:
                    giorno[v].append(c - r['valore'])
        n = max(len(x) for x in giorno.values())
        if n == 0:
            continue
        print(f"{file.stem}: {n} valori GEXBot")
        for v in VARIANTI:
            if giorno[v]:
                d = giorno[v]
                print(f"  {v:14} scarto medio {statistics.mean(d):+7.1f}  |medio| {statistics.mean(abs(x) for x in d):6.1f}  max {max(abs(x) for x in d):6.1f}")
            scarti[v].extend(giorno[v])
    if not any(scarti.values()):
        print('Nessun valore GEXBot inserito ancora: usa il campo Zero Gamma su /market.')
        return
    print('\nTotale:')
    for v in sorted(VARIANTI, key=lambda v: statistics.median(abs(x) for x in scarti[v]) if scarti[v] else 1e9):
        d = scarti[v]
        if d:
            print(f"  {v:14} n={len(d):3}  |scarto| mediano {statistics.median(abs(x) for x in d):6.1f}  medio {statistics.mean(abs(x) for x in d):6.1f}")


if __name__ == '__main__':
    main()
