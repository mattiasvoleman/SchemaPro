import type { Role } from '../enums/role.enum';

/**
 * The verified JWT payload minted by the identity provider.
 *
 * `sub` is the immutable subject claim and MUST equal `Users.authId` — this is
 * exactly what the database `auth.uid()` helper reads to evaluate RLS.
 */
export interface JwtPayload {
  /** Subject — matches `Users.authId` (a.k.a. `auth.uid()`). */
  sub: string;
  /** The caller's role claim — matches `auth.role()`. */
  role: Role;
  /** The caller's tenant (school) id. Absent for `SYSTEM_ADMIN`. */
  schoolId?: string;
  /** The caller's internal `Users.id` (convenience claim). */
  userId?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
}
