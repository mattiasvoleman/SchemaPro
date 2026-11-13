import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { todayInZone, zonedTimeToUtc } from '../common/utils/time';
import { runsOn } from '../calendar/lesson-recurrence';
import { sharedRoomTakes } from '../calendar/shared-room-day';
import { isoWeekday, timeToString } from '../calendar/publish-days';
import { effectiveSegments } from './publication-validity';
import { snapshotRanges } from './published-grundschema';
import { publishModeOf } from './publish-mode';
import { selectLessons, type SelectionCandidate, type SelectionRule } from './cancellation-selection';
import type { CancellationSelectionDto } from './dto/cancellation-batch.dto';
import type { DigestLesson } from './cancellation-digest';
import type { ReversePreview } from './cancellation-batches.service';

/*
 * THE AVBOKNING'S OWN PARTS, shared by the bulk avbokning
 * (cancellation-batches.service.ts) and the schemabrytande aktivitet that owns
 * one (schedule-activities.service.ts, activity-replacements.ts). They were
 * the lower half of the service; they moved here unchanged so that the
 * activity can cancel, reinstate and credit by the same code, and so that the
 * service can call the activity's replacement sync after a re-application
 * without the two files importing each other.
 */

export const CANCELLATION_STALE = 'CANCELLATION_STALE';
export const CANCELLATION_REVERSED = 'CANCELLATION_REVERSED';
export const CANCELLATION_RANGE = 'CANCELLATION_RANGE';
export const CANCELLATION_SCOPE = 'CANCELLATION_SCOPE';
export const CANCELLATION_CREDIT = 'CANCELLATION_CREDIT';

export const asDay = (value: Date): string => value.toISOString().slice(0, 10);
export const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const clock = (value: Date | null): string | null => (value ? value.toISOString().slice(11, 16) : null);
export const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

export const CANDIDATE_SELECT = {
  id: true,
  date: true,
  startsAt: true,
  endsAt: true,
  status: true,
  note: true,
  subjectId: true,
  studentGroupId: true,
  studentGroup: { select: { name: true, gradeLevel: true } },
  subject: { select: { name: true } },
  extraGroups: { select: { studentGroupId: true, studentGroup: { select: { gradeLevel: true } } } },
  _count: { select: { attendanceRecords: true } },
} as const satisfies Prisma.CalendarLessonSelect;

export type CandidateRow = Prisma.CalendarLessonGetPayload<{ select: typeof CANDIDATE_SELECT }>;

export const toCandidate = (row: CandidateRow): SelectionCandidate => ({
  id: row.id,
  date: asDay(row.date),
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
  attendance: row._count.attendanceRecords,
  studentGroupId: row.studentGroupId,
  gradeLevel: row.studentGroup.gradeLevel,
  groupName: row.studentGroup.name,
  subjectId: row.subjectId,
  subjectName: row.subject.name,
  extraGroups: row.extraGroups.map((entry) => ({
    studentGroupId: entry.studentGroupId,
    gradeLevel: entry.studentGroup.gradeLevel,
  })),
  note: row.note,
});

export interface StoredSelection {
  academicYearId: string;
  name: string;
  cause: 'EVENT' | 'MANUAL';
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: 'SCHOOL' | 'GRADES' | 'GROUPS';
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  groupIds: string[];
}

export const BATCH_SELECT = {
  id: true,
  academicYearId: true,
  name: true,
  cause: true,
  fromDate: true,
  toDate: true,
  startTime: true,
  endTime: true,
  scope: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  groupIds: true,
  cancelled: true,
  createdAt: true,
  createdByUserId: true,
  reversedAt: true,
  reinstated: true,
  skippedRoomTaken: true,
  notifies: true,
  _count: { select: { credits: true } },
} as const satisfies Prisma.CancellationBatchSelect;

export type BatchRow = Prisma.CancellationBatchGetPayload<{ select: typeof BATCH_SELECT }>;

