import type { AdminProfile } from '@prisma/client';
import type { AccessChannel } from '../../access-log/access-log';
import type { Role } from '../enums/role.enum';
import type { HuvudmanReader } from '../huvudman-reader';
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
  /**
   * Tenant id: the school of the Users row this request is (Flera skolor per
   * inloggning: a login has one row per school, and the request names one
   * with X-School-Id, src/auth/school-choice.ts). PrismaService.withRls names
   * it to the database in every transaction, so RLS answers for this row.
   */
  schoolId?: string;
  /**
   * The schools the access-token hook closed for this session
   * (rastra_closed_schools: {schoolId: reason}), forwarded to the database
   * in the claims. Absent when the token closes none.
   */
  closedSchools?: Readonly<Record<string, string>>;
  /**
   * A SCHOOL_ADMIN's profile, read from Users with the role (Roller i
   * skolan). Which areas it writes is src/auth/admin-areas.ts; RolesGuard
   * holds a route's @Area to it. Absent for every other role.
   */
  adminProfile?: AdminProfile;
  /** HR-läs: may read tjänst % and nedsättning (with a deciding profile). */
  hrRead?: boolean;
  /**
   * The school account this session signed in with, when it signed in with
   * one and nothing else (src/auth/school-account.ts). Read from metadata the
   * person can rewrite, so it is a self-lockout check and never a permission.
   */
  schoolAccount?: SchoolAccountSession;
  /**
   * Huvudman (20261212090000): set exactly when this request is the
   * huvudman's reader at schoolId, a member of the huvudman that owns the
   * school with no row of the login's own there. role is then SCHOOL_ADMIN,
   * adminProfile LASARE, hrRead false and userId absent, as the database
   * answers (app.current_user_id() is NULL for the reader). RolesGuard
   * refuses every write but the huvudman's own routes.
   */
  huvudman?: HuvudmanReader;
  /**
   * Huvudman: whether the token carries the login's mark as a huvudman's
   * member (app_metadata.rastraHuvudman), which the web asks for the
   * huvudman's pages by. Set on the HUVUDMAN principal only; one without it
   * is marked on its next read of /api/v1/huvudman.
   */
  huvudmanMarked?: boolean;
  /**
   * The client the request came through: APP (X-SchemaPro-Client: app), WEB
   * (a browser's Origin) or OTHER (src/access-log). Set by JwtAuthGuard; read
   * only by the läslogg (recordRead), never a permission.
   */
  channel?: AccessChannel;
}
