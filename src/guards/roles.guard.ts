import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import _ from 'lodash';

import { StaffRole } from '../constants';

const ROLE_RANK: Readonly<Record<StaffRole, number>> = {
  [StaffRole.NURSE]: 1,
  [StaffRole.DOCTOR]: 2,
  [StaffRole.ADMIN]: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get<StaffRole[]>(
      'roles',
      context.getHandler(),
    );

    if (_.isEmpty(roles)) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { role?: StaffRole } }>();
    const role = request.user?.role;

    if (!role) {
      throw new ForbiddenException('Missing role');
    }

    const requiredRank = Math.min(
      ...roles.map((requiredRole) => ROLE_RANK[requiredRole]),
    );

    if (ROLE_RANK[role] >= requiredRank) {
      return true;
    }

    throw new ForbiddenException('Insufficient role');
  }
}
