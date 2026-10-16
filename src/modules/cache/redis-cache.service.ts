import { createHash, randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface IGetOrSetVersionedOptions<T> {
  versionKey: string;
  keyPrefix: string;
  identity: unknown;
  ttlSeconds: number;
  logContext: string;
  loader: () => Promise<T>;
}

interface IGetOrSetWithLockOptions<T> {
  key: string;
  queryHash: string;
  version: string;
  ttlSeconds: number;
  logContext: string;
  loader: () => Promise<T>;
}

type CacheStatus = 'hit' | 'miss-set' | 'wait-hit' | 'fallback-db';

interface ICacheResult<T> {
  value: T;
  status: CacheStatus;
  dbDurationMs?: number;
}

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);

  private readonly enabled: boolean;

  private readonly lockTtlSeconds = 3;

  private readonly lockRetryDelaysMs = [50, 100, 150];

  private readonly redis: Redis | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      this.configService.get<string>('REDIS_CACHE_ENABLED') === 'true';

    if (!this.enabled) {
      this.logger.log('Redis cache disabled');

      return;
    }

    const host = this.configService.get<string>('REDIS_HOST') ?? 'localhost';
    const port = this.configService.get<number>('REDIS_PORT') ?? 6379;
    const db = this.configService.get<number>('REDIS_DB') ?? 0;
    const password = this.configService.get<string>('REDIS_PASSWORD');

    this.redis = new Redis({
      host,
      port,
      db,
      password: password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      commandTimeout: 1000,
    });

    this.redis.on('error', (error) => {
      this.logger.error(`Redis connection error: ${error.message}`);
    });

    this.logger.log(
      `Redis cache enabled host=${host} port=${port} db=${db} lockTtlSeconds=${this.lockTtlSeconds}`,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.connect();
      this.logger.log('Redis cache connected');
    } catch (error) {
      this.logger.warn(
        `Redis cache connect failed; falling back to DB: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  onModuleDestroy(): void {
    if (!this.redis) {
      return;
    }

    this.redis.disconnect();
  }

  buildStableHash(input: unknown): string {
    const serialized = JSON.stringify(this.stableNormalize(input));

    return createHash('sha1').update(serialized).digest('base64url');
  }

  async getOrSetVersioned<T>(
    options: IGetOrSetVersionedOptions<T>,
  ): Promise<T> {
    const startedAt = Date.now();

    if (!this.redis) {
      this.logger.log(
        `${options.logContext} cache bypass disabled at=${this.nowIso()}`,
      );

      return options.loader();
    }

    let version = '0';

    try {
      version = (await this.redis.get(options.versionKey)) ?? '0';
    } catch (error) {
      this.logger.warn(
        `${
          options.logContext
        } Redis GET version failed; fallback DB: ${this.errorMessage(error)}`,
      );

      return options.loader();
    }

    const queryHash = this.buildStableHash(options.identity);
    const key = `${options.keyPrefix}:v${version}:${queryHash}`;

    const result = await this.getOrSetWithLock({
      key,
      queryHash,
      version,
      ttlSeconds: options.ttlSeconds,
      logContext: options.logContext,
      loader: options.loader,
    });

    this.logger.log(
      `${options.logContext} cache ${
        result.status
      } v=${version} q=${this.shortHash(queryHash)} total=${
        Date.now() - startedAt
      }ms${
        result.dbDurationMs === undefined ? '' : ` db=${result.dbDurationMs}ms`
      }`,
    );

    return result.value;
  }

  async incrementVersion(
    versionKey: string,
    logContext: string,
  ): Promise<void> {
    if (!this.redis) {
      this.logger.debug(`${logContext} cache invalidation skipped disabled`);

      return;
    }

    try {
      const version = await this.redis.incr(versionKey);
      this.logger.log(
        `${logContext} cache version bumped at=${this.nowIso()} version=${version}`,
      );
    } catch (error) {
      this.logger.warn(
        `${logContext} Redis INCR version failed; cache may be stale until TTL: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  async getString(key: string, logContext: string): Promise<string | null> {
    if (!this.redis) {
      this.logger.log(`${logContext} Redis GET skipped disabled key=${key}`);

      return null;
    }

    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logger.warn(
        `${logContext} Redis GET failed key=${key}: ${this.errorMessage(
          error,
        )}`,
      );

      return null;
    }
  }

  async setString(
    key: string,
    value: string,
    ttlSeconds: number,
    logContext: string,
  ): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn(`${logContext} Redis SET skipped disabled key=${key}`);

      return false;
    }

    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
      this.logger.log(
        `${logContext} Redis SET key=${key} ttlSeconds=${ttlSeconds}`,
      );

      return true;
    } catch (error) {
      this.logger.warn(
        `${logContext} Redis SET failed key=${key}: ${this.errorMessage(
          error,
        )}`,
      );

      return false;
    }
  }

  async getJson<T>(key: string, logContext: string): Promise<T | null> {
    const raw = await this.getString(key, logContext);

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(
        `${logContext} Redis JSON parse failed key=${key}: ${this.errorMessage(
          error,
        )}`,
      );

      return null;
    }
  }

  async setJson<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    logContext: string,
  ): Promise<boolean> {
    return this.setString(key, JSON.stringify(value), ttlSeconds, logContext);
  }

  async delete(key: string, logContext: string): Promise<void> {
    if (!this.redis) {
      this.logger.debug(`${logContext} Redis DEL skipped disabled key=${key}`);

      return;
    }

    try {
      await this.redis.del(key);
      this.logger.log(`${logContext} Redis DEL key=${key}`);
    } catch (error) {
      this.logger.warn(
        `${logContext} Redis DEL failed key=${key}: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  private async getOrSetWithLock<T>(
    options: IGetOrSetWithLockOptions<T>,
  ): Promise<ICacheResult<T>> {
    if (!this.redis) {
      const dbStartedAt = Date.now();
      const value = await options.loader();

      return {
        value,
        status: 'fallback-db',
        dbDurationMs: Date.now() - dbStartedAt,
      };
    }

    const cached = await this.safeGet<T>(options.key, options);

    if (cached.hit) {
      return { value: cached.value, status: 'hit' };
    }

    const lockKey = `lock:${options.key}`;
    const lockToken = randomUUID();
    const hasLock = await this.tryAcquireLock(lockKey, lockToken, options);

    if (hasLock) {
      const dbStartedAt = Date.now();

      try {
        const value = await options.loader();
        const dbDurationMs = Date.now() - dbStartedAt;
        await this.safeSet(options.key, value, options);

        return { value, status: 'miss-set', dbDurationMs };
      } finally {
        await this.releaseLock(lockKey, lockToken, options);
      }
    }

    const cachedAfterWait = await this.retryGetAfterLockWait(options);

    if (cachedAfterWait !== undefined) {
      return { value: cachedAfterWait, status: 'wait-hit' };
    }

    this.logger.warn(
      `${options.logContext} cache lock timeout fallback DB v=${
        options.version
      } q=${this.shortHash(options.queryHash)}`,
    );

    const dbStartedAt = Date.now();
    const value = await options.loader();

    return {
      value,
      status: 'fallback-db',
      dbDurationMs: Date.now() - dbStartedAt,
    };
  }

  private async safeGet<T>(
    key: string,
    options: IGetOrSetWithLockOptions<T>,
  ): Promise<{ hit: true; value: T } | { hit: false }> {
    if (!this.redis) {
      return { hit: false };
    }

    try {
      const raw = await this.redis.get(key);

      if (!raw) {
        return { hit: false };
      }

      return { hit: true, value: JSON.parse(raw) as T };
    } catch (error) {
      this.logger.warn(
        `${
          options.logContext
        } Redis GET/parse failed; treating as miss: ${this.errorMessage(
          error,
        )}`,
      );

      return { hit: false };
    }
  }

  private async safeSet<T>(
    key: string,
    value: T,
    options: IGetOrSetWithLockOptions<T>,
  ): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        'EX',
        options.ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `${
          options.logContext
        } Redis SET failed; response served without cache: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  private async tryAcquireLock<T>(
    lockKey: string,
    lockToken: string,
    options: IGetOrSetWithLockOptions<T>,
  ): Promise<boolean> {
    if (!this.redis) {
      return false;
    }

    try {
      const result = await this.redis.set(
        lockKey,
        lockToken,
        'EX',
        this.lockTtlSeconds,
        'NX',
      );
      const hasAcquiredLock = result === 'OK';

      if (hasAcquiredLock) {
        this.logger.debug(
          `${options.logContext} cache lock acquired v=${
            options.version
          } q=${this.shortHash(options.queryHash)}`,
        );
      }

      return hasAcquiredLock;
    } catch (error) {
      this.logger.warn(
        `${
          options.logContext
        } Redis lock acquire failed; fallback DB: ${this.errorMessage(error)}`,
      );

      return false;
    }
  }

  private async releaseLock<T>(
    lockKey: string,
    lockToken: string,
    options: IGetOrSetWithLockOptions<T>,
  ): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
      this.logger.debug(
        `${options.logContext} cache lock released v=${
          options.version
        } q=${this.shortHash(options.queryHash)}`,
      );
    } catch (error) {
      this.logger.warn(
        `${options.logContext} Redis lock release failed: ${this.errorMessage(
          error,
        )}`,
      );
    }
  }

  private stableNormalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stableNormalize(item));
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.stableNormalize(item)]),
      );
    }

    return value;
  }

  private async retryGetAfterLockWait<T>(
    options: IGetOrSetWithLockOptions<T>,
    index = 0,
  ): Promise<T | undefined> {
    if (index >= this.lockRetryDelaysMs.length) {
      return undefined;
    }

    const delayMs = this.lockRetryDelaysMs[index];

    this.logger.debug(
      `${options.logContext} cache lock wait delay=${delayMs}ms v=${
        options.version
      } q=${this.shortHash(options.queryHash)}`,
    );
    await this.sleep(delayMs);

    const cachedAfterWait = await this.safeGet<T>(options.key, options);

    if (cachedAfterWait.hit) {
      return cachedAfterWait.value;
    }

    return this.retryGetAfterLockWait(options, index + 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private shortHash(hash: string): string {
    return hash.slice(0, 8);
  }
}
