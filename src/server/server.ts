// The optimizer's web service: the UI (ui/) plus a small JSON API. Runs
// execute one at a time from a queue (runs.status = 'queued'), each on a
// fresh worker pool no bigger than OPT_MAX_THREADS -- the CPU cap that
// leaves Redfish's other half to the local AI.
//
//   GET  /api/meta                       thread cap, Strike Canopy ref
//   GET  /api/strategies                 everything in the Paper Lab registry
//   GET  /api/sessions?strategy=&from=&to=   usable / skipped sessions
//   POST /api/runs                       submit a TestSpec -> {id}
//   GET  /api/runs                       recent runs
//   GET  /api/runs/:id                   one run (+ live progress)
//   POST /api/runs/:id/cancel
//   GET  /api/runs/:id/passes?phase=back|forward
//   GET  /api/passes/:id                 pass + per-session results
//   POST /api/passes/:id/replay?date=    re-run one session with its trade log
//   POST /api/runs/:id/analysis          compute + narrate (on-demand, overwrites)
//   GET  /api/runs/:id/analysis          stored analysis, if any
import 'dotenv/config'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import pino from 'pino'
import { z } from 'zod'
import { ensureResultsSchema } from '../sim/db.js'
import { getStrategy, listStrategies, replayable, variantDefaults } from '../strategies/registry.js'
import { buildSpace, TestSpec } from '../engine/space.js'
import { executeRun, usableSessions } from '../engine/run.js'
import { WorkerPool } from '../engine/pool.js'
import { TUNABLE_ROLES } from '../sc.js'
import { analyzeRun } from '../analysis/index.js'

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  OPT_DATA_DIR: z.string().default('/data'),
  OPT_MAX_THREADS: z.coerce.number().int().min(1).max(72).default(30),
  OPT_PORT: z.coerce.number().int().default(8430),
  LOG_LEVEL: z.string().default('info'),
  // AI analysis backend: Redfish's local Ollama by default (reached from
  // inside this container via the host-gateway alias, see docker-compose.yml).
  OPT_OLLAMA_URL: z.string().default('http://host.docker.internal:11434'),
  OPT_OLLAMA_MODEL: z.string().default('qwen3:30b-a3b-ctx32k'),
  OPT_OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000)
})
const env = Env.parse(process.env)
const logger = pino({ level: env.LOG_LEVEL })
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8 })
const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url))
const scRef = (await readFile(new URL('../../vendor/strike-canopy.ref', import.meta.url), 'utf8').catch(() => 'unknown')).trim()

// ---- run queue ------------------------------------------------------------------
let active: { id: number; cancel: boolean } | null = null
let replayPool: WorkerPool | null = null

async function runLoop(): Promise<void> {
  for (;;) {
    if (!active) {
      const { rows } = await db.query<{ id: number; spec: unknown }>(
        `SELECT id, spec FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1`
      )
      const r = rows[0]
      if (r) {
        const id = Number(r.id)
        active = { id, cancel: false }
        const spec = TestSpec.parse(r.spec)
        const pool = new WorkerPool(Math.min(spec.threads, env.OPT_MAX_THREADS))
        const t0 = Date.now()
        try {
          await executeRun({ db, pool, logger, dataRoot: env.OPT_DATA_DIR, scRef, cancelled: () => active?.cancel === true }, id, spec)
          logger.info({ id, s: Math.round((Date.now() - t0) / 1000) }, 'optimizer: run finished')
        } catch (err) {
          logger.error({ err, id }, 'optimizer: run failed')
          await db.query(`UPDATE runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`, [
            id,
            err instanceof Error ? err.message : String(err)
          ])
        } finally {
          await pool.close()
          active = null
        }
        continue
      }
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
}

// ---- http helpers ---------------------------------------------------------------
type Handler = (req: http.IncomingMessage, url: URL, m: RegExpMatchArray) => Promise<unknown>
const routes: Array<{ method: string; re: RegExp; h: Handler }> = []
const route = (method: string, re: RegExp, h: Handler) => routes.push({ method, re, h })

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 1_000_000) throw new HttpError(413, 'body too large')
    chunks.push(c as Buffer)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}

