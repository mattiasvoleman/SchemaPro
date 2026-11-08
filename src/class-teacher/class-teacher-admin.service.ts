import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { parseTimeString, toWallClock } from '../common/utils/time';
import { ClassTeacherEngine, toChangeView } from './class-teacher-engine';
import { rethrowClassTeacherError } from './class-teacher-errors';
import { CODES, type ChangeView, type PublishOutcome, type Verdict } from './class-teacher.types';
import type { AppointDto, ClassTeacherSettingsDto, OpenTimesDto } from './dto/class-teacher.dto';

export interface AppointmentView {
  id: string;
  academicYearId: string;
  studentGroupId: string;
  className: string;
  userId: string;
  teacherName: string;
  appointedByUserId: string | null;
  /** Whether the appointment still runs: the administrator it runs as is active and writes what the work needs. */
  runs: boolean;
}

export interface OpenTimeView {
  id: string;
  academicYearId: string;
  studentGroupId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface DraftRowView {
  change: ChangeView;
  className: string;
  authorName: string | null;
  subjectName: string | null;
  verdict: Verdict;
}

/** Touching or overlapping spans of one day made one, so an hour that two rows hold between them is open (the database asks for one span). */
export function mergeSpans(spans: ReadonlyArray<{ dayOfWeek: number; startTime: string; endTime: string }>): Array<{ dayOfWeek: number; startTime: string; endTime: string }> {
  const sorted = [...spans].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  const out: Array<{ dayOfWeek: number; startTime: string; endTime: string }> = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && last.dayOfWeek === span.dayOfWeek && span.startTime <= last.endTime) {
      if (span.endTime > last.endTime) last.endTime = span.endTime;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Klasslärarens schema, the schemaläggare's side: who is klasslärare of which
 * class, which hours are open to them, whether they publish for themselves,
 * and the drafts waiting to be published or thrown away.
 */
@Injectable()
export class ClassTeacherAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ClassTeacherEngine,
  ) {}

