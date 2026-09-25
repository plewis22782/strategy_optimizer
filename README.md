# Strategy Optimizer

An MT5-style parameter optimizer for the Strike Canopy paper strategies. It
replays Strike Canopy's **real, unmodified** strategy code (pinned to a
commit) against a local cache of The Well's history, so a pass is exact and
puts zero load on the live systems. Design: [`docs/SPEC.md`](docs/SPEC.md).

Status: **phase 1 (engine) working.** DayPack pull, the cached Well client,
the sim DB and single-pass runs are done. The fidelity test reproduces
Strike Canopy's own `bt_nutter5`/`bt_nutter10` results event-for-event.
Search (grid/genetic), the UI and the AI setup are next.

## How it fits

| Reads | How | Writes |
| --- | --- | --- |
| The Well | HTTP API (`/api/chain-history`, `/api/bars`, `/api/expirations`, `/api/candles`), one request at a time, once per session/chain -> DayPack or generic cache | nothing |
| Strike Canopy code | pinned clone in `vendor/strike-canopy` (`scripts/vendor-sync.sh`) | nothing |
| Strike Canopy Paper Lab | read-only, for pass-vs-live comparison (phase 3) | nothing |
| its own Postgres (`strategy-optimizer-db`) | sim schemas + results | `sim_w*`, `runs`, `passes`, `pass_days` |

## Schemas

**DayPack** (`$OPT_DATA_DIR/packs/<date>/`, gzip JSON, immutable), described
by `manifest.json`:
- `chain_SPX_<date>_60s.json.gz`: `{ key, spot[{bucketMs,spot}], rows[{bucketMs,k,cp,mid,bid,ask,delta,gamma,iv}] }`,
  the exact `getChainHistory` payload Strike Canopy's backtest asks for
  (09:30-16:06 ET, 60 s buckets, 300 s lookback).
- `bars_<table>.json.gz`: `{ table, fromMs, toMs, rows[BarRow] }` for
  `spx_minute_bars`, `es_implied_spx_minute` and `es_minute_bars`, from
  session open minus 4 days (the WAE warm-up) to 16:06.
- `manifest.checks`: `spx_chain` (>= 380 of 397 buckets) and `spx_bars`
  (>= 370 of 390 RTH bars). A strategy refuses a day that fails a check it
  needs, rather than silently reporting "no-entry".

**Optimizer DB**
- `sim_w<N>.*`: UNLOGGED copies of Strike Canopy's `strategy`,
  `strategy_position`, `strategy_leg` and `strategy_event`. The DDL is taken
  from the pinned `db/schema.sql`, so it can't drift. Scratch only; a pass's
  rows are deleted once summarised.
- `runs(id, status, spec jsonb, sc_ref, ...)`: one optimization run.
- `passes(id, run_id, phase back|forward, generation, params, varied, metrics, criterion)`
- `pass_days(pass_id, date, outcome, pnl, result, events)`

## Generic strategies (any ticker)

JSON-defined strategies on any symbol The Well covers (S&P 500 / Nasdaq-100
+ SPX/QQQ/IWM, 2 years via Massive). Spec: `src/generic/spec.ts`; examples
in `examples/generic/` (45 DTE put spread, weekly iron condor, monthly
cash-secured put, 45 DTE strangle). Design notes: `docs/SPEC.md`.

```bash
docker exec strategy-optimizer-runner node_modules/.bin/tsx src/cli.ts generic \
  --spec examples/generic/aapl-45dte-put-spread.json --from 2026-06-15 --to 2026-09-18 --trades --skips
# sweep: every combination, ranked by a criterion
  ... --grid '{"exit.profitTargetPct":[25,50,75],"costs.spreadMult":[1,2,3]}' --criterion recoveryFactor
```

Stock chains are **modeled** from trades (no historical quotes exist on
this plan): always look at `spreadMult` 2-3 before trusting a result.

## Where it runs

On **Redfish** (192.168.4.31: 72 threads, 251 GB RAM) since 2026-09-25, moved
from Charlie for the compute. `~/strategy-optimizer` + data in
`~/strategy-optimizer-data` (`OPT_HOST_DATA` is set in `.env`). It reaches
The Well over the LAN at `http://192.168.4.25:8092`. GitHub access from
Redfish is a per-repo deploy key (`~/.ssh/strategy_optimizer_deploy_key`,
wired via `git config core.sshCommand`), same pattern as Alan's repo.

## Commands

```bash
export OPT_HOST_DATA=~/strategy-optimizer-data   # where packs + pgdata live on the host (Redfish)
docker compose -p strategy-optimizer up -d --wait db runner
docker exec strategy-optimizer-runner node_modules/.bin/tsx src/cli.ts pull --from 2026-09-15 --to 2026-09-23
docker exec strategy-optimizer-runner node_modules/.bin/tsx src/cli.ts pass --strategy nutterfly10 --dates 2026-09-21 --params '{"stopMin":60,"waeFlipAbort":false}' --events
docker compose -p strategy-optimizer run --rm --no-deps runner node_modules/.bin/tsx src/cli.ts accept
```

Typecheck: `docker run --rm -u 1000:1000 -v "$PWD":/app -w /app node:22-slim node_modules/.bin/tsc --noEmit -p tsconfig.json`

## Rules
- Pulls from The Well are serial (never parallel sweeps against it). The
  after-hours-only rule was retired 2026-09-25: it existed only because the
  live DB shared a saturated disk, and that DB is now on its own SSD.
- Never point `DATABASE_URL` at `tasty-market-db`.
- Never edit `vendor/strike-canopy`. Change Strike Canopy in its own dev
  tree, then re-pin with `scripts/vendor-sync.sh <commit>`.
- Always pass `-p strategy-optimizer` and a service name to compose.
