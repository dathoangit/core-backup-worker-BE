# HIS Source Database

Survey of the production HIS databases that this service backs up.
Collected / updated on 2026-10-05 via read-only queries.

## Hosts (from vendor sheet)

Policy for this project: **always connect to secondary (máy chủ phụ)**.

| System | Primary (not used) | Secondary (used) | Port | Account |
| --- | --- | --- | --- | --- |
| HIS + EMR | `172.16.16.22` | **`172.16.16.23`** | 5432 | `his_stpaul` / `emr_stpaul` |
| BADL | `172.16.16.82` | **`172.16.16.83`** | 5432 | `badl_stpaul` |

From the current developer network (`192.168.110.242`):

- `172.16.16.23` is reachable and usable for all HIS/EMR databases including
  `research_management`.
- `172.16.16.22` rejects connections with `no pg_hba.conf entry` for our client IP
  (another reason to stay on secondary).
- `172.16.16.83` (and `.82`) refuse TCP (`ECONNREFUSED`) — BADL is a separate
  PostgreSQL instance and is not reachable yet (VPN / firewall / not listening).

Env groups: `HIS_*`, `EMR_*`, `BADL_*` (all secondary hosts). Do not reuse the
`PG*` prefix for app TypeORM — the `pg` driver auto-reads
`PGHOST`/`PGUSER`/`PGPASSWORD`.

Password tip: the vendor sheet font makes lowercase `l` look like `|`. Verified
working passwords use a **capital `I`** at the end of the EMR password
(`…pbI`), not a pipe or lowercase L. HIS password uses lowercase `l`
(`…AlQs`).

## Server landscape (HIS/EMR instance at `.23`)

The HIS is not one database. The PostgreSQL instance at `172.16.16.23:5432` hosts
11 databases belonging to an ADempiere core plus a set of Java/Spring microservices
(identifiable by their Hibernate Envers `*_aud` + `revinfo` tables and
`flyway_schema_history`).

| Database | Size | Tables | `his_stpaul` SELECT | `emr_stpaul` SELECT | Role |
| --- | --- | --- | --- | --- | --- |
| `produce` | 1494 GB | 1210 | **1210/1210** | 0 | ADempiere HIS core |
| `signer` | 82 GB | 24 | 0 | **22/24** | Digital signature history |
| `file_service` | 34 GB | 11 | 0 | **11/11** | Document/file registry |
| `html_editor` | 30 GB | 472 | 0 (connect only) | **326/472** | Electronic medical record forms |
| `produce_old` | 21 GB | 1076 | 0 | — | Old ADempiere snapshot |
| `produce_bak` | 20 GB | 1075 | 0 | — | Old ADempiere snapshot |
| `phat_thuoc` | 2.3 GB | 17 | 0 (connect only) | **17/17** | Drug dispensing |
| `isofh_pay` | 1.2 GB | 14 | 0 | 0 | Payment transactions |
| `medical_incident` | 86 MB | 102 | 0 | **102/102** | Medical incident reporting |
| `research_management` | 12 MB | 31 | 0 | **31/31** | Research topic management |
| `vital_signs` | 9 MB | 8 | 0 | **8/8** | Vital signs |

Total across the HIS/EMR instance: **~1685 GB**. BADL (`his` on `.82`/`.83`) is
additional and not sized yet.

Vendor sheet mapping (which account is intended for which DB; we connect via secondary):

| Account | Secondary host | Databases |
| --- | --- | --- |
| `his_stpaul` | `.23` | `produce`, `html_editor`, `phat_thuoc` |
| `emr_stpaul` | `.23` | `signer`, `file_service`, `vital_signs`, `research_management` |
| `badl_stpaul` | `.83` | `his` |

Measured reality is broader for `emr_stpaul` on `.23` (also reads `html_editor`,
`phat_thuoc`, `medical_incident`) and narrower for `his_stpaul` (only `produce`
has schema `USAGE`; sheet DBs `html_editor` / `phat_thuoc` connect but deny
schema access).

### Access status (2026-10-05)

