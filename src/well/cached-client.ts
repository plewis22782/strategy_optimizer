// A WellClient that answers ONLY from loaded DayPacks -- no network, ever.
// Subclasses WellClient (its private fields make it nominal in TS) so the
// strategy code accepts it unchanged. Any call a pack can't answer exactly
// throws or is counted, so a coverage gap shows up loudly instead of
// becoming a silent "no-entry" (the failure mode that hid the pre-09-15 data
// loss inside Strike Canopy's own bt_* rows).
import type { Logger } from 'pino'
import path from 'node:path'
import { WellClient, type BarRow, type BarsTable, type ChainSnapshotRow } from '../sc.js'
import { packDir, readJsonGz, readManifest, type BarsPayload, type ChainPayload, type Manifest } from '../daypack/pack.js'

export interface CacheStats {
  chainHistoryHits: number
  snapshotDerived: number
  snapshotMisses: number
  barsCalls: number
}

export class CachedWellClient extends WellClient {
  private chains = new Map<string, ChainPayload>()
  private bars = new Map<BarsTable, BarsPayload[]>()
  readonly stats: CacheStats = { chainHistoryHits: 0, snapshotDerived: 0, snapshotMisses: 0, barsCalls: 0 }

  constructor(logger: Logger) {
    super('http://cached.invalid', 'none', logger)
  }

  /** Load one session's pack. Throws if it's missing or fails `requireChecks`. */
  async loadDay(root: string, date: string, requireChecks: string[] = []): Promise<Manifest> {
    const man = await readManifest(root, date)
    if (!man) throw new Error(`no DayPack for ${date} -- run: opt pull --dates ${date}`)
    for (const c of requireChecks) {
      const r = man.checks[c]
      if (!r?.ok) throw new Error(`DayPack ${date} fails check "${c}": ${r?.detail ?? 'missing'}`)
    }
    const dir = packDir(root, date)
    for (const c of man.chains) {
      const p = await readJsonGz<ChainPayload>(path.join(dir, c.file))
      this.chains.set(chainMapKey(p.key.symbol, p.key.expiration), p)
    }
    for (const b of man.bars) {
      const p = await readJsonGz<BarsPayload>(path.join(dir, b.file))
      const arr = this.bars.get(b.table) ?? []
      arr.push(p)
      this.bars.set(b.table, arr)
    }
    return man
  }

  override async getBars(table: BarsTable, fromMs: number, toMs: number, symbol?: string): Promise<BarRow[]> {
    if (symbol) throw new Error(`CachedWellClient.getBars: per-symbol bars (${symbol}) are not packed`)
    this.stats.barsCalls++
    const packs = this.bars.get(table) ?? []
    const covering = packs.find((p) => p.fromMs <= fromMs && p.toMs >= toMs)
    if (!covering) {
      throw new Error(
        `CachedWellClient.getBars: ${table} [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}] not covered by any loaded pack`
      )
    }
    return covering.rows.filter((r) => {
      const t = Date.parse(r.bucket)
      return t >= fromMs && t <= toMs
    })
  }

  override async getChainHistory(
    symbol: string,
    expiration: string,
    fromMs: number,
    toMs: number,
    bucketSec?: number,
    lookbackSec?: number
  ): Promise<{ spot: Array<{ bucketMs: number; spot: number | null }>; rows: ChainPayload['rows'] } | null> {
    const p = this.chains.get(chainMapKey(symbol, expiration))
    if (!p) throw new Error(`CachedWellClient.getChainHistory: ${symbol} ${expiration} not packed`)
    const k = p.key
    if (k.fromMs !== fromMs || k.toMs !== toMs || k.bucketSec !== (bucketSec ?? 60) || k.lookbackSec !== (lookbackSec ?? 300)) {
      throw new Error(
        `CachedWellClient.getChainHistory: ${symbol} ${expiration} requested window/bucket differs from the packed one`
      )
    }
    this.stats.chainHistoryHits++
    return { spot: p.spot, rows: p.rows }
  }

  /** Only reached when ChainHistoryCache has no row for a bucket. The live
   *  Well would run a point-in-time query; the closest faithful answer from a
   *  pack is the latest packed bucket at or before atMs, within lookback. */
  override async getChainSnapshot(
    symbol: string,
    expiration: string,
    atMs: number,
    lookbackSec?: number
  ): Promise<{ spot: number | null; rows: ChainSnapshotRow[] } | null> {
    const p = this.chains.get(chainMapKey(symbol, expiration))
    if (!p) {
      this.stats.snapshotMisses++
      return null
    }
    const lb = (lookbackSec ?? 180) * 1000
    let best = -Infinity
    for (const s of p.spot) if (s.bucketMs <= atMs && s.bucketMs >= atMs - lb && s.bucketMs > best) best = s.bucketMs
    if (!Number.isFinite(best)) {
      this.stats.snapshotMisses++
      return null
    }
    this.stats.snapshotDerived++
    const rows = p.rows.filter((r) => r.bucketMs === best) as unknown as ChainSnapshotRow[]
    return { spot: p.spot.find((s) => s.bucketMs === best)?.spot ?? null, rows }
  }

  override async getMany(): Promise<never> {
    throw new Error('CachedWellClient.getMany: live-only read-model call reached from a backtest path')
  }

  override async close(): Promise<void> {}
}

function chainMapKey(symbol: string, expiration: string): string {
  return `${symbol}|${expiration}`
}
