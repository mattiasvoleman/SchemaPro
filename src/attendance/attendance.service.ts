import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { parseDateString, zonedTimeToUtc } from '../common/utils/time';
import { recordRead } from '../access-log/access-log';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { calendarLessonRosters, type CalendarRosterLesson } from '../calendar/lesson-roster';
import type { ReportAttendanceDto } from './dto/report-attendance.dto';

export interface AttendanceReportResult {
  created: number;
  updated: number;
}

/** The pupils of a lesson whose absence was reported before it. */
export interface ReportedAbsencesResult {
  studentIds: string[];
}

/** A pupil on a register: who, and the name the list shows. */
export interface RosterPupil {
  id: string;
  firstName: string;
  lastName: string;
}

/** The pupils a register lists for a lesson. */
export interface LessonRosterResult {
  students: RosterPupil[];
}

/** A lesson's attendance marks, as the register opens with them. */
export interface LessonAttendanceResult {
  records: Array<{
    id: string;
    calendarLessonId: string;
    studentId: string;
    status: string;
    recordedAt: string | null;
    note: string | null;
  }>;
}

/** A class's attendance over a period, for the administrator's report. */
export interface GroupAttendanceResult {
  records: Array<{
    studentId: string;
    status: string;
    lesson: { id: string; date: string; startsAt: string; endsAt: string };
  }>;
}

/** The dashboard's attendance figure: how many marks, how many of them present or late. Counts only. */
export interface AttendanceSummaryResult {
  recorded: number;
  present: number;
}

/** The most rows a class report returns, as the web's direct read did. */
export const GROUP_ATTENDANCE_LIMIT = 20_000;
/** The longest period a class report reads at once. */
export const GROUP_ATTENDANCE_MAX_DAYS = 400;

/** The lesson as the register and the absence check read it. */
const LESSON_SELECT = {
  id: true,
  schoolId: true,
  studentGroupId: true,
  date: true,
  startsAt: true,
  endsAt: true,
  subject: { select: { name: true } },
  // `startsAt`/`endsAt` are instants, absence reports are bare wall-clock
  // times. The school's zone is the only thing that relates the two — see
  // coveredBy.
  school: { select: { timezone: true } },
  extraGroups: { select: { studentGroupId: true } },
} as const satisfies Prisma.CalendarLessonSelect;

/**
 * An absence reported for a day, as app.reported_absences answers it: the
 * pupil and the wall-clock times, both null for the whole day. Never the
 * note or the type — see reportedAbsencesOn.
 */
interface ReportedAbsence {
  studentId: string;
  startTime: Date | null;
  endTime: Date | null;
}

/** The parts of a lesson that decide whether a report covers it. */
interface LessonClock {
  date: Date;
  startsAt: Date;
  endsAt: Date;
  school: { timezone: string };
}

