import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import { zonedTimeToUtc } from '../common/utils/time';
import { runsOn } from './lesson-recurrence';
import {
  coversTime,
  publishSkips,
  type PublishClosure,
  type PublishDaysContext,
} from './publish-days';
import { PUBLISH_NOTE_ROOM_UNAVAILABLE, PUBLISH_NOTE_TEACHER_UNAVAILABLE } from './calendar.service';

/**
 * THE ONE RULE BY WHICH A TEMPLATE CHANGE MOVES THE CALENDAR.
 *
 * Reconciles future, still-SCHEDULED calendar lessons that were materialized
 * from this template and carry no attendance yet: they move with the slot,
 * and the ones the template no longer runs on are removed. Lessons in the past
 * or with attendance are left untouched (history must stay accurate).
 *
 * Only the removing half lives here, deliberately. Narrowing a template —
 * every week to odd weeks, a term end pulled forward — strands rows that no
 * later publish can ever reach again, because publishing only ever creates;
 * they would sit in the calendar until the template itself is deleted, so
 * this is the one place that can clear them. Widening leaves the opposite
 * gap, dates that ought to exist and do not, but filling it is
 * materialization: it needs the academic year's bounds, the holiday
 * closures and the idempotency set that `CalendarService.publish` owns.
 * Re-publishing is how those dates appear, and it is idempotent, so it can
 * be run any time after the change.
 *
 * TWO MODES.
 *
 * 'update' (the default) is MasterLessonsService.update's, byte for byte as it
 * was when it lived there: every reconcilable row moves, its room is written,
 * its LEAD is rewritten unless a vikarie holds the lesson.
 *
 * 'publish' is a DRAFT school's publish (src/publication) carrying a template
 * change made days or weeks earlier. In between the school ran its days: a
 * room changed for one date, a vikarie assigned, a note written. DIRECT would
 * have moved the row first and those operations would have been made on the
 * moved row; publishing later must not undo them. So in 'publish':
 *
 *   - only rows dated inside `range` (the segment being published) are asked;
 *   - the date and the time are always written;
 *   - the room only on a row still in the room the template is leaving — the
 *     room optimisation's own rule (room-optimization.service.ts) — so a room
 *     changed for the day stays;
 *   - the LEAD only on a row whose LEAD is the teacher the template is
 *     leaving and that has no SUBSTITUTE;
 *   - the landing date is asked what materialisation asks it: a lov or a
 *     class closure makes the row stale (removed); a teacher or room closure
 *     writes it CANCELLED with that cause and note.
 *
 * DIRECT's update() does not ask the landing date. That is divergence (3) of
 * the equivalence the publish is tested against, and fixing DIRECT is its
 * own change.
 */

export interface TemplateBefore {
  id: string;
  dayOfWeek: number;
  teacherId: string | null;
  /** 'publish' only: the room rows still in it follow the template. */
  roomId?: string | null;
}

export interface TemplateAfter {
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  roomId: string | null;
  teacherId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  /** 'publish' only, for the landing rules. */
  studentGroupId?: string;
  coTeacherId?: string | null;
}

export interface PropagateOptions {
  timezone: string;
  schoolId: string;
  mode?: 'update' | 'publish';
  /** 'publish': the rows dated in [from, to] only. */
  range?: { from: string; to: string };
  /** 'publish': lov, closures and years over the range (publish-days.ts). */
  landing?: PublishDaysContext;
  /** "now", for tests; the rows are asked by instant either way. */
  now?: Date;
}

/** A row 'publish' removed that carried something the school did on the day. */
export interface LostDayOperation {
  calendarLessonId: string;
  date: string;
  substitute: boolean;
  roomChanged: boolean;
  note: boolean;
}

export interface PropagateResult {
  moved: number;
  removed: number;
  /** 'publish': rows written CANCELLED because they landed on a closure. */
  cancelled: number;
  /** 'publish': the rows moved, for the batches a publish re-applies. */
  movedIds: string[];
  /** 'publish': removed rows that carried a day operation. */
  lostDayOperations: LostDayOperation[];
}

/**
 * The materialized lessons a template change may still rewrite or remove.
 *
 * One definition for every caller: deleting the template, narrowing it, and
 * the room optimisation moving its room (RoomOptimizationService.apply) reach
 * the same rows, and a difference between the rules would mean a lesson that
 * one of them rewrites and another leaves alone. Anything that has begun, no
 * longer merely SCHEDULED (cancelled, completed, rescheduled by hand), or
 * with attendance recorded is what happened, and stays as it happened.
 *
 * "Has begun" is an instant, `startsAt`, not a calendar day. A day is the
 * wrong grain twice over. Read as the UTC day it was until now, the school's
 * yesterday is still "today" for an hour or two after local midnight, and
 * deleting the template took yesterday's held lessons with it. Read as any
 * day at all, this morning's lesson that has already ended is still "today's"
 * and was deleted or moved like next week's. Both were lessons the calendar
 * says were held — the timplan's genomförd tid counts exactly those — and a
 * template edited afterwards does not unhold them. A lesson under way is
 * being held and is left alone with the rest.
 *
 * Several templates at once for the room optimisation, which moves hundreds
 * of lessons in one transaction and would otherwise pay a statement each.
 */
