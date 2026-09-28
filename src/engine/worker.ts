// One optimizer worker process (forked by pool.ts). Owns sim schema
// sim_w<N>, keeps parsed DayPacks in memory across passes, and evaluates
// (pass, session) tasks one at a time: run the strategy's real tick over the
// session, reply with the day's result. Events are dropped here -- a pass's
// full trade log is re-derived on demand by replaying it (deterministic).
import 'dotenv/config'
import pg from 'pg'
import pino from 'pino'
import { ensureSimSchema, simPool } from '../sim/db.js'
import { getStrategy, type ParamValue } from '../strategies/registry.js'
import { runPassDay, type DayResult } from './pass.js'

export interface WorkerTask {
  id: number
  strategy: string
  params: Record<string, ParamValue>
  date: string
  mode: string
  keepEvents?: boolean
}
export type WorkerReply =
  | { id: number; ok: true; day: DayResult; ms: number }
  | { id: number; ok: false; error: string }
  | { ready: true }

const worker = Number(process.env.OPT_WORKER_ID)
const dataRoot = process.env.OPT_DATA_DIR ?? '/data'
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, pino.destination(2))

async function main(): Promise<void> {
  const schema = `sim_w${worker}`
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  await ensureSimSchema(admin, schema)
  await admin.end()
  const pool = simPool(process.env.DATABASE_URL!, schema, 2)

  process.on('message', async (t: WorkerTask) => {
    const t0 = Date.now()
    try {
      const day = await runPassDay(pool, logger, dataRoot, getStrategy(t.strategy), t.params, t.date, t.mode)
      if (!t.keepEvents) day.events = []
      process.send!({ id: t.id, ok: true, day, ms: Date.now() - t0 } satisfies WorkerReply)
    } catch (err) {
      process.send!({ id: t.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply)
    }
  })
  process.send!({ ready: true } satisfies WorkerReply)
}

main().catch((err) => {
  console.error(`worker ${worker} failed to start:`, err)
  process.exit(1)
})
