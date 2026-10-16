import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Auth, UUIDParam } from '../../decorators';
import { CreateAdminUserDto } from './dtos/create-admin-user.dto';
import { UpdateAdminUserDto } from './dtos/update-admin-user.dto';
import { UserDto } from './dtos/user.dto';
import { UserService } from './user.service';

@ApiTags('admin-users')
@Controller('admin')
export class UserAdminController {
  constructor(private readonly userService: UserService) {}

  @Get('users')
  @Auth()
  @ApiOkResponse({ type: UserDto, isArray: true })
  async getUsers(): Promise<UserDto[]> {
    const users = await this.userService.findAllUsers();

    return users.map((user) => user.toDto());
  }

  @Post('users')
  @Auth()
  @ApiCreatedResponse({ type: UserDto })
  async createUser(@Body() dto: CreateAdminUserDto): Promise<UserDto> {
    const user = await this.userService.createUserWithPlainPassword({
      username: dto.username,
      email: dto.email,
      password: dto.password,
      role: dto.role,
      isActive: dto.isActive,
    });

    return user.toDto();
  }

  @Patch('users/:id')
  @Auth()
  @ApiOkResponse({ type: UserDto })
  async updateUser(
    @UUIDParam('id') userId: Uuid,
    @Body() dto: UpdateAdminUserDto,
  ): Promise<UserDto> {
    const user = await this.userService.updateUser(userId, {
      username: dto.username,
      email: dto.email,
      password: dto.password,
      role: dto.role,
      isActive: dto.isActive,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user.toDto();
  }

  @Delete('users/:id')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateUser(@UUIDParam('id') userId: Uuid): Promise<void> {
    const user = await this.userService.deactivateUser(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }
  }
}
