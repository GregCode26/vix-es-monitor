-- Market Tide sugli snapshot dei volumi, per la pagina /market-tide pubblicata.
--
-- NCP, NPP e i due volumi netti sono cumulati dal poller dei volumi e finivano
-- solo nel file JSON locale: su Vercel i file dei poller non esistono (vedi
-- frontend/.vercelignore), quindi la pagina restava vuota.
--
-- Una colonna jsonb invece di quattro float8: e' un blocco solo, ~60 byte a
-- riga, e la route lo legge da solo senza toccare `volumes` -- che pesa 5 KB a
-- snapshot ed e' quello che spenderebbe l'egress.
--
-- Da eseguire nel SQL Editor di Supabase.

alter table volumes_snapshots add column if not exists tide jsonb;

-- Verifica: una riga.
select column_name, data_type
from information_schema.columns
where table_name = 'volumes_snapshots'
  and column_name = 'tide';
