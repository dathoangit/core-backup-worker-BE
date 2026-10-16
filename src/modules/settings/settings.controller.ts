import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../decorators';
import {
  CreateSettingDto,
  SettingResponseDto,
  UpdateSettingDto,
} from './dtos/setting.dto';
import type { SettingCategory } from './settings.constants';
import { SettingsService } from './settings.service';

@Controller('admin/settings')
@ApiTags('admin/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Auth()
  @ApiOkResponse({ type: SettingResponseDto, isArray: true })
  list(@Query('category') category?: SettingCategory) {
    return this.settingsService.list(category);
  }

  @Get(':key')
  @Auth()
  @ApiOkResponse({ type: SettingResponseDto })
  getOne(@Param('key') key: string) {
    return this.settingsService.getOne(key);
  }

  @Post()
  @Auth()
  @ApiOkResponse({ type: SettingResponseDto })
  create(@Body() dto: CreateSettingDto) {
    return this.settingsService.create(dto);
  }

  @Put(':key')
  @Auth()
  @ApiOkResponse({ type: SettingResponseDto })
  update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    return this.settingsService.update(key, dto);
  }

  @Delete(':key')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('key') key: string): Promise<void> {
    await this.settingsService.remove(key);
  }
}
