# Lịch backup hiện tại

Cập nhật **2026-11-08**, múi giờ `Asia/Ho_Chi_Minh`. Chiến thuật: **tách đêm theo nhóm** — mỗi full chiếm một đêm riêng, tránh xếp hàng trên full queue (`concurrency=1`).

`BACKUP_SCHEDULE_ENABLED` = **`true`**.

Ngưỡng freshness: `BACKUP_FRESHNESS_MAX_AGE_HOURS=48`.

## Tóm tắt

| Nhóm | Incremental | Full | Logical |
| --- | --- | --- | --- |
| HIS (`produce`) | 23:00 Chủ nhật–thứ Năm | **22:00 thứ Sáu** | 23:30 thứ Bảy |
| EMR (7 database) | 03:00 mỗi ngày | **22:00 thứ Bảy** | 01:00 Chủ nhật |
| LIS (4 database) | 05:00 thứ Hai–thứ Bảy | **21:00 Chủ nhật** | không có |

## Cuối tuần (full tách đêm)

| Đêm | Giờ | Job | Kỳ vọng |
| --- | --- | --- | --- |
| T6 | 22:00 | HIS full | ~04:00–05:00 T7 (~6 giờ) |
| T7 | 03:00 / 05:00 | EMR incr / LIS incr | bình thường |
| T7 | 22:00 | EMR full | ~22:45 (~45 phút) |
| T7 | 23:30 | HIS logical | sau EMR |
| CN | 01:00 | EMR logical | |
| CN | 03:00 | EMR incr | |
| CN | 21:00 | LIS full | ~05:00–06:00 T2 (~8 giờ) |

Thứ Sáu không có HIS incremental (23:00 T6 trùng cửa sổ HIS full). Chủ nhật không có LIS incremental (đêm LIS full).

## Tuần (incremental)

| Giờ | T2 | T3 | T4 | T5 | T6 | T7 | CN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01:00 | | | | | | | EMR logical |
| 03:00 | EMR incr | EMR incr | EMR incr | EMR incr | EMR incr | EMR incr | EMR incr |
| 05:00 | LIS incr | LIS incr | LIS incr | LIS incr | LIS incr | LIS incr | |
| 21:00 | | | | | | | LIS full |
| 22:00 | | | | | HIS full | EMR full | |
| 23:00 | HIS incr | HIS incr | HIS incr | HIS incr | | | HIS incr |
| 23:30 | | | | | | HIS logical | |

## Cron trong `app_settings`

| Key | Value |
| --- | --- |
| `BACKUP_TIMEZONE` | `Asia/Ho_Chi_Minh` |
| `BACKUP_SCHEDULE_ENABLED` | `true` |
| `BACKUP_INCREMENTAL_CRON` | `0 23 * * 0-4` |
| `BACKUP_HIS_INCREMENTAL_CRON` | `0 23 * * 0-4` |
| `BACKUP_EMR_INCREMENTAL_CRON` | `0 3 * * *` |
| `BACKUP_LIS_INCREMENTAL_CRON` | `0 5 * * 1-6` |
| `BACKUP_HIS_FULL_CRON` | `0 22 * * 5` |
| `BACKUP_EMR_FULL_CRON` | `0 22 * * 6` |
| `BACKUP_LIS_FULL_CRON` | `0 21 * * 0` |
| `BACKUP_HIS_LOGICAL_CRON` | `30 23 * * 6` |
| `BACKUP_EMR_LOGICAL_CRON` | `0 1 * * 0` |
| `BACKUP_FRESHNESS_MAX_AGE_HOURS` | `48` |

`BACKUP_INCREMENTAL_CRON_<database>` khớp cron nhóm:

| Database | Nhóm | Cron |
| --- | --- | --- |
| `produce` | HIS | `0 23 * * 0-4` |
| `signer`, `file_service`, `vital_signs`, `research_management`, `medical_incident`, `html_editor`, `phat_thuoc` | EMR | `0 3 * * *` |
| `BloodStorage_XanhPon`, `Labconnect_Card`, `LabconnXP`, `LabInventory_XP` | LIS | `0 5 * * 1-6` |

## Rủi ro còn lại

- LIS full ~8 giờ: bắt đầu 21:00 CN vẫn có thể chạm 05:00–06:00 T2.
- HIS full ~6 giờ: 22:00 T6 thường xong trước sáng; nếu chậm hơn lần đo, cân nhắc 21:00.
- Incremental LIS mỗi đêm đã là snapshot full CSV — weekly LIS full vẫn nặng và có thể xem xét bỏ sau.
