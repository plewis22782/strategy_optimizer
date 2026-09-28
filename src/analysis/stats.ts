// Small, deterministic statistics helpers for run analysis. No LLM, no DB --
// pure arithmetic so it's cheap to unit-test and to sanity-check by hand.

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Drop up to `n` of the lowest and `n` of the highest values, then average what's left. */
export function trimmedMean(xs: number[], n: number): number {
  if (xs.length <= 2 * n) return mean(xs)
  const s = [...xs].sort((a, b) => a - b)
  return mean(s.slice(n, s.length - n))
}

/** Between-groups variance explained (eta-squared, 0..1) of `valueOf` grouped by `keyOf`.
 *  Null when there's nothing to compare (< 2 finite rows or < 2 distinct groups). */
export function etaSquared<T>(rows: T[], keyOf: (r: T) => string, valueOf: (r: T) => number): number | null {
  const finite = rows.filter((r) => Number.isFinite(valueOf(r)))
  if (finite.length < 2) return null
  const groups = new Map<string, number[]>()
  for (const r of finite) {
    const k = keyOf(r)
    const arr = groups.get(k) ?? []
    arr.push(valueOf(r))
    groups.set(k, arr)
  }
  if (groups.size < 2) return null
  const all = finite.map(valueOf)
  const grand = mean(all)
  const ssTotal = all.reduce((a, y) => a + (y - grand) ** 2, 0)
  if (ssTotal === 0) return 0
  let ssBetween = 0
  for (const g of groups.values()) ssBetween += g.length * (mean(g) - grand) ** 2
  return ssBetween / ssTotal
}
