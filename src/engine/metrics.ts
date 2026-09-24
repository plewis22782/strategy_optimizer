// Pass-level metrics over its sessions -- the MT5 criteria, adapted to
// session-sized paper trades. A no-entry day is a 0 P&L day for equity/
// drawdown/Sharpe (capital sat idle) but isn't counted as a trade.
import type { DayResult } from './pass.js'

export interface PassMetrics {
  days: number
  tradedDays: number
  noEntryDays: number
  totalPnl: number
  wins: number // traded days with pnl > 0
  losses: number
  grossWin: number
  grossLoss: number // positive number
  profitFactor: number | null // grossWin / grossLoss (null when no losses)
  expectancy: number | null // mean pnl per traded day
  maxDrawdown: number // peak-to-trough on the daily equity curve, positive $
  recoveryFactor: number | null // totalPnl / maxDrawdown
  sharpe: number | null // mean/std of daily pnl (all days), not annualised
  flies: number
  completed: number
  aborted: number
  completionRate: number | null // completed / flies
  wingCapital: number
  ror: number | null // totalPnl / wingCapital
  tickErrors: number
}

export type Criterion =
  | 'totalPnl'
  | 'profitFactor'
  | 'expectancy'
  | 'maxDrawdown'
  | 'recoveryFactor'
  | 'sharpe'
  | 'completionRate'
  | 'complex'

export function passMetrics(days: DayResult[]): PassMetrics {
  const pnl = days.map((d) => (d.noEntry ? 0 : (d.pnl ?? 0)))
  const traded = days.filter((d) => !d.noEntry)
  let eq = 0
  let peak = 0
  let maxDD = 0
  for (const p of pnl) {
    eq += p
    peak = Math.max(peak, eq)
    maxDD = Math.max(maxDD, peak - eq)
  }
  const totalPnl = pnl.reduce((a, b) => a + b, 0)
  const tpnl = traded.map((d) => d.pnl ?? 0)
  const grossWin = tpnl.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const grossLoss = -tpnl.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  const mean = pnl.length ? totalPnl / pnl.length : 0
  const sd = pnl.length > 1 ? Math.sqrt(pnl.reduce((a, x) => a + (x - mean) ** 2, 0) / (pnl.length - 1)) : 0
  const num = (k: string) => traded.reduce((a, d) => a + (Number(d.result?.[k]) || 0), 0)
  const flies = num('butterflies')
  const completed = num('completed')
  const wingCapital = num('wingCapital')
  return {
    days: days.length,
    tradedDays: traded.length,
    noEntryDays: days.length - traded.length,
    totalPnl,
    wins: tpnl.filter((x) => x > 0).length,
    losses: tpnl.filter((x) => x < 0).length,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: traded.length ? tpnl.reduce((a, b) => a + b, 0) / traded.length : null,
    maxDrawdown: maxDD,
    recoveryFactor: maxDD > 0 ? totalPnl / maxDD : null,
    sharpe: sd > 0 ? mean / sd : null,
    flies,
    completed,
    aborted: num('aborted'),
    completionRate: flies > 0 ? completed / flies : null,
    wingCapital,
    ror: wingCapital > 0 ? totalPnl / wingCapital : null,
    tickErrors: days.reduce((a, d) => a + d.tickErrors, 0)
  }
}

/** Higher is always better (maxDrawdown is negated), so search can maximise
 *  one number. Null metrics rank last. 'complex' blends the MT5 way: reward
 *  P&L and recovery, penalise drawdown and too few trades. */
export function criterionValue(m: PassMetrics, c: Criterion): number {
  const v = (x: number | null) => (x == null || !Number.isFinite(x) ? -Infinity : x)
  switch (c) {
    case 'totalPnl':
      return m.totalPnl
    case 'profitFactor':
      return m.grossLoss === 0 ? (m.grossWin > 0 ? 1e6 : -Infinity) : v(m.profitFactor)
    case 'expectancy':
      return v(m.expectancy)
    case 'maxDrawdown':
      return -m.maxDrawdown
    case 'recoveryFactor':
      return m.maxDrawdown === 0 ? (m.totalPnl > 0 ? 1e6 : m.totalPnl) : v(m.recoveryFactor)
    case 'sharpe':
      return v(m.sharpe)
    case 'completionRate':
      return v(m.completionRate)
    case 'complex': {
      if (m.tradedDays === 0) return -Infinity
      const tradePenalty = Math.min(1, m.tradedDays / 5) // thin samples shrink toward 0
      return (m.totalPnl - 0.5 * m.maxDrawdown) * tradePenalty
    }
  }
}
