import {
  Controller,
  Header,
  type MessageEvent,
  Param,
  Sse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { interval, merge, Observable } from 'rxjs';
import { finalize, map, takeWhile } from 'rxjs/operators';

import { Auth } from '../../decorators';
import { type BackupProgressMessage } from './progress/backup-progress.types';
import { BackupRedisService } from './queue/backup-redis.service';

const TERMINAL = new Set(['ok', 'partial', 'error', 'cancelled']);

@Controller('runs')
@ApiTags('runs')
export class BackupRunsStreamController {
  constructor(private readonly backupRedis: BackupRedisService) {}

  @Sse(':id/stream')
  @Auth()
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache')
  stream(@Param('id') runId: string): Observable<MessageEvent> {
    let closed = false;
    let unsub: (() => void) | null = null;

    const live$ = new Observable<BackupProgressMessage>((subscriber) => {
      void this.backupRedis.getLastProgress(runId).then((last) => {
        if (last && !closed) {
          subscriber.next(last);
        }
      });

      unsub = this.backupRedis.onProgress(runId, (message) => {
        subscriber.next(message);

        if (
          message.type === 'status' &&
          message.status &&
          TERMINAL.has(message.status)
        ) {
          subscriber.complete();
        }
      });

      return () => {
        closed = true;
        unsub?.();
      };
    });

    const ping$ = interval(15_000).pipe(
      map(
        (): BackupProgressMessage => ({
          type: 'log',
          runId,
          at: new Date().toISOString(),
          line: 'ping',
          level: 'info',
        }),
      ),
    );

    return merge(live$, ping$).pipe(
      takeWhile(
        (message) =>
          !(
            message.type === 'status' &&
            message.status &&
            TERMINAL.has(message.status)
          ),
        true,
      ),
      map(
        (data) =>
          ({
            type: data.type,
            data: JSON.stringify(data),
          }) as MessageEvent,
      ),
      finalize(() => {
        closed = true;
        unsub?.();
      }),
    );
  }
}
