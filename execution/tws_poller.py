#!/usr/bin/env python3
import json
import time
import os
import sys
from datetime import datetime
from dotenv import load_dotenv

try:
    from ib_insync import *
except ImportError:
    print("Error: ib_insync is not installed. Please run 'pip install ib_insync'.")
    sys.exit(1)

from supabase import create_client, Client

from poller_session import esegui_a_oltranza, registra_connessione

# Load environment variables
load_dotenv()

# Configuration
# Un punto ogni 15 secondi invece che ogni 5: per un grafico intraday di VIX
# ed ES la risoluzione e' identica a vedersi, ma le righe scritte in una
# giornata passano da ~16.500 a ~5.500. E' la voce di banda piu' pesante del
# progetto, perche' /api/market?history=true rilegge tutta la giornata a ogni
# caricamento della pagina.
POLL_INTERVAL = 15  # seconds
START_HOUR = 0
END_HOUR = 23

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")

# Determine paths relative to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'market')

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

# Ora in cui si fissa il cono, in minuti da mezzanotte, e per quanto ancora
# si accetta di fissarlo se a quell'istante preciso mancavano i dati.
CONO_MINUTI = 15 * 60 + 35
CONO_TOLLERANZA_MIN = 30


def _percorso_cono(date_key):
    return os.path.join(DATA_DIR, f"cono-{date_key}.json")


def cono_gia_fissato(date_key):
    """
    Il cono di oggi, se era gia' stato fissato prima di questo avvio.

    Sta in un file suo e non fra gli snapshot: quelli sono tagliati agli
    ultimi 100, cioe' venticinque minuti, quindi un poller ripartito la sera
    non ci troverebbe piu' il punto delle 15:35 -- ci troverebbe il piu'
    vecchio che gli e' rimasto, delle 20:30, e lo congelerebbe chiamandolo
    apertura. Un valore sbagliato con l'aria di essere quello giusto e' il
    modo peggiore di sbagliare.
    """
    try:
        with open(_percorso_cono(date_key), 'r', encoding='utf-8') as f:
            salvato = json.load(f)
        if salvato.get("date") == date_key and salvato.get("up") and salvato.get("down"):
            return salvato["up"], salvato["down"]
    except (FileNotFoundError, ValueError, KeyError):
        pass
    return None, None


def salva_cono(date_key, su, giu, ora):
    ensure_data_dir()
    try:
        with open(_percorso_cono(date_key), 'w', encoding='utf-8') as f:
            json.dump({"date": date_key, "up": su, "down": giu, "time": ora}, f)
    except Exception as e:
        print(f"Impossibile salvare il cono: {e}", file=sys.stderr)


def append_to_session_file(date_key, point):
    ensure_data_dir()
    existing = read_session_file(date_key)
    existing.append(point)
    
    # Keep only the last 100 snapshots to ensure performance
    if len(existing) > 100:
        existing = existing[-100:]
        
    file_path = get_file_path(date_key)
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(existing, f, indent=2)
    except Exception as e:
        print(f"Error writing to file {file_path}: {e}")

def _passo_strike(strikes, atm, default=5.0):
    """Distanza fra strike adiacenti attorno all'ATM.

    Serve a sapere quanto lo spot puo' allontanarsi prima che lo strike
    scelto smetta di essere quello ATM.
    """
    vicini = sorted(strikes, key=lambda s: abs(s - atm))[:6]
    passi = sorted({round(abs(a - b), 4) for a in vicini for b in vicini if a != b})
    return passi[0] if passi else default


def _serve_rinnovo(ticker, strike, passo, spot, ultimo_agg, adesso):
    """Se lo strike sottoscritto non e' piu' quello ATM, va rifatto.

    Il rinnovo a tempo fisso ogni 15 minuti non bastava: nei minuti dopo
    l'apertura l'indice si sposta di piu' di tre intervalli di strike, e lo
    straddle finisce per essere misurato su un contratto dentro il denaro,
    gonfiato dal valore intrinseco. Il limite dei 30 secondi evita di
    riabbonarsi in continuazione quando lo spot oscilla attorno al confine.
    """
    if ticker is None:
        return True
    if adesso - ultimo_agg > 900:
        return True
    if strike is None or passo is None:
        return False
    return abs(spot - strike) > passo / 2 and adesso - ultimo_agg > 30


