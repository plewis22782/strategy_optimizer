// Strategies the optimizer can run: a preset (every input's default and type)
// plus the real Strike Canopy tick function. A TestSpec may only name
// strategies and params that appear here; the AI setup layer reads this
// registry, it cannot add to it.
import type pg from 'pg'
import type { Logger } from 'pino'
import { NUTTERFLY_10_DEFAULT, NUTTERFLY_5_DEFAULT, nutterflyTick, type NutterflyParams, type TickOpts } from '../sc.js'

export type ParamValue = number | boolean | string
export type ParamKind = 'number' | 'boolean' | 'string'

export interface StrategyDef {
  key: string
  label: string
  preset: Record<string, ParamValue>
  /** Inputs that must never be varied (identity/plumbing, not strategy logic). */
  locked: string[]
  /** DayPack checks a session must pass to be replayable for this strategy. */
  requireChecks: string[]
  tick(pool: pg.Pool, logger: Logger, params: Record<string, ParamValue>, atMs: number, opts: TickOpts): Promise<void>
}

const nutterfly = (key: string, label: string, preset: NutterflyParams): StrategyDef => ({
  key,
  label,
  preset: preset as unknown as Record<string, ParamValue>,
  locked: ['kind', 'symbol', 'dte'],
  requireChecks: ['spx_chain', 'spx_bars'],
  tick: (pool, logger, params, atMs, opts) =>
    nutterflyTick(pool, logger, params as unknown as NutterflyParams, atMs, opts)
})

export const STRATEGIES: Record<string, StrategyDef> = {
  nutterfly5: nutterfly('nutterfly5', 'Nutterfly $5 wings (SPXW 0DTE double butterfly)', NUTTERFLY_5_DEFAULT),
  nutterfly10: nutterfly('nutterfly10', 'Nutterfly $10 wings (SPXW 0DTE double butterfly)', NUTTERFLY_10_DEFAULT)
}

export function paramKind(def: StrategyDef, name: string): ParamKind | null {
  if (!(name in def.preset)) return null
  const v = def.preset[name]
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string'
}

/** preset <- overrides, with every override's name and type checked. */
export function resolveParams(def: StrategyDef, overrides: Record<string, unknown>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...def.preset }
  for (const [k, v] of Object.entries(overrides)) {
    const kind = paramKind(def, k)
    if (!kind) throw new Error(`${def.key}: unknown param "${k}"`)
    if (def.locked.includes(k)) throw new Error(`${def.key}: param "${k}" is locked`)
    if (typeof v !== kind) throw new Error(`${def.key}: param "${k}" must be a ${kind}, got ${typeof v}`)
    out[k] = v as ParamValue
  }
  return out
}
