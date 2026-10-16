# Backup source databases — inventory & behavior

Reference for how this worker sees and backs up PostgreSQL sources, **and how the backup
pipeline works** (lock, checkpoints, HIS/EMR profiles, retention, restore plan).
Derived from `src/modules/backup/` (profiles, source registry, schema discovery, runbook).
Table **counts** are not fixed in code — they are discovered at runtime via `listReadableTables`.

---

## 1. Two layers of “database”

| Layer | Role | Backed up by this worker? |
| --- | --- | --- |
| **App DB** (`DB_*` in `.env`, MySQL/Postgres via TypeORM) | Nest settings, optional backup run history | **No** |
| **Source DBs** (`HIS_*` / `EMR_*` / `BADL_*` / …) | Hospital systems on secondary hosts | **Yes** (when runnable + profile exists) |

Always use **secondary** hosts for source backup (never primary production write path as the intended target).

Default secondary (from `.env.example` / runbook):

| Group | Host | Port |
| --- | --- | --- |
| HIS, EMR | `172.16.16.23` | `5432` |
| BADL | `172.16.16.83` | `5432` |

---

## 2. Source groups and configured databases

Configured via env / `app_settings` CSV lists: `HIS_DATABASES`, `EMR_DATABASES`, `BADL_DATABASES`, …

| Group | Default databases | Reachability (code) | Backup profile | Runnable by default? |
| --- | --- | --- | --- | --- |
| **HIS** | `produce` | `ready` if host + user + password set | **adempiere** (only if DB name is exactly `produce`) | Yes |
| **EMR** | `signer`, `file_service`, `vital_signs`, `research_management`, `medical_incident`, `html_editor`, `phat_thuoc` | `ready` if credentials set | **envers** (or **snapshot** fallback) | Yes (7 DBs) |
| **BADL** | `his` | Forced **`unreachable`** (inventory only) | Would use envers if ever runnable | No |
| **LIS** | optional | Marked **`unconfigured`** (“profile not implemented”) | None | No |
| **PACS** | optional | Marked **`unconfigured`** | None | No |

**Practical inventory for a normal StPaul setup:** 1 HIS + 7 EMR = **8 backupable databases** when sources are `ready`.

HIS databases other than `produce` are **skipped** (`No profile for HIS/<name>`).

---

## 3. Schema mapping (what gets scanned inside each DB)

### HIS — `produce`

| Item | Value |
| --- | --- |
| PostgreSQL database | `produce` |
| Business schema | `adempiere` |
| Table discovery | All relations `relkind = 'r'` in `adempiere` with `SELECT` privilege |
| Typical size | Hundreds–thousands of tables; weekly full ~**1.5 TB** business data (runbook) |
| Watermark | `adempiere.ad_changelog.ad_changelog_id` |

**Append-only tables** (copied by ID range into `append/`, excluded from `full/` baseline dump of the same tables):

| Table | ID column |
| --- | --- |
| `ad_changelog` | `ad_changelog_id` |
| `ad_issue` | `ad_issue_id` |
| `ad_session` | `ad_session_id` |
| `ad_pinstance` | `ad_pinstance_id` |
| `ad_pinstance_para` | `ad_pinstance_id` |
| `ad_recentitem` | `ad_recentitem_id` |
| `his_sign_history` | `his_sign_history_id` |
| `his_sms` | `his_sms_id` |

Code: `src/modules/backup/engine/profiles/adempiere.profile.ts`.

### EMR — one Postgres DB per app, one primary schema each

From `SCHEMA_BY_DATABASE` in `envers.profile.ts`:

| PostgreSQL database | Preferred schema(s) |
| --- | --- |
| `signer` | `signer` |
| `file_service` | `file` |
| `vital_signs` | `vital_signs` |
| `research_management` | `research` |
| `medical_incident` | `medical_incident` |
| `html_editor` | `html_editor` |
| `phat_thuoc` | `phat_thuoc` |

Table discovery: all readable tables in those schemas (plus Envers artifacts when present: `revinfo`, `*_aud`).

