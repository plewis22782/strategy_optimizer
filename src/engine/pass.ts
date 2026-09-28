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
import { backtestDataFor } from '../daypack/extras.js'

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
  await client.loadDay(dataRoot, date, requireChecks(ref, params))
  await pool.query(`DELETE FROM strategy_position WHERE mode = $1 AND session_date = $2`, [mode, date])

  const from = etWallToUtcMs(date, 9, 30)
  const to = etWallToUtcMs(date, 16, 6)
  const chainCache = new ChainHistoryCache(client, from, to, BUCKET_SEC)
  const hist = await backtestDataFor(dataRoot, date)
  let tickErrors = 0
  let firstError: string | undefined
  for (let t = from; t <= to; t += BUCKET_SEC * 1000) {
    try {
      await ref.def.tick({ pool, logger, mode, readModel: client, chainCache, histAtMs: t, hist }, params, t)
    } catch (err) {
      tickErrors++
      firstError ??= err instanceof Error ? err.message : String(err)
    }
  }

  // A session can hold several positions (Exhaustion opens one per condor):
  // the day's result is all of them together.
  const { rows: positions } = await pool.query<{ id: number; result: Record<string, unknown> | null }>(
    `SELECT id, result FROM strategy_position WHERE mode = $1 AND session_date = $2 ORDER BY id`,
    [mode, date]
  )
  let events: DayEvent[] = []
  if (positions.length) {
    const ev = await pool.query<DayEvent>(
      `SELECT to_char(sim_time AT TIME ZONE 'America/New_York', 'HH24:MI') AS t, kind, structure, cash,
              COALESCE(detail->>'detail', detail::text) AS detail
         FROM strategy_event WHERE position_id = ANY($1) ORDER BY position_id, id`,
      [positions.map((p) => p.id)]
    )
    events = ev.rows
  }
  const pos = positions[positions.length - 1]
  const stds = positions.map((p) => ref.def.result(p.result))
  const std: StandardResult =
    stds.length <= 1
      ? ref.def.result(pos?.result ?? null)
      : {
          outcome: stds.map((s) => s.outcome).join(' | '),
          noEntry: stds.every((s) => s.noEntry),
          pnl: stds.some((s) => s.pnl != null) ? stds.reduce((a, s) => a + (s.pnl ?? 0), 0) : null,
          basis: stds.some((s) => s.basis != null) ? stds.reduce((a, s) => a + (s.basis ?? 0), 0) : null,
          trades: stds.reduce((a, s) => a + s.trades, 0)
        }
  const r = positions.length <= 1 ? (pos?.result ?? null) : { positions: positions.map((p) => p.result), totalPnl: std.pnl }
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
