"""
SPX Options Volume Scanner - punto d'ingresso.

Dalla radice del repo:
    python -m spx_flow_scanner.main verifica   # Fase 1: connessione e stato TWS
    python -m spx_flow_scanner.main sonda      # Fase 1: cosa restituisce IBKR (snapshot vs streaming)
"""

import argparse
import json
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from spx_flow_scanner.config.settings import IMPOSTAZIONI
from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr
from spx_flow_scanner.utils.logger import prendi_logger

log = prendi_logger('main')
NEW_YORK = ZoneInfo('America/New_York')


def comando_verifica(cli: ClienteIbkr) -> int:
    print(json.dumps(cli.stato(), indent=2, ensure_ascii=False))
    return 0


def comando_sonda(cli: ClienteIbkr) -> int:
    from spx_flow_scanner.scanner import sonda
    try:
        resoconto = sonda.esegui_sonda(cli)
    except sonda.LineeEsaurite as e:
        log.error('%s', e)
        return 2
    percorso = sonda.salva(resoconto)
    sintesi = {k: v for k, v in resoconto.items() if k not in ('ultimi_errori',)}
    for chiave in ('snapshot', 'streaming_volume', 'streaming_volume_oi'):
        sintesi[chiave] = {k: v for k, v in resoconto[chiave].items() if k != 'righe'}
    print(json.dumps(sintesi, indent=2, ensure_ascii=False))
    print(f'\nResoconto completo: {percorso}')
    return 0


def comando_catena(cli: ClienteIbkr, forza: bool = False) -> int:
    from spx_flow_scanner.connectors.ibkr_market_data import prezzo_spx, qualifica_spx
    from spx_flow_scanner.scanner.atm_calculator import passo_vicino, strike_atm
    from spx_flow_scanner.scanner.chain_discovery import aggiorna_catena, giorni_a
    from spx_flow_scanner.utils import market_calendar

    spx = qualifica_spx(cli)
    catena, stat = aggiorna_catena(cli, spx, forza=forza)
    _, prezzo = prezzo_spx(cli, spx)
    strikes = catena.strike_vicina()
    atm = strike_atm(prezzo['riferimento'], strikes)
    rng = IMPOSTAZIONI.range_strike

    print(f"\nSPX {prezzo['riferimento']} ({prezzo['fonte_riferimento']}, {prezzo['tipo_dati']})  "
          f"ATM {atm:g}  passo vicino ATM {passo_vicino(prezzo['riferimento'], strikes)}")
    st = market_calendar.stato(catena.orari['tradingHours'], catena.orari['timeZoneId'])
    cash = market_calendar.stato(catena.orari['liquidHours'], catena.orari['timeZoneId'])
    print(f"sessione opzioni aperta: {st['aperto']}  cash aperto: {cash['aperto']}  "
          f"prossima apertura cash: {cash['prossima_apertura']}  giorni chiusi: {st['giorni_chiusi'] or '-'}")
    print(f"\n{'classe':6} {'scad.IBKR':9} {'reale':9} {'DTE':>3} {'tot':>5} {'range':>5} "
          f"{'min':>6} {'max':>6}")
    totale = 0
    for s in sorted(catena.scadenze.values(), key=lambda s: (s.scadenza_reale, s.classe)):
        nel = [c for c in s.contratti if abs(c.strike - atm) <= rng]
        totale += len(nel)
        k = [c.strike for c in nel] or [0]
        print(f"{s.classe:6} {s.scadenza:9} {s.scadenza_reale:9} {giorni_a(s.scadenza_reale):>3} "
              f"{len(s.contratti):>5} {len(nel):>5} {min(k):>6g} {max(k):>6g}")
    print(f"\nscadenze {len(catena.scadenze)}  contratti entro ATM +/-{rng}: {totale}  "
          f"(richieste {stat['richieste']}: nuove {stat['nuove']}, rinfrescate {stat['rinfrescate']}, "
          f"dalla cache {stat['dalla_cache']}; {stat['secondi']}s)")
    if stat['vuote']:
        print(f"ATTENZIONE scadenze senza contratti: {stat['vuote']}")
    if stat['ignorate']:
        print(f"classi ignorate: {stat['ignorate']}")
    return 0


def _attendi(cli: ClienteIbkr, secondi: float) -> None:
    """Attesa che tiene viva la connessione (ib.sleep smaltisce i messaggi)."""
    fine = time.monotonic() + secondi
    while (resto := fine - time.monotonic()) > 0:
        if cli.ib.isConnected():
            cli.ib.sleep(min(resto, 5))
        else:
            time.sleep(min(resto, 5))


