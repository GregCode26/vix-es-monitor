-- Anello esterno della catena SPX 0DTE, solo per il profilo GEX di /api/gex.
--
-- Il poller dei volumi segue 37 strike in streaming; altri 20 per lato li
-- legge a rotazione (volume, open interest, gamma) e ne scrive una riga al
-- minuto. Tabella a parte e non dentro `volumes_snapshots`: cosi' gli snapshot
-- ogni 10 s non crescono, e /api/volumes e il resto non li vedono.
-- ~4 KB a riga, ~500 righe a sessione.
--
-- Da eseguire nel SQL Editor di Supabase. Finche' non c'e', il poller scrive
-- solo il file locale frontend/data/volumes-esterni/ e la route legge quello.

create table if not exists volumes_esterni (
    date       date    not null,
    time       text    not null,                 -- 'HH:MM:SS', ora locale del poller
    spx_price  float8,
    und_price  float8,
    volumes    jsonb   not null,                 -- stesse righe di volumes_snapshots, senza Lee-Ready
    created_at timestamptz not null default now(),
    primary key (date, time)
);

alter table volumes_esterni enable row level security;

drop policy if exists "volumes_esterni leggibili" on volumes_esterni;
create policy "volumes_esterni leggibili"
    on volumes_esterni for select
    using (true);

drop policy if exists "volumes_esterni scrivibili" on volumes_esterni;
create policy "volumes_esterni scrivibili"
    on volumes_esterni for insert
    with check (true);

drop policy if exists "volumes_esterni aggiornabili" on volumes_esterni;
create policy "volumes_esterni aggiornabili"
    on volumes_esterni for update
    using (true) with check (true);

-- Pulizia notturna, come per volumes_snapshots (pg_cron ragiona in UTC).
select cron.unschedule('pulizia-volumi-esterni')
    where exists (select 1 from cron.job where jobname = 'pulizia-volumi-esterni');

select cron.schedule(
    'pulizia-volumi-esterni',
    '6 1 * * *',
    $$delete from volumes_esterni where date < current_date$$
);
