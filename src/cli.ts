// opt <command>
//   pull   --dates 2026-09-15,2026-09-16 | --from 2026-09-15 --to 2026-09-23
//          Pull DayPacks from The Well (one request at a time).
//   pass   --strategy nutterfly5 --dates ... [--params '{"stopMin":60}']
//          Run one pass from the packs and print per-day results + metrics.
//   generic --spec examples/generic/aapl-45dte-put-spread.json --from 2025-01-01 --to 2026-09-18
//          [--trades] [--skips] [--json out.json]
//          [--grid '{"entry.targetDte":[30,45],"exit.profitTargetPct":[25,50]}' --criterion totalPnl]
//          Run a GENERIC (JSON-defined) strategy on any symbol: one pass, or
//          every combination of --grid (dotted paths into the spec).
//   accept Fidelity test: default-param passes must reproduce Strike Canopy's
//          own bt_nutter5/bt_nutter10 rows (test/fixtures/golden-nutterfly.json).
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { z } from 'zod'
import pino from 'pino'
import { WellClient } from './sc.js'
import { pullDay } from './daypack/pull.js'
import { readManifest } from './daypack/pack.js'
import { ensureSimSchema, simPool } from './sim/db.js'
import { STRATEGIES, resolveParams } from './strategies/registry.js'
import { runPassDay, type DayResult } from './engine/pass.js'
import { criterionValue, passMetrics, type Criterion } from './engine/metrics.js'
import { writeFile } from 'node:fs/promises'
import { GenericSpec } from './generic/spec.js'
import { ChainSource } from './generic/chains.js'
import { runGeneric, type GenericResult } from './generic/engine.js'

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  WELL_API_URL: z.string().url(),
  WELL_API_SECRET: z.string().min(1),
  OPT_DATA_DIR: z.string().default('/data'),
  LOG_LEVEL: z.string().default('warn')
})

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

function dates(): string[] {
  const list = arg('dates')
  const ds = list ? list.split(',').map((s) => s.trim()) : arg('from') && arg('to') ? weekdaysBetween(arg('from')!, arg('to')!) : []
  if (!ds.length) throw new Error('need --dates a,b or --from/--to')
  for (const d of ds) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date ${d}`)
  return ds
}

/** Every combination of a {dotted.path: [values]} grid ([{}] when empty). */
function expandGrid(grid: Record<string, unknown[]>): Array<Record<string, unknown>> {
  let out: Array<Record<string, unknown>> = [{}]
  for (const [k, vals] of Object.entries(grid)) {
    if (!Array.isArray(vals) || !vals.length) throw new Error(`--grid ${k}: need a non-empty array`)
    out = out.flatMap((o) => vals.map((v) => ({ ...o, [k]: v })))
  }
  return out
}

/** Set a dotted path ("entry.legs.0.strike.value") in a plain JSON object. */
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cur: Record<string, unknown> = obj
  for (const p of parts.slice(0, -1)) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

async function scRef(): Promise<string> {
  return (await readFile(new URL('../vendor/strike-canopy.ref', import.meta.url), 'utf8').catch(() => 'unknown')).trim()
}

const usd = (n: number | null | undefined) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`)

