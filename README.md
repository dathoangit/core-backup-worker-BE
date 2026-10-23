# BE-nestJs — Overview

NestJS base API: JWT auth (RS256 + Redis session), role-based access (`StaffRole`), admin user CRUD, health, TypeORM, Swagger.

**Package manager:** `yarn` only.

---

## Agent index — start here

| I need to… | Open first | Deep dive |
|------------|------------|-----------|
| Understand the whole backend | This file | [`docs/luong-he-thong.md`](./docs/luong-he-thong.md) |
| Auth login / JWT / session / Google / email / reset | [`docs/auth.md`](./docs/auth.md) | `src/modules/auth/` |
| Roles & protecting endpoints | [`docs/roles.md`](./docs/roles.md) | `src/guards/`, `src/decorators/`, `src/constants/staff-role.ts` |
| Admin user CRUD APIs | [`docs/admin-users.md`](./docs/admin-users.md) | `src/modules/user/` |
| Redis cache / session keys | [`docs/cache.md`](./docs/cache.md) | `src/modules/cache/` |
| Bootstrap, pipes, filters, health, Swagger | [`docs/platform.md`](./docs/platform.md) | `src/main.ts`, `src/app.module.ts` |
| HIS/EMR incremental backup | [`docs/backup-runbook.md`](./docs/backup-runbook.md) | `src/modules/backup/` + `src/modules/settings/` |

### Quick path map

```text
src/
  main.ts                 # HTTP bootstrap, ValidationPipe, static /uploads
  app.module.ts           # Root wiring (Config, TypeORM, Throttler, I18n, modules)
  setup-swagger.ts        # /documentation
  modules/
    auth/                 # Auth HTTP + AuthService + Passport strategies
    user/                 # UserEntity + UserService + /admin/users
    backup/               # HIS/EMR incremental backup engine + admin API
    cache/                # RedisCacheService (used by auth/user)
    health-checker/       # GET /health (+ backup freshness)
  guards/                 # AuthGuard, RolesGuard
  decorators/             # @Auth, @AuthUser, @PublicRoute, …
  filters/ interceptors/  # Global error/response shaping
  database/migrations/    # Schema + seed admin
  constants/staff-role.ts # nurse | doctor | admin
```

---

## Runtime flow (short)

1. `src/main.ts` boots Nest + CORS + global `ValidationPipe`.
2. `AppModule` loads config, DB, throttler, i18n, auth/user/health modules.
3. Public routes use `@PublicRoute`; protected routes use `@Auth()` / `@Auth([StaffRole.…])`.
4. Login writes Redis session; JWT carries `sub`, `role`, `sessionId`.
5. `JwtStrategy` checks Redis session + caches user briefly.

---

## Environment & commands

```bash
cp .env.example .env
yarn
yarn migration:run   # when DB is ready
yarn dev             # watch
yarn build:prod && yarn start:prod
```

Key env: `PORT`, `JWT_*`, `DB_*`, `REDIS_CACHE_ENABLED` (+ Redis host/port).  
**Auth sessions require Redis** (`REDIS_CACHE_ENABLED=true`). Details: [`docs/auth.md`](./docs/auth.md), [`docs/cache.md`](./docs/cache.md).

Seed admin (migration): username `admin` / password `0123456789` — rotate in production.

---

## Base endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | Smoke JSON |
| `GET` | `/health` | Health |
| `GET` | `/documentation` | Swagger (if enabled) |
| `*` | `/auth/*` | See [`docs/auth.md`](./docs/auth.md) |
| `*` | `/admin/users` | See [`docs/admin-users.md`](./docs/admin-users.md) |
| `*` | `/admin/settings` | Backup/source settings in DB (see [`docs/backup-runbook.md`](./docs/backup-runbook.md)) |
| `*` | `/admin/backup/*` | See [`docs/backup-runbook.md`](./docs/backup-runbook.md) |

FE counterpart: [`../FE-nextJs/README.md`](../FE-nextJs/README.md).
