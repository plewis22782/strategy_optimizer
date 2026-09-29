// DayPack: everything one ET session's strategy replay reads from The Well,
// pulled once (after hours) and stored gzip-JSON under OPT_DATA_DIR/<date>/.
// Immutable once written -- a re-pull writes a new manifest (pulledAt,
// sha) and replaces the files atomically (tmp + rename).
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import path from 'node:path'
import type { BarRow, BarsTable, ChainHistoryRow } from '../sc.js'

export const PACK_VERSION = 1

/** The exact getChainHistory call Strike Canopy's backtest makes for a
 *  session (backtest-cli.ts: ChainHistoryCache(readModel, 09:30, 16:06, 60)
 *  with its default 300s lookback). A CachedWellClient call with any other
 *  window is refused rather than answered approximately. */
export interface ChainKey {
  symbol: string
  expiration: string
  fromMs: number
  toMs: number
  bucketSec: number
  lookbackSec: number
}

export interface ChainPayload {
  key: ChainKey
  spot: Array<{ bucketMs: number; spot: number | null }>
  rows: ChainHistoryRow[]
}

export interface BarsPayload {
  table: BarsTable
  /** Set for a multi-symbol table (streamed_minute_bars); omitted for the
   *  single-symbol SPX tables (spx_minute_bars/es_implied_spx_minute/
   *  es_minute_bars), which need no disambiguation. */
  symbol?: string
  fromMs: number
  toMs: number
  rows: BarRow[]
}

export interface Manifest {
  version: number
  date: string
  pulledAt: string
  wellUrl: string
  strikeCanopyRef: string
  chains: Array<{ file: string; key: ChainKey; rows: number; buckets: number }>
  bars: Array<{ file: string; table: BarsTable; symbol?: string; fromMs: number; toMs: number; rows: number; rthRows: number }>
  /** Why this day is (not) usable for a given strategy family. */
  checks: Record<string, { ok: boolean; detail: string }>
  /** Fingerprint of the chains + bars (the core Well data). */
  sha256: string
  /** Inputs Strike Canopy computes itself (npm run strategy:backtest-data),
   *  attached after the pull by `opt import-sc`. Each has its own sha, so
   *  attaching one never changes the core fingerprint (and never throws away
   *  stored results of strategies that don't use it). */
  extras?: Array<{ kind: 'trend-state' | 'spot-raw'; symbol: string; expiration: string; file: string; sha256: string; points: number }>
}

export function packDir(root: string, date: string): string {
  return path.join(root, 'packs', date)
}

export function chainFile(k: ChainKey): string {
  return `chain_${k.symbol}_${k.expiration}_${k.bucketSec}s.json.gz`
}

export function barsFile(table: BarsTable, symbol?: string): string {
  return symbol ? `bars_${table}_${symbol}.json.gz` : `bars_${table}.json.gz`
}

async function writeAtomic(file: string, buf: Buffer): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, buf)
  await rename(tmp, file)
}

export async function writeJsonGz(file: string, obj: unknown): Promise<string> {
  const raw = Buffer.from(JSON.stringify(obj))
  await writeAtomic(file, gzipSync(raw, { level: 6 }))
  return createHash('sha256').update(raw).digest('hex')
}

export async function readJsonGz<T>(file: string): Promise<T> {
  return JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as T
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function readManifest(root: string, date: string): Promise<Manifest | null> {
  const f = path.join(packDir(root, date), 'manifest.json')
  try {
    await stat(f)
  } catch {
    return null
  }
  return JSON.parse(await readFile(f, 'utf8')) as Manifest
}

export async function writeManifest(root: string, m: Manifest): Promise<void> {
  const f = path.join(packDir(root, m.date), 'manifest.json')
  await writeAtomic(f, Buffer.from(JSON.stringify(m, null, 2)))
}
