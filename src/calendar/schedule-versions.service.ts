import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { todayInZone } from '../common/utils/time';
import { schoolTimezone } from '../cover/cover-context';
import { requireDirectReachAnswered } from '../publication/direct-reach';
import { enterGrundschemaWrite, isLockTimeout, type PublishMode } from '../publication/publish-mode';
import { lockYearForRegeneration, scheduleBusy, SCHEDULE_BUSY } from '../optimization/regeneration-lock';
import { exemptionsOf } from './lesson-exemption';
import {
  countSweep,
  lockYearLessons,
  pairTemplates,
  relinkCalendarRows,
  sweepCalendarRows,
  yearHasCalendarRows,
  type TemplateFields,
} from './restore-calendar';

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
  /**
   * Förlagda poster: Generera wrote it from a förläggning on its timplanspost
   * (MasterLesson.fromPlacement), locked, and the next Generera writes it
   * again. Carried so a restore puts it back as such: dropped, it came back as
   * an ordinary lock beside its förläggning, and every Generera of the school
   * was refused for a clash with itself (review of #293, MEDEL-2). Absent is
   * false, which for a snapshot from before the field is the truth: no
   * förläggning existed yet.
   */
  fromPlacement?: boolean;
  /**
   * Set aside on the tray: occupies nothing, and its day and time are only a
   * memory of where it was. Carried because a restore that dropped it put
   * every parked lesson back at that remembered slot — which by then may
   * belong to another lesson, since freeing it is what parking is for — and
   * a restore runs no clash check to stop it.
   *
   * Absent is read as false. For a snapshot stored before the tray existed
   * (3ddc70d) that is not a guess but the truth: no lesson could be parked
   * yet. Snapshots stored since, and before this field was carried, lost the
   * flag on whichever lessons were on the tray when they were taken, and
   * nothing can say which those were — the blob is the only copy. For them
   * false is still the side to be wrong on: an un-parked lesson lands on the
   * grid, where a clash it makes is shown and it can be lifted back. Read
   * absent as true and an old snapshot restores the whole year onto the tray
   * — nothing to publish, nothing fixed for the solver, an empty SS12000
   * feed — to recover the few lessons that were set aside at the time.
   *
   * Rejected: re-parking, on restore, an absent-key lesson whose remembered
   * slot clashes with the rest of the snapshot. That guesses the flag from a
   * symptom, in a path with no clash check of its own to borrow, and the
   * administrator — not the restore — knows whether the lesson was set aside.
   */
  isParked?: boolean;
  /**
   * Undantag med flit: the rules of the board the lesson stands against on purpose (`FRAME`, `LUNCH`). Carried so a restore puts the lesson
   * back as the exemption it was, locked as it stands in the snapshot: dropped, the lesson came back outside its ramtid with nothing to say why
   * and the next hand edit of it was refused. Said only on a lesson that has one, so a snapshot of a school with none is the blob it always was;
   * absent is none, which for a snapshot from before the column is the truth.
   */
  exemptFrom?: string[];
  /** Absent or null means "from the start of the academic year". */
  startDate?: string | null;
  /** Absent or null means "until the year ends". */
  endDate?: string | null;
  extraGroupIds?: string[];
  studentIds?: string[];
}

/**
 * What a restore did to the published calendar (Direkt only; absent when the year had no calendar rows to carry, and in Utkast, where the
 * published rows stay until a publication settles them): the rows that went with their lesson to the restored one, the rows taken off the
 * calendar, and how many of those somebody had worked on by hand. restore-calendar.ts says why.
 */
export type RestoredCalendar = {
  kept: number;
  removed: number;
  handChanged: number;
};

/** A version's lesson with its two clocks parsed, as the restore writes it. */
type RestoreRow = Omit<VersionLesson, 'startTime' | 'endTime'> & { startTime: Date; endTime: Date };

export interface RestoreResult {
  restoredLessons: number;
  safetyVersionId: string;
  calendar?: RestoredCalendar;
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
    const versions = await this.prisma.queryWithRls(user, (db) =>
      db.scheduleVersion.findMany({
        where: { academicYearId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          lessonCount: true,
          createdAt: true,
        },
      }),
    );
    return versions.map((version) => ({
      ...version,
      createdAt: version.createdAt.toISOString(),
    }));
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

