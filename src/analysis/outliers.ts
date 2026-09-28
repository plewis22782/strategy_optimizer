// "Best" by raw totalPnl can be one freak session carrying the rest. For the
// top-N back passes by criterion, pull the per-session P&L and re-rank by a
// robustified view (trimmed mean), reporting where the ranking changes.
import type { ParamValue } from '../strategies/registry.js'
import { median, trimmedMean } from './stats.js'

export interface OutlierPass {
  passId: number
  varied: Record<string, ParamValue>
  rawCriterion: number
  rawRank: number // 1 = best by raw criterion
  sessionCount: number
  medianPnl: number
  trimmedMeanPnl: number
  worstSessionPnl: number // most negative session (0 if none negative)
  bestSessionPnl: number // most positive session
  totalPnl: number
  /** |best session pnl| / |totalPnl| -- close to 1 means one session carried the pass. */
  bestSessionShareOfTotal: number | null
  robustRank: number // 1 = best by trimmedMeanPnl
  rankChange: number // rawRank - robustRank; positive = this pass fell once outliers are trimmed
}

interface TopPassInput {
  passId: number
  varied: Record<string, ParamValue>
  criterion: number
  days: Array<{ pnl: number | null }>
}

export function rerankByOutliers(topPasses: TopPassInput[]): OutlierPass[] {
  const byRaw = [...topPasses].sort((a, b) => b.criterion - a.criterion)
  const prelim = byRaw.map((p, i) => {
    const pnls = p.days.map((d) => d.pnl ?? 0)
    const totalPnl = pnls.reduce((a, b) => a + b, 0)
    const trimN = pnls.length >= 5 ? Math.max(1, Math.floor(pnls.length * 0.1)) : 0
    const worst = pnls.length ? Math.min(...pnls, 0) : 0
    const best = pnls.length ? Math.max(...pnls, 0) : 0
    const carrier = Math.abs(best) >= Math.abs(worst) ? best : worst
    return {
      passId: p.passId,
      varied: p.varied,
      rawCriterion: p.criterion,
      rawRank: i + 1,
      sessionCount: pnls.length,
      medianPnl: median(pnls),
      trimmedMeanPnl: trimmedMean(pnls, trimN),
      worstSessionPnl: worst,
      bestSessionPnl: best,
      totalPnl,
      bestSessionShareOfTotal: totalPnl !== 0 ? Math.abs(carrier) / Math.abs(totalPnl) : null
    }
  })
  const byRobust = [...prelim].sort((a, b) => b.trimmedMeanPnl - a.trimmedMeanPnl)
  const robustRankOf = new Map(byRobust.map((p, i) => [p.passId, i + 1]))
  return prelim.map((p) => {
    const robustRank = robustRankOf.get(p.passId) as number
    return { ...p, robustRank, rankChange: p.rawRank - robustRank }
  })
}
