import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LessonCancelCause, PrismaClient, TeacherAssignmentRole, TeacherQualificationKind } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  NotificationsService,
  type NotificationKind,
} from '../notifications/notifications.service';
import { attendanceSpan, lessonQualificationFindings } from '../staffing/staffing-enforcement';
import type { RosterViewer } from '../year-rollover/projected-rosters';
import { settleFindings, type StaffingWarning } from '../staffing/staffing-checks';
import { requireSchoolId } from '../common/utils/request-context';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import {
  decisionsOn,
  lockLessons,
  lockTeachers,
  mergeRemoved,
  REPLACED_TEACHER_NOT_ON_LESSON,
  SUBSTITUTE_ON_LESSON,
  substituteIsAbsent,
  writeDecision,
  type PendingNotice,
  type RemovedTeacher,
} from '../cover/cover-decisions';
import { readPersonDays, schoolTimezone } from '../cover/cover-context';
import { hardFindings, softWarnings, type CoverWarningCode } from '../cover/cover-rules';
import { coverEmail, coverMeta, withdrawnEmail, withdrawnMeta, type NoticeLesson } from '../cover/cover-notices';
import type {
  AssignSubstituteDto,
  CancelLessonDto,
  ChangeRoomDto,
} from './dto/lesson-action.dto';

export interface LessonActionResult {
  id: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  note: string | null;
}

/** A hard cover rule a manual pick overrides, informed (cover-rules.ts softWarnings). */
export interface CoverWarning {
  code: CoverWarningCode;
  params: Record<string, string | number>;
}

/**
 * A vikarie assigned, with what the staffing policy says about their behörighet
 * for this lesson (STAFF_TEACHER_NOT_QUALIFIED) — a warning even when the policy
 * says REFUSE; see assignSubstitute — and the cover rules the pick breaks
 * (lunch, daily rest, a closure or a booking of theirs, a pool member outside
 * their declared hours), warnings too.
 */
export interface SubstituteResult extends LessonActionResult {
  warnings: Array<StaffingWarning | CoverWarning>;
}

/**
 * Who leaves the lesson when a substitute is put in: every row (undefined, the
 * old PATCH's behaviour), the one row of this teacher (a string), or nobody
 * (null — the board covering a lesson whose absent row an earlier decision
 * already removed).
 */
export type Replaces = string | null | undefined;

/** An assignment written, and what is left to do after it. */
export interface AssignOutcome {
  result: SubstituteResult;
  schoolId: string;
  date: string;
  lesson: LessonForAction;
  /** The rows removed from the lesson. */
  removed: RemovedTeacher[];
  /** Notices for the substitute put in and any substitute removed. */
  notices: PendingNotice[];
  /** The school's clock, read for the cover rules; the notices format on it. */
  timezone: string;
}

/** A qualified, currently-free candidate to cover a lesson. */
export interface SubstituteSuggestion {
  teacherId: string;
  /** true = teaches this exact class+subject; false = teaches the subject elsewhere. */
  isPrimary: boolean;
  /**
   * The strongest behörighet the candidate holds for this subject over the
   * lesson's grade span, valid on the lesson's date — or null: the school has
   * recorded none for them, or none that reaches this class. The badge the
   * picker shows, and the first key it sorts on.
   */
  qualificationKind: TeacherQualificationKind | null;
}

/**
 * LEGITIMATION over BEHORIG over TILLATEN, as skollagen ranks them: the
 * legitimerad teacher sets grades, the behörig one teaches, the one a rektor
 * has allowed does so for this year only.
 */
const QUALIFICATION_RANK: Record<TeacherQualificationKind, number> = {
  LEGITIMATION: 3,
  BEHORIG: 2,
  TILLATEN: 1,
};

export interface LessonForAction {
  id: string;
  schoolId: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  cancelCause?: LessonCancelCause | null;
  note: string | null;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  subjectId: string;
  studentGroupId: string;
  subject: { name: string };
  teachers: { teacherId: string; role: TeacherAssignmentRole }[];
  /** The lesson's attendance beyond its class, for the grade span a vikarie is asked about. */
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
}

/** The cover board's day of a lesson, for its realtime notice. */
const boardOf = (lesson: LessonForAction): { schoolId: string; date: string } => ({
  schoolId: lesson.schoolId,
  date: lesson.date.toISOString().slice(0, 10),
});

