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

/**
 * Returns the caller's internal user id or fails with 403. `userId` is only
 * there "when present in the token", and a write that records the acting user
 * in a required column — a reporter, a requester, a booker — cannot be made
 * without one. Asked here, that is an answer; left to the insert, it is a
 * Prisma runtime error and a 500.
 */
export function requireUserId(user: AuthenticatedUser): string {
  if (!user.userId) {
    throw new ForbiddenException('No user identity is associated with this account.');
  }
  return user.userId;
}