An EMR database listed in `EMR_DATABASES` but **missing** from `SCHEMA_BY_DATABASE` fails with `no usable business schema`.

---

## 4. How many tables does each DB have?

**Not hardcoded.** At backup time the worker runs `listReadableTables` (`engine/schema.ts`):

- Lists every ordinary table in the preferred schema(s)
- Skips tables without `SELECT` (recorded in `skippedTables`)

So:

- **`produce` / HIS:** typically **very many** tables (full Adempiere + HIS extensions)
- **`signer` / other EMR:** **many** tables relative to a small app, but usually **far fewer** than `produce`; exact count = whatever exists on the secondary today

To count on the secondary (example):

```sql
SELECT n.nspname, count(*) AS tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'signer'   -- or 'adempiere', 'file', …
GROUP BY 1;
```

---

## 5. Full vs incremental — what is stored on disk

Artifacts are split by **source group volume** (not per-DB, not full vs cdc):

| Volume | Env | Contents |
| --- | --- | --- |
| **meta** | `BACKUP_VOLUME_META` | `backup.lock`, optional meta `manifest.json` |
| **his** | `BACKUP_VOLUME_HIS` | HIS `produce` runs/state |
| **emr** | `BACKUP_VOLUME_EMR` | All EMR DBs runs/state/snapshots |

Relative volume paths join `BACKUP_ROOT` (legacy `BACKUP_DIR` acts as root when `BACKUP_ROOT` unset). Absolute volume paths may point at separate disks.

Local/dev layout (`yarn backup:ensure-volumes`):

```text
.backup-dev/                          # BACKUP_ROOT
  volumes/
    meta/
      backup.lock
    his/
      runs/<runId>/produce/{full,append,cdc}/
      state/produce.json
    emr/
      runs/<runId>/<db>/{full,append,cdc}/
      state/<db>.json
      snapshots/<db>/
```

Production example:

```env
BACKUP_VOLUME_META=C:\backup-meta
BACKUP_VOLUME_HIS=D:\his-backup
BACKUP_VOLUME_EMR=E:\emr-backup
BACKUP_DEV_ROW_LIMIT=0
```

Format: PostgreSQL `COPY (SELECT …) TO STDOUT` → **CSV gzip** with header (`copy-writer.ts`).

### Full (weekly / first run / `--full`)

- **HIS:** dump all readable non–append-only tables into `full/`; append-only tables by ID range into `append/`
- **EMR Envers:** baseline of base tables (exclude `*_aud`, `revinfo`) into `full/`
- **EMR snapshot:** overwrite under `snapshots/` or `full/` on weekly full

### Incremental (default cron ~every 4h)

- **Does not** re-dump entire patient/business tables
- **HIS:** new `append/` for append-only ID ranges; **`cdc/`** for rows touched in `ad_changelog`:
  - Deletes → `deletes_*.csv.gz` (`table_name`, `record_id` only)
  - Inserts/updates → `patch_*.csv.gz` = **`SELECT *` of current row** for that PK (guessed as `{tablename}_id`)
- **EMR Envers:** `append/` for `revinfo` / `*_aud` by `rev`; `cdc/patch_*` = current base row for changed ids; deletes by id from `revtype = 2`

### Example: patient A date of birth changed after Sunday full

| Where | What happens |
| --- | --- |
| Live DB | `UPDATE` same row; new `ad_changelog` entries |
| Sunday `full/` | Still has old DOB for that row |
| Monday incremental `cdc/patch_*.csv.gz` | Only changed record ids; **full current row** (all columns), not column-diff |
| Unchanged patients | Not present in that incremental run |

Restoring “state after Monday” = apply Sunday `full/` then later `append/` + `cdc/` patches in order.

---

## 6. Schedule & RPO (design targets)

| Job | Default cron | Scope |
| --- | --- | --- |
| Incremental | Per-DB / group / global cron (see settings) | HIS + EMR runnable DBs |
| HIS full | `BACKUP_HIS_FULL_CRON` ≈ Sunday 01:30 | HIS |
| EMR full | `BACKUP_EMR_FULL_CRON` ≈ Sunday 02:30 | EMR |

