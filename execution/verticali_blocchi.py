"""I vertical eseguiti sullo SPX 0DTE, riconosciuti dai singoli trade, e il
Market Tide calcolato sugli stessi trade.

IBKR non dice quali trade delle opzioni sono gambe di un ordine multi-leg: il
test del 27/10/2026 ha trovato i codici OPRA (`specialConditions`) vuoti in
tutti i 5.443 tick storici guardati, e il tick-by-tick non e' supportato sulle
SPXW (errore 10189). Resta RTVolume (tick generico 233), che da' prezzo e size
di ogni trade sulle stesse linee di market data gia' aperte. Un vertical si
riconosce cosi':

1. due trade sullo stesso lato (call o put), strike K e K+L con L multiplo
   di 5 fino a AMPIEZZA_MAX, stessa size, arrivati entro FINESTRA_SEC: le
   gambe di un ordine complesso si stampano insieme. Fino al 28/10/2026 solo
   L = 5, e il 7670/7680 da 3.000 contratti di quel giorno non si vedeva;
2. il prezzo del vertical (gamba cara - gamba economica) sta fra il credito e
   il debito al naturale del bid/ask in vigore PRIMA dei trade, con
   TOLLERANZA: due ordini singoli che capitano insieme di rado fanno un
   prezzo coerente;
3. il verso dal prezzo: sopra il mid del vertical comprato (bull call, bear
   put), sotto venduto (bear call, bull put), sul mid incerto.

Un ordine grosso si divide spesso fra piu' controparti, e ogni pezzo si stampa
come un vertical a se': i pezzi sullo stesso vertical e verso entro
UNIONE_SEC diventano un blocco solo.

I blocchi si accodano a `frontend/data/verticali/YYYY-MM-DD.ndjson`, che legge
/api/verticali. Solo locale.

Ogni trade, quando si sa se era una gamba o no, passa anche al Market Tide
(`tide`, vedi MarketTide in tws_volumes_poller.py): i trade singoli uno per
uno, i vertical una volta sola, con il loro prezzo e verso.
"""

import json
import os
from datetime import datetime

FINESTRA_SEC = 0.5
UNIONE_SEC = 1.0
TOLLERANZA = 0.10
PASSO = 5
AMPIEZZA_MAX = 50
# Sotto questa size le coppie sono quasi tutte coincidenze (il 27/10, sui tick
# della notte, 868 coppie su 955 erano di 1 contratto).
SIZE_MIN = 5


def _valido(x):
    return x is not None and x == x and x > 0


