"""
Add-on Python per Bookmap: CVD e liquidita' bid/ask su ES, verso la pagina /bookmap.

Non si lancia da riga di comando: lo esegue Bookmap. Si costruisce da
Bookmap (Settings -> API plugins configuration -> Build Python add-on,
scegliendo questo file) e poi si attiva sul grafico di ES.

Ogni secondo manda un campione a POST /api/bookmap del dashboard locale:

    {"date", "t", "alias", "price", "bid", "ask", "buy", "sell", "bidLiq", "askLiq", "levels", "book"}

`buy`/`sell` sono i contratti aggrediti in quel secondo, non il cumulato: il
CVD lo somma la route sull'intera giornata, cosi' riavviare l'add-on o
Bookmap a meta' sessione non lo riporta a zero.

`book` sono gli ordini limit livello per livello ({"b": [[prezzo, contratti], ...],
"a": [...]}), entro LIVELLI_BOOK tick dal migliore e solo da MIN_CONTRATTI_BOOK in
su: la pagina li disegna come le linee orizzontali della heatmap di Bookmap.
Il filtro serve al peso: tutti i livelli sarebbero ~1 KB al secondo in piu'.

I callback di Bookmap (trade e depth arrivano a migliaia al secondo su ES)
non devono mai aspettare la rete: qui si mette il campione in una coda e lo
spedisce un thread a parte. Se il dashboard e' spento i campioni restano in
coda (fino a un'ora) e partono quando torna su.
"""

import json
import queue
import threading
import time
import urllib.request
from datetime import datetime

import bookmap as bm

URL = "http://localhost:3000/api/bookmap"
# Si seguono solo gli strumenti il cui alias comincia cosi' (es. "ESZ6.CME@...").
PREFISSO_ALIAS = "ES"
LIVELLI_DEFAULT = 10
MAX_IN_CODA = 3600
LIVELLI_BOOK = 30
MIN_CONTRATTI_BOOK = 20

libri = {}          # alias -> order book di Bookmap
strumenti = {}      # alias -> {"pips", "granularita"}
livelli = {}        # alias -> quanti livelli per lato sommare nella liquidita'
flusso = {}         # alias -> {"buy", "sell"} del secondo in corso
ultimo_secondo = {}  # alias -> secondo (epoch) dell'ultimo campione emesso

coda = queue.Queue()
req_id = 0


def handle_subscribe_instrument(addon, alias, full_name, is_crypto, pips, size_granularity,
                                instrument_multiplier, supported_features):
    global req_id
    if not alias.upper().startswith(PREFISSO_ALIAS):
        print(f"Ignoro {alias}: non comincia con {PREFISSO_ALIAS}", flush=True)
        return

    libri[alias] = bm.create_order_book()
    strumenti[alias] = {"pips": pips, "granularita": size_granularity}
    livelli[alias] = LIVELLI_DEFAULT
    flusso[alias] = {"buy": 0.0, "sell": 0.0}
    ultimo_secondo[alias] = int(time.time())

    req_id += 1
    bm.subscribe_to_depth(addon, alias, req_id)
    req_id += 1
    bm.subscribe_to_trades(addon, alias, req_id)
    bm.add_number_settings_parameter(addon, alias, "Livelli liquidita'", LIVELLI_DEFAULT, 1, 50, 1)
    print(f"Seguo {alias} (pips={pips}), invio a {URL}", flush=True)


def handle_unsubscribe_instrument(addon, alias):
    for d in (libri, strumenti, livelli, flusso, ultimo_secondo):
        d.pop(alias, None)
    print(f"Staccato {alias}", flush=True)


def handle_depth_info(addon, alias, is_bid, price, size):
    libro = libri.get(alias)
    if libro is not None:
        bm.on_depth(libro, is_bid, price, size)


def handle_trades(addon, alias, price, size, is_otc, is_bid, is_execution_start, is_execution_end,
                  aggressor_order_id, passive_order_id):
    f = flusso.get(alias)
    if f is None or is_otc:
        return
    contratti = size / strumenti[alias]["granularita"]
    # is_bid = l'aggressore ha comprato (stessa convenzione di cvd_addon.py)
    if is_bid:
        f["buy"] += contratti
    else:
        f["sell"] += contratti