  async appointments(academicYearId: string, user: AuthenticatedUser): Promise<AppointmentView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.classTeacherAppointment.findMany({ where: { academicYearId }, orderBy: { createdAt: 'asc' } });
      const groups = await tx.studentGroup.findMany({ where: { id: { in: rows.map((row) => row.studentGroupId) } }, select: { id: true, name: true } });
      const people = await tx.user.findMany({
        where: { id: { in: rows.flatMap((row) => [row.userId, ...(row.appointedByUserId ? [row.appointedByUserId] : [])]) } },
        select: { id: true, firstName: true, lastName: true, role: true, isActive: true, adminProfile: true },
      });
      const groupName = new Map(groups.map((row) => [row.id, row.name]));
      const person = new Map(people.map((row) => [row.id, row]));
      return rows
        .map((row) => {
          const appointer = row.appointedByUserId ? person.get(row.appointedByUserId) : undefined;
          const teacher = person.get(row.userId);
          return {
            id: row.id,
            academicYearId: row.academicYearId,
            studentGroupId: row.studentGroupId,
            className: groupName.get(row.studentGroupId) ?? '',
            userId: row.userId,
            teacherName: teacher ? `${teacher.firstName} ${teacher.lastName}` : '',
            appointedByUserId: row.appointedByUserId,
            runs:
              appointer !== undefined &&
              appointer.role === 'SCHOOL_ADMIN' &&
              appointer.isActive &&
              (appointer.adminProfile === 'FULL' || appointer.adminProfile === 'REKTOR' || appointer.adminProfile === 'SCHEMALAGGARE'),
          };
        })
        .sort((a, b) => a.className.localeCompare(b.className, 'sv') || a.teacherName.localeCompare(b.teacherName, 'sv'));
    });
  }

  /** Appoints, or takes over: the one who writes is the one the appointment runs as. */
  async appoint(dto: AppointDto, user: AuthenticatedUser): Promise<AppointmentView[]> {
    const schoolId = requireSchoolId(user);
    try {
      const academicYearId = await this.prisma.withRls(user, async (tx) => {
        const group = await tx.studentGroup.findUnique({ where: { id: dto.studentGroupId }, select: { academicYearId: true } });
        if (!group) throw new NotFoundException({ message: 'Klassen finns inte.', code: CODES.GONE });
        const existing = await tx.classTeacherAppointment.findFirst({ where: { studentGroupId: dto.studentGroupId, userId: dto.userId }, select: { id: true } });
        if (existing) {
          await tx.classTeacherAppointment.update({ where: { id: existing.id }, data: { appointedByUserId: user.userId ?? null } });
        } else {
          await tx.classTeacherAppointment.create({
            data: { schoolId, academicYearId: group.academicYearId, studentGroupId: dto.studentGroupId, userId: dto.userId, appointedByUserId: user.userId ?? null },
          });
        }
        return group.academicYearId;
      });
      return await this.appointments(academicYearId, user);
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    const removed = await this.prisma.withRls(user, (tx) => tx.classTeacherAppointment.deleteMany({ where: { id } }));
    if (removed.count === 0) throw new NotFoundException({ message: 'Utnämningen finns inte.', code: CODES.GONE });
  }

  // ---------------------------------------------------------------------
  // Open times
  // ---------------------------------------------------------------------

  async openTimes(academicYearId: string, user: AuthenticatedUser): Promise<OpenTimeView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.classTeacherOpenTime.findMany({ where: { academicYearId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
      return rows.map((row) => ({
        id: row.id,
        academicYearId: row.academicYearId,
        studentGroupId: row.studentGroupId,
        dayOfWeek: row.dayOfWeek,
        startTime: toWallClock(row.startTime),
        endTime: toWallClock(row.endTime),
      }));
    });
  }

  /** Replaces the spans of one scope (a class's, or every class of the läsår's) whole. */
  async setOpenTimes(dto: OpenTimesDto, user: AuthenticatedUser): Promise<OpenTimeView[]> {
    const schoolId = requireSchoolId(user);
    for (const span of dto.spans) {
      if (span.startTime >= span.endTime) throw new ConflictException({ message: 'En öppen tid slutar efter att den börjar.', code: 'CLASS_TEACHER_INVALID' });
    }
    try {
      await this.prisma.withRls(user, async (tx) => {
        const scope = { academicYearId: dto.academicYearId, studentGroupId: dto.studentGroupId ?? null };
        await tx.classTeacherOpenTime.deleteMany({ where: scope });
        const merged = mergeSpans(dto.spans);
        if (merged.length > 0) {
          await tx.classTeacherOpenTime.createMany({
            data: merged.map((span) => ({
              schoolId,
              academicYearId: dto.academicYearId,
              studentGroupId: dto.studentGroupId ?? null,
              dayOfWeek: span.dayOfWeek,
              startTime: parseTimeString(span.startTime),
              endTime: parseTimeString(span.endTime),
            })),
          });
        }
      });
      return await this.openTimes(dto.academicYearId, user);
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  // ---------------------------------------------------------------------
  // The option
  // ---------------------------------------------------------------------

  async settings(user: AuthenticatedUser): Promise<{ selfPublish: boolean }> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) => tx.classTeacherSettings.findUnique({ where: { schoolId } }));
    return { selfPublish: row?.selfPublish ?? false };
  }

  async updateSettings(dto: ClassTeacherSettingsDto, user: AuthenticatedUser): Promise<{ selfPublish: boolean }> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.classTeacherSettings.upsert({
        where: { schoolId },
        create: { schoolId, selfPublish: dto.selfPublish },
        update: { selfPublish: dto.selfPublish },
      }),
    );
    return { selfPublish: row.selfPublish };
  }

  // ---------------------------------------------------------------------
  // The drafts
  // ---------------------------------------------------------------------

  /** The waiting drafts, each judged as publication would judge it. */
  async drafts(studentGroupId: string | undefined, user: AuthenticatedUser): Promise<DraftRowView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.classTeacherChange.findMany({
        where: { status: 'DRAFT', ...(studentGroupId ? { studentGroupId } : {}) },
        orderBy: [{ studentGroupId: 'asc' }, { createdAt: 'asc' }],
      });
      const groups = await tx.studentGroup.findMany({ where: { id: { in: rows.map((row) => row.studentGroupId) } }, select: { id: true, name: true } });
      const authors = await tx.user.findMany({
        where: { id: { in: rows.flatMap((row) => (row.authorId ? [row.authorId] : [])) } },
        select: { id: true, firstName: true, lastName: true },
      });
      const calendar = await tx.calendarLesson.findMany({
        where: { id: { in: rows.flatMap((row) => (row.calendarLessonId ? [row.calendarLessonId] : [])) } },
        select: { id: true, subject: { select: { name: true } } },
      });
      const master = await tx.masterLesson.findMany({
        where: { id: { in: rows.flatMap((row) => (row.masterLessonId ? [row.masterLessonId] : [])) } },
        select: { id: true, subject: { select: { name: true } } },
      });
      const groupName = new Map(groups.map((row) => [row.id, row.name]));
      const author = new Map(authors.map((row) => [row.id, `${row.firstName} ${row.lastName}`]));
      const subject = new Map<string, string>([...calendar, ...master].map((row) => [row.id, row.subject.name]));
      const out: DraftRowView[] = [];
      for (const row of rows) {
        out.push({
          change: toChangeView(row),
          className: groupName.get(row.studentGroupId) ?? '',
          authorName: row.authorId ? (author.get(row.authorId) ?? null) : null,
          subjectName: subject.get((row.calendarLessonId ?? row.masterLessonId) ?? '') ?? null,
          verdict: await this.engine.evaluate(tx, row),
        });
      }
      return out;
    });
  }

  async discard(id: string, user: AuthenticatedUser): Promise<void> {
    const removed = await this.prisma.withRls(user, (tx) => tx.classTeacherChange.deleteMany({ where: { id, status: 'DRAFT' } }));
    if (removed.count === 0) throw new NotFoundException({ message: 'Utkastet finns inte.', code: CODES.GONE });
  }

  /** Publishes a class's waiting drafts as the administrator who asks (Publicering). */
  async publish(studentGroupId: string, changeIds: string[] | undefined, user: AuthenticatedUser): Promise<{ outcomes: PublishOutcome[] }> {
    try {
      return { outcomes: await this.engine.publishClass(user, studentGroupId, changeIds) };
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }
}

