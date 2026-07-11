/**
 * The verified JWT payload.
 *
 * The application role, tenant (`schoolId`) and internal `userId` are ALWAYS
 * resolved from the `Users` table by the verified `sub` claim — they are never
 * trusted from the token body. The only exception is the cross-tenant
 * `SYSTEM_ADMIN` platform role, which by design has no `Users` row and is
 * honoured solely from an explicit, verified `role` claim (it grants no
 * implicit RLS data access).
 *
 * `sub` is the immutable subject claim and MUST equal `Users.authId` — this is
 * exactly what the database `auth.uid()` helper reads to evaluate RLS.
 */
export interface JwtPayload {
  /** Subject — matches `Users.authId` (a.k.a. `auth.uid()`). */
  sub: string;
  /** Role claim — an application `Role` or a Supabase role string. */
  role?: string;
  /** The caller's tenant (school) id. Absent in Supabase tokens. */
  schoolId?: string;
  /** The caller's internal `Users.id`. Absent in Supabase tokens. */
  userId?: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
}
