import { ApiProperty } from '@nestjs/swagger';

import { UserDto } from '../../user/dtos/user.dto';

export class AuthTokenPayloadDto {
  @ApiProperty({ example: 3600 })
  expiresIn!: number;

  @ApiProperty()
  accessToken!: string;
}

export class AuthTokenDto {
  @ApiProperty({ type: UserDto })
  user!: UserDto;

  @ApiProperty({ type: AuthTokenPayloadDto })
  token!: AuthTokenPayloadDto;
}
