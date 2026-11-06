import json
import os
import sys
import time
from datetime import datetime
import asyncio

try:
    from ib_insync import *
except ImportError:
    print("Error: ib_insync is not installed. Please run 'pip install ib_insync'.")
    sys.exit(1)

from poller_session import esegui_a_oltranza, registra_connessione, minuti_locali_da_ny
import smile
from verticali_blocchi import RilevaVerticali

try:
    from dotenv import load_dotenv
    from supabase import create_client
    load_dotenv()
    SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    SUPABASE_KEY = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
except ImportError:
    SUPABASE_URL = SUPABASE_KEY = None
    print("WARNING: supabase/dotenv non disponibili, si scrive solo su file locale.")

# Configuration
POLL_INTERVAL = 10  # seconds
# Finestra di raccolta in ora di New York (7:30-16:00, cioe' 13:30-22:00
# italiane quasi tutto l'anno): si converte ogni giro con
# `minuti_locali_da_ny`, perche' le due ore legali non cambiano lo stesso giorno.
START_NY = (7, 30)
END_NY = (16, 0)
# Quanti strike puo' allontanarsi lo spot dal centro della catena prima che la
# sessione si chiuda per ricentrarla: 8 strike da 5 punti = 40 punti, e ne
# restano almeno 10 dal lato verso cui si muove.
RICENTRA_DOPO_STRIKE = 8
# Anello esterno, solo per il profilo GEX (volume, open interest e gamma):
# altri 20 strike per lato oltre i 37 in streaming, letti a rotazione perche'
# in streaming non ci stanno (IBKR da' ~100 linee e ne usiamo ~90). Volume e
# OI sono totali del giorno, quindi leggerli ogni mezzo minuto non perde
# niente; Lee-Ready, vertical, tide e smile invece vedono ogni trade e restano
# sui 37 centrali. Sonda del 30/10/2026: volume, OI e gamma arrivano entro
# 1,5 s dalla sottoscrizione, 8 linee in piu' senza errori.
ESTERNI_PER_LATO = 20
LOTTO_ESTERNI = 8          # contratti sottoscritti insieme
TIENI_ESTERNI_SEC = 3      # quanto resta aperto un lotto prima di leggerlo
ESTERNI_OGNI_SEC = 60      # una riga dell'anello al minuto, file e Supabase
ESTERNI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'data', 'volumes-esterni')


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'volumes')
# Ultimo bid/ask di ogni contratto seguito, per i vertical di /operativita.
QUOTE_FILE = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'catena', 'quote.json')
# Una lettura dello smile per riga, per gli z-score di /api/smile (vedi smile.py).
SMILE_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'smile')
# I vertical eseguiti riconosciuti dai singoli trade, per /api/verticali (vedi verticali_blocchi.py).
VERTICALI_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'verticali')

def ensure_data_dir():
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)

def get_today_key():
    return datetime.now().strftime('%Y-%m-%d')

def get_file_path(date_key):
    return os.path.join(DATA_DIR, f"{date_key}.json")

def read_session_file(date_key):
    file_path = get_file_path(date_key)
    if not os.path.exists(file_path):
        return []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error reading file {file_path}: {e}")
        return []

# Copia in memoria della sessione corrente: il file viene riscritto per intero
# a ogni snapshot, ma senza rileggerlo e rideserializzarlo ogni volta.
_session_cache = {"date": None, "snapshots": []}

def append_to_session_file(date_key, snapshot):
    ensure_data_dir()

    if _session_cache["date"] != date_key:
        # Primo snapshot del giorno (o poller riavviato a meta' sessione):
        # si riparte da quello che c'e' gia' su disco.
        _session_cache["date"] = date_key
        _session_cache["snapshots"] = read_session_file(date_key)

    _session_cache["snapshots"].append(snapshot)

    file_path = get_file_path(date_key)
    try:
        # Write to temporary file, then rename for atomicity
        temp_file = file_path + ".tmp"
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(_session_cache["snapshots"], f, separators=(',', ':'))
        os.replace(temp_file, file_path)
    except Exception as e:
        print(f"Error writing to file {file_path}: {e}")

