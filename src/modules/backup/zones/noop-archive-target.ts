import { Injectable } from '@nestjs/common';

import {
  type ArchiveResult,
  type ArchiveTarget,
} from './archive-target.interface';

@Injectable()
export class NoopArchiveTarget implements ArchiveTarget {
  readonly name = 'none';

  isConfigured(): boolean {
    return false;
  }

  async publishRun(runId: string, _runDir: string): Promise<ArchiveResult> {
    return {
      status: 'not-configured',
      message: `Isolated archive not configured (run ${runId}). Set BACKUP_ARCHIVE_TARGET when infrastructure is ready.`,
    };
  }
}
