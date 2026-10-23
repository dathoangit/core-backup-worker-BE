import { Injectable } from '@nestjs/common';

import { BackupConfigService } from './backup-config.service';
import { type SourceConfig } from './types';

@Injectable()
export class SourceRegistry {
  constructor(private readonly backupConfig: BackupConfigService) {}

  async getRunnableSources(): Promise<SourceConfig[]> {
    return (await this.listAllSources()).filter(
      (s) => s.reachability === 'ready',
    );
  }

  async listAllSources(): Promise<SourceConfig[]> {
    const sources: SourceConfig[] = [];

    const his = await this.backupConfig.loadSource('HIS', 'HIS');

    if (his) {
      sources.push(his);
    }

    const emr = await this.backupConfig.loadSource('EMR', 'EMR');

    if (emr) {
      sources.push(emr);
    }

    const badl = await this.backupConfig.loadSource('BADL', 'BADL', {
      defaultReachability: 'unreachable',
      reason:
        'BADL secondary host not reachable yet (ECONNREFUSED). Kept in inventory only.',
    });

    if (badl) {
      sources.push(badl);
    }

    const lis = await this.backupConfig.loadSource('LIS', 'LIS', {
      defaultPort: 1433,
    });

    if (lis) {
      sources.push(lis);
    }

    const pacs = await this.backupConfig.loadSource('PACS', 'PACS');

    if (pacs) {
      sources.push({
        ...pacs,
        reachability:
          pacs.reachability === 'ready' ? 'unconfigured' : pacs.reachability,
        reason: pacs.reason ?? 'PACS profile not implemented yet',
      });
    }

    return sources;
  }
}
