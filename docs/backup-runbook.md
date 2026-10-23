# HIS / EMR backup runbook

Manual run and Nest cron use the **same** engine inside `src/modules/backup/`.
Checkpoints are monotonic ids (`ad_changelog_id` / `rev`), not wall-clock finish time.

## RPO / RTO (HIS + EMR CSDL)

| System | RPO | RTO | Schedule in this module |
| --- | --- | --- | --- |
| HIS | ≤ 4h | ≤ 4h | Incremental every **4 hours** + full re-baseline **Sunday 01:30** |
| EMR | ≤ 4h | ≤ 4h | Incremental every **4 hours** + full re-baseline **Sunday 02:30** |

Retention: **30 days** for all run artifacts on the primary zone (chain guard keeps
the newest `full/` baseline and every later run).

**Warning:** weekly full of `produce` re-dumps business tables (~1.5 TB) and can run
many hours. Run only on a large-disk Windows worker. PID `backup.lock` prevents
overlap with the 4-hour job.

LIS / PACS / EMR files / DICOM are out of scope for this phase.

## Prerequisites

1. Windows PC with large disks for **HIS / EMR / meta** volumes (about **2 TB+** free for
   the first / weekly full on HIS), or a laptop for **dev sample** mode (`yarn dev`).
2. Node.js 20+ and Yarn.
3. Network reachability to HIS/EMR secondary host `172.16.16.23:5432`.
4. Clone this repo and copy `.env.example` to `.env` (dev overrides live in `.env.development`).

## Configure

Production worker (absolute disks):

```env
BACKUP_VOLUME_META=C:\backup-meta
BACKUP_VOLUME_HIS=D:\his-backup
BACKUP_VOLUME_EMR=E:\emr-backup
BACKUP_DEV_ROW_LIMIT=0

HIS_HOST=172.16.16.23
HIS_PORT=5432
HIS_USER=his_stpaul
HIS_PASSWORD=...
HIS_DATABASES=produce

EMR_HOST=172.16.16.23
EMR_PORT=5432
EMR_USER=emr_stpaul
EMR_PASSWORD=...
EMR_DATABASES=signer,file_service,vital_signs,research_management,medical_incident,html_editor,phat_thuoc

BACKUP_SCHEDULE_ENABLED=false
BACKUP_INCREMENTAL_CRON=0 */4 * * *
BACKUP_HIS_INCREMENTAL_CRON=0 */4 * * *
BACKUP_EMR_INCREMENTAL_CRON=30 */4 * * *
BACKUP_HIS_FULL_CRON=30 1 * * 0
BACKUP_EMR_FULL_CRON=30 2 * * 0
BACKUP_TIMEZONE=Asia/Ho_Chi_Minh
BACKUP_HISTORY_ENABLED=false
BACKUP_RETENTION_DAYS=30
BACKUP_FRESHNESS_MAX_AGE_HOURS=5
BACKUP_ARCHIVE_TARGET=none
```

Local/dev (also defaulted in `.env.development` for `yarn dev`):

```env
BACKUP_ROOT=../.backup-dev
BACKUP_VOLUME_META=volumes/meta
BACKUP_VOLUME_HIS=volumes/his
BACKUP_VOLUME_EMR=volumes/emr
BACKUP_DEV_ROW_LIMIT=100
BACKUP_SCHEDULE_ENABLED=false
```

Optional:

- `BACKUP_CHUNK_SIZE=1000000`
- `BACKUP_STATEMENT_TIMEOUT_MS=0`
- `BACKUP_SCHEDULE_CRON` — legacy alias for incremental cron
- `BACKUP_DIR` — legacy alias for `BACKUP_ROOT`

Set the OS / Task Scheduler time zone to `Asia/Ho_Chi_Minh`.

## Install

```bat
cd C:\path\to\core-backup-worker-BE
yarn
yarn backup:ensure-volumes
```

## Run modes

| Command | Mode |
| --- | --- |
| `yarn dev` | Development / sample dumps (`BACKUP_DEV_ROW_LIMIT` > 0 required) |
| `yarn start` | Production-like Nest (no row cap; `BACKUP_DEV_ROW_LIMIT` must be 0) |
| `yarn start:prod` | `node dist/main.js` with `NODE_ENV=production` |
| `yarn backup:run` | CLI worker (same engine; uses env files per `NODE_ENV`) |

## Run anytime (manual)

```bat
yarn backup:run
yarn backup:run -- --full
```

`--full` forces a re-baseline (same as Sunday full jobs).

This boots Nest standalone (`BackupWorkerModule`) — no HTTP server; app DB optional
when `BACKUP_HISTORY_ENABLED=false`.

What happens:

