# Hệ thống backup — mô tả tổng quan & hiện trạng

Cập nhật: **2026-10-26 ~10:30 Asia/Ho_Chi_Minh** (full → `error`)  
Repo: `core-backup-worker-BE` · Server: `xp-cntt-server` · Disk backup: `/mnt/5AE4E9F5E4E9D375` (~11 TB)

Tài liệu này gom: kiến trúc, luồng chạy, cấu hình production, **hiện trạng lúc ghi**, và giải thích vì sao countdown ETA trên dashboard trông quá lâu.

**Phân tích hiệu quả + sự cố 08:56:** [`backup-phan-tich-hieu-qua-2026-10-25.md`](./backup-phan-tich-hieu-qua-2026-10-25.md) (§0).

Chi tiết kỹ thuật sâu hơn: [`luong-he-thong.md`](./luong-he-thong.md), [`backup-runbook.md`](./backup-runbook.md), [`backup-databases.md`](./backup-databases.md).

---

## 1. Hệ thống đang làm gì

Worker kéo dữ liệu từ DB nguồn bệnh viện (secondary) ra đĩa `.csv.gz`, theo dõi tiến độ, lịch sử run, và đẩy trạng thái lên API/SSE cho frontend / màn hình TV.

| Thành phần | Vai trò |
|------------|---------|
| `core-backup-api` | Nest `dist/main.js` — REST `/api/v1`, SSE, cron schedule |
| `core-backup-worker` | Nest `dist/worker.js` — consume BullMQ, dump nặng |
| `core-backup-worker-fe` | Dashboard (port 3001) |
| Postgres app | `core-backup-worker` — settings, `backup_runs`, users |
| Redis | Cache + BullMQ (`REDIS_BULL_DB=1`) + progress/cancel PubSub |

Hai process API/worker cùng image: worker OOM/CPU cao không làm chết HTTP.

---

## 2. Nguồn dữ liệu (source)

| Nhóm | Engine | DB | Profile | Hành vi |
|------|--------|-----|---------|---------|
| **HIS** | Postgres `172.16.16.23` | `produce` | `adempiere` | `full` hoặc lần đầu: dump toàn bộ bảng schema `adempiere`. `incremental`: watermark + append-only + patch |
| **EMR** | Postgres cùng host | 7 DB (`signer`, `file_service`, …) | `envers` / snapshot | Incremental theo `revinfo` nếu có |
| **LIS** | SQL Server `192.168.105.2:1433` | 4 DB (`LabconnXP`, …) | `snapshot` | **Mỗi lần đều export full bảng** (cron gọi `incremental` nhưng profile bỏ qua) |
| BADL / PACS | — | — | — | Inventory / chưa chạy |

Production bắt buộc: `NODE_ENV=production`, `BACKUP_DEV_ROW_LIMIT=0` (không LIMIT mẫu). Dev `yarn dev` có LIMIT → “nhanh giả”, không phản ánh prod.

---

## 3. Luồng một lần backup

```text
Cron (API)  hoặc  POST /api/v1/admin/backup/runs?mode=full|incremental
        │
        ▼
BackupService.triggerRun → BackupQueueService.enqueue
        │  backup_runs = queued
        │  BullMQ queue-full | queue-incremental  (jobId = runId)
        ▼
Worker processor → BackupJobRunner
        │  progress Redis + cancel AbortSignal
        ▼
BackupRunnerService  (từng DB, lock locks/<db>.lock)
        │
        ▼
Profile (adempiere / envers / mssql-snapshot)
        │  COPY/stream → runs/<runId>/<db>/.../*.csv.gz
        │  state/<db>.json (watermark + pending resume)
        ▼
backup_runs / backup_database_runs  +  SSE / wallboard
```

| Queue | Concurrency | Mode |
|-------|-------------|------|
| `queue-incremental` | 2 | incremental |
| `queue-full` | 1 | full |

`lockDuration` BullMQ = **6 giờ** — restart worker giữa chừng dễ để job “zombie” nếu recovery cũ bỏ qua `active`. Đã siết: lúc boot, job `active` orphan → fail + DB `error`.

---

## 4. Đĩa & retention

| Volume (trong container) | Host |
|--------------------------|------|
| `/app/backup-storage/his` | `.../backup-storage/his` |
| `/app/backup-storage/emr` | `.../emr` |
| `/app/backup-storage/lis` | `.../lis` |
| `/app/backup-storage/meta` | locks, meta |

Layout: `runs/<runId>/<database>/full|append/`, `state/<database>.json`.

---

## 5. Lịch (cron) — cấu hình hiện tại

