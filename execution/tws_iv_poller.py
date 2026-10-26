"""
ES 0DTE ATM Implied Volatility Monitor
Raccoglie bid/ask/IV per opzioni vicine all'ATM, calcola weighted IV e variazioni.
Salva snapshot ogni 5 secondi.
"""

import json
import os
import sys
import time
from datetime import datetime
import asyncio
from collections import deque

try:
    from ib_insync import *
except ImportError:
    print("Error: ib_insync is not installed. Please run 'pip install ib_insync'.")
    sys.exit(1)

from poller_session import esegui_a_oltranza, registra_connessione, minuti_locali_da_ny

try:
    from dotenv import load_dotenv
    from supabase import create_client
    load_dotenv()
    SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    SUPABASE_KEY = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
except ImportError:
    SUPABASE_URL = SUPABASE_KEY = None
    print("WARNING: supabase/dotenv non disponibili, si scrive solo su file locale.")

POLL_INTERVAL = 5  # seconds - raccogliamo IV ogni 5 secondi
# Finestra in ora di New York (7:30-16:00 = 13:30-22:00 italiane quasi tutto
# l'anno), convertita a ogni giro: vedi `minuti_locali_da_ny`.
START_NY = (7, 30)
END_NY = (16, 0)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'frontend', 'data', 'iv-monitor')

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

_session_cache = {"date": None, "snapshots": []}


def _senza_nan(valore):
    """
    Sostituisce i NaN con None, ricorsivamente.

    `json.dump` di suo scrive NaN, che JSON non prevede: JSON.parse lo rifiuta
    e con lui l'INTERO file, non la sola riga sbagliata. Il 20 agosto 2026 e'
    bastato un `"esPrice":NaN` -- IBKR non aveva ancora un prezzo -- per
    rendere illeggibili 7,3 MB, cioe' tutta la giornata: la route leggeva,
    falliva il parse e rispondeva con una lista vuota.

    `allow_nan=False` non andrebbe bene: solleverebbe, e a quel punto non si
    scriverebbe piu' niente. Qui il valore mancante diventa `null`, che e'
    esattamente quello che e'.
    """
    if isinstance(valore, float):
        return None if valore != valore else valore
    if isinstance(valore, dict):
        return {k: _senza_nan(v) for k, v in valore.items()}
    if isinstance(valore, list):
        return [_senza_nan(v) for v in valore]
    return valore


def append_to_session_file(date_key, snapshot):
    ensure_data_dir()

    if _session_cache["date"] != date_key:
        _session_cache["date"] = date_key
        _session_cache["snapshots"] = read_session_file(date_key)

    _session_cache["snapshots"].append(_senza_nan(snapshot))

    file_path = get_file_path(date_key)
    try:
        temp_file = file_path + ".tmp"
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(_session_cache["snapshots"], f, separators=(',', ':'))
        os.replace(temp_file, file_path)
    except Exception as e:
        print(f"Error writing to file {file_path}: {e}")

_supabase_client = None

def push_snapshot_to_supabase(date_key, snapshot):
    """Inserisce il singolo snapshot IV."""
    global _supabase_client
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        if _supabase_client is None:
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        snapshot = _senza_nan(snapshot)
        _supabase_client.table("iv_snapshots").upsert({
            "date": date_key,
            "time": snapshot["time"],
            "es_price": snapshot["esPrice"],
            "atm_strike": snapshot["atmStrike"],
            "weighted_put_iv": snapshot["weightedPutIV"],
            "weighted_call_iv": snapshot["weightedCallIV"],
            "put_iv_change_pct": snapshot["putIVChangePct"],
            "call_iv_change_pct": snapshot["callIVChangePct"],
            "iv_differential_pct": snapshot["ivDifferentialPct"],
            "puts_data": snapshot.get("putsData"),
            "calls_data": snapshot.get("callsData"),
        }, on_conflict="date,time", returning="minimal").execute()
    except Exception as e:
        print(f"Error pushing IV snapshot to Supabase: {e}", file=sys.stderr)


