-- Fase 6 bis - sessioni. IBKR azzera il volume giornaliero alle 9:30 NY
-- (apertura cash) e alle 20:15 NY (apertura notturna): ogni lettura appartiene
-- a una sessione ('notturna' | 'cash') del giorno di borsa, e incrementi,
-- riepilogo e alert vivono dentro una sessione. Il riempimento delle righe
-- esistenti e il ricalcolo degli incrementi li fa 003_sessioni.py.
ALTER TABLE volume_snapshots ADD COLUMN sessione TEXT;
ALTER TABLE scan_history ADD COLUMN sessione TEXT;
CREATE INDEX IF NOT EXISTS ix_snap_sessione ON volume_snapshots (giorno, sessione, con_id, ts);

-- volume_latest e scanner_alerts sono derivate (o ancora vuote): si rifanno
-- con la sessione nella chiave.
DROP TABLE IF EXISTS volume_latest;
CREATE TABLE volume_latest (
    giorno              TEXT    NOT NULL,
    sessione            TEXT    NOT NULL,
    con_id              INTEGER NOT NULL,
    trading_class       TEXT    NOT NULL,
    real_expiry         TEXT    NOT NULL,
    dte                 INTEGER NOT NULL,
    strike              REAL    NOT NULL,
    opt_right           TEXT    NOT NULL,
    volume              INTEGER,
    ts                  INTEGER,
    delta_last          INTEGER,
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
    last_attempt_ts     INTEGER NOT NULL,
    last_attempt_status TEXT    NOT NULL,
    anomaly             TEXT,
    updated_at          INTEGER NOT NULL,
    PRIMARY KEY (giorno, sessione, con_id)
);
CREATE INDEX IF NOT EXISTS ix_latest_volume ON volume_latest (giorno, sessione, opt_right, volume DESC);
CREATE INDEX IF NOT EXISTS ix_latest_expiry ON volume_latest (giorno, sessione, real_expiry, strike);

DROP TABLE IF EXISTS scanner_alerts;
CREATE TABLE scanner_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    giorno      TEXT    NOT NULL,
    sessione    TEXT    NOT NULL,
    con_id      INTEGER NOT NULL,
    kind        TEXT    NOT NULL,
    level       INTEGER NOT NULL DEFAULT 0,
    value       REAL,
    message     TEXT,
    sent_at     INTEGER,
    UNIQUE (giorno, sessione, con_id, kind, level)
);
