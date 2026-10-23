# Luồng hệ thống — Backend

Tài liệu này mô tả backend đang làm gì, một lần backup đi qua đâu, queue BullMQ nằm ở đâu, và cách vận hành. Chi tiết schema HIS nằm ở [`his-database.md`](./his-database.md).

Deploy production là **hai process NestJS** từ cùng image / mã nguồn:

| Service | Entry | Vai trò |
|---------|-------|---------|
| `backup-api` | `node dist/main.js` | REST API (`/api/v1/...`), SSE, cron (`ScheduleRegistry`) |
| `backup-worker` | `node dist/worker.js` | Chỉ consume BullMQ (dump nặng) |

Khi worker OOM hoặc CPU cao, HTTP API vẫn sống. CLI `yarn backup:run` là process thứ ba (không qua Redis).

Global HTTP prefix: `api/v1`. Liveness `/` và Swagger `/documentation` không có prefix.

---

## Hệ thống đang làm gì

Worker kéo dữ liệu từ các database nguồn của bệnh viện ra đĩa backup, theo dõi tiến độ, và cho frontend / màn hình TV đọc trạng thái.

| Nhóm | Engine | Database đang biết | Cách backup |
|------|--------|--------------------|-------------|
| HIS | Postgres, profile `adempiere` | `produce` | Lần đầu (hoặc `mode=full`) dump full. Sau đó chỉ copy phần id mới của bảng append-only, cộng bản vá / xóa của bảng nghiệp vụ. |
| EMR | Postgres, profile `envers` | `signer`, `file_service`, `vital_signs`, `research_management`, `medical_incident`, `html_editor`, `phat_thuoc` | Nếu có `revinfo` thì incremental theo revision. Không có `revinfo` thì snapshot đè toàn bộ bảng. |
| LIS | SQL Server, profile `snapshot` | `BloodStorage_XanhPon`, `Labconnect_Card`, `LabconnXP`, `LabInventory_XP` | Mỗi lần chạy export full CSV gzip, chia chunk keyset khi có PK một cột. Cron vẫn gọi `mode=incremental`, nhưng profile LIS bỏ qua incremental. |
| BADL | Cùng profile Envers | Theo `BADL_*` | Chỉ để trong inventory. Mặc định `unreachable`, không được đưa vào run. |
| PACS | Chưa có profile | Theo `PACS_*` | Nếu có cấu hình vẫn bị đánh `unconfigured`. Run sẽ bỏ qua. |

File ra đĩa là `.csv.gz`. Watermark nằm trong `state/<database>.json`. Lịch sử run nằm trong `backup_runs` / `backup_database_runs`.

---

## Ba cổng vào cùng một engine

```text
Cron (BackupScheduler, api)  ──┐
HTTP POST /api/v1/admin/backup/runs ──┼── BackupService.triggerRun()
                                      │         │
                                      │         ▼
                                      │   BackupQueueService.enqueue()
                                      │         │  1. INSERT backup_runs status=queued
                                      │         │  2. BullMQ queue-incremental | queue-full
                                      │         ▼
                                      │   Worker processors
                                      │         │
                                      │         ▼
                                      │   BackupService.executeQueuedRun()
                                      │         │  per-database locks/
                                      │         ▼
                                      └── BackupRunnerService.run()
                                                │
CLI yarn backup:run ────────────────────────────┘
```

---

## BullMQ — hai queue

| Queue | Concurrency | Priority | Mode |
|-------|-------------|----------|------|
| `queue-incremental` | 2 | 1 (cao) | `incremental` |
| `queue-full` | 1 | 10 (thấp) | `full` |

| Việc | File |
|------|------|
| Tên queue | `src/modules/backup/queue/backup-queue.constants.ts` |
| Enqueue / cancel / recover | `backup-queue.service.ts` |
| Processors | `backup-incremental.processor.ts`, `backup-full.processor.ts` |
| Cancel registry + killers | `backup-cancel.registry.ts` |
| Redis PubSub (cancel + progress) | `backup-redis.service.ts` |

`jobId` = `runId`. Redis BullMQ dùng `REDIS_BULL_DB` (default 1).

### Khóa theo database

Không còn `backup.lock` toàn cục cho queue path. Mỗi database lấy `locks/<database>.lock` trên volume meta. DB đang bị run khác giữ → `status=skipped`, message `locked by run <id>`; các DB khác trong cùng run vẫn chạy.

### Recovery

`BackupQueueRecoveryService` chỉ chạy trên **worker** boot: đánh stale `running` (khi Redis không còn job active), clear lock stale, re-enqueue orphan `queued`. API restart **không** đánh fail các run đang chạy trên worker.

---

## Cron hot-reload

`BackupScheduler` đăng ký lúc boot và hỗ trợ `reload()`:

- `POST /api/v1/config` với body `{ settings: { BACKUP_HIS_FULL_CRON: "...", ... } }`
- `PUT /api/v1/admin/settings/:key` khi key là cron/timezone cũng gọi reload qua `BackupScheduleReloadBus`

Validate cron trước; lỗi → giữ lịch cũ, trả 400. Không cần restart process.

`BACKUP_SCHEDULE_ENABLED=false` vẫn đăng ký cron nhưng không enqueue.

---

