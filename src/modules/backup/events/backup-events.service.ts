import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { interval, merge, Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

import {
  type BackupRunLogEvent,
  type BackupRunProgressEvent,
  type BackupRunStatusEvent,
  type BackupStreamEvent,
} from './backup-events.types';

interface RunBuffer {
  status: BackupRunStatusEvent | null;
  progress: BackupRunProgressEvent | null;
  logs: BackupRunLogEvent[];
}

const MAX_LOGS_PER_RUN = 500;
const MAX_TRACKED_RUNS = 20;
const HEARTBEAT_MS = 25_000;

const TERMINAL_STATUSES = new Set<BackupRunStatusEvent['status']>([
  'ok',
  'partial',
  'error',
  'cancelled',
]);

function isTerminalStatus(
  status: BackupRunStatusEvent['status'] | undefined | null,
): boolean {
  return Boolean(status && TERMINAL_STATUSES.has(status));
}

@Injectable()
export class BackupEventsService implements OnModuleDestroy {
  private readonly subject = new Subject<BackupStreamEvent>();

  private readonly buffers = new Map<string, RunBuffer>();

  private readonly runOrder: string[] = [];

  /** Live event bus for in-process consumers (alerts, etc.). */
  get events$(): Observable<BackupStreamEvent> {
    return this.subject.asObservable();
  }

  emit(event: BackupStreamEvent): void {
    switch (event.type) {
      case 'run.status': {
        const buffer = this.touchRun(event.runId);
        buffer.status = event;

        if (
          (event.status === 'ok' || event.status === 'partial') &&
          buffer.progress
        ) {
          buffer.progress = {
            ...buffer.progress,
            percent: 100,
            etaSeconds: 0,
            at: event.at,
          };
        }

        break;
      }

      case 'run.progress': {
        const buffer = this.touchRun(event.runId);

        if (isTerminalStatus(buffer.status?.status)) {
          return;
        }

        buffer.progress = event;

        break;
      }

      case 'run.log': {
        const buffer = this.touchRun(event.runId);
        buffer.logs.push(event);

        if (buffer.logs.length > MAX_LOGS_PER_RUN) {
          buffer.logs.splice(0, buffer.logs.length - MAX_LOGS_PER_RUN);
        }

        break;
      }
      // No default
    }

    this.subject.next(event);
  }

  emitStatus(
    partial: Omit<BackupRunStatusEvent, 'type' | 'at'> & { at?: string },
  ): void {
    this.emit({
      type: 'run.status',
      at: partial.at ?? new Date().toISOString(),
      ...partial,
    });
  }

  emitProgress(
    partial: Omit<BackupRunProgressEvent, 'type' | 'at'> & { at?: string },
  ): void {
    this.emit({
      type: 'run.progress',
      at: partial.at ?? new Date().toISOString(),
      ...partial,
    });
  }

  emitLog(
    partial: Omit<BackupRunLogEvent, 'type' | 'at'> & { at?: string },
  ): void {
    this.emit({
      type: 'run.log',
      at: partial.at ?? new Date().toISOString(),
      ...partial,
    });
  }

  stream(options?: {
    runId?: string;
    includeLogs?: boolean;
  }): Observable<MessageEvent> {
    const runId = options?.runId;
    const includeLogs = options?.includeLogs !== false;

    const snapshots: BackupStreamEvent[] = [];

    if (runId) {
      const buffer = this.buffers.get(runId);

      if (buffer) {
        snapshots.push({
          type: 'snapshot',
          runId,
          status: buffer.status,
          progress: buffer.progress,
          logs: includeLogs ? [...buffer.logs] : [],
          at: new Date().toISOString(),
        });
      }
    } else {
      for (const id of this.runOrder) {
        const buffer = this.buffers.get(id);

        if (!buffer) {
          continue;
        }

        snapshots.push({
          type: 'snapshot',
          runId: id,
          status: buffer.status,
          progress: buffer.progress,
          logs: includeLogs ? [...buffer.logs] : [],
          at: new Date().toISOString(),
        });
      }
    }

    const live$ = this.subject.asObservable().pipe(
      filter((event) => {
        if (event.type === 'heartbeat') {
          return true;
        }

        if (runId && 'runId' in event && event.runId !== runId) {
          return false;
        }

        if (!includeLogs && event.type === 'run.log') {
          return false;
        }

        if (!includeLogs && event.type === 'run.progress') {
          // public stream still gets progress without file paths
          return true;
        }

        return true;
      }),
    );

    const heartbeat$ = interval(HEARTBEAT_MS).pipe(
      map(
        (): BackupStreamEvent => ({
          type: 'heartbeat',
          at: new Date().toISOString(),
        }),
      ),
    );

    const snapshot$ = new Observable<BackupStreamEvent>((subscriber) => {
      for (const snap of snapshots) {
        subscriber.next(snap);
      }

      subscriber.complete();
    });

    return merge(snapshot$, live$, heartbeat$).pipe(
      map(
        (data) =>
          ({
            type: data.type,
            data: JSON.stringify(data),
          }) as MessageEvent,
      ),
    );
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }

  private touchRun(runId: string): RunBuffer {
    let buffer = this.buffers.get(runId);

    if (!buffer) {
      buffer = { status: null, progress: null, logs: [] };
      this.buffers.set(runId, buffer);
      this.runOrder.push(runId);

      while (this.runOrder.length > MAX_TRACKED_RUNS) {
        const old = this.runOrder.shift();

        if (old) {
          this.buffers.delete(old);
        }
      }
    }

    return buffer;
  }
}