export function reconcilableLessons(
  masterLessonIds: string | string[],
): Prisma.CalendarLessonWhereInput {
  return {
    masterLessonId:
      typeof masterLessonIds === 'string' ? masterLessonIds : { in: masterLessonIds },
    status: 'SCHEDULED',
    startsAt: { gt: new Date() },
    attendanceRecords: { none: {} },
  };
}

const toHHMM = (time: Date): string =>
  `${time.getUTCHours().toString().padStart(2, '0')}:${time.getUTCMinutes().toString().padStart(2, '0')}`;

export async function propagateTemplateChange(
  tx: PrismaClient,
  before: TemplateBefore,
  after: TemplateAfter,
  options: PropagateOptions,
): Promise<PropagateResult> {
  const { timezone, schoolId } = options;
  const publishing = options.mode === 'publish';
  const futureLessons = publishing
    ? await tx.calendarLesson.findMany({
        where: {
          ...reconcilableLessons(before.id),
          ...(options.range
            ? {
                date: {
                  gte: new Date(`${options.range.from}T00:00:00.000Z`),
                  lte: new Date(`${options.range.to}T00:00:00.000Z`),
                },
              }
            : {}),
        },
        select: {
          id: true,
          date: true,
          roomId: true,
          note: true,
          teachers: { select: { teacherId: true, role: true } },
        },
      })
    : await tx.calendarLesson.findMany({
        where: reconcilableLessons(before.id),
        select: { id: true, date: true },
      });

  const dayShift = after.dayOfWeek - before.dayOfWeek;
  const startHHMM = toHHMM(after.startTime);
  const endHHMM = toHHMM(after.endTime);
  const stale: string[] = [];
  const movedIds: string[] = [];
  const lostDayOperations: LostDayOperation[] = [];
  let moved = 0;
  let cancelled = 0;
  // Every row here has yet to begin (reconcilableLessons asks by instant),
  // so the only past a row can reach is the one this edit carries it into.
  const now = options.now ?? new Date();

  type PublishRow = {
    id: string;
    date: Date;
    roomId: string | null;
    note: string | null;
    teachers: { teacherId: string; role: string }[];
  };
  const markStale = (row: { id: string; date: Date }) => {
    stale.push(row.id);
    if (!publishing) return;
    const full = row as PublishRow;
    const operation: LostDayOperation = {
      calendarLessonId: full.id,
      date: full.date.toISOString().slice(0, 10),
      substitute: full.teachers.some((teacher) => teacher.role === 'SUBSTITUTE'),
      roomChanged: (before.roomId ?? null) !== full.roomId,
      note: full.note !== null && full.note !== '',
    };
    if (operation.substitute || operation.roomChanged || operation.note) lostDayOperations.push(operation);
  };

  for (const calendarLesson of futureLessons) {
    const newDate = new Date(calendarLesson.date);
    newDate.setUTCDate(newDate.getUTCDate() + dayShift);
    const dateString = newDate.toISOString().slice(0, 10);
    const startsAt = zonedTimeToUtc(dateString, startHHMM, timezone);
    const endsAt = zonedTimeToUtc(dateString, endHHMM, timezone);

    // Never into the past, judged by the instant and not the day. A
    // Thursday lesson moved to Monday on a Thursday would carry this week's
    // row back to Monday; a 13:00 lesson moved to 08:00 at ten o'clock
    // would carry today's row back three hours. Either way the row would
    // stand SCHEDULED with its teacher at a time already lived: a lesson
    // the calendar says was held and nobody held. The timplan's genomförd
    // tid counts exactly such rows, and every other reader takes a past
    // row as what happened. A slot that has already begun cannot be held
    // as scheduled either. The row is stale instead — the week's lesson is
    // gone from the time it was at, as it is from the template — and
    // removed with the others below.
    if (startsAt <= now) {
      markStale(calendarLesson);
      continue;
    }

    // The date the row would land on is the one that has to survive the
    // template's own rule — a weekday move can carry a half-term lesson
    // past its end date, and a parity change empties every other week.
    if (!runsOn(after, newDate)) {
      markStale(calendarLesson);
      continue;
    }

    if (!publishing) {
      await tx.calendarLesson.update({
        where: { id: calendarLesson.id },
        data: {
          date: newDate,
          startsAt,
          endsAt,
          roomId: after.roomId,
        },
      });
      moved++;

      // Keep the LEAD teacher assignment in sync with the template — except
      // on a lesson a vikarie has been assigned to. assignSubstitute replaced
      // every row of that lesson with one SUBSTITUTE row; writing the new
      // lead beside it put two teachers on a lesson one person held, and the
      // staffing reconciliation would credit both (it now reads such a LEAD
      // as DISPLACED, for rows written before this). And when the new lead IS
      // the vikarie, the unique (calendarLessonId, teacherId) made the whole
      // PATCH a P2002. So the LEAD is written only when the lesson has no
      // SUBSTITUTE row and the new teacher no row of their own on it: one
      // statement, as the create it replaces.
      if (after.teacherId !== before.teacherId) {
        await tx.calendarLessonTeacher.deleteMany({
          where: { calendarLessonId: calendarLesson.id, role: 'LEAD' },
        });
        if (after.teacherId) {
          await tx.$executeRaw`
            INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", "role")
            SELECT ${schoolId}::uuid, ${calendarLesson.id}::uuid, ${after.teacherId}::uuid, 'LEAD'::"TeacherAssignmentRole"
             WHERE NOT EXISTS (
                     SELECT 1 FROM "CalendarLessonTeachers" x
                      WHERE x."calendarLessonId" = ${calendarLesson.id}::uuid
                        AND (x."role" = 'SUBSTITUTE' OR x."teacherId" = ${after.teacherId}::uuid))
          `;
        }
      }
      continue;
    }

    // ---- 'publish': field-wise, and the landing date asked like a publish.
    const row = calendarLesson as PublishRow;
    const landing = options.landing;
    let closure: 'teacher' | 'room' | null = null;
    if (landing && after.studentGroupId) {
      const template = { studentGroupId: after.studentGroupId, startTime: after.startTime, endTime: after.endTime };
      if (publishSkips(template, dateString, landing) !== null) {
        markStale(row);
        continue;
      }
      for (const entry of (landing.closuresByDate.get(dateString) ?? []) as PublishClosure[]) {
        if (!coversTime(entry, dateString, startsAt, endsAt, timezone)) continue;
        if (
          entry.resourceType === 'TEACHER' &&
          entry.userId !== null &&
          (entry.userId === after.teacherId || entry.userId === (after.coTeacherId ?? null))
        ) {
          closure = closure ?? 'teacher';
        }
        const landedRoom = row.roomId === (before.roomId ?? null) ? after.roomId : row.roomId;
        if (entry.resourceType === 'ROOM' && entry.roomId !== null && entry.roomId === landedRoom) {
          closure = closure ?? 'room';
        }
      }
    }

    const followsRoom = row.roomId === (before.roomId ?? null);
    await tx.calendarLesson.update({
      where: { id: row.id },
      data: {
        date: newDate,
        startsAt,
        endsAt,
        ...(followsRoom ? { roomId: after.roomId } : {}),
        ...(closure === null
          ? {}
          : {
              status: 'CANCELLED' as const,
              note: closure === 'teacher' ? PUBLISH_NOTE_TEACHER_UNAVAILABLE : PUBLISH_NOTE_ROOM_UNAVAILABLE,
              cancelCause: closure === 'teacher' ? ('TEACHER_UNAVAILABLE' as const) : ('ROOM_UNAVAILABLE' as const),
            }),
      },
    });
    moved++;
    movedIds.push(row.id);
    if (closure !== null) cancelled++;

    const lead = row.teachers.find((teacher) => teacher.role === 'LEAD');
    const substituted = row.teachers.some((teacher) => teacher.role === 'SUBSTITUTE');
    if (
      after.teacherId !== before.teacherId &&
      !substituted &&
      (lead === undefined ? before.teacherId === null : lead.teacherId === before.teacherId)
    ) {
      await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: row.id, role: 'LEAD' } });
      if (after.teacherId && !row.teachers.some((teacher) => teacher.teacherId === after.teacherId)) {
        await tx.calendarLessonTeacher.create({
          data: { schoolId, calendarLessonId: row.id, teacherId: after.teacherId, role: 'LEAD' },
        });
      }
    }
  }

  // Deleting by id alone is safe: these ids come from the guarded query
  // above, so they are already future, SCHEDULED and attendance-free.
  if (stale.length > 0) {
    await tx.calendarLesson.deleteMany({ where: { id: { in: stale } } });
  }

  return { moved, removed: stale.length, cancelled, movedIds, lostDayOperations };
}