class RilevaVerticali:
    def __init__(self, cartella, tide=None):
        self.cartella = cartella
        self.tide = tide
        # conId -> (bid, ask) in vigore
        self.quote = {}
        # trade in attesa di essere accoppiati: dict con t, strike, lato, prezzo, size, bid, ask
        self.attesa = []
        # blocchi in costruzione (si chiudono dopo UNIONE_SEC senza pezzi nuovi)
        self.aperti = []
        self.trade_visti = 0

    def su_tickers(self, tickers):
        for t in tickers:
            c = t.contract
            if c is None or c.secType != 'OPT':
                continue
            bid, ask = self.quote.get(c.conId, (None, None))
            for d in t.ticks:
                # 48 = RTVolume: un trade con prezzo e size.
                if d.tickType != 48 or not _valido(d.price) or not _valido(d.size):
                    continue
                self.trade_visti += 1
                self.attesa.append({"t": d.time.timestamp(), "strike": c.strike, "lato": c.right,
                                    "prezzo": d.price, "size": int(d.size), "bid": bid, "ask": ask})
            # Dopo i trade: la quotazione vale per quelli che vengono.
            if _valido(t.bid) and _valido(t.ask) and t.ask > t.bid:
                self.quote[c.conId] = (t.bid, t.ask)

    def _vertical(self, a, b):
        """Il blocco formato da due trade accoppiati, o None se il prezzo non torna."""
        basso, alto = (a, b) if a["strike"] < b["strike"] else (b, a)
        # Sulle call vale di piu' lo strike basso, sulle put quello alto.
        cara, economica = (basso, alto) if a["lato"] == 'C' else (alto, basso)
        prezzo = round(cara["prezzo"] - economica["prezzo"], 2)
        if not 0 <= prezzo <= alto["strike"] - basso["strike"]:
            return None
        verso = "incerto"
        debito = credito = None
        if None not in (cara["bid"], cara["ask"], economica["bid"], economica["ask"]):
            debito = round(cara["ask"] - economica["bid"], 2)
            credito = round(cara["bid"] - economica["ask"], 2)
            if not credito - TOLLERANZA <= prezzo <= debito + TOLLERANZA:
                return None
            mid = (debito + credito) / 2
            if prezzo > mid + 1e-9:
                verso = "comprato"
            elif prezzo < mid - 1e-9:
                verso = "venduto"
        return {"ts": max(a["t"], b["t"]), "k1": basso["strike"], "k2": alto["strike"], "lato": a["lato"],
                "size": a["size"], "prezzo": prezzo, "verso": verso, "debito": debito, "credito": credito}

    def elabora(self, adesso, date_key):
        """Accoppia i trade piu' vecchi di FINESTRA_SEC e scrive i blocchi chiusi."""
        self.attesa.sort(key=lambda x: x["t"])
        restano = []
        usati = set()
        for i, a in enumerate(self.attesa):
            if i in usati:
                continue
            if adesso - a["t"] < FINESTRA_SEC:
                restano.append(a)
                continue
            migliore = None
            for j in range(i + 1, len(self.attesa)):
                b = self.attesa[j]
                if b["t"] - a["t"] > FINESTRA_SEC:
                    break
                if j in usati or b["lato"] != a["lato"] or b["size"] != a["size"]:
                    continue
                ampiezza = abs(b["strike"] - a["strike"])
                if ampiezza == 0 or ampiezza > AMPIEZZA_MAX or ampiezza % PASSO:
                    continue
                # La gamba piu' vicina nel tempo, a parita' la piu' stretta.
                chiave = (b["t"] - a["t"], ampiezza)
                if migliore is None or chiave < migliore[0]:
                    migliore = (chiave, j)
            if migliore is not None and a["size"] >= SIZE_MIN:
                v = self._vertical(a, self.attesa[migliore[1]])
                if v:
                    usati.add(migliore[1])
                    self._unisci(v)
                    if self.tide:
                        self.tide.vertical(v)
                    continue
            # Senza compagna: se e' ancora nella finestra di qualcuno piu'
            # giovane resta in attesa, altrimenti era un trade singolo.
            if adesso - a["t"] < 2 * FINESTRA_SEC:
                restano.append(a)
            elif self.tide:
                self.tide.trade(a)
        self.attesa = [x for x in restano]
        self._chiudi(adesso, date_key)

    def _unisci(self, v):
        for b in self.aperti:
            if (b["k1"], b["k2"], b["lato"], b["verso"]) == (v["k1"], v["k2"], v["lato"], v["verso"]) and v["ts"] - b["ts"] <= UNIONE_SEC:
                # Prezzo medio pesato sulle size, ora dell'ultimo pezzo.
                b["prezzo"] = round((b["prezzo"] * b["size"] + v["prezzo"] * v["size"]) / (b["size"] + v["size"]), 2)
                b["size"] += v["size"]
                b["ts"] = v["ts"]
                b["pezzi"] += 1
                return
        v["pezzi"] = 1
        self.aperti.append(v)

    def _chiudi(self, adesso, date_key):
        chiusi = [b for b in self.aperti if adesso - b["ts"] > UNIONE_SEC]
        if not chiusi:
            return
        self.aperti = [b for b in self.aperti if adesso - b["ts"] <= UNIONE_SEC]
        try:
            os.makedirs(self.cartella, exist_ok=True)
            with open(os.path.join(self.cartella, f"{date_key}.ndjson"), 'a', encoding='utf-8') as f:
                for b in chiusi:
                    riga = {"t": datetime.fromtimestamp(b.pop("ts")).strftime('%H:%M:%S'), **b}
                    f.write(json.dumps(riga, separators=(',', ':')) + "\n")
        except Exception as e:
            print(f"Error writing vertical blocks: {e}")
