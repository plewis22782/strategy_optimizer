// Pull one session's DayPack from The Well. After hours only: on 2026-09-23 a
// backtest sweep hitting The Well during RTH timed out its chain-history
// calls and drove the shared DB to ~260-1700% CPU. The guard is the point of
// this file as much as the pull is.
import type { Logger } from 'pino'
import { etWallToUtcMs, WellClient, type BarsTable } from '../sc.js'
import {
  PACK_VERSION,
  barsFile,
  chainFile,
  ensureDir,
  packDir,
  writeJsonGz,
  writeManifest,
  type ChainKey,
  type Manifest
} from './pack.js'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Mirrors backtest-cli.ts: walk 09:30 -> 16:06 ET, 60 s buckets, and
 *  ChainHistoryCache's default 300 s lookback. */
export function sessionChainKey(symbol: string, date: string): ChainKey {
  return {
    symbol,
    expiration: date,
    fromMs: etWallToUtcMs(date, 9, 30),
    toMs: etWallToUtcMs(date, 16, 6),
    bucketSec: 60,
    lookbackSec: 300
  }
}

/** hotch-signal.ts spxBarsWideContinuous(date, asOf, warmupDays=4): reads
 *  spx_minute_bars + es_implied_spx_minute from session-open minus 4 days up
 *  to asOf (<= 16:06). The pack stores exactly that span. */
export const WARMUP_DAYS = 4
export function sessionBarsSpan(date: string): { fromMs: number; toMs: number } {
  const open = etWallToUtcMs(date, 9, 30)
  return { fromMs: open - WARMUP_DAYS * 86_400_000, toMs: etWallToUtcMs(date, 16, 6) }
}
// es_minute_bars isn't read by the Nutterfly path but, like spx_minute_bars, it's a
// continuous aggregate over raw ticks The Well keeps only ~7 days -- packing it
// is the only way that history survives.
export const PACK_BAR_TABLES: BarsTable[] = ['spx_minute_bars', 'es_implied_spx_minute', 'es_minute_bars']

export function inRthWindow(nowMs = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(nowMs))
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false
  const m = Number(p.hour) * 60 + Number(p.minute)
  return m >= 9 * 60 && m <= 16 * 60 + 30
}

async function retry<T>(what: string, logger: Logger, fn: () => Promise<T | null>, ok: (v: T) => boolean): Promise<T> {
  let wait = 5_000
  for (let attempt = 1; attempt <= 5; attempt++) {
    const v = await fn()
    if (v != null && ok(v)) return v
    logger.warn({ what, attempt }, 'daypack: empty/failed response, retrying')
    await new Promise((r) => setTimeout(r, wait))
    wait *= 2
  }
  throw new Error(`daypack: ${what} failed after 5 attempts`)
}

export async function pullDay(
  well: WellClient,
  root: string,
  date: string,
  strikeCanopyRef: string,
  wellUrl: string,
  logger: Logger,
  opts: { force?: boolean } = {}
): Promise<Manifest> {
  if (!opts.force && inRthWindow()) {
    throw new Error('daypack: refusing to pull between 09:00 and 16:30 ET on a weekday (use --force only if The Well is idle)')
  }
  const dir = packDir(root, date)
  await ensureDir(dir)
  const hash = createHash('sha256')
  const man: Manifest = {
    version: PACK_VERSION,
    date,
    pulledAt: new Date().toISOString(),
    wellUrl,
    strikeCanopyRef,
    chains: [],
    bars: [],
    checks: {},
    sha256: ''
  }

  // --- 0DTE SPX chain history (the Nutterfly / fly / pcs / meic family)
  const key = sessionChainKey('SPX', date)
  const hist = await retry(
    `chain-history SPX ${date}`,
    logger,
    () => well.getChainHistory(key.symbol, key.expiration, key.fromMs, key.toMs, key.bucketSec, key.lookbackSec),
    (h) => h.rows.length > 0
  )
  const cfile = chainFile(key)
  hash.update(await writeJsonGz(path.join(dir, cfile), { key, spot: hist.spot, rows: hist.rows }))
  const buckets = new Set(hist.rows.map((r) => r.bucketMs)).size
  man.chains.push({ file: cfile, key, rows: hist.rows.length, buckets })
  man.checks.spx_chain = { ok: buckets >= 380, detail: `${buckets} of ~397 minute buckets quoted` }

  // --- SPX 1-min bars + /ES-implied fill, with the WAE warm-up span
  const span = sessionBarsSpan(date)
  const rthFrom = etWallToUtcMs(date, 9, 30)
  const rthTo = etWallToUtcMs(date, 16, 0)
  for (const table of PACK_BAR_TABLES) {
    // getBars returns [] on failure AND on a genuinely empty range; retry a
    // few times, then accept [] (es_implied has no rows before its backfill).
    let rows = await well.getBars(table, span.fromMs, span.toMs)
    for (let i = 0; i < 2 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5_000))
      rows = await well.getBars(table, span.fromMs, span.toMs)
    }
    const bfile = barsFile(table)
    hash.update(await writeJsonGz(path.join(dir, bfile), { table, fromMs: span.fromMs, toMs: span.toMs, rows }))
    const rthRows = rows.filter((r) => {
      const t = Date.parse(r.bucket)
      return t >= rthFrom && t < rthTo && (table === 'es_implied_spx_minute' || r.ticks >= 2)
    }).length
    man.bars.push({ file: bfile, table, fromMs: span.fromMs, toMs: span.toMs, rows: rows.length, rthRows })
  }
  const spxRth = man.bars.find((b) => b.table === 'spx_minute_bars')?.rthRows ?? 0
  man.checks.spx_bars = {
    ok: spxRth >= 370,
    detail: `${spxRth} of 390 RTH SPX 1-min bars (Hotch fractal / WAE / spike detection need them)`
  }

  man.sha256 = hash.digest('hex')
  await writeManifest(root, man)
  return man
}
