// Attach Strike Canopy-computed inputs to cached sessions (`opt import-sc`)
// and serve them to ticks through the BacktestData hook.
import { readdir, readFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import type { BacktestData } from '../sc.js'
import { packDir, readManifest, writeManifest, type Manifest } from './pack.js'
import { readPackFile } from '../well/cached-client.js'

/** A full session's trend state has ~414 minute points (pre-open + RTH);
 *  a day the recorder or the Options Map was short on data has fewer. */
const TREND_MIN_POINTS = 380

interface TrendFile {
  kind: 'trend-state'
  symbol: string
  expiration: string
  date: string
  series: unknown[]
}

export async function importScData(root: string, srcDir: string): Promise<string[]> {
  const log: string[] = []
  for (const date of (await readdir(srcDir)).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const man = await readManifest(root, date)
    if (!man) {
      log.push(`${date}: no DayPack yet -- pull it first, then import again`)
      continue
    }
    for (const f of (await readdir(path.join(srcDir, date))).sort()) {
      const m = f.match(/^trendstate_([A-Z0-9.]+)_(\d{4}-\d{2}-\d{2})\.json\.gz$/)
      if (!m) continue
      const src = path.join(srcDir, date, f)
      const buf = await readFile(src)
      const body = JSON.parse(gunzipSync(buf).toString('utf8')) as TrendFile
      if (body.kind !== 'trend-state' || body.date !== date || !Array.isArray(body.series)) {
        log.push(`${date}: ${f} is not a trend-state export for this session -- skipped`)
        continue
      }
      const dest = `sc_${f}`
      await copyFile(src, path.join(packDir(root, date), dest))
      const extra = {
        kind: 'trend-state' as const,
        symbol: body.symbol,
        expiration: body.expiration,
        file: dest,
        sha256: createHash('sha256').update(buf).digest('hex'),
        points: body.series.length
      }
      man.extras = [...(man.extras ?? []).filter((e) => !(e.kind === extra.kind && e.symbol === extra.symbol && e.expiration === extra.expiration)), extra]
      const spx = man.extras.find((e) => e.kind === 'trend-state' && e.symbol === 'SPX' && e.expiration === date)
      man.checks.trend_state = spx
        ? { ok: spx.points >= TREND_MIN_POINTS, detail: `${spx.points} trend-state points (full session ~414)` }
        : { ok: false, detail: 'no SPX 0DTE trend state for this session' }
      log.push(`${date}: ${body.symbol} ${body.expiration} trend state, ${extra.points} points${extra.points < TREND_MIN_POINTS ? ' (PARTIAL -- session fails trend_state)' : ''}`)
    }
    await writeManifest(root, man)
  }
  return log
}

/** Fingerprint of the extras a strategy actually reads (sorted), '' if none. */
export function extrasSha(man: Manifest, kinds: readonly string[]): string {
  return (man.extras ?? [])
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${e.kind}:${e.symbol}:${e.expiration}:${e.sha256}`)
    .sort()
    .join('|')
}

/** BacktestData served from one session's cached extras. */
export async function backtestDataFor(root: string, date: string): Promise<BacktestData> {
  const man = await readManifest(root, date)
  return {
    trendSeries: async ({ symbol, expiration }) => {
      const e = man?.extras?.find((x) => x.kind === 'trend-state' && x.symbol === symbol && x.expiration === expiration)
      if (!e) return null
      const body = await readPackFile<TrendFile>(path.join(packDir(root, date), e.file))
      return body.series as never
    }
  }
}
