# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal market dashboard ("Greg Dashboard") with three areas:
- **Market Monitor** (`/market`): live VIX + ES=F (S&P futures) intraday chart
- **SPX Volumes / GEX** (`/spx-volumes`, `/gex`, `/spx-gamma`): 3D and gamma-exposure visualizations of SPX option data
- **Finance Input** (`/input`): manual personal transaction log written to a local CSV

Frontend is Next.js (App Router), deployed to Vercel. Data collection is done by local Python scripts talking to Interactive Brokers TWS, which is only reachable when running on the developer's own machine — this is fundamentally a local-first tool with a cloud-deployed viewer.

Auth is a hardcoded client-side check (`Gregorio` / `Pinzolo26` in `frontend/src/app/login/page.tsx`) storing `market_auth` in `localStorage`. This is intentional for a single-user private tool — do not "fix" it into a real auth system unless asked.

## Commands

Frontend (run from `frontend/`):
```bash
npm run dev      # http://localhost:3000
npm run build
npm run lint
```

Python (run from repo root):
```bash
pip install -r requirements.txt
pip install ib_insync          # not in requirements.txt but required by pollers

python execution/tws_poller.py          # VIX + ES=F + SPX poller (needs IBKR TWS running locally, port 7496)
python execution/tws_volumes_poller.py  # SPX option volume-by-strike poller
python execution/tws_iv_poller.py       # SPX 0DTE ATM implied volatility monitor (bid/ask/IV per option)
python execution/backfill_ibkr.py       # 1-min historical backfill for VIX/ES
python execution/init_db.py             # verify Supabase connectivity / print bootstrap SQL
python execution/check_sync.py          # read latest Supabase rows for today
```

`start_dashboard.bat` (Windows) opens the browser and hands off to `scripts/keep_dashboard_alive.ps1`, a supervisor that keeps `npm run dev` up (restarting it 15s after any exit) and POSTs `/api/poller` every minute so a poller that dies with TWS comes back. It does not launch the pollers itself: they start with the server via `frontend/src/instrumentation.ts` (skipped on Vercel, or with `AUTO_START_POLLERS=false`).

**The supervisor is registered as a logon task, so nothing has to be launched by hand.** Scheduled task `GregDashboard` (AtLogon, 30s delay, no execution time limit, no elevation) runs the same script hidden. This exists because the retry wrapper inside each poller survives TWS disconnecting and the day rolling over, but not the machine being switched off: on 21/08/2026 the logs stopped at 22:05 the previous night mid-retry and nothing ran until 16:05, losing two and a half hours of the session. Starting a second supervisor is harmless — it checks whether port 3000 already answers before starting a server, so it will not put Next on 3001. Inspect it with `Get-ScheduledTask GregDashboard`, disable it with `Disable-ScheduledTask GregDashboard`.

There is no automated test suite in this repo.

## Architecture

### Data flow: pollers → files/Supabase → API routes → chart

**Every poller runs sessions, not one endless loop** (`execution/poller_session.py`). A session = connect, pick today's 0DTE chain, subscribe, poll; it *ends* when the day changes, and `esegui_a_oltranza()` starts a fresh one 30s later. This is not decoration: the date key for the output file was recomputed every iteration but the 0DTE expiry was chosen once at startup, so past midnight a poller looked healthy and wrote to the right file while subscribed to expired contracts. The same wrapper turns two other fatal cases into retries — TWS restarting overnight (`ConnectionError: Socket disconnect` used to kill the process) and data not being ready yet (every `CRITICAL: ...` was a `return`, i.e. permanent death; the IV poller restarted at 08:27 CET died because SPX cash does not print before 15:30). Do not "simplify" a poller back into a single `main()` loop, and keep the `spx_ticker.close` fallbacks — they are what let a poller come up before the cash open.

Python pollers (`execution/tws_poller.py`, `execution/tws_volumes_poller.py`) connect to a locally running IBKR TWS instance, pull market/option data, and write JSON snapshot files. `tws_poller.py` also optionally pushes rows to Supabase (`push_to_supabase()` currently only sends `vix`, `esf`, `time`, `date` — NOT the derived `volTide`/`coneUp`/`coneDown` fields, so anything relying on those cloud-side will not find them).