const lessonGroupIds = (lesson: LessonForAction): string[] => [
  lesson.studentGroupId,
  ...(lesson.extraGroups ?? []).map((row) => row.studentGroupId),
];
const lessonStudentIds = (lesson: LessonForAction): string[] =>
  (lesson.participants ?? []).map((row) => row.studentId);

/**
 * The läsår of the lesson's class, with the flags its roster basis is decided
 * from (projected-rosters.ts). Null when the group is gone or hidden.
 *
 * Asked of the YEAR, with the group as a relation filter, so it is one
 * statement: Prisma 7 loads a selected relation (the group's `academicYear`)
 * in a statement of its own, and a substitute assigned or suggested in the
 * active year would otherwise make one more round-trip than it did before the
 * flags were needed.
 */
function yearOfLessonGroup(
  tx: PrismaClient,
  studentGroupId: string,
): Promise<{ id: string; isActive: boolean; predecessorId: string | null } | null> {
  return tx.academicYear.findFirst({
    where: { studentGroups: { some: { id: studentGroupId } } },
    select: { id: true, isActive: true, predecessorId: true },
  });
}

/**
 * Day-to-day operations on individual calendar lessons: cancellations,
 * reinstatements, substitute-teacher assignments and room changes. These are
 * the "something changed today" workflows, so every mutation broadcasts a
 * `calendar_lesson_updated` event and notifies the affected class (students +
 * guardians) and the teachers involved.
 */
