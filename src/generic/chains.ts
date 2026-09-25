// Data for generic strategies: per-(symbol, expiration, session) chains,
// the symbol's expiration list and its daily candles -- read from a disk
// cache under OPT_DATA_DIR/generic/<SYM>/, fetched from The Well only on a
// miss, ONE request at a time (the 2026-09-23 overload was 16 sweeps hitting
// it in parallel; the after-hours-only rule it prompted was retired
// 2026-09-25 once the live DB moved to its own SSD). A sweep's first pass
// fills the cache; every later pass that needs the same chains reads disk.
//
// Chains come from /api/chain-history with source=auto: real tasty quotes
// where the archive has the expiration, otherwise The Well's Massive-trade
// MODEL (fair value + modeled spread, source 'model'). Both are stored at
// spreadMult=1; the engine scales the spread itself (priceAt), so one pull
// serves every spread scenario.
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { ensureDir, readJsonGz, writeJsonGz } from '../daypack/pack.js'
import { etWallToUtcMs } from '../sc.js'

export interface ChainRow {
  bucketMs: number
  k: number
  cp: 'call' | 'put'
  mid: number | null
  bid: number | null
  ask: number | null
  delta: number | null
  gamma: number | null
  iv: number | null
}

export interface ChainPayload {
  symbol: string
  expiration: string
  date: string
  bucketSec: number
  source: string // 'raw' | 'archive' | 'model'
  spot: Array<{ bucketMs: number; spot: number | null }>
  rows: ChainRow[]
}

export interface DailyCandle {
  date: string
  close: number
}

/** One bucket of a chain, indexed for strike selection and marking. */
export interface ChainSlice {
  bucketMs: number
  spot: number | null
  byKey: Map<string, ChainRow> // `${k}|${cp}`
  strikes: number[] // sorted, strikes with a mid on either side
}

export const legKey = (k: number, cp: string) => `${k}|${cp}`

/** Indexed view of one session's chain for one expiration. */
export class SessionChain {
  readonly times: number[]
  private slices = new Map<number, ChainSlice>()
  constructor(readonly payload: ChainPayload) {
    const spotBy = new Map(payload.spot.map((s) => [s.bucketMs, s.spot]))
    for (const r of payload.rows) {
      let s = this.slices.get(r.bucketMs)
      if (!s) {
        s = { bucketMs: r.bucketMs, spot: spotBy.get(r.bucketMs) ?? null, byKey: new Map(), strikes: [] }
        this.slices.set(r.bucketMs, s)
      }
      s.byKey.set(legKey(r.k, r.cp), r)
    }
    for (const s of this.slices.values()) {
      s.strikes = [...new Set([...s.byKey.values()].filter((r) => r.mid != null).map((r) => r.k))].sort((a, b) => a - b)
    }
    this.times = [...this.slices.keys()].sort((a, b) => a - b)
  }

  /** Latest slice at or before t. */
  at(t: number): ChainSlice | null {
    let lo = 0
    let hi = this.times.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.times[mid] <= t) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return best >= 0 ? (this.slices.get(this.times[best]) ?? null) : null
  }

  /** Last spot of the session (settlement reference). */
  lastSpot(): number | null {
    for (let i = this.times.length - 1; i >= 0; i--) {
      const s = this.slices.get(this.times[i])?.spot
      if (s != null) return s
    }
    return null
  }
}

export interface ChainSourceStats {
  diskHits: number
  fetched: number
  bytesFetched: number
}

export class ChainSource {
  readonly stats: ChainSourceStats = { diskHits: 0, fetched: 0, bytesFetched: 0 }
  private mem = new Map<string, SessionChain>()
  private expCache = new Map<string, string[]>()
  private dailyCache = new Map<string, DailyCandle[]>()

  constructor(
    private readonly root: string,
    private readonly wellUrl: string,
    private readonly secret: string,
    private readonly opts: { memLimit?: number } = {}
  ) {}

  private dir(symbol: string): string {
    return path.join(this.root, 'generic', symbol)
  }

  private inflight: Promise<unknown> = Promise.resolve()

  /** Serialised: callers queue behind each other, so The Well sees one request at a time. */
  private fetchJson<T>(pathQs: string): Promise<T> {
    const run = this.inflight.then(() => this.fetchOnce<T>(pathQs))
    this.inflight = run.catch(() => undefined)
    return run
  }

