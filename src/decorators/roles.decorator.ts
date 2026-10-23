import { Reflector } from '@nestjs/core';

import { type StaffRole } from '../constants';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const Roles = Reflector.createDecorator<StaffRole[]>();
