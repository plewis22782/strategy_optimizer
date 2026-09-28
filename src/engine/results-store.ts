// The permanent result store (table day_results, optimizer DB on Redfish).
// Every (strategy version, params, session, data) combination is computed
// once, ever; later runs read it back instead of spending compute again.
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { readManifest } from '../daypack/pack.js'
import type { ParamValue, StrategyRef } from '../strategies/registry.js'
import type { DayResult } from './pass.js'

/** JSON with sorted keys, so the same params always hash the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export class ResultsStore {
  private packSha = new Map<string, string>()
  hits = 0
  misses = 0

  constructor(
    private readonly db: pg.Pool,
    private readonly dataRoot: string,
    private readonly scRef: string
  ) {}

  private async shaFor(date: string): Promise<string> {
    let s = this.packSha.get(date)
    if (!s) {
      const m = await readManifest(this.dataRoot, date)
      if (!m) throw new Error(`no DayPack for ${date}`)
      s = m.sha256
      this.packSha.set(date, s)
    }
    return s
  }

  async keyFor(ref: StrategyRef, params: Record<string, ParamValue>, date: string): Promise<string> {
    const parts = [ref.def.id, String(ref.def.version), canonical(params), date, await this.shaFor(date)]
    return createHash('sha256').update(parts.join('\u0000')).digest('hex')
  }

  async get(key: string): Promise<DayResult | null> {
    const { rows } = await this.db.query<{
      date: string
      outcome: string | null
      no_entry: boolean
      pnl: number | null
      result: Record<string, unknown> | null
      std: DayResult['std']
    }>(`SELECT date::text AS date, outcome, no_entry, pnl, result, std FROM day_results WHERE key = $1`, [key])
    const r = rows[0]
    if (!r) {
      this.misses++
      return null
    }
    this.hits++
    return {
      date: r.date,
      outcome: r.outcome ?? '',
      noEntry: r.no_entry,
      pnl: r.pnl,
      result: r.result,
      std: r.std,
      events: [],
      tickErrors: 0,
      cache: { chainHistoryHits: 0, snapshotDerived: 0, snapshotMisses: 0, barsCalls: 0 }
    }
  }

  async put(key: string, ref: StrategyRef, params: Record<string, ParamValue>, d: DayResult, ms: number): Promise<void> {
    if (d.tickErrors > 0) return // never persist a result that hit errors
    await this.db.query(
      `INSERT INTO day_results (key, strategy_id, version, date, params, pack_sha, sc_ref, outcome, no_entry, pnl, result, std, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (key) DO NOTHING`,
      [key, ref.def.id, ref.def.version, d.date, JSON.stringify(params), await this.shaFor(d.date), this.scRef,
       d.outcome, d.noEntry, d.pnl, JSON.stringify(d.result), JSON.stringify(d.std), ms]
    )
  }
}