class MarketTide:
    """Premio e volume netti della giornata, lato ask meno lato bid.

    E' il "Market Tide" di Unusual Whales, ma su quello che questo poller vede:
    la catena SPX 0DTE degli strike sottoscritti, non tutto il mercato.

    Versione 2 (29/10/2026), trade per trade da RTVolume tramite
    RilevaVerticali. La versione 1 attribuiva gli aumenti del volume cumulato
    confrontando l'ultimo prezzo con il bid/ask di quel momento, e lo studio
    del 29/10 (execution/studio_tide.py, 14 sessioni) ha trovato due errori:

    1. andava al contrario del mercato: il bid/ask era gia' quello spostato
       dal movimento, e quando SPX sale le put sembrano comprate e le call
       vendute (correlazione con SPX nello stesso intervallo: NPP +0.16,
       NCP -0.08; il Tide netto -0.28 sui 5 minuti). Qui ogni trade si
       confronta con la quotazione in vigore PRIMA del trade;
    2. le gambe dei vertical contavano due volte, a premio pieno: il 28/10 un
       7670/7680 call deep ITM da 3.000 contratti fece +40 milioni di NCP, per
       uno spread che ne valeva al massimo 3. Qui un vertical conta una volta,
       per il suo prezzo e nel suo verso (comprato = premio pagato).

    Trade al mid, o senza quotazione prima, non contano.

    Dal 06/11/2026 tiene anche i conti per strike (`strike` nella fotografia,
    solo file locale): {strike: [call comprate, call vendute, put comprate,
    put vendute]}, con la stessa regola. Le gambe di un vertical vanno ognuna
    sul suo strike nel verso dello spread (bull call comprato = call bassa
    comprata, alta venduta). Servono a confrontare il comprato/venduto per
    strike con lo strumento esterno dell'utente (barre "IMB", 0DTE, destra =
    comprato): il 06/11 i cb/cs/pb/ps di LeeReady, che classificano gli
    incrementi di volume ogni 10 s, concordavano sul segno in 13 strike su 23
    (Spearman +0.20), cioe' a caso.
    """

    VERSIONE = 2

    def __init__(self):
        self.ncp = 0.0  # net call premium, $
        self.npp = 0.0  # net put premium, $
        self.ncv = 0    # net call volume, contratti
        self.npv = 0    # net put volume, contratti
        # strike -> [cb, cs, pb, ps], trade per trade
        self.per_strike = {}

    def riprendi(self, snapshots):
        """Riparte dai totali dell'ultimo snapshot: un riavvio a meta' sessione
        non deve azzerare la giornata. I contratti scambiati mentre il poller
        era giu' restano fuori, perche' il loro lato non si puo' piu' sapere.
        Totali della versione 1 non si riprendono: si riparte da zero."""
        for snap in reversed(snapshots):
            tide = snap.get("tide")
            if tide:
                if tide.get("v") != self.VERSIONE:
                    return
                self.ncp = float(tide.get("ncp", 0))
                self.npp = float(tide.get("npp", 0))
                self.ncv = int(tide.get("ncv", 0))
                self.npv = int(tide.get("npv", 0))
                for k, c in (tide.get("strike") or {}).items():
                    self.per_strike[float(k)] = [int(x) for x in c]
                print(f"Market Tide ripreso dalle {snap.get('time')}: NCP {self.ncp:,.0f}, NPP {self.npp:,.0f}")
                return

    def _conta(self, strike, lato, segno, size):
        c = self.per_strike.setdefault(float(strike), [0, 0, 0, 0])
        c[(0 if lato == 'C' else 2) + (0 if segno > 0 else 1)] += size

    def _somma(self, lato, segno, prezzo, size):
        premio = segno * prezzo * size * 100
        if lato == 'C':
            self.ncp += premio
            self.ncv += segno * size
        else:
            self.npp += premio
            self.npv += segno * size

    def trade(self, t):
        """Un trade singolo (non gamba di un vertical): regola della quotazione."""
        bid, ask = t["bid"], t["ask"]
        if bid is None or ask is None:
            return
        mid = (bid + ask) / 2
        segno = 1 if t["prezzo"] > mid + 1e-9 else -1 if t["prezzo"] < mid - 1e-9 else 0
        if segno:
            self._somma(t["lato"], segno, t["prezzo"], t["size"])
            self._conta(t["strike"], t["lato"], segno, t["size"])

    def vertical(self, v):
        """Un vertical: una volta sola, al suo prezzo. Comprato = bull call o
        bear put, cioe' premio pagato sul suo lato; venduto il contrario."""
        segno = 1 if v["verso"] == "comprato" else -1 if v["verso"] == "venduto" else 0
        if not segno:
            return
        self._somma(v["lato"], segno, v["prezzo"], v["size"])
        # Gamba cara (call bassa, put alta) nel verso dello spread, l'altra al contrario.
        cara, economica = (v["k1"], v["k2"]) if v["lato"] == 'C' else (v["k2"], v["k1"])
        self._conta(cara, v["lato"], segno, v["size"])
        self._conta(economica, v["lato"], -segno, v["size"])

    def fotografia(self):
        return {"ncp": round(self.ncp), "npp": round(self.npp), "ncv": self.ncv, "npv": self.npv,
                "v": self.VERSIONE,
                "strike": {f"{k:g}": c for k, c in sorted(self.per_strike.items())}}


