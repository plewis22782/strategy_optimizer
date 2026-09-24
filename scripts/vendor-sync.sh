#!/usr/bin/env bash
# Pin the Strike Canopy strategy code the optimizer runs.
#   scripts/vendor-sync.sh [commit]   (default: the commit in vendor/strike-canopy.ref)
# Source: Strike Canopy on GitHub (override with SC_SRC=/srv/tmr-dev on Charlie). The pinned
# commit must be pushed there for another host (Redfish) to clone it.
# this repo never edits Strike Canopy code; change it there, then re-pin here.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=${SC_SRC:-git@github.com:plewis22782/tastytrade_market_recorder.git}
REF=${1:-$(cat vendor/strike-canopy.ref)}
if [ ! -d vendor/strike-canopy/.git ]; then
  git clone -q --no-hardlinks "$SRC" vendor/strike-canopy
fi
git -C vendor/strike-canopy fetch -q "$SRC" '+refs/heads/*:refs/remotes/src/*'
git -C vendor/strike-canopy checkout -q --detach "$REF"
git -C vendor/strike-canopy rev-parse --short HEAD > vendor/strike-canopy.ref
echo "pinned Strike Canopy at $(cat vendor/strike-canopy.ref)"
