# Phân tích hiệu quả backup — 25–26/10/2026

**Cập nhật mới nhất:** 2026-10-26 **10:30** Asia/Ho_Chi_Minh (sự cố lỗi full)  
**Server:** `xp-cntt-server`  
**Mốc trước:** 08:02 (job còn chạy) · 25/10 22:20–22:36 (giữ ở §8–§9)

Doc hiện trạng hệ thống: [`backup-he-thong-va-hien-trang.md`](./backup-he-thong-va-hien-trang.md).

---

## 0. Sự cố — full chuyển `error` (26/10 ~08:56)

### Triệu chứng trên dashboard / overview

| Field | Value |
|-------|--------|
| Run | `2026-10-25T13-55-01-379Z` · full manual HIS+EMR+LIS |
| Status | **`error`** (không còn `running`) |
| `finishedAt` | 2026-10-26 **08:56:22** ICT |
| Message | **`Interrupted by worker restart (backup was interrupted)`** |
| `jobSummary` | ok 1 · error **4** · running 0 |
| Freshness | Vẫn unhealthy · last success 25/10 10:53 · age **~23,6 giờ** |
| Lịch | Vẫn **tắt** |

### Chuỗi nguyên nhân (đã đối chiếu journal + docker logs)

```text
Đang COPY append ad_changelog (chunk ~965M→966M)
        │
        ▼
Postgres client: "Connection terminated unexpectedly"
        │
        ▼
Container core-backup-worker exitCode=1  (~08:56:15 ICT)
  · wall ~12h · CPU peak tích lũy ~15h45 · memory peak ~2.7G
  · không OOMKilled
        │
        ▼
restartPolicy=unless-stopped → tự start lại worker (~08:56:17)
        │
        ▼
Boot recovery BackupQueueService:
  · Moved orphan active job …T13-55-01-379Z to failed
  · Marked stale running run … as error
  · Cleared stale database locks: produce
        │
        ▼
Dashboard hiện Lỗi / Interrupted by worker restart
```

**Không phải** lỗi logic dump bảng, **không phải** đầy đĩa, **không phải** cancel tay.

Sự kiện **sau đó** (không phải nguyên nhân đánh `error` của run — run đã fail lúc 08:56):

| Thời điểm ICT | Việc |
|---------------|------|
| ~09:30 | Redis `ECONNREFUSED` ngắn |
| 09:30–09:34 | **`docker.service` bị stop rồi start lại** (toàn bộ container host) |
| ~09:34 | api / worker / fe / redis lên lại, healthy |

### Tiến độ đã giữ được trên đĩa (resume được)

Pending vẫn trỏ run file `2026-10-25T13-43-51-750Z`:

| Hạng mục | Lúc fail (~08:56) |
|----------|-------------------|
| Full tables | **1202/1202** (~42,2 GiB) — giữ nguyên |
| `ad_changelog` chunks completed | **965** · last key `…:964000000:965000000` |
| Tip `pending.captured` | `1.183.187.252` |
| Tiến độ tip | **~81,6%** |
| Leftover | `adempiere.ad_changelog.965000000_966000000.csv.gz.partial` (chunk đang ghi lúc chết) |
| Append đã ghi | ~**93 GiB** |

Trigger lại `mode=full` (cùng profile) sẽ **bỏ qua** 1202 full + 965 chunk changelog đã có trong `completedChunkKeys`, tiếp từ khoảng id 965M — **không phải làm lại từ đầu**.

### Việc nên làm tiếp

1. Trigger lại full HIS (hoặc HIS+EMR+LIS) để resume pending — ưu tiên nếu cần hoàn tất baseline.
2. Hoặc tạm bỏ baseline: bật lịch / chạy **incremental** ngay (freshness đã > 23 giờ).
3. Tránh restart Docker / worker khi đang append dài; theo dõi kết nối tới HIS `172.16.16.23:5432` (nguyên nhân gần: connection drop giữa COPY).
4. Cân nhắc: full-from-zero `ad_changelog` quá dài → dễ dính restart giữa chừng.

---

## 1. Tóm tắt mốc 08:02 (trước khi lỗi) — để so sánh

| Câu hỏi | Trả lời lúc 08:02 |
|---------|-------------------|
| Full còn chạy? | **Có** — ~11,1 giờ elapsed |
| Phase | Append `ad_changelog` (~73% tip lúc đó) |
| Freshness | Unhealthy · age 21,1 giờ |
| Lịch | Tắt |
| Nút thắt | Gzip/CPU ~3 MB/s |