class LeeReady:
    """Call e put comprate e vendute per strike, con l'algoritmo di Lee e Ready (1991).

    Ogni volta che il volume cumulato di un contratto sale, i contratti in piu'
    sono un trade (o piu' trade fra due aggiornamenti: IBKR campiona i tick
    delle opzioni, non li manda tutti). Si classificano cosi':

    1. regola della quotazione: prezzo del trade sopra il mid del bid/ask in
       vigore PRIMA del trade = iniziato da un compratore, sotto = da un
       venditore. Il bid/ask di prima e non quello arrivato insieme: un trade
       aggressivo sposta la quotazione, e letto dopo sembrerebbe a meta';
    2. tick test, per i trade esattamente sul mid: prezzo salito rispetto
       all'ultimo trade a prezzo diverso = acquisto, sceso = vendita; a
       prezzo uguale vale il verso dell'ultima variazione (zero-tick).

    A differenza di MarketTide non scarta i trade a meta' spread e tiene i
    conti per strike, che e' quello che serve a stimare la posizione dei
    dealer: il cliente che compra ha davanti un market maker che vende.

    I conti sono cumulati dall'inizio della giornata e ripartono dall'ultimo
    snapshot dopo un riavvio; i contratti scambiati mentre il poller era giu'
    restano fuori, perche' il loro lato non si puo' piu' ricostruire.
    """

    def __init__(self):
        # conId -> volume visto, bid/ask in vigore, ultimo prezzo di trade diverso e verso dell'ultima variazione
        self.stato = {}
        # (strike, 'C'|'P') -> [comprati, venduti]
        self.conti = {}
        self.non_classificati = 0

    def riprendi(self, snapshots):
        for snap in reversed(snapshots):
            righe = snap.get("volumes") or []
            if not any("cb" in r for r in righe):
                continue
            for r in righe:
                k = r.get("strike")
                self.conti[(k, 'C')] = [int(r.get("cb", 0)), int(r.get("cs", 0))]
                self.conti[(k, 'P')] = [int(r.get("pb", 0)), int(r.get("ps", 0))]
            print(f"Lee-Ready ripreso dalle {snap.get('time')}")
            return

    @staticmethod
    def _valido(x):
        return x is not None and x == x and x > 0

    def _lato(self, prezzo, s):
        """+1 acquisto, -1 vendita, 0 se non si puo' dire."""
        bid, ask = s["bid"], s["ask"]
        if bid is not None and ask is not None:
            mid = (bid + ask) / 2
            if prezzo > mid + 1e-9:
                return 1
            if prezzo < mid - 1e-9:
                return -1
        rif = s["rif"]
        if rif is not None and prezzo != rif:
            return 1 if prezzo > rif else -1
        return s["verso"]

    def su_tickers(self, tickers):
        for t in tickers:
            c = t.contract
            if c is None or c.secType != 'OPT':
                continue
            s = self.stato.setdefault(c.conId, {"vol": None, "bid": None, "ask": None, "rif": None, "verso": 0})
            prezzo = t.last
            vol = t.volume
            if vol is not None and vol == vol:
                precedente = s["vol"]
                s["vol"] = vol
                # Il primo volume visto e' la base; se scende (IBKR lo azzera
                # all'apertura del cash) si riparte da li' senza classificare.
                if precedente is not None and vol > precedente:
                    nuovi = int(vol - precedente)
                    if s["bid"] is None and self._valido(t.bid) and self._valido(t.ask) and t.ask > t.bid:
                        s["bid"], s["ask"] = t.bid, t.ask
                    lato = self._lato(prezzo, s) if self._valido(prezzo) else 0
                    if lato == 0:
                        self.non_classificati += nuovi
                    else:
                        conto = self.conti.setdefault((c.strike, c.right), [0, 0])
                        conto[0 if lato > 0 else 1] += nuovi
            # Dopo la classificazione: il riferimento del tick test e la
            # quotazione valgono per il trade SUCCESSIVO.
            if self._valido(prezzo) and prezzo != s["rif"]:
                if s["rif"] is not None:
                    s["verso"] = 1 if prezzo > s["rif"] else -1
                s["rif"] = prezzo
            if self._valido(t.bid) and self._valido(t.ask) and t.ask > t.bid:
                s["bid"], s["ask"] = t.bid, t.ask

    def riga(self, strike):
        """I quattro conti di uno strike, per lo snapshot."""
        cb, cs = self.conti.get((strike, 'C'), [0, 0])
        pb, ps = self.conti.get((strike, 'P'), [0, 0])
        return {"cb": cb, "cs": cs, "pb": pb, "ps": ps}

_supabase_client = None

# Quando Supabase ha risposto che la colonna `tide` non esiste
# (sql/006_volumes_snapshots_tide.sql non ancora eseguito): per dieci minuti la
# si lascia fuori invece di perdere lo snapshot, poi si riprova, cosi' dopo la
# migrazione riparte da sola senza riavviare il poller.
_colonna_tide_manca_dal = None
_RIPROVA_COLONNA_TIDE_SEC = 600

def scrivi_quote(date_key, time_str, spot, scadenza, option_tickers, gamma, lee_ready):
    """Sovrascrive QUOTE_FILE con l'ultima fotografia di ogni strike, e accoda la lettura dello smile.

    Per strike: bid/ask, IV e delta di call e put, gamma e i conti Lee-Ready.
    Servono al costo dei vertical (/api/verticali) e allo smile con il
    convexity ladder (/api/smile). Solo l'ultima fotografia e solo in locale:
    su Supabase sarebbe egress senza motivo. Nessuna linea di market data in
    piu': sono gli stessi ticker da cui si leggono i volumi.
    """
    # IBKR manda -1 quando un lato non c'e'; 0 invece e' un bid vero, sulle
    # put lontane, e senza di lui il vertical sparirebbe.
    def prezzo(x):
        return round(float(x), 2) if x is not None and x == x and x >= 0 else None

    righe = {}
    for item in option_tickers:
        t = item["ticker"]
        r = righe.setdefault(item["strike"], {"strike": item["strike"]})
        lato = 'c' if item["right"] == 'C' else 'p'
        r[lato + "Bid"] = prezzo(t.bid)
        r[lato + "Ask"] = prezzo(t.ask)
        g = t.modelGreeks
        iv = g.impliedVol if g else None
        delta = g.delta if g else None
        r[lato + "Iv"] = round(float(iv), 6) if iv is not None and iv == iv else None
        r[lato + "Delta"] = round(float(delta), 6) if delta is not None and delta == delta else None
    for k, r in righe.items():
        r["gamma"] = gamma.get(k)
        r.update(lee_ready.riga(k))
    strikes = [righe[k] for k in sorted(righe)]
    righe_smile, lettura = smile.calcola(strikes, spot, scadenza)
    # Le IV in % con cui e' stata fatta la lettura (dal mid, o il ripiego sui
    # modelGreeks): la curva di /api/smile disegna queste, non cIv/pIv.
    for r, s in zip(strikes, righe_smile):
        r["cIvS"] = round(s["callIv"], 4) if s["callIv"] is not None else None
        r["pIvS"] = round(s["putIv"], 4) if s["putIv"] is not None else None
    dati = {"date": date_key, "time": time_str, "spot": spot, "expiry": scadenza,
            "smile": lettura, "strikes": strikes}
    try:
        os.makedirs(os.path.dirname(QUOTE_FILE), exist_ok=True)
        temp_file = QUOTE_FILE + ".tmp"
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(dati, f, separators=(',', ':'))
        os.replace(temp_file, QUOTE_FILE)
    except Exception as e:
        print(f"Error writing {QUOTE_FILE}: {e}")
    if lettura:
        try:
            os.makedirs(SMILE_DIR, exist_ok=True)
            with open(os.path.join(SMILE_DIR, f"{date_key}.ndjson"), 'a', encoding='utf-8') as f:
                f.write(json.dumps({"t": time_str, **lettura}, separators=(',', ':')) + "\n")
        except Exception as e:
            print(f"Error writing smile reading: {e}")


