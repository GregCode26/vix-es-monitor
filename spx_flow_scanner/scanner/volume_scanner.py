"""
Fase 4/5 - lettura dei volumi, lenta e a priorita', salvata in SQLite.

Ogni ciclo (default 10 minuti):
  1. prezzo SPX -> ATM (strike reale piu' vicino);
  2. PRIORITA': le prime `prio_scadenze` scadenze (oggi e la successiva)
     entro ATM +/- `prio_range`: tutte, ogni ciclo;
  3. ROTAZIONE: nel tempo che resta, gli altri contratti entro ATM +/-
     `range_strike` e 0-`dte_max` DTE, dal dato piu' vecchio (mai letti per
     primi).

Lettura di un contratto: sottoscrizione streaming senza generic tick (niente
OI, l'utente non lo vuole), chiusa appena arrivano volume e bid/ask. Mai piu'
di `max_linee` contratti aperti insieme: i poller della dashboard tengono
~90 linee su ~100. Su errore 101 le linee si dimezzano e il contratto torna
in coda.

Un volume che non arriva entro `timeout_s` e' NON_DISPONIBILE (NULL), non
zero. Ogni lettura porta l'ora e il tipo di dato (LIVE/FROZEN/DELAYED, oppure
NON_COMUNICATO se TWS non l'ha detto).

Ogni lettura va in `volume_snapshots` + `market_quotes` con l'incremento
rispetto all'ultima lettura OK dello stesso contratto nella stessa sessione
(`volume_delta`); un volume che scende non da' incremento ma un'`anomaly`.

Sessioni: IBKR azzera il volume giornaliero all'apertura del cash (9:30 NY)
e della notturna (20:15 NY). Ogni lettura porta la sua sessione; al cambio
lo stato riparte da zero per la nuova, e al cambio di giorno di borsa il
ciclo si ferma perche' la catena va riletta. Al riavvio lo stato
del giorno si ricarica dal database, cosi' la rotazione riprende dai
contratti piu' vecchi e gli incrementi restano continui.
"""

import time
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

from spx_flow_scanner.config.settings import Impostazioni
from spx_flow_scanner.connectors.ibkr_client import ClienteIbkr, tipo_dati
from spx_flow_scanner.connectors.ibkr_market_data import num, prezzo_spx, valido
from spx_flow_scanner.database.repository import Archivio
from spx_flow_scanner.scanner.atm_calculator import strike_atm
from spx_flow_scanner.scanner.chain_discovery import Catena, ContrattoOpzione, giorni_a
from spx_flow_scanner.scanner.volume_analyzer import aggiorna_ultimi
from spx_flow_scanner.utils.logger import prendi_logger
from spx_flow_scanner.utils.market_calendar import sessione_di_borsa

log = prendi_logger('volumi')
NEW_YORK = ZoneInfo('America/New_York')

# Errori che riguardano il singolo contratto: lo si chiude e si va avanti.
_ERRORI_CONTRATTO = {200, 354, 10090, 10167, 10168, 10197, 300}


class _Slot:
    __slots__ = ('contratto', 'ibkr', 'ticker', 't0', 't_volume', 'errore')

    def __init__(self, contratto: ContrattoOpzione, ibkr, ticker):
        self.contratto, self.ibkr, self.ticker = contratto, ibkr, ticker
        self.t0 = time.monotonic()
        self.t_volume = None
        self.errore = None


def priorita(catena: Catena, atm: float, cfg: Impostazioni, oggi=None) -> list:
    reali = sorted({s.scadenza_reale for s in catena.scadenze.values()
                    if giorni_a(s.scadenza_reale, oggi) >= 0})[:cfg.prio_scadenze]
    return [c for c in catena.contratti(atm, cfg.prio_range, 0, cfg.dte_max, oggi=oggi)
            if c.scadenza_reale in reali]


