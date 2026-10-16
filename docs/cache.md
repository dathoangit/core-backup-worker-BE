# Cache (Redis)

`RedisCacheService` backs **auth session** and **auth user** cache. Versioned-cache helpers are ready for future read-heavy features.

Related: [auth.md](./auth.md).

---

## Where logic lives

| Concern                                     | File                                          |
| ------------------------------------------- | --------------------------------------------- |
| Redis client + get/set/delete/versioned API | `src/modules/cache/redis-cache.service.ts`    |
| Module export                               | `src/modules/cache/cache.module.ts`           |
| Auth key prefixes & TTLs                    | `src/modules/auth/auth-redis.constants.ts`    |
| Write session on login                      | `src/modules/auth/auth.service.ts`            |
| Read session + user cache on request        | `src/modules/auth/strategies/jwt.strategy.ts` |
| Invalidate user cache on admin mutate       | `src/modules/user/user.service.ts`            |

**Change session TTL/keys →** `auth-redis.constants.ts` + login/strategy.
**Add feature cache →** inject `RedisCacheService`, use `getOrSetVersioned` / `incrementVersion`.

---

## Enable Redis

```env
REDIS_CACHE_ENABLED=true
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
```

| Flag    | Behavior                                    |
| ------- | ------------------------------------------- |
| `false` | Service no-ops → **login 503**, **JWT 401** |
| `true`  | Auth session + user cache active            |

Local: `docker run -p 6379:6379 redis:7-alpine`.

---

## Auth cache keys

| Key                          | Value       | TTL                   | Written                 | Read              |
| ---------------------------- | ----------- | --------------------- | ----------------------- | ----------------- |
| `auth:user-session:{userId}` | `sessionId` | `JWT_EXPIRATION_TIME` | `AuthService` login/SSO | `JwtStrategy`     |
| `auth:user:{userId}`         | JSON user   | 30s                   | `JwtStrategy` miss      | `JwtStrategy` hit |

Invalidation:

| Event                            | Effect                                |
| -------------------------------- | ------------------------------------- |
| New login                        | Overwrites session key → old JWTs die |
| Password reset                   | `DELETE` session key                  |
| User password/role/email changes | `DELETE auth:user:{userId}`           |

---

## RedisCacheService API (extension)

| Method                    | Use                         |
| ------------------------- | --------------------------- |
| `getString` / `setString` | Sessions                    |
| `getJson` / `setJson`     | User cache                  |
| `delete`                  | Invalidation                |
| `getOrSetVersioned`       | Versioned list/report cache |
| `incrementVersion`        | Bust a cache namespace      |
| `buildStableHash`         | Stable query hash for keys  |

```typescript
await this.redisCacheService.getOrSetVersioned({
  versionKey: 'my-feature:version',
  keyPrefix: 'my-feature:list',
  identity: { page, filters },
  ttlSeconds: 60,
  logContext: 'my-feature list',
  loader: () => this.repository.find(...),
});
await this.redisCacheService.incrementVersion('my-feature:version', 'my-feature invalidate');
```

No base feature currently calls `getOrSetVersioned` — infrastructure only.