def push_snapshot_to_supabase(date_key, snapshot):
    """Inserisce il singolo snapshot appena prodotto (~1,8 KB).

    Prima si spingeva l'intera sessione come una riga JSONB: ~200 KB a ogni
    push, piu' altrettanti rimandati indietro da PostgREST. Con una riga per
    snapshot il client puo' chiedere solo i nuovi, e `returning=minimal`
    elimina l'eco della risposta.
    """
    global _supabase_client
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        if _supabase_client is None:
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        global _colonna_tide_manca_dal
        riga = {
            "date": date_key,
            "time": snapshot["time"],
            "spx_price": snapshot["spxPrice"],
            "und_price": snapshot.get("undPrice"),
            "is_opening": snapshot["isOpening"],
            "volumes": snapshot["volumes"],
            # Senza i conti per strike (~2 KB): servono solo in locale, e su
            # Supabase si pagherebbero a ogni lettura di /api/market-tide.
            "tide": {k: v for k, v in snapshot["tide"].items() if k != "strike"} if snapshot.get("tide") else None,
        }
        if _colonna_tide_manca_dal is not None and time.time() - _colonna_tide_manca_dal < _RIPROVA_COLONNA_TIDE_SEC:
            riga.pop("tide", None)
        try:
            _supabase_client.table("volumes_snapshots").upsert(
                riga, on_conflict="date,time", returning="minimal").execute()
        except Exception as e:
            if "tide" not in str(e) or "tide" not in riga:
                raise
            _colonna_tide_manca_dal = time.time()
            print("Colonna tide assente su Supabase: il Market Tide resta solo nel file locale "
                  "finche' non si esegue sql/006_volumes_snapshots_tide.sql.", file=sys.stderr)
            riga.pop("tide", None)
            _supabase_client.table("volumes_snapshots").upsert(
                riga, on_conflict="date,time", returning="minimal").execute()
    except Exception as e:
        print(f"Error pushing snapshot to Supabase: {e}", file=sys.stderr)