| Account | Login on `.23` | What it can actually read |
| --- | --- | --- |
| `his_stpaul` | yes | Full `produce` / schema `adempiere` (1210 tables) |
| `emr_stpaul` | yes | `signer` (missing `nguoi_than`, `nguoi_than_aud`), `file_service`, `vital_signs`, `research_management`, `medical_incident`, `phat_thuoc`, most of `html_editor` (326/472; 146 tables denied) |
| `badl_stpaul` | n/a | Hosts `.82`/`.83` unreachable; role does not exist on the HIS/EMR instance |

Still unreadable with current accounts:

- `isofh_pay` (schema `pay`)
- `produce_old` / `produce_bak`
- 146 tables inside `html_editor`
- 2 tables inside `signer` (`nguoi_than`, `nguoi_than_aud`)
- Entire BADL instance

Each database has its own owner role, which is the grantor to ask for remaining gaps:

| Database | Schema | Owner role |
| --- | --- | --- |
| `produce`, `produce_old`, `produce_bak` | `adempiere` | `adempiere` |
| `html_editor` | `html_editor` | `html_editor` |
| `signer` | `signer` | `signer` |
| `file_service` | `file` | `file` |
| `isofh_pay` | `pay` | `isofh_pay` |
| `phat_thuoc` | `phat_thuoc` | `phat_thuoc` |
| `medical_incident` | `medical_incident` | `medical_incident` |
| `research_management` | `research` | `research` |
| `vital_signs` | `vital_signs` | `vital_signs` |

Grant pattern for remaining gaps:

```sql
GRANT USAGE ON SCHEMA <schema> TO <account>;
GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO <account>;
ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT SELECT ON TABLES TO <account>;
```

### Roles that already exist on the HIS/EMR server

Observed login roles of interest: `his_stpaul`, `emr_stpaul`, `emr_readonly`,
`da_read_user`, `srv_da_xp`, `onlyread`, `logical_rep`, `replication`, `sp_cdc`.
`badl_stpaul` is **not** present on this instance (expected — it belongs on BADL).

There are **no replication slots and no publications** on the server
(`pg_replication_slots` and `pg_publication` are both empty), so despite
`wal_level = logical` nothing is consuming logical decoding today.

Live workload for context: 263 JDBC connections from `adempiere` plus 60 each from
the microservice roles.

### The microservices have their own change feed

The system catalogs are readable even where the data is not, so the column layout of
the microservice databases could be confirmed without `SELECT` access. They all use
stock Hibernate Envers auditing:

```
revinfo(rev integer, revtstmp bigint, api, ip, user_id, server, uri, version, client)
<table>_aud(id bigint, rev integer, revtype smallint, active boolean, deleted bigint, ...)
```

`rev` is a monotonically increasing revision id and `revtype` encodes the operation
(0 add, 1 modify, 2 delete). This is structurally the same thing `ad_changelog`
provides for ADempiere, which means one change-feed abstraction covers both
families:

- ADempiere profile (`produce`, `produce_old`, `produce_bak`): feed is `ad_changelog`,
  watermark `ad_changelog_id`, event column `eventchangelog`.
- Envers profile (`html_editor`, `signer`, `file_service`, `phat_thuoc`,
  `medical_incident`, `research_management`, `vital_signs`): feed is
  `<table>_aud` joined to `revinfo` on `rev`, watermark `rev`, event column `revtype`.
- Generic profile (`isofh_pay` and anything else): watermark on `updated_at`, or
  full reload when the table is small.

The `_aud` and `revinfo` tables are themselves append-only, and they are the bulk of
those databases (in `signer`, `lich_su_ky_aud` at 23 GB plus `revinfo` at 12 GB out
of 82 GB total), so they fall into the cheap append-only tier.

Base tables also carry `created_at`, `updated_at`, `active` and `deleted`, meaning
these services use soft deletes rather than physical ones.

### Binary content is not stored in PostgreSQL

`file_service` holds 25.5 M rows in `nb_ho_so` but its TOAST storage across the
whole database is **80 kB**. At roughly 450 bytes per row it stores file metadata
and paths, not file bytes. `signer` shows the same pattern: 160 M rows, 176 kB of
TOAST.