const idOf = (m: RegExpMatchArray) => Number(m[1])

// ---- API ----------------------------------------------------------------------------
route('GET', /^\/api\/meta$/, async () => ({ maxThreads: env.OPT_MAX_THREADS, strikeCanopyRef: scRef, activeRun: active?.id ?? null, ollamaModel: env.OPT_OLLAMA_MODEL }))

route('GET', /^\/api\/strategies$/, async () =>
  listStrategies().map((ref) => ({
    key: ref.key,
    id: ref.def.id,
    variant: ref.variant,
    mode: ref.mode,
    label: ref.label,
    family: ref.def.label,
    cadence: ref.def.cadence,
    footprint: ref.def.footprint,
    constraints: ref.def.constraints ?? [],
    tunableRoles: TUNABLE_ROLES,
    defaults: variantDefaults(ref),
    replayable: replayable(ref),
    params: ref.def.params
  }))
)

route('GET', /^\/api\/sessions$/, async (_req, url) => {
  const ref = getStrategy(url.searchParams.get('strategy') ?? '')
  const from = url.searchParams.get('from') ?? '2026-08-01'
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10)
  return usableSessions(env.OPT_DATA_DIR, ref, from, to)
})

route('POST', /^\/api\/runs$/, async (req) => {
  const parsed = TestSpec.safeParse(await body(req))
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const spec = parsed.data
  if (spec.threads > env.OPT_MAX_THREADS) throw new HttpError(400, `threads is capped at ${env.OPT_MAX_THREADS}`)
  const ref = getStrategy(spec.strategy)
  let combinations: number
  let base: ReturnType<typeof buildSpace>['base']
  try {
    const space = buildSpace(ref, spec)
    combinations = space.combinations
    base = space.base
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err))
  }
  // Checked against the run's own resolved params (e.g. a fixed symbol
  // override), not just the variant's default -- see registry.ts's
  // footprintSymbols comment: a variant's own symbol can look replayable
  // while an override on the same run points at an unpacked one.
  const rp = replayable(ref, base)
  if (!rp.ok) throw new HttpError(400, `${spec.strategy} can't be replayed yet: ${rp.why}`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO runs (status, spec, sc_ref, note) VALUES ('queued', $1, $2, $3) RETURNING id`,
    [JSON.stringify(spec), scRef, spec.note ?? null]
  )
  return { id: Number(rows[0].id), combinations }
})

route('GET', /^\/api\/runs$/, async () => {
  const { rows } = await db.query(
    `SELECT id, status, created_at, started_at, finished_at, spec->>'strategy' AS strategy,
            spec->>'criterion' AS criterion, spec->>'search' AS search, progress, error, note,
            (SELECT count(*) FROM passes p WHERE p.run_id = runs.id)::int AS passes
       FROM runs ORDER BY id DESC LIMIT 50`
  )
  return rows
})

route('GET', /^\/api\/runs\/(\d+)$/, async (_req, _url, m) => {
  const { rows } = await db.query(`SELECT * FROM runs WHERE id = $1`, [idOf(m)])
  if (!rows[0]) throw new HttpError(404, 'no such run')
  return rows[0]
})

route('POST', /^\/api\/runs\/(\d+)\/cancel$/, async (_req, _url, m) => {
  const id = idOf(m)
  if (active?.id === id) active.cancel = true
  await db.query(`UPDATE runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'`, [id])
  return { ok: true }
})