def calculate_weighted_iv(options_data, atm_strike, is_put=True, only_atm=False, only_wing=False):
    """
    Calcola la volatilità implicita ponderata per le opzioni vicine all'ATM.

    La ponderazione è basata sulla distanza dall'ATM: più vicino = peso maggiore.
    Formula: peso = 1 / (1 + distanza_in_strike_units)

    Args:
        options_data: list di dict {"strike": X, "iv": Y, "bid": B, "ask": A}
        atm_strike: strike ATM
        is_put: True per PUT, False per CALL
        only_atm: se True, usa solo la strike più vicina all'ATM
        only_wing: se True, esclude la strike più vicina all'ATM (wing only)

    Returns:
        float: weighted average IV percentuale
    """
    if not options_data:
        return None

    # Filtra opzioni valide (con IV)
    valid_options = [opt for opt in options_data if opt.get("iv") is not None]
    if not valid_options:
        return None

    # Trova l'ATM (strike più vicina)
    atm_option = min(valid_options, key=lambda opt: abs(opt["strike"] - atm_strike))
    atm_distance = abs(atm_option["strike"] - atm_strike)

    # Filtra based su only_atm / only_wing
    if only_atm:
        # Usa solo strike entro tolleranza dalla più vicina all'ATM
        options_to_use = [opt for opt in valid_options if abs(abs(opt["strike"] - atm_strike) - atm_distance) < 0.5]
    elif only_wing:
        # Esclude la strike più vicina all'ATM
        options_to_use = [opt for opt in valid_options if abs(opt["strike"] - atm_option["strike"]) > 0.5]
    else:
        options_to_use = valid_options

    if not options_to_use:
        return None

    total_weight = 0
    weighted_sum = 0

    for opt in options_to_use:
        strike_dist = abs(opt["strike"] - atm_strike)
        # Peso inversamente proporzionale alla distanza
        weight = 1.0 / (1.0 + strike_dist / 5.0)  # 5 point distance scale
        weighted_sum += opt["iv"] * weight
        total_weight += weight

    if total_weight == 0:
        return None

    return weighted_sum / total_weight


def calculate_iv_change(current_iv, history_deques, lookback_seconds=60):
    """
    Calcola il cambio percentuale dell'IV rispetto a N secondi fa.

    Args:
        current_iv: IV attuale
        history_deques: dict {"put": deque, "call": deque} con (timestamp, iv) tuples
        lookback_seconds: quanti secondi indietro guardare

    Returns:
        dict con {"pct_change": X, "previous_iv": Y} o None se insufficiente storia
    """
    if current_iv is None:
        return None

    now = time.time()
    cutoff = now - lookback_seconds

    # Cerca il valore più vecchio dentro il window. La storia si riempie con
    # appendleft (il più recente in testa): letta in avanti, il primo valore
    # trovato era quello appena aggiunto, e la variazione valeva sempre 0.
    previous_iv = None
    for ts, iv in reversed(history_deques):
        if ts >= cutoff and iv is not None:
            previous_iv = iv
            break

    if previous_iv is None:
        return None

    if previous_iv == 0:
        return None

    pct_change = ((current_iv - previous_iv) / previous_iv) * 100

    return {"pct_change": pct_change, "previous_iv": previous_iv}


