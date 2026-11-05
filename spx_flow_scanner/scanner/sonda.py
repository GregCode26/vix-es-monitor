"""
Fase 1 - sonda: misura cosa IBKR restituisce davvero, prima di progettare
il motore di scansione.

Domande a cui risponde, su pochi contratti veri (8) e mai piu' di
`max_linee` linee aperte insieme:
  1. Lo snapshot (`snapshot=True`) porta il volume? In quanto tempo?
  2. Lo snapshot accetta il generic tick 101 (open interest)? Si attende di no
     (errore 321): lo si verifica invece di darlo per scontato.
  3. In streaming temporaneo, dopo quanto arrivano volume e OI?
  4. Che tipo di dato arriva (LIVE / FROZEN / DELAYED)?
  5. Quanti contratti esistono davvero in 0-90 DTE entro ATM +/- range, e
     quanto ci vorrebbe a leggerli tutti al ritmo misurato.

Non scrive nulla nel database: salva il resoconto in
`.tmp/spx_flow_scanner/sonda_YYYYMMDD_HHMMSS.json`.
"""

import json
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

from ib_insync import Option

from spx_flow_scanner.config.settings import CARTELLA_DATI
from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr, tipo_dati
from spx_flow_scanner.connectors.ibkr_market_data import num, prezzo_spx, valido
from spx_flow_scanner.utils.logger import prendi_logger

log = prendi_logger('sonda')
NEW_YORK = ZoneInfo('America/New_York')


class LineeEsaurite(RuntimeError):
    pass


def oggi_ny() -> date:
    return datetime.now(NEW_YORK).date()


def dte(scadenza: str) -> int:
    return (datetime.strptime(scadenza, '%Y%m%d').date() - oggi_ny()).days


# -- universo ---------------------------------------------------------------

def catene(cli: ClienteIbkr, spx) -> list:
    cli.limitatore.attendi()
    tutte = cli.ib.reqSecDefOptParams(spx.symbol, '', spx.secType, spx.conId)
    smart = [c for c in tutte if c.exchange == 'SMART']
    return smart or tutte


def contratti_scadenza(cli: ClienteIbkr, classe: str, scadenza: str) -> list:
    """Tutti i contratti realmente quotati per una scadenza (una richiesta)."""
    cli.limitatore.attendi()
    t0 = time.monotonic()
    dettagli = cli.ib.reqContractDetails(
        Option('SPX', scadenza, exchange='SMART', currency='USD', tradingClass=classe))
    log.info('contractDetails %s %s: %s contratti in %.1fs', classe, scadenza,
             len(dettagli), time.monotonic() - t0)
    return [d.contract for d in dettagli]


def stima_universo(cli: ClienteIbkr, lista_catene: list, atm: float, rng: int, dte_max: int) -> dict:
    per_classe = {}
    campioni = {}
    for c in lista_catene:
        scad = sorted(s for s in c.expirations if 0 <= dte(s) <= dte_max)
        strike = [k for k in c.strikes if atm - rng <= k <= atm + rng]
        per_classe[c.tradingClass] = {
            'scadenze': len(scad), 'prima': scad[0] if scad else None, 'ultima': scad[-1] if scad else None,
            'strike_unione_nel_range': len(strike),
            'limite_superiore_contratti': len(scad) * len(strike) * 2,
        }
    # Conteggio vero su due scadenze SPXW: la piu' vicina e una ~30 DTE.
    spxw = next((c for c in lista_catene if c.tradingClass == 'SPXW'), None)
    if spxw:
        scad = sorted(s for s in spxw.expirations if 0 <= dte(s) <= dte_max)
        scelte = {scad[0]}
        if len(scad) > 1:
            scelte.add(min(scad, key=lambda s: abs(dte(s) - 30)))
        for s in sorted(scelte):
            contratti = contratti_scadenza(cli, 'SPXW', s)
            nel_range = [k for k in contratti if atm - rng <= k.strike <= atm + rng]
            campioni[s] = {'dte': dte(s), 'contratti_totali': len(contratti),
                           'contratti_nel_range': len(nel_range), 'contratti': nel_range}
    totale_scadenze = sum(v['scadenze'] for v in per_classe.values())
    medie = [v['contratti_nel_range'] for v in campioni.values()]
    stima = round(totale_scadenze * sum(medie) / len(medie)) if medie else None
    return {'per_classe': per_classe, 'campioni': campioni,
            'stima_contratti_reali': stima,
            'nota': 'stima = scadenze totali x media dei contratti nel range sulle scadenze campione'}


def scegli_contratti(campioni: dict, atm: float) -> list:
    scadenze = sorted(campioni)
    scelti = []
    for i, s in enumerate(scadenze):
        contratti = campioni[s]['contratti']
        strike = sorted({c.strike for c in contratti}, key=lambda k: abs(k - atm))[: 3 if i == 0 else 1]
        scelti += [c for c in contratti if c.strike in strike]
    return scelti


# -- prove market data ------------------------------------------------------

def _gruppi(lista, n):
    for i in range(0, len(lista), n):
        yield lista[i:i + n]


def _controlla_linee(cli: ClienteIbkr, prima: int) -> None:
    if cli.errori[101] > prima:
        raise LineeEsaurite('errore 101: linee di market data finite, sonda interrotta per non '
                            'togliere linee ai poller. Abbassa SCANNER_MAX_LINEE.')


