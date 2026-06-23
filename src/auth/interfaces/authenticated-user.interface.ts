import type { Role } from '../enums/role.enum';

/**
 * The normalized principal attached to `request.user` after JWT verification.
 * This is the object passed to `PrismaService.withRls(...)` so that the correct
 * `request.jwt.claims` are injected into the PostgreSQL session for every query.
 */
export interface AuthenticatedUser {
  /** Subject claim — equals `Users.authId` / `auth.uid()`. Drives RLS. */
  authId: string;
  /** The caller's role — equals `auth.role()`. */
  role: Role;
  /** Internal `Users.id`, when present in the token. */
  userId?: string;
  /** Tenant id, when present in the token. */
  schoolId?: string;
}
