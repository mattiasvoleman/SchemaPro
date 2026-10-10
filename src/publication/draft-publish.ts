import type { PrismaClient } from '@prisma/client';
import { zonedTimeToUtc } from '../common/utils/time';
import { runsOn } from '../calendar/lesson-recurrence';
import {
  propagateTemplateChange,
  type LostDayOperation,
} from '../calendar/propagate-template';
import {
  breakDaysOf,
  closuresByDateOf,
  isoWeekday,
  parseUtcDate,
  timeToString,
  type PublishDaysContext,
} from '../calendar/publish-days';
import type { GateEntry } from './publication-gates';
import { effectiveSegments } from './publication-validity';
import { slotChanged, snapshotRanges, type PublishedMaster } from './published-grundschema';

/**
 * A DRAFT school's publish: carrying the draft into the calendar.
 *
 * The calendar holds what was published; the snapshot of each publication
 * says which grundschema produced which dates (publication-validity.ts). A
 * publish over [validFrom, validTo] therefore asks, for every published
 * segment inside that range, which masters differ from the segment's
 * snapshot, and moves their rows with the ONE move rule
 * (propagateTemplateChange, mode 'publish'). Rows of masters the draft
 * deleted were recorded by the database (PublicationPendingRemovals) and are
 * adopted or removed here. Materialisation (CalendarService.materialise, with
 * notBefore = now) then creates what the new grundschema has and the calendar
 * lacks. The caller holds the exclusive publication lock throughout.
 */

export interface DraftWindow {
  schoolId: string;
  academicYearId: string;
  timezone: string;
  validFrom: string;
  validTo: string;
  /** The year's last day: a validTo there splits no week, nothing follows it. */
  yearEnd?: string;
  /** The year's masters, the draft, as published-grundschema.ts reads them. */
  masters: readonly PublishedMaster[];
  now: Date;
}

export interface DraftCarry {
  moved: number;
  removed: number;
  /** Rows moved onto a teacher's or a room's closure, written CANCELLED. */
  cancelled: number;
  adopted: number;
  /** Rows the publish removes that carried a vikarie, a room change or a note. */
  lostDayOperations: LostDayOperation[];
  /**
   * Masters changing weekday across a validFrom that is not a Monday, or a
   * validTo that is not a Sunday: that week's lesson is dropped or doubled.
   */
  weekSplit: GateEntry[];
  /** The masters whose published rows moved or went: their classes are told. */
  changedMasterIds: string[];
  /** The rows the publish moved, for the batches it re-applies. */
  movedIds: string[];
}

const WEEKDAY = ['', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];

/** The lov, closures and years over [from, to]: what materialise reads, for the landing rules. */
export async function landingContextOf(
  tx: PrismaClient,
  academicYearId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<PublishDaysContext> {
  const closures = await tx.availabilityConstraint.findMany({
    where: { type: 'UNAVAILABLE', date: { not: null, gte: parseUtcDate(from), lte: parseUtcDate(to) } },
    select: {
      resourceType: true,
      userId: true,
      roomId: true,
      studentGroupId: true,
      minGradeLevel: true,
      maxGradeLevel: true,
      date: true,
      startTime: true,
      endTime: true,
    },
  });
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId, startDate: { lte: parseUtcDate(to) }, endDate: { gte: parseUtcDate(from) } },
    select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
  });
  const groups = await tx.studentGroup.findMany({
    where: { academicYearId },
    select: { id: true, gradeLevel: true },
  });
  return {
    breakDays: breakDaysOf(breaks, from, to),
    closuresByDate: closuresByDateOf(closures),
    gradeOfGroup: new Map(groups.map((group) => [group.id, group.gradeLevel])),
    timezone,
  };
}

/**
 * Whether a master moving from weekday `a` to weekday `b` crosses an edge of
 * the range that falls inside a week: validFrom after a Monday, or validTo
 * before a Sunday (and before the year's last day, after which nothing is).
 */
export function crossesWeekEdge(
  window: Pick<DraftWindow, 'validFrom' | 'validTo' | 'yearEnd'>,
  a: number,
  b: number,
): boolean {
  const fromDay = isoWeekday(window.validFrom);
  const toDay = window.validTo === window.yearEnd ? 7 : isoWeekday(window.validTo);
  return (fromDay !== 1 && a < fromDay !== b < fromDay) || (toDay !== 7 && a > toDay !== b > toDay);
}

