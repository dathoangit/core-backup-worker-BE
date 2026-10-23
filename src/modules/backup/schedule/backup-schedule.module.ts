import { Global, Module } from '@nestjs/common';

import { BackupScheduleReloadBus } from './backup-schedule-reload.bus';

@Global()
@Module({
  providers: [BackupScheduleReloadBus],
  exports: [BackupScheduleReloadBus],
})
export class BackupScheduleModule {}