def setup_spx_atm_options(ib, spx_contract, spx_price):
    """Sottoscrive la call e la put ATM sulla chain SPX 0DTE.

    Serve al calcolo del range del pomeriggio (15:35), quando il cash
    americano e' aperto da cinque minuti.

    Le 0DTE stanno sotto la trading class SPXW, non SPX: quest'ultima ha solo
    le scadenze mensili (la piu' vicina e' a giorni di distanza). Il codice
    precedente prendeva `SPX` e poi `expirations[0]`, chiamando `exp_0dte`
    una scadenza a sei giorni: uno straddle circa 2,4 volte piu' largo del
    dovuto, e quindi livelli R sbagliati in modo silenzioso.

    Ritorna (ticker_call, ticker_put, strike, passo_strike) oppure None.
    """
    try:
        chains = ib.reqSecDefOptParams(spx_contract.symbol, '', spx_contract.secType, spx_contract.conId)
        if not chains:
            return None

        today = datetime.now().strftime('%Y%m%d')
        cbo = [c for c in chains if c.exchange == 'CBOE']
        chain = next((c for c in cbo if today in c.expirations and c.tradingClass == 'SPXW'), None) \
            or next((c for c in cbo if today in c.expirations), None)
        expiry = today
        if chain is None:
            # Nessuna 0DTE (festivo): prima scadenza utile, sempre da CBOE.
            options = sorted({(e, c.tradingClass) for c in cbo for e in c.expirations if e >= today})
            if not options:
                return None
            expiry, tc_name = options[0]
            chain = next(c for c in cbo if c.tradingClass == tc_name)

        if not chain.strikes:
            return None
        atm = min(chain.strikes, key=lambda s: abs(s - spx_price))

        call = Option('SPX', expiry, atm, 'C', 'CBOE', multiplier='100', tradingClass=chain.tradingClass)
        put = Option('SPX', expiry, atm, 'P', 'CBOE', multiplier='100', tradingClass=chain.tradingClass)
        qualified = ib.qualifyContracts(call, put)
        if len(qualified) != 2:
            print(f"SPX ATM: qualificati solo {len(qualified)}/2 contratti su {chain.tradingClass}")
            return None

        print(f"SPX ATM 0DTE aggiornato: strike {atm}, scadenza {expiry}, classe {chain.tradingClass}")
        return (ib.reqMktData(call, '106', False, False),
                ib.reqMktData(put, '106', False, False),
                atm, _passo_strike(chain.strikes, atm))
    except Exception as e:
        print(f"Errore nel setup delle opzioni SPX ATM: {e}", file=sys.stderr)
        return None


