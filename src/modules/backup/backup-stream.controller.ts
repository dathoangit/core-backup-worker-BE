import { Controller, Header, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Observable } from 'rxjs';

import { Auth } from '../../decorators';
import { BackupEventsService } from './events/backup-events.service';

@Controller('admin/backup')
@ApiTags('admin/backup')
export class BackupStreamController {
  constructor(private readonly backupEvents: BackupEventsService) {}

  @Sse('stream')
  @Auth()
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache')
  stream(@Query('runId') runId?: string): Observable<MessageEvent> {
    return this.backupEvents.stream({
      runId: runId?.trim() || undefined,
      includeLogs: true,
    });
  }
}
