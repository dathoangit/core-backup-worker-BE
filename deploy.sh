#!/bin/sh
# Production deploy entrypoint on xp-cntt-server.
# Delegates to scripts/deploy-prod.sh (uses .env; requires NODE_ENV=production).
set -eu
cd "$(dirname "$0")"
exec ./scripts/deploy-prod.sh "$@"
