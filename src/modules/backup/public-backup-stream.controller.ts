import { Controller, Header, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Observable } from 'rxjs';

import { PublicRoute } from '../../decorators';
import { BackupEventsService } from './events/backup-events.service';

@Controller('public/backup')
@ApiTags('public/backup')
export class PublicBackupStreamController {
  constructor(private readonly backupEvents: BackupEventsService) {}

  @Sse('stream')
  @PublicRoute(true)
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache')
  stream(): Observable<MessageEvent> {
    return this.backupEvents.stream({ includeLogs: false });
  }
}
