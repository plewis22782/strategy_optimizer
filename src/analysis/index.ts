// Entry point: compute a run's statistics, hand them to the local model for
// narration, and persist the result on runs.analysis. On-demand only (called
// from a route), never automatically after a run finishes.
import type pg from 'pg'
import { computeSummary, type ComputedSummary } from './summary.js'
import { narrate, type OllamaConfig } from './llm.js'

export interface RunAnalysis {
  computedAt: string
  model: string
  summary: ComputedSummary
  narrative: string
}

export async function analyzeRun(db: pg.Pool, runId: number, ollama: OllamaConfig): Promise<RunAnalysis> {
  const summary = await computeSummary(db, runId)
  const narrative = await narrate(ollama, summary)
  const analysis: RunAnalysis = { computedAt: new Date().toISOString(), model: ollama.model, summary, narrative }
  await db.query(`UPDATE runs SET analysis = $2 WHERE id = $1`, [runId, JSON.stringify(analysis)])
  return analysis
}

export type { ComputedSummary }