1. Takes `meta\backup.lock` (PID). If held, exits **without** moving checkpoints.
2. For each **ready** database (HIS `produce` + EMR), captures tip once and copies the
   mode-appropriate range. BADL stays `unreachable` and is skipped.
3. Writes under the **group volume** (`his` or `emr`) `runs\<runId>\` and updates
   `state\<db>.json` only after that database succeeds.
4. Writes `manifest.json` on meta + each participating volume (same `runId`).
5. Applies 30-day retention across volumes with chain guard.

## Settings in app DB

Runtime `.env` / `.env.production` stay **infrastructure-only**: `NODE_ENV`, `PORT`,
JWT keys, `DB_*`, Redis, `SETTINGS_SECRET_KEY`, `SETTINGS_SEED_FILE`.

All backup config (`BACKUP_*` volumes/cron/retention, `HIS_*` / `EMR_*` / `LIS_*` /
`BADL_*`, alerts) lives in `app_settings`. Runtime reads **DB first**. Secrets
(`*_PASSWORD`) are stored encrypted (`enc:v1:…`) and **never** fall back to env.

### Fresh production deploy

1. Copy `.env.production.example` → `.env.production` (fill DB/Redis/JWT/`SETTINGS_SECRET_KEY`).
2. Copy `.env.settings.example` → `.env.settings` (fill source passwords + confirm volumes).
3. `docker compose up` — first boot with an empty `app_settings` table seeds from
   `.env.settings` (see `SETTINGS_SEED_FILE`) and encrypts passwords.
4. Optional: delete `.env.settings` from the host after a successful seed; further
   edits via FE **Cấu hình** (`/config`).

### Sync / re-seed from seed file

```bash
# Preview
yarn settings:sync-from-env -- --env-file=.env.settings --all --include-paths --dry-run

# Fill missing/empty only
yarn settings:sync-from-env -- --env-file=.env.settings --all --include-paths

# Overwrite DB values from the seed file
yarn settings:sync-from-env -- --env-file=.env.settings --all --include-paths --force
```

`SETTINGS_SECRET_KEY` in runtime env **must match** the key used to encrypt rows.
Point `DB_*` at the same app database the container uses.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/settings?category=backup` | List (secrets masked) |
| `GET` | `/admin/settings/:key` | One key |
| `PUT` | `/admin/settings/:key` | Upsert |

Require login (`@Auth()` only — no role check).  
Cron/timezone changes hot-reload via `ScheduleRegistry` (no restart). Do not edit
cron while a backup is running.

`DB_*` / Redis / JWT stay in `.env` only (not stored in `app_settings`).

## Admin API

