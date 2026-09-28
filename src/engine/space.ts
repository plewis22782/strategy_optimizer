// A test spec's parameter space: for every declared input either a fixed
// value or the list of values the search may pick from, built from the
// MT5-style start/step/stop the user set (validated against the strategy's
// own declaration -- hard limits, kinds, never-tuned roles).
import { z } from 'zod'
import { TUNABLE_ROLES, paramsZod, variantParams, type ParamSpec } from '../sc.js'
import { resolveParams, type ParamValue, type StrategyRef } from '../strategies/registry.js'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** One input's setting in a test. Omitted inputs keep the variant default. */
export const InputSetting = z.union([
  z.object({ optimize: z.literal(false), value: z.union([z.number(), z.boolean(), z.string()]) }),
  z.object({ optimize: z.literal(true), start: z.number(), step: z.number().positive(), stop: z.number(), withOff: z.boolean().optional() }),
  z.object({ optimize: z.literal(true), from: z.string().regex(HHMM), to: z.string().regex(HHMM), stepMin: z.number().int().positive() }),
  z.object({ optimize: z.literal(true), values: z.array(z.union([z.number(), z.boolean(), z.string()])).min(1) })
])
export type InputSetting = z.infer<typeof InputSetting>

export const TestSpec = z.object({
  strategy: z.string(), // "<definition>/<variant>"
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Hold back the last 1/n of the sessions (0 = no forward test), or a date. */
  forward: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  search: z.enum(['grid', 'genetic']),
  /** Pass budget for the back test. Genetic: stop once this many passes have
   *  run (the last generation is trimmed to fit). Grid: when the grid is
   *  bigger, test a seeded random sample of this many combinations. Passes
   *  answered from stored results don't count. Omitted = no cap. */
  maxPasses: z.number().int().min(1).max(200_000).optional(),
  criterion: z.enum(['totalPnl', 'profitFactor', 'expectancy', 'maxDrawdown', 'recoveryFactor', 'sharpe', 'completionRate', 'complex']),
  inputs: z.record(InputSetting),
  /** Re-run every pass with costs x2 as well (cost-role inputs). */
  costStress: z.boolean().default(false),
  threads: z.number().int().min(1).max(72),
  genetic: z
    .object({
      population: z.number().int().min(8).max(512).default(64),
      maxGenerations: z.number().int().min(1).max(500).default(40),
      /** Stop after this many generations without a better best pass. */
      stallGenerations: z.number().int().min(1).max(100).default(8),
      mutationRate: z.number().min(0).max(1).optional(),
      seed: z.number().int().default(1)
    })
    .default({}),
  note: z.string().max(500).optional()
})
export type TestSpec = z.infer<typeof TestSpec>

export interface Dimension {
  name: string
  values: ParamValue[]
}

export interface Space {
  base: Record<string, ParamValue> // variant defaults + fixed overrides
  dims: Dimension[] // optimized inputs, each with >= 1 values
  combinations: number
}

const round = (x: number, step: number) => {
  const dp = Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 2))
  return Number(x.toFixed(dp))
}
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export function buildSpace(ref: StrategyRef, spec: TestSpec): Space {
  const specs = ref.def.params as Record<string, ParamSpec>
  const fixed: Record<string, unknown> = {}
  const dims: Dimension[] = []
  for (const [name, setting] of Object.entries(spec.inputs)) {
    const ps = specs[name]
    if (!ps) throw new Error(`unknown input "${name}"`)
    if (!setting.optimize) {
      fixed[name] = setting.value
      continue
    }
    if (!TUNABLE_ROLES.includes(ps.role)) throw new Error(`${name}: role "${ps.role}" is never optimized`)
    let values: ParamValue[]
    if ('values' in setting) {
      values = setting.values
    } else if ('from' in setting) {
      if (ps.kind !== 'time') throw new Error(`${name}: a time window only fits a time input`)
      const a = toMin(setting.from)
      const b = toMin(setting.to)
      if (b < a) throw new Error(`${name}: window ends before it starts`)
      values = []
      for (let m = a; m <= b; m += setting.stepMin) values.push(toHHMM(m))
    } else {
      if (ps.kind !== 'number') throw new Error(`${name}: start/step/stop only fits a number input`)
      if (setting.stop < setting.start) throw new Error(`${name}: stop is below start`)
      const n = Math.floor((setting.stop - setting.start) / setting.step + 1e-9) + 1
      if (n > 10_000) throw new Error(`${name}: ${n} values -- widen the step`)
      values = []
      for (let i = 0; i < n; i++) {
        const v = round(setting.start + i * setting.step, setting.step)
        values.push(ps.int ? Math.round(v) : v)
      }
      if (setting.withOff) {
        if (ps.off == null) throw new Error(`${name}: has no "off" value`)
        if (!values.includes(ps.off)) values.unshift(ps.off)
      }
    }
    values = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()]
    // every value must be individually valid for this input's kind + hard limits
    const zSingle = paramsZod(ref.def)
    for (const v of values) {
      const probe = { ...resolveParamsLoose(ref, fixed), [name]: v }
      const r = zSingle.safeParse(probe)
      const own = r.success ? [] : r.error.issues.filter((i) => i.path[0] === name)
      if (own.length) throw new Error(`${name}=${JSON.stringify(v)}: ${own[0].message}`)
    }
    dims.push({ name, values })
  }
  const base = resolveParams(ref, fixed)
  const combinations = dims.reduce((a, d) => a * d.values.length, 1)
  return { base, dims, combinations }
}

/** Variant defaults + overrides WITHOUT the constraint check (used to probe
 *  one value at a time; constraints are enforced per full candidate). */
function resolveParamsLoose(ref: StrategyRef, overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...variantParams(ref.def, ref.variant), ...overrides }
}

/** Full params for one point in the space (genome = index per dim), or null
 *  when it breaks a cross-input constraint. */
export function paramsAt(ref: StrategyRef, space: Space, genome: number[]): Record<string, ParamValue> | null {
  const p: Record<string, ParamValue> = { ...space.base }
  space.dims.forEach((d, i) => (p[d.name] = d.values[genome[i]]))
  return paramsZod(ref.def).safeParse(p).success ? p : null
}

export function genomeKey(genome: number[]): string {
  return genome.join(',')
}

export function variedOf(space: Space, genome: number[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  space.dims.forEach((d, i) => (out[d.name] = d.values[genome[i]]))
  return out
}
