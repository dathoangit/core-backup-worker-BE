#!/bin/sh
# Deploy the backup worker on xp-cntt-server.
# Run from core-backup-worker-BE after copying .env.production.example to .env.production.
set -eu

STORAGE_MOUNT=/mnt/5AE4E9F5E4E9D375
STORAGE_ROOT="$STORAGE_MOUNT/backup-storage"
ENV_FILE=.env.production
# uid/gid of the "node" user inside node:22-alpine.
CONTAINER_UID=1000
CONTAINER_GID=1000

fail() {
  echo "deploy-prod: $1" >&2
  exit 1
}

docker compose version >/dev/null 2>&1 || fail "docker compose is not available"

[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing (copy .env.production.example and fill it in)"

# A missing mount would silently write terabytes of backup data onto the OS disk.
mountpoint -q "$STORAGE_MOUNT" \
  || fail "$STORAGE_MOUNT is not a mount point; the 10.9 TB disk is not mounted"

ROW_LIMIT=$(grep -E '^BACKUP_DEV_ROW_LIMIT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)
[ "$ROW_LIMIT" = "0" ] || fail "BACKUP_DEV_ROW_LIMIT must be 0 in $ENV_FILE (found '${ROW_LIMIT:-<unset>}')"

echo "Preparing storage directories under $STORAGE_ROOT"
mkdir -p \
  "$STORAGE_ROOT/meta" \
  "$STORAGE_ROOT/his" \
  "$STORAGE_ROOT/emr" \
  "$STORAGE_ROOT/lis"
chown -R "$CONTAINER_UID:$CONTAINER_GID" "$STORAGE_ROOT"

echo "Building image"
docker compose build --pull

echo "Starting container"
docker compose up -d --remove-orphans

docker compose ps

HOST_PORT=$(grep -E '^HOST_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)
HOST_PORT=${HOST_PORT:-3000}

echo "Waiting for http://127.0.0.1:$HOST_PORT/"
ATTEMPT=0
until curl -fsS "http://127.0.0.1:$HOST_PORT/" >/dev/null; do
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -ge 30 ] && fail "app did not answer on / within 60s; check 'docker compose logs'"
  sleep 2
done

echo "Liveness OK."
echo "Backup freshness (GET /health returns 503 until the first successful run):"
curl -sS -o /dev/null -w "  /health -> HTTP %{http_code}\n" "http://127.0.0.1:$HOST_PORT/health" || true
