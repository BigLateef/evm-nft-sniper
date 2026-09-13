#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo 'Node.js is missing. Install nodejs-lts first.' >&2; exit 1; }
[ -f config.json ] || { echo 'config.json is missing.' >&2; exit 1; }
[ -f .env ] || { echo '.env is missing.' >&2; exit 1; }

# Never permit contradictory safety switches.
if [ "${LIVE_TRADING:-0}" = "1" ] && [ "${DRY_RUN:-1}" != "0" ]; then
  echo 'LIVE_TRADING=1 with DRY_RUN!=0; refusing to start.' >&2
  exit 1
fi

exec node src/index.mjs