## Hủy triệt để

`POST /api/v1/admin/backup/runs/:runId/cancel`

| Job state | Việc làm |
|-----------|----------|
| waiting / delayed / prioritized | `job.remove()`, status `cancelled` |
| active | Redis `backup:cancel:<runId>` + PubSub → worker abort + native kill |

Native kill:

- Postgres: `pg_cancel_backend(pid)`, sau 10s nếu còn thì `pg_terminate_backend`
- SQL Server: `request.cancel()` (TDS), fallback `KILL <spid>`

Runner kiểm tra `AbortSignal` giữa các bảng/chunk. Default `BACKUP_STATEMENT_TIMEOUT_MS=21600000` (6 giờ).

---

## SSE tiến độ

| Endpoint | Auth | Ghi chú |
|----------|------|---------|
| `GET /api/v1/runs/:id/stream` | JWT (header hoặc `?access_token=`) | Spec mới; Redis PubSub |
| `GET /api/v1/admin/backup/stream?runId=` | JWT | Legacy fan-out qua `BackupEventsService` |
| `GET /api/v1/public/backup/stream` | Public | Wallboard, không log chi tiết |

Worker publish (camelCase JSON): `percent`, `rowsProcessed`, `bytesProcessed`, `rowsPerSec`, `bytesPerSec`, `etaSeconds`, `tablesDone`/`tablesTotal`, `dbIndex`/`dbCount`, `startedAt`, `currentDatabase`, `currentTable`, `log` line, `status`. Snapshot cuối ở Redis key `backup:progress:last:<runId>`. Public SSE bridge map sang `run.progress` (`rowsTotal` = cumulative processed, `bytesTotal`, rates, ETA).

---

## HTTP (prefix `api/v1`)

### Backup — `/api/v1/admin/backup`

| Method | Path | Việc |
|--------|------|------|
| `POST` | `/runs?...` | Enqueue. `202`. |
| `POST` | `/runs/:runId/cancel` | Hủy. |
| `GET` | `/queue` | Snapshot BullMQ + DB queued/running. |
| `POST` | `/queue/cancel-all-queued` | Hủy mọi run `status=queued`. |
| `GET` | `/runs`, `/runs/:runId` | Lịch sử. |
| `GET` | `/sources`, `/zones`, `/restore-plan` | Metadata. |
| `GET` | `/stream?runId=` | SSE admin. |

Worker startup `recoverStaleState`: re-enqueue DB `queued` khi Redis mất job; mark `cancelled` nếu Redis job `failed`/`completed` mà DB vẫn `queued`.

### Config / runs stream

| Method | Path | Việc |
|--------|------|------|
| `POST` | `/api/v1/config` | Cập nhật settings cron + hot-reload. |
| `GET` | `/api/v1/runs/:id/stream` | SSE tiến độ một run. |

### Public

| Method | Path | Việc |
|--------|------|------|
| `GET` | `/api/v1/public/backup/overview` | Wallboard aggregate (xem payload bên dưới). |
| `GET` | `/api/v1/public/backup/stream` | SSE wallboard (`run.progress` / `run.status`, không log). |

**Overview extras (wallboard):**

- `activeJob` — run `running` + last Redis progress (%, rows, bytes, rates, ETA).
- `databases[].watermark`, `databases[].lagMinutes` — lag = phút kể từ `lastStartedAt` (backup freshness, không query tip nguồn).
- `disk.forecast` — `dailyGrowthBytes` (sample 7 ngày tại `state/disk-usage-samples.json`), `compressionRatio` / `compressionSavingsPercent` (ước lượng từ row×180B vs gzip bytes), `estimatedDaysUntilFull`.
- `schedule` — `enabled`, `nextIncrementalAt`, `nextFullAt`, `nextFullLabel` (cron sớm nhất, TZ `Asia/Ho_Chi_Minh`).

### Khác

| Method | Path | Việc |
|--------|------|------|
| `GET` | `/` | Liveness (healthcheck Docker). |
| `GET` | `/api/v1/health` | Process + freshness (có thể 503). |
| `*` | `/api/v1/auth/*`, `/api/v1/admin/users`, `/api/v1/admin/settings` | Auth / users / settings. |

---

## Docker Compose

```yaml
backup-api:    command node dist/main.js   # port 3000
backup-worker: command node dist/worker.js # mem_limit 4g, no port
```

Cả hai mount `backup-storage`. Scripts: `yarn start:prod`, `yarn start:worker`, `yarn dev`, `yarn dev:worker`.

---

## LIS keyset

Khi bảng có PK/unique một cột phù hợp: lặp `SELECT TOP (@chunk) * WHERE pk > @last ORDER BY pk`, file `schema.table.000001.csv.gz`. Không có khóa → stream full + warn. Chunk size mặc định theo `BACKUP_CHUNK_SIZE` (cap 500000 cho LIS khi cần).

---

## Việc chưa làm / lưu ý

- Archive filesystem / S3 vẫn no-op.
- Profile PACS chưa có.
- BADL mặc định unreachable.
- Ba job song song tăng tải DB nguồn — theo dõi giờ cao điểm.
- `KILL` SQL Server cần quyền `ALTER ANY CONNECTION`; đường chính là `request.cancel()`.
