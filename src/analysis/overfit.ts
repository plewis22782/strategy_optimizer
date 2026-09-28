// Three overfitting signals, cheapest first (per the handoff):
//  1. back vs forward criterion gap on the held-out sessions (already computed
//     by the run's own forward test -- just read it).
//  2. neighbor stability: does the best genome sit on a broad plateau or a
//     narrow spike in the search grid?
//  3. how many combinations were tried against how few sessions (multiple-
//     comparisons risk), surfaced as a raw ratio for the LLM to reason about.
import type { ParamValue } from '../strategies/registry.js'
import type { Dimension } from '../engine/space.js'
import type { TestSpec } from '../engine/space.js'

export interface BackForwardPair {
  backPassId: number
  forwardPassId: number
  varied: Record<string, ParamValue>
  backCriterion: number
  forwardCriterion: number
  dropPct: number | null // (forward - back) / |back|; negative = forward did worse
}

export interface NeighborSample {
  index: number // this dim's value index the neighbor used
  value: ParamValue
  criterion: number
  delta: number // neighborCriterion - bestCriterion
}

export interface NeighborStability {
  dim: string
  bestValue: ParamValue
  neighbors: NeighborSample[] // 0-2 found neighbors (one step away in this dim only)
  missingSteps: number // how many of the up-to-2 adjacent steps weren't evaluated in this run
  verdict: 'plateau' | 'spike' | 'insufficient-data'
}

export interface OverfitSignals {
  backForward: BackForwardPair[]
  neighborStability: NeighborStability[]
  sessionsBack: number
  combinationsDeclared: number // size of the full declared search space
  combinationsTried: number // distinct genomes actually evaluated (back phase)
  triedPerSession: number // combinationsTried / sessionsBack -- multiple-comparisons risk, higher = riskier
}

export interface GeneticConvergence {
  generationsRun: number
  maxGenerations: number
  stallGenerations: number
  hitFullBudget: boolean // ran every generation without an early stall
}

interface BackPassLike {
  id: number
  genome: string | null
  criterion: number | null
  generation: number | null
}

export function computeBackForward(
  backPasses: Array<{ id: number; varied: Record<string, ParamValue>; criterion: number | null }>,
  forwardPasses: Array<{ id: number; back_pass_id: number | null; criterion: number | null }>
): BackForwardPair[] {
  const backById = new Map(backPasses.map((p) => [p.id, p]))
  const out: BackForwardPair[] = []
  for (const f of forwardPasses) {
    if (f.back_pass_id == null || f.criterion == null || !Number.isFinite(f.criterion)) continue
    const b = backById.get(f.back_pass_id)
    if (!b || b.criterion == null || !Number.isFinite(b.criterion)) continue
    out.push({
      backPassId: b.id,
      forwardPassId: f.id,
      varied: b.varied,
      backCriterion: b.criterion,
      forwardCriterion: f.criterion,
      dropPct: b.criterion !== 0 ? (f.criterion - b.criterion) / Math.abs(b.criterion) : null
    })
  }
  return out.sort((a, b) => b.backCriterion - a.backCriterion)
}

/** For the single best back pass, look at its immediate grid neighbors (one
 *  step away in exactly one dimension) actually evaluated in this run. */
export function computeNeighborStability(dims: Dimension[], backPasses: BackPassLike[]): NeighborStability[] {
  const finite = backPasses.filter((p) => p.genome != null && p.criterion != null && Number.isFinite(p.criterion))
  if (!finite.length || !dims.length) return []
  const best = finite.reduce((a, b) => ((b.criterion as number) > (a.criterion as number) ? b : a))
  const bestGenome = (best.genome as string).split(',').map(Number)
  const bestCriterion = best.criterion as number
  const byGenome = new Map(finite.map((p) => [p.genome as string, p.criterion as number]))
  const allCriteria = finite.map((p) => p.criterion as number)
  const range = Math.max(...allCriteria) - Math.min(...allCriteria)

  return dims.map((dim, i) => {
    const bestIdx = bestGenome[i]
    const steps = [bestIdx - 1, bestIdx + 1].filter((idx) => idx >= 0 && idx < dim.values.length)
    const neighbors: NeighborSample[] = []
    for (const idx of steps) {
      const g = [...bestGenome]
      g[i] = idx
      const crit = byGenome.get(g.join(','))
      if (crit != null) neighbors.push({ index: idx, value: dim.values[idx], criterion: crit, delta: crit - bestCriterion })
    }
    const missingSteps = steps.length - neighbors.length
    let verdict: NeighborStability['verdict'] = 'insufficient-data'
    if (neighbors.length) {
      const worstDrop = Math.max(0, ...neighbors.map((n) => -n.delta))
      verdict = range > 0 && worstDrop > 0.25 * range ? 'spike' : 'plateau'
    }
    return { dim: dim.name, bestValue: dim.values[bestIdx], neighbors, missingSteps, verdict }
  })
}

export function computeGeneticConvergence(spec: TestSpec, backPasses: Array<{ generation: number | null }>): GeneticConvergence | null {
  if (spec.search !== 'genetic') return null
  const gens = backPasses.map((p) => p.generation).filter((g): g is number => g != null)
  if (!gens.length) return null
  const generationsRun = Math.max(...gens) + 1
  return {
    generationsRun,
    maxGenerations: spec.genetic.maxGenerations,
    stallGenerations: spec.genetic.stallGenerations,
    hitFullBudget: generationsRun >= spec.genetic.maxGenerations
  }
}