/**
 * Processes batched attendance reports from mobile devices.
 *
 * ## Authorization
 *
 * Two checks, and they are not the same kind of check.
 *
 * The teacher-assignment check duplicates RLS: `attendance_teacher_insert` /
 * `attendance_teacher_update` would reject the write anyway, so failing fast
 * here only keeps error messages clear and avoids wasted round-trips.
 *
 * The roster check does not. No policy on `AttendanceRecords` places any
 * predicate on `studentId`, so this service is currently the *only* thing
 * standing between a teacher and an official attendance row — plus the
 * guardian alert it triggers — against a pupil who was never in the room.
 * Until the same predicate exists as a policy, do not weaken it and do not
 * move it out of the write transaction.
 *
 * ## Rate limiting
 *
 * Throttling is handled at the controller layer via `@nestjs/throttler` to
 * protect the endpoint during high-concurrency morning check-in peaks.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async reportAttendance(
    dto: ReportAttendanceDto,
    user: AuthenticatedUser,
  ): Promise<AttendanceReportResult> {
    return this.prisma.withRls(user, async (tx) => {
      // Verify the lesson exists (RLS will scope this to the caller's school).
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: dto.calendarLessonId },
        select: LESSON_SELECT,
      });

      if (!lesson) {
        throw new NotFoundException(
          `Calendar lesson not found: ${dto.calendarLessonId}`,
        );
      }

      // For teachers: verify they are explicitly assigned to this lesson.
      // SCHOOL_ADMIN is trusted to record for any lesson in their school.
      if (user.role === Role.TEACHER) {
        await this.assertTeacherIsAssigned(
          tx,
          dto.calendarLessonId,
          user,
        );
      }

      // Every role, admins included: being allowed to record for the lesson
      // says nothing about who was in the room. Resolved inside the same
      // transaction as the writes, so a membership removed concurrently cannot
      // let a row slip through between the check and the upsert.
      const studentIds = [...new Set(dto.records.map((entry) => entry.studentId))];
      await this.assertStudentsAreOnRoster(tx, lesson, studentIds);

      // At a school that shares attendance with integrations each status
      // written moves a version the SS12000 provider reads, one upsert at a
      // time, and an SS12000 apply that links pupils moves all of theirs and
      // holds them to its end: wait for a running apply before the first
      // write, so neither holds one the other waits for (20261114090000).
      await tx.$executeRaw(Prisma.sql`SELECT app.attendance_recording_waits_for_sync()`);

      let created = 0;
      let updated = 0;

      /**
       * What the register said before this batch.
       *
       * The guardian alert is about a pupil BECOMING absent, not about a
       * request arriving. The device queue retries whenever a response is lost,
       * and the write itself is idempotent — upsert on (lesson, student) — but
       * the alert was not: every retry sent the guardian the same "oanmäld
       * frånvaro" again. Notifications carry no natural key to deduplicate on,
       * and inventing one would be describing the symptom; the transition is
       * the thing that is actually new.
       */
      const priorStatus = new Map(
        (
          await tx.attendanceRecord.findMany({
            where: { calendarLessonId: dto.calendarLessonId, studentId: { in: studentIds } },
            select: { studentId: true, status: true },
          })
        ).map((row) => [row.studentId, row.status]),
      );

      const now = new Date();
      const recordedById = user.userId ?? null;

      /**
       * When the teacher marked it, not when the network came back.
       *
       * The offline queue can hold a batch for a day, and stamping arrival time
       * puts a whole class in the register at one instant hours after the
       * lesson — which is what an absence follow-up is then read from. The
       * client's clock is not trusted blindly: a time in the future, or older
       * than a school term, is the device being wrong rather than the teacher
       * being late, and the server's own clock is the safer answer there.
       */
      const MAX_BACKDATE_MS = 120 * 24 * 60 * 60 * 1000;
      const recordedAtOf = (value: string | undefined): Date => {
        if (!value) return now;
        const claimed = new Date(value);
        if (Number.isNaN(claimed.getTime())) return now;
        const age = now.getTime() - claimed.getTime();
        return age < 0 || age > MAX_BACKDATE_MS ? now : claimed;
      };

      // Use upsert for idempotency — mobile devices may re-send if the first
      // attempt was lost while offline.
      for (const entry of dto.records) {
        const result = await tx.attendanceRecord.upsert({
          where: {
            calendarLessonId_studentId: {
              calendarLessonId: dto.calendarLessonId,
              studentId: entry.studentId,
            },
          },
          create: {
            schoolId: lesson.schoolId,
            calendarLessonId: dto.calendarLessonId,
            studentId: entry.studentId,
            status: entry.status,
            recordedById,
            recordedAt: recordedAtOf(entry.recordedAt),
            note: entry.note ?? null,
          },
          update: {
            status: entry.status,
            recordedById,
            recordedAt: recordedAtOf(entry.recordedAt),
            note: entry.note ?? null,
          },
          select: { createdAt: true, updatedAt: true },
        });

        // Prisma upsert doesn't distinguish create vs update, so compare timestamps.
        const wasCreated =
          result.createdAt.getTime() === result.updatedAt.getTime();
        if (wasCreated) {
          created++;
        } else {
          updated++;
        }
      }

      this.logger.log(
        `Attendance reported [lesson=${dto.calendarLessonId}, created=${created}, updated=${updated}]`,
      );

      // Skola24-style guardian alert: a student was marked ABSENT without a
      // prior absence report covering this lesson.
      const absentIds = dto.records
        .filter(
          (entry) =>
            entry.status === 'ABSENT' &&
            // Already absent in the register: this batch changed nothing about
            // them, so there is nothing to tell a guardian that was not told
            // the first time. A correction from PRESENT to ABSENT is a real
            // transition and does alert.
            priorStatus.get(entry.studentId) !== 'ABSENT',
        )
        .map((entry) => entry.studentId);
      if (absentIds.length > 0) {
        const lessonDate = toDateString(lesson.date);
        const covered = coveredBy(await reportedAbsencesOn(tx, lesson.date), lesson);
        const unreported = absentIds.filter((studentId) => !covered.has(studentId));
        if (unreported.length > 0) {
          const students = await tx.user.findMany({
            where: { id: { in: unreported } },
            select: { id: true, firstName: true, lastName: true },
          });
          for (const student of students) {
            const guardianIds = await this.notifications.guardiansOf(tx, [student.id]);
            if (guardianIds.length === 0) continue;
            const studentName = `${student.firstName} ${student.lastName}`;
            await this.notifications.notifyUsers(tx, {
              schoolId: lesson.schoolId,
              userIds: guardianIds,
              type: 'ABSENCE_UNREPORTED',
              meta: {
                studentName,
                subjectName: lesson.subject.name,
                date: lessonDate,
              },
              email: {
                subject: 'Unreported absence / Oanmäld frånvaro',
                body:
                  `${studentName} was marked absent from ${lesson.subject.name} on ` +
                  `${lessonDate} without a prior absence report.\n\n` +
                  `${studentName} markerades frånvarande från ${lesson.subject.name} den ` +
                  `${lessonDate} utan föranmäld frånvaro.`,
              },
            });
          }
        }
      }

      return { created, updated };
    });
  }

  /**
   * The pupils of a lesson whose absence was reported before it, by a
   * guardian, an adult pupil or a granted leave: what the attendance list
   * opens with as Anmäld frånvaro.
   *
   * Narrower than what app.reported_absences answers. A TEACHER asks only for
   * a lesson they are assigned to, the same rule as recording it, and hears
   * only of pupils on its roster. The teacher learns that a pupil in front of
   * them is away, not who else in the school is, and never why.
   */
  async reportedAbsences(
    calendarLessonId: string,
    user: AuthenticatedUser,
  ): Promise<ReportedAbsencesResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: calendarLessonId },
        select: LESSON_SELECT,
      });

      if (!lesson) {
        throw new NotFoundException(
          `Calendar lesson not found: ${calendarLessonId}`,
        );
      }

      if (user.role === Role.TEACHER) {
        await this.assertTeacherIsAssigned(tx, calendarLessonId, user);
      }

      const covered = [
        ...coveredBy(await reportedAbsencesOn(tx, lesson.date), lesson),
      ];
      if (covered.length === 0) return { studentIds: [] };
      const roster = await this.rosterAmong(tx, lesson, covered);
      const studentIds = covered.filter((studentId) => roster.has(studentId)).sort();
      // That a pupil's absence was reported is the report's, even without
      // its note: in the läslogg as ABSENCE_REPORTS.
      await recordRead(tx, 'ABSENCE_REPORTS', studentIds, user.channel);
      return { studentIds };
    });
  }

  /**
   * The pupils the register lists for the lesson, by name: its active pupils,
   * as the one roster reader answers it (calendar/lesson-roster.ts), which is
   * also the list the teacher app caches and the broadcast replaces. The web
   * register and the teacher app assembled the same union themselves, from
   * four reads of their own, until they asked here; now a change to who
   * attends a lesson reaches both lists and the check that accepts the
   * register (RECORDED, a superset of this list: see
   * assertStudentsAreOnRoster) at once.
   *
   * Names only, no contact details: the list shows a name and takes a
   * status. A teacher must be assigned to the lesson, as for the report the
   * list is taken for and for reportedAbsences beside it.
   */
  async lessonRoster(
    calendarLessonId: string,
    user: AuthenticatedUser,
  ): Promise<LessonRosterResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: calendarLessonId },
        select: LESSON_SELECT,
      });

      if (!lesson) {
        throw new NotFoundException(
          `Calendar lesson not found: ${calendarLessonId}`,
        );
      }

      if (user.role === Role.TEACHER) {
        await this.assertTeacherIsAssigned(tx, calendarLessonId, user);
      }

      const rosters = await calendarLessonRosters(tx, [lesson], { pupils: 'ACTIVE' });
      const roster = [...(rosters.get(lesson.id) ?? [])];
      if (roster.length === 0) return { students: [] };
      const students = await tx.user.findMany({
        where: { id: { in: roster } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      });
      // The register's hot path: the read log leaves out whoever this
      // teacher already read on a roster in the last quarter-hour, so the
      // list opened again and again within a lesson writes once.
      await recordRead(tx, 'ROSTER', students.map((student) => student.id), user.channel);
      return { students };
    });
  }

  /**
   * The marks already recorded for a lesson, as the register opens with them
   * (the web's useLessonAttendance read them from PostgREST until Läslogg).
   * The same door as the roster: an unknown lesson is a 404, and a teacher
   * must be assigned to it. ATTENDANCE in the läslogg.
   */
  async lessonRecords(
    calendarLessonId: string,
    user: AuthenticatedUser,
  ): Promise<LessonAttendanceResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: calendarLessonId },
        select: { id: true },
      });
      if (!lesson) {
        throw new NotFoundException(
          `Calendar lesson not found: ${calendarLessonId}`,
        );
      }
      if (user.role === Role.TEACHER) {
        await this.assertTeacherIsAssigned(tx, calendarLessonId, user);
      }
      const rows = await tx.attendanceRecord.findMany({
        where: { calendarLessonId },
        select: {
          id: true,
          calendarLessonId: true,
          studentId: true,
          status: true,
          recordedAt: true,
          note: true,
        },
        orderBy: [{ studentId: 'asc' }],
      });
      await recordRead(tx, 'ATTENDANCE', rows.map((row) => row.studentId), user.channel);
      return {
        records: rows.map((row) => ({
          ...row,
          recordedAt: row.recordedAt ? row.recordedAt.toISOString() : null,
        })),
      };
    });
  }

  /**
   * A class's attendance over a period: every mark of a pupil whose home
   * class is the group, on a lesson dated from..to (the administrator's
   * attendance report; read from PostgREST until Läslogg). At most
   * GROUP_ATTENDANCE_LIMIT marks, as the direct read was. ATTENDANCE in the
   * läslogg, naming the pupils whose marks were returned.
   */
  async groupRecords(
    groupId: string,
    fromDay: string,
    toDay: string,
    user: AuthenticatedUser,
  ): Promise<GroupAttendanceResult> {
    const from = parseDateString(fromDay);
    const to = parseDateString(toDay);
    if (to < from) {
      throw new BadRequestException('to must not be before from.');
    }
    if ((to.getTime() - from.getTime()) / 86_400_000 > GROUP_ATTENDANCE_MAX_DAYS) {
      throw new BadRequestException(`A report reads at most ${GROUP_ATTENDANCE_MAX_DAYS} days at once.`);
    }
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.attendanceRecord.findMany({
        where: {
          student: { studentGroupId: groupId },
          calendarLesson: { date: { gte: from, lte: to } },
        },
        select: {
          studentId: true,
          status: true,
          calendarLesson: { select: { id: true, date: true, startsAt: true, endsAt: true } },
        },
        orderBy: [{ calendarLesson: { startsAt: 'asc' } }, { id: 'asc' }],
        take: GROUP_ATTENDANCE_LIMIT,
      });
      await recordRead(tx, 'ATTENDANCE', rows.map((row) => row.studentId), user.channel);
      return {
        records: rows.map((row) => ({
          studentId: row.studentId,
          status: row.status,
          lesson: {
            id: row.calendarLesson.id,
            date: toDateString(row.calendarLesson.date),
            startsAt: row.calendarLesson.startsAt.toISOString(),
            endsAt: row.calendarLesson.endsAt.toISOString(),
          },
        })),
      };
    });
  }

  /** The dashboard's attendance figure since a day. Counts only, so not in the läslogg. */
  async summary(sinceDay: string, user: AuthenticatedUser): Promise<AttendanceSummaryResult> {
    const since = parseDateString(sinceDay);
    const groups = await this.prisma.queryWithRls(user, (db) =>
      db.attendanceRecord.groupBy({
        by: ['status'],
        where: { recordedAt: { gte: since } },
        _count: { _all: true },
      }),
    );
    let recorded = 0;
    let present = 0;
    for (const group of groups) {
      recorded += group._count._all;
      if (group.status === 'PRESENT' || group.status === 'LATE') present += group._count._all;
    }
    return { recorded, present };
  }

  // ---------------------------------------------------------------------------

  private async assertTeacherIsAssigned(
    tx: Prisma.TransactionClient,
    calendarLessonId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (!user.userId) {
      throw new ForbiddenException(
        'Teacher userId is missing from the authentication token.',
      );
    }

    const assignment = await tx.calendarLessonTeacher.findUnique({
      where: {
        calendarLessonId_teacherId: {
          calendarLessonId,
          teacherId: user.userId,
        },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw new ForbiddenException(
        'You are not assigned to this lesson and cannot record attendance for it.',
      );
    }
  }

  /**
   * Rejects the batch unless every student on it belongs to the lesson.
   *
   * The roster is the union of four membership sources: the lesson's own
   * class, any extra classes joined to it, teaching-group membership of any of
   * those groups (a nivågrupp or språkval group has no home-class members at
   * all — its roster lives entirely in StudentGroupMembers), and students
   * named on the lesson individually. The list the teacher ticks down is the
   * active pupils of this set, from the same reader (lessonRoster, and the
   * teacher app's broadcast); this check asks it for the recorded ones and
   * accepts nobody outside them, rather than trusting the client.
   *
   * Membership is deliberately not filtered by `isActive` or `role`: a batch
   * queued on a teacher's phone must still drain after the pupil has been
   * deactivated, and being wrongly listed in a group is a catalogue problem,
   * not the forged-attendance one this guards against.
   *
   * Cross-tenant ids need no separate check — every query below runs inside
   * the caller's RLS transaction, so a student from another school is simply
   * absent from all three results and lands in `strangers`.
   */
  private async assertStudentsAreOnRoster(
    tx: Prisma.TransactionClient,
    lesson: CalendarRosterLesson,
    studentIds: string[],
  ): Promise<void> {
    const roster = await this.rosterAmong(tx, lesson, studentIds);
    const strangers = studentIds.filter((studentId) => !roster.has(studentId));
    if (strangers.length > 0) {
      // The ids are what an admin needs: they are what the mobile client sent
      // and what the group membership must be corrected against.
      throw new ForbiddenException(
        `These students are not on the roster for lesson ${lesson.id}: ` +
          `${strangers.join(', ')}. Attendance can only be recorded for ` +
          'students in the lesson group, in a group joined to the lesson, or ' +
          'named as individual participants — correct the group membership ' +
          'before reporting.',
      );
    }
  }

  /**
   * Which of `studentIds` are on the lesson's roster, by the sources above,
   * as the one roster reader answers it (calendar/lesson-roster.ts, which the
   * lesson notices ask too). Membership as recorded: see above. The roster
   * check refuses the rest; reportedAbsences leaves them out.
   */
  private async rosterAmong(
    tx: Prisma.TransactionClient,
    lesson: CalendarRosterLesson,
    studentIds: string[],
  ): Promise<Set<string>> {
    const rosters = await calendarLessonRosters(tx, [lesson], { pupils: 'RECORDED', among: studentIds });
    return rosters.get(lesson.id) ?? new Set<string>();
  }
}

/**
 * The absences reported at the caller's school for the day of `date`.
 *
 * Asked of app.reported_absences (20261015120000), not of the table: a
 * TEACHER reads no AbsenceReports row, because the row carries the note a
 * guardian or an adult pupil wrote to the school, and the type of the
 * absence. The function answers who and between which times, to a TEACHER
 * or a SCHOOL_ADMIN of the school. The admin asks it too, so what the
 * register sees of a report has one rule.
 */
function reportedAbsencesOn(
  tx: Prisma.TransactionClient,
  date: Date,
): Promise<ReportedAbsence[]> {
  return tx.$queryRaw<ReportedAbsence[]>(
    Prisma.sql`SELECT "studentId", "startTime", "endTime" FROM app.reported_absences(${toDateString(date)}::date)`,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers. `date` is a calendar day and `startTime`/`endTime` are bare
// wall-clock times, so both are read in UTC parts — that is how Prisma hands
// back `@db.Date` and `@db.Time` regardless of the server's locale.
// ---------------------------------------------------------------------------

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The pupils whose report covers the lesson; a report without both times is the whole day. */
function coveredBy(
  reports: readonly ReportedAbsence[],
  lesson: LessonClock,
): Set<string> {
  const lessonDate = toDateString(lesson.date);
  return new Set(
    reports
      .filter((report) => {
        if (!report.startTime || !report.endTime) return true; // full day
        // A guardian reporting "away 08:00-12:00" means local clock time;
        // the lesson is a real instant. Lift the report onto the lesson's
        // date through the same conversion that materialised the lesson
        // (see CalendarService.publish) so the two are the same unit —
        // comparing the raw UTC parts is off by the zone offset, which in
        // Europe/Stockholm is one or two hours every day of the year.
        const start = zonedTimeToUtc(
          lessonDate,
          timeToString(report.startTime),
          lesson.school.timezone,
        );
        const end = zonedTimeToUtc(
          lessonDate,
          timeToString(report.endTime),
          lesson.school.timezone,
        );
        return (
          start.getTime() < lesson.endsAt.getTime() &&
          lesson.startsAt.getTime() < end.getTime()
        );
      })
      .map((report) => report.studentId),
  );
}

function timeToString(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  const s = time.getUTCSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
