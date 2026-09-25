// Interpreter for a GenericSpec: walks the symbol's sessions, opens the
// spec'd structure at the entry time, manages it across days (weeklies,
// monthlies, 45 DTE) and closes it on the first exit rule that fires.
//
// Pricing, per leg:
//   trigger  profit target / stop are judged on the MID mark (what a broker
//            watches), so a wide market doesn't fake a stop-out
//   fill     natural by default: sell at mid - h, buy at mid + h, where h is
//            spreadMult x half the chain's spread (the chain is pulled at 1x:
//            real quotes, or The Well's modeled spread on Massive history)
//   expiry   still open at the close of expiration day -> settled at
//            intrinsic on that close (cash; no assignment/early exercise)
// Equity is marked to market every session close, so drawdown inside a
// 45-day hold counts, not just realized P&L.
import { etWallToUtcMs } from '../sc.js'
import type { PassMetrics } from '../engine/metrics.js'
import { legKey, type ChainRow, type ChainSlice, type ChainSource, type SessionChain } from './chains.js'
import type { GenericSpec, Leg } from './spec.js'

const MULT = 100
const DAY_MS = 86_400_000

export interface OpenLeg {
  cp: 'call' | 'put'
  side: 'long' | 'short'
  qty: number
  k: number
  openPx: number
}

export type ExitReason = 'target' | 'stop' | 'dte' | 'time' | 'maxHold' | 'expiry' | 'endOfData'

export interface Trade {
  id: number
  expiration: string
  openDate: string
  openTime: string
  dteAtOpen: number
  spotOpen: number
  atmIvOpen: number | null
  legs: OpenLeg[]
  entryCash: number // + credit / - debit, $ (x100), before commissions
  maxLoss: number | null // $ at expiry, null = unbounded
  exitDate: string | null
  exitTime: string | null
  exitReason: ExitReason | null
  exitCash: number | null
  spotClose: number | null
  commissions: number
  pnl: number | null // entryCash + exitCash - commissions
  sessionsHeld: number
}

export interface SkippedEntry {
  date: string
  reason: string
}

export interface GenericResult {
  spec: GenericSpec
  from: string
  to: string
  sessions: number
  trades: Trade[]
  skipped: SkippedEntry[]
  equity: Array<{ date: string; realized: number; mtm: number }>
  chainSources: Record<string, number> // source -> chains used
  metrics: PassMetrics
}

// ------------------------------------------------------------ small helpers

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)
const isoWeekday = (d: string) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1 // 1=Mon
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const hm = (s: string) => s.split(':').map(Number) as [number, number]
const etHHMM = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)

function nearest(strikes: number[], target: number): number | null {
  let best: number | null = null
  for (const k of strikes) if (best === null || Math.abs(k - target) < Math.abs(best - target)) best = k
  return best
}

/** Price one leg for a fill (natural or mid), or its mid mark. */
function legPx(row: ChainRow | undefined, action: 'buy' | 'sell' | 'mark', spec: GenericSpec): number | null {
  if (!row || row.mid == null) return null
  if (action === 'mark' || spec.costs.fill === 'mid') return row.mid
  const half = row.bid != null && row.ask != null ? ((row.ask - row.bid) / 2) * spec.costs.spreadMult : 0
  return action === 'buy' ? row.mid + half : Math.max(0, row.mid - half)
}

/** Cash to close every leg now ($, + = received); null if any leg can't be priced. */
function closeCash(legs: OpenLeg[], slice: ChainSlice | null, action: 'fill' | 'mark', spec: GenericSpec): number | null {
  if (!slice) return null
  let cash = 0
  for (const l of legs) {
    const row = slice.byKey.get(legKey(l.k, l.cp))
    const px = legPx(row, action === 'mark' ? 'mark' : l.side === 'short' ? 'buy' : 'sell', spec)
    if (px == null) return null
    cash += (l.side === 'short' ? -px : px) * l.qty * MULT
  }
  return cash
}