| Key | Value | Ý nghĩa |
|-----|-------|---------|
| `BACKUP_SCHEDULE_ENABLED` | **`false`** (tạm tắt) | Tránh đụng full manual |
| `BACKUP_HIS_INCREMENTAL_CRON` | `0 */4 * * *` | HIS mỗi 4 giờ |
| `BACKUP_EMR_INCREMENTAL_CRON` | `30 */4 * * *` | EMR |
| `BACKUP_LIS_INCREMENTAL_CRON` | `0 */4 * * *` | LIS |
| `BACKUP_*_FULL_CRON` | Chủ nhật ~01:30 / 02:30 / 03:30 | Full theo nhóm |
| `BACKUP_DEV_ROW_LIMIT` | `0` | Production unlimited |

**Nhớ bật lại** `BACKUP_SCHEDULE_ENABLED=true` (qua FE Cấu hình hoặc API settings) khi full baseline xong.

---

## 6. Progress & ETA trên dashboard

### Cách tính %

\[
\text{overallFrac} = \frac{\text{dbIndex} + \text{tablesDone}/\text{tablesTotal}}{\text{dbCount}}
\]

Full HIS+EMR+LIS ≈ **12 DB**. HIS `produce` ≈ **1200 bảng**. Vài chục bảng đầu + đang dump một bảng khổng lồ → overallFrac rất nhỏ → UI làm tròn / sàn **1%**.

### Vì sao countdown (ETA) trông quá lâu

Công thức cũ (đã lỗi UX):

\[
\text{etaSeconds} \approx \text{elapsed} \times \frac{100 - \text{percent}}{\text{percent}}
\]

Khi `percent` bị **sàn = 1** trong khi tiến độ thật chỉ ~0.3–0.5%:

- Elapsed ~13 phút → ETA ≈ \(13 \times 99\) ≈ **21 giờ** (`etaSeconds ≈ 76500`) — **không phản ánh thực tế**, chỉ là nhân 99 lần thời gian đã chạy.

Thêm nữa: bảng như `adempiere.ad_attachment` có thể nhiều GB một mình; ETA theo số bảng cũng không ổn định giữa chừng.

### Đã sửa trong code (cần deploy để có trên process đang chạy)

File: `src/modules/backup/progress/backup-progress.publisher.ts`

- ETA dùng **overallFrac thật**, không dùng percent sàn 1%.
- Nếu `overallFrac < 2%` → **`etaSeconds = null`** (dashboard hiện `—`) thay vì countdown ảo.
- Progress vẫn emit bảng đang chạy + bytes mid-COPY (sau fix telemetry trước đó).

> **Lưu ý vận hành:** deploy/restart worker interrupt job đang chạy (resume theo `state/*.json` pending). Full `…T13-55` đã `error` lúc 08:56 — có thể deploy ETA fix rồi **re-trigger full** để resume, hoặc chạy incremental trước nếu ưu tiên freshness.

---

## 7. Hiện trạng lúc cập nhật doc (2026-10-26 10:30)

### Process / health

| Service | Status |
|---------|--------|
| `core-backup-api` | Up ~1h (sau docker restart 09:34), healthy |
| `core-backup-worker` | Up ~1h, healthy · **không** còn job backup |
| `core-backup-worker-fe` | Up, healthy |
| Schedule | **Tắt** (`BACKUP_SCHEDULE_ENABLED=false`) |
| Freshness | **Không healthy** · last success 25/10 10:53 · age **~23,7 giờ** / ngưỡng 5 giờ |
| `jobSummary` | ok 1 · error **4** · running **0** |

### Sự cố full `error` (~08:56)

| Field | Value |
|-------|--------|
| `runId` (UI/DB) | `2026-10-25T13-55-01-379Z` |
| Status | **`error`** · `finishedAt` **08:56:22** ICT |
| Message | `Interrupted by worker restart (backup was interrupted)` |
| Files trên đĩa | Resume `...T13-43-51-750Z` (pending còn) |
| Phase lúc chết | Append `adempiere.ad_changelog` chunk **965M→966M** (~**81,6%** tip) |
| Đã giữ | Full **1202/1202** (~43 GiB) + **965** chunk changelog (~93 GiB) |
| Leftover | `…965000000_966000000.csv.gz.partial` |
| Nguyên nhân gần | PG HIS `Connection terminated unexpectedly` → worker `exitCode=1` → orphan recovery |
| Không phải | OOM, đầy đĩa, cancel tay, lỗi dump logic bảng |
| Sau đó (~09:30) | `docker.service` stop/start — **không** phải gốc đánh error lúc 08:56 |

Overview vẫn `percent=8`, `currentTable=ws_webservicetypeaccess` (stale) — **không dùng để vận hành**. Chi tiết chuỗi nguyên nhân: [`backup-phan-tich-hieu-qua-2026-10-25.md`](./backup-phan-tich-hieu-qua-2026-10-25.md) §0.

