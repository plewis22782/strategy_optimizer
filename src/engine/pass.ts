// One pass = one strategy + one param set replayed over a list of sessions,
// exactly the way Strike Canopy's backtest-cli.ts walks a day (09:30 ->
// 16:06 ET, 60 s steps, histAtMs = the step), but reading only DayPacks and
// writing only to this worker's sim schema.
import type pg from 'pg'
import type { Logger } from 'pino'
import { ChainHistoryCache, etWallToUtcMs } from '../sc.js'
import { CachedWellClient, type CacheStats } from '../well/cached-client.js'
import type { StandardResult } from '../sc.js'
import { requireChecks, type ParamValue, type StrategyRef } from '../strategies/registry.js'

export interface DayEvent {
  t: string // HH:MM ET
  kind: string
  structure: string | null
  cash: number | null
  detail: string
}

export interface DayResult {
  date: string
  outcome: string
  noEntry: boolean
  pnl: number | null
  result: Record<string, unknown> | null
  /** The strategy's own mapping of `result` to the uniform shape. */
  std: StandardResult
  events: DayEvent[]
  tickErrors: number
  firstError?: string
  cache: CacheStats
}

const BUCKET_SEC = 60

export async function runPassDay(
  pool: pg.Pool,
  logger: Logger,
  dataRoot: string,
  ref: StrategyRef,
  params: Record<string, ParamValue>,
  date: string,
  mode: string
): Promise<DayResult> {
  const client = new CachedWellClient(logger)
  await client.loadDay(dataRoot, date, requireChecks(ref.def))
  await pool.query(`DELETE FROM strategy_position WHERE mode = $1 AND session_date = $2`, [mode, date])

  const from = etWallToUtcMs(date, 9, 30)
  const to = etWallToUtcMs(date, 16, 6)
  const chainCache = new ChainHistoryCache(client, from, to, BUCKET_SEC)
  let tickErrors = 0
  let firstError: string | undefined
  for (let t = from; t <= to; t += BUCKET_SEC * 1000) {
    try {
      await ref.def.tick({ pool, logger, mode, readModel: client, chainCache, histAtMs: t }, params, t)
    } catch (err) {
      tickErrors++
      firstError ??= err instanceof Error ? err.message : String(err)
    }
  }

  const { rows } = await pool.query<{ id: number; result: Record<string, unknown> | null }>(
    `SELECT id, result FROM strategy_position WHERE mode = $1 AND session_date = $2 ORDER BY id DESC LIMIT 1`,
    [mode, date]
  )
  const pos = rows[0]
  let events: DayEvent[] = []
  if (pos) {
    const ev = await pool.query<DayEvent>(
      `SELECT to_char(sim_time AT TIME ZONE 'America/New_York', 'HH24:MI') AS t, kind, structure, cash,
              COALESCE(detail->>'detail', detail::text) AS detail
         FROM strategy_event WHERE position_id = $1 ORDER BY id`,
      [pos.id]
    )
    events = ev.rows
  }
  const r = pos?.result ?? null
  const std = ref.def.result(r)
  const outcome = pos ? std.outcome : '(no position row)'
  const pnl = std.pnl
  // scratch rows are summarised into pass_days by the caller; drop them now
  await pool.query(`DELETE FROM strategy_position WHERE mode = $1 AND session_date = $2`, [mode, date])
  return {
    date,
    outcome,
    noEntry: std.noEntry || !pos,
    pnl,
    result: r,
    std,
    events,
    tickErrors,
    firstError,
    cache: client.stats
  }
}