def setup_es_atm_options(ib, es_contract, es_price):
    """Sottoscrive la call e la put ATM sulla chain 0DTE delle opzioni ES.

    La mattina presto il range si calcola su ES e non su SPX: alle 10:35 CET
    sono le 04:35 a New York, le SPX quotano in Global Trading Hours con
    spread larghi mentre le ES sono piene su CME (spread ~0,3 punti).

    La trading class ruota ogni giorno -- E2D il giovedi', EW2 il venerdi',
    E3A il lunedi', 21 in tutto -- quindi non va mai scritta a mano: si cerca
    a runtime quale chain contiene la scadenza di oggi.

    Ritorna (ticker_call, ticker_put, strike, passo_strike) oppure None.
    """
    try:
        front = Future(conId=es_contract.conId, exchange='CME')
        ib.qualifyContracts(front)
        chains = ib.reqSecDefOptParams('ES', 'CME', 'FUT', front.conId)
        if not chains:
            return None

        today = datetime.now().strftime('%Y%m%d')
        chain = next((c for c in chains if today in c.expirations), None)
        expiry = today
        if chain is None:
            # Nessuna 0DTE (festivo, weekend): si prende la prima utile.
            future_exps = sorted({(e, c.tradingClass) for c in chains for e in c.expirations if e >= today})
            if not future_exps:
                return None
            expiry, tc_name = future_exps[0]
            chain = next(c for c in chains if c.tradingClass == tc_name)

        if not chain.strikes:
            return None
        atm = min(chain.strikes, key=lambda s: abs(s - es_price))

        call = FuturesOption('ES', expiry, atm, 'C', 'CME', tradingClass=chain.tradingClass)
        put = FuturesOption('ES', expiry, atm, 'P', 'CME', tradingClass=chain.tradingClass)
        qualified = ib.qualifyContracts(call, put)
        if len(qualified) != 2:
            print(f"ES ATM: qualificati solo {len(qualified)}/2 contratti su {chain.tradingClass}")
            return None

        print(f"ES ATM aggiornato: strike {atm}, scadenza {expiry}, classe {chain.tradingClass}")
        return (ib.reqMktData(call, '', False, False),
                ib.reqMktData(put, '', False, False),
                atm, _passo_strike(chain.strikes, atm))
    except Exception as e:
        print(f"Errore nel setup delle opzioni ES ATM: {e}", file=sys.stderr)
        return None


def _quote(ticker, side):
    """bid/ask di un ticker, None se assente o NaN."""
    if ticker is None:
        return None
    v = getattr(ticker, side, None)
    if v is None or v != v or v <= 0:
        return None
    return round(float(v), 2)


def _iv_atm(*tickers):
    """IV ATM in punti percentuali: media delle impliedVol IBKR disponibili.

    Arriva con i modelGreeks, che TWS manda per le opzioni senza generic tick
    dedicati. Valori fuori da (0, 5) -- cioe' oltre il 500% -- sono modelli
    che non hanno convergito, non volatilita'.
    """
    valori = []
    for t in tickers:
        g = getattr(t, 'modelGreeks', None) if t is not None else None
        iv = getattr(g, 'impliedVol', None) if g is not None else None
        if iv is not None and iv == iv and 0 < iv < 5:
            valori.append(float(iv))
    if not valori:
        return None
    return round(sum(valori) / len(valori) * 100, 2)


# Istante in cui Supabase ha risposto che la colonna es_atm_iv non esiste
# (sql/005_market_data_es_atm_iv.sql non ancora eseguito): per dieci minuti la
# si lascia fuori, invece di perdere l'intera riga a ogni push, poi si riprova
# -- cosi' dopo la migrazione torna da sola, senza riavviare il poller.
_colonna_iv_manca_dal = None
_RIPROVA_COLONNA_IV_SEC = 600


def push_to_supabase(point):
    if not SUPABASE_URL or not SUPABASE_KEY or SUPABASE_URL == "YOUR_SUPABASE_URL":
        return
    
    try:
        supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
        data = {
            "time": point["time"],
            "date": get_today_key(),
        }
        # Tutti i campi calcolati finivano nel cestino: si spingevano solo vix,
        # esf, time e date, quindi volTide, i coni e le quote ATM esistevano
        # solo nel file locale e in cloud non arrivavano.
        for k in ("vix", "esf", "spx", "volTide", "coneUp", "coneDown", "vwap"):
            if point.get(k) is not None:
                data[k] = point[k]
        for src, col in (("callBid", "call_bid"), ("callAsk", "call_ask"),
                         ("putBid", "put_bid"), ("putAsk", "put_ask"),
                         ("esCallBid", "es_call_bid"), ("esCallAsk", "es_call_ask"),
                         ("esPutBid", "es_put_bid"), ("esPutAsk", "es_put_ask"),
                         ("esAtmStrike", "es_atm_strike"), ("spxAtmStrike", "spx_atm_strike"),
                         ("spxRef", "spx_ref"), ("esAtmIv", "es_atm_iv")):
            if point.get(src) is not None:
                data[col] = point[src]
        global _colonna_iv_manca_dal
        if _colonna_iv_manca_dal is not None and time.time() - _colonna_iv_manca_dal < _RIPROVA_COLONNA_IV_SEC:
            data.pop("es_atm_iv", None)
        try:
            supabase.table("market_data").insert(data, returning="minimal").execute()
        except Exception as e:
            if "es_atm_iv" not in str(e) or "es_atm_iv" not in data:
                raise
            _colonna_iv_manca_dal = time.time()
            print("Colonna es_atm_iv assente su Supabase: la IV ATM resta solo nel file locale "
                  "finche' non si esegue sql/005_market_data_es_atm_iv.sql.", file=sys.stderr)
            data.pop("es_atm_iv", None)
            supabase.table("market_data").insert(data, returning="minimal").execute()
    except Exception as e:
        print(f"Error pushing to Supabase: {e}", file=sys.stderr)

