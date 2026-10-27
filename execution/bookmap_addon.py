"""
Add-on Python per Bookmap: CVD e liquidita' bid/ask su ES, verso la pagina /bookmap.

Non si lancia da riga di comando: lo esegue Bookmap. Si costruisce da
Bookmap (Settings -> API plugins configuration -> Build Python add-on,
scegliendo questo file) e poi si attiva sul grafico di ES.

Ogni secondo manda un campione a POST /api/bookmap del dashboard locale:

    {"date", "t", "alias", "price", "bid", "ask", "buy", "sell", "bidLiq", "askLiq", "levels", "book",
     "addB", "remB", "addA", "remA", "ofi", "cB", "cA", "q1B", "q1A", "qm", "sp1", "abs"}

`buy`/`sell` sono i contratti aggrediti in quel secondo, non il cumulato: il
CVD lo somma la route sull'intera giornata, cosi' riavviare l'add-on o
Bookmap a meta' sessione non lo riporta a zero.

`book` sono gli ordini limit livello per livello ({"b": [[prezzo, contratti], ...],
"a": [...]}), entro LIVELLI_BOOK tick dal migliore e solo da MIN_CONTRATTI_BOOK in
su: la pagina li disegna come le linee orizzontali della heatmap di Bookmap.
Il filtro serve al peso: tutti i livelli sarebbero ~1 KB al secondo in piu'.
Oltre, fino a LIVELLI_BOOK_LONTANI tick, solo da MIN_CONTRATTI_LONTANI in su
(la soglia minima di /bookmap e di Quantower): con 30 tick soli un muro a 15-20
punti dal prezzo, visibile in Bookmap, non arrivava (27/10/2026, 7750 con ES a 7731).

`addB`/`remB` (e `addA`/`remA` per gli ask) sono i contratti limit aggiunti e
tolti in quel secondo entro LIVELLI_FLUSSO livelli dal migliore, contati a ogni
aggiornamento del book: se la size di un livello sale e' aggiunta, se scende e'
tolta. Tolta comprende anche l'eseguito (un ordine riempito sparisce dal book
come uno cancellato): la pagina, se si vuole, gli sottrae `buy`/`sell`.

`ofi` e' l'Order Flow Imbalance livello per livello (Cont, Kukanov e Stoikov
2014 per il primo livello, Xu, Gould e Howison per i livelli successivi, il
"MLOFI"), sommato sul secondo: LIVELLI_OFI numeri in contratti, il primo e'
il migliore. Non guarda quanta liquidita' c'e' ma come cambia tra due
fotografie consecutive del book (ogni 0,1 s): per il livello m del bid

    e = q_ora * [P_ora >= P_prima] - q_prima * [P_ora <= P_prima]

e il contrario per l'ask. Positivo = pressione in acquisto (bid che si
riempiono o salgono, ask che si svuotano o salgono). Comprende inserimenti,
cancellazioni ed esecuzioni: i tre eventi del book. Un ordine messo e tolto
tra due fotografie non conta, che per un ordine fugace e' quello che si vuole.

`cB`/`cA` sono il baricentro della liquidita' di ciascun lato, in tick dal
mid, sugli stessi livelli: un lato che "si allontana" dal prezzo (l'asimmetria
del modello di Avellaneda e Stoikov) lo sposta in fuori. `q1B`/`q1A` sono i
contratti in media sul migliore, `qm` la media per livello sui due lati (serve
a normalizzare l'OFI), `sp1` la quota di fotografie con lo spread a un tick:
vicino a 1 e' un mercato "large tick", con code spesse e spread schiacciato.
Tutti medie delle fotografie del secondo.

`abs` sono gli assorbimenti del secondo, [[prezzo, contratti, verso, "HH:MM:SS"], ...]:
tanto volume aggressivo su un solo prezzo, almeno ASS_MULTIPLO_CODA volte la
coda che c'era, e il livello che regge (il migliore resta li') per
ASS_TENUTA_SEC dopo l'ultimo trade. Verso +1 = compratori passivi che
assorbono le vendite (sul bid), -1 = venditori passivi che assorbono gli
acquisti (sull'ask). La soglia e' bassa apposta: la pagina filtra per
dimensione, cosi' la si regola guardando il grafico senza ricostruire
l'add-on.

Gli stop non ci sono piu' (05/10/2026). Si cercavano come aggressori diversi
nello stesso evento di matching (is_execution_start..is_execution_end), ma su
Rithmic ogni evento ha un solo aggressore: in 126 mila eventi nessuno ne
aveva due. Il ripiego -- raffiche di eventi nello stesso verso a pochi
millisecondi l'uno dall'altro -- confrontato con Stops & Icebergs di Bookmap
mescolava stop, riempimenti di iceberg e ordini grossi spezzati: quell'add-on
vede il book ordine per ordine, dai soli trade non si separano.

Attenzione nel modificare questo file: l'editor di Bookmap va in crash su
un'intestazione di blocco (for/if/def...) spezzata su piu' righe.

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
LIVELLI_BOOK_LONTANI = 120
MIN_CONTRATTI_LONTANI = 50
LIVELLI_FLUSSO = 5
LIVELLI_OFI = 15
# Alla sottoscrizione Bookmap riversa l'intero book: sembrerebbero migliaia di
# contratti aggiunti in un colpo. Per questi secondi non si conta.
AVVIO_SENZA_FLUSSO_SEC = 3
# Assorbimento: volume aggressivo a un prezzo dentro questa finestra...
ASS_FINESTRA_SEC = 5.0
# ...almeno tanti contratti e tante volte la coda iniziale...
ASS_MIN_CONTRATTI = 30
ASS_MULTIPLO_CODA = 2.0
# ...e il livello ancora li' dopo tanto dall'ultimo trade.
ASS_TENUTA_SEC = 1.0

libri = {}          # alias -> order book di Bookmap
strumenti = {}      # alias -> {"pips", "granularita"}
livelli = {}        # alias -> quanti livelli per lato sommare nella liquidita'
flusso = {}         # alias -> {"buy", "sell", "addB", "remB", "addA", "remA"} del secondo in corso
conta_da = {}       # alias -> da quando (epoch) contare aggiunte e rimozioni
ultimo_secondo = {}  # alias -> secondo (epoch) dell'ultimo campione emesso
foto_prima = {}     # alias -> ultima fotografia dei primi LIVELLI_OFI livelli, per l'OFI
statistiche = {}    # alias -> OFI per livello e medie del secondo in corso
finestre_ass = {}   # alias -> {(compra, livello): finestra di volume aggressivo a quel prezzo}
eventi = {}         # alias -> {"abs": [...]} del secondo in corso
# Tutti i dizionari per alias, da svuotare quando uno strumento si stacca. In
# una costante e non nella riga del `for`: un'intestazione di blocco spezzata
# su due righe manda in crash l'editor di Bookmap (NullPointerException in
# PythonFoldParser, 05/10/2026), che non apre piu' il file.
STATO_PER_ALIAS = (libri, strumenti, livelli, flusso, conta_da, ultimo_secondo, foto_prima, statistiche, finestre_ass, eventi)

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
    flusso[alias] = azzerato()
    conta_da[alias] = time.time() + AVVIO_SENZA_FLUSSO_SEC
    ultimo_secondo[alias] = int(time.time())
    foto_prima[alias] = None
    statistiche[alias] = statistiche_azzerate()
    finestre_ass[alias] = {}
    eventi[alias] = {"abs": []}

    req_id += 1
    bm.subscribe_to_depth(addon, alias, req_id)
    req_id += 1
    bm.subscribe_to_trades(addon, alias, req_id)
    bm.add_number_settings_parameter(addon, alias, "Livelli liquidita'", LIVELLI_DEFAULT, 1, 50, 1)
    print(f"Seguo {alias} (pips={pips}), invio a {URL}", flush=True)


def handle_unsubscribe_instrument(addon, alias):
    for d in STATO_PER_ALIAS:
        d.pop(alias, None)
    print(f"Staccato {alias}", flush=True)


def azzerato():
    return {"buy": 0.0, "sell": 0.0, "addB": 0.0, "remB": 0.0, "addA": 0.0, "remA": 0.0}


def statistiche_azzerate():
    return {"ofi": [0.0] * LIVELLI_OFI, "n": 0, "cB": 0.0, "nB": 0, "cA": 0.0, "nA": 0,
            "q1B": 0.0, "q1A": 0.0, "qm": 0.0, "sp1": 0}


def fotografia(libro, info):
    """(miglior bid, code bid, miglior ask, code ask), prezzi in tick e code in contratti; None senza i due lati."""
    migliori_bid, migliori_ask = bm.get_bbo(libro)
    if not migliori_bid or not migliori_ask:
        return None
    bb, ba = migliori_bid[0], migliori_ask[0]
    g = info["granularita"]
    qb = [libro["bids"].get(bb - m, 0) / g for m in range(LIVELLI_OFI)]
    qa = [libro["asks"].get(ba + m, 0) / g for m in range(LIVELLI_OFI)]
    return bb, qb, ba, qa


def aggiorna_statistiche(alias, foto):
    """OFI tra la fotografia precedente e questa, e le medie del secondo (baricentri, code, spread)."""
    s = statistiche[alias]
    prima = foto_prima[alias]
    foto_prima[alias] = foto
    if foto is None:
        return
    bb, qb, ba, qa = foto
    # All'avvio Bookmap riversa l'intero book: sembrerebbe un OFI enorme.
    if prima is not None and time.time() >= conta_da[alias]:
        bb0, qb0, ba0, qa0 = prima
        for m in range(LIVELLI_OFI):
            e = 0.0
            if bb >= bb0:
                e += qb[m]
            if bb <= bb0:
                e -= qb0[m]
            if ba <= ba0:
                e -= qa[m]
            if ba >= ba0:
                e += qa0[m]
            s["ofi"][m] += e

    # Distanza dal mid in tick: livello m del bid = m + spread/2.
    meta = (ba - bb) / 2
    tot_b = sum(qb)
    tot_a = sum(qa)
    if tot_b > 0:
        s["cB"] += sum(q * (m + meta) for m, q in enumerate(qb)) / tot_b
        s["nB"] += 1
    if tot_a > 0:
        s["cA"] += sum(q * (m + meta) for m, q in enumerate(qa)) / tot_a
        s["nA"] += 1
    s["q1B"] += qb[0]
    s["q1A"] += qa[0]
    s["qm"] += (tot_b + tot_a) / (2 * LIVELLI_OFI)
    s["sp1"] += 1 if ba - bb == 1 else 0
    s["n"] += 1


def riassunto_statistiche(s):
    """I campi del campione; None dove nel secondo non c'e' stata nessuna fotografia valida."""
    n = s["n"]
    return {
        "ofi": [round(v) for v in s["ofi"]] if n else None,
        "cB": round(s["cB"] / s["nB"], 2) if s["nB"] else None,
        "cA": round(s["cA"] / s["nA"], 2) if s["nA"] else None,
        "q1B": round(s["q1B"] / n, 1) if n else None,
        "q1A": round(s["q1A"] / n, 1) if n else None,
        "qm": round(s["qm"] / n, 1) if n else None,
        "sp1": round(s["sp1"] / n, 2) if n else None,
    }


def handle_depth_info(addon, alias, is_bid, price, size):
    libro = libri.get(alias)
    if libro is None:
        return
    lato = libro["bids"] if is_bid else libro["asks"]
    prima = lato.get(price, 0)
    # Il migliore di prima dell'aggiornamento: un ordine che migliora il prezzo
    # (distanza negativa) e' comunque tra i primi livelli e si conta.
    migliori = bm.get_bbo(libro)
    bm.on_depth(libro, is_bid, price, size)

    migliore = migliori[0 if is_bid else 1] if migliori else None
    if migliore is None or size == prima or time.time() < conta_da[alias]:
        return
    distanza = migliore[0] - price if is_bid else price - migliore[0]
    if distanza >= LIVELLI_FLUSSO:
        return
    variazione = (size - prima) / strumenti[alias]["granularita"]
    f = flusso[alias]
    if variazione > 0:
        f["addB" if is_bid else "addA"] += variazione
    else:
        f["remB" if is_bid else "remA"] -= variazione


def orario(epoch):
    return datetime.fromtimestamp(epoch).strftime("%H:%M:%S")


def livello_trade(alias, price):
    """Il prezzo del trade in tick, come quelli del book.

    Il modulo `bookmap` lo dichiara solo come float: se arriva gia' in tick e'
    vicino al miglior bid del book, se arriva in prezzo reale no, e lo si
    divide per il tick."""
    migliori_bid, _ = bm.get_bbo(libri[alias])
    if migliori_bid and abs(price - migliori_bid[0]) > 1000:
        return int(round(price / strumenti[alias]["pips"]))
    return int(round(price))


def registra_assorbimento(alias, livello, compra, contratti, adesso):
    """Accumula il volume aggressivo a un prezzo; la valutazione la fa valuta_assorbimenti."""
    finestre = finestre_ass[alias]
    chiave = (compra, livello)
    f = finestre.get(chiave)
    if f is not None and adesso - f["t0"] > ASS_FINESTRA_SEC:
        valuta_finestra(alias, chiave, f)
        f = None
    if f is None:
        # La coda passiva che c'era: quella di adesso piu' questo trade, perche'
        # l'aggiornamento del book puo' arrivare prima del trade.
        lato = libri[alias]["asks" if compra else "bids"]
        coda_ora = lato.get(livello, 0) / strumenti[alias]["granularita"]
        f = {"t0": adesso, "ultimo": adesso, "vol": 0.0, "coda0": coda_ora + contratti}
        finestre[chiave] = f
    f["vol"] += contratti
    f["ultimo"] = adesso


def valuta_finestra(alias, chiave, f):
    finestre_ass[alias].pop(chiave, None)
    compra, livello = chiave
    if f["vol"] < max(ASS_MIN_CONTRATTI, ASS_MULTIPLO_CODA * f["coda0"]):
        return
    migliori_bid, migliori_ask = bm.get_bbo(libri[alias])
    # Il livello ha retto se il lato passivo e' ancora li' (o meglio):
    # gli acquisti aggressivi non hanno portato l'ask sopra, le vendite il bid sotto.
    if compra:
        tenuto = bool(migliori_ask) and migliori_ask[0] <= livello
    else:
        tenuto = bool(migliori_bid) and migliori_bid[0] >= livello
    if not tenuto:
        return
    eventi[alias]["abs"].append([round(livello * strumenti[alias]["pips"], 2), round(f["vol"]), -1 if compra else 1,
                                 orario(f["ultimo"])])


def valuta_assorbimenti(alias, adesso):
    for chiave, f in list(finestre_ass[alias].items()):
        if adesso - f["ultimo"] >= ASS_TENUTA_SEC or adesso - f["t0"] > ASS_FINESTRA_SEC + ASS_TENUTA_SEC:
            valuta_finestra(alias, chiave, f)


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

    # Assorbimenti: un errore qui non deve fermare CVD e liquidita'.
    try:
        registra_assorbimento(alias, livello_trade(alias, price), is_bid, contratti, time.time())
    except Exception as e:
        print(f"Assorbimenti: {e}", flush=True)




def livelli_book(lato, migliore, verso, info):
    """[[prezzo, contratti], ...] dal migliore verso l'esterno; `verso` -1 per i bid, +1 per gli ask."""
    if migliore is None:
        return []
    righe = []
    for i in range(LIVELLI_BOOK_LONTANI):
        livello = migliore + verso * i
        size = lato.get(livello)
        if not size:
            continue
        contratti = size / info["granularita"]
        if contratti >= (MIN_CONTRATTI_BOOK if i < LIVELLI_BOOK else MIN_CONTRATTI_LONTANI):
            righe.append([round(livello * info["pips"], 2), round(contratti)])
    return righe


def on_interval(addon, alias):
    """Bookmap lo chiama ogni 0,1 s: si fotografa il book ogni volta, si emette un campione a ogni cambio di secondo."""
    libro = libri.get(alias)
    if libro is None:
        return
    info = strumenti[alias]
    aggiorna_statistiche(alias, fotografia(libro, info))
    try:
        valuta_assorbimenti(alias, time.time())
    except Exception as e:
        print(f"Assorbimenti: {e}", flush=True)
    adesso = int(time.time())
    if adesso == ultimo_secondo[alias]:
        return
    ultimo_secondo[alias] = adesso

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
        "addB": round(f["addB"]),
        "remB": round(f["remB"]),
        "addA": round(f["addA"]),
        "remA": round(f["remA"]),
        **riassunto_statistiche(statistiche[alias]),
        "abs": eventi[alias]["abs"],
    }
    flusso[alias] = azzerato()
    statistiche[alias] = statistiche_azzerate()
    eventi[alias] = {"abs": []}

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
