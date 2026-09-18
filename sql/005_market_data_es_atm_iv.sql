-- IV ATM di ES, per la linea rossa "IV ATM" sul grafico di /market.
--
-- E' la media dell'implied volatility (modelGreeks IBKR) della call e della
-- put ATM sulla chain 0DTE delle opzioni ES che tws_poller.py segue gia' per
-- il Range Calc, in punti percentuali (18.5 = 18,5%).
--
-- Da eseguire nel SQL Editor di Supabase.

alter table market_data add column if not exists es_atm_iv float8;

-- Verifica: una riga.
select column_name, data_type
from information_schema.columns
where table_name = 'market_data' and column_name = 'es_atm_iv';
