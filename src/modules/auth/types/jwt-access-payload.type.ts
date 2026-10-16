import { type TokenType, type StaffRole } from '../../../constants';

export interface IJwtAccessPayload {
  sub: Uuid;
  type: TokenType;
  role: StaffRole;
  sessionId: string;
  email?: string | null;
}
