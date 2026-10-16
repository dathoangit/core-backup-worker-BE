import {
  applyDecorators,
  Param,
  ParseUUIDPipe,
  type PipeTransform,
  UseGuards,
} from '@nestjs/common';
import { type Type } from '@nestjs/common/interfaces';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { type StaffRole } from '../constants';
import { AuthGuard } from '../guards/auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { PublicRoute } from './public-route.decorator';
import { Roles } from './roles.decorator';

interface IAuthOptions {
  public?: boolean;
}

export function Auth(
  roles: StaffRole[] = [],
  options?: IAuthOptions,
): MethodDecorator {
  const isPublicOptionalRoute = options?.public === true;

  return applyDecorators(
    Roles(roles),
    UseGuards(AuthGuard({ public: isPublicOptionalRoute }), RolesGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Unauthorized' }),
    PublicRoute(isPublicOptionalRoute),
  );
}

export function UUIDParam(
  property: string,
  ...pipes: Array<Type<PipeTransform> | PipeTransform>
): ParameterDecorator {
  return Param(property, new ParseUUIDPipe({ version: '4' }), ...pipes);
}
