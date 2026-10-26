import { describe, expect, it, jest } from '@jest/globals';

import { BackupProgressPublisher } from './backup-progress.publisher';

describe('BackupProgressPublisher', () => {
  it('throttles progress emits to at most one per second', async () => {
    const published: unknown[] = [];
    const backupRedis = {
      publishProgress: jest.fn((message: unknown) => {
        published.push(message);

        return Promise.resolve();
      }),
    };

    const publisher = new BackupProgressPublisher(backupRedis as never);
    publisher.begin('run-1', 1);
    publisher.setDbIndex('run-1', 0, 'produce');

    const sink = publisher.sinkFor('run-1');
    sink.onTableProgress({
      database: 'produce',
      table: 'a',
      tablesDone: 1,
      tablesTotal: 10,
      rowsDelta: 10,
      bytesDelta: 1000,
    });
    sink.onTableProgress({
      database: 'produce',
      table: 'b',
      tablesDone: 2,
      tablesTotal: 10,
      rowsDelta: 10,
      bytesDelta: 1000,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(
      published.filter(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'progress',
      ),
    ).toHaveLength(1);
  });

  it('includes bytes, rates, and ETA on progress messages', async () => {
    const published: Array<Record<string, unknown>> = [];
    const backupRedis = {
      publishProgress: jest.fn((message: Record<string, unknown>) => {
        published.push(message);

        return Promise.resolve();
      }),
    };

    const publisher = new BackupProgressPublisher(backupRedis as never);
    publisher.begin('run-2', 1);
    publisher.setDbIndex('run-2', 0, 'produce');

    const sink = publisher.sinkFor('run-2');
    sink.onTableProgress({
      database: 'produce',
      table: 'a',
      tablesDone: 5,
      tablesTotal: 10,
      rowsDelta: 1000,
      bytesDelta: 50_000,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const progress = published.find((m) => m.type === 'progress');
    expect(progress).toBeDefined();
    expect(progress?.rowsProcessed).toBe(1000);
    expect(progress?.bytesProcessed).toBe(50_000);
    expect(progress?.tablesDone).toBe(5);
    expect(progress?.tablesTotal).toBe(10);
    expect(typeof progress?.rowsPerSec).toBe('number');
    expect(typeof progress?.bytesPerSec).toBe('number');
    expect(progress?.etaSeconds).not.toBeNull();
    expect(typeof progress?.startedAt).toBe('string');
  });

  it('floors percent at 1 once work starts across many databases', async () => {
    const published: Array<Record<string, unknown>> = [];
    const backupRedis = {
      publishProgress: jest.fn((message: Record<string, unknown>) => {
        published.push(message);

        return Promise.resolve();
      }),
    };

    const publisher = new BackupProgressPublisher(backupRedis as never);
    publisher.begin('run-3', 12);
    publisher.setDbIndex('run-3', 0, 'produce');

    const sink = publisher.sinkFor('run-3');
    sink.onTableProgress({
      database: 'produce',
      table: 'adempiere.ad_attachment',
      tablesDone: 0,
      tablesTotal: 2000,
      bytesDelta: 1024,
      inFlight: true,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const progress = published.find((m) => m.type === 'progress');
    expect(progress?.percent).toBe(1);
    expect(progress?.currentTable).toBe('adempiere.ad_attachment');
    expect(progress?.bytesProcessed).toBe(1024);
    // Floored 1% must not drive a ~99× elapsed ETA.
    expect(progress?.etaSeconds).toBeNull();
  });

  it('flushes immediately when the active table changes', async () => {
    const published: Array<Record<string, unknown>> = [];
    const backupRedis = {
      publishProgress: jest.fn((message: Record<string, unknown>) => {
        published.push(message);

        return Promise.resolve();
      }),
    };

    const publisher = new BackupProgressPublisher(backupRedis as never);
    publisher.begin('run-4', 1);
    publisher.setDbIndex('run-4', 0, 'produce');
    const sink = publisher.sinkFor('run-4');

    sink.onTableProgress({
      database: 'produce',
      table: 'a',
      tablesDone: 0,
      tablesTotal: 10,
      inFlight: true,
    });
    sink.onTableProgress({
      database: 'produce',
      table: 'b',
      tablesDone: 1,
      tablesTotal: 10,
      inFlight: true,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const progressEvents = published.filter((m) => m.type === 'progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.at(-1)?.currentTable).toBe('b');
  });
});
