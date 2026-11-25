import { HttpException, HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { dateShiftDays, mapPeriod } from '../common/year-rollover';
import type { VersionLesson } from '../calendar/schedule-versions.service';
import { clockOf, dayOf, type DraftContent } from './candidate-basis';
import {
  START_VERSION_NAME_MAX,
  type SourceLesson,
  type StartDropped,
  type StartMapping,
  type StartRequest,
} from './start-schedule';

/**
 * Where a schedule to start from is READ (omgång 15, M9; the mapping to posts is start-schedule.ts). Three sources, each
 * ending as the same SourceLesson in real ids and in the weeks the lesson ran:
 *
 *   CURRENT        this year's grundschema as it stands: the lessons the next Generera replaces (the machine-owned
 *                  masters, which the fetch has already read: `draftLessons`). What the school locked or placed by hand
 *                  is never among them, since that is in the payload as locks already.
 *   PREVIOUS_YEAR  the year this one was rolled over from (AcademicYear.predecessorId): its masters under the successor of
 *                  each group (StudentGroup.predecessorId), and the dates of a post that ran in part of the year moved as
 *                  the rollover moved the post's (mapPeriod), so that an autumn post's lessons meet this year's autumn post.
 *   VERSION        a saved version of THIS year (ScheduleVersion): an earlier run, a schedule the school saved, or a
 *                  schedule read in from a file and saved as a version. A version of another year is not offered: its
 *                  groups are another year's.
 *
 * NOTHING HERE WRITES. The reads are the caller's transaction, under the caller's RLS.
 */

/** A refusal with its code and flat params: what a run stores and the page says in Swedish. */
function refusal(status: HttpStatus, code: string, message: string, params: Record<string, string | number> = {}): HttpException {
  return new HttpException({ message, code, params }, status);
}

export const START_NO_PREVIOUS_YEAR = 'START_NO_PREVIOUS_YEAR';
export const START_VERSION_NOT_FOUND = 'START_VERSION_NOT_FOUND';
export const START_NOTHING_TO_START_FROM = 'START_NOTHING_TO_START_FROM';

/** The läsår has no year it was rolled over from, so there is no last year's schedule to start from. */
export function noPreviousYear(): HttpException {
  return refusal(
    HttpStatus.CONFLICT,
    START_NO_PREVIOUS_YEAR,
    'This school year was not created from an earlier one, so there is no earlier schedule to start from.',
  );
}

/** The saved version is not one of this year's (or is gone). */
export function versionNotFound(): HttpException {
  return refusal(
    HttpStatus.NOT_FOUND,
    START_VERSION_NOT_FOUND,
    'That saved version is not one of this school year’s, so it cannot be started from.',
  );
}

/**
 * The schedule gave the engine no lesson to start from: nothing is sent, and a week laid from nothing is not what the
 * school asked for. The counts are flat (the exception filter forwards only flat params) and say why.
 */
export function nothingToStartFrom(source: string, mapping: Pick<StartMapping, 'offered' | 'dropped'>): HttpException {
  const params: Record<string, string | number> = { source, offered: mapping.offered };
  const names: Record<string, string> = {
    NO_SUCCESSOR: 'noSuccessor',
    NO_POST: 'noPost',
    NOT_IN_WEEK: 'notInWeek',
    OTHER_WEEKS: 'otherWeeks',
    AMBIGUOUS: 'ambiguous',
    NOT_STARTABLE: 'notStartable',
    MORE_THAN_ASKED: 'moreThanAsked',
  };
  for (const [reason, count] of Object.entries(mapping.dropped)) {
    if (typeof count === 'number' && count > 0 && names[reason] !== undefined) params[names[reason]!] = count;
  }
  return refusal(
    HttpStatus.CONFLICT,
    START_NOTHING_TO_START_FROM,
    'The chosen schedule has no lesson that belongs to a post of this week, so there is nothing to start from.',
    params,
  );
}

/** What a source gave: the lessons, and what it could not map before the posts were asked. */
export interface SourceRead {
  lessons: SourceLesson[];
  /** Lessons the source held that never became a SourceLesson (a class with no successor): counted, so they are told. */
  already: { offered: number; dropped: StartDropped };
  /** The saved version's name, for source VERSION. */
  versionName: string | null;
}

const fromDraft = (lesson: DraftContent & { isParked?: boolean }): SourceLesson => ({
  studentGroupId: lesson.studentGroupId,
  subjectId: lesson.subjectId,
  dayOfWeek: lesson.dayOfWeek,
  startTime: lesson.startTime,
  endTime: lesson.endTime,
  recurrence: lesson.recurrence,
  startDate: lesson.startDate,
  endDate: lesson.endDate,
});

/**
 * A version's lessons that may be a start: the machine's own and the ones nobody has taken over. A locked lesson is a fact
 * (and is in the payload as one, if it is still there), a lesson placed by hand is kept by the next Generera as it stands,
 * a parked lesson occupies nothing, and a lesson written from a förläggning is written again from the förläggning. Absent
 * `isGenerated` is read as the machine's, which is the side to be wrong on here: a snapshot from before the field is
 * mostly generated lessons, and a start is only ever held until the week shows it cannot stay.
 */
function isStartLesson(lesson: VersionLesson): boolean {
  return lesson.isLocked !== true && lesson.isParked !== true && lesson.isGenerated !== false && lesson.fromPlacement !== true;
}

const clock = (value: unknown): string | null => (typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value) ? value : null);

