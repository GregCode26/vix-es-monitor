"""
Add-on Python di prova per Bookmap: arrivano i dati MBO (ordine per ordine) di ES all'API Python?

Non cambia niente di quello che gira: non manda nulla al dashboard. Si costruisce da Bookmap
(Settings -> API plugins configuration -> Build Python add-on, scegliendo questo file), si
attiva sul grafico di ES e si lascia andare almeno un minuto. Ogni 10 secondi riscrive
C:\\Bookmap\\Python\\mbo_verifica.json con:
  - le funzioni che Bookmap dichiara per lo strumento (`supported_features`);
  - quanti eventi MBO sono arrivati, per tipo (BID_NEW, ASK_NEW, REPLACE, CANCEL...), al secondo;
  - quanti ordini sono vivi nel book ricostruito e il volume sui primi livelli, da confrontare col COB;
  - quanti trade portano il codice dell'ordine aggressore e di quello passivo (anche questi
    vengono solo da un feed MBO), con qualche esempio.

Nota (26/11/2026): l'esempio di Bookmap `mbo_test.py` registra i BID_NEW come ask (passa False):
qui e' corretto. Come nell'add-on principale, ogni intestazione di blocco sta su una riga sola:
l'editor di Bookmap va in crash se e' spezzata.
"""

import json
import time

import bookmap as bm

FILE = "C:\\Bookmap\\Python\\mbo_verifica.json"
PREFISSO_ALIAS = "ES"
OGNI_SEC = 10

stato = {}


def nuovo_stato(alias, features):
    return {"alias": alias, "inizio": time.time(), "features": features, "mbo": {}, "trade": 0,
            "trade_con_id": 0, "esempi_trade": [], "esempi_mbo": [], "libro": bm.create_mbo_book(),
            "pips": 1.0, "scritto": 0.0}


def handle_subscribe_instrument(addon, alias, full_name, is_crypto, pips, size_multiplier, instrument_multiplier, supported_features):
    if not alias.upper().startswith(PREFISSO_ALIAS):
        return
    s = nuovo_stato(alias, supported_features)
    s["pips"] = pips
    stato[alias] = s
    bm.subscribe_to_mbo(addon, alias, 1)
    bm.subscribe_to_trades(addon, alias, 2)
    print("MBO verifica: seguo " + alias + " features=" + json.dumps(supported_features), flush=True)


def handle_unsubscribe_instrument(addon, alias):
    s = stato.pop(alias, None)
    if s is not None:
        scrivi(s)


def handle_mbo_event(addon, alias, event_type, order_id, price, size):
    s = stato.get(alias)
    if s is None:
        return
    s["mbo"][event_type] = s["mbo"].get(event_type, 0) + 1
    if len(s["esempi_mbo"]) < 20:
        s["esempi_mbo"].append([event_type, order_id, price * s["pips"], size])
    libro = s["libro"]
    if event_type == "BID_NEW":
        bm.on_new_order(libro, order_id, True, price, size)
    elif event_type == "ASK_NEW":
        bm.on_new_order(libro, order_id, False, price, size)
    elif event_type == "REPLACE" and bm.has_order(libro, order_id):
        bm.on_replace_order(libro, order_id, price, size)
    elif event_type == "CANCEL" and bm.has_order(libro, order_id):
        bm.on_remove_order(libro, order_id)
    if time.time() - s["scritto"] >= OGNI_SEC:
        scrivi(s)


def handle_trades(addon, alias, price, size, is_otc, is_bid, is_execution_start, is_execution_end, aggressor_order_id, passive_order_id):
    s = stato.get(alias)
    if s is None:
        return
    s["trade"] += 1
    if aggressor_order_id or passive_order_id:
        s["trade_con_id"] += 1
        if len(s["esempi_trade"]) < 10:
            s["esempi_trade"].append([price * s["pips"], size, is_bid, aggressor_order_id, passive_order_id])


def scrivi(s):
    secondi = max(1.0, time.time() - s["inizio"])
    libro = s["libro"]
    ordini = bm.get_all_order_ids(libro)
    out = {
        "alias": s["alias"],
        "aggiornato": time.strftime("%H:%M:%S"),
        "secondi": round(secondi),
        "features": s["features"],
        "eventi_mbo": s["mbo"],
        "eventi_mbo_al_secondo": round(sum(s["mbo"].values()) / secondi, 1),
        "ordini_vivi": len(ordini),
        "trade": s["trade"],
        "trade_con_id_ordini": s["trade_con_id"],
        "esempi_mbo": s["esempi_mbo"],
        "esempi_trade": s["esempi_trade"],
    }
    try:
        with open(FILE, "w") as f:
            json.dump(out, f, indent=1)
    except Exception as e:
        print("MBO verifica: non scrivo " + FILE + ": " + str(e), flush=True)
    s["scritto"] = time.time()


if __name__ == "__main__":
    addon = bm.create_addon()
    bm.add_mbo_handler(addon, handle_mbo_event)
    bm.add_trades_handler(addon, handle_trades)
    bm.start_addon(addon, handle_subscribe_instrument, handle_unsubscribe_instrument)
    bm.wait_until_addon_is_turned_off(addon)
