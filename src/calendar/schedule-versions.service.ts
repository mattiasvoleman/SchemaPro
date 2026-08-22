import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';

/**
 * One lesson inside a version snapshot (times as `HH:MM`, dates as
 * `YYYY-MM-DD`).
 */
export interface VersionLesson {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isLocked: boolean;
  /**
   * Absent is read as ALL_WEEKS, the same reading `RecurrenceWindow` gives it.
   *
   * Snapshots written before this field was carried have no such key, and no
   * migration can repair them: the blob is the only copy, and the master
   * lessons it was taken from have since been edited or restored over. Those
   * restores already produced ALL_WEEKS, because that is the column default —
   * so reading an absent key that way keeps an old snapshot restoring exactly
   * as it always did, rather than failing on it.
   */
  recurrence?: LessonRecurrence;
  /** Absent or null means "from the start of the academic year". */
  startDate?: string | null;
  /** Absent or null means "until the year ends". */
  endDate?: string | null;
  extraGroupIds?: string[];
  studentIds?: string[];
}

export interface ScheduleVersionSummary {
  id: string;
  academicYearId: string;
  name: string;
  lessonCount: number;
  createdAt: string;
}

/**
 * Named snapshots of the master timetable. A snapshot copies every master
 * lesson of the academic year into a JSON blob; restoring replaces the live
 * timetable with the snapshot (and is itself preceded by an automatic
 * safety snapshot, so a restore can always be reverted).
 */
@Injectable()
export class ScheduleVersionsService {
  private readonly logger = new Logger(ScheduleVersionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary[]> {
    return this.prisma.withRls(user, async (tx) => {
      const versions = await tx.scheduleVersion.findMany({
        where: { academicYearId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          lessonCount: true,
          createdAt: true,
        },
      });
      return versions.map((version) => ({
        ...version,
        createdAt: version.createdAt.toISOString(),
      }));
    });
  }

  async create(
    academicYearId: string,
    name: string,
    user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary> {
    return this.prisma.withRls(user, (tx) =>
      this.snapshot(tx, academicYearId, name, user),
    );
  }

  async get(
    versionId: string,
    user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary & { lessons: VersionLesson[] }> {
    return this.prisma.withRls(user, async (tx) => {
      const version = await tx.scheduleVersion.findUnique({
        where: { id: versionId },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          lessonCount: true,
          createdAt: true,
          lessons: true,
        },
      });
      if (!version) {
        throw new NotFoundException('Schedule version not found.');
      }
      return {
        id: version.id,
        academicYearId: version.academicYearId,
        name: version.name,
        lessonCount: version.lessonCount,
        createdAt: version.createdAt.toISOString(),
        lessons: version.lessons as unknown as VersionLesson[],
      };
    });
  }

  async restore(
    versionId: string,
    user: AuthenticatedUser,
  ): Promise<{ restoredLessons: number; safetyVersionId: string }> {
    return this.prisma.withRls(user, async (tx) => {
      const version = await tx.scheduleVersion.findUnique({
        where: { id: versionId },
        select: {
          id: true,
          schoolId: true,
          academicYearId: true,
          name: true,
          lessons: true,
        },
      });
      if (!version) {
        throw new NotFoundException('Schedule version not found.');
      }

      // Safety net: snapshot the current timetable before replacing it.
      const safety = await this.snapshot(
        tx,
        version.academicYearId,
        `Before restore of "${version.name}"`,
        user,
      );

      const lessons = version.lessons as unknown as VersionLesson[];
      if (!Array.isArray(lessons)) {
        throw new BadRequestException('Version snapshot is malformed.');
      }

      await tx.masterLesson.deleteMany({
        where: { academicYearId: version.academicYearId },
      });
      for (const lesson of lessons) {
        await tx.masterLesson.create({
          data: {
            schoolId: version.schoolId,
            academicYearId: version.academicYearId,
            subjectId: lesson.subjectId,
            studentGroupId: lesson.studentGroupId,
            teacherId: lesson.teacherId,
            coTeacherId: lesson.coTeacherId ?? null,
            roomId: lesson.roomId,
            dayOfWeek: lesson.dayOfWeek,
            startTime: parseHHMM(lesson.startTime),
            endTime: parseHHMM(lesson.endTime),
            isLocked: lesson.isLocked,
            recurrence: lesson.recurrence ?? 'ALL_WEEKS',
            startDate: parseDateOrNull(lesson.startDate),
            endDate: parseDateOrNull(lesson.endDate),
            extraGroups: {
              create: (lesson.extraGroupIds ?? []).map((studentGroupId) => ({
                schoolId: version.schoolId,
                studentGroupId,
              })),
            },
            participants: {
              create: (lesson.studentIds ?? []).map((studentId) => ({
                schoolId: version.schoolId,
                studentId,
              })),
            },
          },
        });
      }

      await tx.scheduleChangeLog.create({
        data: {
          schoolId: version.schoolId,
          academicYearId: version.academicYearId,
          actorId: user.userId ?? null,
          action: 'RESTORE',
          after: {
            versionId: version.id,
            versionName: version.name,
            restoredLessons: lessons.length,
            safetyVersionId: safety.id,
          },
        },
      });

      this.logger.log(
        `Schedule version restored [version=${versionId}, lessons=${lessons.length}]`,
      );

      return { restoredLessons: lessons.length, safetyVersionId: safety.id };
    });
  }

  async remove(versionId: string, user: AuthenticatedUser): Promise<{ id: string }> {
    return this.prisma.withRls(user, async (tx) => {
      const version = await tx.scheduleVersion.findUnique({
        where: { id: versionId },
        select: { id: true },
      });
      if (!version) {
        throw new NotFoundException('Schedule version not found.');
      }
      await tx.scheduleVersion.delete({ where: { id: versionId } });
      return { id: versionId };
    });
  }

  // ---------------------------------------------------------------------

  private async snapshot(
    tx: PrismaClient,
    academicYearId: string,
    name: string,
    user: AuthenticatedUser,
  ): Promise<ScheduleVersionSummary> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { id: true, schoolId: true },
    });
    if (!year) {
      throw new NotFoundException('Academic year not found.');
    }