| Metric | Target (runbook) |
| --- | --- |
| RPO HIS/EMR | ≤ 4 hours |
| RTO | ≤ 4 hours (operational goal; **restore execution is out of scope**) |
| Retention | 30 days + chain guard (keep newest `full/` baseline and later runs) |

Cron resolution for incremental:

1. `BACKUP_INCREMENTAL_CRON_<database>`
2. `BACKUP_HIS_INCREMENTAL_CRON` / `BACKUP_EMR_INCREMENTAL_CRON`
3. `BACKUP_INCREMENTAL_CRON` (global)

Databases sharing the same resolved cron run in one job (avoids lock contention).

---

## 7. Local / laptop testing (`yarn dev` vs `yarn start`)

| | `yarn dev` (`NODE_ENV=development`) | `yarn start` / production |
| --- | --- | --- |
| Env files | `.env.development` then `.env` | `.env.production` (optional) then `.env` |
| Default root | repo `.backup-dev` via `BACKUP_ROOT=../.backup-dev` | Must set absolute `BACKUP_VOLUME_*` (and/or `BACKUP_ROOT`) |
| `BACKUP_DEV_ROW_LIMIT` | Default `100` if unset; **must be > 0** | Default `0`; **must be 0** (sample dumps refused) |
| Schedule | Usually `BACKUP_SCHEDULE_ENABLED=false` | Per real ops config |

```bash
cd core-backup-worker-BE
yarn backup:ensure-volumes   # once
yarn dev                     # sample dumps under .backup-dev/volumes/*
yarn start                   # real backups (no row cap)
```

---

## 8. Out of scope (not in these DB backups)

- Binary / file objects outside PostgreSQL
- EMR hồ sơ files, DICOM / PACS content
- `isofh_pay`, `produce_old` / `produce_bak` (unless explicitly listed and profiled)
- Automated restore execution (restore **plan** only lists files)
- Off-site archive (`BACKUP_ARCHIVE_TARGET` — only `none` implemented)
- App metadata DB (`DB_*`)

---

## 9. Backup logic currently implemented

This section describes **how a run actually works** in code (not only which DBs exist).

### 9.1 Entry points

| Trigger | Entry | Behavior |
| --- | --- | --- |
| Admin API | `POST /admin/backup/runs?mode=&groups=&databases=` | `BackupService.triggerRun` → background (`202`) |
| Nest cron | `BackupScheduler` | `runOnceAndWait` (blocks until done) |
| CLI | `yarn backup:run` [`-- --full`] | Nest standalone `BackupWorkerModule` → `runOnceAndWait` |

Shared options (`BackupRunOptions`):

- `mode`: `incremental` (default) \| `full`
- `sourceGroups`: optional filter `HIS`, `EMR`, …
- `databases`: optional filter by DB name (e.g. `produce,signer`)

### 9.2 End-to-end run pipeline

```text
trigger
  → acquire backup.lock (PID file); if held → abort, do NOT move watermark
  → create runId (ISO timestamp)
  → SourceRegistry.getRunnableSources()  (reachability === ready)
  → filter by sourceGroups / databases
  → BackupRunnerService.run(config, runId)
       for each source × database:
         connect pg.Client → SET application_name / timezone
         route profile → database result (ok | error | skipped)
         upsert into runs/<runId>/manifest.json
  → optional archive publish (noop today)
  → persist history to app DB if BACKUP_HISTORY_ENABLED
  → RetentionService.applyRetention
  → release lock
```

**Lock:** `meta/backup.lock` contains the holding PID. Stale locks (dead PID) are replaced. Overlap = fail closed (no checkpoint advance).

### 9.3 Profile routing (`BackupRunnerService`)

| Condition | Profile function |
| --- | --- |
| `HIS` + database `produce` | `backupAdempiereDatabase` |
| `EMR` or `BADL` | `backupEnversDatabase` |
| Anything else | `skipped` — `No profile for GROUP/db` |

