// A GENERIC options strategy: plain JSON, zod-validated, interpreted by
// engine.ts -- so any strategy on any ticker (verticals, condors, strangles,
// short puts, calendars' same-expiry cousins...) can be described, swept and
// tested without writing code. Same rule as the TestSpec: a person or an AI
// composes these from the primitives below; nothing here is executable.
//
// Everything is per contract (x100) and paper-only.
import { z } from 'zod'

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (ET)')

/** How a leg picks its strike at entry (nearest listed strike with a price). */
export const StrikeRule = z.discriminatedUnion('by', [
  // |delta| closest to value (0.30 = a 30-delta call or put)
  z.object({ by: z.literal('delta'), value: z.number().gt(0).lt(1) }),
  // percent out of the money: calls spot*(1+v), puts spot*(1-v); negative = ITM
  z.object({ by: z.literal('pctOtm'), value: z.number().gt(-0.5).lt(0.5) }),
  // absolute points from spot, signed (+ above spot, - below)
  z.object({ by: z.literal('offset'), value: z.number() }),
  z.object({ by: z.literal('atm') }),
  // relative to an EARLIER leg's strike, `value` points further out of the
  // money for this leg's type (calls up, puts down); negative = toward spot
  z.object({ by: z.literal('width'), leg: z.number().int().nonnegative(), value: z.number() })
])
export type StrikeRule = z.infer<typeof StrikeRule>

export const Leg = z.object({
  cp: z.enum(['call', 'put']),
  side: z.enum(['long', 'short']),
  qty: z.number().int().positive().default(1),
  strike: StrikeRule
})
export type Leg = z.infer<typeof Leg>

export const GenericSpec = z
  .object({
    name: z.string().min(1).max(80),
    symbol: z.string().regex(/^[A-Z][A-Z0-9.]{0,7}$/),
    entry: z.object({
      // 1=Mon .. 5=Fri; default every session
      weekdays: z.array(z.number().int().min(1).max(5)).min(1).default([1, 2, 3, 4, 5]),
      timeEt: HHMM.default('10:00'),
      // expiration = the listed one whose calendar DTE is closest to
      // targetDte within [dteMin, dteMax] (default target -/+ 10 days).
      // Stock strategies are mostly weeklies (7), monthlies (~30) and 45 DTE;
      // 0 = same-day, for the few names with daily expirations.
      targetDte: z.number().int().nonnegative().max(400),
      dteMin: z.number().int().nonnegative().optional(),
      dteMax: z.number().int().nonnegative().optional(),
      legs: z.array(Leg).min(1).max(8),
      maxOpen: z.number().int().positive().default(1),
      filters: z
        .object({
          minCredit: z.number().optional(), // $ per spread (x100 already)
          maxDebit: z.number().optional(),
          atmIvMin: z.number().optional(), // ATM IV at entry, e.g. 0.20
          atmIvMax: z.number().optional(),
          // close vs its N-day simple moving average (prior sessions' daily closes)
          trend: z
            .object({ smaDays: z.number().int().min(2).max(250), require: z.enum(['above', 'below']) })
            .optional()
        })
        .default({})
    }),
    exit: z
      .object({
        // % of the entry credit/debit (basis = |entry cash|)
        profitTargetPct: z.number().positive().optional(),
        stopLossPct: z.number().positive().optional(),
        // close once calendar DTE <= this (e.g. 21 for the "manage at 21 DTE" rule)
        exitDte: z.number().int().nonnegative().optional(),
        // close at this time on any day it's still open (0DTE: '15:45')
        timeEt: HHMM.optional(),
        maxHoldDays: z.number().int().positive().optional()
        // otherwise: held to expiration, settled at intrinsic on that day's close
      })
      .default({}),
    costs: z
      .object({
        // multiple of the chain's spread: 1 = real quotes (tasty) or the
        // QQQ/IWM-fitted model spread (Massive); 2-3 = realistic for stocks
        spreadMult: z.number().min(0).max(10).default(2),
        // natural = sell at bid / buy at ask; mid = at mid
        fill: z.enum(['natural', 'mid']).default('natural'),
        commissionPerContract: z.number().nonnegative().default(0.65)
      })
      .default({}),
    // chain sampling: exits/targets are checked at this resolution. 30 min
    // suits weekly-to-45-DTE holds (and keeps a 2-year pull small); 60 s is
    // for 0DTE. Entry and exit times snap to the latest bucket at/before them.
    bucketSec: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800)]).default(1800)
  })
  .transform((s) => ({
    ...s,
    entry: {
      ...s.entry,
      dteMin: s.entry.dteMin ?? Math.max(0, s.entry.targetDte - 10),
      dteMax: s.entry.dteMax ?? s.entry.targetDte + 10
    }
  }))
  .superRefine((s, ctx) => {
    if (s.entry.dteMax < s.entry.dteMin) ctx.addIssue({ code: 'custom', message: 'entry.dteMax < entry.dteMin' })
    s.entry.legs.forEach((l, i) => {
      if (l.strike.by === 'width' && l.strike.leg >= i) {
        ctx.addIssue({ code: 'custom', message: `leg ${i}: width must reference an EARLIER leg` })
      }
    })
  })
export type GenericSpec = z.infer<typeof GenericSpec>