/** Steps 3–5 of the publish: move what changed, then settle what the draft deleted. */
export async function carryDraft(tx: PrismaClient, window: DraftWindow): Promise<DraftCarry> {
  const carry: DraftCarry = {
    moved: 0,
    removed: 0,
    cancelled: 0,
    adopted: 0,
    lostDayOperations: [],
    weekSplit: [],
    changedMasterIds: [],
    movedIds: [],
  };
  const landing = await landingContextOf(tx, window.academicYearId, window.validFrom, window.validTo, window.timezone);
  const byId = new Map(window.masters.map((master) => [master.id, master]));
  const segments = effectiveSegments(await snapshotRanges(tx, window.academicYearId)).filter(
    (segment) => segment.to >= window.validFrom && segment.from <= window.validTo,
  );
  // A week is split where the range begins or ends inside it. A changed
  // master crosses such an edge when its old and its new weekday fall on
  // opposite sides of it: the rows on the far side belong to another
  // segment and are never written (propagate-template.ts, 'publish'), so the
  // week keeps the old day's lesson as well as the new one, or neither.
  const crossesEdge = (a: number, b: number): boolean => crossesWeekEdge(window, a, b);
  const split = new Set<string>();
  const changed = new Set<string>();

  for (const segment of segments) {
    const from = segment.from < window.validFrom ? window.validFrom : segment.from;
    const to = segment.to > window.validTo ? window.validTo : segment.to;
    const published = await tx.publishedLesson.findMany({
      where: { publicationId: segment.publicationId },
      orderBy: { masterLessonId: 'asc' },
    });
    for (const before of published) {
      const after = byId.get(before.masterLessonId);
      if (!after || !slotChanged(before, after)) continue;
      const result = await propagateTemplateChange(
        tx,
        { id: before.masterLessonId, dayOfWeek: before.dayOfWeek, teacherId: before.teacherId, roomId: before.roomId },
        {
          dayOfWeek: after.dayOfWeek,
          startTime: after.startTime,
          endTime: after.endTime,
          roomId: after.roomId,
          teacherId: after.teacherId,
          coTeacherId: after.coTeacherId,
          studentGroupId: after.studentGroupId,
          recurrence: after.recurrence,
          startDate: after.startDate,
          endDate: after.endDate,
        },
        {
          timezone: window.timezone,
          schoolId: window.schoolId,
          mode: 'publish',
          range: { from, to },
          landing,
          now: window.now,
        },
      );
      carry.moved += result.moved;
      carry.removed += result.removed;
      carry.cancelled += result.cancelled;
      carry.movedIds.push(...result.movedIds);
      carry.lostDayOperations.push(...result.lostDayOperations);
      if (result.moved + result.removed > 0) changed.add(after.id);
      if (crossesEdge(before.dayOfWeek, after.dayOfWeek) && !split.has(after.id)) {
        split.add(after.id);
        carry.weekSplit.push({
          label: `${after.subject.name} · ${after.studentGroup.name}: ${WEEKDAY[before.dayOfWeek]} → ${WEEKDAY[after.dayOfWeek]}`,
          masterLessonId: after.id,
        });
      }
    }
  }

  const pending = await settlePendingRemovals(tx, window);
  carry.adopted = pending.adopted;
  carry.removed += pending.removed;
  carry.lostDayOperations.push(...pending.lostDayOperations);
  for (const id of pending.changedMasterIds) changed.add(id);
  carry.changedMasterIds = [...changed].sort();
  return carry;
}

/**
 * Step 5, "adopt, then remove". A recorded row whose (date, start, end,
 * subject, group) is exactly one instance the current masters would
 * materialise — and that instance is claimed by no other recorded row — is
 * relinked to that master and keeps its status, teachers, room and note:
 * a regeneration or a restore in DRAFT gives masters new ids, and without
 * this their vikarier and avbokningar would be deleted and re-created bare.
 * Materialisation then skips it as already there. A row nobody adopts is
 * deleted when it is still SCHEDULED, ahead and attendance-free, and left an
 * orphan otherwise — DIRECT's history rule.
 */
