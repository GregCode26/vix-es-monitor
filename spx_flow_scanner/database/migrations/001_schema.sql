-- SPX Options Volume Scanner - schema SQLite (versione 1).
-- Orari: `ts` in secondi epoch UTC; `giorno` = giorno di borsa NY (YYYY-MM-DD,
-- dalle 20:15 NY e' gia' il giorno dopo). Niente open interest: escluso
-- su richiesta dell'utente.

-- Ogni contratto visto nella catena. SPX (AM) e SPXW sono righe diverse anche
-- con la stessa scadenza reale.
CREATE TABLE IF NOT EXISTS options_contracts (
    con_id          INTEGER PRIMARY KEY,
    trading_class   TEXT    NOT NULL CHECK (trading_class IN ('SPX', 'SPXW')),
    expiry          TEXT    NOT NULL,   -- lastTradeDateOrContractMonth (SPX AM: il giovedi')
    real_expiry     TEXT    NOT NULL,   -- realExpirationDate (base del DTE)
    strike          REAL    NOT NULL,
    opt_right       TEXT    NOT NULL CHECK (opt_right IN ('C', 'P')),
    local_symbol    TEXT,
    first_seen      TEXT    NOT NULL,   -- giorno di borsa
    last_seen       TEXT    NOT NULL,
    UNIQUE (trading_class, expiry, strike, opt_right)
);
CREATE INDEX IF NOT EXISTS ix_contracts_expiry ON options_contracts (real_expiry, strike);

-- Una riga per ciclo di scansione.
CREATE TABLE IF NOT EXISTS scan_history (
    scan_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    giorno              TEXT    NOT NULL,
    numero              INTEGER NOT NULL,   -- ciclo nel processo
    started_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    spx                 REAL,
    spx_source          TEXT,               -- last / close
    atm                 REAL,
    universe            INTEGER,
    priority            INTEGER,
    read_ok             INTEGER,
    unavailable         INTEGER,
    errors              INTEGER,
    not_read            INTEGER,            -- rimasti in coda a fine intervallo
    priority_not_read   INTEGER,
    rate                REAL,               -- contratti al secondo
    fresh_60min         INTEGER,            -- contratti con volume letto da < 60 min
    never_read          INTEGER,
    lines               INTEGER,
    params              TEXT                -- JSON
);
CREATE INDEX IF NOT EXISTS ix_scan_giorno ON scan_history (giorno, started_at);

-- Una riga per lettura del volume. `volume` NULL = non disponibile, mai 0.
-- prev_volume/volume_delta: rispetto all'ultima lettura OK dello stesso
-- contratto nello stesso giorno di borsa. Un incremento NON e' una singola
-- esecuzione: e' la somma di tutto cio' che e' passato fra le due letture.
CREATE TABLE IF NOT EXISTS volume_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    giorno          TEXT    NOT NULL,
    con_id          INTEGER NOT NULL REFERENCES options_contracts (con_id),
    scan_id         INTEGER REFERENCES scan_history (scan_id),
    dte             INTEGER NOT NULL,
    volume          INTEGER,
    prev_volume     INTEGER,
    prev_ts         INTEGER,
    volume_delta    INTEGER,                -- NULL se manca un estremo o il volume e' sceso
    data_type       TEXT    NOT NULL,       -- LIVE / FROZEN / DELAYED / DELAYED_FROZEN / NON_COMUNICATO
    status          TEXT    NOT NULL CHECK (status IN ('OK', 'NON_DISPONIBILE', 'ERRORE')),
    error_code      INTEGER,
    scan_group      TEXT,                   -- priorita / rotazione
    anomaly         TEXT,
    UNIQUE (con_id, ts)
);
CREATE INDEX IF NOT EXISTS ix_snap_giorno_con ON volume_snapshots (giorno, con_id, ts);
CREATE INDEX IF NOT EXISTS ix_snap_giorno_ts ON volume_snapshots (giorno, ts);

-- Quotazioni della stessa lettura (stessa chiave con_id + ts).
CREATE TABLE IF NOT EXISTS market_quotes (
    con_id      INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    bid         REAL,
    ask         REAL,
    last_price  REAL,
    data_type   TEXT    NOT NULL,
    PRIMARY KEY (con_id, ts)
);

-- Alert (Fase 10). La chiave unica e' la deduplica: lo stesso tipo di alert
-- sullo stesso contratto nello stesso giorno scatta una volta per livello.
CREATE TABLE IF NOT EXISTS scanner_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    giorno      TEXT    NOT NULL,
    con_id      INTEGER NOT NULL,
    kind        TEXT    NOT NULL,
    level       INTEGER NOT NULL DEFAULT 0,
    value       REAL,
    message     TEXT,
    sent_at     INTEGER,
    UNIQUE (giorno, con_id, kind, level)
);

-- Stato del sistema: chiave -> JSON (connessione, ultimo ciclo, battito).
CREATE TABLE IF NOT EXISTS system_status (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
