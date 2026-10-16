import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type { SettingCategory } from '../settings.constants';

export class CreateSettingDto {
  @ApiProperty({ example: 'BACKUP_DIR' })
  @IsString()
  @MaxLength(128)
  key!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  value?: string | null;

  @ApiPropertyOptional({
    enum: ['backup', 'his', 'emr', 'badl', 'lis'],
    description: 'Optional; inferred from allowlist when omitted',
  })
  @IsOptional()
  @IsIn(['backup', 'his', 'emr', 'badl', 'lis'])
  category?: SettingCategory;

  @ApiPropertyOptional({
    description: 'Optional; inferred from allowlist (PASSWORD keys = secret)',
  })
  @IsOptional()
  @IsBoolean()
  isSecret?: boolean;
}

export class UpdateSettingDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  value?: string | null;
}

export class SettingResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Always null for secrets',
  })
  value!: string | null;

  @ApiProperty()
  isSecret!: boolean;

  @ApiProperty()
  hasValue!: boolean;

  @ApiProperty()
  category!: SettingCategory;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
