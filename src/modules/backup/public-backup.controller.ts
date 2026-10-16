import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { PublicRoute } from '../../decorators';
import { BackupService } from './backup.service';

@Controller('public/backup')
@ApiTags('public/backup')
export class PublicBackupController {
  constructor(private readonly backupService: BackupService) {}

  @Get('overview')
  @PublicRoute(true)
  @ApiOkResponse({ description: 'Read-only wallboard overview' })
  getOverview() {
    return this.backupService.getPublicOverview();
  }
}
