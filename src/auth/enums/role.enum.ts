/**
 * Application roles used for RBAC at the API gateway.
 *
 * `SCHOOL_ADMIN`, `TEACHER` and `STUDENT` mirror the Prisma `UserRole` enum and
 * are also what the PostgreSQL RLS policies evaluate via `auth.role()`.
 *
 * `SYSTEM_ADMIN` is a *platform-level* role issued by the identity provider for
 * cross-tenant operators. It is intentionally NOT stored in the tenant `Users`
 * table, so it grants no implicit RLS data access — it only unlocks
 * administrative API routes guarded by `@Roles(Role.SYSTEM_ADMIN)`.
 */
export enum Role {
  SYSTEM_ADMIN = 'SYSTEM_ADMIN',
  /**
   * Huvudman (20261212090000): a login that is an active member of a
   * huvudman, at no school (none named, and no row of its own). The database
   * sees no principal for it; it reaches the huvudman's own routes and
   * /me, and every write elsewhere is refused (RolesGuard). At a school the
   * huvudman owns, the same login reads as SCHOOL_ADMIN with
   * AuthenticatedUser.huvudman set.
   */
  HUVUDMAN = 'HUVUDMAN',
  SCHOOL_ADMIN = 'SCHOOL_ADMIN',
  TEACHER = 'TEACHER',
  STUDENT = 'STUDENT',
  GUARDIAN = 'GUARDIAN',
}

export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' &&
    (Object.values(Role) as string[]).includes(value)
  );
}
