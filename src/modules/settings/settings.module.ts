import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BackupModule } from '../backup/backup.module';
import { AppSettingEntity } from './entities/app-setting.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([AppSettingEntity]),
    forwardRef(() => BackupModule),
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
