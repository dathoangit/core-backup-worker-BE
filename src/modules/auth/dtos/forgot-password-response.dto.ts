import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordResponseDto {
  @ApiProperty({
    example:
      'If the account exists, a password reset instruction has been sent.',
  })
  message!: string;
}