### 9.4 Shared checkpoint model (`state/<database>.json`)

Watermarks are **monotonic IDs**, not wall-clock finish time.

| Field | Meaning |
| --- | --- |
| `watermark` | Last successfully committed tip (`ad_changelog_id` or `rev` or snapshot tip) |
| `pending` | In-flight capture window: `{ captured, runId, completedChunkKeys[] }` |
| `initialFullDone` | Baseline `full/` completed at least once |
| `profile` | `adempiere` \| `envers` \| `snapshot` |

**Rules:**

1. **Capture tip once** at start of DB work (`captured`).
2. **`beginOrResumePending`**: if a pending window already exists, **resume that window** (do not expand mid-flight to a newer tip).
3. After each successful chunk → `markChunkComplete` + save pending (crash-safe resume).
4. Only after the whole DB succeeds → **`commitWatermark(captured)`** (clears pending, sets `initialFullDone`).
5. On error → pending kept; next run resumes incomplete chunk keys.

ID window for incremental data: half-open **`(savedWatermark, captured]`** via `buildIdRange` / `splitIdRange` (`engine/checkpoint.ts`). Chunk size default `BACKUP_CHUNK_SIZE` (1_000_000).

### 9.5 Artifact writer (`copy-writer.ts`)

- `COPY (SELECT …) TO STDOUT WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`
- Stream → gzip → `*.csv.gz` (atomic rename from `.partial`)
- If `BACKUP_DEV_ROW_LIMIT > 0`: wrap SELECT as `SELECT * FROM (…) LIMIT N` (local sample only)

### 9.6 HIS logic — Adempiere (`produce`)

**Mode decision:** `doFullDump = (mode === 'full') || !initialFullDone`

**Full / first baseline:**

1. List readable tables in schema `adempiere`.
2. For every table **except** append-only set → `full/<schema>.<table>.csv.gz` (`SELECT *`).
3. For append-only tables → `append/` by ID from `0` to captured tip (chunked).

**Incremental (after baseline):**

1. Append-only tables: copy rows with id in `(watermark, captured]` → `append/`.
2. **CDC** from `ad_changelog` in that same id window:
   - Group by `(tablename, record_id)`.
   - If any delete event → write `cdc/deletes_*.csv.gz` (`table_name`, `record_id` only — **no row payload**).
   - Else → `SELECT * FROM table WHERE {table}_id IN (…)` → `cdc/patch_*.csv.gz` (**full current row**, not column diff).
   - Tables without guessed PK `{tablename}_id` are skipped for patches.

**Patient DOB example (conceptual):**

1. Live DB: `UPDATE` patient row; new `ad_changelog` rows.
2. Incremental finds `record_id` in changelog → dumps **entire current patient row** into `cdc/patch_…csv.gz`.
3. Other patients unchanged → not in that incremental artifact.
4. Reconstruct “after change” = Sunday `full/` + apply Monday patches.

### 9.7 EMR logic — Envers / snapshot

**Schema:** `SCHEMA_BY_DATABASE[db]` (see §3). Fail if no usable non-`public` schema.

**Branch A — no `revinfo` or `rev` tip = 0 (snapshot mode):**

- Dump all readable tables to `snapshots/<db>/` (incremental overwrite) or `runs/…/full/` when weekly `full`.
- Watermark often timestamp-based; profile stored as `snapshot`.

**Branch B — Envers available:**

- **Full / first:** dump base tables only (exclude `*_aud` and `revinfo`) → `full/`.
- **Then / incremental:** copy `revinfo` and each `*_aud` for rev in `(watermark, captured]` → `append/`.
- **Incremental only (after baseline):** for each base table with matching `_aud`, export:
  - `cdc/patch_*`: `SELECT b.*` for ids with `revtype IN (0,1)` in window (**full current row**)
  - `cdc/deletes_*`: distinct ids with `revtype = 2`

### 9.8 Scheduler logic

