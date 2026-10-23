import { Module } from '@nestjs/common';

import { BackupApiModule } from './backup-api.module';

/**
 * Compatibility export — AppModule should prefer BackupApiModule directly.
 * Kept so SettingsModule / older imports keep resolving.
 */
@Module({
  imports: [BackupApiModule],
  exports: [BackupApiModule],
})
export class BackupModule {}
