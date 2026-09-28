// A fixed pool of worker processes -- its size IS the optimizer's CPU cap
// (Redfish: ~30 of 72 threads; the local AI uses about half the box). Each
// worker handles one (pass, session) task at a time; tasks queue here.
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { WorkerReply, WorkerTask } from './worker.js'
import type { DayResult } from './pass.js'

interface Pending {
  task: WorkerTask
  resolve: (d: { day: DayResult; ms: number }) => void
  reject: (e: Error) => void
}

export class WorkerPool {
  private workers: Array<{ proc: ChildProcess; busy: Pending | null; ready: boolean }> = []
  private queue: Pending[] = []
  private nextId = 1
  private closed = false

  constructor(readonly size: number) {
    const entry = fileURLToPath(new URL('./worker.ts', import.meta.url))
    for (let i = 0; i < size; i++) {
      const proc = fork(entry, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, OPT_WORKER_ID: String(i) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      const w = { proc, busy: null as Pending | null, ready: false }
      proc.on('message', (m: WorkerReply) => {
        if ('ready' in m) {
          w.ready = true
          this.pump()
          return
        }
        const p = w.busy
        w.busy = null
        if (p) {
          if (m.ok) p.resolve({ day: m.day, ms: m.ms })
          else p.reject(new Error(m.error))
        }
        this.pump()
      })
      proc.on('exit', (code) => {
        if (this.closed) return
        const p = w.busy
        w.busy = null
        w.ready = false
        if (p) p.reject(new Error(`worker ${i} exited (${code}) mid-task`))
      })
      this.workers.push(w)
    }
  }

  run(task: Omit<WorkerTask, 'id'>): Promise<{ day: DayResult; ms: number }> {
    if (this.closed) return Promise.reject(new Error('pool closed'))
    return new Promise((resolve, reject) => {
      this.queue.push({ task: { ...task, id: this.nextId++ }, resolve, reject })
      this.pump()
    })
  }

  /** Drop everything still queued (running tasks finish). */
  clearQueue(reason: string): void {
    for (const p of this.queue.splice(0)) p.reject(new Error(reason))
  }

  get pending(): number {
    return this.queue.length + this.workers.filter((w) => w.busy).length
  }

  private pump(): void {
    for (const w of this.workers) {
      if (!w.ready || w.busy) continue
      const next = this.queue.shift()
      if (!next) return
      w.busy = next
      w.proc.send(next.task)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearQueue('pool closed')
    for (const w of this.workers) w.proc.kill()
  }
}
