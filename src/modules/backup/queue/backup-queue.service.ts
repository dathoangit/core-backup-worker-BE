import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Job, Queue } from 'bullmq';
import { In, type Repository } from 'typeorm';

import { BackupConfigService } from '../backup-config.service';
import {
  clearStaleDatabaseLocks,
  clearStaleLock,
  LOCK_OWNER_ID,
} from '../engine/lock';
import { createRunId } from '../engine/manifest';
import { BackupRunEntity } from '../entities/backup-run.entity';
import { BackupEventsService } from '../events/backup-events.service';
import { type BackupMode, type BackupRunOptions } from '../types';
import { BackupCancelRegistry } from './backup-cancel.registry';
import {
  BACKUP_FULL_PRIORITY,
  BACKUP_FULL_QUEUE_NAME,
  BACKUP_INCREMENTAL_PRIORITY,
  BACKUP_INCREMENTAL_QUEUE_NAME,
  BACKUP_QUEUE_JOB_NAME,
} from './backup-queue.constants';
import { type BackupQueueJobData } from './backup-queue.types';
import { BackupRedisService } from './backup-redis.service';

export interface EnqueueBackupResult {
  runId: string;
  status: 'queued';
  mode: BackupQueueJobData['mode'];
  message: string;
}

export interface BackupQueueJobView {
  runId: string;
  queue: string;
  bullState: string;
  mode: BackupMode;
  trigger: string;
  sourceGroups: string[] | null;
  databases: string[] | null;
  timestamp: number | null;
}

export interface BackupQueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  prioritized: number;
}

export interface BackupQueueSnapshot {
  generatedAt: string;
  incremental: {
    name: string;
    counts: BackupQueueCounts;
    jobs: BackupQueueJobView[];
  };
  full: {
    name: string;
    counts: BackupQueueCounts;
    jobs: BackupQueueJobView[];
  };
  dbQueued: BackupRunEntity[];
  dbRunning: BackupRunEntity[];
}

@Injectable()
export class BackupQueueService {
  private readonly logger = new Logger(BackupQueueService.name);

  constructor(
    @InjectQueue(BACKUP_INCREMENTAL_QUEUE_NAME)
    private readonly incrementalQueue: Queue<BackupQueueJobData>,
    @InjectQueue(BACKUP_FULL_QUEUE_NAME)
    private readonly fullQueue: Queue<BackupQueueJobData>,
    @InjectRepository(BackupRunEntity)
    private readonly runRepo: Repository<BackupRunEntity>,
    private readonly backupConfig: BackupConfigService,
    private readonly cancelRegistry: BackupCancelRegistry,
    private readonly backupRedis: BackupRedisService,
    private readonly backupEvents: BackupEventsService,
  ) {}

  queueForMode(mode: BackupMode): Queue<BackupQueueJobData> {
    return mode === 'incremental' ? this.incrementalQueue : this.fullQueue;
  }

