import { describe, expect, it } from '@jest/globals';
import { firstValueFrom, take, toArray } from 'rxjs';

import { BackupEventsService } from './backup-events.service';

function progressPartial(runId: string, percent: number) {
  return {
    runId,
    database: 'LabInventory_XP',
    currentTable: 'dbo.tbl_InputDetail_Analyzer',
    tablesDone: 1,
    tablesTotal: 2,
    databasesDone: 0,
    databasesTotal: 1,
    rowsTotal: 29_000,
    bytesTotal: 20_000,
    percent,
  };
}

describe('BackupEventsService', () => {
  it('snaps buffered progress to 100% when status becomes ok', async () => {
    const service = new BackupEventsService();

    service.emitProgress(progressPartial('run-1', 95));
    service.emitStatus({ runId: 'run-1', status: 'ok' });

    const message = await firstValueFrom(service.stream({ runId: 'run-1' }));
    const snapshot = JSON.parse(String(message.data)) as {
      type: string;
      status: { status: string } | null;
      progress: { percent: number; etaSeconds: number | null } | null;
    };

    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.status?.status).toBe('ok');
    expect(snapshot.progress?.percent).toBe(100);
    expect(snapshot.progress?.etaSeconds).toBe(0);

    service.onModuleDestroy();
  });

  it('does not emit late progress after a terminal status', async () => {
    const service = new BackupEventsService();
    const progressEvents: unknown[] = [];

    const sub = service.events$.subscribe((event) => {
      if (event.type === 'run.progress') {
        progressEvents.push(event);
      }
    });

    service.emitStatus({ runId: 'run-1', status: 'ok' });
    service.emitProgress(progressPartial('run-1', 95));

    expect(progressEvents).toHaveLength(0);

    const messages = await firstValueFrom(
      service.stream({ runId: 'run-1' }).pipe(take(1), toArray()),
    );
    const snapshot = JSON.parse(String(messages[0]?.data)) as {
      progress: unknown;
    };

    expect(snapshot.progress).toBeNull();

    sub.unsubscribe();
    service.onModuleDestroy();
  });

  it('keeps progress while the run is still running', async () => {
    const service = new BackupEventsService();

    service.emitStatus({ runId: 'run-1', status: 'running' });
    service.emitProgress(progressPartial('run-1', 42));

    const message = await firstValueFrom(service.stream({ runId: 'run-1' }));
    const snapshot = JSON.parse(String(message.data)) as {
      progress: { percent: number } | null;
      status: { status: string } | null;
    };

    expect(snapshot.status?.status).toBe('running');
    expect(snapshot.progress?.percent).toBe(42);

    service.onModuleDestroy();
  });
});
