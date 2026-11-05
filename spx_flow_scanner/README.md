# SPX Options Volume Scanner

Scanner dei volumi delle opzioni SPX 0-90 DTE da IBKR (TWS), con pagina nel
dashboard Next.js e storico in SQLite (`frontend/data/spx-scanner/scanner.db`).
Sviluppato per fasi.

## Vincolo principale: le linee di market data

Il conto ha ~100 linee e i poller della dashboard ne usano ~90. Lo scanner ne
apre al massimo `SCANNER_MAX_LINEE` (default 4) e si ferma su errore 101: e'
lento per scelta, per non togliere dati ai poller. Un giro completo della
chain richiede quindi molto piu' di 10 minuti; la scansione sara' progressiva
(prima ATM e DTE bassi) e ogni contratto avra' l'eta' del proprio dato.

## Fase 1 - connessione e sonda

Dalla radice del repo, con TWS aperto (API abilitate, porta 7496):

```bash
pip install -r spx_flow_scanner/requirements.txt
python -m spx_flow_scanner.main verifica   # connessione, conti, scarto orologio
python -m spx_flow_scanner.main sonda      # snapshot vs streaming su 8 contratti
```

La sonda misura su contratti veri se lo snapshot porta il volume, se rifiuta
il generic tick 101 (OI), i tempi di arrivo in streaming, il tipo di dato
(LIVE/FROZEN/DELAYED) e quanti contratti esistono davvero nel range; salva il
resoconto in `.tmp/spx_flow_scanner/sonda_*.json`. Log in
`.tmp/spx_flow_scanner/logs/scanner.log`.

clientId nella fascia 30000-39999, connessione `readonly`.

### Esito sonda 05/11/2026 (sessione notturna, dati LIVE)

- ~16.400 contratti reali in 0-90 DTE entro ATM +/-2000 (33 scadenze SPXW,
  3 SPX AM; SPXO senza strike nel range).
- Snapshot: porta il volume ma non distingue 0 da mancante e rifiuta i
  generic tick (321). Streaming temporaneo: volume e bid/ask in ~0.2 s.
- Scelta: streaming temporaneo **senza generic tick**, chiuso appena arriva il
  volume. **Open interest escluso** su richiesta dell'utente (niente tick 101,
  niente Volume/OI, niente alert volume > OI).
- Ritmo con 4 linee e 10 msg/s: ~4.3 contratti/s, giro completo ~63 min ->
  scansione progressiva a priorita' (0-7 DTE vicino all'ATM ogni 10 minuti,
  il resto a rotazione con l'eta' del dato).

## Fase 2 - catena 0-90 DTE

```bash
python -m spx_flow_scanner.main catena          # usa la cache del giorno
python -m spx_flow_scanner.main catena --forza  # rilegge tutto
python -m unittest discover -s spx_flow_scanner/tests -t .
```

- Contratti veri da `reqContractDetails` (una richiesta per scadenza, nessuna
  linea di market data), cache in `.tmp/spx_flow_scanner/catena/YYYY-MM-DD.json`
  con **tutti** gli strike (il range si filtra dopo), salvata dopo ogni
  scadenza: un'interruzione riparte da dove era.
- SPX (AM) e SPXW restano distinte. Il DTE si conta su `realExpirationDate`:
  le SPX AM hanno ultimo trade il giovedi' (20261119) ma scadono il venerdi'
  (20261120), lo stesso giorno della SPXW 20261120.
- Scadenze 0-7 DTE rilette dopo 60 minuti (il Cboe aggiunge strike in giornata).
- Orari e festivita' da `tradingHours`/`liquidHours` di IBKR (`utils/market_calendar.py`).
- 05/11/2026: 36 scadenze (33 SPXW, 3 SPX), 16.800 contratti entro ATM +/-2000,
  prima lettura 177 s / 37 richieste, dalla cache 0,2 s / 1 richiesta.

## Fase 4 - lettura dei volumi