def comando_scansiona(cli: ClienteIbkr, cicli: int = 0) -> int:
    """
    Gira a oltranza: una sessione per giorno di borsa (catena del giorno),
    cicli ogni `intervallo_minuti` solo a mercato opzioni aperto. TWS che cade
    o un errore imprevisto non chiudono il processo: si riparte dopo 30 s.
    `cicli` > 0 (solo per prova) si ferma dopo quel numero di cicli.
    """
    from spx_flow_scanner.connectors.ibkr_market_data import qualifica_spx
    from spx_flow_scanner.scanner.chain_discovery import aggiorna_catena, oggi_ny
    from spx_flow_scanner.database.repository import Archivio
    from spx_flow_scanner.scanner.volume_scanner import ScannerVolumi
    from spx_flow_scanner.utils import market_calendar

    cfg = IMPOSTAZIONI
    numero = 0
    archivio = Archivio()
    log.info('archivio %s', archivio.percorso)
    while True:
        try:
            if not cli.assicura_connessione():
                _attendi(cli, 60)
                continue
            spx = qualifica_spx(cli)
            catena, _ = aggiorna_catena(cli, spx)
            orari = (catena.orari['tradingHours'], catena.orari['timeZoneId'])
            st = market_calendar.stato(*orari)
            if not st['aperto']:
                archivio.imposta_stato('scanner', {'stato': 'mercato_chiuso', 'prossima_apertura': st['prossima_apertura']})
                log.info('mercato opzioni chiuso, prossima apertura %s', st['prossima_apertura'])
                _attendi(cli, 300)
                continue
            scanner = ScannerVolumi(cli, catena, cfg, archivio)
            try:
                while catena.data_ny == oggi_ny().isoformat() and market_calendar.mercato_aperto(*orari):
                    numero += 1
                    t0 = time.monotonic()
                    scanner.ciclo(numero, spx)
                    if cicli and numero >= cicli:
                        archivio.imposta_stato('scanner', {'stato': 'fermato', 'motivo': f'--cicli {cicli}'})
                        return 0
                    catena, _ = aggiorna_catena(cli, spx)  # rilegge solo le scadenze vicine scadute in cache
                    scanner.aggiorna_catena(catena)
                    _attendi(cli, cfg.intervallo_minuti * 60 - (time.monotonic() - t0))
            finally:
                scanner.chiudi()
            log.info('sessione finita (giorno cambiato o mercato chiuso)')
        except KeyboardInterrupt:
            archivio.imposta_stato('scanner', {'stato': 'fermato'})
            archivio.chiudi()
            raise
        except Exception as e:
            log.exception('scansione interrotta, si riparte fra 30 s')
            archivio.imposta_stato('scanner', {'stato': 'errore', 'errore': f'{type(e).__name__}: {e}'})
            cli.disconnetti()
            time.sleep(30)