function intrinsicCash(legs: OpenLeg[], spot: number): number {
  let cash = 0
  for (const l of legs) {
    const iv = l.cp === 'call' ? Math.max(0, spot - l.k) : Math.max(0, l.k - spot)
    cash += (l.side === 'short' ? -iv : iv) * l.qty * MULT
  }
  return cash
}

/** Worst expiry P&L (including the entry cash); null when a side is unbounded. */
function maxLossAtExpiry(legs: OpenLeg[], entryCash: number): number | null {
  // Payoff is piecewise linear in spot: check 0, every strike, and the
  // slope beyond the top strike (net long calls >= 0, else unbounded).
  const netCalls = legs.reduce((a, l) => a + (l.cp === 'call' ? (l.side === 'long' ? l.qty : -l.qty) : 0), 0)
  if (netCalls < 0) return null
  const pts = [0, ...legs.map((l) => l.k)]
  let worst = Infinity
  for (const s of pts) worst = Math.min(worst, entryCash + intrinsicCash(legs, s))
  return Math.max(0, -worst)
}

/** Expirations inside [dteMin, dteMax], closest to targetDte first (ties -> earlier).
 *  The list is every expiration EVER seen, so the caller must confirm one
 *  was actually listed on `date` (weeklies appear ~5 weeks out: on
 *  2026-06-15 AAPL had no 07-29 yet) -- see firstListed(). */
function expirationCandidates(exps: string[], date: string, spec: GenericSpec): string[] {
  return exps
    .map((e) => ({ e, dte: daysBetween(date, e) }))
    .filter((x) => x.dte >= spec.entry.dteMin && x.dte <= spec.entry.dteMax)
    .sort((a, b) => Math.abs(a.dte - spec.entry.targetDte) - Math.abs(b.dte - spec.entry.targetDte) || a.dte - b.dte)
    .map((x) => x.e)
}

function pickStrike(leg: Leg, chosen: OpenLeg[], slice: ChainSlice, spot: number): number | null {
  const listed = slice.strikes.filter((k) => slice.byKey.get(legKey(k, leg.cp))?.mid != null)
  const r = leg.strike
  switch (r.by) {
    case 'atm':
      return nearest(listed, spot)
    case 'offset':
      return nearest(listed, spot + r.value)
    case 'pctOtm':
      return nearest(listed, leg.cp === 'call' ? spot * (1 + r.value) : spot * (1 - r.value))
    case 'delta': {
      let best: number | null = null
      let bestGap = Infinity
      for (const k of listed) {
        const d = slice.byKey.get(legKey(k, leg.cp))?.delta
        if (d == null) continue
        const gap = Math.abs(Math.abs(d) - r.value)
        if (gap < bestGap) {
          best = k
          bestGap = gap
        }
      }
      return best
    }
    case 'width': {
      const base = chosen[r.leg]?.k
      if (base == null) return null
      const dir = (leg.cp === 'call' ? 1 : -1) * Math.sign(r.value || 1)
      // strictly beyond the base strike in the asked direction, so a width
      // smaller than the strike spacing never collapses onto the base
      const side = listed.filter((k) => (dir > 0 ? k > base : k < base))
      return nearest(side, base + (leg.cp === 'call' ? r.value : -r.value))
    }
  }
}

// ------------------------------------------------------------ the run

