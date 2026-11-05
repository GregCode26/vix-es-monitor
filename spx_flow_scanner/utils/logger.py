"""Log su console e su file a rotazione in `.tmp/spx_flow_scanner/logs/`."""

import logging
import sys
from logging.handlers import RotatingFileHandler

from spx_flow_scanner.config.settings import CARTELLA_DATI

_configurato = False


def prendi_logger(nome: str = 'scanner') -> logging.Logger:
    global _configurato
    if not _configurato:
        cartella = CARTELLA_DATI / 'logs'
        cartella.mkdir(parents=True, exist_ok=True)
        formato = logging.Formatter('%(asctime)s %(levelname)-7s %(name)s: %(message)s',
                                    '%Y-%m-%d %H:%M:%S')
        radice = logging.getLogger('spx')
        radice.setLevel(logging.INFO)
        su_file = RotatingFileHandler(cartella / 'scanner.log', maxBytes=5_000_000,
                                      backupCount=5, encoding='utf-8')
        su_file.setFormatter(formato)
        su_console = logging.StreamHandler(sys.stdout)
        su_console.setFormatter(formato)
        radice.addHandler(su_file)
        radice.addHandler(su_console)
        # ib_insync scrive i suoi errori nel logging: li si tiene, ma solo
        # dai warning in su, altrimenti ogni tick finisce nel log.
        logging.getLogger('ib_insync').setLevel(logging.WARNING)
        _configurato = True
    return logging.getLogger(f'spx.{nome}')