| KPI | 25/10 22:20 | 26/10 08:02 | 26/10 10:30 |
|-----|-------------|-------------|-------------|
| Status full | running | **running** | **`error`** (08:56) |
| Tuổi bản sao | 11,4 giờ | 21,1 giờ | **~23,6 giờ** |
| Changelog tip | — | ~73% | **~81,6%** lúc chết |
| File produce run | ~20 GiB | full 43 + append 84 | full 42 + append **~93** GiB |

---

## 2. Freshness & lịch (10:30 — sau lỗi)

| Metric | Giá trị |
|--------|---------|
| `freshness.healthy` | `false` |
| `lastSuccessAt` | 2026-10-25 **10:53** ICT — incremental `produce` manual |
| `ageHours` | **~23,7** |
| `maxAgeHours` | 5 |
| `scheduleEnabled` | **`false`** |
| `jobSummary` | ok 1 · error **4** · running **0** |
| Next incremental (tính toán) | không bắn khi lịch tắt |
| Next full HIS | 01:30 Chủ nhật 01/11 |

12 database vẫn `ready` / `live`. `produce.lastRunStatus=ok` vẫn trỏ lần incremental 10:53 (full lỗi **không** đổi last success). `lagState=missed` · `lagMinutes` ~1420+.  
Ngày **26/10** trong `historyByDay`: **0 run** kết thúc (full fail gắn ngày 25 theo `startedAt`).

> Tin `freshness.ageHours` / `lastSuccessAt`, không chỉ badge lag.

---

## 3. Full job — timeline đến khi lỗi

Run UI: `2026-10-25T13-55-01-379Z` (full manual HIS+EMR+LIS).  
File ghi tiếp vào run resume `2026-10-25T13-43-51-750Z`.  
Pending: `his/state/produce.json` · `updatedAt` ~**08:55** ICT · `completedChunkKeys` **2167** (1202 full + 965 changelog).

```text
25/10 20:55     Full manual bắt đầu (resume pending)
25/10 20:43–00:31  Phase FULL: 1202 bảng → produce/full (~43 GiB)
26/10 00:31     Bảng full cuối: ws_webservicetypeaccess
26/10 00:31→08:56  Phase APPEND: ad_changelog 0 → tip (chunk tới ~965M)
26/10 ~08:56    PG "Connection terminated unexpectedly" → worker exit 1
                → orphan recovery → status=error
26/10 09:30–09:34  docker.service stop/start (sau khi job đã fail)
```

| Phase | Đường dẫn | Dung lượng nén | Trạng thái 10:30 |
|-------|-----------|----------------:|------------------|
| Full tables | `.../produce/full/` | **~43 GiB** · 1202 file | **Xong** (giữ trong pending) |
| Append changelog | `.../produce/append/` | **~93 GiB** · 965 chunk + 1 `.partial` | **Dừng ~81,6% tip** |
| EMR / LIS | — | — | Chưa tới |

Leftover: `adempiere.ad_changelog.965000000_966000000.csv.gz.partial` (chunk đang COPY lúc chết — lần resume sẽ làm lại chunk này).

### Telemetry UI vẫn lệch (kể cả sau khi error)

| Field overview | Value | Thực tế |
|----------------|-------|---------|
| `activeJob.status` | `error` | Đúng |
| `percent` | 8 | Không phản ánh ~81% tip changelog |
| `currentTable` | `ws_webservicetypeaccess` | Stale từ lúc hết phase full (00:31) |
| `finishedAt` | 08:56:22 ICT | Khớp orphan recovery |

---

## 4. Dung lượng đĩa (10:30)

| Metric | Value |
|--------|-------|
| Used | **~1,8%** · ~200–214 GB · còn ~11 TB |
| Run resume | full **43 GiB** + append **93 GiB** |
| Isolated copy | Chưa cấu hình |
| Lock produce | Đã clear lúc recovery |

Đĩa **không** liên quan tới lỗi; vẫn dư chỗ lớn.

---

## 5. Nút thắt tốc độ (trước khi crash) + nguyên nhân fail

Trước 08:56 cùng pattern tối 25/10: **gzip/CPU một luồng** (~3 MB/s nén) + `ad_changelog` append-from-zero — không phải đĩa.

