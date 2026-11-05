"""
Limitatore a gettoni per i messaggi verso TWS.

TWS accetta al massimo 50 messaggi al secondo per connessione; oltre, la
chiude. Lo scanner si tiene molto sotto (default 10/s) perche' non ha fretta
e perche' TWS serve anche i poller della dashboard.

`attendi()` usa `ib.sleep` quando c'e' una connessione, cosi' mentre si
aspetta ib_insync continua a smaltire i messaggi in arrivo.
"""

import time


class LimitatoreRichieste:
    def __init__(self, al_secondo: float, raffica: int | None = None, dormi=None):
        self.al_secondo = max(0.1, float(al_secondo))
        self.capienza = float(raffica if raffica is not None else max(1, int(self.al_secondo)))
        self.gettoni = self.capienza
        self.ultimo = time.monotonic()
        self._dormi = dormi or time.sleep
        self.inviati = 0

    def _ricarica(self) -> None:
        adesso = time.monotonic()
        self.gettoni = min(self.capienza, self.gettoni + (adesso - self.ultimo) * self.al_secondo)
        self.ultimo = adesso

    def attendi(self, costo: float = 1.0) -> None:
        self._ricarica()
        while self.gettoni < costo:
            self._dormi((costo - self.gettoni) / self.al_secondo)
            self._ricarica()
        self.gettoni -= costo
        self.inviati += 1
