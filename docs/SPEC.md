# Strategy Optimizer — design spec

An MT5-style parameter optimizer for the Strike Canopy paper strategies
(Nutterfly first). It is standalone: its own repo, containers and database.
It reads market history from **The Well** and live paper results from
**Strike Canopy's Paper Lab**. It never writes to either one.

## Goals

1. **Exact fidelity.** A pass runs Strike Canopy's *real* tick functions
   (`nutterflyTick`, …), unmodified and pinned to a commit. There is no
   re-implementation that could drift from the live strategy.
2. **Minimal load on live systems.** Each session's data is pulled from The
   Well once, serially, into a local cache. Every pass after that reads
   only the cache. (2026-09-23: running 16 sweep variants against The Well
   in parallel timed out its chain-history calls and pushed the shared DB to
   ~260-1700% CPU. Never again.)
3. **MT5 feature parity where it matters:**
   - Each input has start / step / stop plus an "optimize" checkbox, and
     the UI shows the combination count.
   - Search: complete grid (slow) or genetic (fast).
   - Optimization criteria: total P&L, profit factor, expectancy, max
     drawdown (min), recovery factor, Sharpe, completion rate, and a
     custom/complex blend.
   - Forward testing: split the date range (1/2, 1/3, 1/4 or a custom
     date), optimize on the first part, then re-run the top 25% (genetic)
     or top 10% (grid) on the forward part.
   - A results table (one row per pass, sortable) and graphs: a 1-D line
     (criterion vs one param), a 2-D heatmap (two params, colour =
     criterion), a 3-D surface, and a genetic-progress scatter.
   - Drill into a pass: its per-day trade log, equity curve, and a
     comparison with the live Paper Lab track record over the same days.
4. **AI-native (phase 3).** A model turns a plain-English request into a
   validated `TestSpec`, submits it, and **idles with zero tokens** until
   the run finishes. Then it reads a compact results summary and explains
   it. Bring-your-own model and API key, with the key cached client-side
   only.

## Non-goals

- No live or real trading, ever: paper math only, as in Strike Canopy.
- No LLM-generated *code* is ever executed. The AI can only emit a
  `TestSpec` (JSON, zod-validated) over strategies and parameters that
  already exist.

## Architecture

```
 The Well API ──(after-hours pull, once per session)──► DayPack cache (/mnt/data/optimizer/cache)
 Strike Canopy src/strategy (pinned clone) ─┐                     │
                                            ▼                     ▼
                         worker pool (N node processes) ── CachedWellClient
                                            │
                                            ▼
                         optimizer DB (own Postgres, on /mnt/data)
                           ├─ sim schema: strategy_position/leg/event (+ instruments slice)
                           └─ runs / passes / pass_days (results)
                                            │
                          API + web UI (table, 1D/2D/3D, drill-in)
                                            │
                     Strike Canopy Paper Lab (read-only: /api/strategy/history)
```

### DayPack (cache unit = one ET session)
- `chain/<SYM>/<EXP>.json.gz`: the `getChainHistory` payload for the
  session at a 60 s bucket and 300 s lookback. This is what
  `ChainHistoryCache` already consumes.
- `bars/<table>.json.gz`: the `getBars` rows the strategy reads (SPX RTH
  plus /ES-implied), including the warm-up days the WAE EMA-200 needs.
- `instruments.json.gz`: the instruments rows for the session's
  expirations (strike/type lookups, nearest common expiration).
- `manifest.json`: source, pull time, Strike Canopy commit and row counts.
Packs are immutable. Re-pull only when The Well re-derives a day, keyed by a
checksum in the manifest.

### CachedWellClient
Implements the subset of `WellClient` the strategies call (`getBars`,
`getChainHistory`, `getChainSnapshot`, `getMany`) from a loaded DayPack.
Any other call throws, so an uncovered read fails loudly instead of quietly
hitting The Well.

### Sim DB
Tick functions persist state through `pool.query` into the `strategy_*`
tables. Each worker gets its own Postgres schema (`sim_w<N>`) holding those
tables plus the instruments slice. A pass is one `mode` string
(`opt_<runId>_<passId>`). Results are read back from `result` JSON with the
same fields the Paper Lab uses (`totalPnl`, `wingCapital`, flies…). Pass
rows are deleted once they're summarised into `pass_days`.

