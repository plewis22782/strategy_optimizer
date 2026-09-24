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
