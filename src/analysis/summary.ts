// Loads one run's passes/pass_days and turns them into a ComputedSummary --
// every number in the eventual report traces back to something computed
// here, deterministically, before any LLM is involved.
import type pg from 'pg'
import type { ParamValue } from '../strategies/registry.js'
import type { Dimension, TestSpec } from '../engine/space.js'
import type { PassMetrics } from '../engine/metrics.js'
import { computeSensitivity, type DimSensitivity } from './sensitivity.js'
import { rerankByOutliers, type OutlierPass } from './outliers.js'
import { computeBackForward, computeNeighborStability, computeGeneticConvergence, type BackForwardPair, type NeighborStability, type GeneticConvergence } from './overfit.js'

export interface ComputedSummary {
  runId: number
  strategy: string
  criterion: string
  search: 'grid' | 'genetic'
  sessionsBack: number
  sessionsForward: number
  backPassesEvaluated: number
  combinationsDeclared: number
  sensitivity: DimSensitivity[]
  outliers: { topN: number; passes: OutlierPass[] }
  overfit: {
    backForward: BackForwardPair[]
    neighborStability: NeighborStability[]
    combinationsTried: number
    triedPerSession: number
  }
  genetic: GeneticConvergence | null
  thinSample: boolean // fewer than 30 back-test sessions -- hedge conclusions
}

const OUTLIER_TOP_N = 15
const THIN_SAMPLE_THRESHOLD = 30

interface RunRow {
  id: number
  spec: TestSpec
  sessions: { back: string[]; forward: string[] } | null
  space: { dims: Dimension[]; combinations: number } | null
}

interface PassRow {
  id: number
  generation: number | null
  varied: Record<string, ParamValue>
  criterion: number | null
  metrics: PassMetrics | null
  genome: string | null
  back_pass_id: number | null
}

export async function computeSummary(db: pg.Pool, runId: number): Promise<ComputedSummary> {
  const { rows: runRows } = await db.query<RunRow>(`SELECT id, spec, sessions, space FROM runs WHERE id = $1`, [runId])
  const run = runRows[0]
  if (!run) throw new Error(`no such run: ${runId}`)
  const dims = run.space?.dims ?? []
  const combinationsDeclared = run.space?.combinations ?? 0
  const sessionsBack = run.sessions?.back ?? []
  const sessionsForward = run.sessions?.forward ?? []

  const { rows: backPasses } = await db.query<PassRow>(
    `SELECT id, generation, varied, criterion, metrics, genome, back_pass_id FROM passes WHERE run_id = $1 AND phase = 'back'`,
    [runId]
  )
  const { rows: forwardPasses } = await db.query<PassRow>(
    `SELECT id, generation, varied, criterion, metrics, genome, back_pass_id FROM passes WHERE run_id = $1 AND phase = 'forward'`,
    [runId]
  )

  const finiteBack = backPasses.filter((p) => p.criterion != null && Number.isFinite(p.criterion))
  const sensitivity = computeSensitivity(dims, finiteBack)

  const topN = [...finiteBack].sort((a, b) => (b.criterion as number) - (a.criterion as number)).slice(0, OUTLIER_TOP_N)
  const { rows: dayRows } = topN.length
    ? await db.query<{ pass_id: number; pnl: number | null }>(`SELECT pass_id, pnl FROM pass_days WHERE pass_id = ANY($1)`, [topN.map((p) => p.id)])
    : { rows: [] as Array<{ pass_id: number; pnl: number | null }> }
  const daysByPass = new Map<number, Array<{ pnl: number | null }>>()
  for (const d of dayRows) {
    const arr = daysByPass.get(d.pass_id) ?? []
    arr.push({ pnl: d.pnl })
    daysByPass.set(d.pass_id, arr)
  }
  const outlierPasses = rerankByOutliers(
    topN.map((p) => ({ passId: p.id, varied: p.varied, criterion: p.criterion as number, days: daysByPass.get(p.id) ?? [] }))
  )

  const backForward = computeBackForward(backPasses, forwardPasses)
  const neighborStability = computeNeighborStability(dims, finiteBack)
  const combinationsTried = finiteBack.length
  const genetic = computeGeneticConvergence(run.spec, backPasses)

  return {
    runId,
    strategy: run.spec.strategy,
    criterion: run.spec.criterion,
    search: run.spec.search,
    sessionsBack: sessionsBack.length,
    sessionsForward: sessionsForward.length,
    backPassesEvaluated: finiteBack.length,
    combinationsDeclared,
    sensitivity,
    outliers: { topN: topN.length, passes: outlierPasses },
    overfit: {
      backForward,
      neighborStability,
      combinationsTried,
      triedPerSession: sessionsBack.length ? combinationsTried / sessionsBack.length : 0
    },
    genetic,
    thinSample: sessionsBack.length < THIN_SAMPLE_THRESHOLD
  }
}
