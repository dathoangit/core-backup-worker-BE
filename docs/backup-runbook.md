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

`BACKUP_*` and `HIS_*` / `EMR_*` / `BADL_*` are stored in MySQL table `app_settings`
(seeded once from `.env` on first boot). Runtime reads **DB first**, then env.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/settings?category=backup` | List (secrets masked) |
| `GET` | `/admin/settings/:key` | One key |
| `POST` | `/admin/settings` | Create (allowlisted keys) |
| `PUT` | `/admin/settings/:key` | Upsert |
| `DELETE` | `/admin/settings/:key` | Delete |

Require login (`@Auth()` only — no role check).  
`SETTINGS_SECRET_KEY` encrypts `*_PASSWORD` values. Changing cron strings in DB
requires **process restart** (Nest `@Cron` is fixed at boot from env).

`DB_*` connection settings stay in `.env` only (not stored in `app_settings`).

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

```env
BACKUP_SCHEDULE_ENABLED=true
```

| Job | Cron source | Mode | Scope |
| --- | --- | --- | --- |
| Incremental (per DB) | `BACKUP_INCREMENTAL_CRON_<db>` → `BACKUP_<GROUP>_INCREMENTAL_CRON` → `BACKUP_INCREMENTAL_CRON` | incremental | Databases sharing the same resolved cron run in one job |
| HIS full | `BACKUP_HIS_FULL_CRON` | full | HIS |
| EMR full | `BACKUP_EMR_FULL_CRON` | full | EMR |

Examples:

- All DBs inherit `BACKUP_INCREMENTAL_CRON=0 */4 * * *` → one combined incremental job (same as before).
- Set `BACKUP_EMR_INCREMENTAL_CRON=30 */4 * * *` to offset all EMR DBs from HIS.
- Set `BACKUP_INCREMENTAL_CRON_produce=0 */6 * * *` for HIS `produce` only.

Changing any cron / timezone setting requires a **backend restart** (jobs are registered at boot).

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
