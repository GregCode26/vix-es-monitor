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

from poller_session import esegui_a_oltranza, registra_connessione

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
START_HOUR = 8  # 14:30 Italian = 8:30 Eastern inside IBKR usually, but let's use local machine time
# Assuming local machine is CET
START_TIME_MINUTES = 13 * 60 + 30  # Adjusted for immediate testing
END_TIME_MINUTES = 22 * 60  # 22:00


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'volumes')

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

    IBKR non manda ogni trade con il suo lato. Manda il volume cumulato del
    contratto, l'ultimo prezzo e il book: quando il volume sale, i contratti
    in piu' si attribuiscono confrontando l'ultimo prezzo con bid e ask di
    quel momento. Vicino all'ask conta come comprato, vicino al bid come
    venduto, a meta' non conta. E' un'approssimazione: i tick di opzioni sono
    campionati, e fra due aggiornamenti possono passare piu' trade.
    """

    VICINO_ASK = 0.6  # quota dello spread da bid verso ask
    VICINO_BID = 0.4

    def __init__(self):
        self.ultimo_volume = {}  # conId -> volume cumulato visto
        self.ncp = 0.0  # net call premium, $
        self.npp = 0.0  # net put premium, $
        self.ncv = 0    # net call volume, contratti
        self.npv = 0    # net put volume, contratti

    def riprendi(self, snapshots):
        """Riparte dai totali dell'ultimo snapshot: un riavvio a meta' sessione
        non deve azzerare la giornata. I contratti scambiati mentre il poller
        era giu' restano fuori, perche' il loro lato non si puo' piu' sapere."""
        for snap in reversed(snapshots):
            tide = snap.get("tide")
            if tide:
                self.ncp = float(tide.get("ncp", 0))
                self.npp = float(tide.get("npp", 0))
                self.ncv = int(tide.get("ncv", 0))
                self.npv = int(tide.get("npv", 0))
                print(f"Market Tide ripreso dalle {snap.get('time')}: NCP {self.ncp:,.0f}, NPP {self.npp:,.0f}")
                return

    @staticmethod
    def _valido(x):
        return x is not None and x == x and x > 0

    def su_tickers(self, tickers):
        for t in tickers:
            c = t.contract
            if c is None or c.secType != 'OPT':
                continue
            vol = t.volume
            if vol is None or vol != vol:
                continue
            precedente = self.ultimo_volume.get(c.conId)
            self.ultimo_volume[c.conId] = vol
            # Il primo volume visto e' la base: quello che c'era prima non ha lato.
            if precedente is None or vol <= precedente:
                continue
            nuovi = vol - precedente
            prezzo, bid, ask = t.last, t.bid, t.ask
            if not (self._valido(prezzo) and self._valido(bid) and self._valido(ask)) or ask <= bid:
                continue
            quota = (prezzo - bid) / (ask - bid)
            if quota >= self.VICINO_ASK:
                lato = 1
            elif quota <= self.VICINO_BID:
                lato = -1
            else:
                continue
            premio = nuovi * prezzo * 100 * lato
            if c.right == 'C':
                self.ncp += premio
                self.ncv += int(nuovi) * lato
            else:
                self.npp += premio
                self.npv += int(nuovi) * lato

    def fotografia(self):
        return {"ncp": round(self.ncp), "npp": round(self.npp), "ncv": self.ncv, "npv": self.npv}

_supabase_client = None

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
        _supabase_client.table("volumes_snapshots").upsert({
            "date": date_key,
            "time": snapshot["time"],
            "spx_price": snapshot["spxPrice"],
            "und_price": snapshot.get("undPrice"),
            "is_opening": snapshot["isOpening"],
            "volumes": snapshot["volumes"],
        }, on_conflict="date,time", returning="minimal").execute()
    except Exception as e:
        print(f"Error pushing snapshot to Supabase: {e}", file=sys.stderr)

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
        # Implied Volatility (porta con se' i modelGreeks, e quindi il gamma).
        # Tutto sulle stesse linee di market data gia' impegnate: nessun
        # abbonamento in piu'.
        ticker = ib.reqMktData(c, '100,101,106', False, False)
        option_tickers.append({"strike": c.strike, "right": c.right, "ticker": ticker})

    # Il tide parte dai totali gia' salvati oggi, poi ascolta ogni aggiornamento
    # dei ticker: fra uno snapshot e l'altro (10 s) il volume cambia piu' volte,
    # e il lato va letto quando cambia, non dieci secondi dopo.
    tide = MarketTide()
    oggi = get_today_key()
    if _session_cache["date"] != oggi:
        _session_cache["date"] = oggi
        _session_cache["snapshots"] = read_session_file(oggi)
    tide.riprendi(_session_cache["snapshots"])
    ib.pendingTickersEvent += tide.su_tickers

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
        
        is_active = START_TIME_MINUTES <= minutes_since_midnight <= END_TIME_MINUTES

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

                # Check for 15:30 open (9:30 EST)
                is_opening_snapshot = False
                if not open_spx_captured and now.hour == 15 and now.minute >= 30:
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
                    "volumes": [{"strike": k, "calls": v["calls"], "puts": v["puts"], "gamma": v["gamma"],
                                 "delta": v["delta"], "vega": v["vega"],
                                 "callsOi": v["callsOi"], "putsOi": v["putsOi"]}
                                for k, v in volume_by_strike.items()],
                    # Solo nel file locale: push_snapshot_to_supabase sceglie
                    # le colonne una per una e questa non c'e'.
                    "tide": tide.fotografia(),
                }
                
                append_to_session_file(today_key, snapshot)
                push_snapshot_to_supabase(today_key, snapshot)

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

                last_poll = timestamp
        else:
            if now.second % 30 == 0:
                print(f"[{now.strftime('%H:%M:%S')}] Outside active hours ({START_TIME_MINUTES//60}:{START_TIME_MINUTES%60} to {END_TIME_MINUTES//60}:{END_TIME_MINUTES%60}). Waiting...")
        
        ib.sleep(1)

if __name__ == "__main__":
    try:
        # Non `main()` una volta sola: una sessione finisce a ogni cambio di
        # giorno, e ogni caduta di TWS deve valere un tentativo, non la morte.
        esegui_a_oltranza(main, nome='volumes')
    except KeyboardInterrupt:
        print("\nExiting...")
