// Which swept parameters actually moved the outcome: a one-way ANOVA / eta-
// squared (variance explained) per dimension, ranked. This is the "compute
// it, don't ask an LLM to eyeball it" step from the handoff -- the LLM only
// ever sees this ranking, never the raw passes.
import type { ParamValue } from '../strategies/registry.js'
import type { Dimension } from '../engine/space.js'
import { etaSquared, mean } from './stats.js'

export interface DimValueStat {
  value: ParamValue
  n: number
  meanCriterion: number
}

export interface DimSensitivity {
  name: string
  etaSquared: number | null // fraction of criterion variance this dim explains, 0..1
  byValue: DimValueStat[] // ascending, same order as the dimension's own value list
  bestValue: ParamValue | null // the value with the highest mean criterion
  /** For a numeric/time dim with >= 2 values: where the best value sits in the
   *  searched range -- an optimum pinned to an edge suggests the range should
   *  be widened; null for boolean/choice dims (no "edge" concept). */
  bestValueEdge: 'low' | 'high' | 'interior' | null
}

interface PassLike {
  varied: Record<string, ParamValue>
  criterion: number | null
}

const label = (v: ParamValue): string => (typeof v === 'boolean' ? String(v) : JSON.stringify(v))

export function computeSensitivity(dims: Dimension[], backPasses: PassLike[]): DimSensitivity[] {
  const out: DimSensitivity[] = []
  for (const dim of dims) {
    const rows = backPasses.filter((p) => p.criterion != null && Number.isFinite(p.criterion) && dim.name in p.varied)
    const eta = etaSquared(
      rows,
      (r) => label(r.varied[dim.name]),
      (r) => r.criterion as number
    )
    const byValue: DimValueStat[] = dim.values.map((value) => {
      const ys = rows.filter((r) => label(r.varied[dim.name]) === label(value)).map((r) => r.criterion as number)
      return { value, n: ys.length, meanCriterion: ys.length ? mean(ys) : NaN }
    })
    const scored = byValue.filter((v) => v.n > 0)
    let bestValue: ParamValue | null = null
    let bestValueEdge: DimSensitivity['bestValueEdge'] = null
    if (scored.length) {
      const best = scored.reduce((a, b) => (b.meanCriterion > a.meanCriterion ? b : a))
      bestValue = best.value
      const numericOrdered = typeof dim.values[0] === 'number' && dim.values.length >= 2
      if (numericOrdered) {
        const bestLabel = label(best.value)
        const idx = dim.values.findIndex((v) => label(v) === bestLabel)
        bestValueEdge = idx === 0 ? 'low' : idx === dim.values.length - 1 ? 'high' : 'interior'
      }
    }
    out.push({ name: dim.name, etaSquared: eta, byValue, bestValue, bestValueEdge })
  }
  out.sort((a, b) => (b.etaSquared ?? -1) - (a.etaSquared ?? -1))
  return out
}
