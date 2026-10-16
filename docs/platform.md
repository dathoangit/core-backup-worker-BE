# Platform (bootstrap & cross-cutting)

App shell: Nest bootstrap, config, DB, throttling, i18n, filters, interceptors, health, Swagger.

---

## Where logic lives

| Concern | File |
|---------|------|
| HTTP server start, CORS, ValidationPipe, static uploads, root `GET /` | `src/main.ts` |
| Root module imports | `src/app.module.ts` |
| Swagger `/documentation` | `src/setup-swagger.ts` |
| Health | `src/modules/health-checker/health-checker.controller.ts` |
| Health indicator | `src/modules/health-checker/health-indicators/service.indicator.ts` |
| Bad request filter | `src/filters/bad-request.filter.ts` |
| Query failed filter | `src/filters/query-failed.filter.ts` |
| Response envelope | `src/interceptors/responseInterceptor.service.ts` |
| Language interceptor | `src/interceptors/language-interceptor.service.ts` |
| Base entity / DTOs | `src/common/abstract.entity.ts`, `src/common/dto/*` |
| Migrations | `src/database/migrations/*.ts` |
| i18n strings | `src/i18n/en/` |

**Change global validation →** `src/main.ts` `ValidationPipe`.  
**Wire a new feature module →** create under `src/modules/<name>/`, import in `app.module.ts`.  
**Add migration →** TypeORM migration under `src/database/migrations/`, run `yarn migration:run`.

---

## AppModule stack

Imported in `app.module.ts` (high level):

- `ConfigModule`, TypeORM, Throttler, i18n
- `AuthModule`, `UserModule`, `HealthCheckerModule`
- Global filters / interceptors / guards as registered in module or bootstrap

`CacheModule` is imported by auth/user modules (not always at root).

---

## Endpoints (platform)

| Method | Path | Source |
|--------|------|--------|
| `GET` | `/` | `main.ts` |
| `GET` | `/health` | `health-checker.controller.ts` |
| `GET` | `/documentation` | `setup-swagger.ts` (when `ENABLE_DOCUMENTATION` / env allows) |

---

## Commands

```bash
yarn dev
yarn build:prod
yarn start:prod
yarn migration:run
yarn migration:revert
yarn test
```

Env template: `.env.example`.
