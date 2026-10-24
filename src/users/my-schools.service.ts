import { Injectable } from '@nestjs/common';
import type { AdminProfile, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';

/**
 * One of the signed-in login's schools, for the school switcher (Flera
 * skolor per inloggning, 20261204090000). The person's own rows only, and
 * only what the switcher shows: the school, the role there, and whether
 * this session may enter it.
 */
export interface MySchoolView {
  schoolId: string;
  schoolName: string;
  role: UserRole;
  /** The administrator's profile there; null for every other role. */
  adminProfile: AdminProfile | null;
  /**
   * Why this session may not enter the school, as the access-token hook
   * closed it (sso_required, sso_not_enabled, …); null when it may.
   */
  closed: string | null;
  /** Whether this request is about this school. */
  current: boolean;
}

interface MySchoolRow {
  school_id: string;
  school_name: string;
  role: UserRole;
  admin_profile: AdminProfile | null;
  closed_reason: string | null;
  is_current: boolean;
}

@Injectable()
export class MySchoolsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/v1/me/schools: the login's active rows, in the order it got them, read by
   * app.my_schools() under the caller's claims, so the closed schools and
   * the chosen one are the database's own answer.
   */
  async list(user: AuthenticatedUser): Promise<MySchoolView[]> {
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.$queryRaw<MySchoolRow[]>`
        SELECT school_id, school_name, role, admin_profile, closed_reason, is_current
          FROM app.my_schools()`,
    );
    return rows.map((row) => ({
      schoolId: row.school_id,
      schoolName: row.school_name,
      role: row.role,
      adminProfile: row.admin_profile,
      closed: row.closed_reason,
      current: row.is_current,
    }));
  }
}
