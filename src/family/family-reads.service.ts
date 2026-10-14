import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../access-log/access-log';
import { requireUserId } from '../common/utils/request-context';
import { parseDateString } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import type { AbsenceReportsQueryDto, GuardianLinksQueryDto } from './dto/family-reads.dto';

/** A guardian's child, as the family's pages list them: no contact details. */
export interface ChildView {
  linkId: string;
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  studentGroupId: string | null;
}

/** An absence report as PostgREST answered it: a bare date, wall clocks, the note. */
export interface AbsenceReportView {
  id: string;
  studentId: string;
  reportedById: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  type: string;
  note: string | null;
  createdAt: string;
}

export interface GuardianLinkView {
  id: string;
  guardianId: string;
  guardian: { id: string; firstName: string; lastName: string; email: string };
}

/** The newest this many: what the web and the app read directly before, each one at most. */
export const FAMILY_READ_LIMIT = 200;

const day = (value: Date) => value.toISOString().slice(0, 10);

/** A `@db.Time` column as PostgREST spelled it: "HH:MM:SS", read in UTC (see toWallClock). */
function clock(value: Date | null): string | null {
  if (!value) return null;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

/**
 * The family's reads (Läslogg): a guardian's children, absence reports, and
 * an administrator's view of a pupil's guardians. The leave requests are
 * LeaveService's (GET /api/v1/leave-requests), which records them the same
 * way. The web and the app read these straight from PostgREST until now;
 * every one of them names other people, so they come through here, where
 * each response is recorded in the read log in the same transaction
 * (recordRead).
 *
 * Row security decides what each role sees, as it did for the direct reads:
 * a guardian their linked children's rows, a pupil their own, the
 * administrator the school's. Nothing here filters by role on top of it,
 * except that a guardian's children are the guardian's own links.
 */
@Injectable()
export class FamilyReadsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/v1/family/children: the signed-in guardian's linked pupils. */
  async children(user: AuthenticatedUser): Promise<ChildView[]> {
    const guardianId = requireUserId(user);
    return this.prisma.withRls(user, async (tx) => {
      const links = await tx.guardianStudent.findMany({
        where: { guardianId },
        select: {
          id: true,
          student: { select: { id: true, firstName: true, lastName: true, isActive: true, studentGroupId: true } },
        },
        orderBy: { id: 'asc' },
      });
      const children = links.map((link) => ({ linkId: link.id, ...link.student }));
      await recordRead(tx, 'PEOPLE', children.map((child) => child.id), user.channel);
      return children;
    });
  }

  /** GET /api/v1/absence-reports: the reports row security shows the caller, newest day first. */
  async absenceReports(query: AbsenceReportsQueryDto, user: AuthenticatedUser): Promise<AbsenceReportView[]> {
    const date = query.date ? parseDateString(query.date) : undefined;
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.absenceReport.findMany({
        where: {
          ...(date ? { date } : {}),
          ...(query.studentId ? { studentId: query.studentId } : {}),
        },
        select: {
          id: true,
          studentId: true,
          reportedById: true,
          date: true,
          startTime: true,
          endTime: true,
          type: true,
          note: true,
          createdAt: true,
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: FAMILY_READ_LIMIT,
      });
      await recordRead(tx, 'ABSENCE_REPORTS', rows.map((row) => row.studentId), user.channel);
      return rows.map((row) => ({
        ...row,
        date: day(row.date),
        startTime: clock(row.startTime),
        endTime: clock(row.endTime),
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  /** GET /api/v1/guardian-links?studentId: a pupil's guardians, for the administrator's people page. */
  async guardianLinks(query: GuardianLinksQueryDto, user: AuthenticatedUser): Promise<GuardianLinkView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const links = await tx.guardianStudent.findMany({
        where: { studentId: query.studentId },
        select: {
          id: true,
          guardianId: true,
          guardian: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        orderBy: { id: 'asc' },
      });
      if (links.length > 0) {
        await recordRead(tx, 'GUARDIANS', [query.studentId, ...links.map((link) => link.guardianId)], user.channel);
      }
      return links;
    });
  }
}