  private async fetchOnce<T>(pathQs: string): Promise<T> {
    const res = await fetch(`${this.wellUrl}${pathQs}`, {
      headers: { 'x-well-api-secret': this.secret },
      signal: AbortSignal.timeout(180_000)
    })
    if (!res.ok) throw new Error(`generic: The Well ${res.status} for ${pathQs.split('?')[0]}: ${(await res.text()).slice(0, 200)}`)
    const text = await res.text()
    this.stats.fetched++
    this.stats.bytesFetched += text.length
    return JSON.parse(text) as T
  }

  /** Cached file younger than maxAgeMs (or any age when maxAgeMs is Infinity). */
  private async fresh(file: string, maxAgeMs: number): Promise<boolean> {
    try {
      const st = await stat(file)
      return Date.now() - st.mtimeMs < maxAgeMs
    } catch {
      return false
    }
  }

  /** Every expiration The Well can answer for (tasty + Massive), before `before`. */
  async expirations(symbol: string): Promise<string[]> {
    const hit = this.expCache.get(symbol)
    if (hit) return hit
    const file = path.join(this.dir(symbol), 'expirations.json.gz')
    // The Massive backfill is still adding history: refresh daily when allowed.
    let dates: string[]
    if (await this.fresh(file, 24 * 3600_000)) {
      dates = (await readJsonGz<{ dates: string[] }>(file)).dates
    } else {
      dates = (await this.fetchJson<{ dates: string[] }>(`/api/expirations?symbols=${encodeURIComponent(symbol)}&source=all&before=2100-01-01`)).dates
      await ensureDir(this.dir(symbol))
      await writeJsonGz(file, { dates })
    }
    this.expCache.set(symbol, dates)
    return dates
  }

  /** Daily closes (the session calendar + trend filters). */
  async daily(symbol: string, from: string, to: string): Promise<DailyCandle[]> {
    const key = `${symbol}|${from}|${to}`
    const hit = this.dailyCache.get(key)
    if (hit) return hit
    const file = path.join(this.dir(symbol), `daily_${from}_${to}.json.gz`)
    let out: DailyCandle[]
    if (await this.fresh(file, Infinity)) {
      out = await readJsonGz<DailyCandle[]>(file)
    } else {
      const fromMs = Date.parse(`${from}T00:00:00Z`)
      const toMs = Date.parse(`${to}T23:59:59Z`)
      const r = await this.fetchJson<{ candles: Array<{ t: string; close: number | null }> }>(
        `/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=1d&fromMs=${fromMs}&toMs=${toMs}`
      )
      out = r.candles.filter((c) => c.close != null).map((c) => ({ date: c.t.slice(0, 10), close: c.close as number }))
      await ensureDir(this.dir(symbol))
      // a range ending today or later can still grow: don't pin it forever
      if (to < new Date().toISOString().slice(0, 10)) await writeJsonGz(file, out)
    }
    this.dailyCache.set(key, out)
    return out
  }

  /** One session's chain for one expiration, 09:30-16:00 ET at bucketSec. */
  async chain(symbol: string, expiration: string, date: string, bucketSec: number): Promise<SessionChain> {
    const key = `${symbol}|${expiration}|${date}|${bucketSec}`
    const hit = this.mem.get(key)
    if (hit) return hit
    const file = path.join(this.dir(symbol), expiration, `${date}_${bucketSec}s.json.gz`)
    let payload: ChainPayload
    if (await this.fresh(file, Infinity)) {
      this.stats.diskHits++
      payload = await readJsonGz<ChainPayload>(file)
    } else {
      const fromMs = etWallToUtcMs(date, 9, 30)
      const toMs = etWallToUtcMs(date, 16, 0)
      const r = await this.fetchJson<{ spot: ChainPayload['spot']; rows: ChainRow[]; source?: string }>(
        `/api/chain-history?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&fromMs=${fromMs}&toMs=${toMs}` +
          `&bucketSec=${bucketSec}&lookbackSec=300&source=auto&spreadMult=1`
      )
      payload = { symbol, expiration, date, bucketSec, source: r.source ?? 'unknown', spot: r.spot, rows: r.rows }
      await ensureDir(path.dirname(file))
      await writeJsonGz(file, payload)
    }
    const sc = new SessionChain(payload)
    if (this.mem.size >= (this.opts.memLimit ?? 400)) this.mem.delete(this.mem.keys().next().value as string)
    this.mem.set(key, sc)
    return sc
  }
}