async function settlePendingRemovals(
  tx: PrismaClient,
  window: DraftWindow,
): Promise<{ adopted: number; removed: number; lostDayOperations: LostDayOperation[]; changedMasterIds: string[] }> {
  const rows = await tx.publicationPendingRemoval.findMany({
    where: {
      academicYearId: window.academicYearId,
      calendarLesson: {
        is: { date: { gte: parseUtcDate(window.validFrom), lte: parseUtcDate(window.validTo) } },
      },
    },
    select: {
      calendarLessonId: true,
      masterLessonId: true,
      calendarLesson: {
        select: {
          id: true,
          date: true,
          startsAt: true,
          endsAt: true,
          subjectId: true,
          studentGroupId: true,
          status: true,
          roomId: true,
          note: true,
          teachers: { select: { role: true } },
          _count: { select: { attendanceRecords: true } },
        },
      },
    },
  });
  if (rows.length === 0) return { adopted: 0, removed: 0, lostDayOperations: [], changedMasterIds: [] };

  const placed = window.masters.filter((master) => !master.isParked);
  const instanceOf = (row: (typeof rows)[number]) => {
    const lesson = row.calendarLesson;
    const date = lesson.date.toISOString().slice(0, 10);
    return placed.filter(
      (master) =>
        master.subjectId === lesson.subjectId &&
        master.studentGroupId === lesson.studentGroupId &&
        master.dayOfWeek === isoWeekday(date) &&
        zonedTimeToUtc(date, timeToString(master.startTime), window.timezone).getTime() === lesson.startsAt.getTime() &&
        zonedTimeToUtc(date, timeToString(master.endTime), window.timezone).getTime() === lesson.endsAt.getTime() &&
        runsOn(master, lesson.date),
    );
  };
  const candidates = new Map(rows.map((row) => [row.calendarLessonId, instanceOf(row)]));
  const masterIds = [...new Set([...candidates.values()].flat().map((master) => master.id))];
  const taken = new Set(
    (
      await tx.calendarLesson.findMany({
        where: {
          masterLessonId: { in: masterIds },
          date: { gte: parseUtcDate(window.validFrom), lte: parseUtcDate(window.validTo) },
        },
        select: { masterLessonId: true, date: true },
      })
    ).map((row) => `${row.masterLessonId}:${row.date.toISOString().slice(0, 10)}`),
  );
  const claims = new Map<string, number>();
  for (const row of rows) {
    const found = candidates.get(row.calendarLessonId)!;
    if (found.length !== 1) continue;
    const key = `${found[0]!.id}:${row.calendarLesson.date.toISOString().slice(0, 10)}`;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }

  let adopted = 0;
  const remove: string[] = [];
  const release: string[] = [];
  const lostDayOperations: LostDayOperation[] = [];
  const changedMasterIds = new Set<string>();
  for (const row of rows) {
    const lesson = row.calendarLesson;
    const date = lesson.date.toISOString().slice(0, 10);
    const found = candidates.get(row.calendarLessonId)!;
    const key = found.length === 1 ? `${found[0]!.id}:${date}` : null;
    if (key !== null && claims.get(key) === 1 && !taken.has(key)) {
      await tx.calendarLesson.update({ where: { id: lesson.id }, data: { masterLessonId: found[0]!.id } });
      release.push(row.calendarLessonId);
      adopted++;
      continue;
    }
    changedMasterIds.add(row.masterLessonId);
    const reconcilable =
      lesson.status === 'SCHEDULED' && lesson.startsAt > window.now && lesson._count.attendanceRecords === 0;
    if (!reconcilable) {
      release.push(row.calendarLessonId);
      continue;
    }
    remove.push(lesson.id);
    const operation: LostDayOperation = {
      calendarLessonId: lesson.id,
      date,
      substitute: lesson.teachers.some((teacher) => teacher.role === 'SUBSTITUTE'),
      roomChanged: false,
      note: lesson.note !== null && lesson.note !== '',
    };
    if (operation.substitute || operation.note) lostDayOperations.push(operation);
  }
  if (release.length > 0) {
    await tx.publicationPendingRemoval.deleteMany({ where: { calendarLessonId: { in: release } } });
  }
  // The recorded rows go with their lessons (ON DELETE CASCADE).
  if (remove.length > 0) {
    await tx.calendarLesson.deleteMany({ where: { id: { in: remove } } });
  }
  return { adopted, removed: remove.length, lostDayOperations, changedMasterIds: [...changedMasterIds] };
}

/** The window a DRAFT publish may cover: never a day that has begun. */
export function draftWindow(
  year: { start: string; end: string },
  today: string,
  dto: { validFrom?: string; validTo?: string },
): { validFrom: string; validTo: string } | { error: string } {
  const validFrom = dto.validFrom ?? (today > year.start ? today : year.start);
  if (validFrom < today) return { error: 'PAST' };
  const validTo = dto.validTo === undefined || dto.validTo > year.end ? year.end : dto.validTo;
  const from = validFrom < year.start ? year.start : validFrom;
  if (from > validTo) return { error: 'EMPTY' };
  return { validFrom: from, validTo };
}