**Nguyên nhân fail gần nhất:** kết nối Postgres HIS đứt giữa COPY (`Connection terminated unexpectedly`) → process worker thoát mã 1 → restart container → boot recovery đánh orphan `active` → message UI *Interrupted by worker restart*. Không OOM. Docker daemon restart ~09:30 là sự kiện **sau**, không phải gốc của `error` lúc 08:56.

---

## 6. Hướng xử lý (sau lỗi)

| Ưu tiên | Việc | Vì sao |
|--------:|------|--------|
| 1 | **Trigger lại `mode=full`** (HIS hoặc HIS+EMR+LIS) để resume pending | Giữ 1202 full + 965 chunk; tiếp từ ~965M — không làm lại từ đầu |
| 2 | Hoặc ưu tiên freshness: bật lịch / chạy **incremental** ngay | Age **~23,7 giờ**; ngày 26 chưa có bản sao mới |
| 3 | Tránh restart Docker/worker khi đang append dài; theo dõi link tới `172.16.16.23:5432` | Crash vừa rồi bắt đầu từ PG disconnect |
| 4 | Cân nhắc product: full không dump lại toàn bộ `ad_changelog` từ 0 nếu watermark đã có | Append-from-zero ~12h+ → dễ dính restart giữa chừng |
| 5 | Deploy fix telemetry `currentTable` / ETA khi không còn job dài | UI vẫn stale ở `ws_*` |

---

## 7. Recent jobs (DB `backup_runs`)

| run_id | mode | status | error (rút gọn) |
|--------|------|--------|-----------------|
| `...T13-55-01-379Z` | full | **error** | Interrupted by worker restart |
| `...T13-43-51-750Z` | full | error | Interrupted… (20:54 ngày 25; file resume) |
| `...T09-00` | incr | error | Stale after process restart |
| `...T05-00` | incr | error | Cancel requested |
| `...T03-53` produce | incr | **ok** | Last success freshness |

Không có incremental mới sau 10:53 ngày 25. `running=0`.
---

## 8. Phụ lục — mốc đo tối 25/10 (22:20–22:36)

Giữ để so sánh; chi tiết đo gzip vs đĩa nằm đây.

### 8.1 KPI lúc đó

| KPI | Value |
|-----|-------|
| Freshness age | 11,4 giờ / ngưỡng 5 giờ |
| Nhịp incremental có bản sao trong ngày | 3/6 |
| Run kết thúc OK | 7/10 |
| Phase | Full dump bảng `produce` (~48% so với full 23/10 theo GiB) |
| Ghi `.partial` | **~3,7 MB/s** |
| NIC RX HIS | **~12,4 MB/s** |
| CPU worker | 110–130% |
| `dd` đĩa NTFS/FUSE | 43–65 MB/s · `%util` sdb ~0% |

### 8.2 Nhịp incremental 25/10

| Nhịp ICT | Kết quả | Thời lượng |
|----------|---------|------------|
| 00:00 | OK | 43 giây |
| 04:00 | OK | 25 giây |
| 08:00 | OK | 54 giây — bản sao cuối 11 DB |
| 12:00 | error | Cancel requested (restart ~19:50) |
| 16:00 | error | Stale after process restart |
| 20:00 | không chạy | lịch tắt |

### 8.3 Loại trừ nút thắt (đo tối 25/10)

| Giả thuyết | Kết luận |
|------------|----------|
| Gzip / CPU một luồng | **Đúng** |
| Đĩa lưu chậm | **Sai** — dư ~15× |
| Đọc file local chậm | **Sai** — COPY từ Postgres HIS |
| Mạng LAN kém | **Sai** — ping 0,3 ms |

### 8.4 Bảng full nặng đã gặp tối 25/10

`ad_attachment` (~4,9 GB, ~26 phút) là bảng full chậm nhất lúc đó; `his_service_product` (~6,4 GB) còn phía trước — **đã vượt qua** trước 00:31 ngày 26.

---

## 9. Liên kết

| Doc / code | Path |
|------------|------|
| Hiện trạng + ETA + checklist | [`backup-he-thong-va-hien-trang.md`](./backup-he-thong-va-hien-trang.md) |
| Runbook | [`backup-runbook.md`](./backup-runbook.md) |
| COPY → gzip | `src/modules/backup/engine/copy-writer.ts` |
| Profile HIS / APPEND_ONLY | `src/modules/backup/engine/profiles/adempiere.profile.ts` |
| Progress / ETA | `src/modules/backup/progress/backup-progress.publisher.ts` |
