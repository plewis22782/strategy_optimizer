// opt <command>
//   pull   --dates 2026-09-15,2026-09-16 | --from 2026-09-15 --to 2026-09-23  [--force]
//          Pull DayPacks from The Well (after hours only unless --force).
//   pass   --strategy nutterfly5 --dates ... [--params '{"stopMin":60}']
//          Run one pass from the packs and print per-day results + metrics.
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
import { passMetrics } from './engine/metrics.js'

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
        const m = await pullDay(well, env.OPT_DATA_DIR, d, ref, env.WELL_API_URL, logger, { force: flag('force') })
        const checks = Object.entries(m.checks).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL'}(${v.detail})`).join('  ')
        const bars = m.bars.map((b) => `${b.table}=${b.rows}`).join(' ')
        console.log(`${d}  ${((Date.now() - t0) / 1000).toFixed(0)}s  chain rows=${m.chains[0]?.rows}  ${bars}\n            ${checks}`)
      } catch (err) {
        console.log(`${d}  FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }
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

  console.error('usage: opt pull|pass|accept  (see src/cli.ts header)')
  process.exitCode = 2
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