/** A version's lessons as the column holds them, each checked: a row that is not wholly well formed is left out, not guessed at. */
export function versionLessonsOf(stored: unknown): SourceLesson[] {
  if (!Array.isArray(stored)) return [];
  const out: SourceLesson[] = [];
  for (const entry of stored as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const lesson = entry as VersionLesson;
    const start = clock(lesson.startTime);
    const end = clock(lesson.endTime);
    if (
      typeof lesson.studentGroupId !== 'string' ||
      typeof lesson.subjectId !== 'string' ||
      !Number.isInteger(lesson.dayOfWeek) ||
      start === null ||
      end === null ||
      !isStartLesson(lesson)
    ) {
      continue;
    }
    out.push({
      studentGroupId: lesson.studentGroupId,
      subjectId: lesson.subjectId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: start,
      endTime: end,
      recurrence: lesson.recurrence ?? null,
      startDate: typeof lesson.startDate === 'string' ? lesson.startDate.slice(0, 10) : null,
      endDate: typeof lesson.endDate === 'string' ? lesson.endDate.slice(0, 10) : null,
    });
  }
  return out;
}

/**
 * The checks a click can make before a run is queued, with nothing solved: a version that is not this year's, and a year
 * with no year before it. Everything that needs the week (does the schedule have a lesson for any post of it) waits for
 * the run, which stores the refusal with the code.
 */
export async function assertStartable(tx: PrismaClient, academicYearId: string, request: StartRequest): Promise<void> {
  if (request.source === 'VERSION') {
    const found =
      request.versionId === undefined
        ? null
        : await tx.scheduleVersion.findFirst({ where: { id: request.versionId, academicYearId }, select: { id: true } });
    if (found === null) throw versionNotFound();
  }
  if (request.source === 'PREVIOUS_YEAR') {
    const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { predecessorId: true } });
    if (year?.predecessorId == null) throw noPreviousYear();
  }
}

/** The schedule `request` names, as lessons in real ids. */
export async function readStartSource(
  tx: PrismaClient,
  academicYearId: string,
  request: StartRequest,
  draft: readonly (DraftContent & { isParked?: boolean })[],
): Promise<SourceRead> {
  if (request.source === 'CURRENT') {
    const lessons = draft.filter((lesson) => lesson.isParked !== true).map(fromDraft);
    return { lessons, already: { offered: 0, dropped: {} }, versionName: null };
  }

  if (request.source === 'VERSION') {
    const version =
      request.versionId === undefined
        ? null
        : await tx.scheduleVersion.findFirst({
            where: { id: request.versionId, academicYearId },
            select: { name: true, lessons: true },
          });
    if (version === null) throw versionNotFound();
    // A lesson the version holds that is not a start (a lock, a hand-placed or a parked lesson) is not "offered": the
    // schedule the school is starting from is the machine's, and the others are in the week as they stand.
    return {
      lessons: versionLessonsOf(version.lessons),
      already: { offered: 0, dropped: {} },
      versionName: version.name.slice(0, START_VERSION_NAME_MAX),
    };
  }

  // PREVIOUS_YEAR
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { startDate: true, endDate: true, predecessorId: true },
  });
  if (year === null || year.predecessorId === null) throw noPreviousYear();
  const previous = await tx.academicYear.findUnique({
    where: { id: year.predecessorId },
    select: { startDate: true, endDate: true },
  });
  if (previous === null) throw noPreviousYear();

  const successors = await tx.studentGroup.findMany({
    where: { academicYearId, predecessorId: { not: null } },
    select: { id: true, predecessorId: true },
  });
  const successorOf = new Map(successors.flatMap((group) => (group.predecessorId === null ? [] : [[group.predecessorId, group.id] as const])));

  const old = await tx.masterLesson.findMany({
    where: { academicYearId: year.predecessorId, isParked: false },
    select: {
      studentGroupId: true,
      subjectId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      // A lesson of several classes or of named pupils belongs to no one post: the school placed it by hand.
      _count: { select: { extraGroups: true, participants: true } },
    },
  });

  const source = { startDate: dayOf(previous.startDate)!, endDate: dayOf(previous.endDate)! };
  const target = { startDate: dayOf(year.startDate)!, endDate: dayOf(year.endDate)! };
  const shift = dateShiftDays(source.startDate, target.startDate);

  const dropped: StartDropped = {};
  const lessons: SourceLesson[] = [];
  for (const lesson of old) {
    if (lesson._count.extraGroups > 0 || lesson._count.participants > 0) {
      dropped.NOT_STARTABLE = (dropped.NOT_STARTABLE ?? 0) + 1;
      continue;
    }
    const group = successorOf.get(lesson.studentGroupId);
    if (group === undefined) {
      dropped.NO_SUCCESSOR = (dropped.NO_SUCCESSOR ?? 0) + 1;
      continue;
    }
    const weeks = mapPeriod(dayOf(lesson.startDate), dayOf(lesson.endDate), source, target, shift);
    if (weeks.status === 'DROPPED') {
      dropped.OTHER_WEEKS = (dropped.OTHER_WEEKS ?? 0) + 1;
      continue;
    }
    lessons.push({
      studentGroupId: group,
      subjectId: lesson.subjectId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: clockOf(lesson.startTime)!,
      endTime: clockOf(lesson.endTime)!,
      recurrence: lesson.recurrence,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
    });
  }
  const refused = Object.values(dropped).reduce((sum, count) => sum + (count ?? 0), 0);
  return { lessons, already: { offered: refused, dropped }, versionName: null };
}
