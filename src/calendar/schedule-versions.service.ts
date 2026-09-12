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
  /**
   * Who owns the lesson: false is somebody's handiwork that regeneration must
   * leave standing, true is the optimizer's own output it may replace. Carried
   * through the snapshot rather than re-decided on the way out, because a
   * restore that stamped a fixed value would hand every lesson in the year to
   * the machine (or take every one from it) as a side effect of restoring.
   *
   * Absent is read as false, which is a choice about which way to be wrong on
   * snapshots stored before the field was carried. Read absent as true and an
   * old snapshot signs the whole year over to the optimizer, which deletes the
   * handmade lessons on its next run — and restoring the same version again
   * only feeds them back into the same shredder, since the blob still has no
   * key. Read as false it preserves too much instead: a generated lesson lives
   * on, in front of the administrator, who can see it and remove it. Same
   * direction the column's own default leans, for the same reason.
   *
   * Rejected: reproducing the migration's backfill here (ALL_WEEKS with no
   * dates = the machine's) so an old snapshot classifies exactly as the rows it
   * was taken from. Tempting, but it re-implements in a second place the guess
   * the column exists to abolish, and it demotes a lesson an admin placed by
   * hand after the migration — whose row plainly says false — the first time a
   * pre-change snapshot is restored over it.
   */
  isGenerated?: boolean;
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
      this.snapshotInTransaction(tx, academicYearId, name, user),
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
      const safety = await this.snapshotInTransaction(
        tx,
        version.academicYearId,
        `Before restore of "${version.name}"`,
        user,
      );

      const lessons = version.lessons as unknown as VersionLesson[];
      if (!Array.isArray(lessons)) {
        throw new BadRequestException('Version snapshot is malformed.');
      }

      // Every time is parsed before the wipe. A throw would roll the
      // transaction back either way; what parsing first buys is a 400 naming
      // the bad value while nothing has been deleted yet, instead of a Prisma
      // 500 from an Invalid Date somewhere in the middle of the inserts.
      const rows = lessons.map((lesson) => ({
        ...lesson,
        startTime: parseHHMM(lesson.startTime),
        endTime: parseHHMM(lesson.endTime),
      }));

      await tx.masterLesson.deleteMany({
        where: { academicYearId: version.academicYearId },
      });
      for (const lesson of rows) {
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
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            isLocked: lesson.isLocked,
            // See VersionLesson.isGenerated for why an absent key is false.
            isGenerated: lesson.isGenerated ?? false,
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

  /**
   * Snapshot the year inside a transaction the CALLER holds.
   *
   * Public for the writers that change the timetable wholesale and want the
   * safety copy to share their fate: the room optimisation takes one before it
   * moves anything, in its own transaction, so a refused apply leaves neither
   * a moved lesson nor a version describing a change that never happened. A
   * snapshot taken in a transaction of its own would survive the rollback and
   * list, under a name promising a room optimisation, a timetable identical to
   * the one in front of the school.
   *
   * The one copy of the snapshot rule — what a version holds, and how it is
   * spelled — so a second writer cannot store a version that restore() reads
   * differently.
   */
  async snapshotInTransaction(
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
        isGenerated: true,
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
      isGenerated: lesson.isGenerated,
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

/**
 * `HH:MM` back to the epoch-day Date a `@db.Time` column takes — strictly.
 *
 * Only snapshot() writes these strings, always through toHHMM, so anything
 * else means the blob was damaged, and a restore runs no clash check that
 * could catch a lesson landing somewhere it was never put. The split(':') this
 * replaces read "24:00" and "" as midnight without a word. Not
 * parseTimeString: that one takes request input, seconds and "99:99" included.
 */
function parseHHMM(value: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new BadRequestException(
      `Version snapshot contains an invalid time: "${value}".`,
    );
  }
  const d = new Date(0);
  d.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
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