- `BACKUP_SCHEDULE_ENABLED` must be true (env at boot for registration + runtime settings check).
- **Incremental:** dynamic `CronJob`s at `onModuleInit`, one job per **unique resolved cron**; each job passes `databases: […]` for that bucket.
- Cron resolve order: per-DB → group (`BACKUP_HIS|EMR_INCREMENTAL_CRON`) → global `BACKUP_INCREMENTAL_CRON`.
- **Full:** static `@Cron` for HIS and EMR groups separately.
- Changing cron/timezone settings requires **backend restart**.

### 9.9 Retention logic

After each successful orchestrated run:

- Delete run dirs older than `BACKUP_RETENTION_DAYS` **only if** they are **before** the newest run that contains a non-empty `*/full/`.
- **Chain guard:** newest baseline `full/` + every later run are kept even if older than retention.
- `state/` files are never deleted by retention.

### 9.10 Restore logic (plan only)

`GET /admin/backup/restore-plan?database=`

- Lists `.csv.gz` under `snapshots/` then each successful run’s `full` → `append` → `cdc`.
- Notes explicitly: **does not execute restore**.
- Manual intent: apply full, then append by watermark, then CDC patches/deletes.

### 9.11 History & health

- If `BACKUP_HISTORY_ENABLED`: write `backup_run` / per-database rows to app DB after run.
- Else (or empty history): UI lists runs from filesystem union of meta/his/emr `runs/`.
- `/health` backup-freshness: last successful run older than `BACKUP_FRESHNESS_MAX_AGE_HOURS` → unhealthy.

### 9.12 Logic flow diagram

```text
                    ┌─────────────┐
   API / cron / CLI │ BackupService│
                    └──────┬──────┘
                           │ lock + runId
                           ▼
                    ┌──────────────────┐
                    │ BackupRunner     │
                    │  per DB connect  │
                    └──────┬───────────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
      HIS produce     EMR (Envers)    other / no profile
      adempiere       envers|snapshot      skipped
           │               │
           ▼               ▼
   state/*.json checkpoints (pending → commit watermark)
           │
           ▼
   runs/<runId>/<db>/{full,append,cdc}/*.csv.gz
           │
           ▼
   retention (keep newest full chain) + optional history
```

---

## 10. Key source files

| Concern | Path |
| --- | --- |
| Orchestration / API | `src/modules/backup/backup.service.ts`, `backup.controller.ts` |
| Source inventory | `src/modules/backup/source-registry.ts` |
| Config / env settings | `src/modules/backup/backup-config.service.ts` |
| Runner / profile routing | `src/modules/backup/engine/backup-runner.service.ts` |
| HIS profile | `src/modules/backup/engine/profiles/adempiere.profile.ts` |
| EMR profile | `src/modules/backup/engine/profiles/envers.profile.ts` |
| Table discovery | `src/modules/backup/engine/schema.ts` |
| CSV COPY | `src/modules/backup/engine/copy-writer.ts` |
| Checkpoint / watermark | `src/modules/backup/engine/state.ts`, `checkpoint.ts` |
| Lock | `src/modules/backup/engine/lock.ts` |
| Manifest | `src/modules/backup/engine/manifest.ts` |
| Retention / restore plan | `src/modules/backup/zones/retention.service.ts`, `restore-plan.service.ts` |
| Incremental schedules | `src/modules/backup/incremental-schedule.ts`, `backup.scheduler.ts` |
| Ops runbook | `docs/backup-runbook.md` |

---

## 11. Summary diagram

```text
Source groups
├── HIS  → produce (Postgres)
│            └── schema adempiere → N tables (discovered)
│                 watermark: ad_changelog_id
│                 full/ + append/ + cdc/
├── EMR  → signer | file_service | vital_signs | …
│            └── one schema each (see §3) → M tables (discovered)
│                 watermark: rev (Envers) or snapshot timestamp
│                 full|snapshots/ + append/ + cdc/
├── BADL → his (inventory, unreachable)
└── LIS / PACS → unconfigured

Run path: trigger → lock → filter DBs → profile → COPY csv.gz → commit watermark → retention
```

*Last updated from repository analysis of `core-backup-worker-BE` backup module (inventory + implemented backup logic).*
