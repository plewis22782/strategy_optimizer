// The optimizer's view of Strike Canopy's Paper Lab registry. A strategy is
// addressed as "<definition id>/<variant>" (e.g. "nutterfly/w5"); the
// variant only supplies the starting params -- every declared input can
// still be overridden or searched.
import { STRATEGY_REGISTRY, paramsZod, variantParams, type DataNeed, type StrategyDefinition } from '../sc.js'

export type ParamValue = number | boolean | string | unknown[]

export interface StrategyRef {
  key: string
  def: StrategyDefinition<any>
  variant: string
  mode: string
  label: string
}

export function listStrategies(): StrategyRef[] {
  return STRATEGY_REGISTRY.flatMap((def) =>
    Object.entries(def.variants).map(([variant, v]) => ({ key: `${def.id}/${variant}`, def, variant, mode: v.mode, label: v.label }))
  )
}

export function getStrategy(key: string): StrategyRef {
  const ref = listStrategies().find((s) => s.key === key)
  if (!ref) throw new Error(`unknown strategy "${key}" -- one of ${listStrategies().map((s) => s.key).join(', ')}`)
  return ref
}

export function strategyForMode(mode: string): StrategyRef | null {
  return listStrategies().find((s) => s.mode === mode) ?? null
}

/** Variant defaults <- overrides, validated against the definition (kinds,
 *  hard limits, cross-param constraints, no unknown keys). */
export function resolveParams(ref: StrategyRef, overrides: Record<string, unknown>): Record<string, ParamValue> {
  const merged = { ...variantParams(ref.def, ref.variant), ...overrides }
  const r = paramsZod(ref.def).safeParse(merged)
  if (!r.success) throw new Error(`${ref.key}: ${r.error.issues.map((i) => `${i.path.join('.') || '(params)'} ${i.message}`).join('; ')}`)
  return r.data as Record<string, ParamValue>
}

/** DayPack checks a session must pass before this strategy may replay it,
 *  derived from the definition's declared data footprint. */
export function requireChecks(def: StrategyDefinition<any>): string[] {
  const out = new Set<string>()
  for (const d of def.footprint.data as readonly DataNeed[]) {
    if (d.kind === 'chain-minute') out.add('spx_chain')
    if (d.kind === 'bars-1m' && d.table === 'spx_minute_bars') out.add('spx_bars')
  }
  return [...out]
}
