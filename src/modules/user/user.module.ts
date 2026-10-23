import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CacheModule } from '../cache/cache.module';
import { UserEntity } from './user.entity';
import { UserService } from './user.service';
import { UserAdminController } from './user-admin.controller';

@Module({
  imports: [CacheModule, TypeOrmModule.forFeature([UserEntity])],
  controllers: [UserAdminController],
  providers: [UserService],
  exports: [UserService, TypeOrmModule],
})
export class UserModule {}