  async enqueue(options: BackupRunOptions): Promise<EnqueueBackupResult> {
    const mode = options.mode ?? 'incremental';
    const runId = createRunId();
    const now = new Date();

    let backupDir = '';

    try {
      backupDir = (await this.backupConfig.getSettings()).backupDir;
    } catch {
      backupDir = '';
    }

    const sourceGroupsCsv = options.sourceGroups?.join(',') ?? null;
    const databasesCsv = options.databases?.join(',') ?? null;

    await this.runRepo.save(
      this.runRepo.create({
        runId,
        startedAt: now,
        finishedAt: null,
        status: 'queued',
        trigger: options.trigger,
        mode,
        backupDir,
        error: null,
        archiveStatus: null,
        sourceGroups: sourceGroupsCsv,
        databasesFilter: databasesCsv,
        queuedAt: now,
      }),
    );

    const jobData: BackupQueueJobData = {
      runId,
      trigger: options.trigger,
      mode,
      sourceGroups: options.sourceGroups,
      databases: options.databases,
    };

    const queue = this.queueForMode(mode);
    const priority =
      mode === 'incremental'
        ? BACKUP_INCREMENTAL_PRIORITY
        : BACKUP_FULL_PRIORITY;

    try {
      await queue.add(BACKUP_QUEUE_JOB_NAME, jobData, {
        jobId: runId,
        attempts: 1,
        priority,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      });
    } catch (error) {
      const message = `Failed to enqueue backup job: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.logger.error(`run=${runId} ${message}`);
      await this.runRepo.update(
        { runId },
        {
          status: 'error',
          finishedAt: new Date(),
          error: message,
        },
      );
      this.backupEvents.emitStatus({
        runId,
        status: 'error',
        mode,
        trigger: options.trigger,
        error: message,
      });

      throw new ServiceUnavailableException(
        'Backup queue unavailable (Redis). Ensure Redis is up and REDIS_* / REDIS_BULL_DB are set.',
      );
    }

    this.backupEvents.emitStatus({
      runId,
      status: 'queued',
      mode,
      trigger: options.trigger,
    });
    this.backupEvents.emitLog({
      runId,
      level: 'info',
      message: `Backup queued (mode=${mode}, queue=${queue.name})`,
    });
    this.logger.log(
      `queued run=${runId} mode=${mode} trigger=${options.trigger} queue=${
        queue.name
      } groups=${options.sourceGroups?.join(',') || '*'} databases=${
        options.databases?.join(',') || '*'
      }`,
    );

    return {
      runId,
      status: 'queued',
      mode,
      message: `Backup queued (mode=${mode}, queue=${queue.name})`,
    };
  }

  async cancel(runId: string): Promise<{ runId: string; status: string }> {
    const row = await this.runRepo.findOne({ where: { runId } });

    if (!row) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    if (
      row.status === 'ok' ||
      row.status === 'partial' ||
      row.status === 'error' ||
      row.status === 'cancelled'
    ) {
      throw new ConflictException(
        `Run ${runId} is already finished (${row.status})`,
      );
    }

    const found = await this.findJob(runId);

    if (found) {
      const state = await found.job.getState();

      if (
        state === 'waiting' ||
        state === 'delayed' ||
        state === 'prioritized'
      ) {
        await found.job.remove();
        await this.markCancelled(runId, 'Cancelled while queued');
        this.logger.log(`cancel run=${runId}: removed queued job`);

        return { runId, status: 'cancelled' };
      }

      if (state === 'active') {
        await this.signalCancel(runId);
        await this.runRepo.update({ runId }, { error: 'Cancel requested' });
        this.backupEvents.emitStatus({
          runId,
          status: 'cancelling',
          mode: row.mode,
          trigger: row.trigger,
          error: 'Cancel requested',
        });
        this.logger.log(`cancel run=${runId}: signal sent to active job`);

        return { runId, status: 'cancelling' };
      }
    }

    if (row.status === 'queued') {
      await this.markCancelled(runId, 'Cancelled while queued (orphan job)');
      this.logger.log(`cancel run=${runId}: removed orphan queued job`);

      return { runId, status: 'cancelled' };
    }

    if (row.status === 'running') {
      await this.signalCancel(runId);
      await this.runRepo.update({ runId }, { error: 'Cancel requested' });
      this.backupEvents.emitStatus({
        runId,
        status: 'cancelling',
        mode: row.mode,
        trigger: row.trigger,
        error: 'Cancel requested',
      });
      this.logger.log(`cancel run=${runId}: signal sent to running job`);

      return { runId, status: 'cancelling' };
    }

    throw new ConflictException(
      `Cannot cancel run ${runId} in status ${row.status}`,
    );
  }

  async markCancelled(runId: string, message: string): Promise<void> {
    await this.runRepo.update(
      { runId },
      {
        status: 'cancelled',
        finishedAt: new Date(),
        error: message,
      },
    );
    this.cancelRegistry.clear(runId);
    await this.backupRedis.clearCancelFlag(runId);
    this.backupEvents.emitStatus({
      runId,
      status: 'cancelled',
      error: message,
    });
    this.backupEvents.emitLog({
      runId,
      level: 'warn',
      message,
    });
  }

  async getActiveJobCount(): Promise<number> {
    const [inc, full] = await Promise.all([
      this.incrementalQueue.getActiveCount(),
      this.fullQueue.getActiveCount(),
    ]);

    return inc + full;
  }

  async getQueueSnapshot(): Promise<BackupQueueSnapshot> {
    const [incremental, full, dbQueued, dbRunning] = await Promise.all([
      this.describeQueue(this.incrementalQueue),
      this.describeQueue(this.fullQueue),
      this.runRepo.find({
        where: { status: 'queued' },
        order: { queuedAt: 'ASC' },
        take: 100,
      }),
      this.runRepo.find({
        where: { status: 'running' },
        order: { startedAt: 'DESC' },
        take: 50,
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      incremental,
      full,
      dbQueued,
      dbRunning,
    };
  }

  async cancelAllQueued(): Promise<{
    cancelled: string[];
    failed: Array<{ runId: string; error: string }>;
  }> {
    const rows = await this.runRepo.find({
      where: { status: 'queued' },
      order: { queuedAt: 'ASC' },
    });

    const cancelled: string[] = [];
    const failed: Array<{ runId: string; error: string }> = [];

    for (const row of rows) {
      try {
        await this.cancel(row.runId);
        cancelled.push(row.runId);
      } catch (error) {
        failed.push({
          runId: row.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { cancelled, failed };
  }

  private async describeQueue(queue: Queue<BackupQueueJobData>): Promise<{
    name: string;
    counts: BackupQueueCounts;
    jobs: BackupQueueJobView[];
  }> {
    const countsRaw = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
      'prioritized',
    );

    const [waiting, active, delayed, prioritized] = await Promise.all([
      queue.getJobs(['waiting'], 0, 49),
      queue.getJobs(['active'], 0, 49),
      queue.getJobs(['delayed'], 0, 49),
      queue.getJobs(['prioritized'], 0, 49),
    ]);

    const jobs = await Promise.all(
      [...active, ...waiting, ...prioritized, ...delayed].map((job) =>
        this.toJobView(queue.name, job),
      ),
    );

    return {
      name: queue.name,
      counts: {
        waiting: countsRaw.waiting ?? 0,
        active: countsRaw.active ?? 0,
        delayed: countsRaw.delayed ?? 0,
        failed: countsRaw.failed ?? 0,
        completed: countsRaw.completed ?? 0,
        prioritized: countsRaw.prioritized ?? 0,
      },
      jobs,
    };
  }

  private async toJobView(
    queueName: string,
    job: Job<BackupQueueJobData>,
  ): Promise<BackupQueueJobView> {
    const state = await job.getState();
    const data = job.data;

    return {
      runId: data.runId,
      queue: queueName,
      bullState: state,
      mode: data.mode,
      trigger: data.trigger,
      sourceGroups: data.sourceGroups ?? null,
      databases: data.databases ?? null,
      timestamp: job.timestamp ?? null,
    };
  }

  async recoverStaleState(): Promise<void> {
    const running = await this.runRepo.find({
      where: { status: In(['running', 'cancelling']) },
    });

    for (const row of running) {
      const found = await this.findJob(row.runId);

      if (found) {
        const state = await found.job.getState();

        // Waiting/delayed jobs can still be consumed after boot — keep them.
        if (
          state === 'waiting' ||
          state === 'delayed' ||
          state === 'prioritized'
        ) {
          continue;
        }

        // Active jobs at worker boot are orphans from the previous process
        // (lockDuration can keep them "active" for hours after a crash).
        if (state === 'active') {
          await this.discardOrphanActiveJob(found.job, row.runId);
        }
      }

      row.status = 'error';
      row.finishedAt = new Date();
      row.error =
        row.error ?? 'Interrupted by worker restart (backup was interrupted)';
      await this.runRepo.save(row);
      this.logger.warn(`Marked stale running run ${row.runId} as error`);
      await this.backupRedis.clearCancelFlag(row.runId);
    }

    try {
      const settings = await this.backupConfig.getSettings();

      if (clearStaleLock(settings.backupDir, LOCK_OWNER_ID)) {
        this.logger.warn(
          `Cleared stale backup.lock under ${settings.backupDir}`,
        );
      }

      const cleared = clearStaleDatabaseLocks(
        settings.backupDir,
        LOCK_OWNER_ID,
      );

      if (cleared.length > 0) {
        this.logger.warn(`Cleared stale database locks: ${cleared.join(', ')}`);
      }
    } catch (error) {
      this.logger.debug(
        `Skip lock cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const queued = await this.runRepo.find({
      where: { status: 'queued' },
      order: { queuedAt: 'ASC' },
    });

    const aliveBullStates = new Set([
      'waiting',
      'delayed',
      'prioritized',
      'active',
      'waiting-children',
    ]);

    for (const row of queued) {
      const existing = await this.findJob(row.runId);

      if (existing) {
        const state = await existing.job.getState();

        if (aliveBullStates.has(state)) {
          continue;
        }

        // Redis job is dead (failed/completed/unknown) but DB still queued.
        try {
          await existing.job.remove();
        } catch {
          // ignore remove errors
        }

        await this.markCancelled(
          row.runId,
          `Cleared orphan queued run (BullMQ state=${state})`,
        );
        this.logger.warn(
          `Marked orphan queued run ${row.runId} cancelled (BullMQ state=${state})`,
        );

        continue;
      }

      const sourceGroups = row.sourceGroups
        ? row.sourceGroups.split(',').filter(Boolean)
        : undefined;
      const databases = row.databasesFilter
        ? row.databasesFilter.split(',').filter(Boolean)
        : undefined;

      const mode =
        row.mode === 'full' || row.mode === 'logical'
          ? row.mode
          : 'incremental';
      const queue = this.queueForMode(mode);
      const priority =
        mode === 'incremental'
          ? BACKUP_INCREMENTAL_PRIORITY
          : BACKUP_FULL_PRIORITY;

      await queue.add(
        BACKUP_QUEUE_JOB_NAME,
        {
          runId: row.runId,
          trigger: row.trigger,
          mode,
          sourceGroups: sourceGroups as BackupQueueJobData['sourceGroups'],
          databases,
        },
        {
          jobId: row.runId,
          attempts: 1,
          priority,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        },
      );
      this.logger.log(`Re-enqueued orphan queued run ${row.runId}`);
    }
  }

  private async signalCancel(runId: string): Promise<void> {
    await this.backupRedis.publishCancel(runId);
    await this.cancelRegistry.requestCancel(runId);
  }

  /**
   * Fail/remove a BullMQ job left in `active` after process death.
   * Recovery only runs on worker boot, so any `active` job here is orphaned.
   */
  private async discardOrphanActiveJob(
    job: Job<BackupQueueJobData>,
    runId: string,
  ): Promise<void> {
    const reason = 'Interrupted by worker restart';

    try {
      const token =
        typeof job.token === 'string' && job.token.length > 0 ? job.token : '0';
      await job.moveToFailed(new Error(reason), token, false);
      this.logger.warn(`Moved orphan active job ${runId} to failed`);

      return;
    } catch (error) {
      this.logger.warn(
        `moveToFailed orphan ${runId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      await job.remove();
      this.logger.warn(`Removed orphan active job ${runId}`);
    } catch (error) {
      this.logger.warn(
        `remove orphan ${runId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async findJob(
    runId: string,
  ): Promise<{ job: Job<BackupQueueJobData>; queue: Queue } | null> {
    for (const queue of [this.incrementalQueue, this.fullQueue]) {
      const job = await queue.getJob(runId);

      if (job) {
        return { job, queue };
      }
    }

    return null;
  }
}
