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
 * Returns the caller's internal user id or fails with 403. A write that records
 * the acting user in a required column — a reporter, a requester, a booker —
 * cannot be made without one.
 *
 * No HTTP caller reaches such a write without one today. JwtStrategy resolves
 * userId from the Users row for every tenant role; only SYSTEM_ADMIN, who has
 * no row, carries whatever the token says, and every route that writes these
 * columns leaves SYSTEM_ADMIN out of its @Roles. This is defence in depth: the
 * invariant sits next to the write instead of depending on every route's role
 * list staying as it is, and a broken one becomes a refusal that names what is
 * missing rather than a Prisma error at the insert.
 */
export function requireUserId(user: AuthenticatedUser): string {
  if (!user.userId) {
    throw new ForbiddenException('No user identity is associated with this account.');
  }
  return user.userId;
}
