-- Fase 6 - ultima situazione di ogni contratto nel giorno di borsa, con gli
-- incrementi gia' calcolati. La scrive lo scanner (scanner/volume_analyzer.py)
-- dopo il gruppo prioritario e a fine ciclo; la pagina la legge filtrando.
--
-- Gli incrementi sono differenze fra due letture dello stesso contratto: la
-- somma di tutto cio' che e' passato in mezzo, mai una singola esecuzione.
-- `*_window_s` e' la distanza vera fra le due letture: un "30 minuti" e'
-- calcolato solo se esiste una lettura fra 30 e 42 minuti prima (un ciclo di
-- tolleranza), altrimenti e' NULL. I contratti in rotazione, letti ogni ~90
-- minuti, hanno quindi spesso NULL a 30/60 minuti: non e' zero.
CREATE TABLE IF NOT EXISTS volume_latest (
    giorno              TEXT    NOT NULL,
    con_id              INTEGER NOT NULL,
    trading_class       TEXT    NOT NULL,
    real_expiry         TEXT    NOT NULL,
    dte                 INTEGER NOT NULL,
    strike              REAL    NOT NULL,
    opt_right           TEXT    NOT NULL,
    volume              INTEGER,            -- ultimo volume OK del giorno
    ts                  INTEGER,            -- ora di quella lettura
    delta_last          INTEGER,            -- rispetto alla lettura OK precedente
    delta_last_window_s INTEGER,
    inc_30m             INTEGER,
    inc_30m_window_s    INTEGER,
    inc_60m             INTEGER,
    inc_60m_window_s    INTEGER,
    bid                 REAL,
    ask                 REAL,
    last_price          REAL,
    data_type           TEXT,
    readings_ok         INTEGER NOT NULL,
    last_attempt_ts     INTEGER NOT NULL,   -- ultimo tentativo, anche fallito
    last_attempt_status TEXT    NOT NULL,
    anomaly             TEXT,               -- ultima anomalia del giorno, se c'e'
    updated_at          INTEGER NOT NULL,
    PRIMARY KEY (giorno, con_id)
);
CREATE INDEX IF NOT EXISTS ix_latest_volume ON volume_latest (giorno, opt_right, volume DESC);
CREATE INDEX IF NOT EXISTS ix_latest_expiry ON volume_latest (giorno, real_expiry, strike);