export function storedSelection(row: BatchRow): StoredSelection {
  return {
    academicYearId: row.academicYearId,
    name: row.name,
    cause: row.cause as 'EVENT' | 'MANUAL',
    fromDate: asDay(row.fromDate),
    toDate: asDay(row.toDate),
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    scope: row.scope as StoredSelection['scope'],
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    groupIds: row.groupIds,
  };
}

/** A selected lesson as the digest reads it. */
export const digestLessonOf = (lesson: SelectionCandidate): DigestLesson => ({
  id: lesson.id,
  date: lesson.date,
  subjectId: lesson.subjectId,
  studentGroupId: lesson.studentGroupId,
  extraGroups: lesson.extraGroups,
});

/** The lessons a reversal reinstates, as the digest reads them. */
export async function digestLessonsOf(tx: PrismaClient, rows: ReadonlyArray<{ id: string }>): Promise<DigestLesson[]> {
  if (rows.length === 0) return [];
  const lessons = await tx.calendarLesson.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: {
      id: true,
      date: true,
      subjectId: true,
      studentGroupId: true,
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  return lessons.map((lesson) => ({ ...lesson, date: asDay(lesson.date) }));
}

export function ruleOf(selection: StoredSelection, timezone: string, now: Date): SelectionRule {
  return {
    scope: selection.scope,
    minGradeLevel: selection.minGradeLevel,
    maxGradeLevel: selection.maxGradeLevel,
    groupIds: selection.groupIds,
    startTime: selection.startTime,
    endTime: selection.endTime,
    timezone,
    now,
  };
}

/** The cross-field rules a DTO cannot state, with the fields named. Mirrors the CHECKs. */
export function checkSelection(dto: CancellationSelectionDto): StoredSelection {
  if (dto.toDate < dto.fromDate) {
    throw new BadRequestException({ message: 'toDate: avbokningens sista dag ligger före den första.', code: CANCELLATION_RANGE });
  }
  if ((day(dto.toDate).getTime() - day(dto.fromDate).getTime()) / 86_400_000 > 30) {
    throw new BadRequestException({ message: 'toDate: en avbokning gäller högst 31 dagar.', code: CANCELLATION_RANGE });
  }
  if ((dto.startTime === undefined) !== (dto.endTime === undefined) || (dto.startTime && dto.endTime && dto.startTime >= dto.endTime)) {
    throw new BadRequestException({
      message: 'startTime/endTime: ett tidsfönster har en början före sitt slut, eller utelämnas helt.',
      code: CANCELLATION_RANGE,
    });
  }
  const span = dto.minGradeLevel !== undefined || dto.maxGradeLevel !== undefined;
  const groups = dto.groupIds !== undefined && dto.groupIds.length > 0;
  const scopeOk =
    dto.scope === 'SCHOOL'
      ? !span && !groups
      : dto.scope === 'GRADES'
        ? dto.minGradeLevel !== undefined && dto.maxGradeLevel !== undefined && dto.minGradeLevel <= dto.maxGradeLevel && !groups
        : groups && !span;
  if (!scopeOk) {
    throw new BadRequestException({
      message:
        'scope: SCHOOL anger varken årskurser eller grupper, GRADES anger minGradeLevel och maxGradeLevel i ordning, GROUPS anger groupIds.',
      code: CANCELLATION_SCOPE,
    });
  }
  return {
    academicYearId: dto.academicYearId,
    name: dto.name.trim(),
    cause: dto.cause,
    fromDate: dto.fromDate,
    toDate: dto.toDate,
    startTime: dto.startTime ?? null,
    endTime: dto.endTime ?? null,
    scope: dto.scope,
    minGradeLevel: dto.scope === 'GRADES' ? dto.minGradeLevel! : null,
    maxGradeLevel: dto.scope === 'GRADES' ? dto.maxGradeLevel! : null,
    groupIds: dto.scope === 'GROUPS' ? [...new Set(dto.groupIds!)] : [],
  };
}

/**
 * The dates a credit is written for: a whole-day batch's dates that lie
 * after the school's today and on which the batch cancels a lesson — a day
 * that had teaching to count. A day with a time window, or one already under
 * way, could be partly held, and a credit for all of it would count the held
 * part twice.
 */
export function creditDatesOf(selection: StoredSelection, matched: readonly SelectionCandidate[], today: string): string[] {
  if (selection.startTime !== null) return [];
  return [...new Set(matched.map((lesson) => lesson.date))].filter((date) => date > today).sort();
}

/** One credit per date for the school or the span, one per group per date for GROUPS. */
export function creditTargetsOf(
  selection: StoredSelection,
): Array<{ studentGroupId: string | null; minGradeLevel: number | null; maxGradeLevel: number | null }> {
  if (selection.scope === 'GROUPS') {
    return selection.groupIds.map((studentGroupId) => ({ studentGroupId, minGradeLevel: null, maxGradeLevel: null }));
  }
  return [{ studentGroupId: null, minGradeLevel: selection.minGradeLevel, maxGradeLevel: selection.maxGradeLevel }];
}

/**
 * The lessons a batch's selection takes now that it does not hold yet: what a
 * publish, a refill or a moved lesson has put into its days since. Never an
 * activity's replacement lesson, which stands in the cancelled ones' place.
 */
export async function pendingLessons(tx: PrismaClient, row: BatchRow, timezone: string): Promise<SelectionCandidate[]> {
  const selection = storedSelection(row);
  const rows = await tx.calendarLesson.findMany({
    where: {
      studentGroup: { is: { academicYearId: selection.academicYearId } },
      date: { gte: day(selection.fromDate), lte: day(selection.toDate) },
      batchLessons: { none: { batchId: row.id } },
      activityLinks: { none: {} },
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  return selectLessons(rows.map(toCandidate), ruleOf(selection, timezone, new Date())).matched;
}

/** Cancels the rows into the batch, keeping each one's note to give back. */
export async function cancelInto(
  tx: PrismaClient,
  schoolId: string,
  batchId: string,
  selection: Pick<StoredSelection, 'cause' | 'name'>,
  lessons: readonly SelectionCandidate[],
): Promise<number> {
  if (lessons.length === 0) return 0;
  await tx.cancellationBatchLesson.createMany({
    data: lessons.map((lesson) => ({ batchId, calendarLessonId: lesson.id, schoolId, previousNote: lesson.note })),
  });
  const { count } = await tx.calendarLesson.updateMany({
    where: {
      id: { in: lessons.map((lesson) => lesson.id) },
      status: 'SCHEDULED',
      startsAt: { gt: new Date() },
      attendanceRecords: { none: {} },
    },
    data: { status: 'CANCELLED', cancelCause: selection.cause, note: `Inställd: ${selection.name}` },
  });
  // Read and written in one transaction under the publication lock; a row
  // that changed in between (a cancel, a vikarie's first register) means the
  // preview no longer says what this would do.
  if (count !== lessons.length) throw stale();
  return count;
}

/** A template as the slot check reads it: the master's, or a snapshot's row. */
export interface SlotTemplate {
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: Prisma.MasterLessonGetPayload<{ select: { recurrence: true } }>['recurrence'];
  startDate: Date | null;
  endDate: Date | null;
  /** DIRECT only: a parked lesson has no slot to carry a lesson to. */
  isParked?: boolean;
  /** DIRECT only: when the master was last written, which tells a template moved after a batch from an exception that was there before it. */
  updatedAt?: Date;
}

export const SLOT_SELECT = {
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  recurrence: true,
  startDate: true,
  endDate: true,
} as const;

/**
 * For each row, the published template it would run by on its date, or null
 * when its lesson no longer has one. DIRECT: the master itself. DRAFT: the
 * snapshot of the segment the date lies in (publication-validity.ts) — the
 * draft is not what is published. A row whose master was deleted in a draft
 * is keyed on its recorded id (PublicationPendingRemovals), as every
 * published-key reader keys it.
 */
export async function publishedTemplates(
  tx: PrismaClient,
  schoolId: string,
  academicYearId: string,
  rows: ReadonlyArray<{ id: string; date: Date; masterLessonId: string | null }>,
): Promise<Map<string, SlotTemplate | null>> {
  const out = new Map<string, SlotTemplate | null>();
  if (rows.length === 0) return out;
  const pending = new Map(
    (
      await tx.publicationPendingRemoval.findMany({
        where: { calendarLessonId: { in: rows.filter((row) => row.masterLessonId === null).map((row) => row.id) } },
        select: { calendarLessonId: true, masterLessonId: true },
      })
    ).map((entry) => [entry.calendarLessonId, entry.masterLessonId]),
  );
  const keyOf = (row: (typeof rows)[number]) => row.masterLessonId ?? pending.get(row.id) ?? null;
  const ids = [...new Set(rows.map(keyOf).filter((id): id is string => id !== null))];
  if ((await publishModeOf(tx, schoolId)) === 'DIRECT') {
    const masters = new Map(
      (await tx.masterLesson.findMany({ where: { id: { in: ids } }, select: { id: true, isParked: true, updatedAt: true, ...SLOT_SELECT } })).map(
        (master) => [master.id, master],
      ),
    );
    for (const row of rows) {
      const master = masters.get(keyOf(row) ?? '');
      out.set(row.id, master ?? null);
    }
    return out;
  }
  const segments = effectiveSegments(await snapshotRanges(tx, academicYearId));
  const bySegment = new Map<string, Map<string, SlotTemplate>>();
  for (const row of rows) {
    const date = asDay(row.date);
    const segment = segments.find((entry) => entry.from <= date && date <= entry.to);
    const key = keyOf(row);
    if (!segment || key === null) {
      out.set(row.id, null);
      continue;
    }
    let published = bySegment.get(segment.publicationId);
    if (!published) {
      published = new Map(
        (
          await tx.publishedLesson.findMany({
            where: { publicationId: segment.publicationId, masterLessonId: { in: ids } },
            select: { masterLessonId: true, ...SLOT_SELECT },
          })
        ).map((lesson) => [lesson.masterLessonId, lesson]),
      );
      bySegment.set(segment.publicationId, published);
    }
    out.set(row.id, published.get(key) ?? null);
  }
  return out;
}

/** A cancelled lesson carried back to the template's slot of its own week (see relocationsOf): where it stood and where it goes. */
export interface Relocation {
  id: string;
  previousNote: string | null;
  from: string;
  to: string;
  startsAt: Date;
  endsAt: Date;
}

const shiftDay = (iso: string, by: number): string => new Date(Date.parse(`${iso}T00:00:00.000Z`) + by * 86_400_000).toISOString().slice(0, 10);

/**
 * THE LESSON THAT A TEMPLATE MOVED OUT FROM UNDER A BATCH IS STILL THE CLASS'S LESSON THAT WEEK.
 *
 * A DIRECT school's edit of the template moves the rows it can carry (reconcilableLessons: SCHEDULED, ahead, no register) and
 * writes no row for the new day, so a lesson the batch had cancelled stays cancelled at the old slot and the new slot has no row:
 * the week's lesson is the cancelled one. When the batch is taken back it is that row that is the lesson, and deleting it (as a
 * row whose lesson already runs where the template says is deleted) leaves the class without it until the next publication.
 * So it goes to the template's slot of its own week: the date of the template's weekday in the row's ISO week, the template's own
 * hours, provided that
 *
 *   - the school is DIRECT (a DRAFT school's publication writes the new day itself, and the row there is deleted as before);
 *   - the master lesson is there, is not parked, and was written after the batch was made (a row that was an exception before it
 *     stays an old slot as before);
 *   - the slot is ahead and the template runs on that date (its weeks and its dates), as propagateTemplateChange's standsAt asks;
 *   - no row of the master stands on that date already (a publication wrote it, or another cancelled row of this batch came first):
 *     then the lesson is where it runs now and the old row is deleted, as before.
 *
 * The room is asked about at the new slot like a reinstated lesson's (reversePlan). One query for all the rows' target days.
 */
async function relocationsOf(
  tx: PrismaClient,
  schoolId: string,
  batch: BatchRow,
  lessons: ReadonlyArray<{ id: string; date: Date; startsAt: Date; endsAt: Date; masterLessonId: string | null }>,
  templates: ReadonlyMap<string, SlotTemplate | null>,
  timezone: string,
  now: Date,
): Promise<Map<string, { to: string; startsAt: Date; endsAt: Date }>> {
  const out = new Map<string, { to: string; startsAt: Date; endsAt: Date }>();
  if ((await publishModeOf(tx, schoolId)) !== 'DIRECT') return out;
  const wanted: Array<{ id: string; masterLessonId: string; to: string; startsAt: Date; endsAt: Date }> = [];
  for (const lesson of lessons) {
    const template = templates.get(lesson.id) ?? null;
    if (template === null || lesson.masterLessonId === null || runsAt(template, lesson, timezone)) continue;
    if (template.isParked === true || template.updatedAt === undefined || template.updatedAt <= batch.createdAt) continue;
    const date = asDay(lesson.date);
    const to = shiftDay(shiftDay(date, 1 - isoWeekday(date)), template.dayOfWeek - 1);
    const startsAt = zonedTimeToUtc(to, timeToString(template.startTime), timezone);
    const endsAt = zonedTimeToUtc(to, timeToString(template.endTime), timezone);
    if (startsAt <= now || !runsOn(template, day(to))) continue;
    wanted.push({ id: lesson.id, masterLessonId: lesson.masterLessonId, to, startsAt, endsAt });
  }
  if (wanted.length === 0) return out;
  const there = await tx.calendarLesson.findMany({
    // Not the rows being judged: a template moved to another hour of the same day has its new slot on the very date the old row stands on.
    where: {
      id: { notIn: lessons.map((lesson) => lesson.id) },
      masterLessonId: { in: [...new Set(wanted.map((entry) => entry.masterLessonId))] },
      date: { in: [...new Set(wanted.map((entry) => day(entry.to)))] },
    },
    select: { masterLessonId: true, date: true },
  });
  const taken = new Set(there.map((entry) => `${entry.masterLessonId}|${asDay(entry.date)}`));
  for (const entry of wanted) {
    const key = `${entry.masterLessonId}|${entry.to}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.set(entry.id, { to: entry.to, startsAt: entry.startsAt, endsAt: entry.endsAt });
  }
  return out;
}

/** Does the template run this row's lesson at exactly this date and slot? */
export function runsAt(template: SlotTemplate | null, row: { date: Date; startsAt: Date; endsAt: Date }, timezone: string): boolean {
  if (template === null) return false;
  const date = asDay(row.date);
  return (
    template.dayOfWeek === isoWeekday(date) &&
    zonedTimeToUtc(date, timeToString(template.startTime), timezone).getTime() === row.startsAt.getTime() &&
    zonedTimeToUtc(date, timeToString(template.endTime), timezone).getTime() === row.endsAt.getTime() &&
    runsOn(template, row.date)
  );
}

/**
 * `only` narrows the plan to some of the batch's lessons (an activity that
 * changes puts back the lessons it no longer takes, and keeps the rest);
 * without it the credits dated today or later go too, which a narrowed plan
 * leaves to its caller.
 */
export interface ReverseOptions {
  only?: ReadonlySet<string>;
  /**
   * False: a lesson whose template has moved is deleted, never carried to the template's slot. An activity that CHANGES puts back
   * the lessons it no longer takes and takes new ones by the new description, which a lesson carried to another day would not be
   * judged by; a removal and a reversal of a whole batch relocate.
   */
  relocate?: boolean;
}

export async function reversePlan(
  tx: PrismaClient,
  schoolId: string,
  row: BatchRow,
  timezone: string,
  options: ReverseOptions = {},
) {
  const today = asDay(todayInZone(timezone));
  const lessons = await tx.cancellationBatchLesson.findMany({
    where: { batchId: row.id, ...(options.only ? { calendarLessonId: { in: [...options.only] } } : {}) },
    select: {
      previousNote: true,
      calendarLesson: {
        select: {
          id: true,
          date: true,
          startsAt: true,
          endsAt: true,
          status: true,
          cancelCause: true,
          roomId: true,
          masterLessonId: true,
          _count: { select: { attendanceRecords: true } },
        },
      },
    },
  });
  const now = new Date();
  const candidates = lessons.filter(
    (entry) =>
      entry.calendarLesson.status === 'CANCELLED' &&
      entry.calendarLesson.cancelCause === row.cause &&
      entry.calendarLesson.startsAt > now &&
      entry.calendarLesson._count.attendanceRecords === 0,
  );
  const skipped: ReversePreview['skippedRoomTaken'] = [];
  const templateMoved: ReversePreview['removedTemplateMoved'] = [];
  const reinstate: Array<{ id: string; previousNote: string | null }> = [];
  const relocate: Relocation[] = [];
  // The slot the lesson runs at NOW. A publish (or a DIRECT edit) since the
  // batch moves the template, materialises the new day, and the batch takes
  // that row too (S7); reinstating the old day's row as well would give the
  // class the lesson twice that week, at a slot no timetable has any more.
  const templates = await publishedTemplates(
    tx,
    schoolId,
    row.academicYearId,
    candidates.map((entry) => entry.calendarLesson),
  );
  // A DIRECT edit of the template since the batch moved only the rows it could carry (the SCHEDULED ones), and wrote no row where
  // the cancelled one stood in the way: a lesson whose template moved and whose new day has no row is the class's lesson that
  // week, and it goes to the template's slot (relocation) instead of being deleted with the old one.
  const relocation = options.relocate === false ? null : await relocationsOf(tx, schoolId, row, candidates.map((entry) => entry.calendarLesson), templates, timezone, now);
  for (const entry of candidates) {
    const lesson = entry.calendarLesson;
    const moved = relocation?.get(lesson.id) ?? null;
    if (moved === null && !runsAt(templates.get(lesson.id) ?? null, lesson, timezone)) {
      templateMoved.push({ lessonId: lesson.id, date: asDay(lesson.date) });
      continue;
    }
    const startsAt = moved?.startsAt ?? lesson.startsAt;
    const endsAt = moved?.endsAt ?? lesson.endsAt;
    if (lesson.roomId !== null) {
      // The room's other SCHEDULED lessons, and its live bookings (the
      // booking flow's own predicate: PENDING or APPROVED), over the slot.
      const found = await tx.calendarLesson.findFirst({
        where: {
          id: { not: lesson.id },
          roomId: lesson.roomId,
          status: 'SCHEDULED',
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { id: true },
      });
      // A lesson there is no taking when the room is a shared one that holds
      // both classes' pupils (Delade salar): asked only now that one was found.
      const other =
        found && (await sharedRoomTakes(tx, schoolId, lesson.id, lesson.roomId, startsAt, endsAt))
          ? null
          : found;
      const booking = other
        ? null
        : await tx.roomBooking.findFirst({
            where: {
              roomId: lesson.roomId,
              status: { in: ['PENDING', 'APPROVED'] },
              startsAt: { lt: endsAt },
              endsAt: { gt: startsAt },
            },
            select: { id: true },
          });
      if (other || booking) {
        skipped.push({ lessonId: lesson.id, date: moved?.to ?? asDay(lesson.date), roomId: lesson.roomId, by: other ? 'LESSON' : 'BOOKING' });
        continue;
      }
    }
    if (moved) relocate.push({ id: lesson.id, previousNote: entry.previousNote, from: asDay(lesson.date), to: moved.to, startsAt, endsAt });
    else reinstate.push({ id: lesson.id, previousNote: entry.previousNote });
  }
  const credits = options.only
    ? []
    : await tx.cancellationBatchCredit.findMany({
        where: { batchId: row.id, credit: { is: { date: { gte: day(today) } } } },
        select: { creditId: true },
      });
  return {
    reinstate,
    relocate,
    skipped,
    templateMoved,
    notReinstatable: lessons.length - candidates.length,
    creditIds: credits.map((entry) => entry.creditId),
  };
}

export function stale(): ConflictException {
  return new ConflictException({
    message: 'Lektionerna i urvalet har ändrats sedan förhandsgranskningen. Granska igen.',
    code: CANCELLATION_STALE,
  });
}

export function reversed(): ConflictException {
  return new ConflictException({
    message: 'Avbokningen är redan återställd.',
    code: CANCELLATION_REVERSED,
  });
}


export type ReversalPlan = Awaited<ReturnType<typeof reversePlan>>;

/**
 * Writes a reversal plan's lessons: every reinstated row back to SCHEDULED
 * with the note it had, every relocated row carried to its template's slot,
 * every other row whose template has moved deleted, in the
 * statements the plan read them by (the guards repeated in the write). Shared
 * by a reversal of the whole batch and by an activity that puts back only some
 * of its lessons.
 */
export async function applyReinstatement(tx: PrismaClient, cause: BatchRow['cause'], plan: ReversalPlan): Promise<void> {
  const byNote = new Map<string | null, string[]>();
  for (const lesson of plan.reinstate) {
    const list = byNote.get(lesson.previousNote) ?? [];
    list.push(lesson.id);
    byNote.set(lesson.previousNote, list);
  }
  for (const [note, lessonIds] of byNote) {
    await tx.calendarLesson.updateMany({
      where: { id: { in: lessonIds }, status: 'CANCELLED', cancelCause: cause },
      data: { status: 'SCHEDULED', cancelCause: null, note },
    });
  }
  // A lesson carried to the template's slot: the same guards, and the new date and hours with it.
  for (const move of plan.relocate) {
    await tx.calendarLesson.updateMany({
      where: { id: move.id, status: 'CANCELLED', cancelCause: cause, startsAt: { gt: new Date() }, attendanceRecords: { none: {} } },
      data: { date: day(move.to), startsAt: move.startsAt, endsAt: move.endsAt, status: 'SCHEDULED', cancelCause: null, note: move.previousNote },
    });
  }
  if (plan.templateMoved.length > 0) {
    await tx.calendarLesson.deleteMany({
      where: {
        id: { in: plan.templateMoved.map((entry) => entry.lessonId) },
        status: 'CANCELLED',
        cancelCause: cause,
        startsAt: { gt: new Date() },
        attendanceRecords: { none: {} },
      },
    });
  }
}

/** The year, its timezone and the school's today; a selection's range must lie inside the year. */
export async function yearOf(
  tx: PrismaClient,
  academicYearId: string,
  selection: StoredSelection | null,
): Promise<{ timezone: string; today: string }> {
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { startDate: true, endDate: true, school: { select: { timezone: true } } },
  });
  if (!year) throw new NotFoundException('Läsåret finns inte.');
  if (selection && (selection.fromDate < asDay(year.startDate) || selection.toDate > asDay(year.endDate))) {
    throw new BadRequestException({
      message: `fromDate/toDate: avbokningen ligger inom läsåret (${asDay(year.startDate)}–${asDay(year.endDate)}).`,
      code: CANCELLATION_RANGE,
    });
  }
  if (selection && selection.scope === 'GROUPS') {
    const found = await tx.studentGroup.count({ where: { id: { in: selection.groupIds }, academicYearId } });
    if (found !== new Set(selection.groupIds).size) {
      throw new BadRequestException({
        message: 'groupIds: varje grupp ska vara en grupp i läsåret.',
        code: CANCELLATION_SCOPE,
      });
    }
  }
  return { timezone: year.school.timezone, today: asDay(todayInZone(year.school.timezone)) };
}
