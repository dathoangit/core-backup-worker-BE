import { describe, expect, it, jest } from '@jest/globals';

import { BackupProgressPublisher } from './backup-progress.publisher';

describe('BackupProgressPublisher throttle', () => {
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
    });
    sink.onTableProgress({
      database: 'produce',
      table: 'b',
      tablesDone: 2,
      tablesTotal: 10,
      rowsDelta: 10,
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
});