async function main(): Promise<void> {
  const env = Env.parse(process.env)
  // Plain JSON to stderr -- Strike Canopy's createLogger() spawns a pino-pretty
  // transport thread, which a pool of optimizer workers doesn't want.
  const logger = pino({ level: env.LOG_LEVEL }, pino.destination(2))
  const cmd = process.argv[2]

  if (cmd === 'pull') {
    const well = new WellClient(env.WELL_API_URL, env.WELL_API_SECRET, logger)
    const ref = await scRef()
    for (const d of dates()) {
      const t0 = Date.now()
      try {
        const m = await pullDay(well, env.OPT_DATA_DIR, d, ref, env.WELL_API_URL, logger)
        const checks = Object.entries(m.checks).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL'}(${v.detail})`).join('  ')
        const bars = m.bars.map((b) => `${b.table}=${b.rows}`).join(' ')
        console.log(`${d}  ${((Date.now() - t0) / 1000).toFixed(0)}s  chain rows=${m.chains[0]?.rows}  ${bars}\n            ${checks}`)
      } catch (err) {
        console.log(`${d}  FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }
    return
  }

  if (cmd === 'generic') {
    const specPath = arg('spec')
    const from = arg('from')
    const to = arg('to')
    if (!specPath || !from || !to) throw new Error('generic needs --spec <file> --from YYYY-MM-DD --to YYYY-MM-DD')
    const raw = JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>
    const src = new ChainSource(env.OPT_DATA_DIR, env.WELL_API_URL, env.WELL_API_SECRET)
    const grid = JSON.parse(arg('grid') ?? '{}') as Record<string, unknown[]>
    const criterion = (arg('criterion') ?? 'totalPnl') as Criterion
    const combos = expandGrid(grid)
    const results: Array<{ vary: Record<string, unknown>; r: GenericResult }> = []
    for (const vary of combos) {
      const specObj = structuredClone(raw)
      for (const [p, v] of Object.entries(vary)) setPath(specObj, p, v)
      const spec = GenericSpec.parse(specObj)
      const t0 = Date.now()
      const r = await runGeneric(spec, src, from, to)
      results.push({ vary, r })
      const m = r.metrics
      console.log(
        `${JSON.stringify(vary)}  ${((Date.now() - t0) / 1000).toFixed(1)}s  trades=${m.tradedDays} win=${m.completionRate == null ? '—' : (m.completionRate * 100).toFixed(0) + '%'}` +
          `  pnl=${usd(m.totalPnl)}  PF=${m.profitFactor?.toFixed(2) ?? '—'}  maxDD=${usd(m.maxDrawdown)}  ror=${m.ror == null ? '—' : (m.ror * 100).toFixed(1) + '%'}` +
          `  chains=${JSON.stringify(r.chainSources)}`
      )
      if (flag('trades')) {
        for (const t of r.trades) {
          const legs = t.legs.map((l) => `${l.side === 'short' ? '-' : '+'}${l.qty}${l.cp[0].toUpperCase()}${l.k}@${l.openPx.toFixed(2)}`).join(' ')
          console.log(
            `   #${t.id} ${t.openDate} ${t.openTime} exp ${t.expiration} (${t.dteAtOpen}d) S=${t.spotOpen.toFixed(2)} ${legs}  ` +
              `cash ${usd(t.entryCash)} -> ${t.exitDate} ${t.exitTime ?? ''} ${t.exitReason} ${usd(t.exitCash)}  pnl ${usd(t.pnl)}` +
              `  maxLoss ${t.maxLoss == null ? 'unbounded' : usd(t.maxLoss)}`
          )
        }
      }
      if (flag('skips')) for (const s of r.skipped) console.log(`   skip ${s.date}: ${s.reason}`)
    }
    if (combos.length > 1) {
      const ranked = [...results].sort((a, b) => criterionValue(b.r.metrics, criterion) - criterionValue(a.r.metrics, criterion))
      console.log(`\nbest by ${criterion}:`)
      for (const x of ranked.slice(0, 10)) console.log(`  ${criterionValue(x.r.metrics, criterion).toFixed(2).padStart(12)}  ${JSON.stringify(x.vary)}`)
    } else {
      console.log(JSON.stringify(results[0]?.r.metrics, null, 1))
    }
    console.log(`well: fetched=${src.stats.fetched} (${(src.stats.bytesFetched / 1e6).toFixed(1)} MB)  disk hits=${src.stats.diskHits}`)
    const out = arg('json')
    if (out) await writeFile(out, JSON.stringify(results.map((x) => ({ vary: x.vary, ...x.r })), null, 1))
    return
  }

  if (cmd === 'pass' || cmd === 'accept') {
    const admin = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 })
    await ensureSimSchema(admin, 'sim_w0')
    const pool = simPool(env.DATABASE_URL, 'sim_w0')
    try {
      if (cmd === 'pass') {
        const def = STRATEGIES[arg('strategy') ?? '']
        if (!def) throw new Error(`--strategy one of ${Object.keys(STRATEGIES).join(', ')}`)
        const params = resolveParams(def, JSON.parse(arg('params') ?? '{}'))
        const days: DayResult[] = []
        for (const d of dates()) {
          const t0 = Date.now()
          const r = await runPassDay(pool, logger, env.OPT_DATA_DIR, def, params, d, 'opt_cli')
          days.push(r)
          console.log(
            `${d}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${r.outcome.padEnd(38)} ${usd(r.pnl).padStart(8)}` +
              (r.tickErrors ? `  tickErrors=${r.tickErrors} (${r.firstError})` : '')
          )
          if (flag('events')) for (const e of r.events) console.log(`     ${e.t} ${e.kind.padEnd(8)} ${usd(e.cash).padStart(8)}  ${e.detail}`)
        }
        console.log(JSON.stringify(passMetrics(days), null, 1))
        return
      }

      // accept
      const golden = JSON.parse(await readFile(new URL('../test/fixtures/golden-nutterfly.json', import.meta.url), 'utf8')) as Array<{
        mode: string
        date: string
        outcome: string
        totalPnl: number | null
        events: Array<{ t: string; kind: string; cash: number | null; detail: string }>
      }>
      // Event text gained ", IV x%" in 0aa03c3 after the golden rows were made.
      const norm = (s: string) => s.replace(/, IV [^%)]*%/, '')
      let fails = 0
      for (const g of golden) {
        const def = STRATEGIES[g.mode === 'bt_nutter5' ? 'nutterfly5' : 'nutterfly10']
        if (!(await readManifest(env.OPT_DATA_DIR, g.date))) {
          console.log(`SKIP ${g.date} ${g.mode}: no DayPack`)
          continue
        }
        const r = await runPassDay(pool, logger, env.OPT_DATA_DIR, def, def.preset, g.date, `accept_${g.mode}`)
        const got = r.events.map((e) => `${e.t} ${e.kind} ${Math.round(e.cash ?? 0)} ${norm(e.detail)}`)
        const want = g.events.map((e) => `${e.t} ${e.kind} ${Math.round(e.cash ?? 0)} ${norm(e.detail)}`)
        const same = r.pnl === g.totalPnl && r.outcome === g.outcome && JSON.stringify(got) === JSON.stringify(want)
        if (!same) fails++
        console.log(`${same ? 'PASS' : 'FAIL'} ${g.date} ${g.mode.padEnd(12)} want ${usd(g.totalPnl)} "${g.outcome}"  got ${usd(r.pnl)} "${r.outcome}"`)
        if (!same) {
          for (let i = 0; i < Math.max(got.length, want.length); i++) {
            if (got[i] !== want[i]) console.log(`   want: ${want[i] ?? '(none)'}\n   got:  ${got[i] ?? '(none)'}`)
          }
        }
        if (r.tickErrors) console.log(`   tickErrors=${r.tickErrors}: ${r.firstError}`)
      }
      console.log(fails ? `\n${fails} FAILED` : '\nall passed')
      process.exitCode = fails ? 1 : 0
    } finally {
      await pool.end()
      await admin.end()
    }
    return
  }

  console.error('usage: opt pull|pass|generic|accept  (see src/cli.ts header)')
  process.exitCode = 2
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