def _riga(c, t, t0, arrivi) -> dict:
    oi = t.callOpenInterest if c.right == 'C' else t.putOpenInterest
    return {
        'classe': c.tradingClass, 'scadenza': c.lastTradeDateOrContractMonth, 'dte': dte(c.lastTradeDateOrContractMonth),
        'strike': c.strike, 'right': c.right, 'conId': c.conId,
        'volume': num(t.volume), 'oi': num(oi), 'bid': num(t.bid), 'ask': num(t.ask),
        'last': num(t.last), 'tipo_dati': tipo_dati(t),
        's_al_volume': arrivi.get('volume'), 's_al_bidask': arrivi.get('bidask'), 's_al_oi': arrivi.get('oi'),
    }


def prova(cli: ClienteIbkr, contratti: list, snapshot: bool, generici: str, attesa: float) -> dict:
    ib = cli.ib
    righe = []
    t_inizio = time.monotonic()
    prima_101 = cli.errori[101]
    for gruppo in _gruppi(contratti, max(1, cli.cfg.max_linee)):
        tickers = []
        t0 = time.monotonic()
        for c in gruppo:
            cli.limitatore.attendi()
            t = ib.reqMktData(c, generici, snapshot, False)
            t.marketDataType = 0
            tickers.append(t)
        arrivi = [{} for _ in gruppo]
        fine = t0 + attesa
        while time.monotonic() < fine:
            ib.sleep(0.2)
            _controlla_linee(cli, prima_101)
            trascorso = round(time.monotonic() - t0, 2)
            for c, t, a in zip(gruppo, tickers, arrivi):
                oi = t.callOpenInterest if c.right == 'C' else t.putOpenInterest
                if 'volume' not in a and valido(t.volume):
                    a['volume'] = trascorso
                if 'bidask' not in a and valido(t.bid) and valido(t.ask):
                    a['bidask'] = trascorso
                if 'oi' not in a and valido(oi):
                    a['oi'] = trascorso
            # In streaming si chiude appena c'e' il volume (l'OI se richiesto):
            # e' proprio questo che decide il ritmo dello scanner.
            if not snapshot and all('volume' in a and ('101' not in generici or 'oi' in a) for a in arrivi):
                break
        righe += [_riga(c, t, t0, a) for c, t, a in zip(gruppo, tickers, arrivi)]
        if not snapshot:
            for c in gruppo:
                cli.limitatore.attendi()
                ib.cancelMktData(c)
        ib.sleep(0.5)
    durata = time.monotonic() - t_inizio
    con_volume = sum(r['volume'] is not None for r in righe)
    return {'snapshot': snapshot, 'generici': generici, 'contratti': len(righe),
            'con_volume': con_volume, 'con_oi': sum(r['oi'] is not None for r in righe),
            'durata_s': round(durata, 1), 'contratti_al_secondo': round(len(righe) / durata, 2) if durata else None,
            'righe': righe}


def prova_snapshot_con_101(cli: ClienteIbkr, contratto) -> dict:
    prima = dict(cli.errori)
    cli.limitatore.attendi()
    cli.ib.reqMktData(contratto, '101', True, False)
    cli.ib.sleep(4)
    nuovi = {k: v - prima.get(k, 0) for k, v in cli.errori.items() if v > prima.get(k, 0)}
    return {'errori_nuovi': nuovi, 'rifiutato': 321 in nuovi}


# -- tutto insieme ----------------------------------------------------------

def esegui_sonda(cli: ClienteIbkr) -> dict:
    cfg = cli.cfg
    ora = datetime.now(NEW_YORK)
    resoconto = {'ora_ny': ora.isoformat(timespec='seconds'), 'max_linee': cfg.max_linee,
                 'messaggi_al_secondo': cfg.messaggi_al_secondo}
    spx, sottostante = prezzo_spx(cli)
    resoconto['spx'] = sottostante
    atm = sottostante['riferimento']
    if not atm:
        raise RuntimeError('nessun prezzo SPX (ne last ne close): impossibile centrare l\'ATM')
    log.info('SPX %s (%s, %s)', atm, sottostante['fonte_riferimento'], sottostante['tipo_dati'])

    lista = catene(cli, spx)
    universo = stima_universo(cli, lista, atm, cfg.range_strike, cfg.dte_max)
    contratti = scegli_contratti(universo['campioni'], atm)
    resoconto['universo'] = {**universo, 'campioni': {
        s: {k: v for k, v in d.items() if k != 'contratti'} for s, d in universo['campioni'].items()}}
    log.info('universo stimato: %s contratti reali', universo['stima_contratti_reali'])
    log.info('contratti di prova: %s', ', '.join(
        f'{c.lastTradeDateOrContractMonth} {c.strike:g}{c.right}' for c in contratti))

    resoconto['snapshot'] = prova(cli, contratti, snapshot=True, generici='', attesa=12)
    resoconto['snapshot_con_101'] = prova_snapshot_con_101(cli, contratti[0])
    resoconto['streaming_volume'] = prova(cli, contratti, snapshot=False, generici='', attesa=10)
    resoconto['streaming_volume_oi'] = prova(cli, contratti, snapshot=False, generici='101', attesa=10)

    stima = universo['stima_contratti_reali']
    ritmo = resoconto['streaming_volume']['contratti_al_secondo']
    if stima and ritmo:
        resoconto['giro_completo_stimato_min'] = round(stima / ritmo / 60, 1)
    resoconto['errori_ibkr'] = dict(cli.errori)
    resoconto['ultimi_errori'] = list(cli.ultimi_errori)
    return resoconto


def salva(resoconto: dict):
    CARTELLA_DATI.mkdir(parents=True, exist_ok=True)
    percorso = CARTELLA_DATI / f'sonda_{datetime.now():%Y%m%d_%H%M%S}.json'
    percorso.write_text(json.dumps(resoconto, indent=2, ensure_ascii=False), encoding='utf-8')
    return percorso