### Acceptance test (fidelity)
Replaying the Nutterfly with default params through the optimizer must
reproduce Strike Canopy's own `bt_nutter5` / `bt_nutter10` results
exactly: 2026-09-21 = −$518 / −$242, and the same event log.

### TestSpec (the only thing the UI or AI submits)
```jsonc
{
  "strategy": "nutterfly5",            // registry key -> preset + tick fn
  "dates": { "from": "2026-09-15", "to": "2026-09-23", "exclude": [] },
  "forward": { "split": "1/3" },       // or { "from": "2026-09-21" } / null
  "search": "genetic",                 // | "grid"
  "criterion": "totalPnl",             // | profitFactor | expectancy | maxDD | recovery | sharpe | completion | complex
  "params": {
    "stopMin":       { "start": 20, "step": 5, "stop": 90 },
    "waeFlipAbort":  { "values": [true, false] },
    "ivBandMaxPct":  { "start": 0.30, "step": 0.01, "stop": 0.40 }
  },
  "fixed": { "requireHotchSignal": true },
  "genetic": { "population": 64, "maxGenerations": 30, "seed": 1 }
}
```
Parameter names and bounds are checked against the strategy's registry
entry, which is derived from its `*Params` type and preset.

## Data window
The Well's archive lost sessions around the week of 2026-09-03. Every day
**from 2026-09-15 on** is complete. Earlier days lack the SPX 1-min bars the
Hotch and WAE gates need. The DayPack builder refuses a day whose manifest
is missing a required input rather than silently producing "no-entry".

Massive (in The Well) has about 2 years of trade-built options minute
bars. They have no quotes; since 2026-09-25 The Well models them
(`/api/chain-history` `source: "model"`: fair value from OTM trade IVs +
a parity forward, modeled spread), which is what generic strategies use
for every chain tasty never recorded.

## Generic strategies (2026-09-25)

Strike Canopy's strategies are all SPX/QQQ 0DTE; stocks mostly trade
weeklies, monthlies and 45 DTE. `src/generic/` interprets a **GenericSpec**
(JSON, zod-validated, `src/generic/spec.ts`) instead of replaying SC code:
- **legs** (1-8): call/put, long/short, qty, strike by `delta`, `pctOtm`,
  `offset`, `atm`, or `width` from an earlier leg -- verticals, condors,
  strangles, flies, short puts, ratios...
- **entry**: weekdays, time, `targetDte` (+ window; the closest expiration
  that was actually LISTED that day -- weeklies appear ~5 weeks out),
  `maxOpen`, filters (min credit / max debit, ATM IV band, trend vs SMA).
- **exit**: profit target / stop (% of entry credit/debit, judged on mid),
  `exitDte`, time of day, max hold; otherwise settled at intrinsic on
  expiration day's close.
- **costs**: `spreadMult` x the chain's spread (1 = real/modeled base;
  2-3 realistic for stocks), natural or mid fills, commission.
- **bucketSec**: exit resolution, default 30 min.
Results reuse `PassMetrics` (tradedDays = trades, completionRate = win
rate, wingCapital = summed max loss; ror null if any leg set is unbounded),
over a daily mark-to-market equity curve. Chains are cached per
(symbol, expiration, session) under `$OPT_DATA_DIR/generic/<SYM>/`.
Known simplifications: no early assignment, cash settlement, D=1 pricing.

## Phases
1. **Engine (CLI):** DayPack builder (after-hours guard), CachedWellClient,
   sim DB, a single-pass runner, and the fidelity acceptance test.
2. **Search:** a grid and genetic optimizer over a worker pool, the
   criteria, forward split, and the runs/passes/pass_days tables.
3. **UI:** the results table, 1-D/2-D/3-D graphs, genetic-progress view,
   and pass drill-in with a Paper Lab comparison.
4. **AI setup:** BYOK model picker, NL → TestSpec with zod validation, idle
   until done, then a results briefing.
5. **Strike Canopy tab:** the same engine behind an authenticated Strike
   Canopy tab for testers. Before any subscriber-facing exposure, check
   what licensing (OPRA-derived data) and compute quotas are needed.

## Ops rules
- Pulls from The Well are serial. (The 09:00–16:30 ET ban was retired
  2026-09-25 with the live DB's move to its own SSD.)
- Everything lives under `/mnt/data/optimizer` (never on the root `sdb`
  disk, which the live DB saturates).
- Strike Canopy code is consumed from a pinned local clone
  (`vendor/strike-canopy`, commit recorded in each run). This repo never
  edits it.