export async function runGeneric(spec: GenericSpec, src: ChainSource, from: string, to: string): Promise<GenericResult> {
  const sym = spec.symbol
  const smaDays = spec.entry.filters.trend?.smaDays ?? 0
  // Calendar = the symbol's own daily candles (holidays drop out); pulled
  // with enough lead for the trend filter's moving average.
  const daily = await src.daily(sym, addDays(from, -Math.ceil(smaDays * 1.6) - 10), to)
  const closes = daily.map((d) => d.close)
  const sessions = daily.map((d) => d.date).filter((d) => d >= from && d <= to)
  const exps = [...(await src.expirations(sym))].sort()

  const trades: Trade[] = []
  const open: Trade[] = []
  const skipped: SkippedEntry[] = []
  const equity: GenericResult['equity'] = []
  const chainSources: Record<string, number> = {}
  let realized = 0
  let nextId = 1
  const commissionFor = (legs: OpenLeg[]) => legs.reduce((a, l) => a + l.qty, 0) * spec.costs.commissionPerContract

  const close = (p: Trade, date: string, t: number | null, reason: ExitReason, cash: number, spot: number | null, commission: boolean) => {
    p.exitDate = date
    p.exitTime = t == null ? '16:00' : etHHMM(t)
    p.exitReason = reason
    p.exitCash = cash
    p.spotClose = spot
    if (commission) p.commissions += commissionFor(p.legs)
    p.pnl = p.entryCash + cash - p.commissions
    realized += p.pnl
    open.splice(open.indexOf(p), 1)
  }

  for (const date of sessions) {
    const di = daily.findIndex((d) => d.date === date)
    const wantsEntry = spec.entry.weekdays.includes(isoWeekday(date)) && open.length < spec.entry.maxOpen
    const candidates = wantsEntry ? expirationCandidates(exps, date, spec) : []
    if (wantsEntry && !candidates.length) skipped.push({ date, reason: `no expiration within ${spec.entry.dteMin}-${spec.entry.dteMax} DTE` })

    // Trend filter: prior session's close vs the SMA of the N closes before
    // today (both known before the open -- no look-ahead).
    let trendOk = true
    if (candidates.length && spec.entry.filters.trend) {
      const { smaDays: n, require } = spec.entry.filters.trend
      if (di < n) {
        trendOk = false
        skipped.push({ date, reason: `trend: fewer than ${n} prior closes` })
      } else {
        const win = closes.slice(di - n, di)
        const sma = win.reduce((a, b) => a + b, 0) / n
        const prev = closes[di - 1]
        trendOk = require === 'above' ? prev > sma : prev < sma
        if (!trendOk) skipped.push({ date, reason: `trend: prior close ${prev.toFixed(2)} not ${require} SMA${n} ${sma.toFixed(2)}` })
      }
    }

    const chains = new Map<string, SessionChain>()
    const load = async (e: string) => {
      const c = await src.chain(sym, e, date, spec.bucketSec)
      chains.set(e, c)
      chainSources[c.payload.source] = (chainSources[c.payload.source] ?? 0) + 1
      return c
    }
    for (const e of new Set(open.map((p) => p.expiration))) await load(e)
    // Entry expiration: the closest candidate that was really listed today
    // (has contracts in today's chain).
    let entryExp: string | null = null
    if (candidates.length && trendOk) {
      for (const e of candidates) {
        const c = chains.get(e) ?? (await load(e))
        if (c.times.length) {
          entryExp = e
          break
        }
        chains.delete(e)
      }
      if (!entryExp) skipped.push({ date, reason: `none of ${candidates.length} expirations in ${spec.entry.dteMin}-${spec.entry.dteMax} DTE had a priced chain` })
    }
    for (const p of open) {
      if (!chains.get(p.expiration)?.times.length) skipped.push({ date, reason: `trade ${p.id}: no ${p.expiration} chain today (held unmarked)` })
    }
    const times = [...new Set([...chains.values()].flatMap((c) => c.times))].sort((a, b) => a - b)
    for (const p of open) p.sessionsHeld++

    const [eh, em] = hm(spec.entry.timeEt)
    const entryAt = etWallToUtcMs(date, eh, em)
    const exitAt = spec.exit.timeEt ? etWallToUtcMs(date, ...hm(spec.exit.timeEt)) : Infinity
    let entryTried = !(entryExp && trendOk)

    for (const t of times) {
      // ---- exits first (a position opened this bucket isn't re-checked until the next)
      for (const p of [...open]) {
        const slice = chains.get(p.expiration)?.at(t) ?? null
        const mark = closeCash(p.legs, slice, 'mark', spec)
        if (mark == null) continue // can't price every leg this bucket -- hold
        const basis = Math.abs(p.entryCash)
        const markPnl = p.entryCash + mark
        let reason: ExitReason | null = null
        if (spec.exit.profitTargetPct != null && basis > 0 && markPnl >= (spec.exit.profitTargetPct / 100) * basis) reason = 'target'
        else if (spec.exit.stopLossPct != null && basis > 0 && markPnl <= -(spec.exit.stopLossPct / 100) * basis) reason = 'stop'
        else if (spec.exit.exitDte != null && daysBetween(date, p.expiration) <= spec.exit.exitDte && p.openDate !== date) reason = 'dte'
        else if (spec.exit.maxHoldDays != null && p.sessionsHeld >= spec.exit.maxHoldDays) reason = 'maxHold'
        else if (t >= exitAt && !(p.openDate === date && t <= entryAt)) reason = 'time'
        if (!reason) continue
        const fill = closeCash(p.legs, slice, 'fill', spec)
        if (fill == null) continue
        close(p, date, t, reason, fill, slice?.spot ?? null, true)
      }

      // ---- entry: the first bucket at/after the entry time
      if (!entryTried && t >= entryAt && entryExp) {
        entryTried = true
        const slice = chains.get(entryExp)?.at(t) ?? null
        const spot = slice?.spot
        if (!slice || spot == null) {
          skipped.push({ date, reason: `no ${entryExp} chain/spot at ${spec.entry.timeEt}` })
          continue
        }
        const legs: OpenLeg[] = []
        let fail: string | null = null
        for (const [i, leg] of spec.entry.legs.entries()) {
          const k = pickStrike(leg, legs, slice, spot)
          const row = k == null ? undefined : slice.byKey.get(legKey(k, leg.cp))
          const px = legPx(row, leg.side === 'short' ? 'sell' : 'buy', spec)
          if (k == null || px == null) {
            fail = `leg ${i} (${leg.side} ${leg.cp} ${leg.strike.by}): no priced strike`
            break
          }
          legs.push({ cp: leg.cp, side: leg.side, qty: leg.qty, k, openPx: px })
        }
        if (fail) {
          skipped.push({ date, reason: fail })
          continue
        }
        const entryCash = legs.reduce((a, l) => a + (l.side === 'short' ? l.openPx : -l.openPx) * l.qty * MULT, 0)
        const f = spec.entry.filters
        const atm = nearest(slice.strikes, spot)
        const atmIv = atm == null ? null : (slice.byKey.get(legKey(atm, 'call'))?.iv ?? slice.byKey.get(legKey(atm, 'put'))?.iv ?? null)
        const why =
          f.minCredit != null && entryCash < f.minCredit
            ? `credit ${entryCash.toFixed(0)} < min ${f.minCredit}`
            : f.maxDebit != null && -entryCash > f.maxDebit
              ? `debit ${(-entryCash).toFixed(0)} > max ${f.maxDebit}`
              : f.atmIvMin != null && (atmIv == null || atmIv < f.atmIvMin)
                ? `ATM IV ${atmIv?.toFixed(3)} < ${f.atmIvMin}`
                : f.atmIvMax != null && (atmIv == null || atmIv > f.atmIvMax)
                  ? `ATM IV ${atmIv?.toFixed(3)} > ${f.atmIvMax}`
                  : null
        if (why) {
          skipped.push({ date, reason: why })
          continue
        }
        const tr: Trade = {
          id: nextId++,
          expiration: entryExp,
          openDate: date,
          openTime: etHHMM(t),
          dteAtOpen: daysBetween(date, entryExp),
          spotOpen: spot,
          atmIvOpen: atmIv,
          legs,
          entryCash,
          maxLoss: maxLossAtExpiry(legs, entryCash),
          exitDate: null,
          exitTime: null,
          exitReason: null,
          exitCash: null,
          spotClose: null,
          commissions: commissionFor(legs),
          pnl: null,
          sessionsHeld: 0
        }
        trades.push(tr)
        open.push(tr)
      }
    }

    // ---- expiration-day settlement at the close
    for (const p of [...open]) {
      if (p.expiration > date) continue
      const spot = chains.get(p.expiration)?.lastSpot() ?? null
      if (spot == null) {
        // no spot on expiry day: settle on the prior candle's close? No --
        // leave it unsettled and loud rather than invent a price.
        skipped.push({ date, reason: `trade ${p.id}: no spot to settle ${p.expiration}; left open` })
        continue
      }
      close(p, date, null, 'expiry', intrinsicCash(p.legs, spot), spot, false)
    }

    // ---- mark-to-market equity at the close
    let unreal = 0
    for (const p of open) {
      const c = chains.get(p.expiration)
      const m = c ? closeCash(p.legs, c.at(Number.MAX_SAFE_INTEGER), 'mark', spec) : null
      if (m != null) unreal += p.entryCash + m - p.commissions
    }
    equity.push({ date, realized, mtm: realized + unreal })
  }

  // Positions still open when the data ends: marked at the last mid, flagged.
  const last = sessions[sessions.length - 1]
  for (const p of [...open]) {
    const c = last ? await src.chain(sym, p.expiration, last, spec.bucketSec) : null
    const m = c ? closeCash(p.legs, c.at(Number.MAX_SAFE_INTEGER), 'mark', spec) : null
    if (m != null) {
      close(p, last ?? p.openDate, null, 'endOfData', m, c?.lastSpot() ?? null, false)
    } else {
      // unmarkable: no P&L rather than an invented one
      p.exitDate = last ?? p.openDate
      p.exitReason = 'endOfData'
      open.splice(open.indexOf(p), 1)
      skipped.push({ date: p.exitDate, reason: `trade ${p.id}: open at end of data and unmarkable; pnl left null` })
    }
  }

  return { spec, from, to, sessions: sessions.length, trades, skipped, equity, chainSources, metrics: genericMetrics(trades, equity) }
}