def comando_analisi(args) -> int:
    """Tabelle LARGE CALL / LARGE PUT dal database, senza TWS."""
    from spx_flow_scanner.database.repository import Archivio
    from spx_flow_scanner.scanner.atm_calculator import riferimento_atm
    from spx_flow_scanner.scanner.filters import Filtro, contratti_filtrati, copertura
    from spx_flow_scanner.scanner.volume_analyzer import aggiorna_ultimi, ricalcola_incrementi
    from spx_flow_scanner.utils.market_calendar import sessione_di_borsa

    archivio = Archivio()
    db = archivio.db
    giorno_ora, sessione_ora = sessione_di_borsa()
    giorno = args.giorno or giorno_ora.isoformat()
    sessione = args.sessione or sessione_ora
    if args.ricalcola:
        ricalcola_incrementi(db, giorno, sessione)
        print(f'incrementi e volume_latest ricalcolati: {aggiorna_ultimi(db, giorno, sessione)} contratti')
    rif = riferimento_atm(db, giorno, args.atm, args.ora, sessione)
    if rif is None:
        print(f'nessun ATM "{args.atm}" per {giorno} (quello di apertura esiste solo dopo le 9:30 NY)')
        return 1
    dte_min, dte_max = (int(x) for x in args.dte.split('-'))
    filtro = Filtro(args.min, args.tipo, dte_min, dte_max, args.range, rif['atm'])
    adesso = int(time.time())
    cop = copertura(db, giorno, sessione, filtro, adesso)
    ora_rif = datetime.fromtimestamp(rif['ts'], NEW_YORK).strftime('%H:%M')
    print(f"\n{giorno} sessione {sessione}  ATM {rif['atm']:g} ({rif['modo']}, ciclo {rif['scan_id']} delle {ora_rif} NY, "
          f"SPX {rif['spx']} da {rif['fonte_spx']})  filtro: volume >= {args.min}, {args.tipo}, "
          f"DTE {args.dte}, ATM +/-{args.range}")
    print(f"copertura: {cop['con_volume']} contratti con volume su {cop['contratti_tentati']} tentati oggi; "
          f"letti negli ultimi 30 min {cop['letti_30min']}, 60 min {cop['letti_60min']}")
    righe = contratti_filtrati(db, giorno, sessione, filtro, adesso)

    def f(v, larghezza, fmt='{:,}'):
        return (fmt.format(v) if v is not None else '-').rjust(larghezza)

    for lato, titolo in (('C', 'LARGE CALL ACTIVITY'), ('P', 'LARGE PUT ACTIVITY')):
        if lato not in args.tipo:
            continue
        sel = [r for r in righe if r['opt_right'] == lato]
        print(f"\n{titolo} ({len(sel)})")
        print(f"{'DTE':>3} {'scadenza':8} {'cl':4} {'strike':>6} {'volume':>8} {'d ultimo':>9} {'(min)':>5} "
              f"{'+30m':>7} {'+60m':>7} {'bid':>7} {'ask':>7} {'last':>7} {'eta':>4} tipo")
        for r in sel[:args.righe]:
            print(f"{r['dte']:>3} {r['real_expiry']:8} {r['trading_class']:4} {r['strike']:>6g} {f(r['volume'], 8)} "
                  f"{f(r['delta_last'], 9)} {f(r['delta_last_window_s'] and round(r['delta_last_window_s'] / 60), 5)} "
                  f"{f(r['inc_30m'], 7)} {f(r['inc_60m'], 7)} {f(r['bid'], 7, '{:.2f}')} {f(r['ask'], 7, '{:.2f}')} "
                  f"{f(r['last_price'], 7, '{:.2f}')} {round((adesso - r['ts']) / 60):>4} {r['data_type']}")
    archivio.chiudi()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='SPX Options Volume Scanner')
    parser.add_argument('comando', choices=['verifica', 'sonda', 'catena', 'scansiona', 'analisi'])
    parser.add_argument('--forza', action='store_true', help='catena: ignora la cache del giorno')
    parser.add_argument('--cicli', type=int, default=0, help='scansiona: fermati dopo N cicli (prova)')
    analisi = parser.add_argument_group('analisi (non serve TWS)')
    analisi.add_argument('--giorno', help='YYYY-MM-DD, default il giorno di borsa in corso')
    analisi.add_argument('--sessione', choices=['notturna', 'cash'], help='default la sessione in corso')
    analisi.add_argument('--min', type=int, default=IMPOSTAZIONI.volume_minimo, help='volume minimo per contratto')
    analisi.add_argument('--tipo', choices=['C', 'P', 'CP'], default='CP')
    analisi.add_argument('--dte', default=f'0-{IMPOSTAZIONI.dte_max}', help='es. 0-7')
    analisi.add_argument('--range', type=int, default=IMPOSTAZIONI.range_strike, help='punti attorno ATM')
    analisi.add_argument('--atm', choices=['corrente', 'apertura', 'storico'], default='corrente')
    analisi.add_argument('--ora', help="analisi --atm storico: 'HH:MM' New York")
    analisi.add_argument('--righe', type=int, default=25)
    analisi.add_argument('--ricalcola', action='store_true', help='ricalcola volume_latest del giorno')
    args = parser.parse_args()

    if args.comando == 'analisi':
        return comando_analisi(args)

    cli = ClienteIbkr(IMPOSTAZIONI)
    # scansiona riprova da sola a oltranza; gli altri comandi si fermano.
    if not cli.connetti() and args.comando != 'scansiona':
        log.error('TWS non raggiungibile su %s:%s: e\' aperto, con le API abilitate?',
                  IMPOSTAZIONI.host, IMPOSTAZIONI.porta)
        return 1
    try:
        if args.comando == 'scansiona':
            return comando_scansiona(cli, cicli=args.cicli)
        if args.comando == 'catena':
            return comando_catena(cli, forza=args.forza)
        return {'verifica': comando_verifica, 'sonda': comando_sonda}[args.comando](cli)
    finally:
        cli.disconnetti()


if __name__ == '__main__':
    sys.exit(main())
