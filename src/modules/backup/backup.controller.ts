import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Auth } from '../../decorators';
import { BackupService } from './backup.service';
import type { BackupMode, SourceGroup } from './types';

@Controller('admin/backup')
@ApiTags('admin/backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auth()
  triggerRun(
    @Query('mode') modeRaw?: string,
    @Query('groups') groupsRaw?: string,
    @Query('databases') databasesRaw?: string,
  ) {
    const mode: BackupMode =
      modeRaw === 'full' ? 'full' : 'incremental';
    const sourceGroups = this.parseGroups(groupsRaw);
    const databases = this.parseDatabases(databasesRaw);

    return this.backupService.triggerRun({
      trigger: 'manual',
      mode,
      sourceGroups,
      databases,
    });
  }

  @Get('runs')
  @Auth()
  listRuns(@Query('limit') limit?: string) {
    const take = limit ? Number.parseInt(limit, 10) : 50;

    return this.backupService.listRuns(
      Number.isFinite(take) && take > 0 ? take : 50,
    );
  }

  @Get('runs/:runId')
  @Auth()
  getRun(@Param('runId') runId: string) {
    return this.backupService.getRun(runId);
  }

  @Get('sources')
  @Auth()
  listSources() {
    return this.backupService.listSources();
  }

  @Get('zones')
  @Auth()
  getZones() {
    return this.backupService.getZones();
  }

  @Get('restore-plan')
  @Auth()
  getRestorePlan(@Query('database') database = 'produce') {
    return this.backupService.getRestorePlan(database);
  }

  private parseGroups(raw?: string): SourceGroup[] | undefined {
    if (!raw?.trim()) {
      return undefined;
    }

    const allowed = new Set<SourceGroup>([
      'HIS',
      'EMR',
      'BADL',
      'LIS',
      'PACS',
    ]);
    const groups = raw
      .split(',')
      .map((part) => part.trim().toUpperCase())
      .filter((part): part is SourceGroup =>
        allowed.has(part as SourceGroup),
      );

    return groups.length > 0 ? groups : undefined;
  }

  private parseDatabases(raw?: string): string[] | undefined {
    if (!raw?.trim()) {
      return undefined;
    }

    const databases = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    return databases.length > 0 ? databases : undefined;
  }
}
