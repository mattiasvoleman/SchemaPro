import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Returns the caller's tenant id or fails with 403. Every school-scoped write
 * must resolve the tenant from the verified principal — never from the body.
 */
export function requireSchoolId(user: AuthenticatedUser): string {
  if (!user.schoolId) {
    throw new ForbiddenException('No school is associated with this account.');
  }
  return user.schoolId;
}
