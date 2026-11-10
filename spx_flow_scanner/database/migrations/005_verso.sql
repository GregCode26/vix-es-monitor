-- Verso dei singoli trade (10/11/2026): l'ultima quotazione bid/ask prima
-- del trade, dallo storico tick IBKR (BID_ASK), e il confronto col mid.
--   verso: 'C' comprato (sopra il mid), 'V' venduto (sotto), 'I' al mid,
--          'N' nessuna quotazione utile; NULL = non ancora chiesto.
ALTER TABLE trades ADD COLUMN bid REAL;
ALTER TABLE trades ADD COLUMN ask REAL;
ALTER TABLE trades ADD COLUMN verso TEXT;
