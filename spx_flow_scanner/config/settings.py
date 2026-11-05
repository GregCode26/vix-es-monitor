"""
Configurazione dello scanner, letta da variabili d'ambiente (file
`spx_flow_scanner/.env`, vedi `.env.example`).

Il punto delicato e' `max_linee`: il conto ha ~100 linee di market data e i
poller della dashboard (volumi, IV, VIX/ES, anello esterno a rotazione) ne
tengono gia' ~90. Lo scanner deve restare nelle briciole: pochissime linee
alla volta, a costo di metterci ore per un giro completo della chain.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

RADICE_PROGETTO = Path(__file__).resolve().parents[2]
CARTELLA_SCANNER = Path(__file__).resolve().parents[1]
CARTELLA_DATI = RADICE_PROGETTO / '.tmp' / 'spx_flow_scanner'

try:
    from dotenv import load_dotenv
    load_dotenv(CARTELLA_SCANNER / '.env')
except ImportError:
    pass


def _int(nome: str, predefinito: int) -> int:
    valore = os.environ.get(nome)
    return int(valore) if valore not in (None, '') else predefinito


def _float(nome: str, predefinito: float) -> float:
    valore = os.environ.get(nome)
    return float(valore) if valore not in (None, '') else predefinito


@dataclass(frozen=True)
class Impostazioni:
    # Connessione. TWS (non IB Gateway) sulla 7496, come i poller.
    host: str = field(default_factory=lambda: os.environ.get('SCANNER_TWS_HOST', '127.0.0.1'))
    porta: int = field(default_factory=lambda: _int('SCANNER_TWS_PORT', 7496))
    # clientId casuale in una fascia propria: i poller usano 1000-9999, gli
    # studi 10000-29999. Cosi' non si rubano mai la connessione a vicenda.
    client_id_min: int = 30000
    client_id_max: int = 39999
    timeout_connessione: float = field(default_factory=lambda: _float('SCANNER_TIMEOUT', 15))
    tentativi_connessione: int = field(default_factory=lambda: _int('SCANNER_TENTATIVI', 5))

    # Limiti verso IBKR.
    max_linee: int = field(default_factory=lambda: _int('SCANNER_MAX_LINEE', 4))
    messaggi_al_secondo: float = field(default_factory=lambda: _float('SCANNER_MSG_AL_SECONDO', 10))
    # 1 = live, 2 = frozen, 3 = delayed, 4 = delayed frozen.
    tipo_dati_richiesto: int = field(default_factory=lambda: _int('SCANNER_TIPO_DATI', 1))

    # Universo (default del prompt, modificabili poi dalla dashboard).
    range_strike: int = field(default_factory=lambda: _int('SCANNER_RANGE_STRIKE', 2000))
    dte_max: int = field(default_factory=lambda: _int('SCANNER_DTE_MAX', 90))
    volume_minimo: int = field(default_factory=lambda: _int('SCANNER_VOLUME_MIN', 500))
    intervallo_minuti: int = field(default_factory=lambda: _int('SCANNER_INTERVALLO_MIN', 10))

    # Zona letta per intero a ogni ciclo: le prime N scadenze (oggi e la
    # successiva) entro ATM +/- prio_range. Il resto va a rotazione.
    prio_scadenze: int = field(default_factory=lambda: _int('SCANNER_PRIO_SCADENZE', 2))
    prio_range: int = field(default_factory=lambda: _int('SCANNER_PRIO_RANGE', 2000))
    # Oltre questo tempo senza volume un contratto e' NON_DISPONIBILE.
    timeout_s: float = field(default_factory=lambda: _float('SCANNER_TIMEOUT_CONTRATTO', 3))
    # Secondi lasciati liberi a fine ciclo (catena, scrittura file).
    margine_ciclo_s: int = 20

    # Database (Fase 5).
    postgres_dsn: str = field(default_factory=lambda: os.environ.get('SCANNER_PG_DSN', ''))


IMPOSTAZIONI = Impostazioni()
