// Turns a ComputedSummary into readable prose + recommendations. The model
// only ever narrates numbers that are already in the summary -- it never
// sees raw passes and is told not to invent figures.
import { Agent, fetch } from 'undici'
import type { ComputedSummary } from './summary.js'

export interface OllamaConfig {
  url: string // e.g. http://host.docker.internal:11434
  model: string
  timeoutMs: number
}

const SYSTEM_PROMPT = `You are a quant analyst reviewing the results of a parameter-optimization sweep for an options-trading paper strategy.
You are given a JSON object of statistics computed deterministically from the run's actual passes -- eta-squared parameter sensitivity, a top-passes outlier re-ranking, back-vs-forward overfitting gaps, grid-neighbor stability, and search-budget numbers.
Rules:
- Use ONLY the numbers in the JSON. Never invent a figure, a parameter name, or a value that isn't there.
- If "thinSample" is true, open your report with an explicit, unambiguous caveat about the small session count before any conclusion -- do not bury it.
- Write plain, direct prose for a trader who already knows the strategy; no filler, no restating the JSON schema.
- Structure your reply with these four "## " headings, in this order: "## Key drivers", "## Robust vs. lucky settings", "## Overfitting risk", "## Suggestions for the next search".
- Keep it tight: a few sentences to a short paragraph per section, plus bullet points where a list is clearer.`

/** Ollama (as of 0.34) doesn't reliably honor "think": false for qwen3's
 *  hybrid thinking mode -- it can still emit a thinking preamble ending in a
 *  stray "</think>" with no matching opening tag. Take whatever comes after
 *  the LAST "</think>" as the answer.
 *
 *  If a "<think>" opened but never closed, the model burned its whole
 *  num_predict budget on reasoning and never wrote the actual report --
 *  confirmed live 2026-09-29 (run #21's stored "narrative" was mid-sentence
 *  raw chain-of-thought, not the four "## " sections asked for). That's a
 *  real failure, not a usable-but-unlabelled answer -- throw so the caller
 *  surfaces it as an error instead of silently storing garbage as if it
 *  were a valid report. */
function stripThinking(text: string): string {
  const openIdx = text.indexOf('<think>')
  const closeIdx = text.lastIndexOf('</think>')
  if (openIdx >= 0 && closeIdx < openIdx) {
    throw new Error('model exceeded its thinking budget before writing an answer -- raise num_predict or retry')
  }
  const after = closeIdx >= 0 ? text.slice(closeIdx + '</think>'.length) : text
  return after.trim() || text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

export async function narrate(cfg: OllamaConfig, summary: ComputedSummary): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  // Global fetch (undici)'s default headersTimeout/bodyTimeout is 300s,
  // independent of any AbortSignal -- it was killing this call long before
  // cfg.timeoutMs (confirmed live 2026-10-02: "HeadersTimeoutError" even
  // after the proxy's own timeout was raised). A dedicated Agent with a
  // longer timeout than our own AbortController lets OUR timeout fire first,
  // so a genuine timeout still surfaces as the clear message below.
  const dispatcher = new Agent({ headersTimeout: cfg.timeoutMs + 5_000, bodyTimeout: cfg.timeoutMs + 5_000 })
  try {
    const res = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      dispatcher,
      body: JSON.stringify({
        model: cfg.model,
        think: false,
        stream: false,
        options: { temperature: 0.2, num_predict: 6000 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(summary) }
        ]
      })
    })
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = (await res.json()) as { message?: { content?: string } }
    const content = data.message?.content
    if (!content) throw new Error('ollama returned no content')
    return stripThinking(content)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`ollama timed out after ${cfg.timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
    void dispatcher.close()
  }
}
