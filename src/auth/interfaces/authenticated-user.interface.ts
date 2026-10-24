import type { AdminProfile } from '@prisma/client';
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
   * The client the request came through: APP (X-SchemaPro-Client: app), WEB
   * (a browser's Origin) or OTHER (src/access-log). Set by JwtAuthGuard; read
   * only by the läslogg (recordRead), never a permission.
   */
  channel?: AccessChannel;
}