def livelli_book(lato, migliore, verso, info):
    """[[prezzo, contratti], ...] dal migliore verso l'esterno; `verso` -1 per i bid, +1 per gli ask."""
    if migliore is None:
        return []
    righe = []
    for i in range(LIVELLI_BOOK):
        livello = migliore + verso * i
        size = lato.get(livello)
        if not size:
            continue
        contratti = size / info["granularita"]
        if contratti >= MIN_CONTRATTI_BOOK:
            righe.append([round(livello * info["pips"], 2), round(contratti)])
    return righe


def on_interval(addon, alias):
    """Bookmap lo chiama ogni 0,1 s: si emette un campione a ogni cambio di secondo."""
    libro = libri.get(alias)
    if libro is None:
        return
    adesso = int(time.time())
    if adesso == ultimo_secondo[alias]:
        return
    ultimo_secondo[alias] = adesso

    info = strumenti[alias]
    migliori_bid, migliori_ask = bm.get_bbo(libro)
    bid = migliori_bid[0] * info["pips"] if migliori_bid else None
    ask = migliori_ask[0] * info["pips"] if migliori_ask else None
    prezzo = (bid + ask) / 2 if bid is not None and ask is not None else (bid if bid is not None else ask)
    liq_bid, liq_ask = bm.get_sum(libro, livelli[alias])

    f = flusso[alias]
    ora = datetime.fromtimestamp(adesso)
    campione = {
        "date": ora.strftime("%Y-%m-%d"),
        "t": ora.strftime("%H:%M:%S"),
        "alias": alias,
        "price": round(prezzo, 2) if prezzo is not None else None,
        "bid": round(bid, 2) if bid is not None else None,
        "ask": round(ask, 2) if ask is not None else None,
        "buy": round(f["buy"], 2),
        "sell": round(f["sell"], 2),
        "bidLiq": round(liq_bid / info["granularita"], 2),
        "askLiq": round(liq_ask / info["granularita"], 2),
        "levels": livelli[alias],
        "book": {
            "b": livelli_book(libro["bids"], migliori_bid[0] if migliori_bid else None, -1, info),
            "a": livelli_book(libro["asks"], migliori_ask[0] if migliori_ask else None, 1, info),
        },
    }
    f["buy"] = 0.0
    f["sell"] = 0.0

    if coda.qsize() < MAX_IN_CODA:
        coda.put(campione)


def on_settings_change(addon, alias, setting_name, field_type, new_value):
    if setting_name == "Livelli liquidita'" and alias in livelli:
        livelli[alias] = int(new_value)


def spedizioniere():
    """Thread separato: raccoglie quello che c'e' in coda e lo manda in un'unica POST."""
    in_attesa = []
    errore_segnalato = False
    while True:
        try:
            in_attesa.append(coda.get(timeout=1))
        except queue.Empty:
            pass
        while not coda.empty() and len(in_attesa) < 500:
            in_attesa.append(coda.get_nowait())
        if not in_attesa:
            continue
        try:
            corpo = json.dumps({"samples": in_attesa}).encode("utf-8")
            richiesta = urllib.request.Request(URL, data=corpo, method="POST",
                                               headers={"Content-Type": "application/json"})
            urllib.request.urlopen(richiesta, timeout=3).read()
            in_attesa = []
            if errore_segnalato:
                print("Dashboard di nuovo raggiungibile", flush=True)
                errore_segnalato = False
        except Exception as e:
            if not errore_segnalato:
                print(f"Dashboard non raggiungibile ({e}), tengo i campioni in coda", flush=True)
                errore_segnalato = True
            in_attesa = in_attesa[-MAX_IN_CODA:]
            time.sleep(2)


if __name__ == "__main__":
    threading.Thread(target=spedizioniere, daemon=True).start()
    addon = bm.create_addon()
    bm.add_depth_handler(addon, handle_depth_info)
    bm.add_trades_handler(addon, handle_trades)
    bm.add_on_interval_handler(addon, on_interval)
    bm.add_on_setting_change_handler(addon, on_settings_change)
    bm.start_addon(addon, handle_subscribe_instrument, handle_unsubscribe_instrument)
    bm.wait_until_addon_is_turned_off(addon)