class AnelloEsterno:
    """Gli strike oltre i 37 in streaming, sottoscritti a lotti e poi cancellati.

    Ogni TIENI_ESTERNI_SEC si legge il lotto aperto (volume, OI, greche), si
    cancella e si apre il successivo: 80 contratti a 8 per volta sono un giro
    ogni ~40 s. Tiene l'ultimo valore visto di ogni contratto, e `righe()` li
    mette nella stessa forma delle righe di `volumes` per /api/gex.

    Nessun RTVolume (233): i loro trade non devono arrivare a vertical e tide.
    """

    def __init__(self, ib, contratti):
        self.ib = ib
        self.contratti = list(contratti)
        self.conid = {c.conId for c in self.contratti}
        self.pos = 0
        self.lotto = LOTTO_ESTERNI
        self.aperti = []
        self.dal = 0
        # (strike, right) -> {"vol", "oi", "gamma", "delta", "vega", "und"}
        self.valori = {}
        ib.errorEvent += self._errore

    def _errore(self, req_id, code, msg, contract):
        # 101 = troppe linee aperte: si dimezza il lotto invece di insistere.
        if code == 101 and self.lotto > 2:
            self.lotto = max(2, self.lotto // 2)
            print(f"Anello esterno: limite di linee IBKR, lotto ridotto a {self.lotto}.", flush=True)

    @staticmethod
    def _num(x):
        return float(x) if x is not None and x == x else None

    def _leggi(self, t):
        c = t.contract
        v = self.valori.setdefault((c.strike, c.right), {})
        vol = self._num(t.volume)
        oi = self._num(t.callOpenInterest if c.right == 'C' else t.putOpenInterest)
        if vol is not None and vol >= 0:
            v["vol"] = int(vol)
        if oi is not None and oi >= 0:
            v["oi"] = int(oi)
        g = t.modelGreeks
        if g:
            for nome, x in (("gamma", g.gamma), ("delta", g.delta), ("vega", g.vega), ("und", g.undPrice)):
                x = self._num(x)
                if x is not None:
                    v[nome] = x

    def avanza(self, adesso):
        if self.aperti and adesso - self.dal < TIENI_ESTERNI_SEC:
            return
        for t in self.aperti:
            self._leggi(t)
            self.ib.cancelMktData(t.contract)
        if not self.contratti:
            self.aperti = []
            return
        lotto = [self.contratti[(self.pos + i) % len(self.contratti)] for i in range(min(self.lotto, len(self.contratti)))]
        self.pos = (self.pos + len(lotto)) % len(self.contratti)
        self.aperti = [self.ib.reqMktData(c, '100,101,106', False, False) for c in lotto]
        self.dal = adesso

    def righe(self):
        """Una riga per strike con il gamma noto: calls/puts, callsOi/putsOi, greche."""
        strike = sorted({k for k, _ in self.valori})
        out = []
        for s in strike:
            c = self.valori.get((s, 'C'), {})
            p = self.valori.get((s, 'P'), {})
            gamma = c.get("gamma", p.get("gamma"))
            if gamma is None:
                continue
            arr = lambda x, n: round(x, n) if x is not None else None
            out.append({"strike": s, "calls": c.get("vol", 0), "puts": p.get("vol", 0),
                        "gamma": arr(gamma, 8), "delta": arr(c.get("delta", p.get("delta")), 8),
                        "vega": arr(c.get("vega", p.get("vega")), 8),
                        "callsOi": c.get("oi", 0), "putsOi": p.get("oi", 0)})
        return out

    def und(self):
        for v in self.valori.values():
            if v.get("und"):
                return round(v["und"], 2)
        return None


# Come per la colonna tide: se la tabella non c'e' ancora (sql/007 non
# eseguito) si smette di provare per dieci minuti, il file locale resta.
_tabella_esterni_manca_dal = None

def scrivi_esterni(date_key, riga):
    """Accoda la riga dell'anello esterno al file del giorno e la manda a Supabase."""
    global _supabase_client, _tabella_esterni_manca_dal
    try:
        os.makedirs(ESTERNI_DIR, exist_ok=True)
        with open(os.path.join(ESTERNI_DIR, f"{date_key}.ndjson"), 'a', encoding='utf-8') as f:
            f.write(json.dumps(riga, separators=(',', ':')) + "\n")
    except Exception as e:
        print(f"Error writing outer ring: {e}")
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    if _tabella_esterni_manca_dal is not None and time.time() - _tabella_esterni_manca_dal < _RIPROVA_COLONNA_TIDE_SEC:
        return
    try:
        if _supabase_client is None:
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        _supabase_client.table("volumes_esterni").upsert(
            {"date": date_key, "time": riga["time"], "spx_price": riga["spxPrice"],
             "und_price": riga["undPrice"], "volumes": riga["volumes"]},
            on_conflict="date,time", returning="minimal").execute()
        _tabella_esterni_manca_dal = None
    except Exception as e:
        if "volumes_esterni" in str(e) or "PGRST205" in str(e):
            _tabella_esterni_manca_dal = time.time()
            print("Tabella volumes_esterni assente su Supabase: l'anello esterno resta nel file locale "
                  "finche' non si esegue sql/007_volumes_esterni.sql.", file=sys.stderr)
        else:
            print(f"Error pushing outer ring to Supabase: {e}", file=sys.stderr)


def main():
    print("Starting Volumes Poller background service (IBKR TWS API)...")
    ensure_data_dir()
    
    ib = IB()
    # Cosi' chi tiene viva la sessione sa cosa chiudere quando finisce.
    registra_connessione(ib)
    connected = False
    import random
    
    for attempt in range(5):
        client_id = random.randint(1000, 9999)
        try:
            print(f"Attempting to connect to IBKR TWS (attempt {attempt+1}) as clientId {client_id}...")
            ib.connect('127.0.0.1', 7496, clientId=client_id, timeout=10)
            print("Connected to IBKR on port 7496.")
            connected = True
            break
        except Exception as e:
            print(f"Connection attempt {attempt+1} failed: {e}")
            ib.sleep(2)
            
    if not connected:
        print("CRITICAL: Failed to connect to IBKR after multiple attempts.")
        return


    # User confirmed they have real-time subscriptions
    ib.reqMarketDataType(1)

    # 1. Qualify SPX and get ATM
    spx_contract = Index('SPX', 'CBOE')
    ib.qualifyContracts(spx_contract)
    print("Qualifying SPX...")
    spx_ticker = ib.reqMktData(spx_contract, '', False, False)
    
    # Wait for SPX price
    spx = None
    for _ in range(10):
        ib.sleep(1)
        spx = spx_ticker.marketPrice()
        if spx and spx == spx:  # Check for NaN
            break
        elif spx_ticker.last and spx_ticker.last == spx_ticker.last:
            spx = spx_ticker.last
            break
        elif spx_ticker.close and spx_ticker.close == spx_ticker.close:
            spx = spx_ticker.close
            break

    if not spx or spx != spx:
        print("CRITICAL: Cannot determine SPX price to find ATM after 10 seconds.")
        return
        
    print(f"Current SPX Price: {spx}")

    # 2. Get Option Chain expiration
    chains = ib.reqSecDefOptParams(spx_contract.symbol, '', spx_contract.secType, spx_contract.conId)
    
    today_str = datetime.now().strftime('%Y%m%d')
    target_exp = today_str
    
    valid_chain = None
    # SPX dailies and weeklies are typically under tradingClass 'SPXW'
    for c in chains:
        if c.exchange == 'CBOE' and today_str in c.expirations:
            # Prefer SPXW if available since that's where dailies are, but any CBOE will do
            if c.tradingClass == 'SPXW' or not valid_chain:
                valid_chain = c

    if not valid_chain:
        print(f"CRITICAL: Could not find 0DTE options for today ({today_str}). Checking next available...")
        # Fallback if 0DTE doesn't exist (e.g. weekend testing or holiday)
        all_exp = set()
        for c in chains:
            if c.exchange == 'CBOE':
                all_exp.update(c.expirations)
        if not all_exp:
            return
        next_exp = sorted(list(all_exp))[0]
        for c in chains:
            if c.exchange == 'CBOE' and next_exp in c.expirations:
                valid_chain = c
                target_exp = next_exp
                break
                
        print(f"Fallback to Expiration: {target_exp}")
    else:
        print(f"Selected 0DTE Expiration: {target_exp} (Trading Class: {valid_chain.tradingClass})")
        
    chain = valid_chain

    # 3. Determine Strikes (18 above, 18 below ATM per ridurre del 10%)
    sorted_strikes = sorted(chain.strikes)
    
    # Find the index of the ATM strike (closest to spx)
    if not sorted_strikes:
        print("CRITICAL: No strikes found in the option chain.")
        return
        
    atm_strike_idx = min(range(len(sorted_strikes)), key=lambda i: abs(sorted_strikes[i] - spx))
    
    # Select 18 strikes below and 18 strikes above (37 strikes total -> 74 tickers)
    start_idx = max(0, atm_strike_idx - 18)
    end_idx = min(len(sorted_strikes), atm_strike_idx + 19)
    
    strikes = sorted_strikes[start_idx:end_idx]
    
    print(f"Selected {len(strikes)} strikes around {spx} (18 above, 18 below ATM)")
        
    # 4. Subscribe to Option Tickers
    option_tickers = []
    contracts = []
    for strike in strikes:
        c_call = Option('SPX', target_exp, strike, 'C', 'CBOE', multiplier='100', tradingClass=chain.tradingClass)
        c_put = Option('SPX', target_exp, strike, 'P', 'CBOE', multiplier='100', tradingClass=chain.tradingClass)
        contracts.extend([c_call, c_put])

    qualified = ib.qualifyContracts(*contracts)
    print(f"Qualified {len(qualified)} option contracts. Requesting Market Data...")

    for c in qualified:
        # Request data without volume limits if possible, we just need generic ticks (100) or short volume
        # Option Volume is usually included by default in reqMktData
        # 100 = Option Volume, 101 = Option Open Interest, 106 = Option
        # Implied Volatility (porta con se' i modelGreeks, e quindi il gamma),
        # 233 = RTVolume (ogni trade con prezzo e size, per i vertical).
        # Tutto sulle stesse linee di market data gia' impegnate: nessun
        # abbonamento in piu'.
        ticker = ib.reqMktData(c, '100,101,106,233', False, False)
        option_tickers.append({"strike": c.strike, "right": c.right, "ticker": ticker})

    # L'anello esterno: ESTERNI_PER_LATO strike per lato oltre quelli in
    # streaming, qualificati una volta e poi sottoscritti a rotazione.
    esterni_strike = (sorted_strikes[max(0, start_idx - ESTERNI_PER_LATO):start_idx]
                      + sorted_strikes[end_idx:end_idx + ESTERNI_PER_LATO])
    esterni_contratti = [Option('SPX', target_exp, k, r, 'CBOE', multiplier='100', tradingClass=chain.tradingClass)
                         for k in esterni_strike for r in ('C', 'P')]
    anello = AnelloEsterno(ib, ib.qualifyContracts(*esterni_contratti) if esterni_contratti else [])
    print(f"Anello esterno: {len(anello.contratti)} contratti "
          f"({esterni_strike[0] if esterni_strike else '-'}-{esterni_strike[-1] if esterni_strike else '-'}) a rotazione.")
    ultimo_esterni = 0

    def solo_catena(gestore):
        """Il gestore senza i ticker dell'anello: per Lee-Ready e vertical esistono solo i 37 strike."""
        return lambda tickers: gestore([t for t in tickers if t.contract is None or t.contract.conId not in anello.conid])

    # Il tide parte dai totali gia' salvati oggi, poi ascolta ogni aggiornamento
    # dei ticker: fra uno snapshot e l'altro (10 s) il volume cambia piu' volte,
    # e il lato va letto quando cambia, non dieci secondi dopo.
    tide = MarketTide()
    oggi = get_today_key()
    if _session_cache["date"] != oggi:
        _session_cache["date"] = oggi
        _session_cache["snapshots"] = read_session_file(oggi)
    tide.riprendi(_session_cache["snapshots"])
    lee_ready = LeeReady()
    lee_ready.riprendi(_session_cache["snapshots"])
    ib.pendingTickersEvent += solo_catena(lee_ready.su_tickers)
    # I trade arrivano al tide da qui, dopo aver capito se erano gambe di un vertical.
    rileva_verticali = RilevaVerticali(VERTICALI_DIR, tide)
    ib.pendingTickersEvent += solo_catena(rileva_verticali.su_tickers)

    print("Subscribed. Starting poller loop...")

    # Wait for initial data
    ib.sleep(5)

    last_poll = 0
    open_spx_captured = False
    giorno_sessione = get_today_key()
    # Quanti contratti hanno mai riportato volume in questa sessione, e da
    # quanti giri ne rispondono molti meno: vedi il controllo piu' sotto.
    max_attivi = 0
    giri_al_buio = 0

    while True:
        # A mezzanotte la sessione finisce: la scadenza 0DTE scelta all'avvio
        # e' scaduta, e restare abbonati a quei contratti vuol dire scrivere
        # sul file di oggi i volumi di ieri. Chi ci chiama riapre tutto.
        if get_today_key() != giorno_sessione:
            print(f"Giorno cambiato ({giorno_sessione} -> {get_today_key()}): chiudo la sessione.")
            return

        now = datetime.now()
        timestamp = now.timestamp()
        
        # Current time in minutes since midnight
        minutes_since_midnight = now.hour * 60 + now.minute
        
        start_minutes = minuti_locali_da_ny(*START_NY)
        end_minutes = minuti_locali_da_ny(*END_NY)
        is_active = start_minutes <= minutes_since_midnight <= end_minutes

        if is_active:
            if timestamp - last_poll >= POLL_INTERVAL:
                time_str = now.strftime('%H:%M:%S')
                # Ricalcolato a ogni giro: il poller resta acceso tra una
                # sessione e l'altra e la data cambia sotto di lui.
                today_key = get_today_key()

                # Capture current SPX price
                current_spx = spx_ticker.marketPrice()
                if not current_spx or current_spx != current_spx:
                    current_spx = spx_ticker.last if spx_ticker.last else spx_ticker.close
                
                # Sanitize NaN for JSON
                if current_spx != current_spx:
                    current_spx = None

                # Catena da ricentrare. Gli strike si scelgono una volta, a
                # inizio sessione, attorno al prezzo di quel momento -- che
                # prima delle 15:30 e' la chiusura di ieri. Il 22/10/2026 la
                # sessione e' partita a mezzanotte su 7757, lo SPX ha aperto
                # a 7685 ed e' sceso a 7650, sotto lo strike piu' basso
                # seguito (7665): mancavano tutti gli strike sotto il prezzo,
                # dove sta l'open interest delle put, e la "put wall" usciva
                # sempre sullo strike seguito piu' vicino, sopra il prezzo.
                # Solo con un prezzo vero (marketPrice), non con la chiusura:
                # chiudere la sessione la riapre fra 30s attorno allo spot, e
                # tide e Lee-Ready riprendono dagli snapshot gia' salvati.
                spot_vero = spx_ticker.marketPrice()
                if spot_vero and spot_vero == spot_vero:
                    idx_spot = min(range(len(sorted_strikes)), key=lambda i: abs(sorted_strikes[i] - spot_vero))
                    if abs(idx_spot - atm_strike_idx) > RICENTRA_DOPO_STRIKE:
                        print(f"SPX a {spot_vero}, catena centrata su {sorted_strikes[atm_strike_idx]} "
                              f"({strikes[0]}-{strikes[-1]}): chiudo la sessione per ricentrarla.", flush=True)
                        return

                # Apertura del cash, 9:30 a New York
                is_opening_snapshot = False
                if not open_spx_captured and minutes_since_midnight >= minuti_locali_da_ny(9, 30):
                    is_opening_snapshot = True
                    open_spx_captured = True
                    print(f"Captured SPX Opening Price at {time_str}: {current_spx}")
                
                # Aggregate volumes by strike
                volume_by_strike = {} # strike -> {calls, puts, gamma, delta, vega}

                # Initialize
                for s in strikes:
                    volume_by_strike[s] = {"calls": 0, "puts": 0, "gamma": None,
                                           "delta": None, "vega": None,
                                           "callsOi": 0, "putsOi": 0}

                valid_data_points = 0
                und_price = None
                for item in option_tickers:
                    ticker = item["ticker"]
                    strike = item["strike"]
                    right = item["right"] # 'C' or 'P'

                    vol = ticker.volume if ticker.volume and ticker.volume == ticker.volume else 0
                    # L'open interest sta su due campi distinti: il contratto
                    # call popola callOpenInterest, la put putOpenInterest.
                    raw_oi = ticker.callOpenInterest if right == 'C' else ticker.putOpenInterest
                    oi = int(raw_oi) if raw_oi and raw_oi == raw_oi else 0
                    if right == 'C':
                        volume_by_strike[strike]["calls"] += vol
                        volume_by_strike[strike]["callsOi"] += oi
                    else:
                        volume_by_strike[strike]["puts"] += vol
                        volume_by_strike[strike]["putsOi"] += oi

                    if vol > 0:
                        valid_data_points += 1

                    # Il gamma serve al calcolo del GEX reale. Call e put dello
                    # stesso strike lo condividono (parita' put-call), quindi
                    # si prende il primo dei due che arriva valorizzato.
                    # Delta e vega si raccolgono per il calcolo della vanna.
                    greeks = ticker.modelGreeks
                    if greeks:
                        if volume_by_strike[strike]["gamma"] is None and greeks.gamma is not None and greeks.gamma == greeks.gamma:
                            volume_by_strike[strike]["gamma"] = round(float(greeks.gamma), 8)
                        if volume_by_strike[strike]["delta"] is None and greeks.delta is not None and greeks.delta == greeks.delta:
                            volume_by_strike[strike]["delta"] = round(float(greeks.delta), 8)
                        if volume_by_strike[strike]["vega"] is None and greeks.vega is not None and greeks.vega == greeks.vega:
                            volume_by_strike[strike]["vega"] = round(float(greeks.vega), 8)
                        if und_price is None and greeks.undPrice and greeks.undPrice == greeks.undPrice:
                            und_price = round(float(greeks.undPrice), 2)

                con_gamma = sum(1 for v in volume_by_strike.values() if v["gamma"] is not None)
                con_delta = sum(1 for v in volume_by_strike.values() if v["delta"] is not None)
                con_vega = sum(1 for v in volume_by_strike.values() if v["vega"] is not None)
                print(f"[{time_str}] Aggregated volumes (C/P separate) for {valid_data_points} active contracts, "
                      f"gamma/delta/vega su {con_gamma}/{con_delta}/{con_vega}/{len(volume_by_strike)} strike.")

                # We save a snapshot: time -> array of volumes [strike, calls, puts, gamma, delta, vega]
                snapshot = {
                    "time": time_str,
                    "spxPrice": current_spx,
                    # Sottostante secondo IBKR: prima dell'apertura del cash
                    # l'indice SPX non e' calcolato, ma questo lo e' (deriva
                    # dai futures) ed e' il riferimento su cui e' stato
                    # valutato il gamma.
                    "undPrice": und_price,
                    "isOpening": is_opening_snapshot,
                    # cb/cs/pb/ps: call e put comprate e vendute oggi, per
                    # Lee-Ready (vedi LeeReady): ~1 KB in piu' a snapshot.
                    "volumes": [{"strike": k, "calls": v["calls"], "puts": v["puts"], "gamma": v["gamma"],
                                 "delta": v["delta"], "vega": v["vega"],
                                 "callsOi": v["callsOi"], "putsOi": v["putsOi"],
                                 **lee_ready.riga(k)}
                                for k, v in volume_by_strike.items()],
                    # Solo nel file locale: push_snapshot_to_supabase sceglie
                    # le colonne una per una e questa non c'e'.
                    "tide": tide.fotografia(),
                }
                
                append_to_session_file(today_key, snapshot)
                push_snapshot_to_supabase(today_key, snapshot)
                scrivi_quote(today_key, time_str, current_spx, target_exp, option_tickers,
                             {k: v["gamma"] for k, v in volume_by_strike.items()}, lee_ready)

                # Le sottoscrizioni si spengono da sole, e in silenzio.
                #
                # Il 21/08/2026 i contratti che riportavano volume sono passati
                # da 71 a 33 in dieci minuti, senza un errore da TWS: il gamma
                # continuava ad arrivare su tutti e 37 gli strike, il volume no.
                # Nel profilo restava un buco di dieci strike contigui proprio
                # attorno al denaro, e i dati salvati erano zeri che sembravano
                # dati veri. Riavviando il poller sono tornati 74 su 74.
                #
                # Non si sa ancora perche' si spengano. Si sa pero' che una
                # sessione nuova le rimette a posto, e questa e' gia' una cosa
                # che la macchina sa fare: uscire da main() vuol dire farsi
                # riaprire da esegui_a_oltranza() trenta secondi dopo.
                if valid_data_points > max_attivi:
                    max_attivi = valid_data_points
                if max_attivi >= 20 and valid_data_points < max_attivi * 0.5:
                    giri_al_buio += 1
                else:
                    giri_al_buio = 0
                if giri_al_buio >= 12:
                    print(f"[{time_str}] Solo {valid_data_points} contratti con volume su {max_attivi} "
                          f"visti in giornata: sottoscrizioni degradate, chiudo la sessione.")
                    return

                if timestamp - ultimo_esterni >= ESTERNI_OGNI_SEC:
                    righe_esterni = anello.righe()
                    if righe_esterni:
                        scrivi_esterni(today_key, {"time": time_str, "spxPrice": current_spx,
                                                   "undPrice": anello.und() or und_price,
                                                   "volumes": righe_esterni})
                        ultimo_esterni = timestamp

                last_poll = timestamp
        else:
            if now.second % 30 == 0:
                print(f"[{now.strftime('%H:%M:%S')}] Outside active hours ({start_minutes//60}:{start_minutes%60:02d} to {end_minutes//60}:{end_minutes%60:02d}). Waiting...")

        if is_active:
            try:
                anello.avanza(time.time())
            except Exception as e:
                print(f"Outer ring error: {e}")

        # Ogni secondo, non ogni 10: i trade si accoppiano entro mezzo secondo.
        try:
            rileva_verticali.elabora(time.time(), get_today_key())
        except Exception as e:
            print(f"Vertical detection error: {e}")

        ib.sleep(1)

if __name__ == "__main__":
    try:
        # Non `main()` una volta sola: una sessione finisce a ogni cambio di
        # giorno, e ogni caduta di TWS deve valere un tentativo, non la morte.
        esegui_a_oltranza(main, nome='volumes')
    except KeyboardInterrupt:
        print("\nExiting...")
