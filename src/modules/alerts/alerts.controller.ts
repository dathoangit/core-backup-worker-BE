import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Auth } from '../../decorators';
import { AlertService } from './alert.service';

@Controller('admin/alerts')
@ApiTags('admin/alerts')
export class AlertsController {
  constructor(private readonly alertService: AlertService) {}

  @Post('test')
  @Auth()
  @HttpCode(HttpStatus.OK)
  test(@Query('channel') channelRaw?: string) {
    const channel =
      channelRaw === 'email'
        ? 'email'
        : channelRaw === 'telegram'
          ? 'telegram'
          : null;

    if (!channel) {
      throw new BadRequestException('channel must be telegram or email');
    }

    return this.alertService.sendTest(channel);
  }
}