`file_service.nb_ho_so` even has a `duong_dan varchar(255)` column, which is simply
the file path. `signer.lich_su_ky_aud` stores `file_truoc_ky` and `file_sau_ky` the
same way.

The actual artifacts (diagnostic images, scanned records, signed PDFs) live outside
PostgreSQL on a file server, NAS, or object store. A database-only backup does not
capture them. This has been accepted as out of scope for this project.

### `produce` itself is complete

`produce` is not a truncated extract. Patient visits in `his_patienthistory` run
continuously from go-live with no gaps:

| Year | Visits |
| --- | --- |
| 2020 (from October) | 150,247 |
| 2021 | 439,019 |
| 2022 | 599,540 |
| 2023 | 588,721 |
| 2024 | 585,778 |
| 2025 | 595,204 |
| 2026 (to October) | 525,983 |

Roughly 590 K visits per year since 2021. What is partial is the *system* scope,
not the time range of `produce`.

## Connection

| Item | Value |
| --- | --- |
| HIS/EMR host (used) | `172.16.16.23:5432` (secondary — project policy) |
| BADL host (used) | `172.16.16.83:5432` (secondary — not reachable yet) |
| HIS account | `his_stpaul` → full read on `produce` |
| EMR account | `emr_stpaul` → microservices on `.23` (incl. `research_management`) |
| BADL account | `badl_stpaul` → database `his` (unverified) |
| Server version (HIS/EMR) | PostgreSQL **11.12** (x86_64, RHEL/CentOS 7) |
| `max_connections` | 2000 |
| `shared_buffers` | 25 GB |
| `wal_level` | `logical` |
| `archive_mode` | `on` |
| `max_wal_senders` | 10 |
| `log_min_duration_statement` | 5000 ms |

### Privileges of `his_stpaul` on `produce`

- `rolsuper = false`, `rolreplication = false`
- `USAGE` on schema `adempiere`: yes
- `CREATE` on schema `adempiere`: **no** (cannot add indexes, triggers, publications)
- `SELECT` on all 1210 tables: yes (1210/1210)

Practical consequence: the backup service can only **read**. Any strategy that needs
a replication slot, a publication, or a new index on the source requires the HIS DBA.

## Product

The HIS runs on **ADempiere / iDempiere ERP** (schema `adempiere`), with a large
Vietnamese healthcare module layered on top (`his_*` tables) plus insurance-claim
XML export tables (`his_130_xml*` for QĐ 130, `his_79a_xml*` for QĐ 79A).

Multi-tenant model is ADempiere standard but effectively single-tenant in practice:

- `ad_client`: `0` System, `11` GardenWorld (demo seed), `1000000` **IsofH** (real data)
- `ad_org`: 11 organizations

## Size and shape

| Metric | Value |
| --- | --- |
| Total database size | **1494 GB** |
| Tables | 1210 (771 non-empty, 439 empty) |
| Views | 633 |
| Postgres sequences | 0 (IDs come from the `ad_sequence` table, not `SERIAL`) |
| Foreign keys | 4149 |
| Tables with a primary key | 1200 / 1210 |
| Tables with a composite primary key | 182 |
| Tables with `created` column | 1363 |
| Tables with `updated` column | 1343 |
| Tables with a `<table>_uu` UUID column | 1214 |
| `his_*` tables | 337 |
| Core ADempiere tables (`ad_`/`c_`/`m_`) | 538 |
| Earliest business record (`his_patienthistory.created`) | 2020-10-03 |
| Earliest `ad_changelog` row | 2020-06-01 |

### Size is dominated by audit/log tables

| Table | Total size | Est. rows | Nature |
| --- | --- | --- | --- |
| `ad_changelog` | **1042 GB** | 2.65 B | ADempiere field-level audit trail |
| `ad_issue` | 104 GB | 113 M | Application error/exception log |
| `ad_session` | 12 GB | 19.9 M | Login session log |
| `ad_pinstance_para` | 9.3 GB | 35.3 M | Report/process run parameters |
| `ad_pinstance` | 4.3 GB | 10.8 M | Report/process run log |