def main():
    print("Starting Market Poller background service (IBKR TWS API)...")
    print(f"Data directory: {DATA_DIR}")
    print(f"Trading window: {START_HOUR}:00 - {END_HOUR}:00")
    
    if not SUPABASE_URL or SUPABASE_URL == "YOUR_SUPABASE_URL":
        print("WARNING: Supabase credentials not found. Falling back to local files only.")
    
    ib = IB()
    # Cosi' chi tiene viva la sessione sa cosa chiudere quando finisce.
    registra_connessione(ib)
    connected = False

    import random
    
    for attempt in range(5):
        client_id = random.randint(1000, 9999)
        try:
            print(f"Attempting to connect to IBKR TWS on 127.0.0.1:7496 as clientId {client_id} (attempt {attempt+1})...")
            ib.connect('127.0.0.1', 7496, clientId=client_id, timeout=10)
            print("Connected to IBKR on port 7496.")
            connected = True
            break
        except Exception as e:
            print(f"Connection attempt {attempt+1} failed: {e}")
            ib.sleep(2)
            
    if not connected:
        print("\nERROR: Failed to connect to IBKR on port 7496.")
        print("Please make sure TWS is open, and go to:")
        print("File -> Global Configuration -> API -> Settings")
        print("And check 'Enable ActiveX and Socket Clients'.")
        return

    # User confirmed they have real-time subscriptions, defaulting to 1 (Live)
    ib.reqMarketDataType(1)

    # Request market data
    # VIX Index
    vix_contract = Index('VIX', 'CBOE')
    ib.qualifyContracts(vix_contract)
    vix_ticker = ib.reqMktData(vix_contract, '', False, False)

    # ES continuous futures
    esf_contract = ContFuture('ES', 'CME')
    ib.qualifyContracts(esf_contract)
    # 233 = RTVolume, il tick che porta con se' il VWAP di giornata. Sul VIX
    # non si richiede: e' un indice, non ha volume, e restituirebbe NaN.
    esf_ticker = ib.reqMktData(esf_contract, '233', False, False)

    # SPX Index for Options logic (VolTide)
    spx_contract = Index('SPX', 'CBOE')
    ib.qualifyContracts(spx_contract)
    spx_ticker = ib.reqMktData(spx_contract, '', False, False)

    # Initialize option greeks variables
    vol_tide_score = 100.0
    # Il cono e' di giornata: se oggi era gia' stato fissato prima di questo
    # avvio, si riprende quello invece di ricalcolarne un altro.
    cone_up, cone_down = cono_gia_fissato(get_today_key())
    if cone_up:
        print(f"Cono di oggi ripreso dal file: {cone_down} - {cone_up}")
    last_skew_update = 0
    option_tickers = [] # [atm, put90, call120]

    # Straddle ATM 0DTE su SPX, per il calcolo del range del pomeriggio
    spx_call_ticker = None
    spx_put_ticker = None
    spx_atm_strike = None
    spx_strike_step = None
    last_spx_atm_update = 0

    # Straddle ATM sulla chain ES, per il calcolo del range della mattina
    es_call_ticker = None
    es_put_ticker = None
    es_atm_strike = None
    es_strike_step = None
    last_es_update = 0

    ib.sleep(3) # Wait for initial data

    giorno_sessione = get_today_key()

    while True:
        # A mezzanotte la sessione finisce: gli strike ATM e le scadenze
        # scelte ieri non valgono piu'. Chi ci chiama riapre tutto da capo.
        if get_today_key() != giorno_sessione:
            print(f"Giorno cambiato ({giorno_sessione} -> {get_today_key()}): chiudo la sessione.")
            return

        now = datetime.now()
        hour = now.hour
        minute = now.minute
        timestamp = now.timestamp()
        
        is_active = (hour == 0 and minute >= 5) or (START_HOUR + 1 <= hour < END_HOUR)
        
        # Ensure we process incoming IBKR messages to keep subscriptions alive
        ib.sleep(POLL_INTERVAL)

        if is_active:
            # We get marketPrice() which uses last price, or bid/ask average if last price is not available
            vix = vix_ticker.marketPrice()
            esf = esf_ticker.marketPrice()
            spx = spx_ticker.marketPrice()

            # Riferimento SPX per il pannello Range: l'indice non viene
            # calcolato prima dell'apertura del cash americano, quindi la
            # mattina `spx` e' NaN. Si ripiega su last e poi su close.
            # Resta un campo distinto da `spx`: scriverlo nella colonna vera
            # disegnerebbe sul grafico una linea piatta alla chiusura di ieri
            # da mezzanotte alle 15:30.
            spx_ref = None
            for candidate in (spx, spx_ticker.last, spx_ticker.close):
                if candidate and candidate == candidate and candidate > 0:
                    spx_ref = round(float(candidate), 2)
                    break

            # 1. Update Option Selection every 15 minutes (or if none selected)
            if (timestamp - last_skew_update > 900 or not option_tickers) and spx == spx and spx > 0:
                print(f"[{now.strftime('%H:%M:%S')}] Updating Option Skew targets (SPX at {spx})...")
                
                # Fetch chain
                chains = ib.reqSecDefOptParams(spx_contract.symbol, '', spx_contract.secType, spx_contract.conId)
                if chains:
                    # Preference: SPX (Standard) then SPXW (Weekly)
                    chain = next((c for c in chains if c.exchange == 'CBOE' and c.tradingClass == 'SPX'), None)
                    if not chain:
                        chain = next((c for c in chains if c.exchange == 'CBOE'), None)
                    
                    if chain:
                        # Find nearest weekly/monthly expiration (at least 2 days out, at most 30)
                        expirations = sorted(chain.expirations)
                        target_exp = expirations[0] 
                        for exp in expirations:
                            # Simple logic: closest to 7-10 days
                            try:
                                days = (datetime.strptime(exp, '%Y%m%d') - datetime.now()).days
                                if days >= 2:
                                    target_exp = exp
                                    break
                            except: continue
                        
                        # Strikes (Ensure we stay within bounds of what TWS offers)
                        strikes = sorted(chain.strikes)
                        target_90 = spx * 0.90
                        target_120 = spx * 1.20
                        
                        atm_strike = min(strikes, key=lambda x: abs(x - spx))
                        put90_strike = min(strikes, key=lambda x: abs(x - target_90))
                        call120_strike = min(strikes, key=lambda x: abs(x - target_120))
                        trading_class = chain.tradingClass

                        # Lo straddle ATM 0DTE non si costruisce piu' qui: sta
                        # su un'altra trading class (SPXW) e ha una sua
                        # funzione, setup_spx_atm_options.
                        atm_c = Option('SPX', target_exp, atm_strike, 'C', 'CBOE', multiplier='100', tradingClass=trading_class)
                        put90_c = Option('SPX', target_exp, put90_strike, 'P', 'CBOE', multiplier='100', tradingClass=trading_class)
                        call120_c = Option('SPX', target_exp, call120_strike, 'C', 'CBOE', multiplier='100', tradingClass=trading_class)
                        
                        print(f"Qualifying: ATM={atm_strike}, ExpVolTide={target_exp}, P90={put90_strike}, C120={call120_strike} ({trading_class})")
                        qualified = ib.qualifyContracts(atm_c, put90_c, call120_c)

                        # Cancel old
                        for t in option_tickers:
                            ib.cancelMktData(t.contract)

                        # Request new
                        option_tickers = []
                        if atm_c in qualified: option_tickers.append(ib.reqMktData(atm_c, '106', False, False))
                        if put90_c in qualified: option_tickers.append(ib.reqMktData(put90_c, '106', False, False))
                        if call120_c in qualified: option_tickers.append(ib.reqMktData(call120_c, '106', False, False))
                        
                        last_skew_update = timestamp
                        print(f"Active Tickers: {len(option_tickers)} (Qualified: {[c.strike for c in qualified]})")

            # 1-bis. Straddle ATM 0DTE su SPX, per il range delle 15:35.
            if spx == spx and spx > 0 and _serve_rinnovo(
                    spx_call_ticker, spx_atm_strike, spx_strike_step, spx, last_spx_atm_update, timestamp):
                setup = setup_spx_atm_options(ib, spx_contract, spx)
                if setup:
                    if spx_call_ticker is not None:
                        for old in (spx_call_ticker, spx_put_ticker):
                            try:
                                ib.cancelMktData(old.contract)
                            except Exception:
                                pass
                    spx_call_ticker, spx_put_ticker, spx_atm_strike, spx_strike_step = setup
                last_spx_atm_update = timestamp

            # 1-ter. Straddle ATM su ES. Non dipende da SPX, che resta NaN
            # finche' il cash americano non apre: e' per questo che la mattina
            # il range si calcola qui e non sulla chain SPX.
            if esf == esf and esf > 0 and _serve_rinnovo(
                    es_call_ticker, es_atm_strike, es_strike_step, esf, last_es_update, timestamp):
                setup = setup_es_atm_options(ib, esf_contract, esf)
                if setup:
                    if es_call_ticker is not None:
                        for old in (es_call_ticker, es_put_ticker):
                            try:
                                ib.cancelMktData(old.contract)
                            except Exception:
                                pass
                    es_call_ticker, es_put_ticker, es_atm_strike, es_strike_step = setup
                last_es_update = timestamp

            # 2. Calculate VolTide Score & ATM Option Quotes
            atm_call_bid = _quote(spx_call_ticker, 'bid')
            atm_call_ask = _quote(spx_call_ticker, 'ask')
            atm_put_bid = _quote(spx_put_ticker, 'bid')
            atm_put_ask = _quote(spx_put_ticker, 'ask')
            c_0dte_t = spx_call_ticker

            if len(option_tickers) >= 2:

                # Find the Put 90 and Call 120
                put_t = next((t for t in option_tickers if t.contract.right == 'P' and t.contract.strike != atm_strike), None)
                call_t = next((t for t in option_tickers if t.contract.right == 'C' and t.contract.strike > spx), None)
                atm_t = c_0dte_t or next((t for t in option_tickers if t.contract.right == 'C' and t.contract.strike <= spx), None)
                
                # Use modelGreeks safely
                put_iv = put_t.modelGreeks.impliedVol if (put_t and put_t.modelGreeks and put_t.modelGreeks.impliedVol) else None
                call_iv = call_t.modelGreeks.impliedVol if (call_t and call_t.modelGreeks and call_t.modelGreeks.impliedVol) else None
                atm_iv = atm_t.modelGreeks.impliedVol if (atm_t and atm_t.modelGreeks and atm_t.modelGreeks.impliedVol) else None
                
                if put_iv and call_iv and call_iv > 0:
                    vol_tide_score = round((put_iv / call_iv) * 100, 3)
                
                # 3. Il cono dello straddle, fissato all'apertura americana.
                #
                # Prima si ricalcolava a ogni giro sull'IV corrente, quindi
                # seguiva il prezzo e si stringeva col passare delle ore: due
                # linee che dicevano "quanto ci si aspetta di muoversi da
                # adesso a stasera", cioe' una cosa che cambia continuamente e
                # non si puo' usare come riferimento. Adesso lo si calcola una
                # volta sola, alle 15:35, e resta quello per tutta la
                # giornata: e' l'attesa del mercato al suono della campana.
                #
                # Se a quell'ora i dati non ci sono si riprova per mezz'ora,
                # come per i range; passata quella, la giornata resta senza --
                # meglio niente che un cono calcolato a un'ora qualsiasi e
                # spacciato per quello dell'apertura.
                if cone_up is None and atm_iv and atm_iv > 0:
                    minuti_ora = now.hour * 60 + now.minute
                    if CONO_MINUTI <= minuti_ora <= CONO_MINUTI + CONO_TOLLERANZA_MIN:
                        move = atm_iv * esf * 0.052  # sqrt(1/365)
                        cone_up = round(esf + move, 2)
                        cone_down = round(esf - move, 2)
                        salva_cono(get_today_key(), cone_up, cone_down, now.strftime('%H:%M:%S'))
                        print(f"[{now.strftime('%H:%M:%S')}] Cono fissato: "
                              f"{cone_down} - {cone_up} (IV ATM {round(atm_iv, 4)})")
            
            # Check if vix/esf are valid numbers, not NaN or 0
            if vix == vix and esf == esf and vix > 0 and esf > 0:
                vix_rounded = round(float(vix), 2)
                esf_rounded = round(float(esf), 2)
                spx_rounded = round(float(spx), 2) if (spx and spx == spx and spx > 0) else None
                time_str = now.strftime('%H:%M:%S')
                
                esf_vwap = esf_ticker.vwap
                esf_vwap = round(float(esf_vwap), 2) if esf_vwap and esf_vwap == esf_vwap and esf_vwap > 0 else None

                point = {
                    "time": time_str, 
                    "vix": vix_rounded, 
                    "esf": esf_rounded,
                    "spx": spx_rounded,
                    "volTide": vol_tide_score,
                    "coneUp": cone_up,
                    "coneDown": cone_down,
                    "callBid": atm_call_bid,
                    "callAsk": atm_call_ask,
                    "putBid": atm_put_bid,
                    "putAsk": atm_put_ask,
                    "esCallBid": _quote(es_call_ticker, 'bid'),
                    "esCallAsk": _quote(es_call_ticker, 'ask'),
                    "esPutBid": _quote(es_put_ticker, 'bid'),
                    "esPutAsk": _quote(es_put_ticker, 'ask'),
                    "esAtmStrike": es_atm_strike,
                    # IV ATM della chain ES 0DTE: la stessa call e put del
                    # Range Calc, quindi c'e' anche di notte, quando SPX no.
                    "esAtmIv": _iv_atm(es_call_ticker, es_put_ticker),
                    "spxAtmStrike": spx_atm_strike,
                    "spxRef": spx_ref,
                    "vwap": esf_vwap,
                }
                
                # Save locally
                append_to_session_file(get_today_key(), point)
                
                # Push to Cloud
                push_to_supabase(point)
                
                print(f"[{time_str}] VIX={vix_rounded}, ES=F={esf_rounded}, VolTide={vol_tide_score}")
            else:
                print(f"[{now.strftime('%H:%M:%S')}] Waiting for valid market quotes (VIX: {vix}, ES: {esf})")
        else:
            if now.second < POLL_INTERVAL:
                print(f"[{now.strftime('%H:%M:%S')}] Outside trading hours. Waiting...")
            continue

if __name__ == "__main__":
    try:
        # Non `main()` una volta sola: una sessione finisce a ogni cambio di
        # giorno, e ogni caduta di TWS deve valere un tentativo, non la morte.
        esegui_a_oltranza(main, nome='market')
    except KeyboardInterrupt:
        print("\nExiting...")