Next.js API routes (`frontend/src/app/api/*/route.ts`) read this data back out:
- `GET /api/market` — Supabase first if configured, else local JSON fallback. No params = latest point; `?history=true` = today's intraday series. **Today only** — there is no `?date=` and no archived-session branch.
- `GET /api/volumes` — Supabase table `volumes_snapshots` (una riga per snapshot) first, local JSON fallback. **Today only**, no `?date=`; `?since=HH:MM:SS` returns only the snapshots after that time, which is how the page stays cheap — it fetches ~2 KB every 30s instead of re-downloading the session.
- `GET /api/gex` — **real** gamma exposure, computed in TypeScript from the same `volumes_snapshots` rows `/api/volumes` reads: gamma comes from the IBKR `modelGreeks` the volumes poller already subscribes to. This replaced the old synthetic generator (the port of `execution/gexbot.py`, still on disk but no longer invoked by anything). Every point carries two measures and the page switches between them without refetching: `gex` weighted by volume traded (a **flow** measure) and `gexOi` weighted by open interest (**positioning**, the canonical GEX — flat intraday, since OI is frozen at the previous close). The call-positive/put-negative sign is still the standard "dealers long calls, short puts" heuristic, not observed data. The response carries `points` (flow bubbles), `profile` (day total per strike), `spot` (the underlying as IBKR valued the gamma, one point per ~30s — the right series for a gamma page, unlike `/api/market` with its hand-rolled timezone shift), and `profileHistory` (the profile as it was 1/5/10 minutes ago, computed only on the full load — an incremental window is a few seconds wide and could not contain it). **Today only**, no `?date=`; supports `?since=` like `/api/volumes`, plus `?flow=0` to drop the bubbles (474 KB → 27 KB for a full session); the first load is truncated to the last ~8000 flow points (the cumulative `profile` is unaffected). Returns **503 when there is no gamma yet** — the volumes poller only collects between 13:30 and 22:00, so this is the normal answer in the morning, not a failure.
- `GET /api/iv-monitor` — **implied volatility changes** for SPX 0DTE options near ATM. Collects bid/ask/IV from IBKR via `tws_iv_poller.py` (separate from the volumes poller). Response includes weighted PUT IV and weighted CALL IV (weighted by distance from ATM), calculated IV change % (default 1-min lookback), and a differential (PUT change − CALL change) measuring volatility skew. No params = today's full session; `?since=HH:MM:SS` returns only snapshots after that time; `?limit=N` caps results. Reads from Supabase `iv_snapshots` table if configured, else local JSON fallback (`frontend/data/iv-monitor/YYYY-MM-DD.json`). **Today only**, no `?date=` — same rule as the other routes. **Read incrementally via `?since=`**: a snapshot is ~1.3 KB and one arrives every 5 seconds, so a full session is ~8 MB and the page polls every 5s; fetching the whole day each time was ~700 full-session downloads per hour against the Supabase egress budget. The table is `sql/002_iv_snapshots.sql` (it did not exist until 21/08/2026, so every push failed with PGRST205 while the local JSON fallback quietly hid it). **The poller must never write NaN**: `json.dump` emits bare `NaN`, which is not JSON, and `JSON.parse` then rejects the *entire file* — one missing IBKR price cost the whole 7.3 MB session of 20/08/2026. `_senza_nan()` maps it to `null` before both the file write and the Supabase push.
- `POST /api/bookmap` / `GET /api/bookmap` — ES CVD and book liquidity from **Bookmap**, local only (no Supabase: ~80.000 samples/day would not be worth the egress). `execution/bookmap_addon.py` is not launched by us: it is a Bookmap Python add-on (built from Bookmap's *API plugins configuration*) that POSTs one sample per second (~1 KB, including the limit-order levels within 30 ticks that the page draws as Bookmap-style horizontal lines, and the limit contracts added/removed within 5 levels of the best on each side, counted on every depth update), sending from a background thread so Bookmap's callbacks never wait on the network. The route appends to `frontend/data/bookmap/YYYY-MM-DD.ndjson` and computes the CVD itself as the day's running sum of `buy - sell`, so restarting Bookmap does not reset it. Today only, `?since=HH:MM:SS`. On Vercel GET answers `local: false` and the page says so. After editing the add-on, copy it to `C:\Bookmap\Python\` and rebuild it from Bookmap's code editor (runtime set to the system `python.exe`, since Bookmap looks for a `python3` that Windows does not have).
- `POST /api/poller` — spawns the pollers as detached background processes via `child_process.spawn('python', ...)`, one log each under `.tmp/poller-logs/`. Only works when the API itself is running locally (there's a "start pollers" button in the UI backed by this route, `PollerButton.tsx`; `instrumentation.ts` also calls it at server boot, and `scripts/keep_dashboard_alive.ps1` POSTs to it every minute). **A live PID is not proof a poller is running:** `frontend/src/lib/pollers.ts` verifies the process's actual command line (`Get-CimInstance Win32_Process` on Windows, `ps -o pid=,args=` elsewhere) before trusting `.tmp/pollers.lock`, because Windows recycles PIDs fast — a stale lock pointing at a recycled PID once made the pollers look alive for a whole day while nothing was collected. Restart is per-script, so one dead poller comes back without waiting for the other to die too. Do not "simplify" this back to `process.kill(pid, 0)`.
- `POST /api/finance` / `GET /api/finance` — writes to / reads from the Supabase `transactions` table, falling back to appending `.tmp/transactions.csv` when Supabase is not configured. The old `spawn('python3', ...)` is gone (it never worked on Windows and never worked on Vercel).

**Supabase egress is the binding constraint, not database size.** The free tier allows ~5 GB/month of egress, and the volumes path is what spends it: every extra KB moves ~3.000 times a day. Two rules keep it in budget — writes from the pollers must pass `returning="minimal"` (PostgREST otherwise echoes the whole inserted row back), and the volumes page must fetch incrementally via `?since=`. Reverting either one costs hundreds of MB per trading day. See `sql/001_volumes_snapshots.sql`.

**Known path inconsistency (real, not hypothetical):** pollers write market/volume JSON to `frontend/data/market` and `frontend/data/volumes`, while a root-level `data/market/` and `data/gex/` also exist and some routes resolve paths via `process.cwd()` in ways that assume Next was started from a specific directory. If a change touches file read/write paths, check the actual `path.join`/`path.resolve` calls in the specific route rather than assuming a single canonical data directory — the routes are not all consistent with each other yet.

### Frontend chart pages

- `frontend/src/app/market/page.tsx` — main Chart.js dashboard. Trading window is `00:05`–`23:00` CET; a 30s watcher detects session start/end and resets `localStorage` (`marketData_YYYY-MM-DD`) at `00:05`. Polls `/api/market` every 5s during the window. Custom auto-scroll logic: chart tracks live data at the right edge unless the user has manually panned back, in which case tracking locks until "RESTORE LIVE VIEW" is clicked. Also hosts the "Range Calc" panel (implied-volatility range model off ATM straddle prices entered manually at 10:35/15:35) which computes R1/R2/R3 reference lines and can push them onto the chart.
- `frontend/src/app/spx-volumes/page.tsx` — `echarts` + `echarts-gl` 3D view of call/put volume by strike over time, polling `/api/volumes` every 10s.
- `frontend/src/app/gex/page.tsx` — Chart.js view of the GEX **flow** over time (the `points` bubbles), reading `/api/gex` incrementally via `?since=` plus `/api/market?history=true` for the spot line.
- `frontend/src/app/spx-gamma/page.tsx` — `echarts` view of the GEX **profile by strike**: bars per strike, the spot scrolling alongside on a second (time) x-axis, and white dots showing the same profile 1/5/10 minutes ago. Fetches `/api/gex?flow=0` (it draws the profile, not the bubbles — the flow is ~95% of the payload) every 15s. Reference levels (Major Pos/Neg Gamma, Zero Gamma) are derived from the profile, not stored anywhere. Both bases are on one axis via a selector: on 0DTE the volume-weighted numbers run ~20× the OI-weighted ones, so showing them together by default would flatten the OI bars onto zero. **Values are in $M in the API and rendered as $Bn in this page** — check `inMiliardi()` before comparing numbers across the two pages.
- `frontend/src/app/iv-monitor/page.tsx` — Chart.js dashboard monitoring real-time **implied volatility changes** for SPX 0DTE options. Tracks weighted IV for PUT and CALL near ATM, displays IV change % over user-selected lookback period (5s/30s/1m/5m), and a differential chart showing PUT−CALL IV skew. Polls `/api/iv-monitor` every 5s during active hours. Controlled by `execution/tws_iv_poller.py` which connects to IBKR and collects IV bid/ask data every 5 seconds. See `context/IV_MONITOR_SETUP.md` for full setup and interpretation guide.
- Chart updates should stay imperative (`chart.data... ; chart.update('none')`) to avoid resetting user zoom/pan state — this is the existing convention in `market/page.tsx`, follow it in other Chart.js views.

### Persistence layers in play simultaneously

- Browser `localStorage`: daily market cache, reference lines + visibility, auth token.
- Local filesystem: JSON snapshot files (see path caveat above); `.tmp/transactions.csv` for finance entries.
- Supabase (Postgres): optional — used by the market/volumes/gex/iv-monitor/finance routes, each with a local file fallback. Env vars for it live in `frontend/.env.local` and `execution/.env` (see those files for the current key names — do not print their values).

On Vercel, only `/tmp` is writable and is wiped on cold start, so file-backed history does not persist there — Supabase (where wired up) is the only durable cloud store today.

## Project docs worth reading before larger changes

- `context/PROJECT_OVERVIEW.md`, `context/ARCHITECTURE_NOTES.md`, `context/MISMATCHES_AND_RISKS.md`, `context/NEXT_STEPS.md` — an existing audit of this repo's structure and known issues (data path inconsistencies, incomplete Supabase schema, `python3` vs `python` on Windows, hardcoded auth). Written more recently than `Gemini.md` and considered more accurate.
- `Gemini.md` — earlier project reference (in Italian); useful for historical context on the Range Calc math and chart color conventions, but treat path/architecture claims in it as superseded by `context/`.
- `directives/add_transaction.md` — SOP for the finance transaction flow.

## Windows-specific notes

Dev happens on Windows. `Procfile` references a `market_poller.py` that does not currently exist in `execution/` — it's stale relative to the actual poller filenames (`tws_poller.py`, `tws_volumes_poller.py`).
