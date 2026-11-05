-- Fase 6 ter - singoli trade. Il volume letto a intervalli e' una somma: non
-- dice se 3.000 contratti sono un blocco o 300 trade da 10. I trade arrivano
-- dallo storico tick di IBKR (reqHistoricalTicks TRADES), solo per i contratti
-- il cui volume e' cresciuto di almeno la soglia di base dall'ultima lettura
-- dei trade: un trade >= N puo' esserci solo dove il volume e' salito di >= N.
-- Si salvano solo i trade >= soglia di base (SCANNER_TRADE_MIN): ogni stampa a
-- se', senza unire quelle dello stesso secondo (scelta dell'utente).
CREATE TABLE IF NOT EXISTS trades (
    con_id      INTEGER NOT NULL,
    ts          INTEGER NOT NULL,          -- epoch, secondi (risoluzione IBKR)
    seq         INTEGER NOT NULL,          -- posizione della stampa nel secondo
    giorno      TEXT    NOT NULL,
    sessione    TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    price       REAL,
    exchange    TEXT,
    conditions  TEXT,
    PRIMARY KEY (con_id, ts, seq)
);
CREATE INDEX IF NOT EXISTS ix_trades_sessione ON trades (giorno, sessione, size);

-- Fin dove sono stati letti i trade di ogni contratto, per sessione.
--   fino_ts / n_nel_secondo: ultimo secondo letto e quante stampe di quel
--     secondo si sono gia' viste (la pagina dopo riparte da quel secondo).
--   vol_rif: volume della sessione (dallo scanner) quando la lettura ha
--     raggiunto il presente; il contratto torna candidato quando il volume
--     supera vol_rif di almeno la soglia di base.
CREATE TABLE IF NOT EXISTS trade_cursor (
    giorno          TEXT    NOT NULL,
    sessione        TEXT    NOT NULL,
    con_id          INTEGER NOT NULL,
    fino_ts         INTEGER,
    n_nel_secondo   INTEGER NOT NULL DEFAULT 0,
    vol_rif         INTEGER NOT NULL DEFAULT 0,
    vol_rif_ts      INTEGER,
    in_pari         INTEGER NOT NULL DEFAULT 0,  -- 1 = letto fino al presente
    stampe_lette    INTEGER NOT NULL DEFAULT 0,  -- tutte, anche sotto soglia
    contratti_letti INTEGER NOT NULL DEFAULT 0,
    pagine          INTEGER NOT NULL DEFAULT 0,
    soglia          INTEGER NOT NULL,
    aggiornato      INTEGER NOT NULL,
    PRIMARY KEY (giorno, sessione, con_id)
);