/** The optimizer's PassMetrics, from trades + the daily MTM curve, so the
 *  same criteria rank generic passes. Field meanings for generic runs:
 *  tradedDays = trades, flies = trades, completed = winners (completionRate =
 *  win rate), wingCapital = summed max loss (0 if any trade is unbounded,
 *  making ror null). */
export function genericMetrics(trades: Trade[], equity: GenericResult['equity']): PassMetrics {
  const pnls = trades.map((t) => t.pnl ?? 0)
  const grossWin = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const grossLoss = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  let peak = 0
  let maxDD = 0
  for (const e of equity) {
    peak = Math.max(peak, e.mtm)
    maxDD = Math.max(maxDD, peak - e.mtm)
  }
  const daily = equity.map((e, i) => e.mtm - (i ? equity[i - 1].mtm : 0))
  const mean = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((a, x) => a + (x - mean) ** 2, 0) / (daily.length - 1)) : 0
  const totalPnl = pnls.reduce((a, b) => a + b, 0)
  const wins = pnls.filter((x) => x > 0).length
  const unbounded = trades.some((t) => t.maxLoss == null)
  const wingCapital = unbounded ? 0 : trades.reduce((a, t) => a + (t.maxLoss ?? 0), 0)
  return {
    days: equity.length,
    tradedDays: trades.length,
    noEntryDays: equity.length - new Set(trades.map((t) => t.openDate)).size,
    totalPnl,
    wins,
    losses: pnls.filter((x) => x < 0).length,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: trades.length ? totalPnl / trades.length : null,
    maxDrawdown: maxDD,
    recoveryFactor: maxDD > 0 ? totalPnl / maxDD : null,
    sharpe: sd > 0 ? mean / sd : null,
    flies: trades.length,
    completed: wins,
    aborted: trades.length - wins,
    completionRate: trades.length ? wins / trades.length : null,
    wingCapital,
    ror: wingCapital > 0 ? totalPnl / wingCapital : null,
    tickErrors: 0
  }
}