route('GET', /^\/api\/runs\/(\d+)\/passes$/, async (_req, url, m) => {
  const phase = url.searchParams.get('phase') === 'forward' ? 'forward' : 'back'
  const { rows } = await db.query(
    `SELECT id, generation, varied, criterion, metrics, stress, back_pass_id, error, ms
       FROM passes WHERE run_id = $1 AND phase = $2 ORDER BY id`,
    [idOf(m), phase]
  )
  return rows
})

route('GET', /^\/api\/passes\/(\d+)$/, async (_req, _url, m) => {
  const { rows } = await db.query(`SELECT * FROM passes WHERE id = $1`, [idOf(m)])
  if (!rows[0]) throw new HttpError(404, 'no such pass')
  const days = await db.query(`SELECT date::text AS date, outcome, pnl, result FROM pass_days WHERE pass_id = $1 ORDER BY date`, [idOf(m)])
  return { ...rows[0], days: days.rows }
})

route('POST', /^\/api\/passes\/(\d+)\/replay$/, async (_req, url, m) => {
  const date = url.searchParams.get('date') ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date=YYYY-MM-DD')
  const { rows } = await db.query(
    `SELECT p.params, r.spec->>'strategy' AS strategy FROM passes p JOIN runs r ON r.id = p.run_id WHERE p.id = $1`,
    [idOf(m)]
  )
  if (!rows[0]) throw new HttpError(404, 'no such pass')
  replayPool ??= new WorkerPool(1)
  const r = await replayPool.run({ strategy: rows[0].strategy, params: rows[0].params, date, mode: `replay_${idOf(m)}`, keepEvents: true })
  return r.day
})

const analysisInFlight = new Set<number>()
route('POST', /^\/api\/runs\/(\d+)\/analysis$/, async (_req, _url, m) => {
  const id = idOf(m)
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [id])
  if (!rows[0]) throw new HttpError(404, 'no such run')
  if (rows[0].status === 'running' || rows[0].status === 'queued') throw new HttpError(400, 'run is still in progress')
  const { rows: cnt } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM passes WHERE run_id = $1 AND phase = 'back' AND criterion IS NOT NULL`,
    [id]
  )
  if (cnt[0].n < 2) throw new HttpError(400, 'not enough finished passes to analyze')
  if (analysisInFlight.has(id)) throw new HttpError(409, 'analysis already running for this run')
  analysisInFlight.add(id)
  try {
    return await analyzeRun(db, id, { url: env.OPT_OLLAMA_URL, model: env.OPT_OLLAMA_MODEL, timeoutMs: env.OPT_OLLAMA_TIMEOUT_MS })
  } finally {
    analysisInFlight.delete(id)
  }
})

route('GET', /^\/api\/runs\/(\d+)\/analysis$/, async (_req, _url, m) => {
  const { rows } = await db.query<{ analysis: unknown }>(`SELECT analysis FROM runs WHERE id = $1`, [idOf(m)])
  if (!rows[0]) throw new HttpError(404, 'no such run')
  if (!rows[0].analysis) throw new HttpError(404, 'no analysis yet')
  return rows[0].analysis
})

// ---- server ---------------------------------------------------------------------------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = url.pathname.match(r.re)
        if (m && r.method === req.method) {
          const out = await r.h(req, url, m)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(out))
          return
        }
      }
      throw new HttpError(404, 'no such endpoint')
    }
    const file = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '')
    if (file.includes('..')) throw new HttpError(400, 'bad path')
    const buf = await readFile(path.join(UI_DIR, file)).catch(() => null)
    if (!buf) throw new HttpError(404, 'not found')
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) logger.error({ err, url: req.url }, 'optimizer: request failed')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
})

await ensureResultsSchema(db)
// a run left 'running' by a restart can't resume -- say so instead of hanging
await db.query(`UPDATE runs SET status = 'error', error = 'interrupted by a restart', finished_at = now() WHERE status = 'running'`)
server.listen(env.OPT_PORT, () => logger.info({ port: env.OPT_PORT, maxThreads: env.OPT_MAX_THREADS }, 'optimizer: listening'))
void runLoop()
