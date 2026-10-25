import { Injectable } from '@nestjs/common';
import type { AdminProfile, HuvudmanRole, UserRole } from '@prisma/client';
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
  /**
   * Huvudman (20261212090000): set when the login reads this school as its
   * huvudman's läsare, with no row of its own there (role SCHOOL_ADMIN,
   * adminProfile LASARE). The member's own name, which the web shows as the
   * person signed in. Null for the login's own rows.
   */
  huvudman: { id: string; name: string; role: HuvudmanRole; memberId: string; firstName: string; lastName: string } | null;
}

interface MySchoolRow {
  school_id: string;
  school_name: string;
  role: UserRole;
  admin_profile: AdminProfile | null;
  closed_reason: string | null;
  is_current: boolean;
  huvudman_member_id: string | null;
  huvudman_name: string | null;
  huvudman_role: HuvudmanRole | null;
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
        SELECT school_id, school_name, role, admin_profile, closed_reason, is_current,
               huvudman_member_id, huvudman_name, huvudman_role
          FROM app.my_schools()`,
    );
    // The memberships, for the huvudman's id and the member's own name:
    // asked only for a login that reads a school as a huvudman's, so every
    // other login's list is the one statement it was.
    const memberIds = [...new Set(rows.flatMap((row) => (row.huvudman_member_id ? [row.huvudman_member_id] : [])))];
    const members =
      memberIds.length > 0
        ? await this.prisma.queryWithRls(user, (db) =>
            db.huvudmanMember.findMany({
              where: { id: { in: memberIds } },
              select: { id: true, huvudmanId: true, firstName: true, lastName: true },
            }),
          )
        : [];
    const memberOf = new Map(members.map((member) => [member.id, member]));
    return rows.map((row) => {
      const member = row.huvudman_member_id ? memberOf.get(row.huvudman_member_id) : undefined;
      return {
        schoolId: row.school_id,
        schoolName: row.school_name,
        role: row.role,
        adminProfile: row.admin_profile,
        closed: row.closed_reason,
        current: row.is_current,
        huvudman:
          member && row.huvudman_name && row.huvudman_role
            ? {
                id: member.huvudmanId,
                name: row.huvudman_name,
                role: row.huvudman_role,
                memberId: member.id,
                firstName: member.firstName,
                lastName: member.lastName,
              }
            : null,
      };
    });
  }
}
