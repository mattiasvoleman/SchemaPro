import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, TeacherQualificationKind } from '@prisma/client';
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

/**
 * A vikarie assigned, with what the staffing policy says about their behörighet
 * for this lesson (STAFF_TEACHER_NOT_QUALIFIED) — a warning even when the policy
 * says REFUSE; see assignSubstitute.
 */
export interface SubstituteResult extends LessonActionResult {
  warnings: StaffingWarning[];
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

interface LessonForAction {
  id: string;
  schoolId: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  note: string | null;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  subjectId: string;
  studentGroupId: string;
  subject: { name: string };
  teachers: { teacherId: string }[];
  /** The lesson's attendance beyond its class, for the grade span a vikarie is asked about. */
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
}

const lessonGroupIds = (lesson: LessonForAction): string[] => [
  lesson.studentGroupId,
  ...(lesson.extraGroups ?? []).map((row) => row.studentGroupId),
];
const lessonStudentIds = (lesson: LessonForAction): string[] =>
  (lesson.participants ?? []).map((row) => row.studentId);

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
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status !== 'SCHEDULED') {
        throw new BadRequestException('Only scheduled lessons can be cancelled.');
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: { status: 'CANCELLED', note: dto.reason ?? lesson.note },
        select: { id: true, status: true, note: true },
      });

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
      return updated;
    });
  }

  async reinstate(id: string, user: AuthenticatedUser): Promise<LessonActionResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status !== 'CANCELLED') {
        throw new BadRequestException('Only cancelled lessons can be reinstated.');
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: { status: 'SCHEDULED' },
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      this.logger.log(`Lesson reinstated [lesson=${id}]`);
      return updated;
    });
  }

  /**
   * Replaces the lesson's teacher assignments with a single SUBSTITUTE
   * assignment. The substitute must be an active teacher in the same school
   * and free at the lesson's time.
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
   * load report is computed from the timplan, not from lessons.
   */
  async assignSubstitute(
    id: string,
    dto: AssignSubstituteDto,
    user: AuthenticatedUser,
  ): Promise<SubstituteResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status === 'COMPLETED') {
        throw new BadRequestException('Completed lessons cannot be reassigned.');
      }

      const substitute = await tx.user.findUnique({
        where: { id: dto.teacherId },
        select: { id: true, role: true, isActive: true },
      });
      if (!substitute || !substitute.isActive || substitute.role !== 'TEACHER') {
        throw new BadRequestException('The substitute must be an active teacher.');
      }

      // The substitute must not already teach an overlapping lesson.
      if (await this.teacherHasClash(tx, dto.teacherId, lesson)) {
        throw new ConflictException(
          'The substitute already teaches another lesson at this time.',
        );
      }

      const group = await tx.studentGroup.findUnique({
        where: { id: lesson.studentGroupId },
        select: { academicYearId: true, academicYear: { select: { isActive: true, predecessorId: true } } },
      });
      const lessonDay = lesson.date.toISOString().slice(0, 10);
      const warnings = group
        ? settleFindings(
            await lessonQualificationFindings(tx, {
              schoolId: lesson.schoolId,
              academicYearId: group.academicYearId,
              subjectId: lesson.subjectId,
              // The whole attendance, as the master-lesson PATCH asks it.
              groupIds: lessonGroupIds(lesson),
              studentIds: lessonStudentIds(lesson),
              assignees: [{ userId: dto.teacherId, role: 'SUBSTITUTE' }],
              window: { startDate: lessonDay, endDate: lessonDay },
              // The year's roster basis from the flags just read: a lesson of
              // a rolled year not yet activated spans the grades its
              // activation would place (projected-rosters.ts).
              rosters: { viewer: user, known: group.academicYear },
            }),
            { downgrade: true },
          )
        : [];

      const outgoingTeacherIds = lesson.teachers.map((t) => t.teacherId);
      await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: id } });
      await tx.calendarLessonTeacher.create({
        data: {
          schoolId: lesson.schoolId,
          calendarLessonId: id,
          teacherId: dto.teacherId,
          role: 'SUBSTITUTE',
        },
      });

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: dto.note !== undefined ? { note: dto.note } : {},
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      // Notify the class and both the outgoing teacher(s) and the substitute.
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_SUBSTITUTE',
        teacherIds: [...outgoingTeacherIds, dto.teacherId],
        email: {
          subject: `Substitute assigned: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} will be covered by a substitute teacher.`,
        },
      });
      // Ids only in logs — never teacher names.
      this.logger.log(`Substitute assigned [lesson=${id}]`);
      return { ...updated, warnings };
    });
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
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status === 'COMPLETED') {
        throw new BadRequestException('Completed lessons cannot be changed.');
      }
      // No-op: same room and nothing else to record — return without notifying.
      if (lesson.roomId === dto.roomId && dto.note === undefined) {
        return { id: lesson.id, status: lesson.status, note: lesson.note };
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
      return updated;
    });
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
   * enforces, so every suggestion is guaranteed to be assignable.
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

      const suggestions: SubstituteSuggestion[] = [];
      for (const teacher of teachers) {
        if (await this.teacherHasClash(tx, teacher.id, lesson)) continue;
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
    const group = await tx.studentGroup.findUnique({
      where: { id: lesson.studentGroupId },
      select: { academicYearId: true, academicYear: { select: { isActive: true, predecessorId: true } } },
    });
    if (!group) return null;
    // The derivation the assignment's own warning uses (attendanceSpan), so
    // the badge here and the warning after the click read one span.
    return attendanceSpan(tx, {
      academicYearId: group.academicYearId,
      groupIds: lessonGroupIds(lesson),
      studentIds: lessonStudentIds(lesson),
      rosters: { viewer, known: group.academicYear },
    });
  }

  /** True when the teacher already teaches another scheduled lesson that overlaps. */
  private async teacherHasClash(
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

  private async requireLesson(
    tx: PrismaClient,
    id: string,
  ): Promise<LessonForAction> {
    const lesson = await tx.calendarLesson.findUnique({
      where: { id },
      select: {
        id: true,
        schoolId: true,
        status: true,
        note: true,
        date: true,
        startsAt: true,
        endsAt: true,
        roomId: true,
        subjectId: true,
        studentGroupId: true,
        subject: { select: { name: true } },
        teachers: { select: { teacherId: true } },
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
