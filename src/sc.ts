// The one bridge into the pinned Strike Canopy clone (vendor/strike-canopy,
// commit in vendor/strike-canopy.ref). Everything the optimizer uses from
// Strike Canopy is re-exported here, so a Strike Canopy refactor breaks
// exactly one file.
const SC = '../vendor/strike-canopy/tastytrade-market-recorder/src'

export { WellClient } from '../vendor/strike-canopy/tastytrade-market-recorder/src/well-client.js'
export type {
  BarsTable,
  BarRow,
  ChainHistoryRow,
  ChainSnapshotRow
} from '../vendor/strike-canopy/tastytrade-market-recorder/src/well-client.js'
export { ChainHistoryCache } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/chain-history-cache.js'
export { etWallToUtcMs } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/hist-chain.js'
export { nutterflyTick } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/nutterfly.js'
export {
  NUTTERFLY_5_DEFAULT,
  NUTTERFLY_10_DEFAULT
} from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/presets.js'
export type { NutterflyParams } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/types.js'
export type { TickOpts } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/fly.js'

/** Strike Canopy's schema.sql, for the sim DB's strategy_* DDL. */
export const SC_SCHEMA_SQL = new URL(`${SC}/../db/schema.sql`, import.meta.url)
