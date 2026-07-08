/**
 * The verified JWT payload.
 *
 * Two token flavours are accepted:
 *  1. Supabase Auth access tokens — `role` is the PostgREST role (usually
 *     `"authenticated"`); the application role is resolved from the `Users`
 *     table by `authId` (= `sub`).
 *  2. First-party service tokens — `role` carries an application `Role`
 *     directly, plus optional `userId` / `schoolId` convenience claims.
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
