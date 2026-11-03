# Phạm vi truy cập dữ liệu & dung lượng nguồn

Đo **live** ngày **2026-11-03** (đọc-only) từ tài khoản cấu hình trong `.env.settings`:

| Nhóm | Host | Account |
| --- | --- | --- |
| HIS / EMR | `172.16.16.23:5432` (Postgres) | `his_stpaul` / `emr_stpaul` |
| LIS | `192.168.105.2:1433` (SQL Server) | `thongke` |

Dung lượng = **size database nguồn** (`pg_database_size` / `sys.database_files`), không phải dung lượng artifact trên đĩa backup worker.

**Tăng trưởng / ngày** ước từ:

- HIS/EMR: chênh size survey **2026-10-05 → 2026-11-03** (~29 ngày)
- `ad_changelog`: probe theo `ad_changelog_id` (~0,9–1,1 GB/ngày, nằm trong tăng trưởng `produce`)
- LIS DB: trung bình đời sống `LabconnXP` (~110 MB/ngày)
- LIS PDF: số file mới `tbl_SignaturePDF` (~3.800–4.000 file/ngày; **GB file chưa đo**)

---

## 1. Tổng quan theo nhóm

| Nhóm | Loại nguồn | Account / path | Lấy được (tóm tắt) | Không lấy được (tóm tắt) | Dung lượng nguồn (live) | Tăng trưởng dự tính / ngày |
| --- | --- | --- | --- | --- | --- | --- |
| **HIS core** | PostgreSQL — `produce` | `his_stpaul` | **1210/1210 bảng** `adempiere` (NB, KCB, chỉ định, thuốc trong HIS, viện phí, BHYT XML, audit…) | Không ghi / không tạo index / không replication trên nguồn | **1534 GB** | **~1,4 GB/ngày** (chủ yếu `ad_changelog` ~1 GB) |
| **EMR / microservices** | PostgreSQL — nhiều DB cùng host | `emr_stpaul` | Hầu hết bảng EMR (xem §2); một số bảng deny | `isofh_pay`; `produce_old`/`produce_bak`; 146 bảng `html_editor`; 2 bảng `signer` | **~152 GB** (chưa gồm `produce`) | **~120 MB/ngày** |
| **LIS — DB** | SQL Server — 4 DB | `thongke` | Toàn bộ bảng lab (snapshot CSV), gồm metadata PDF (`FileName`, cờ `ExportPDF`…) | — (trong phạm vi DB) | **~188 GB** (`LabconnXP` **188 GB**) | **~110 MB/ngày** |
| **LIS — PDF kết quả** | File share (nguồn **riêng**, không nằm trong 188 GB) | `\\192.168.105.2\pdf\…` · `D:\PDFISOFH\` | Chưa (worker không backup kho file) | Toàn bộ file PDF đã ký / PDF kết quả | **Chưa đo** | **~3.800–4.000 file/ngày** (GB chưa đo) |
| **PACS** | DB + ảnh DICOM | `PACS_*` | Chưa (profile `unconfigured`) | DB PACS + toàn bộ object ảnh | Chưa đo | Chưa ước |

Tổng DB đo được trên host HIS/EMR (11 DB): **~1749 GB**.  
Trong `produce`: nghiệp vụ (trừ vài bảng log lớn) ~**330 GB**; riêng `ad_changelog` ~**1069 GB**.  
Lượt khám gần đây (`his_patienthistory`): ~**3.200/ngày**.

---

## 2. Chi tiết từng database — HIS/EMR (Postgres)

| Database | Loại | Vai trò | Dung lượng live | ~Tăng/ngày | Bảng | SELECT được? | Không lấy được trong DB này |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `produce` | PostgreSQL (ADempiere) | Lõi HIS | **1534 GB** | **~1,4 GB** | 1210 | **`his_stpaul` 1210/1210** · `emr_stpaul` 0 | DDL/ghi trên nguồn |
| `signer` | PostgreSQL (Envers) | Ký số điện tử | **83 GB** | ~28 MB | 24 | **`emr_stpaul` 22/24** · `his_stpaul` 0 | `nguoi_than`, `nguoi_than_aud`; file PDF ký (path) |
| `file_service` | PostgreSQL (Envers) | Danh mục hồ sơ / path file | **35 GB** | ~42 MB | 11 | **`emr_stpaul` 11/11** · `his_stpaul` 0 | Nội dung file thật (ngoài DB) |
| `html_editor` | PostgreSQL (Envers) | Bệnh án điện tử / biểu mẫu | **32 GB** | ~54 MB | 472 | **`emr_stpaul` 326/472** · `his_stpaul` 0 | **146 bảng** bị deny |
| `produce_old` | PostgreSQL | Snapshot HIS cũ | **21 GB** | ~0 (ổn định) | 1076 | **Không** | Toàn bộ DB |
| `produce_bak` | PostgreSQL | Snapshot HIS cũ | **20 GB** | ~0 | 1075 | **Không** | Toàn bộ DB |
| `phat_thuoc` | PostgreSQL (Envers) | Phát thuốc (microservice) | **~2,2 GB** | ~0 | 17 | **`emr_stpaul` 17/17** · `his_stpaul` 0 | — |
| `isofh_pay` | PostgreSQL | Thanh toán | **~1,2 GB** | ~0 | 14 | **Không** | Toàn bộ schema `pay` |
| `medical_incident` | PostgreSQL (Envers) | Sự cố y khoa | **86 MB** | ~0 | 102 | **`emr_stpaul` 102/102** | — |
| `research_management` | PostgreSQL (Envers) | Đề tài nghiên cứu | **12 MB** | ~0 | 31 | **`emr_stpaul` 31/31** | — |
| `vital_signs` | PostgreSQL (Envers) | Sinh hiệu | **~9 MB** | ~0 | 8 | **`emr_stpaul` 8/8** | — |

### Giấy NCC vs thực tế (`his_stpaul`)

| Theo giấy | Thực tế live |
| --- | --- |
| `produce`, `html_editor`, `phat_thuoc` | Chỉ **`produce` full SELECT**; các DB khác connect được nhưng **0 bảng SELECT** |

`emr_stpaul` thực tế cover EMR như bảng trên (rộng hơn giấy gốc).

---

## 3. Trong `produce` — không chỉ thông tin NB

| Hạng mục | Có quyền? | Ghi chú live |
| --- | --- | --- |
| NB / lượt khám (`his_patienthistory`, …) | **Có** | ~20 GB; ~3.200 lượt/ngày |
| Chỉ định / XN / CĐHA (`his_service_*`) | **Có** | Nhiều bảng lớn |
| Thuốc / SP gắn dịch vụ (`his_service_product`, …) | **Có** | ~67 GB — khác DB `phat_thuoc` |
| Viện phí / XML BHYT | **Có** | |
| Lõi ADempiere + audit | **Có** | `ad_changelog` ~1069 GB (~1 GB/ngày); `ad_issue` ~106 GB |

→ Trong `produce` lấy được **cả lõi nghiệp vụ KCB**, không chỉ thông tin NB.

Top quan hệ lớn nhất (live):

| Relation | Size |
| --- | --- |
| `adempiere.ad_changelog` | 1069 GB |
| `adempiere.ad_issue` | 106 GB |
| `adempiere.his_service_product` | 67 GB |
| `adempiere.his_130_xml3` | 25 GB |
| `adempiere.his_patienthistory` | 20 GB |

---

## 4. LIS — tách DB và PDF (hai nguồn)

**188 GB chỉ là SQL Server.** PDF kết quả là kho file riêng, không nằm trong con số đó.

### 4.1 LIS — Database (SQL Server)

| Database | Loại | Vai trò | Dung lượng live | ~Tăng/ngày | Bảng | Lấy được? |
| --- | --- | --- | --- | --- | --- | --- |
| `LabconnXP` | SQL Server | Lab chính — kết quả XN (số liệu + metadata PDF) | **188 GB** | **~110 MB** (TB cả cụm LIS DB) | 589 | **Có** (`thongke`) |
| `LabInventory_XP` | SQL Server | Kho lab | **53.6 MB** | nhỏ | 99 | **Có** |
| `BloodStorage_XanhPon` | SQL Server | Ngân hàng máu | **102 MB** | nhỏ | 40 | **Có** |
| `Labconnect_Card` | SQL Server | Thẻ / kết nối | **20.6 MB** | nhỏ | 83 | **Có** |

Kết quả xét nghiệm **có lưu trong DB** (bảng `tbl_Result*`, …). Top bảng lớn `LabconnXP`:

| Table | ~Size |
| --- | --- |
| `dbo.tbl_Result_Attribute_2025` | 24.7 GB |
| `dbo.tbl_Result_His` | 22.5 GB |
| `dbo.tbl_Result` | 15.8 GB |
| `dbo.tbl_result_out_his_his` | 13.7 GB |
| `dbo.tbl_SignaturePDF` | 5.8 GB (metadata, không phải file PDF) |

### 4.2 LIS — PDF kết quả (nguồn file riêng)

| Hạng mục | Giá trị |
| --- | --- |
| Loại nguồn | File share / ổ đĩa lab — **không tính vào 188 GB DB** |
| Path cấu hình (`tbl_0Config.AttachPath`) | `D:\PDFISOFH\` |
| Path thực tế (mẫu `FileName`) | `\\192.168.105.2\pdf\BackupPDF\2026\11\3\…_Signed.pdf` |
| Metadata trong DB | `tbl_SignaturePDF` ~1,52 M dòng; cờ `ExportPDF` / `SendPDF` |
| Tăng trưởng | **~3.900 file/ngày** (1 ngày gần nhất); TB 7 ngày ~**3.850 file/ngày** |
| Dung lượng PDF | **Chưa đo** (cần đo riêng trên share) |
| Worker hiện tại | Backup CSV DB — **không** copy kho PDF |

---

## 5. PACS

| Phần | Loại | Lấy được? | Dung lượng | Tăng/ngày | Ghi chú |
| --- | --- | --- | --- | --- | --- |
| PACS metadata DB | (chưa profile) | **Không** | Chưa đo | Chưa ước | `PACS_*` unconfigured |
| Ảnh DICOM | File / PACS store | **Không** | Chưa đo | Chưa ước | Ngoài phạm vi backup DB hiện tại |

---

## 6. Lỗ hổng còn lại

| # | Phần thiếu | Loại | Mức độ |
| --- | --- | --- | --- |
| 1 | `isofh_pay` | PostgreSQL | Toàn DB |
| 2 | `produce_old` / `produce_bak` | PostgreSQL | Toàn DB (ưu tiên thấp) |
| 3 | 146 bảng `html_editor` | PostgreSQL | Một phần EMR |
| 4 | `nguoi_than`, `nguoi_than_aud` (`signer`) | PostgreSQL | 2 bảng |
| 5 | PDF kết quả LIS (`\\192.168.105.2\pdf\…`) | File share | Ngoài DB — worker chưa backup |
| 6 | PACS DB + DICOM | DB + file | Chưa cấu hình |

---

## 7. Ma trận worker đang cover

| Nhóm trong app | Đang backup? | Ghi chú |
| --- | --- | --- |
| HIS `produce` | Có (DB) | `his_stpaul` / `adempiere` |
| EMR (7 DB) | Có (DB, trừ bảng deny) | `emr_stpaul` |
| LIS 4 DB | Có (DB) | Snapshot CSV ~188 GB nguồn |
| LIS PDF kết quả | Không | Nguồn riêng `\\192.168.105.2\pdf\…` |
| PACS | Không | unconfigured |

---

## Nguồn / cách đo

- Postgres: `pg_database_size`, `has_table_privilege`, `pg_total_relation_size`
- SQL Server: `sys.database_files`, `tbl_0Config` / `tbl_SignaturePDF`
- Tăng trưởng: delta size 29 ngày; probe `ad_changelog_id`; count `DateCreatePDF`
- Inventory: [`luong-he-thong.md`](./luong-he-thong.md), [`backup-databases.md`](./backup-databases.md), [`his-database.md`](./his-database.md)
