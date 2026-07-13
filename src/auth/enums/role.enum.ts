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