```bash
python -m spx_flow_scanner.main scansiona             # a oltranza, solo a mercato opzioni aperto
python -m spx_flow_scanner.main scansiona --cicli 1   # un ciclo di prova
```

- Ciclo ogni 10 minuti: **priorita'** = le prime 2 scadenze (oggi e la
  successiva; il venerdi' la successiva e' il lunedi') entro ATM +/-2000, tutte;
  **rotazione** = il resto, dal dato piu' vecchio, nel tempo che avanza.
- Streaming senza generic tick, max 4 contratti aperti, chiuso appena arrivano
  volume e bid/ask; timeout 3 s = NON_DISPONIBILE (mai zero). Errore 101 ->
  linee dimezzate e contratto rimesso in coda.
- Giorno di borsa: dalle 20:15 NY (apertura notturna) e' gia' il giorno dopo.
  Un volume giornaliero che scende viene segnato come `anomalia`.
- Uscita: il database SQLite (Fase 5). Al riavvio riprende la rotazione.
- 05/11/2026, notturna: priorita' 1.102 contratti in 225 s, rotazione 1.778,
  5,0 contratti/s (il freno e' il limite di 10 msg/s), tutto LIVE, 0 errori.
  Giro completo della rotazione ~9 cicli (~90 min).

## Fase 5 - database SQLite

PostgreSQL era la scelta del prompt, ma l'installer EDB rispondeva 403
("Request blocked") da questa rete per tutte le versioni: l'utente ha scelto
SQLite. Nessuna installazione; la pagina Next lo leggera' con `node:sqlite`
(Node 24).

- File `frontend/data/spx-scanner/scanner.db`, WAL (lo scanner scrive mentre
  la pagina legge). Schema in `database/migrations/001_schema.sql`, versione in
  `PRAGMA user_version`.
- Tabelle: `options_contracts`, `volume_snapshots` (volume, prev_volume,
  volume_delta, tipo dato, stato, anomalia), `market_quotes` (bid/ask/last),
  `scan_history`, `scanner_alerts` (deduplica per giorno/contratto/tipo/livello),
  `system_status`. Niente open interest.
- `volume` NULL = non disponibile, mai 0. `volume_delta` = rispetto all'ultima
  lettura OK dello stesso contratto nel giorno di borsa; NULL se il volume scende
  (segnato in `anomaly`). Un incremento non e' una singola esecuzione.
- Deduplica con UNIQUE(con_id, ts). Scritture a blocchi (200 righe o 5 s).
- Dimensione misurata: ~200 byte per lettura con indici, ~0,5 MB per ciclo,
  ~3,5 MB/ora, ~75 MB per una giornata intera (notturna compresa). Nessuna
  pulizia automatica per ora.
- 05/11/2026 ciclo durante il pre-cash con il poller volumi attivo: 1.102
  prioritari in 256 s, 1.417 in rotazione, 4,3 contratti/s, nessun 101. 10 non
  disponibili (NULL): 6 0DTE 7540-7550 LIVE senza tick di volume in 3 s, 4
  SPXW 13/11 con errore 354 arrivato dopo la chiusura della richiesta.

## Fase 6 - incrementi e filtri

```bash
python -m spx_flow_scanner.main analisi                      # LARGE CALL / LARGE PUT, non serve TWS
python -m spx_flow_scanner.main analisi --min 1000 --tipo P --dte 0-7 --range 300
python -m spx_flow_scanner.main analisi --atm apertura       # ATM del primo ciclo dopo le 9:30 NY
python -m spx_flow_scanner.main analisi --atm storico --ora 11:00
```

- Tabella `volume_latest` (migrazione 002): una riga per contratto e giorno,
  ricalcolata dallo scanner dopo il gruppo prioritario e a fine ciclo.
  Volume del giorno, incremento sull'ultima lettura (con la sua finestra vera),
  `inc_30m`/`inc_60m`, bid/ask/last, tipo dato, ultimo tentativo.
- `inc_30m` = differenza con la lettura OK piu' recente almeno 30 minuti prima,
  purche' non oltre 42 (un ciclo di tolleranza); idem 60/72. Altrimenti NULL:
  i contratti in rotazione (letti ogni ~90 min) hanno di solito solo
  l'incremento sull'ultima lettura. Volume che scende nella finestra -> NULL.
- Filtri (`scanner/filters.py`, la pagina li ripetera' in SQL): volume minimo
  per singolo contratto (classe + scadenza + strike + lato), CALL/PUT/entrambe,
  DTE, range attorno all'ATM, eta' massima. Copertura: contratti con volume su
  quelli tentati, letti negli ultimi 30/60 minuti.
- ATM di riferimento (`riferimento_atm`): corrente, apertura (non esiste prima
  delle 9:30 NY), storico a un'ora data. Viene da `scan_history`.

### Sessioni: IBKR azzera il volume due volte al giorno (05/11/2026)

All'apertura del cash (9:30 NY) il volume giornaliero di IBKR riparte da zero:
la 7700C 0DTE era a 5.475 alle 9:09 (notturna) e a 2.020 alle 9:34. Il volume
della notturna (20:15-9:25 NY) non e' compreso in quello del cash. Quindi:

- ogni lettura ha `sessione` = `notturna` | `cash` (`utils/market_calendar.sessione_di_borsa`:
  cash dalle 9:30 alle 20:15 NY, notturna il resto, del giorno di borsa successivo);
- incrementi, `volume_latest`, alert e filtri vivono dentro una sessione; la prima
  lettura del cash non ha base (niente incremento, niente anomalia);
- `analisi --sessione notturna|cash` (default quella in corso);
- migrazione 003 (`.sql` schema + `.py` dati): riempie la sessione sulle righe
  vecchie e ricalcola gli incrementi (`volume_analyzer.ricalcola_incrementi`).
  Le migrazioni ora possono avere una parte Python `NNN_*.py` con `migra(db)`.

Fra le 9:25 e le 9:30 NY il mercato opzioni e' chiuso: lo scanner aspetta.

## Singoli trade (05/11/2026, richiesta dell'utente)

Il filtro "n contratti" vale per il **singolo trade**, non per il volume
cumulativo: per ogni contratto si sommano solo le stampe che da sole sono
>= N. Le stampe non si uniscono (un ordine eseguito come 400+200+200+200 allo
stesso secondo e prezzo, con N = 500, non conta): scelta dell'utente.

    python -m spx_flow_scanner.main trade        # accanto a `scansiona`, a oltranza

- Fonte: `reqHistoricalTicks(..., 'TRADES')`, 1000 stampe per richiesta,
  risoluzione al secondo, con prezzo e borsa. Non usa linee di market data.
- Quali contratti: un trade >= N puo' esserci solo dove il volume della
  sessione e' salito di >= N dall'ultima lettura dei trade, quindi i candidati
  vengono da `volume_latest`. Con soglia di base 500 (scelta dell'utente) ~95 per ciclo da
  10 minuti (con 100 sarebbero ~200, misurato il 05/11).
- Si salvano solo le stampe >= `SCANNER_TRADE_MIN` (default 500) nella tabella
  `trades`; `trade_cursor` dice fin dove e' stato letto ogni contratto. La
  pagina non puo' filtrare sotto la soglia di base e lo dice.
- Ritmo misurato: 60 richieste a 1/s senza errori di pacing, ma dopo ~20 IBKR
  rallenta da solo a 5-12 s l'una (~280 richieste ogni 10 minuti). Errore
  162 di pacing: pausa di 10 minuti.
- Un contratto molto scambiato ha decine di migliaia di stampe al giorno (7500P
  0DTE del 05/11: ~10.000 stampe nelle prime 10 pagine): al massimo
  `SCANNER_TRADE_PAGINE` (10) pagine per contratto per giro, poi si passa agli
  altri. La pagina mostra quanti contratti hanno volume salito di >= N e
  trade non ancora verificati.
