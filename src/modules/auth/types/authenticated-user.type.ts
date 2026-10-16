import { type StaffRole } from '../../../constants';

export interface IAuthenticatedUser {
  id: Uuid;
  email: string;
  role: StaffRole;
  isActive: boolean;
}