def rotazione(catena: Catena, atm: float, cfg: Impostazioni, esclusi: set, ultimo: dict, oggi=None) -> list:
    resto = [c for c in catena.contratti(atm, cfg.range_strike, 0, cfg.dte_max, oggi=oggi)
             if c.conId not in esclusi]
    # Mai letti per primi, poi dal piu' vecchio; a parita', DTE bassi e vicini all'ATM.
    return sorted(resto, key=lambda c: (ultimo.get(c.conId, {}).get('ts_epoch', 0),
                                        c.dte(oggi), abs(c.strike - atm)))


def incremento(volume, precedente: dict | None) -> dict:
    """prev_volume/prev_ts/volume_delta/anomalia rispetto all'ultima lettura OK."""
    if not precedente or precedente.get('ok_volume') is None:
        return {'prev_volume': None, 'prev_ts': None, 'volume_delta': None, 'anomalia': None}
    prima = precedente['ok_volume']
    fuori = {'prev_volume': prima, 'prev_ts': precedente.get('ok_ts'), 'volume_delta': None, 'anomalia': None}
    if volume is None:
        return fuori
    if volume < prima:
        # Azzeramento (nuova sessione) o dato sbagliato: lo si segnala, non lo si corregge.
        fuori['anomalia'] = f'volume sceso da {prima}'
    else:
        fuori['volume_delta'] = volume - prima
    return fuori