### Run gần đây

| runId | Mode | Status | Ghi chú |
|-------|------|--------|---------|
| `...T13-55-01-379Z` | full | **error** | Baseline; đứt lúc append changelog |
| `...T13-43-51-750Z` | full | error | Interrupt 20:54 ngày 25; **file resume vẫn dùng** |
| `...T09-00` / `...T05-00` | incr | error | Restart/cancel ngày 25 |
| `...T03:53` produce | incr | ok | Last success freshness |
| Ngày 26 | — | — | Chưa có incremental mới (lịch tắt) |

### Disk

| Path | Size (approx) |
|------|----------------|
| Mount backup | 11 TB · đã dùng **~200–214 GB (~1,8%)** · còn ~11 TB |
| Run resume | full **~43 GiB** + append **~93 GiB** |
| `lis/` / `emr/` | ~9,4 GB / ~33 MB |

---

## 8. Việc đã xử lý trong ngày (tóm tắt)

1. Phát hiện zombie run 12:00 (BullMQ `active` + lock 6h, cancel UI vô hiệu).
2. Force-clean + restart; tắt schedule.
3. Fix recovery: orphan `active` lúc worker boot → failed + mark DB error.
4. Trigger `mode=full` HIS+EMR+LIS (production, `BACKUP_DEV_ROW_LIMIT=0`).
5. Fix telemetry: mid-COPY bytes + bảng đang chạy; % sàn 1% để UI không đứng 0.
6. Fix ETA (trong source): không dùng percent sàn cho countdown; ẩn ETA khi &lt; 2% overall — **chưa deploy**.
7. **08:56:** full fail do PG disconnect + worker restart → orphan recovery (pending ~81,6% tip vẫn còn).
8. **09:30–09:34:** docker.service restart toàn host (sau fail).

---

## 9. Checklist vận hành tiếp

1. **Trigger lại full** (cùng groups) để resume pending từ chunk ~965M — hoặc tạm bỏ baseline và chạy **incremental** nếu ưu tiên freshness (age > 23 giờ).
2. Bật `BACKUP_SCHEDULE_ENABLED=true` khi chấp nhận lịch chạy lại (hiện vẫn tắt).
3. Tránh restart Docker/worker khi đang append dài; kiểm tra ổn định kết nối HIS `172.16.16.23:5432`.
4. Deploy bản ETA / `currentTable` append khi không còn job dài.
5. Dashboard: tin **pending + thư mục đĩa + age freshness**; không tin `currentTable=ws_*` / % overview khi append.

---

## 10. API hữu ích

| Method | Path |
|--------|------|
| `POST` | `/api/v1/admin/backup/runs?mode=full&groups=HIS,EMR,LIS` |
| `POST` | `/api/v1/admin/backup/runs/:runId/cancel` |
| `GET` | `/api/v1/admin/backup/queue` |
| `GET` | `/api/v1/admin/backup/sources` |
| `GET` | `/api/v1/admin/backup/runs` |
| `PUT` | `/api/v1/admin/settings/BACKUP_SCHEDULE_ENABLED` body `{"value":"true"|"false"}` |

Cần JWT (`POST /api/v1/auth/login`).

---

## 11. Liên kết code chính

| Việc | Path |
|------|------|
| Runner | `src/modules/backup/engine/backup-runner.service.ts` |
| HIS profile | `src/modules/backup/engine/profiles/adempiere.profile.ts` |
| LIS profile | `src/modules/backup/engine/profiles/mssql-snapshot.profile.ts` |
| COPY → gzip → file | `src/modules/backup/engine/copy-writer.ts` (`createGzip({ level: 6 })`) |
| Queue / recovery / cancel | `src/modules/backup/queue/` |
| Progress + ETA | `src/modules/backup/progress/backup-progress.publisher.ts` |
| Deploy | `./deploy.sh` → `scripts/deploy-prod.sh` |

---

## 12. Phân tích hiệu quả

Bản đầy đủ (cập nhật sáng 26/10 + phụ lục đo tối 25/10):

→ [`backup-phan-tich-hieu-qua-2026-10-25.md`](./backup-phan-tich-hieu-qua-2026-10-25.md)

Tóm tắt 10:30 ngày 26: full `…T13-55-01-379Z` → **`error`** lúc **08:56** (PG disconnect → worker exit 1 → orphan *Interrupted by worker restart*). Pending giữ full 1202 + changelog **~81,6% tip** (~93 GiB append) — **resume được**. Freshness age **~23,7 giờ**, lịch vẫn tắt. Docker restart 09:30 là sự kiện sau. Chi tiết §0 file phân tích.
