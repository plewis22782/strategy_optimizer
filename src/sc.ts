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
  ChainSnapshotRow,
  WellCandle
} from '../vendor/strike-canopy/tastytrade-market-recorder/src/well-client.js'
export { ChainHistoryCache } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/chain-history-cache.js'
export { etWallToUtcMs } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/hist-chain.js'
// Paper Lab's strategy registry + contract: the optimizer runs whatever is
// registered there -- no strategy is hand-wired on this side.
export { STRATEGY_REGISTRY, findByMode } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/registry.js'
export {
  TUNABLE_ROLES,
  lintDefinition,
  paramDefaults,
  paramsZod,
  variantParams
} from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/contract.js'
export type {
  Constraint,
  DataNeed,
  ParamRole,
  ParamSpec,
  StandardResult,
  StrategyDefinition,
  TickContext
} from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/contract.js'

export type { BacktestData } from '../vendor/strike-canopy/tastytrade-market-recorder/src/strategy/backtest-data.js'

/** Strike Canopy's schema.sql, for the sim DB's strategy_* DDL. */
export const SC_SCHEMA_SQL = new URL(`${SC}/../db/schema.sql`, import.meta.url)
