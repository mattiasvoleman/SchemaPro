import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type ClassTeacherChange, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { MasterLessonsService, type DayLesson } from '../calendar/master-lessons.service';
import { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import { reconcilableLessons, wouldRemoveOnUpdate } from '../calendar/propagate-template';
import { isoWeekday } from '../calendar/publish-days';
import { substituteNotedLessons } from '../lesson-log/substitute-noted';
import type { GradeNumbering } from '../common/grade-numbering';
import { boardCodeOf, readBoardFacts } from '../swaps/board-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import { enterGrundschemaWrite, publishModeOf, type PublishMode } from '../publication/publish-mode';
import { lockLessons } from '../cover/cover-decisions';
import { schoolTimezone } from '../cover/cover-context';
import { scopeOf } from '../calendar/lesson-roster';
import { parseDateString, toWallClock, zonedTimeToUtc } from '../common/utils/time';
import { requireSchoolId } from '../common/utils/request-context';
import { datedConflicts, localMinutes, type DatedContext } from './dated-conflicts';
import {
  isOccasionKind,
  type ChangeKind,
  type ChangeView,
  type ConflictView,
  type FieldChange,
  type FrameReason,
  type PublishOutcome,
  type RemovalView,
  type Verdict,
} from './class-teacher.types';

/** A draft as the Prisma client hands it. */
export type ChangeRow = ClassTeacherChange;

const minutesOf = (time: Date): number => Number(toWallClock(time).slice(0, 2)) * 60 + Number(toWallClock(time).slice(3));
const dayString = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);
const clockString = (time: Date | null): string | null => (time ? toWallClock(time) : null);
/** HH:MM on the school's clock of an instant. */
const clockOfInstant = (instant: Date, timezone: string): string => {
  const minutes = localMinutes(instant, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

export function toChangeView(row: ChangeRow): ChangeView {
  return {
    id: row.id,
    studentGroupId: row.studentGroupId,
    kind: row.kind,
    status: row.status,
    masterLessonId: row.masterLessonId,
    calendarLessonId: row.calendarLessonId,
    date: dayString(row.date),
    targetDate: dayString(row.targetDate),
    targetDayOfWeek: row.targetDayOfWeek,
    targetStart: clockString(row.targetStart),
    targetEnd: clockString(row.targetEnd),
    targetRoomId: row.targetRoomId,
    keepEnd: clockString(row.keepEnd),
    note: row.note,
    baseVersion: row.baseVersion,
    rev: row.rev,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

/** What differs between two snapshots of a lesson, field by field. Pure. */
export function diffSnapshots(was: unknown, now: unknown): FieldChange[] {
  const a = (was && typeof was === 'object' ? was : {}) as Record<string, unknown>;
  const b = (now && typeof now === 'object' ? now : {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return fields
    .filter((field) => JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null))
    .map((field) => ({ field, was: a[field] ?? null, now: b[field] ?? null }));
}

/**
 * The parts of a draft the frame function reads, as the SQL arguments it takes.
 * `creating` is true only for a draft not yet written.
 */
export interface FrameInput {
  teacherId: string | null;
  studentGroupId: string;
  kind: ChangeKind;
  masterLessonId: string | null;
  calendarLessonId: string | null;
  targetDate: string | null;
  targetDayOfWeek: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  targetRoomId: string | null;
  keepEnd: string | null;
}

export const frameInputOf = (row: ChangeRow): FrameInput => ({
  teacherId: row.authorId,
  studentGroupId: row.studentGroupId,
  kind: row.kind,
  masterLessonId: row.masterLessonId,
  calendarLessonId: row.calendarLessonId,
  targetDate: dayString(row.targetDate),
  targetDayOfWeek: row.targetDayOfWeek,
  targetStart: clockString(row.targetStart),
  targetEnd: clockString(row.targetEnd),
  targetRoomId: row.targetRoomId,
  keepEnd: clockString(row.keepEnd),
});

/** Asks the database's frame (app.class_teacher_frame); null when the change is the teacher's to make. */
export async function askFrame(tx: PrismaClient, input: FrameInput, creating: boolean): Promise<FrameReason | null> {
  const rows = await tx.$queryRaw<{ reason: string | null }[]>(Prisma.sql`
    SELECT app.class_teacher_frame(
      ${input.teacherId}::uuid, ${input.studentGroupId}::uuid, ${input.kind}::"ClassTeacherChangeKind",
      ${input.masterLessonId}::uuid, ${input.calendarLessonId}::uuid,
      ${input.targetDate}::date, ${input.targetDayOfWeek}::integer, ${input.targetStart}::time, ${input.targetEnd}::time,
      ${input.targetRoomId}::uuid, ${input.keepEnd}::time, ${creating}::boolean) AS "reason"`);
  return (rows[0]?.reason ?? null) as FrameReason | null;
}

/** The lesson's version and snapshot as the database has them now; null when it is gone. */
export async function lessonState(
  tx: PrismaClient,
  layer: 'master' | 'calendar',
  lessonId: string,
): Promise<{ version: string; snapshot: Record<string, unknown> } | null> {
  const rows =
    layer === 'master'
      ? await tx.$queryRaw<{ version: string | null; snapshot: Record<string, unknown> | null }[]>(
          Prisma.sql`SELECT app.class_teacher_master_version(${lessonId}::uuid) AS "version", app.class_teacher_master_snapshot(${lessonId}::uuid) AS "snapshot"`,
        )
      : await tx.$queryRaw<{ version: string | null; snapshot: Record<string, unknown> | null }[]>(
          Prisma.sql`SELECT app.class_teacher_calendar_version(${lessonId}::uuid) AS "version", app.class_teacher_calendar_snapshot(${lessonId}::uuid) AS "snapshot"`,
        );
  const row = rows[0];
  if (!row || row.version === null || row.snapshot === null) return null;
  return { version: row.version, snapshot: row.snapshot };
}

/** What a verdict is asked for. */
export interface EvaluateOptions {
  /** A NEW draft, not yet written: a change waiting on the other layer stops it. */
  creating?: boolean;
  /**
   * The verdict goes to a klasslärare and not to an administrator. In a school
   * that publishes through a draft the grundschema is hidden from teachers
   * (20261011100000), so a clash with it is named by its kind alone: "the room
   * is taken", never whose lesson or when.
   */
  forTeacher?: boolean;
}

/**
 * A klasslärare's drafts, judged and carried out.
 *
 * ONE CHECK. A draft is judged by the rules the schemaläggare's editor holds a
 * placement to, and by no rules of its own: the clash rule
 * (MasterLessonsService.findConflicts) for the grundschema and, held against
 * the date's lessons, for one date (dated-conflicts.ts); the board's three
 * hard rules, ramtid, the class's meal and a closure on årskurser, as G1's swap
 * search holds a landing to them (swaps/board-rules.ts), for both layers. The
 * frame is the database's (app.class_teacher_frame), asked again at every check
 * and every publication, since the schemaläggare may close an hour or give a
 * lesson another teacher after a draft was written.
 *
 * WHAT PUBLISHING A CHANGE OF THE TEMPLATE DOES TO THE CALENDAR is said before
 * it is done. In a school that publishes at once, MasterLessonsService.update
 * moves the future dated lessons with the template and removes the ones that
 * would land in the past or past the template's own end
 * (propagateTemplateChange; wouldRemoveOnUpdate counts them, as the swap dialog
 * does). It also rewrites the day, the time and the room of a lesson that was
 * changed for one date, which would put a moved lesson on a third day and a
 * lesson with its own room for the date back in the template's: a change of the
 * template meets such a lesson as a clash (EXCEPTION), and waits until the date
 * has passed or the lesson is put back.
 *
 * ONE WRITER. A published draft is carried out by the services the editor and
 * the day operations use (MasterLessonsService.update and create,
 * CalendarLessonsService.cancel and changeRoom), as the administrator the
 * appointment runs as, so every lock, notice and log they have is kept. The one
 * write with no service of its own, a lesson moved for one date, is below and
 * judged by datedConflicts inside its own transaction. A draft is CLAIMED before
 * it is carried out (see publishOne), so that two who publish it at once carry
 * it out once.
 */
@Injectable()
export class ClassTeacherEngine {
  private readonly logger = new Logger(ClassTeacherEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly masters: MasterLessonsService,
    private readonly dated: CalendarLessonsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Judges one draft (or an unwritten one, with `creating`) in the caller's
   * transaction. A draft already written is not stopped by the neighbour on
   * the other layer that it was written beside; a new one is.
   */
  async evaluate(tx: PrismaClient, change: ChangeRow, options: EvaluateOptions = {}): Promise<Verdict> {
    const layerIsDated = isOccasionKind(change.kind);
    const lessonId = layerIsDated ? change.calendarLessonId : change.masterLessonId;
    if (!lessonId) return { state: 'GONE' };

    const refusal = await askFrame(tx, frameInputOf(change), options.creating === true);
    if (refusal === 'LESSON_GONE') return { state: 'GONE' };
    if (refusal) return { state: 'REFUSED', reason: refusal };

    const now = await lessonState(tx, layerIsDated ? 'calendar' : 'master', lessonId);
    if (!now) return { state: 'GONE' };
    if (now.version !== change.baseVersion) {
      return { state: 'STALE', changed: diffSnapshots(change.baseSnapshot, now.snapshot) };
    }

    const mode = await publishModeOf(tx, change.schoolId);
    const conflicts = layerIsDated ? await this.occasionConflicts(tx, change) : await this.templateConflicts(tx, change, mode);
    if (conflicts.length > 0) {
      // The clashes with a draft grundschema are named by kind alone to a teacher (a clash with the calendar is the calendar's, which they read).
      const hidden = options.forTeacher === true && mode === 'DRAFT' && !layerIsDated;
      return { state: 'CONFLICT', conflicts: hidden ? conflicts.map(({ kind }) => ({ kind })) : conflicts };
    }
    const removes = mode === 'DRAFT' ? null : await this.removalOf(tx, change);
    return removes ? { state: 'OK', removes } : { state: 'OK' };
  }

  // ---------------------------------------------------------------------
  // The conflicts
  // ---------------------------------------------------------------------

  /** What the clash rule and the board read a year through: its pupils (the roster basis) and the way its årskurser are numbered. */
  private async datedContext(tx: PrismaClient, academicYearId: string): Promise<DatedContext> {
    const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { gradeNumbering: true } });
    return {
      masters: this.masters,
      basis: await rostersOfYear(tx, { role: 'SCHOOL_ADMIN' }, academicYearId),
      gradeNumbering: (year?.gradeNumbering ?? 'NIOARIG') as GradeNumbering,
    };
  }

  private async occasionConflicts(tx: PrismaClient, change: ChangeRow): Promise<ConflictView[]> {
    if (change.kind === 'OCCASION_CANCEL' || !change.calendarLessonId) return [];
    const lesson = await tx.calendarLesson.findUnique({
      where: { id: change.calendarLessonId },
      select: {
        id: true,
        date: true,
        startsAt: true,
        endsAt: true,
        roomId: true,
        subjectId: true,
        studentGroupId: true,
        studentGroup: { select: { academicYearId: true } },
        teachers: { select: { teacherId: true } },
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });
    if (!lesson) return [];
    const timezone = await schoolTimezone(tx, requireSchoolFrom(change));
    let startsAt = lesson.startsAt;
    let endsAt = lesson.endsAt;
    let date = lesson.date.toISOString().slice(0, 10);
    let roomId = lesson.roomId;
    if (change.kind === 'OCCASION_MOVE' && change.targetDate && change.targetStart && change.targetEnd) {
      date = change.targetDate.toISOString().slice(0, 10);
      startsAt = zonedTimeToUtc(date, toWallClock(change.targetStart), timezone);
      endsAt = zonedTimeToUtc(date, toWallClock(change.targetEnd), timezone);
    }
    if (change.targetRoomId) roomId = change.targetRoomId;
    return datedConflicts(tx, await this.datedContext(tx, lesson.studentGroup.academicYearId), {
      lessonId: lesson.id,
      academicYearId: lesson.studentGroup.academicYearId,
      schoolId: change.schoolId,
      subjectId: lesson.subjectId,
      date,
      startsAt,
      endsAt,
      roomId,
      studentGroupId: lesson.studentGroupId,
      teacherIds: lesson.teachers.map((row) => row.teacherId),
      extraGroupIds: lesson.extraGroups.map((row) => row.studentGroupId),
      participantIds: lesson.participants.map((row) => row.studentId),
      timezone,
    });
  }

  private async templateConflicts(tx: PrismaClient, change: ChangeRow, mode: PublishMode): Promise<ConflictView[]> {
    if (!change.masterLessonId || change.targetDayOfWeek === null || !change.targetStart || !change.targetEnd) return [];
    const lesson = await tx.masterLesson.findUnique({
      where: { id: change.masterLessonId },
      include: { extraGroups: { select: { studentGroupId: true } }, participants: { select: { studentId: true } }, subject: { select: { name: true } } },
    });
    if (!lesson) return [];
    const context = await this.datedContext(tx, lesson.academicYearId);
    const split = change.kind === 'TEMPLATE_SPLIT';
    const candidate = {
      dayOfWeek: change.targetDayOfWeek,
      startMinutes: minutesOf(change.targetStart),
      endMinutes: minutesOf(change.targetEnd),
      teacherId: lesson.teacherId,
      coTeacherId: lesson.coTeacherId,
      roomId: change.targetRoomId ?? lesson.roomId,
      extraGroupIds: [],
      studentIds: [],
      recurrence: lesson.recurrence,
      startDate: lesson.startDate,
      endDate: lesson.endDate,
    };
    const identity = { id: split ? null : lesson.id, academicYearId: lesson.academicYearId, studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId };
    // A split's second part is a new lesson beside the first, which is shorter than the lesson was: on the same
    // day it stands in the lesson's place, shortened, so it is not a clash with itself.
    const shortened: DayLesson[] =
      split && change.keepEnd && change.targetDayOfWeek === lesson.dayOfWeek
        ? [{ ...lesson, endTime: change.keepEnd, extraGroups: [], participants: [] }]
        : [];
    const hits = await this.masters.findConflicts(tx, context.basis, identity, candidate, split ? { excludeIds: [lesson.id], alongside: shortened } : {});
    const others = await tx.masterLesson.findMany({
      where: { id: { in: hits.map((hit) => hit.masterLessonId).filter((id): id is string => Boolean(id)) } },
      select: { id: true, dayOfWeek: true, startTime: true, endTime: true, subject: { select: { name: true } }, studentGroup: { select: { name: true } } },
    });
    const byId = new Map(others.map((other) => [other.id, other]));
    const views: ConflictView[] = [];
    for (const hit of hits) {
      const other = hit.masterLessonId ? byId.get(hit.masterLessonId) : undefined;
      views.push({
        kind: hit.kind,
        ...(other
          ? { other: { className: other.studentGroup.name, subjectName: other.subject.name, day: other.dayOfWeek, start: toWallClock(other.startTime), end: toWallClock(other.endTime) } }
          : {}),
      });
    }

    // The board's hard rules, as G1's swap search holds a landing to them: the new slot of the lesson (of a split, the second part).
    const groups = [lesson.studentGroupId, ...lesson.extraGroups.map((row) => row.studentGroupId)];
    const facts = await readBoardFacts(tx, {
      academicYearId: lesson.academicYearId,
      schoolId: lesson.schoolId,
      gradeNumbering: context.gradeNumbering,
      basis: context.basis,
      groupIds: groups,
      weekday: change.targetDayOfWeek,
    });
    const board = boardCodeOf(facts, groups, { dayOfWeek: change.targetDayOfWeek, startMinutes: candidate.startMinutes, endMinutes: candidate.endMinutes });
    if (board !== null) views.push({ kind: board });

    if (mode === 'DIRECT') views.push(...(await this.exceptionsOf(tx, lesson)));
    return views;
  }

  /**
   * The future dated lessons of a template that were changed for their date
   * (to another day, another hour or another room than the template's). A
   * change of the template in a school that publishes at once rewrites the day
   * (by the template's shift from where the lesson stands now), the hour and
   * the room of every such lesson (propagateTemplateChange, 'update'), which
   * carries a lesson moved from a Monday to a Tuesday to a third day and puts a
   * lesson whose room was changed for its date (OCCASION_ROOM) back in the
   * template's room, unasked and unannounced. Named by the date's lesson, so
   * that the klasslärare sees which date is in the way; the first five.
   */
  private async exceptionsOf(
    tx: PrismaClient,
    lesson: { id: string; schoolId: string; dayOfWeek: number; startTime: Date; endTime: Date; roomId: string | null; subject: { name: string }; studentGroupId: string },
  ): Promise<ConflictView[]> {
    const timezone = await schoolTimezone(tx, lesson.schoolId);
    const rows = await tx.calendarLesson.findMany({
      where: reconcilableLessons(lesson.id),
      select: { date: true, startsAt: true, endsAt: true, roomId: true, studentGroup: { select: { name: true } } },
      orderBy: { startsAt: 'asc' },
    });
    const start = minutesOf(lesson.startTime);
    const end = minutesOf(lesson.endTime);
    return rows
      .filter((row) => {
        const day = dayString(row.date)!;
        return (
          isoWeekday(day) !== lesson.dayOfWeek ||
          localMinutes(row.startsAt, timezone) !== start ||
          localMinutes(row.endsAt, timezone) !== end ||
          row.roomId !== lesson.roomId
        );
      })
      .slice(0, 5)
      .map((row) => ({
        kind: 'EXCEPTION' as const,
        other: {
          className: row.studentGroup.name,
          subjectName: lesson.subject.name,
          date: dayString(row.date)!,
          start: clockOfInstant(row.startsAt, timezone),
          end: clockOfInstant(row.endsAt, timezone),
        },
      }));
  }

  /**
   * How many of the template's future dated lessons publishing the change
   * removes (and how many of those carry a log, a homework or a note to a
   * vikarie): propagateTemplateChange's own removal decision (standsAt) asked
   * of the rows it would reconcile, before anything is written. Only a move
   * carries lessons to another day; a split leaves the first part where it is.
   */
  private async removalOf(tx: PrismaClient, change: ChangeRow): Promise<RemovalView | null> {
    if (change.kind !== 'TEMPLATE_MOVE' || !change.masterLessonId || change.targetDayOfWeek === null || !change.targetStart || !change.targetEnd) return null;
    const lesson = await tx.masterLesson.findUnique({
      where: { id: change.masterLessonId },
      select: { dayOfWeek: true, recurrence: true, startDate: true, endDate: true },
    });
    if (!lesson) return null;
    const rows = await tx.calendarLesson.findMany({
      where: reconcilableLessons(change.masterLessonId),
      select: { id: true, date: true, _count: { select: { lessonLogs: true } } },
    });
    if (rows.length === 0) return null;
    const timezone = await schoolTimezone(tx, change.schoolId);
    const now = new Date();
    const after = {
      dayOfWeek: change.targetDayOfWeek,
      startTime: change.targetStart,
      endTime: change.targetEnd,
      recurrence: lesson.recurrence,
      startDate: lesson.startDate,
      endDate: lesson.endDate,
    };
    const removed = rows.filter((row) => wouldRemoveOnUpdate([row], { dayOfWeek: lesson.dayOfWeek }, after, timezone, now) === 1);
    if (removed.length === 0) return null;
    const noted = await substituteNotedLessons(tx, removed.map((row) => row.id));
    return { lessons: removed.length, withLog: removed.filter((row) => row._count.lessonLogs > 0 || noted.has(row.id)).length };
  }

  // ---------------------------------------------------------------------
  // Carrying a draft out
  // ---------------------------------------------------------------------

  /**
   * Judges a draft and, if it passes, CLAIMS it, writes it through the editor's
   * own services as `actor`, then marks it published. Each draft is its own
   * transaction: what one does not stop another that does not need it, and a
   * draft that fails is left a draft with the reason.
   *
   * THE CLAIM. Two who publish the same draft at once (the klasslärare and the
   * schemaläggare, two tabs, two administrators) both judge it before either
   * has written, and a split written twice is two identical lessons for the
   * same teacher and class: nothing in the database refuses that, only the
   * clash rule, which neither asks again in time. The claim is a
   * compare-and-set on the draft's revision: an update of the draft that no
   * field of it shows, which the draft's guard counts up like any other
   * change, in a transaction of its own that commits before anything is
   * written. Of two claimants the database lets one count the revision up; the
   * other finds it moved and carries out nothing (GONE). A draft whose
   * carrying out fails is left a draft at the claimed revision, so the next
   * publication reads it again.
   */
  async publishOne(actor: AuthenticatedUser, change: ChangeRow, options: Pick<EvaluateOptions, 'forTeacher'> = {}): Promise<PublishOutcome> {
    const verdict = await this.prisma.withRls(actor, (tx) => this.evaluate(tx, change, options));
    switch (verdict.state) {
      case 'GONE':
        return { id: change.id, outcome: 'GONE' };
      case 'REFUSED':
        return { id: change.id, outcome: 'REFUSED', reason: verdict.reason };
      case 'STALE':
        return { id: change.id, outcome: 'STALE', changed: verdict.changed };
      case 'CONFLICT':
        return { id: change.id, outcome: 'CONFLICT', conflicts: verdict.conflicts };
      case 'OK':
        break;
    }
    // A draft that is claimed is the draft the publisher read, field for field: any edit counts the revision up and so
    // fails the claim. What the claim adds is the revision it leaves the draft at, which the mark below is made at.
    const claimed = await this.prisma.withRls(actor, async (tx) => {
      const taken = await tx.classTeacherChange.updateMany({
        where: { id: change.id, rev: change.rev, status: 'DRAFT' },
        data: { updatedAt: new Date() },
      });
      if (taken.count !== 1) return null;
      return tx.classTeacherChange.findUnique({ where: { id: change.id }, select: { rev: true } });
    });
    if (!claimed) return { id: change.id, outcome: 'GONE' };
    try {
      await this.carryOut(actor, change);
    } catch (error) {
      if (error instanceof ConflictException) {
        // The editor's own check found a clash this one did not (a write in between): named by asking again.
        const again = await this.prisma.withRls(actor, (tx) => this.evaluate(tx, change, options)).catch(() => null);
        return { id: change.id, outcome: 'CONFLICT', conflicts: again?.state === 'CONFLICT' ? again.conflicts : [] };
      }
      if (error instanceof HttpException) {
        this.logger.warn(`A class teacher change was refused by the editor [change=${change.id}, status=${error.getStatus()}]`);
        return { id: change.id, outcome: 'FAILED' };
      }
      throw error;
    }
    const marked = await this.prisma.withRls(actor, (tx) =>
      tx.classTeacherChange.updateMany({ where: { id: change.id, rev: claimed.rev, status: 'DRAFT' }, data: { status: 'PUBLISHED' } }),
    );
    if (marked.count === 0) this.logger.warn(`A class teacher change was carried out but could not be marked published [change=${change.id}]`);
    return { id: change.id, outcome: 'PUBLISHED' };
  }

  /**
   * Publishes a class's waiting drafts (or the ones named), as `actor`. A
   * clash that goes away when another draft has been carried out first (a
   * lesson moved into the hour a second lesson leaves) is met by asking again
   * after a pass that published something; nothing is retried that no draft
   * made room for. Two lessons that exchange hours are not met: each one's
   * target is the other's hour, neither comes first, and both stay drafts with
   * the clash (the schemaläggare's swap, G1, moves them together).
   */
  async publishClass(
    actor: AuthenticatedUser,
    studentGroupId: string,
    only?: readonly string[],
    options: Pick<EvaluateOptions, 'forTeacher'> = {},
  ): Promise<PublishOutcome[]> {
    const waiting = await this.prisma.withRls(actor, (tx) =>
      tx.classTeacherChange.findMany({
        where: { studentGroupId, status: 'DRAFT', ...(only ? { id: { in: [...only] } } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    const outcomes = new Map<string, PublishOutcome>();
    let pending = waiting;
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      let published = 0;
      const retry: ChangeRow[] = [];
      for (const change of pending) {
        // Read again: an earlier draft of this pass may have been the one to change the lesson this one names.
        const fresh = await this.prisma.withRls(actor, (tx) => tx.classTeacherChange.findUnique({ where: { id: change.id } }));
        if (!fresh || fresh.status !== 'DRAFT') {
          outcomes.set(change.id, { id: change.id, outcome: 'GONE' });
          continue;
        }
        const outcome = await this.publishOne(actor, fresh, options);
        outcomes.set(change.id, outcome);
        if (outcome.outcome === 'PUBLISHED') published += 1;
        // Only a clash can go away because another draft went first; a lesson that has changed under a draft stays changed.
        else if (outcome.outcome === 'CONFLICT') retry.push(fresh);
      }
      if (published === 0) break;
      pending = retry;
    }
    return waiting.map((change) => outcomes.get(change.id) ?? { id: change.id, outcome: 'GONE' as const });
  }

  private async carryOut(actor: AuthenticatedUser, change: ChangeRow): Promise<void> {
    switch (change.kind) {
      case 'OCCASION_CANCEL':
        await this.dated.cancel(change.calendarLessonId!, { reason: change.note ?? undefined, cause: 'MANUAL' }, actor);
        return;
      case 'OCCASION_ROOM':
        await this.dated.changeRoom(change.calendarLessonId!, { roomId: change.targetRoomId! }, actor);
        return;
      case 'OCCASION_MOVE':
        await this.moveOccasion(actor, change);
        return;
      case 'TEMPLATE_MOVE':
        await this.masters.update(
          change.masterLessonId!,
          {
            dayOfWeek: change.targetDayOfWeek!,
            startTime: toWallClock(change.targetStart!),
            endTime: toWallClock(change.targetEnd!),
            ...(change.targetRoomId ? { roomId: change.targetRoomId } : {}),
          },
          actor,
        );
        return;
      case 'TEMPLATE_SPLIT':
        await this.splitTemplate(actor, change);
        return;
    }
  }

  /** The first part keeps the lesson (shortened), the second is a new lesson of the same class, subject and teacher. */
  private async splitTemplate(actor: AuthenticatedUser, change: ChangeRow): Promise<void> {
    const original = await this.prisma.withRls(actor, (tx) =>
      tx.masterLesson.findUnique({ where: { id: change.masterLessonId! } }),
    );
    if (!original) throw new ConflictException('The lesson is gone.');
    const originalEnd = toWallClock(original.endTime);
    // Shorter first, so a second part on the same day finds the hour free; undone if the second cannot be made.
    await this.masters.update(original.id, { endTime: toWallClock(change.keepEnd!) }, actor);
    try {
      await this.masters.create(
        {
          academicYearId: original.academicYearId,
          subjectId: original.subjectId,
          studentGroupId: original.studentGroupId,
          teacherId: original.teacherId,
          coTeacherId: original.coTeacherId,
          roomId: change.targetRoomId ?? original.roomId,
          dayOfWeek: change.targetDayOfWeek!,
          startTime: toWallClock(change.targetStart!),
          endTime: toWallClock(change.targetEnd!),
          isLocked: original.isLocked,
          recurrence: original.recurrence,
          startDate: dayString(original.startDate) ?? undefined,
          endDate: dayString(original.endDate) ?? undefined,
        },
        actor,
      );
    } catch (error) {
      await this.masters.update(original.id, { endTime: originalEnd }, actor).catch((undo: unknown) => {
        this.logger.error(`A split could not be undone [lesson=${original.id}, error=${undo instanceof Error ? undo.name : 'unknown'}]`);
      });
      throw error;
    }
  }

  /**
   * One date's lesson goes to another time, day or room. There is no service
   * for it: the day operations cancel, reinstate, cover and change a room. The
   * lesson is locked, judged once more by datedConflicts under that lock, and
   * the class, its guardians and its teachers are told.
   */
  private async moveOccasion(actor: AuthenticatedUser, change: ChangeRow): Promise<void> {
    const schoolId = requireSchoolId(actor);
    const targetDate = dayString(change.targetDate)!;
    const touched = await this.prisma.withRls(actor, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      await lockLessons(tx, [change.calendarLessonId!]);
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: change.calendarLessonId! },
        select: {
          id: true,
          status: true,
          date: true,
          startsAt: true,
          note: true,
          roomId: true,
          subjectId: true,
          studentGroupId: true,
          studentGroup: { select: { academicYearId: true } },
          subject: { select: { name: true } },
          teachers: { select: { teacherId: true } },
          extraGroups: { select: { studentGroupId: true } },
          participants: { select: { studentId: true } },
        },
      });
      if (!lesson || lesson.status !== 'SCHEDULED') throw new ConflictException('The lesson can no longer be moved.');
      const state = await lessonState(tx, 'calendar', lesson.id);
      if (!state || state.version !== change.baseVersion) throw new ConflictException('The lesson has changed.');
      const timezone = await schoolTimezone(tx, schoolId);
      const startsAt = zonedTimeToUtc(targetDate, toWallClock(change.targetStart!), timezone);
      const endsAt = zonedTimeToUtc(targetDate, toWallClock(change.targetEnd!), timezone);
      const roomId = change.targetRoomId ?? lesson.roomId;
      const clashes = await datedConflicts(tx, await this.datedContext(tx, lesson.studentGroup.academicYearId), {
        lessonId: lesson.id,
        academicYearId: lesson.studentGroup.academicYearId,
        schoolId,
        subjectId: lesson.subjectId,
        date: targetDate,
        startsAt,
        endsAt,
        roomId,
        studentGroupId: lesson.studentGroupId,
        teacherIds: lesson.teachers.map((row) => row.teacherId),
        extraGroupIds: lesson.extraGroups.map((row) => row.studentGroupId),
        participantIds: lesson.participants.map((row) => row.studentId),
        timezone,
      });
      if (clashes.length > 0) throw new ConflictException('The new time is taken.');
      await tx.calendarLesson.update({
        where: { id: lesson.id },
        // The klasslärare's words are added to the lesson's own note ("Ta med gympakläder · Flyttad pga besök"), not put in their place.
        data: { date: parseDateString(targetDate), startsAt, endsAt, roomId, ...(change.note ? { note: lesson.note ? `${lesson.note} · ${change.note}` : change.note } : {}) },
      });
      await this.realtime.notifyLessonChanged(tx, lesson.id);
      const recipients = await this.notifications.recipientsForLessons(tx, [scopeOf(lesson)]);
      await this.notifications.notifyUsers(tx, {
        schoolId,
        userIds: [...recipients, ...lesson.teachers.map((row) => row.teacherId)],
        type: 'SCHEDULE_CHANGED',
        meta: { subjectName: lesson.subject.name, startsAt: startsAt.toISOString() },
      });
      return { from: lesson.date.toISOString().slice(0, 10), to: targetDate };
    });
    this.realtime.notifyCoverBoardChanged(schoolId, touched.from < touched.to ? touched.from : touched.to, touched.from < touched.to ? touched.to : touched.from);
  }
}

function requireSchoolFrom(change: ChangeRow): string {
  return change.schoolId;
}