  async restore(versionId: string, user: AuthenticatedUser): Promise<RestoreResult> {
    return this.prisma.withRls(user, async (tx) => {
      // The publication lock and the mode, first (publish-mode.ts). In DRAFT the
      // delete below records the published rows of the replaced masters for the
      // next publish, and the restore writes no calendar row. In DIRECT it
      // carries the restore to the calendar itself (restore-calendar.ts).
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
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

      // The year's regeneration lock, second, as Generera's persist and a
      // schemaförslag apply take it (optimization/regeneration-lock.ts). A
      // restore replaces the whole year: run beside an apply, its delete
      // skipped the rows the apply was inserting and then recreated the
      // version on top of them, and both commits stood. Queued for 5 s, then
      // 409 SCHEDULE_BUSY with nothing written. The version is read first only
      // because it is what names the year; versions are never edited.
      await lockYearForRegeneration(tx, version.academicYearId, SCHEDULE_BUSY);
      try {
        return await this.replaceWithVersion(tx, version, user, mode);
      } catch (error) {
        // The 5 s holds for the rest of the transaction; a row a hand edit
        // holds past it is the same answer.
        if (isLockTimeout(error)) throw scheduleBusy(SCHEDULE_BUSY);
        throw error;
      }
    });
  }

  /** The body of restore(), under its locks. */
  private async replaceWithVersion(
    tx: PrismaClient,
    version: { id: string; schoolId: string; academicYearId: string; name: string; lessons: Prisma.JsonValue },
    user: AuthenticatedUser,
    mode: PublishMode,
  ): Promise<RestoreResult> {
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
    // transaction back either way; what parsing first buys is that a damaged
    // snapshot is refused while nothing has been deleted yet, instead of
    // somewhere in the middle of the inserts — where the old parser's
    // Invalid Date met Prisma's own validation and came back as the filter's
    // anonymous 400, and a missing key as a TypeError and a 500.
    const rows = lessons.map((lesson) => ({
      ...lesson,
      startTime: parseHHMM(lesson.startTime),
      endTime: parseHHMM(lesson.endTime),
    }));

    // Direkt, and the year has published rows: the restore is carried to the
    // calendar in this transaction (restore-calendar.ts). Otherwise the
    // timetable is replaced as it always was.
    let calendar: RestoredCalendar | undefined;
    if (mode === 'DIRECT' && (await yearHasCalendarRows(tx, version.academicYearId))) {
      calendar = await this.replaceCarryingCalendar(tx, version, rows);
    } else {
      await tx.masterLesson.deleteMany({
        where: { academicYearId: version.academicYearId },
      });
      for (const lesson of rows) {
        await tx.masterLesson.create({ data: masterLessonData(version, lesson) });
      }
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
          ...(calendar ? { calendar } : {}),
        },
      },
    });

    this.logger.log(
      `Schedule version restored [version=${version.id}, lessons=${lessons.length}${
        calendar ? `, calendarKept=${calendar.kept}, calendarRemoved=${calendar.removed}` : ''
      }]`,
    );

    return { restoredLessons: lessons.length, safetyVersionId: safety.id, ...(calendar ? { calendar } : {}) };
  }

  /**
   * DIRECT's restore of a year that has published rows: the new masters are made
   * first, so the rows of a lesson the version holds unchanged can move over to
   * it before the old masters are deleted (their SET NULL would otherwise strand
   * every row); the rows of the lessons it changes or drops are swept; the school
   * is asked as any change in Direkt that reaches families asks; then the old
   * masters go. See restore-calendar.ts.
   */
  private async replaceCarryingCalendar(
    tx: PrismaClient,
    version: { id: string; schoolId: string; academicYearId: string },
    rows: ReadonlyArray<RestoreRow>,
  ): Promise<RestoredCalendar> {
    // Before the lessons are read and before a row moves: a publication in Direkt takes no lock on the year (restore-calendar.ts).
    await lockYearLessons(tx, version.academicYearId);
    const current = await tx.masterLesson.findMany({
      where: { academicYearId: version.academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        isParked: true,
        recurrence: true,
        startDate: true,
        endDate: true,
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });
    const pairing = pairTemplates(
      current.map((lesson) => ({
        id: lesson.id,
        subjectId: lesson.subjectId,
        studentGroupId: lesson.studentGroupId,
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        roomId: lesson.roomId,
        dayOfWeek: lesson.dayOfWeek,
        startTime: toHHMM(lesson.startTime),
        endTime: toHHMM(lesson.endTime),
        isParked: lesson.isParked,
        recurrence: lesson.recurrence,
        startDate: toDateStringOrNull(lesson.startDate),
        endDate: toDateStringOrNull(lesson.endDate),
        extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
        studentIds: lesson.participants.map((entry) => entry.studentId),
      })),
      rows.map(templateOfRow),
    );

    const createdIds: string[] = [];
    for (const lesson of rows) {
      const created = await tx.masterLesson.create({
        data: masterLessonData(version, lesson),
        select: { id: true },
      });
      createdIds.push(created.id);
    }

    const kept = await relinkCalendarRows(
      tx,
      pairing.from.flatMap((from, index) => (from === null ? [] : [{ from, to: createdIds[index]! }])),
    );

    // The school's today, as Generera's sweep reads it (regenerationSweepDay).
    const today = todayInZone(await schoolTimezone(tx, version.schoolId));
    const { removed, handChanged } = await countSweep(tx, pairing.replaced, today);
    await sweepCalendarRows(tx, pairing.replaced, today);
    // Published lessons taken off the calendar reach families: asked of the school
    // once, and the throw rolls the restore back whole, the safety version too.
    await requireDirectReachAnswered(tx, {
      academicYearId: version.academicYearId,
      mode: 'DIRECT',
      reached: removed,
      detail: { removed, handChanged },
    });

    await tx.masterLesson.deleteMany({
      where: { academicYearId: version.academicYearId, id: { in: current.map((lesson) => lesson.id) } },
    });
    return { kept, removed, handChanged };
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
        fromPlacement: true,
        isParked: true,
        exemptFrom: true,
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
      // Only on a placed lesson, so a snapshot of a school with none is the
      // blob it always was.
      ...(lesson.fromPlacement ? { fromPlacement: true } : {}),
      isParked: lesson.isParked,
      // Only on a lesson that has one (see VersionLesson.exemptFrom).
      ...(exemptionsOf(lesson.exemptFrom).length > 0 ? { exemptFrom: exemptionsOf(lesson.exemptFrom) } : {}),
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

/** One restored lesson as the table takes it. */
function masterLessonData(
  version: { schoolId: string; academicYearId: string },
  lesson: RestoreRow,
): Prisma.MasterLessonUncheckedCreateInput {
  return {
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
    // See VersionLesson.fromPlacement.
    fromPlacement: lesson.fromPlacement ?? false,
    // See VersionLesson.isParked for why an absent key is false.
    isParked: lesson.isParked ?? false,
    // See VersionLesson.exemptFrom: only the names the table knows (its CHECK), the way a row is written.
    ...(exemptionsOf(lesson.exemptFrom).length > 0 ? { exemptFrom: exemptionsOf(lesson.exemptFrom) } : {}),
    recurrence: lesson.recurrence ?? 'ALL_WEEKS',
    startDate: parseDateOrNull(lesson.startDate),
    endDate: parseDateOrNull(lesson.endDate),
    extraGroups: {
      create: (lesson.extraGroupIds ?? []).map((studentGroupId) => ({
        studentGroupId,
      })),
    },
    participants: {
      create: (lesson.studentIds ?? []).map((studentId) => ({
        studentId,
      })),
    },
  };
}

/** A restored lesson as restore-calendar.ts compares it with a lesson the year holds: absent keys read the way the restore reads them. */
function templateOfRow(lesson: RestoreRow): TemplateFields {
  return {
    subjectId: lesson.subjectId,
    studentGroupId: lesson.studentGroupId,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId ?? null,
    roomId: lesson.roomId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    isParked: lesson.isParked ?? false,
    recurrence: lesson.recurrence ?? 'ALL_WEEKS',
    startDate: toDateStringOrNull(parseDateOrNull(lesson.startDate)),
    endDate: toDateStringOrNull(parseDateOrNull(lesson.endDate)),
    extraGroupIds: lesson.extraGroupIds ?? [],
    studentIds: lesson.studentIds ?? [],
  };
}

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
