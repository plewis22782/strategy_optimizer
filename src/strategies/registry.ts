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

/** What a DayPack can supply today, as the manifest check that proves it. */
const PACKED: Record<string, string> = {
  'chain-minute:SPX': 'spx_chain',
  'bars-1m:spx_minute_bars': 'spx_bars',
  'bars-1m:es_implied_spx_minute': '', // packed; no per-day check needed
  'bars-1m:es_minute_bars': '',
  'trend-state': 'trend_state', // attached by `opt import-sc` (Strike Canopy's getTrendState)
  'spot-raw': 'raw_spot' // attached by `opt import-sc` (Strike Canopy's rawSpotAt series)
}

function needKey(d: DataNeed, symbols: readonly string[]): string[] {
  switch (d.kind) {
    case 'chain-minute':
      return (d.symbol ? [d.symbol] : symbols).map((s) => `chain-minute:${s}`)
    case 'bars-1m':
      return [`bars-1m:${d.table}`]
    default:
      return [d.kind]
  }
}

/** Which symbol(s) this REF actually needs -- for a `fixed` footprint, all of
 *  them (a cross-symbol strategy like RIC genuinely needs both at once); for
 *  a `param` footprint, narrowed to this variant's own resolved value, not
 *  every symbol the footprint merely *allows*. Checking against the full
 *  `allowed` list regardless of variant made every `param`-footprint
 *  variant look unreplayable the moment ANY allowed symbol lacked a pack --
 *  e.g. adding SPY to nutterfly's `allowed` list would otherwise also mark
 *  the already-fully-packed SPX variants unreplayable. Doesn't (yet) handle
 *  a search that varies `symbol` itself across multiple values within one
 *  run -- same gap this had before, just no longer masked by the
 *  everything-required default. */
function footprintSymbols(ref: StrategyRef): readonly string[] {
  const fp = ref.def.footprint.symbols
  if (fp.kind === 'fixed') return fp.symbols
  if (fp.allowed === 'universe') return ['*universe*']
  const resolved = variantDefaults(ref)[fp.param]
  return typeof resolved === 'string' ? [resolved] : fp.allowed
}

/** The data a strategy needs that DayPacks don't carry yet ([] = replayable). */
export function missingData(ref: StrategyRef): string[] {
  const symbols = footprintSymbols(ref)
  const out = new Set<string>()
  for (const d of ref.def.footprint.data as readonly DataNeed[]) for (const k of needKey(d, symbols)) if (!(k in PACKED)) out.add(k)
  return [...out]
}

/** Can the optimizer replay this strategy exactly? If not, why. */
export function replayable(ref: StrategyRef): { ok: true } | { ok: false; why: string } {
  if (ref.def.backtest && ref.def.backtest.supported === false) return { ok: false, why: ref.def.backtest.why }
  const miss = missingData(ref)
  if (miss.length) return { ok: false, why: `DayPacks don't carry ${miss.join(', ')} yet` }
  return { ok: true }
}

/** DayPack checks a session must pass before this strategy may replay it,
 *  derived from the definition's declared data footprint. */
export function requireChecks(ref: StrategyRef): string[] {
  const symbols = footprintSymbols(ref)
  const out = new Set<string>()
  for (const d of ref.def.footprint.data as readonly DataNeed[]) {
    for (const k of needKey(d, symbols)) {
      const c = PACKED[k]
      if (c === undefined) out.add(`missing:${k}`) // fail closed -- no pack has it
      else if (c) out.add(c)
    }
  }
  return [...out]
}

/** The variant's starting params (its declared defaults), for the UI. */
export function variantDefaults(ref: StrategyRef): Record<string, ParamValue> {
  return variantParams(ref.def, ref.variant) as Record<string, ParamValue>
}
