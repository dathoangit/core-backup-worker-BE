import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { StaffRole } from '../constants';
import { RolesGuard } from './roles.guard';

function createContext(role?: StaffRole): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows when no roles required', () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(createContext(StaffRole.NURSE))).toBe(true);
  });

  it('allows higher rank role', () => {
    const reflector = {
      get: jest.fn().mockReturnValue([StaffRole.DOCTOR]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(createContext(StaffRole.ADMIN))).toBe(true);
  });

  it('denies lower rank role', () => {
    const reflector = {
      get: jest.fn().mockReturnValue([StaffRole.DOCTOR]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(createContext(StaffRole.NURSE))).toThrow(
      ForbiddenException,
    );
  });
});