    const lessons = await tx.masterLesson.findMany({
      where: { academicYearId },
      select: {
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        isLocked: true,
        recurrence: true,
        startDate: true,
        endDate: true,
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });

    const snapshotLessons: VersionLesson[] = lessons.map((lesson) => ({
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      teacherId: lesson.teacherId,
      coTeacherId: lesson.coTeacherId,
      roomId: lesson.roomId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: toHHMM(lesson.startTime),
      endTime: toHHMM(lesson.endTime),
      isLocked: lesson.isLocked,
      recurrence: lesson.recurrence,
      startDate: toDateStringOrNull(lesson.startDate),
      endDate: toDateStringOrNull(lesson.endDate),
      extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
      studentIds: lesson.participants.map((entry) => entry.studentId),
    }));

    const created = await tx.scheduleVersion.create({
      data: {
        schoolId: year.schoolId,
        academicYearId,
        name,
        createdById: user.userId ?? null,
        lessons: snapshotLessons as unknown as Prisma.InputJsonValue,
        lessonCount: snapshotLessons.length,
      },
      select: {
        id: true,
        academicYearId: true,
        name: true,
        lessonCount: true,
        createdAt: true,
      },
    });

    this.logger.log(
      `Schedule version saved [version=${created.id}, lessons=${created.lessonCount}]`,
    );

    return { ...created, createdAt: created.createdAt.toISOString() };
  }
}

// ---------------------------------------------------------------------------

function toHHMM(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function parseHHMM(value: string): Date {
  const [h, m] = value.split(':').map(Number);
  const d = new Date(0);
  d.setUTCHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

function toDateStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * `YYYY-MM-DD` back to the midnight-UTC value a `@db.Date` column holds.
 *
 * The slice keeps a full ISO timestamp readable too: the blob is the only
 * copy of a snapshot, so restoring must not turn on how a date was spelled.
 */
function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}