**Business data excluding these log tables is only ~321 GB.** `ad_changelog` alone is
70% of the database. This single fact drives the whole backup design: a naive
full-database copy moves 1.5 TB, a business-data copy moves 321 GB, and an
incremental copy moves a few GB per day.

### Largest business tables

| Table | Total size | Heap | Est. rows |
| --- | --- | --- | --- |
| `his_service_product` | 65 GB | 26 GB | 42.9 M |
| `his_130_xml3` | 24 GB | 13 GB | 30.7 M |
| `his_patienthistory` | 20 GB | 10 GB | 3.5 M |
| `his_storage_document` | 19 GB | 7.8 GB | 20.5 M |
| `his_service_medicaltest` | 19 GB | 8.2 GB | 11.8 M |
| `his_130_xml4` | 18 GB | 9.3 GB | 37.7 M |
| `his_service_diagnosticimage` | 18 GB | 8.0 GB | 9.3 M |
| `his_service_detail` | 15 GB | 8.4 GB | 32.2 M |
| `his_79a_xml4` | 13 GB | 8.5 GB | 30.3 M |
| `his_79a_xml3` | 13 GB | 8.7 GB | 22.1 M |
| `his_sign_history` | 9.6 GB | 8.4 GB | 22.4 M |
| `his_79a_xml2` | 9.2 GB | 6.7 GB | 16.8 M |
| `his_invoice` | 6.8 GB | 2.6 GB | 6.4 M |
| `his_checkup` | 5.2 GB | 4.2 GB | 3.8 M |
| `his_service_group` | 4.9 GB | 3.1 GB | 11.0 M |
| `ad_attachment` | 4.8 GB | 95 MB | 77 K (binary, mostly TOAST) |

## Standard column convention

Every ADempiere table follows the same layout, e.g. `his_patienthistory`:

```
his_patienthistory_id   numeric   -- single-column surrogate PK
ad_client_id            numeric   -- tenant
ad_org_id               numeric   -- organization
isactive                character  -- 'Y'/'N' soft-delete flag
created                 timestamp
createdby               numeric
updated                 timestamp
updatedby               numeric
his_patienthistory_uu   uuid-ish  -- stable natural key, unique index
...business columns...
```

Two properties matter for backup:

1. `<table>_id` and `<table>_uu` give a stable, unique key on almost every table.
2. `created` / `updated` exist almost everywhere, so a timestamp watermark is
   theoretically possible.

### The catch: `updated` is not indexed

Across the entire schema there is exactly **one** index leading with `updated`
(`c_bplocation_updated` on `c_bpartner_location`). Every other table would need a
sequential scan to answer `WHERE updated >= :watermark`.

Measured: `SELECT count(*) FROM his_patienthistory WHERE updated >= now() - interval '1 day'`
scanned 3.5 M rows / 10 GB and returned 5675 rows in roughly 15 seconds. Extrapolated
across 321 GB of business data this is a multi-hour full scan per run, twice a day,
on a live hospital production database. And `his_stpaul` cannot create the missing
indexes.

Some tables do have a `created` index (for example `hph_created` on
`his_patienthistory`), so insert-only incremental reads are cheap on those, but
updates are not detectable that way.

## `ad_changelog` as a built-in change feed

`ad_changelog` is ADempiere's field-level audit table and it is effectively a
ready-made CDC stream.

Structure and indexes:

```
PK     (ad_changelog_id, ad_session_id, ad_table_id, ad_column_id)
UNIQUE ad_changelog_uu
INDEX  ad_changelog_speed (ad_table_id, record_id)
```

Columns of interest: `ad_changelog_id`, `ad_table_id`, `record_id`, `ad_column_id`,
`eventchangelog` (`I`/`U`/`D`), `oldvalue`, `newvalue`, `created`, `createdby`,
`ad_session_id`.

Key properties measured:

- **955 of 1307** entries in `ad_table` have `ischangelog = 'Y'`. All of the large
  business tables checked are enabled: `HIS_PatientHistory`, `HIS_Service_Product`,
  `HIS_Service_Detail`, `HIS_Service_MedicalTest`, `HIS_Service_DiagnosticImage`,
  `HIS_Storage_Document`, `HIS_Invoice`, `HIS_CheckUp`, `HIS_Patient`,
  `HIS_Prescription`, `HIS_130_XML3`, `HIS_79A_XML3`.
- **Deletes are captured**: in a recent 500 K id window the event mix was
  1,025,760 `U` / 154,292 `I` / 46,744 `D`.
- `ad_changelog_id` is monotonically increasing and is the leading PK column, so
  `WHERE ad_changelog_id > :watermark ORDER BY ad_changelog_id` is an index range
  scan, not a sequential scan.
- One `ad_changelog_id` produces **one row per changed column**, so the id is a
  per-record-change identifier, not a per-row identifier.

Volume measured over a ~2.2 day window (1.5 M id range):

| Metric | Value |
| --- | --- |
| Raw changelog rows | 3,765,124 |
| Distinct `(ad_table_id, record_id)` touched | 662,334 |
| Approximate distinct records changed per day | **~300 K** |

Top tables by change volume in that window:

| Table | Changelog rows | Distinct records |
| --- | --- | --- |
| `HIS_Invoice` | 821,386 | 13,726 |
| `HIS_Invoice_Total` | 807,999 | 9,829 |
| `HIS_Service_Detail` | 355,205 | 160,626 |
| `HIS_Service_MedicalTest` | 280,046 | 40,928 |
| `HIS_PatientHistory` | 213,489 | 10,700 |
| `HIS_Storage_Document` | 192,506 | 24,963 |
| `HIS_Service_Product` | 164,819 | 62,392 |
| `HIS_130_XML1` | 151,774 | 10,229 |
| `HIS_CheckUp` | 138,905 | 7,510 |
| `HIS_130_XML4` | 101,296 | 81,647 |

Pulling ~300 K changed records per day by primary key is a trivial workload compared
to scanning 321 GB. The limitation is that `ad_changelog` only records changes made
through the ADempiere application layer; direct SQL, bulk loads, or batch jobs that
bypass `PO.java` will not appear, and tables with `ischangelog = 'N'` are invisible.

## Binary columns

23 `bytea` columns exist. Only a few carry real volume:

- `ad_attachment.binarydata` (4.8 GB total relation size, almost all TOAST)
- `ad_archive.binarydata`, `ad_image.binarydata`
- `his_service_medicaltest.htmlresult`, `his_service_diagnosticimage.htmlresult`
- `his_resulttemplate.htmlresult`, `his_resulttemplate_list.htmlresult`
- `nb_ket_qua_cdha_his.ket_qua`, `nb_ket_qua_xn_his.ket_qua`

These need an explicit encoding decision if the backup target is a text/columnar
format rather than another PostgreSQL instance.

## Data type distribution

| Type | Column count |
| --- | --- |
| `numeric` | 24,113 |
| `character varying` | 14,786 |
| `character` (mostly `char(1)` Y/N flags) | 8,167 |
| `timestamp without time zone` | 5,762 |
| `text` | 1,300 |
| `boolean` | 371 |
| `integer` | 350 |
| `bigint` | 68 |
| `date` | 63 |
| `timestamp with time zone` | 25 |
| `bytea` | 23 |

Note that IDs are `numeric`, not `integer`. Any target schema or ORM mapping must
not silently truncate these to JavaScript numbers.

## Storage breakdown

| Component | Size |
| --- | --- |
| Heap (actual row data) | 897 GB |
| Indexes (2888 of them) | 584 GB |
| TOAST (oversized values) | 12 GB |

Indexes are 39% of the database. A mirror that only needs to store and serve data
does not have to reproduce all 2888 source indexes, which saves hundreds of GB and a
large share of the load time.

## Changelog coverage versus table size