@Injectable()
export class CalendarLessonsService {
  private readonly logger = new Logger(CalendarLessonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async cancel(
    id: string,
    dto: CancelLessonDto,
    user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    const { updated, board } = await this.prisma.withRls(user, async (tx) => {
      // The publication lock, shared, first: a cover write never lands in a
      // DRAFT publish's read of the rows it carries over (publish-mode.ts).
      await enterGrundschemaWrite(tx, requireSchoolId(user));
      const lesson = await this.requireLesson(tx, id);
      const updated = await this.cancelInTransaction(tx, lesson, dto);

      await this.realtime.notifyLessonChanged(tx, id);
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_CANCELLED',
        teacherIds: lesson.teachers.map((t) => t.teacherId),
        email: {
          subject: `Lesson cancelled: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} has been cancelled.${
            dto.reason ? ` Reason: ${dto.reason}` : ''
          }`,
        },
      });
      this.logger.log(`Lesson cancelled [lesson=${id}]`);
      return { updated, board: boardOf(lesson) };
    });
    this.boardChanged(board);
    return updated;
  }

  /**
   * The cancellation itself, in the caller's transaction: no notice, no
   * broadcast (the board sends them after its commit). The caller has
   * entered the publication lock.
   */
  async cancelInTransaction(
    tx: PrismaClient,
    lesson: LessonForAction,
    dto: CancelLessonDto,
  ): Promise<LessonActionResult> {
    if (lesson.status !== 'SCHEDULED') {
      throw new BadRequestException('Only scheduled lessons can be cancelled.');
    }
    return tx.calendarLesson.update({
      where: { id: lesson.id },
      // The cause is the category the timplan counts lost minutes by; the
      // reason stays free text in the note, which pupils read. No cause
      // sent is the school's own decision (MANUAL), as every cancel was
      // before the absence page started saying TEACHER_UNAVAILABLE.
      data: {
        status: 'CANCELLED',
        note: dto.reason ?? lesson.note,
        cancelCause: dto.cause ?? 'MANUAL',
      },
      select: { id: true, status: true, note: true },
    });
  }

  async reinstate(id: string, user: AuthenticatedUser): Promise<LessonActionResult> {
    const { updated, board } = await this.prisma.withRls(user, async (tx) => {
      await enterGrundschemaWrite(tx, requireSchoolId(user));
      const lesson = await this.requireLesson(tx, id);
      const updated = await this.reinstateInTransaction(tx, lesson);

      await this.realtime.notifyLessonChanged(tx, id);
      this.logger.log(`Lesson reinstated [lesson=${id}]`);
      return { updated, board: boardOf(lesson) };
    });
    this.boardChanged(board);
    return updated;
  }

  /** The reinstatement itself, in the caller's transaction (see cancelInTransaction). */
  async reinstateInTransaction(tx: PrismaClient, lesson: LessonForAction): Promise<LessonActionResult> {
    if (lesson.status !== 'CANCELLED') {
      throw new BadRequestException('Only cancelled lessons can be reinstated.');
    }
    return tx.calendarLesson.update({
      where: { id: lesson.id },
      // Held after all: no longer cancelled for any reason.
      data: { status: 'SCHEDULED', cancelCause: null },
      select: { id: true, status: true, note: true },
    });
  }

  /**
   * Replaces the lesson's teacher assignments with a single SUBSTITUTE
   * assignment — or, with `replacesTeacherId`, only that teacher's row, so a
   * co-teacher stays. The substitute must be an active teacher in the same
   * school, free at the lesson's time and not absent themself
   * (SUBSTITUTE_IS_ABSENT).
   *
   * BEHÖRIGHET IS ASKED, AND NEVER REFUSES. The staffing policy's
   * qualification question is asked of the vikarie for this lesson's class and
   * subject on the lesson's own date (staffing-enforcement.ts), and a finding
   * comes back in `warnings` — under WARN and under REFUSE alike. Skollagen
   * lets a school put an obehörig vikarie in front of a class for a short time,
   * and a refusal at 07:45 helps no pupil: it leaves the class with nobody. The
   * policy's REFUSE governs the PLAN (the timplan and the grundschema); today's
   * cover is the rektor's call, informed. A product decision, stated in the
   * Fas 2 hand-over for the school to confirm. Never the load question: the
   * load report is computed from the timplan, not from lessons. The cover
   * rules a manual pick breaks — lunch, daily rest, a closure or a booking of
   * theirs, a pool member outside their hours — come back the same way.
   *
   * When a teacher who leaves the lesson has an ACTIVE absence overlapping
   * it, the assignment is recorded as that absence's decision, so a vikarie
   * put in from the old absence page or the day planner shows on the board
   * and can be undone there.
   *
   * The class and the outgoing teachers are told as before; the substitute
   * gets a notice of their own (their cover, with group and room, mirrored
   * to e-mail in Swedish), and a substitute this assignment replaces is told
   * they are no longer needed.
   */
  async assignSubstitute(
    id: string,
    dto: AssignSubstituteDto,
    user: AuthenticatedUser,
  ): Promise<SubstituteResult> {
    const outcome = await this.prisma.withRls(user, async (tx) => {
      const outcome = await this.assignInTransaction(tx, id, dto.teacherId, dto.replacesTeacherId, user, {
        note: dto.note,
      });
      const { lesson, notices } = outcome;
      const withdrawn = new Set(notices.filter((n) => n.kind === 'WITHDRAWN').map((n) => n.userId));

      await this.realtime.notifyLessonChanged(tx, id);
      // The class and the outgoing teacher(s), as before; the substitute is
      // told separately below, in Swedish, with the group and the room.
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_SUBSTITUTE',
        teacherIds: outcome.removed
          .map((row) => row.teacherId)
          .filter((teacherId) => !withdrawn.has(teacherId) && teacherId !== dto.teacherId),
        email: {
          subject: `Substitute assigned: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} will be covered by a substitute teacher.`,
        },
      });
      await this.notifyInTransaction(tx, outcome);
      // Ids only in logs — never teacher names.
      this.logger.log(`Substitute assigned [lesson=${id}]`);
      return outcome;
    });
    this.boardChanged({ schoolId: outcome.schoolId, date: outcome.date });
    return outcome.result;
  }

  /**
   * The assignment itself, in the caller's transaction: the checks, the rows,
   * the decision. No broadcast and no notice — the caller sends them (the old
   * PATCH inside its transaction as before, the board after its commit).
   *
   * `options.locked`: the caller has already entered the publication lock
   * and locked the lesson row (the board, a bulk, an apply). Otherwise this
   * does both, first. Then the per-teacher lock of the substitute, so two
   * writers cannot both put one person on two lessons at one hour.
   * `options.decision`: the absence the board is covering for.
   */
  async assignInTransaction(
    tx: PrismaClient,
    id: string,
    teacherId: string,
    replaces: Replaces,
    user: AuthenticatedUser,
    options: {
      note?: string;
      locked?: boolean;
      decision?: { absenceId: string; absentTeacherId: string };
    } = {},
  ): Promise<AssignOutcome> {
    const schoolId = requireSchoolId(user);
    if (!options.locked) {
      await enterGrundschemaWrite(tx, schoolId);
      await lockLessons(tx, [id]);
    }
    const lesson = await this.requireLesson(tx, id);
    if (lesson.status === 'COMPLETED') {
      throw new BadRequestException('Completed lessons cannot be reassigned.');
    }

    const substitute = await tx.user.findUnique({
      where: { id: teacherId },
      select: { id: true, role: true, isActive: true },
    });
    if (!substitute || !substitute.isActive || substitute.role !== 'TEACHER') {
      throw new BadRequestException('The substitute must be an active teacher.');
    }

    const teachers = lesson.teachers ?? [];
    let leaving: RemovedTeacher[];
    if (replaces === undefined) {
      leaving = teachers.map((t) => ({ teacherId: t.teacherId, role: t.role ?? 'LEAD' }));
    } else if (replaces === null) {
      leaving = [];
    } else {
      const row = teachers.find((t) => t.teacherId === replaces);
      if (!row) {
        throw new BadRequestException({
          message: 'replacesTeacherId: läraren undervisar inte på lektionen.',
          code: REPLACED_TEACHER_NOT_ON_LESSON,
        });
      }
      leaving = [{ teacherId: row.teacherId, role: row.role ?? 'LEAD' }];
    }
    if (teachers.some((t) => t.teacherId === teacherId) && !leaving.some((row) => row.teacherId === teacherId)) {
      throw new ConflictException({
        message: 'Vikarien undervisar redan på lektionen.',
        code: SUBSTITUTE_ON_LESSON,
      });
    }

    await lockTeachers(tx, [teacherId]);

    // The substitute must not already teach an overlapping lesson.
    if (await this.teacherHasClash(tx, teacherId, lesson)) {
      throw new ConflictException(
        'The substitute already teaches another lesson at this time.',
      );
    }

    // One read for the substitute's absence and the leaving teachers' (for
    // the decision): ACTIVE, overlapping the lesson. The period only.
    const absences =
      (await tx.teacherAbsence.findMany({
        where: {
          status: 'ACTIVE',
          userId: { in: [...new Set([teacherId, ...leaving.map((row) => row.teacherId)])] },
          startsAt: { lt: lesson.endsAt },
          endsAt: { gt: lesson.startsAt },
        },
        select: { id: true, userId: true, startsAt: true, endsAt: true },
        orderBy: { startsAt: 'asc' },
      })) ?? [];
    if (absences.some((absence) => absence.userId === teacherId)) {
      throw substituteIsAbsent();
    }

    const year = await yearOfLessonGroup(tx, lesson.studentGroupId);
    const lessonDay = lesson.date.toISOString().slice(0, 10);
    const warnings: Array<StaffingWarning | CoverWarning> = year
      ? settleFindings(
          await lessonQualificationFindings(tx, {
            schoolId: lesson.schoolId,
            academicYearId: year.id,
            subjectId: lesson.subjectId,
            // The whole attendance, as the master-lesson PATCH asks it.
            groupIds: lessonGroupIds(lesson),
            studentIds: lessonStudentIds(lesson),
            assignees: [{ userId: teacherId, role: 'SUBSTITUTE' }],
            window: { startDate: lessonDay, endDate: lessonDay },
            // The year's roster basis from the flags just read: a lesson of
            // a rolled year not yet activated spans the grades its
            // activation would place (projected-rosters.ts).
            rosters: { viewer: user, known: year },
          }),
          { downgrade: true },
        )
      : [];
    const timezone = await schoolTimezone(tx, schoolId);
    warnings.push(...(await this.coverWarnings(tx, lesson, substitute, year?.id ?? null, timezone)));

    if (replaces === undefined) {
      await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: id } });
    } else if (leaving.length > 0) {
      await tx.calendarLessonTeacher.deleteMany({
        where: { calendarLessonId: id, teacherId: { in: leaving.map((row) => row.teacherId) } },
      });
    }
    await tx.calendarLessonTeacher.create({
      data: {
        schoolId: lesson.schoolId,
        calendarLessonId: id,
        teacherId,
        role: 'SUBSTITUTE',
      },
    });

    const updated = await tx.calendarLesson.update({
      where: { id },
      data: options.note !== undefined ? { note: options.note } : {},
      select: { id: true, status: true, note: true },
    });

    const notices = await this.recordAssignment(tx, {
      schoolId,
      lesson,
      teacherId,
      leaving,
      absences,
      decision: options.decision,
      decidedByUserId: user.userId ?? null,
    });

    return {
      result: { ...updated, warnings },
      schoolId,
      date: lessonDay,
      lesson,
      removed: leaving,
      notices,
      timezone,
    };
  }

  /**
   * The decision rows an assignment writes, and whom to tell.
   *
   * Each leaving teacher with an ACTIVE absence overlapping the lesson gets
   * (or keeps, replaced in place) a SUBSTITUTE decision on that absence,
   * holding exactly the rows it removed. A leaving teacher who is not absent
   * — a co-teacher an old-style PATCH wipes — is put in the decision of the
   * first absent leaver by id, so an undo restores them too. A substitute
   * replaced (S → T) moves the decision that named S on to T, and S is told.
   */
  private async recordAssignment(
    tx: PrismaClient,
    args: {
      schoolId: string;
      lesson: LessonForAction;
      teacherId: string;
      leaving: RemovedTeacher[];
      absences: { id: string; userId: string }[];
      decision?: { absenceId: string; absentTeacherId: string };
      decidedByUserId: string | null;
    },
  ): Promise<PendingNotice[]> {
    const { lesson, teacherId, leaving } = args;
    const notices: PendingNotice[] = [{ kind: 'COVER', userId: teacherId, lessonId: lesson.id }];
    const absenceOf = new Map<string, string>();
    for (const absence of args.absences) {
      if (absence.userId !== teacherId && !absenceOf.has(absence.userId)) absenceOf.set(absence.userId, absence.id);
    }
    if (args.decision) absenceOf.set(args.decision.absentTeacherId, args.decision.absenceId);
    const removedSubstitutes = leaving.filter((row) => row.role === 'SUBSTITUTE' && row.teacherId !== teacherId);
    const absentLeavers = leaving.filter((row) => absenceOf.has(row.teacherId)).map((row) => row.teacherId).sort();
    if (args.decision && !absentLeavers.includes(args.decision.absentTeacherId)) absentLeavers.unshift(args.decision.absentTeacherId);
    if (absentLeavers.length === 0 && removedSubstitutes.length === 0) return notices;

    const existing = await decisionsOn(tx, [lesson.id]);
    const first = absentLeavers[0];
    for (const absentTeacherId of absentLeavers) {
      const absenceId = absenceOf.get(absentTeacherId)!;
      const own = leaving.filter((row) => row.teacherId === absentTeacherId);
      const attributed =
        absentTeacherId === first
          ? leaving.filter((row) => !absenceOf.has(row.teacherId) && row.role !== 'SUBSTITUTE')
          : [];
      await writeDecision(tx, {
        schoolId: args.schoolId,
        absenceId,
        lessonId: lesson.id,
        absentTeacherId,
        decision: 'SUBSTITUTE',
        removed: mergeRemoved(own, attributed),
        substituteId: teacherId,
        decidedByUserId: args.decidedByUserId,
        existing: existing.find((row) => row.absenceId === absenceId),
      });
    }
    for (const removed of removedSubstitutes) {
      for (const row of existing) {
        if (row.substituteId !== removed.teacherId || absentLeavers.includes(row.absentTeacherId)) continue;
        await tx.teacherAbsenceCover.update({ where: { id: row.id }, data: { substituteId: teacherId } });
      }
      notices.push({ kind: 'WITHDRAWN', userId: removed.teacherId, lessonId: lesson.id });
    }
    return notices;
  }

  /** The cover rules a manual pick breaks, as warnings (cover-rules.ts softWarnings). */
  private async coverWarnings(
    tx: PrismaClient,
    lesson: LessonForAction,
    substitute: { id: string; role: string; isActive: boolean },
    academicYearId: string | null,
    timezone: string,
  ): Promise<CoverWarning[]> {
    const date = lesson.date.toISOString().slice(0, 10);
    const read = await readPersonDays(tx, {
      date,
      timezone,
      academicYearId,
      userIds: [substitute.id],
      known: [substitute],
      // The absence was read by the caller and refused there.
      skipAbsences: true,
    });
    const day = read.days.get(substitute.id);
    if (!day) return [];
    return softWarnings(
      hardFindings(day, {
        id: lesson.id,
        date,
        start: lesson.startsAt.getTime(),
        end: lesson.endsAt.getTime(),
        teacherIds: [],
      }),
    );
  }

  /**
   * The substitute's own notices, inside the old PATCH's transaction as its
   * class notice is. The lesson is in hand; only its class's and room's
   * names are read.
   */
  private async notifyInTransaction(
    tx: PrismaClient,
    outcome: AssignOutcome,
  ): Promise<void> {
    const { lesson, notices, schoolId, timezone } = outcome;
    if (notices.length === 0) return;
    const group = await tx.studentGroup.findUnique({ where: { id: lesson.studentGroupId }, select: { name: true } });
    const room = lesson.roomId
      ? await tx.room.findUnique({ where: { id: lesson.roomId }, select: { name: true } })
      : null;
    const details: NoticeLesson = {
      id: lesson.id,
      startsAt: lesson.startsAt,
      subjectName: lesson.subject.name,
      groupName: group?.name ?? '',
      roomName: room?.name ?? '—',
    };
    for (const notice of notices) {
      await this.notifications.notifyUsers(tx, {
        schoolId,
        userIds: [notice.userId],
        type: notice.kind === 'COVER' ? 'LESSON_SUBSTITUTE' : 'LESSON_COVER_WITHDRAWN',
        meta: notice.kind === 'COVER' ? coverMeta(details) : withdrawnMeta(details),
        email: notice.kind === 'COVER' ? coverEmail(details, timezone) : withdrawnEmail(details, timezone),
      });
    }
  }

  /**
   * Tells the cover board's admins that a day changed, after the commit, so
   * a second admin who refetches reads the new state. Best effort: a
   * broadcast never fails a write.
   */
  private boardChanged(board: { schoolId: string; date: string }): void {
    try {
      this.realtime.notifyCoverBoardChanged(board.schoolId, board.date, board.date);
    } catch {
      this.logger.debug(`Cover board broadcast failed [school=${board.schoolId}]`);
    }
  }

  /**
   * Moves a scheduled lesson to a different room (or clears it). Rejects a
   * target room already booked by another scheduled lesson at the same time.
   */
  async changeRoom(
    id: string,
    dto: ChangeRoomDto,
    user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    const { updated, board } = await this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status === 'COMPLETED') {
        throw new BadRequestException('Completed lessons cannot be changed.');
      }
      // No-op: same room and nothing else to record — return without notifying.
      if (lesson.roomId === dto.roomId && dto.note === undefined) {
        return { updated: { id: lesson.id, status: lesson.status, note: lesson.note }, board: null };
      }

      if (dto.roomId !== null) {
        const room = await tx.room.findUnique({
          where: { id: dto.roomId },
          select: { id: true },
        });
        if (!room) {
          throw new BadRequestException('Room not found.');
        }

        const clash = await tx.calendarLesson.findFirst({
          where: {
            id: { not: id },
            status: 'SCHEDULED',
            roomId: dto.roomId,
            startsAt: { lt: lesson.endsAt },
            endsAt: { gt: lesson.startsAt },
          },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictException(
            'That room is already booked by another lesson at this time.',
          );
        }

        // The room must not be held by an approved self-service booking either.
        const bookingClash = await tx.roomBooking.findFirst({
          where: {
            roomId: dto.roomId,
            status: 'APPROVED',
            startsAt: { lt: lesson.endsAt },
            endsAt: { gt: lesson.startsAt },
          },
          select: { id: true },
        });
        if (bookingClash) {
          throw new ConflictException(
            'That room is reserved by an approved booking at this time.',
          );
        }
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: {
          roomId: dto.roomId,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_ROOM_CHANGED',
        teacherIds: lesson.teachers.map((t) => t.teacherId),
        email: {
          subject: `Room changed: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} has moved to a different room.`,
        },
      });
      this.logger.log(`Lesson room changed [lesson=${id}]`);
      return { updated, board: boardOf(lesson) };
    });
    if (board) this.boardChanged(board);
    return updated;
  }

  /**
   * Suggests substitute teachers for a lesson: those who may teach the subject
   * and are free at the lesson's time.
   *
   * RANKED BY BEHÖRIGHET FIRST, then by already teaching this class. A
   * qualification for the subject whose grade span contains the class and is
   * valid on the lesson's date puts a teacher ahead of everyone without one,
   * LEGITIMATION before BEHORIG before TILLATEN; among equals, the teacher of
   * this exact class+subject (isPrimary) comes first, as before.
   *
   * THE OLD HEURISTIC STAYS, AS THE FLOOR. "Has a TeachingRequirement in the
   * subject" was the only notion of qualified this picker had, and it is still
   * how a teacher the school has not written a behörighet for gets suggested at
   * all: with zero qualification rows in the school the list is exactly what it
   * was, so no existing school's suggestions get worse the day the table
   * appears; with rows, a subject teacher nobody has recorded a behörighet for
   * is still listed, after the ones somebody has. The grade span is derived as
   * the optimisation proxy derives it for a group (members' home classes, else
   * the group's own year), so "behörig för åk 7-9" means the same thing here as
   * in the staffing report.
   *
   * Freeness uses the same overlapping-lesson check `assignSubstitute`
   * enforces, so every suggestion is guaranteed to be assignable — and since
   * Vikarieplanering the hard cover rules too (cover-rules.ts): the list is
   * narrower on purpose, never wider, and its shape and order are unchanged.
   */
  async suggestSubstitutes(
    id: string,
    user: AuthenticatedUser,
  ): Promise<SubstituteSuggestion[]> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);

      const requirements = await tx.teachingRequirement.findMany({
        where: { subjectId: lesson.subjectId },
        select: { teacherId: true, coTeacherId: true, studentGroupId: true },
      });

      const primaryIds = new Set<string>();
      const candidateIds = new Set<string>();
      for (const req of requirements) {
        const forThisClass = req.studentGroupId === lesson.studentGroupId;
        for (const teacherId of [req.teacherId, req.coTeacherId]) {
          if (!teacherId) continue;
          candidateIds.add(teacherId);
          if (forThisClass) primaryIds.add(teacherId);
        }
      }

      // Only a school that has recorded any behörighet at all is asked about
      // them; an empty table is not the statement that nobody is qualified.
      const qualificationOf = new Map<string, TeacherQualificationKind>();
      const recorded = await tx.teacherSubjectQualification.count();
      if (recorded > 0) {
        const span = await this.gradeSpanOfLesson(tx, user, lesson);
        const held = await tx.teacherSubjectQualification.findMany({
          where: { subjectId: lesson.subjectId },
          select: {
            userId: true,
            minGradeLevel: true,
            maxGradeLevel: true,
            kind: true,
            validFrom: true,
            validTo: true,
          },
        });
        for (const qualification of held) {
          if (span && (qualification.minGradeLevel > span.min || qualification.maxGradeLevel < span.max)) {
            continue;
          }
          if (qualification.validFrom && qualification.validFrom > lesson.date) continue;
          if (qualification.validTo && qualification.validTo < lesson.date) continue;
          const current = qualificationOf.get(qualification.userId);
          if (!current || QUALIFICATION_RANK[qualification.kind] > QUALIFICATION_RANK[current]) {
            qualificationOf.set(qualification.userId, qualification.kind);
          }
          candidateIds.add(qualification.userId);
        }
      }

      // Never suggest a teacher already assigned to this lesson.
      for (const assignment of lesson.teachers) {
        candidateIds.delete(assignment.teacherId);
        primaryIds.delete(assignment.teacherId);
      }
      if (candidateIds.size === 0) return [];

      const teachers = await tx.user.findMany({
        where: {
          id: { in: [...candidateIds] },
          role: 'TEACHER',
          isActive: true,
        },
        select: { id: true },
      });

      const free: { id: string }[] = [];
      for (const teacher of teachers) {
        if (await this.teacherHasClash(tx, teacher.id, lesson)) continue;
        free.push(teacher);
      }
      // The cover rules, intersected: a duty slot, a closure, a booking, the
      // lunch or the rest of a work rule, an absence or an undeclared pool
      // member drops a teacher this picker used to offer, so every suggestion
      // is one the board would make too (cover-rules.ts). The year only
      // decides which uppdrag slots block, read from the class.
      const feasible = await this.feasibleOf(tx, lesson, free.map((teacher) => teacher.id));

      const suggestions: SubstituteSuggestion[] = [];
      for (const teacher of free) {
        if (!feasible.has(teacher.id)) continue;
        suggestions.push({
          teacherId: teacher.id,
          isPrimary: primaryIds.has(teacher.id),
          qualificationKind: qualificationOf.get(teacher.id) ?? null,
        });
      }

      // Strongest behörighet first, then the class's own teachers, then a
      // stable order so two loads of the dialog agree.
      const rank = (s: SubstituteSuggestion) =>
        s.qualificationKind ? QUALIFICATION_RANK[s.qualificationKind] : 0;
      return suggestions.sort(
        (a, b) =>
          rank(b) - rank(a) ||
          Number(b.isPrimary) - Number(a.isPrimary) ||
          a.teacherId.localeCompare(b.teacherId),
      );
    });
  }

  /**
   * The years the lesson's class holds, derived as the proxy derives them for a
   * group. Null when nothing says — a memberless teaching group with no year —
   * and then any behörighet in the subject counts, since the span cannot be
   * judged and refusing all of them would list nobody.
   */
  private async gradeSpanOfLesson(
    tx: PrismaClient,
    viewer: RosterViewer,
    lesson: LessonForAction,
  ): Promise<{ min: number; max: number } | null> {
    const year = await yearOfLessonGroup(tx, lesson.studentGroupId);
    if (!year) return null;
    // The derivation the assignment's own warning uses (attendanceSpan), so
    // the badge here and the warning after the click read one span.
    return attendanceSpan(tx, {
      academicYearId: year.id,
      groupIds: lessonGroupIds(lesson),
      studentIds: lessonStudentIds(lesson),
      rosters: { viewer, known: year },
    });
  }

  /** Of the active teachers named, those breaking no hard cover rule for the lesson. */
  private async feasibleOf(tx: PrismaClient, lesson: LessonForAction, teacherIds: string[]): Promise<Set<string>> {
    if (teacherIds.length === 0) return new Set();
    const date = lesson.date.toISOString().slice(0, 10);
    const group = await tx.studentGroup.findUnique({
      where: { id: lesson.studentGroupId },
      select: { academicYearId: true },
    });
    const read = await readPersonDays(tx, {
      date,
      timezone: await schoolTimezone(tx, lesson.schoolId),
      academicYearId: group?.academicYearId ?? null,
      userIds: teacherIds,
      known: teacherIds.map((id) => ({ id, role: 'TEACHER', isActive: true })),
    });
    const target = {
      id: lesson.id,
      date,
      start: lesson.startsAt.getTime(),
      end: lesson.endsAt.getTime(),
      teacherIds: (lesson.teachers ?? []).map((row) => row.teacherId),
    };
    return new Set(
      teacherIds.filter((id) => {
        const day = read.days.get(id);
        return day !== undefined && hardFindings(day, target).length === 0;
      }),
    );
  }

  /** True when the teacher already teaches another scheduled lesson that overlaps. */
  async teacherHasClash(
    tx: PrismaClient,
    teacherId: string,
    lesson: { id: string; startsAt: Date; endsAt: Date },
  ): Promise<boolean> {
    const clash = await tx.calendarLesson.findFirst({
      where: {
        id: { not: lesson.id },
        status: 'SCHEDULED',
        startsAt: { lt: lesson.endsAt },
        endsAt: { gt: lesson.startsAt },
        teachers: { some: { teacherId } },
      },
      select: { id: true },
    });
    return clash !== null;
  }

  /** The lesson as the day operations read it; 404 when RLS or the id says there is none. */
  async requireLesson(
    tx: PrismaClient,
    id: string,
  ): Promise<LessonForAction> {
    const lesson = await tx.calendarLesson.findUnique({
      where: { id },
      select: {
        id: true,
        schoolId: true,
        status: true,
        cancelCause: true,
        note: true,
        date: true,
        startsAt: true,
        endsAt: true,
        roomId: true,
        subjectId: true,
        studentGroupId: true,
        subject: { select: { name: true } },
        teachers: { select: { teacherId: true, role: true } },
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found.');
    }
    return lesson;
  }

  /**
   * The class's notice for a lesson the cover board covered or cancelled,
   * sent by the board after its commit: the same type, meta and e-mail the
   * old PATCHes send, without a reason (the board takes none).
   */
  async notifyLessonClass(
    tx: PrismaClient,
    lessonId: string,
    type: 'LESSON_SUBSTITUTE' | 'LESSON_CANCELLED',
    teacherIds: string[],
  ): Promise<void> {
    const lesson = await this.requireLesson(tx, lessonId);
    await this.notifyLessonAudience(tx, lesson, {
      type,
      teacherIds,
      email:
        type === 'LESSON_CANCELLED'
          ? {
              subject: `Lesson cancelled: ${lesson.subject.name}`,
              body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} has been cancelled.`,
            }
          : {
              subject: `Substitute assigned: ${lesson.subject.name}`,
              body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} will be covered by a substitute teacher.`,
            },
    });
  }

  /**
   * In-app (and optionally email) notice about a lesson change. Fans out to the
   * lesson's class (students + guardians) and to the teachers involved.
   */
  private async notifyLessonAudience(
    tx: PrismaClient,
    lesson: {
      schoolId: string;
      studentGroupId: string;
      startsAt: Date;
      subject: { name: string };
    },
    options: {
      type: NotificationKind;
      teacherIds: string[];
      email?: { subject: string; body: string };
    },
  ): Promise<void> {
    const groupRecipients = await this.notifications.recipientsForGroups(tx, [
      lesson.studentGroupId,
    ]);
    const recipients = [...new Set([...groupRecipients, ...options.teacherIds])];
    await this.notifications.notifyUsers(tx, {
      schoolId: lesson.schoolId,
      userIds: recipients,
      type: options.type,
      meta: {
        subjectName: lesson.subject.name,
        startsAt: lesson.startsAt.toISOString(),
      },
      ...(options.email ? { email: options.email } : {}),
    });
  }
}
