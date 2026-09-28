// The optimizer's own Postgres. Two roles:
//  - sim_w<N> schemas: per-worker scratch copies of Strike Canopy's strategy_*
//    tables, where the unmodified tick functions persist their state machines.
//    UNLOGGED (no WAL): it's scratch, rebuilt on demand.
//  - public: runs / passes / pass_days, the durable results.
// Never points at tasty-market-db.
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { SC_SCHEMA_SQL } from '../sc.js'

const SIM_TABLES = ['strategy', 'strategy_position', 'strategy_leg', 'strategy_event']

/** Strike Canopy's DDL for the strategy_* tables, taken from its schema.sql
 *  at the pinned commit so the sim schema can never drift from what the
 *  tick functions expect. */
export async function strategyDdl(): Promise<string[]> {
  const sql = (await readFile(SC_SCHEMA_SQL, 'utf8')).replace(/--[^\n]*/g, '')
  const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean)
  const target = new RegExp(`^(CREATE|ALTER)\\b[\\s\\S]*?\\b(?:TABLE|ON)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+|ONLY\\s+)?(${SIM_TABLES.join('|')})\\b`, 'i')
  const out: string[] = []
  for (const s of stmts) {
    const m = s.match(target)
    if (!m) continue
    out.push(s.replace(/^CREATE TABLE/i, 'CREATE UNLOGGED TABLE'))
  }
  if (out.filter((s) => /CREATE UNLOGGED TABLE/i.test(s)).length !== SIM_TABLES.length) {
    throw new Error(`sim DDL: expected ${SIM_TABLES.length} strategy tables in Strike Canopy schema.sql, found ${out.length} statements`)
  }
  return out
}

/** Empty stand-ins for the bar tables the tick code falls back to when a
 *  (cached) read returns no rows -- the same "no rows" answer the real
 *  fallback gets for a range The Well has nothing for. */
const FALLBACK_DDL = [
  `CREATE UNLOGGED TABLE IF NOT EXISTS spx_minute_bars (bucket timestamptz, open float8, high float8, low float8, close float8, ticks int)`,
  `CREATE UNLOGGED TABLE IF NOT EXISTS es_implied_spx_minute (bucket timestamptz, open float8, high float8, low float8, close float8)`
]

export async function ensureSimSchema(admin: pg.Pool, schema: string): Promise<void> {
  if (!/^sim_w\d{1,3}$/.test(schema)) throw new Error(`bad sim schema name ${schema}`)
  const c = await admin.connect()
  try {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await c.query(`SET search_path = ${schema}`)
    for (const s of await strategyDdl()) await c.query(s)
    for (const s of FALLBACK_DDL) await c.query(s)
  } finally {
    c.release()
  }
}

/** A pool whose every connection is pinned to one sim schema. */
export function simPool(databaseUrl: string, schema: string, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` })
}

export async function ensureResultsSchema(admin: pg.Pool): Promise<void> {
  await admin.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id          BIGSERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|error|cancelled
      spec        JSONB NOT NULL,                   -- the validated TestSpec
      sc_ref      TEXT NOT NULL,                    -- pinned Strike Canopy commit
      note        TEXT,
      error       TEXT
    );
    CREATE TABLE IF NOT EXISTS passes (
      id          BIGSERIAL PRIMARY KEY,
      run_id      BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      phase       TEXT NOT NULL DEFAULT 'back',     -- back|forward
      generation  INTEGER,                          -- genetic generation (null = grid)
      params      JSONB NOT NULL,                   -- the full param set (preset + overrides)
      varied      JSONB NOT NULL,                   -- just the optimized inputs
      metrics     JSONB,                            -- see engine/metrics.ts
      criterion   DOUBLE PRECISION,                 -- value of the run's criterion
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_passes_run ON passes (run_id, phase, criterion DESC);
    -- 2026-09-28: search engine + UI
    ALTER TABLE runs   ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
    ALTER TABLE runs   ADD COLUMN IF NOT EXISTS progress JSONB;      -- phase/generation/evaluated/best, updated live
    ALTER TABLE runs   ADD COLUMN IF NOT EXISTS sessions JSONB;      -- {back:[], forward:[], skipped:[{date,why}]}
    ALTER TABLE runs   ADD COLUMN IF NOT EXISTS space JSONB;         -- {dims:[{name,values}], combinations}
    ALTER TABLE passes ADD COLUMN IF NOT EXISTS genome TEXT;         -- value index per optimized input
    ALTER TABLE passes ADD COLUMN IF NOT EXISTS back_pass_id BIGINT; -- forward pass -> its back-test pass
    ALTER TABLE passes ADD COLUMN IF NOT EXISTS stress JSONB;        -- metrics with costs x2 (costStress runs)
    ALTER TABLE passes ADD COLUMN IF NOT EXISTS ms INTEGER;          -- wall time of the pass
    CREATE INDEX IF NOT EXISTS idx_passes_run_gen ON passes (run_id, phase, id);
    -- 2026-09-28: AI analysis of a completed run (on-demand, see src/analysis)
    ALTER TABLE runs   ADD COLUMN IF NOT EXISTS analysis JSONB;      -- {computedAt, model, summary, narrative}
    -- Permanent per-session backtest results, shared by EVERY run: a result
    -- is computed once and reused forever (the user's rule: never spend
    -- compute repeating a test). Key = strategy id + definition version +
    -- canonical params + session date + the DayPack's data fingerprint, so it
    -- changes only when the strategy's behaviour (version bump) or the data
    -- does. Rows with tick errors are never stored.
    CREATE TABLE IF NOT EXISTS day_results (
      key          TEXT PRIMARY KEY,           -- sha256 of the parts below
      strategy_id  TEXT NOT NULL,
      version      INTEGER NOT NULL,
      date         DATE NOT NULL,
      params       JSONB NOT NULL,
      pack_sha     TEXT NOT NULL,
      sc_ref       TEXT NOT NULL,              -- audit: the Strike Canopy code that produced it
      outcome      TEXT,
      no_entry     BOOLEAN NOT NULL,
      pnl          DOUBLE PRECISION,
      result       JSONB,
      std          JSONB NOT NULL,
      ms           INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_day_results_strat ON day_results (strategy_id, version, date);
    CREATE TABLE IF NOT EXISTS pass_days (
      pass_id     BIGINT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
      date        DATE NOT NULL,
      outcome     TEXT,
      pnl         DOUBLE PRECISION,
      result      JSONB,
      events      JSONB,
      PRIMARY KEY (pass_id, date)
    );
  `)
}