| `ad_table.ischangelog` | Tables | Total size |
| --- | --- | --- |
| `Y` (CDC available) | 939 | 311 GB |
| `N` (no CDC) | 244 | 1173 GB |
| Table not registered in `ad_table` | 27 | 9.8 GB |

The 1173 GB without CDC looks alarming until you list the tables involved. Every
non-CDC table above 100 MB is an append-only log:

| Table | Size | `ischangelog` |
| --- | --- | --- |
| `ad_changelog` | 1042 GB | N |
| `ad_issue` | 104 GB | N |
| `ad_session` | 12 GB | N |
| `his_sign_history` | 9.6 GB | not in `ad_table` |
| `ad_pinstance_para` | 9.3 GB | N |
| `ad_pinstance` | 4.3 GB | N |
| `ad_recentitem` | 463 MB | N |
| `his_sms` | 105 MB | not in `ad_table` |

Everything else without CDC totals well under 1 GB across roughly a thousand tables.

### Append-only verification

Sampling the 20,000 newest rows of each log table and counting rows where
`updated > created`:

| Table | Rows modified after insert | Sampled | Conclusion |
| --- | --- | --- | --- |
| `ad_changelog` | 0 | 20,000 | Strictly append-only |
| `ad_issue` | 15 | 20,000 | Effectively append-only |
| `ad_session` | 10,391 | 20,000 | Updated, but only shortly after insert |
| `ad_pinstance` | 15,844 | 20,000 | Updated, but only shortly after insert |

`ad_changelog` being strictly append-only is the single most useful fact in this
document: the 1042 GB table that dominates the database can be replicated with a
simple monotonic `ad_changelog_id` watermark and an index range scan, with no
need to ever re-read old data.

`ad_session` and `ad_pinstance` are mutated, but the mutations land within minutes
of insert, so re-reading a trailing window of recent IDs on each run covers them.

## Measured read throughput

Single connection from a developer machine on the same network, using the `pg`
Node driver (plain `SELECT`, not `COPY`, so this is a conservative lower bound):

| Workload | Rows | Throughput |
| --- | --- | --- |
| `ad_changelog` id range, 284 K rows | 284,034 | ~304 K rows/s, ~172 MB/s |
| `ad_changelog` id range, 90 K rows | 89,662 | ~264 K rows/s, ~150 MB/s |
| `his_service_product` (wide rows), 100 K rows | 100,000 | ~30 K rows/s |

Narrow log rows stream very fast; wide business rows are roughly ten times slower
per row. At these rates a single-threaded full read of `ad_changelog` is on the
order of 2.5 hours, so a parallel, chunked initial load of the whole 1.5 TB is a
matter of hours rather than days.

## Other objects to reproduce

| Object | Count |
| --- | --- |
| Functions in `adempiere` | 456 |
| Composite types | 72,273 (mostly implicit row types of tables/views) |
| User triggers | 34 |
| Extensions | `plpgsql`, `adminpack`, `unaccent`, `uuid-ossp`, `pg_trgm`, `pgcrypto`, `pg_stat_statements` |

`pg_trgm` is actually used by indexes on `his_patienthistory`, so the mirror needs
that extension if those indexes are reproduced.

## Implications for the backup design

1. The database splits cleanly into three replication tiers rather than one:
   append-only logs (1173 GB, monotonic PK watermark), CDC-covered business tables
   (311 GB, driven by `ad_changelog`), and a long tail of small tables (under 1 GB
   total) that can simply be reloaded in full every run.
2. A timestamp-watermark incremental read is correct but prohibitively slow because
   `updated` is unindexed and the account cannot create indexes.
3. `ad_changelog` serves double duty: it is both the largest table to copy and the
   change feed that makes copying everything else cheap.
4. Logical replication is technically available on the server (`wal_level = logical`,
   `max_wal_senders = 10`) but blocked by the account having no `REPLICATION` role.
   It remains the best option if the HIS DBA ever grants it.
5. `ad_changelog` only records changes made through the ADempiere application layer.
   Direct SQL, bulk loads, or batch jobs bypassing `PO.java` are invisible to it, so
   the design needs a periodic reconciliation pass to catch drift.