class ScannerVolumi:
    def __init__(self, cli: ClienteIbkr, catena: Catena, cfg: Impostazioni, archivio: Archivio):
        self.cli, self.ib, self.cfg = cli, cli.ib, cfg
        self.archivio = archivio
        self.catena = catena
        self.giorno = catena.data_ny
        self.sessione = sessione_di_borsa()[1]
        self.giorno_cambiato = False
        self._anomalie = 0
        self.linee = max(1, cfg.max_linee)
        self.slot: dict[int, _Slot] = {}
        self.scan_id: int | None = None
        self._toccati: set[int] = set()
        self._pausa_fino = 0.0
        archivio.registra_contratti(catena.contratti(dte_max=10_000), self.giorno)
        self.ultimo = archivio.ultime_letture(self.giorno, self.sessione)
        if self.ultimo:
            log.info('ripresa: %s contratti letti in questa sessione (%s)', len(self.ultimo), self.sessione)
        self.ib.errorEvent += self._su_errore

    def aggiorna_catena(self, catena: Catena) -> None:
        self.catena = catena
        self.archivio.registra_contratti(catena.contratti(dte_max=10_000), self.giorno)

    def chiudi(self) -> None:
        for s in list(self.slot.values()):
            self._cancella(s)
        self.slot.clear()
        try:
            self.ib.errorEvent -= self._su_errore
        except Exception:
            pass
        self.archivio.scarica()

    # -- IBKR ---------------------------------------------------------------

    def _su_errore(self, req_id, codice, messaggio, contratto) -> None:
        if codice == 101:
            nuove = max(1, self.linee // 2)
            if nuove < self.linee:
                log.warning('errore 101: linee %s -> %s', self.linee, nuove)
            self.linee = nuove
            self._pausa_fino = time.monotonic() + 10
        conid = getattr(contratto, 'conId', None)
        if conid in self.slot and (codice in _ERRORI_CONTRATTO or codice == 101):
            self.slot[conid].errore = codice

    def _apri(self, c: ContrattoOpzione) -> None:
        ibkr = c.per_ibkr()
        self.cli.limitatore.attendi()
        t = self.ib.reqMktData(ibkr, '', False, False)
        t.marketDataType = 0
        self.slot[c.conId] = _Slot(c, ibkr, t)

    def _cancella(self, s: _Slot) -> None:
        try:
            self.cli.limitatore.attendi()
            self.ib.cancelMktData(s.ibkr)
        except Exception:
            pass

    def _pronto(self, s: _Slot, adesso: float) -> bool:
        t = s.ticker
        if s.errore is not None:
            return True
        if s.t_volume is None and valido(t.volume):
            s.t_volume = adesso
        if adesso - s.t0 >= self.cfg.timeout_s:
            return True
        if s.t_volume is None:
            return False
        quotato = valido(t.bid) and valido(t.ask)
        # Dopo il volume si concede un attimo a bid/ask e al tipo di dato: i
        # contratti lontani spesso non hanno bid, e li' non si aspetta oltre.
        return (quotato and t.marketDataType != 0) or adesso - s.t_volume >= 0.4

    def _cambia_sessione(self, giorno: str, sessione: str) -> None:
        log.info('cambio sessione: %s %s -> %s %s (IBKR riparte da zero col volume)',
                 self.giorno, self.sessione, giorno, sessione)
        self.aggiorna_riepilogo()  # chiude la sessione vecchia
        if giorno != self.giorno:
            self.giorno_cambiato = True
        self.giorno, self.sessione = giorno, sessione
        self.ultimo = self.archivio.ultime_letture(giorno, sessione)

    def _registra(self, s: _Slot, gruppo: str) -> dict | None:
        c, t = s.contratto, s.ticker
        if s.errore == 101:
            return None  # torna in coda
        giorno, sessione = sessione_di_borsa()
        giorno = giorno.isoformat()
        if (giorno, sessione) != (self.giorno, self.sessione):
            self._cambia_sessione(giorno, sessione)
        valore = num(t.volume)
        volume = int(valore) if valore is not None else None
        ts = int(time.time())
        precedente = self.ultimo.get(c.conId)
        if precedente and precedente.get('ts_epoch') == ts:
            ts += 1  # UNIQUE(con_id, ts): due letture nello stesso secondo non si perdono
        stato = 'ERRORE' if s.errore is not None else 'OK' if volume is not None else 'NON_DISPONIBILE'
        r = {'ts_epoch': ts, 'giorno': self.giorno, 'sessione': self.sessione, 'conId': c.conId, 'scan_id': self.scan_id,
             'dte': c.dte(), 'volume': volume, 'bid': num(t.bid), 'ask': num(t.ask), 'last': num(t.last),
             'tipo_dati': tipo_dati(t), 'stato': stato, 'errore': s.errore, 'gruppo': gruppo,
             **incremento(volume, precedente)}
        if r['anomalia']:
            self._anomalie += 1
            log.debug('%s %s %g%s: %s', c.classe, c.scadenza, c.strike, c.right, r['anomalia'])
        u = self.ultimo.setdefault(c.conId, {})
        u['ts_epoch'] = ts
        if stato == 'OK':
            u['ok_ts'], u['ok_volume'] = ts, volume
        self.archivio.aggiungi_lettura(r)
        self._toccati.add(c.conId)
        return r

    def leggi(self, coda: list, scadenza: float, gruppo: str) -> dict:
        """Legge `coda` con al massimo `self.linee` contratti aperti, fino a `scadenza` (monotonic)."""
        attesa = deque(coda)
        conti = {'letti': 0, 'ok': 0, 'non_disponibili': 0, 'errori': 0, 'rimandati': 0}
        self._pausa_fino = 0.0
        while attesa or self.slot:
            adesso = time.monotonic()
            while (attesa and len(self.slot) < self.linee and adesso < scadenza
                   and adesso >= self._pausa_fino and not self.giorno_cambiato):
                c = attesa.popleft()
                if c.conId not in self.slot:
                    self._apri(c)
            if not self.slot and (adesso >= scadenza or not attesa or self.giorno_cambiato):
                break
            self.ib.sleep(0.05)
            adesso = time.monotonic()
            for conid, s in list(self.slot.items()):
                if not self._pronto(s, adesso):
                    continue
                self._cancella(s)
                del self.slot[conid]
                r = self._registra(s, gruppo)
                if r is None:
                    attesa.appendleft(s.contratto)
                    conti['rimandati'] += 1
                    continue
                conti['letti'] += 1
                conti[{'OK': 'ok', 'NON_DISPONIBILE': 'non_disponibili', 'ERRORE': 'errori'}[r['stato']]] += 1
        conti['non_letti'] = len(attesa)
        return conti

    def aggiorna_riepilogo(self) -> None:
        """Ricalcola `volume_latest` (Fase 6) per i contratti letti dall'ultima volta."""
        self.archivio.scarica()
        t0 = time.monotonic()
        n = aggiorna_ultimi(self.archivio.db, self.giorno, self.sessione, self._toccati)
        self._toccati = set()
        log.info('volume_latest: %s contratti aggiornati in %.2fs', n, time.monotonic() - t0)

    # -- ciclo ---------------------------------------------------------------

    def ciclo(self, numero: int, spx) -> dict:
        cfg = self.cfg
        inizio = time.monotonic()
        fine = inizio + cfg.intervallo_minuti * 60 - cfg.margine_ciclo_s
        _, prezzo = prezzo_spx(self.cli, spx)
        atm = strike_atm(prezzo['riferimento'], self.catena.strike_vicina())
        if atm is None:
            raise RuntimeError('nessun ATM: manca il prezzo SPX o la catena')
        prio = priorita(self.catena, atm, cfg)
        resto = rotazione(self.catena, atm, cfg, {c.conId for c in prio}, self.ultimo)
        meta = {'spx': prezzo['riferimento'], 'fonte_spx': prezzo['fonte_riferimento'], 'atm': atm,
                'universo': len(prio) + len(resto), 'priorita': len(prio),
                'parametri': {'range_strike': cfg.range_strike, 'dte_max': cfg.dte_max,
                              'prio_scadenze': cfg.prio_scadenze, 'prio_range': cfg.prio_range,
                              'linee': self.linee, 'intervallo_minuti': cfg.intervallo_minuti}}
        self._anomalie = 0
        self.scan_id = self.archivio.inizia_ciclo(self.giorno, numero, meta, self.sessione)
        self.archivio.imposta_stato('scanner', {'stato': 'in_ciclo', 'scan_id': self.scan_id, 'giorno': self.giorno,
                                                'client_id': self.cli.client_id, **meta})
        log.info('ciclo %s (scan %s): SPX %s (%s) ATM %g, priorita %s, rotazione %s', numero, self.scan_id,
                 prezzo['riferimento'], prezzo['fonte_riferimento'], atm, len(prio), len(resto))
        p = self.leggi(prio, fine, 'priorita')
        t_prio = time.monotonic() - inizio
        self.aggiorna_riepilogo()  # la zona prioritaria e' subito leggibile dalla pagina
        r = self.leggi(resto, fine, 'rotazione')
        self.aggiorna_riepilogo()
        durata = time.monotonic() - inizio
        # Copertura: quanti contratti dell'universo hanno un volume letto da
        # meno di 60 minuti. E' il numero da mostrare, non "16.800 monitorati".
        soglia = time.time() - 3600
        universo = {c.conId for c in prio} | {c.conId for c in resto}
        freschi = sum(1 for k in universo if self.ultimo.get(k, {}).get('ok_ts', 0) >= soglia)
        mai = sum(1 for k in universo if k not in self.ultimo)
        riepilogo = {**meta, 'scan_id': self.scan_id, 'sessione': self.sessione, 'anomalie': self._anomalie, 'durata_s': round(durata, 1),
                     'durata_priorita_s': round(t_prio, 1), 'priorita_letti': p, 'rotazione_letti': r,
                     'contratti_al_secondo': round((p['letti'] + r['letti']) / durata, 2) if durata else None,
                     'copertura_60min': freschi, 'mai_letti': mai, 'linee': self.linee}
        self.archivio.chiudi_ciclo(self.scan_id, riepilogo)
        self.archivio.imposta_stato('scanner', {'stato': 'in_attesa', 'giorno': self.giorno,
                                                'client_id': self.cli.client_id,
                                                'ultimo_ciclo': {k: v for k, v in riepilogo.items() if k != 'parametri'}})
        log.info('ciclo %s finito in %.0fs (priorita %.0fs): priorita %s, rotazione %s, %.1f contratti/s, '
                 'freschi <60min %s/%s, mai letti %s', numero, durata, t_prio, p, r,
                 riepilogo['contratti_al_secondo'] or 0, freschi, len(universo), mai)
        if self._anomalie:
            log.warning('ciclo %s: %s letture con volume sceso rispetto alla precedente (segnate in anomaly)',
                        numero, self._anomalie)
        if p['non_letti']:
            log.warning('ciclo %s: %s contratti prioritari NON letti entro l\'intervallo', numero, p['non_letti'])
        return riepilogo
