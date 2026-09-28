// Executes one optimization run (a validated TestSpec): pick the usable
// sessions, split back/forward, search the space (complete grid or MT5-style
// genetic), then re-test the best back-test passes on the held-out forward
// sessions. Every pass is stored as it finishes, so the UI can show the
// table / heatmap / genetic progress live.
import type pg from 'pg'
import type { Logger } from 'pino'
import { readManifest } from '../daypack/pack.js'
import { getStrategy, requireChecks, type ParamValue, type StrategyRef } from '../strategies/registry.js'
import { criterionValue, passMetrics, type Criterion, type PassMetrics } from './metrics.js'
import type { DayResult } from './pass.js'
import type { WorkerPool } from './pool.js'
import { buildSpace, genomeKey, paramsAt, variedOf, type Space, type TestSpec } from './space.js'
import type { ParamSpec } from '../sc.js'
import { ResultsStore } from './results-store.js'

export interface RunCtx {
  db: pg.Pool
  pool: WorkerPool
  logger: Logger
  dataRoot: string
  scRef: string
  cancelled: () => boolean
}

interface Evaluated {
  passId: number
  genome: number[]
  crit: number
  metrics: PassMetrics
}

const GRID_MAX = 20_000

// ---- sessions ------------------------------------------------------------

function weekdays(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay()
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export async function usableSessions(
  dataRoot: string,
  ref: StrategyRef,
  from: string,
  to: string,
  params?: Record<string, ParamValue>
): Promise<{ usable: string[]; skipped: Array<{ date: string; why: string }> }> {
  const need = requireChecks(ref, params)
  const usable: string[] = []
  const skipped: Array<{ date: string; why: string }> = []
  for (const d of weekdays(from, to)) {
    const m = await readManifest(dataRoot, d)
    if (!m) {
      skipped.push({ date: d, why: 'no DayPack (holiday, or not pulled yet)' })
      continue
    }
    const bad = need.filter((c) => !m.checks[c]?.ok)
    if (bad.length)
      skipped.push({
        date: d,
        why: bad.map((c) => (c.startsWith('missing:') ? `DayPacks have no ${c.slice(8)} data` : `${c}: ${m.checks[c]?.detail ?? 'missing'}`)).join('; ')
      })
    else usable.push(d)
  }
  return { usable, skipped }
}

function splitForward(dates: string[], forward: TestSpec['forward']): { back: string[]; fwd: string[] } {
  if (forward === 0) return { back: dates, fwd: [] }
  if (typeof forward === 'string') return { back: dates.filter((d) => d < forward), fwd: dates.filter((d) => d >= forward) }
  const nFwd = Math.max(1, Math.round(dates.length / forward))
  return { back: dates.slice(0, dates.length - nFwd), fwd: dates.slice(dates.length - nFwd) }
}

// ---- seeded RNG (mulberry32) ------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- the run ---------------------------------------------------------------------

export async function executeRun(ctx: RunCtx, runId: number, spec: TestSpec): Promise<void> {
  const { db, pool, logger } = ctx
  const ref = getStrategy(spec.strategy)
  const space = buildSpace(ref, spec)
  const { usable, skipped } = await usableSessions(ctx.dataRoot, ref, spec.from, spec.to, space.base)
  const { back, fwd } = splitForward(usable, spec.forward)
  if (!back.length) throw new Error('no usable back-test sessions in the date range')
  await db.query(
    `UPDATE runs SET status = 'running', started_at = now(), sessions = $2, space = $3 WHERE id = $1`,
    [runId, JSON.stringify({ back, forward: fwd, skipped }), JSON.stringify({ dims: space.dims, combinations: space.combinations })]
  )

  const crit = spec.criterion as Criterion
  const memo = new Map<string, Evaluated | null>() // genomeKey -> result (null = breaks a constraint)
  let evaluated = 0
  let best: Evaluated | null = null
  let generation: number | null = null
  let phase: 'back' | 'forward' = 'back'
  let total = 0
  let lastProgress = 0
  const progress = async (force = false) => {
    if (!force && Date.now() - lastProgress < 2000) return
    lastProgress = Date.now()
    await db.query(`UPDATE runs SET progress = $2 WHERE id = $1`, [
      runId,
      JSON.stringify({
        phase,
        generation,
        evaluated,
        total,
        best: best ? { passId: best.passId, crit: best.crit, varied: variedOf(space, best.genome) } : null,
        queue: pool.pending,
        reused: store.hits,
        computed: store.misses
      })
    ])
  }

  const costParams = Object.entries(ref.def.params as Record<string, ParamSpec>)
    .filter(([, s]) => s.role === 'cost' && s.kind === 'number')
    .map(([k]) => k)

  const store = new ResultsStore(db, ctx.dataRoot, ctx.scRef)
  // A DayPack going from usable to failing between usableSessions' check at
  // run start and a worker actually loading it -- e.g. a concurrent `opt
  // pull` rewrote the manifest mid-run (found live 2026-09-28: a re-pull
  // flipped 2026-09-16's spx_chain from passing to 379/397, one below the
  // 380 threshold, mid-run, and killed a 14k-pass-deep run). Matches
  // CachedWellClient.loadDay's own two error strings exactly.
  const DAYPACK_UNAVAILABLE_RE = /^(no DayPack for|DayPack .* fails check)/
  // Stored result if this exact (strategy version, params, session, data) was
  // ever computed -- by this run or any earlier one; otherwise compute + store.
  async function runDays(params: Record<string, ParamValue>, dates: string[], tag: string): Promise<DayResult[]> {
    return Promise.all(
      dates.map(async (date) => {
        const key = await store.keyFor(ref, params, date)
        const hit = await store.get(key)
        if (hit) return hit
        try {
          const r = await pool.run({ strategy: ref.key, params, date, mode: `opt_${runId}_${tag}` })
          await store.put(key, ref, params, r.day, r.ms)
          return r.day
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!DAYPACK_UNAVAILABLE_RE.test(msg)) throw err // a real strategy-tick bug: still loud, still aborts the pass
          const day: DayResult = {
            date,
            outcome: '(daypack unavailable mid-run)',
            noEntry: true,
            pnl: null,
            result: null,
            std: { outcome: '(daypack unavailable mid-run)', noEntry: true, pnl: null, basis: null, trades: 0 },
            events: [],
            tickErrors: 0,
            firstError: msg,
            cache: { chainHistoryHits: 0, snapshotDerived: 0, snapshotMisses: 0, barsCalls: 0 }
          }
          return day
        }
      })
    )
  }

  async function evaluate(genome: number[], ph: 'back' | 'forward', dates: string[], backPassId?: number): Promise<Evaluated | null> {
    const key = `${ph}|${genomeKey(genome)}`
    if (memo.has(key)) return memo.get(key)!
    const params = paramsAt(ref, space, genome)
    if (!params) {
      memo.set(key, null)
      return null
    }
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO passes (run_id, phase, generation, params, varied, genome, back_pass_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [runId, ph, generation, JSON.stringify(params), JSON.stringify(variedOf(space, genome)), genomeKey(genome), backPassId ?? null]
    )
    const passId = Number(rows[0].id)
    const t0 = Date.now()
    try {
      const days = await runDays(params, dates, String(passId))
      const metrics = passMetrics(days)
      const value = criterionValue(metrics, crit)
      let stress: PassMetrics | null = null
      if (spec.costStress && costParams.length) {
        const doubled = { ...params }
        for (const k of costParams) doubled[k] = (params[k] as number) * 2
        stress = passMetrics(await runDays(doubled, dates, `${passId}x2`))
      }
      await db.query(`UPDATE passes SET metrics = $2, criterion = $3, stress = $4, ms = $5 WHERE id = $1`, [
        passId,
        JSON.stringify(metrics),
        Number.isFinite(value) ? value : null,
        stress ? JSON.stringify(stress) : null,
        Date.now() - t0
      ])
      for (const d of days) {
        await db.query(
          `INSERT INTO pass_days (pass_id, date, outcome, pnl, result) VALUES ($1,$2,$3,$4,$5)`,
          [passId, d.date, d.outcome, d.noEntry ? null : d.pnl, JSON.stringify({ ...d.result, _std: d.std, _tickErrors: d.tickErrors })]
        )
      }
      const ev: Evaluated = { passId, genome, crit: value, metrics }
      memo.set(key, ev)
      evaluated++
      if (ph === 'back' && (!best || value > best.crit)) best = ev
      await progress()
      return ev
    } catch (err) {
      await db.query(`UPDATE passes SET error = $2 WHERE id = $1`, [passId, err instanceof Error ? err.message : String(err)])
      memo.set(key, null)
      throw err
    }
  }

  /** Evaluate many genomes concurrently, keeping the worker queue full. */
  async function evaluateAll(genomes: number[][], ph: 'back' | 'forward', dates: string[], backIds?: number[]): Promise<Array<Evaluated | null>> {
    const out: Array<Evaluated | null> = new Array(genomes.length).fill(null)
    const inflight = Math.max(2, Math.ceil((pool.size * 2) / Math.max(1, dates.length)))
    let next = 0
    const lanes = Array.from({ length: Math.min(inflight, genomes.length) }, async () => {
      while (next < genomes.length) {
        if (ctx.cancelled()) return
        const i = next++
        out[i] = await evaluate(genomes[i], ph, dates, backIds?.[i])
      }
    })
    await Promise.all(lanes)
    return out
  }

  // ---------- back-test search ----------
  const dims = space.dims
  const nearestDefault = (): number[] =>
    dims.map((d) => {
      const want = ref.def.variants[ref.variant] ? space.base[d.name] : undefined
      const i = d.values.findIndex((v) => JSON.stringify(v) === JSON.stringify(want))
      return i >= 0 ? i : Math.floor(d.values.length / 2)
    })

  const useGrid = spec.search === 'grid' || space.combinations <= spec.genetic.population * 2
  if (useGrid) {
    const gridPasses = spec.maxPasses ? Math.min(spec.maxPasses, space.combinations) : space.combinations
    if (gridPasses > GRID_MAX) throw new Error(`complete grid has ${space.combinations} passes (max ${GRID_MAX}) -- set a pass budget or use genetic`)
    if (space.combinations > 5_000_000) throw new Error(`grid of ${space.combinations} combinations is too large to sample -- use genetic`)
    const all: number[][] = []
    const walk = (i: number, acc: number[]) => {
      if (i === dims.length) return void all.push([...acc])
      for (let j = 0; j < dims[i].values.length; j++) walk(i + 1, [...acc, j])
    }
    walk(0, [])
    if (spec.maxPasses && all.length > spec.maxPasses) {
      // seeded Fisher-Yates, keep the first maxPasses: a repeatable random sample
      const rand = rng(spec.genetic.seed)
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[all[i], all[j]] = [all[j], all[i]]
      }
      all.length = spec.maxPasses
      logger.info({ runId, sampled: spec.maxPasses, of: space.combinations }, 'optimizer: grid larger than the pass budget -- random sample')
    }
    total = all.length
    await progress(true)
    await evaluateAll(all, 'back', back)
  } else {
    const g = spec.genetic
    const rand = rng(g.seed)
    const pm = g.mutationRate ?? Math.max(0.1, 1 / Math.max(1, dims.length))
    const randomGenome = () => dims.map((d) => Math.floor(rand() * d.values.length))
    const valid = (gen: number[]) => paramsAt(ref, space, gen) != null
    const fresh = (make: () => number[], tries = 30): number[] => {
      let cand = make()
      for (let t = 0; t < tries && (!valid(cand) || memo.has(`back|${genomeKey(cand)}`)); t++) cand = make()
      return cand
    }
    let population: number[][] = [nearestDefault()]
    while (population.length < g.population) population.push(fresh(randomGenome))
    total = spec.maxPasses ? Math.min(spec.maxPasses, g.population * g.maxGenerations) : g.population * g.maxGenerations
    let stall = 0
    let bestSoFar = -Infinity
    let spent = 0 // passes that cost a run; genomes already evaluated are free
    for (generation = 0; generation < g.maxGenerations; generation++) {
      if (ctx.cancelled()) break
      if (spec.maxPasses) {
        const left = spec.maxPasses - spent
        if (left <= 0) {
          logger.info({ runId, generation, maxPasses: spec.maxPasses }, 'optimizer: pass budget reached')
          break
        }
        let fresh = 0
        population = population.filter((gen) => memo.has(`back|${genomeKey(gen)}`) || ++fresh <= left)
        spent += Math.min(fresh, left)
      }
      await progress(true)
      const res = await evaluateAll(population, 'back', back)
      const scored = population
        .map((gen, i) => ({ gen, fit: res[i]?.crit ?? -Infinity }))
        .sort((a, b) => b.fit - a.fit)
      const top = scored[0]?.fit ?? -Infinity
      if (top > bestSoFar + 1e-9) {
        bestSoFar = top
        stall = 0
      } else if (++stall >= g.stallGenerations && generation >= 5) {
        logger.info({ runId, generation }, 'optimizer: genetic search converged (no improvement)')
        break
      }
      if (memo.size >= space.combinations) break // every point seen
      // next generation: 2 elites + tournament-selected, crossed, mutated children
      const tournament = () => {
        let b = scored[Math.floor(rand() * scored.length)]
        for (let k = 0; k < 2; k++) {
          const c = scored[Math.floor(rand() * scored.length)]
          if (c.fit > b.fit) b = c
        }
        return b.gen
      }
      const next: number[][] = scored.slice(0, 2).map((s) => s.gen)
      while (next.length < g.population) {
        const child = fresh(() => {
          const a = tournament()
          const b = tournament()
          return a.map((ga, i) => {
            let v = rand() < 0.5 ? ga : b[i]
            if (rand() < pm) {
              const len = dims[i].values.length
              if (rand() < 0.2) v = Math.floor(rand() * len)
              else {
                const span = Math.max(1, Math.round(len * 0.15))
                v = Math.min(len - 1, Math.max(0, v + (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * span))))
              }
            }
            return v
          })
        })
        next.push(child)
      }
      population = next
    }
    generation = null
  }

  // ---------- forward test ----------
  if (fwd.length && !ctx.cancelled()) {
    phase = 'forward'
    const { rows } = await db.query<{ id: number; genome: string }>(
      `SELECT id, genome FROM passes WHERE run_id = $1 AND phase = 'back' AND criterion IS NOT NULL ORDER BY criterion DESC`,
      [runId]
    )
    const frac = useGrid ? 0.1 : 0.25
    const pick = rows.slice(0, Math.min(100, Math.max(1, Math.ceil(rows.length * frac))))
    total = evaluated + pick.length
    await progress(true)
    await evaluateAll(
      pick.map((r) => (r.genome ? r.genome.split(',').map(Number) : [])),
      'forward',
      fwd,
      pick.map((r) => Number(r.id))
    )
  }

  await progress(true)
  await db.query(`UPDATE runs SET status = $2, finished_at = now() WHERE id = $1`, [runId, ctx.cancelled() ? 'cancelled' : 'done'])
}

export type { Space }