Requires login JWT (`@Auth()` — any authenticated user):

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/admin/backup/runs?mode=incremental\|full&groups=HIS,EMR&databases=produce,signer` | `202` background; `databases` optional filter |
| `GET` | `/admin/backup/runs` | History |
| `GET` | `/admin/backup/runs/:runId` | Detail |
| `GET` | `/admin/backup/sources` | Inventory + watermarks |
| `GET` | `/admin/backup/zones` | Primary + isolated-copy status |
| `GET` | `/admin/backup/restore-plan?database=produce` | Ordered file plan |

`GET /health` → `backup-freshness` fails if last success is older than
`BACKUP_FRESHNESS_MAX_AGE_HOURS` (default 5) when backup volumes are configured.

## Schedule

### Nest cron (one API / worker instance only)

Cron jobs are **always registered at process boot**. Enable/disable is
`BACKUP_SCHEDULE_ENABLED` in `app_settings` (FE toggle under Cấu hình) — takes
effect immediately at fire time; no env edit or restart needed to turn the
schedule on or off. Env is only the seed/fallback when the DB row is empty.

| Job | Cron source | Mode | Scope |
| --- | --- | --- | --- |
| Incremental (per DB) | `BACKUP_INCREMENTAL_CRON_<db>` → `BACKUP_<GROUP>_INCREMENTAL_CRON` → `BACKUP_INCREMENTAL_CRON` | incremental | Databases sharing the same resolved cron run in one job |
| HIS full | `BACKUP_HIS_FULL_CRON` | full | HIS |
| EMR full | `BACKUP_EMR_FULL_CRON` | full | EMR |

Examples:

- All DBs inherit `BACKUP_INCREMENTAL_CRON=0 */4 * * *` → one combined incremental job (same as before).
- Set `BACKUP_EMR_INCREMENTAL_CRON=30 */4 * * *` to offset all EMR DBs from HIS.
- Set `BACKUP_INCREMENTAL_CRON_produce=0 */6 * * *` for HIS `produce` only.

Changing any **cron expression or timezone** still requires a **backend restart**
(jobs are registered at boot from settings). Toggling `BACKUP_SCHEDULE_ENABLED`
does not.

### Local / laptop sample mode

```bat
yarn backup:ensure-volumes
yarn dev
```

`.env.development` sets `BACKUP_ROOT=../.backup-dev`, volume relatives, and
`BACKUP_DEV_ROW_LIMIT=100`. Each `COPY` SELECT is capped — enough to exercise the
pipeline without dumping TB of HIS data.

`yarn start` refuses a non-zero row limit (use absolute production volumes +
`BACKUP_DEV_ROW_LIMIT=0`).

## Docker deploy (xp-cntt-server)

Production target is the Ubuntu server `xp-cntt-server`. Backup data must land on the
10.9 TB disk (`/dev/sdb`, mounted at `/mnt/5AE4E9F5E4E9D375`); the OS disk (`/dev/sda`)
only holds the Docker runtime and rotated container logs. MySQL (app DB) and Redis
(auth sessions) are external services reachable from the container.

```bash
cd core-backup-worker-BE
cp .env.production.example .env.production   # fill passwords, JWT keys, DB/Redis hosts
./scripts/deploy-prod.sh
```

`scripts/deploy-prod.sh` refuses to run unless `/mnt/5AE4E9F5E4E9D375` is a real mount
point, `BACKUP_DEV_ROW_LIMIT=0`, and `.env.production` exists. It creates
`backup-storage/{meta,his,emr,lis}`, gives them to uid `1000` (the `node` user inside
the image), then runs `docker compose build --pull && docker compose up -d`.

Notes:

- Settings are seeded from env **only on first boot** (`app_settings` empty). On an
  existing database, change them through `/admin/settings`.
- `GET /` is the container liveness check (always 200). `GET /health` returns 503 while
  no successful run exists yet, so it is for monitoring only and does not restart the
  container.
- The image runs `node dist/main.js` directly. `yarn backup:run` needs ts-node and is
  not available inside the image; trigger runs through the Nest scheduler or the admin API.
- FE **Databases** page: each `ready` card has **Start** (incremental for that DB only).
  History shows a `running` row as soon as the job takes the lock.

### Wipe + fresh seed (clean slate)

Use when you want every source credential ready immediately after boot (no FE password
entry). **Do this before** `docker compose up`:

1. Fill `.env.production` completely — `HIS_*` / `EMR_*` / `LIS_*` passwords must be
   non-empty; paths `BACKUP_ROOT=/app/backup-storage` + volume dirs; `BACKUP_DEV_ROW_LIMIT=0`;
   `DB_*`, Redis, JWT, `SETTINGS_SECRET_KEY`.
2. Drop/recreate the app MySQL database (e.g. `his-raw-backup`).
3. `docker compose down` (BE + FE as needed). Optional: remove stale
   `/mnt/5AE4E9F5E4E9D375/backup-storage/meta/backup.lock`.
4. Pull latest code → `./scripts/deploy-prod.sh` (BE), then FE deploy script.
5. Confirm logs contain `Seeded N settings from env`. FE Databases should show HIS/EMR/LIS
   as `ready` (BADL may stay `unreachable`). Click **Start** on a single DB to verify.

If passwords were empty at first seed, either wipe again with a full env, use FE **Sửa**
on the missing secret keys, or `yarn settings:sync-from-env -- --env-file=.env.production --force`.

### Windows Task Scheduler alternative

Trigger every 4 hours → `yarn backup:run` with `NODE_ENV=production`.  
Sunday 01:30 → `yarn backup:run -- --full` (HIS-only via env filter is Nest-cron only;
for Task Scheduler full of both groups is acceptable, or call the admin API with `groups=` / `databases=`).

## Layout on disk

```text
<meta volume>\
  backup.lock
  runs\<runId>\manifest.json

<his volume>\
  state\produce.json
  runs\<runId>\produce\{full,append,cdc}\
  runs\<runId>\manifest.json

<emr volume>\
  state\<db>.json
  snapshots\<db>\          # empty-revinfo EMR overwrite mode
  runs\<runId>\<db>\{full,append,cdc}\
  runs\<runId>\manifest.json
```

## Retention

- Default `BACKUP_RETENTION_DAYS=30`.
- Never deletes `state/`.
- Scans **his + emr** volumes for run ids; finds the newest run that contains a
  non-empty `*/full/` directory and **keeps that baseline plus all later runs**,
  even if older than 30 days.
- Older runs before that baseline and past the cutoff are deleted from each volume.

## Tests

```bat
yarn backup:test
```

## Out of scope

Binary files outside PostgreSQL, `isofh_pay`, `produce_old` / `produce_bak`, restore
execution, BADL until reachable, LIS/PACS, EMR file hồ sơ, real isolated-copy adapters.