def main():
    print("Starting IV Monitor (IBKR TWS API)...")
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

    ib.reqMarketDataType(1)  # Real-time data

    # 1. Qualify SPX (the underlying for 0DTE options we're monitoring)
    spx_contract = Index('SPX', 'CBOE')
    ib.qualifyContracts(spx_contract)
    print("Qualifying SPX index...")
    spx_ticker = ib.reqMktData(spx_contract, '', False, False)

    # Wait for SPX price
    spx_price = None
    for _ in range(10):
        ib.sleep(1)
        spx_price = spx_ticker.marketPrice()
        if spx_price and spx_price == spx_price:  # Check for NaN
            break
        elif spx_ticker.last and spx_ticker.last == spx_ticker.last:
            spx_price = spx_ticker.last
            break
        # Prima delle 15:30 l'indice cash non stampa: senza questo ripiego
        # sulla chiusura di ieri -- che il poller dei volumi ha da sempre --
        # ogni avvio mattutino moriva qui, e l'ATM da cui partire e' comunque
        # buono finche' non apre il cash.
        elif spx_ticker.close and spx_ticker.close == spx_ticker.close:
            spx_price = spx_ticker.close
            break

    if not spx_price or spx_price != spx_price:
        print("CRITICAL: Cannot determine SPX price.")
        return

    print(f"Current SPX Price: {spx_price}")

    # 2. Get SPX option chain for 0DTE
    chains = ib.reqSecDefOptParams(spx_contract.symbol, '', spx_contract.secType, spx_contract.conId)

    today_str = datetime.now().strftime('%Y%m%d')
    target_exp = today_str

    valid_chain = None
    for c in chains:
        if c.exchange == 'CBOE' and today_str in c.expirations:
            if c.tradingClass == 'SPXW' or not valid_chain:
                valid_chain = c

    if not valid_chain:
        print(f"CRITICAL: Could not find 0DTE options for today ({today_str}).")
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
        print(f"Selected 0DTE Expiration: {target_exp}")

    chain = valid_chain

    # 3. Select ATM and nearby strikes (ATM ± 2 default)
    sorted_strikes = sorted(chain.strikes)
    strike_range = 2

    # 5. Subscribe to option tickers (bid/ask/IV)
    option_tickers = []

    def centra(idx):
        """Segue gli strike ATM +/- strike_range attorno a sorted_strikes[idx].

        Toglie le sottoscrizioni uscite dalla finestra e aggiunge le nuove:
        quelle che restano non si toccano, cosi' non perdono i dati gia' arrivati.
        """
        voluti = set(sorted_strikes[max(0, idx - strike_range):idx + strike_range + 1])
        for item in [it for it in option_tickers if it["strike"] not in voluti]:
            ib.cancelMktData(item["ticker"].contract)
            option_tickers.remove(item)
        presenti = {it["strike"] for it in option_tickers}
        contracts = []
        for strike in sorted(voluti - presenti):
            contracts.append(Option('SPX', target_exp, strike, 'C', 'CBOE', multiplier='100', tradingClass=chain.tradingClass))
            contracts.append(Option('SPX', target_exp, strike, 'P', 'CBOE', multiplier='100', tradingClass=chain.tradingClass))
        for c in ib.qualifyContracts(*contracts):
            # Request IV (code 106 includes modelGreeks)
            ticker = ib.reqMktData(c, '106', False, False)
            option_tickers.append({"strike": c.strike, "right": c.right, "ticker": ticker})
        option_tickers.sort(key=lambda it: (it["strike"], it["right"]))
        print(f"Selected strikes: {sorted(voluti)}")

    centro_idx = min(range(len(sorted_strikes)), key=lambda i: abs(sorted_strikes[i] - spx_price))
    centra(centro_idx)

    print("Subscribed to option data. Starting poller loop...")
    ib.sleep(3)

    # History for calculating IV changes (keyed by "put" and "call")
    put_iv_history = deque(maxlen=13)  # ~65 seconds at 5s interval
    call_iv_history = deque(maxlen=13)

    # History for WING IV (the main signal now)
    put_wing_iv_history = deque(maxlen=13)
    call_wing_iv_history = deque(maxlen=13)

    # History for ATM IV
    put_atm_iv_history = deque(maxlen=13)
    call_atm_iv_history = deque(maxlen=13)

    # History for SKEW
    put_skew_history = deque(maxlen=13)
    call_skew_history = deque(maxlen=13)

    last_poll = 0
    last_atm_update = 0
    giorno_sessione = get_today_key()

    while True:
        # A mezzanotte la sessione finisce: la scadenza 0DTE scelta all'avvio
        # e' scaduta, e le IV che ne verrebbero non sono di oggi. Chi ci
        # chiama riapre tutto con la catena del giorno nuovo.
        if get_today_key() != giorno_sessione:
            print(f"Giorno cambiato ({giorno_sessione} -> {get_today_key()}): chiudo la sessione.")
            return

        now = datetime.now()
        timestamp = now.timestamp()
        minutes_since_midnight = now.hour * 60 + now.minute

        is_active = minuti_locali_da_ny(*START_NY) <= minutes_since_midnight <= minuti_locali_da_ny(*END_NY)

        if is_active:
            if timestamp - last_poll >= POLL_INTERVAL:
                time_str = now.strftime('%H:%M:%S')
                today_key = get_today_key()

                # Update ATM periodically (every 30 seconds)
                if timestamp - last_atm_update >= 30:
                    spx_price = spx_ticker.marketPrice()
                    if not spx_price or spx_price != spx_price:
                        spx_price = spx_ticker.last if spx_ticker.last else spx_ticker.close
                    if spx_price == spx_price:
                        print(f"[{time_str}] SPX: {spx_price}")
                    last_atm_update = timestamp

                    # Gli strike si scelgono all'avvio attorno al prezzo di quel
                    # momento, che prima delle 15:30 e' la chiusura di ieri: il
                    # 23/10/2026 erano 7655-7675 con lo SPX sceso a 7648, tutti
                    # sopra lo spot, e "ATM" e "wing" non erano piu' tali. Con
                    # +/-2 strike basta un movimento di 5 punti per uscire, quindi
                    # si sposta la finestra qui, senza chiudere la sessione (che
                    # costerebbe 30s di buco e la storia delle variazioni). Solo
                    # su un prezzo vero, e oltre 3/4 di strike dal centro, perche'
                    # un prezzo a cavallo fra due strike non la faccia oscillare.
                    spot_vero = spx_ticker.marketPrice()
                    if spot_vero and spot_vero == spot_vero:
                        idx = min(range(len(sorted_strikes)), key=lambda i: abs(sorted_strikes[i] - spot_vero))
                        passo = abs(sorted_strikes[idx] - sorted_strikes[centro_idx]) / max(1, abs(idx - centro_idx))
                        if idx != centro_idx and abs(spot_vero - sorted_strikes[centro_idx]) > 0.75 * passo:
                            print(f"[{time_str}] SPX a {spot_vero}: ricentro su {sorted_strikes[idx]}")
                            centro_idx = idx
                            centra(centro_idx)

                # Get SPX price for snapshot
                spx_price_current = spx_ticker.marketPrice()
                if not spx_price_current or spx_price_current != spx_price_current:
                    spx_price_current = spx_ticker.last if spx_ticker.last else spx_ticker.close

                # Collect IV data from all tickers
                puts_data = []
                calls_data = []

                for item in option_tickers:
                    ticker = item["ticker"]
                    strike = item["strike"]
                    right = item["right"]

                    bid = ticker.bid if ticker.bid and ticker.bid == ticker.bid else None
                    ask = ticker.ask if ticker.ask and ticker.ask == ticker.ask else None

                    # Try different possible attribute names for IV
                    iv = None
                    for attr in ['impliedVolatility', 'impliedVol', 'option_implied_vol']:
                        if hasattr(ticker, attr):
                            val = getattr(ticker, attr)
                            if val and val == val:  # Check for NaN
                                iv = val
                                break

                    # If still None, try extracting from modelGreeks or other sources
                    if iv is None and hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
                        # modelGreeks might contain IV information
                        pass  # For now, leave it None

                    # Calculate mid price
                    mid = None
                    if bid is not None and ask is not None and bid > 0 and ask > 0:
                        mid = (bid + ask) / 2
                    elif bid is not None and bid > 0:
                        mid = bid
                    elif ask is not None and ask > 0:
                        mid = ask

                    opt_data = {
                        "strike": strike,
                        "bid": bid,
                        "ask": ask,
                        "mid": mid,
                        "iv": iv if iv is not None else None,
                    }

                    if right == 'C':
                        calls_data.append(opt_data)
                    else:
                        puts_data.append(opt_data)

                # Calculate weighted IVs - ATM only
                put_atm_iv = calculate_weighted_iv(puts_data, spx_price, is_put=True, only_atm=True)
                call_atm_iv = calculate_weighted_iv(calls_data, spx_price, is_put=False, only_atm=True)

                # Calculate weighted IVs - WING only (OTM)
                put_wing_iv = calculate_weighted_iv(puts_data, spx_price, is_put=True, only_wing=True)
                call_wing_iv = calculate_weighted_iv(calls_data, spx_price, is_put=False, only_wing=True)

                # Calculate SKEW = WING - ATM
                put_skew = (put_wing_iv - put_atm_iv) * 100 if put_wing_iv and put_atm_iv else None  # in vol points
                call_skew = (call_wing_iv - call_atm_iv) * 100 if call_wing_iv and call_atm_iv else None

                # Keep old ATM for backward compatibility (weighted average of all nearby)
                weighted_put_iv = calculate_weighted_iv(puts_data, spx_price, is_put=True)
                weighted_call_iv = calculate_weighted_iv(calls_data, spx_price, is_put=False)

                # Calculate old-style changes for backward compatibility
                put_iv_history.appendleft((timestamp, weighted_put_iv)) if weighted_put_iv else None
                call_iv_history.appendleft((timestamp, weighted_call_iv)) if weighted_call_iv else None

                put_change_result = calculate_iv_change(weighted_put_iv, put_iv_history, lookback_seconds=60)
                call_change_result = calculate_iv_change(weighted_call_iv, call_iv_history, lookback_seconds=60)
                put_iv_change_pct = put_change_result["pct_change"] if put_change_result else None
                call_iv_change_pct = call_change_result["pct_change"] if call_change_result else None

                # Add to history with timestamp (wing IV is the primary signal now)
                if put_wing_iv is not None:
                    put_wing_iv_history.appendleft((timestamp, put_wing_iv))
                if call_wing_iv is not None:
                    call_wing_iv_history.appendleft((timestamp, call_wing_iv))

                # Calculate IV changes for WING (default 1 minute lookback)
                put_wing_change_result = calculate_iv_change(put_wing_iv, put_wing_iv_history, lookback_seconds=60)
                call_wing_change_result = calculate_iv_change(call_wing_iv, call_wing_iv_history, lookback_seconds=60)

                put_wing_iv_change_pct = put_wing_change_result["pct_change"] if put_wing_change_result else None
                call_wing_iv_change_pct = call_wing_change_result["pct_change"] if call_wing_change_result else None

                # Calculate IV changes for ATM (for reference)
                put_atm_iv_history.appendleft((timestamp, put_atm_iv)) if put_atm_iv else None
                call_atm_iv_history.appendleft((timestamp, call_atm_iv)) if call_atm_iv else None

                put_atm_change_result = calculate_iv_change(put_atm_iv, put_atm_iv_history, lookback_seconds=60)
                call_atm_change_result = calculate_iv_change(call_atm_iv, call_atm_iv_history, lookback_seconds=60)

                put_atm_iv_change_pct = put_atm_change_result["pct_change"] if put_atm_change_result else None
                call_atm_iv_change_pct = call_atm_change_result["pct_change"] if call_atm_change_result else None

                # Calculate SKEW changes
                put_skew_history.appendleft((timestamp, put_skew)) if put_skew is not None else None
                call_skew_history.appendleft((timestamp, call_skew)) if call_skew is not None else None

                put_skew_change_result = calculate_iv_change(put_skew, put_skew_history, lookback_seconds=60)
                call_skew_change_result = calculate_iv_change(call_skew, call_skew_history, lookback_seconds=60)

                put_skew_change_pct = put_skew_change_result["pct_change"] if put_skew_change_result else None
                call_skew_change_pct = call_skew_change_result["pct_change"] if call_skew_change_result else None

                # Calculate differential (main signal)
                vol_differential_pct = None
                if put_wing_iv_change_pct is not None and call_wing_iv_change_pct is not None:
                    vol_differential_pct = put_wing_iv_change_pct - call_wing_iv_change_pct

                # Old differential (for compatibility)
                iv_differential_pct = vol_differential_pct

                # Create snapshot
                snapshot = {
                    "time": time_str,
                    "timestamp": timestamp,
                    "esPrice": spx_price_current,
                    "atmStrike": spx_price,
                    # ATM IV (all nearby strikes weighted)
                    "weightedPutIV": weighted_put_iv,
                    "weightedCallIV": weighted_call_iv,
                    "putIVChangePct": put_iv_change_pct,
                    "callIVChangePct": call_iv_change_pct,
                    # ATM IV (only closest strike)
                    "putAtmIV": put_atm_iv,
                    "callAtmIV": call_atm_iv,
                    "putAtmIVChangePct": put_atm_iv_change_pct,
                    "callAtmIVChangePct": call_atm_iv_change_pct,
                    # WING IV (OTM only) - PRIMARY SIGNAL
                    "putWingIV": put_wing_iv,
                    "callWingIV": call_wing_iv,
                    "putWingIVChangePct": put_wing_iv_change_pct,
                    "callWingIVChangePct": call_wing_iv_change_pct,
                    # SKEW (wing - ATM)
                    "putSkew": put_skew,
                    "callSkew": call_skew,
                    "putSkewChangePct": put_skew_change_pct,
                    "callSkewChangePct": call_skew_change_pct,
                    # Differentials
                    "volDifferentialPct": vol_differential_pct,
                    "ivDifferentialPct": iv_differential_pct,  # backward compat
                    # Option data
                    "putsData": puts_data,
                    "callsData": calls_data,
                }

                append_to_session_file(today_key, snapshot)
                push_snapshot_to_supabase(today_key, snapshot)

                if put_wing_iv is not None and call_wing_iv is not None:
                    print(f"[{time_str}] PUT WING IV: {put_wing_iv:.2f}% ({put_wing_iv_change_pct:+.2f}%) | CALL WING IV: {call_wing_iv:.2f}% ({call_wing_iv_change_pct:+.2f}%) | Diff: {vol_differential_pct:+.2f}%")

                last_poll = timestamp
        else:
            if now.second % 30 == 0:
                print(f"[{now.strftime('%H:%M:%S')}] Outside active hours. Waiting...")

        ib.sleep(1)


if __name__ == "__main__":
    try:
        # Non `main()` una volta sola: una sessione finisce a ogni cambio di
        # giorno, e ogni caduta di TWS deve valere un tentativo, non la morte.
        esegui_a_oltranza(main, nome='iv')
    except KeyboardInterrupt:
        print("\nExiting...")
