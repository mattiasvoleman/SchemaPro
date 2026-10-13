import type { AccessChannel } from '../../access-log/access-log';
import type { Role } from '../enums/role.enum';
import type { SchoolAccountSession } from '../school-account';

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
  /**
   * The school account this session signed in with, when it signed in with
   * one and nothing else (src/auth/school-account.ts). Read from metadata the
   * person can rewrite, so it is a self-lockout check and never a permission.
   */
  schoolAccount?: SchoolAccountSession;
  /**
   * The client the request came through: APP (X-SchemaPro-Client: app), WEB
   * (a browser's Origin) or OTHER (src/access-log). Set by JwtAuthGuard; read
   * only by the läslogg (recordRead), never a permission.
   */
  channel?: AccessChannel;
}
