import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { ConflictReads } from '../calendar/conflict-reads';
import type { DayLesson, MasterLessonConflict, MasterLessonsService } from '../calendar/master-lessons.service';
import type { GradeNumbering } from '../common/grade-numbering';
import type { LessonShape } from '../common/lesson-lengths';
import type { LessonShare } from '../common/lesson-shares';
import type { TaughtLesson } from '../optimization/locked-coverage';
import { PRESERVED_FROM_REGENERATION } from '../optimization/preserved-lessons';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { windowOf } from '../common/lunch-window';
import { boardCodeOf, readBoardFacts, type BoardFacts } from '../swaps/board-rules';
import type { RosterBasis } from '../year-rollover/projected-rosters';
import { insideSchoolDay, placementsFitBesideLocks, sharedPlacementsFitBesideLocks } from './placement-fit';

/*
 * FÖRLAGDA POSTER: DOES A FÖRLÄGGNING STAND WHERE THE SCHOOL PUT IT?
 *
 * A förläggning is judged by the rule a lesson placed by hand in the
 * grundschema is held to, and by no rule of its own, in the order a person
 * would give the reason (first one wins, and a row that fails an earlier
 * question is not asked the later ones):
 *
 *   SCHOOL_DAY    Monday to Friday, 08:00 to 18:00, on the five-minute grid
 *   OVER_DEMAND   the post's locks already answer the lessons its rows place
 *   TEACHER, ROOM, GROUP, PUPILS, AVAILABILITY
 *                 MasterLessonsService.findConflicts, the clash rule itself
 *   FRAME, LUNCH, GRADE_RULE
 *                 the board's rules (swaps/board-rules.ts), as G1 and G5 hold a landing to them
 *   OTHER_SCHOOL  a shared teacher's lessons at another school of the
 *                 huvudman, a room lent out or borrowed
 *
 * THE LESSONS A ROW IS HELD AGAINST are the ones the next Generera keeps
 * (PRESERVED_FROM_REGENERATION, not parked), plus the other förläggningar:
 * the rows being judged and the year's other posts' rows (`beside`). Not the
 * generated lessons, which Generera deletes and writes again around the
 * förläggningar. That includes the lessons Generera wrote from a förläggning
 * (`fromPlacement`): it replaces them from the rows as they then stand, so
 * they are drafts, and the PRESERVED filter already leaves them out. One that
 * somebody has since given a second class, named pupils or a window is kept
 * by those arms like any lesson, and a row is held against it like any other:
 * the school has put something else in that place, and says so by name.
 *
 * ONE READ PER FACT, NOT PER ROW. The kept lessons are read once for the year
 * and the weekdays the rows stand on, the board's facts once per weekday, the
 * other schools' holds once, and the clash rule's own reads through one
 * ConflictReads for the call (it lives for this transaction, in which nothing
 * is written between its first row and its last). A call costs the same few
 * statements for one row and for eighty.
 *
 * NO PERSON IS NAMED. A refusal names the other lesson as a class and a
 * subject at a weekday and a time, never a teacher or a pupil: a protected
 * identity must not be read out of a teacher's clash.
 */

export type PlacementRefusalReason =
  /** findConflicts: the teacher (or the medlärare) teaches another lesson then. */
  | 'TEACHER'
  | 'ROOM'
  | 'GROUP'
  /** findConflicts: another group that shares pupils with the class, then. */
  | 'PUPILS'
  /** A weekly UNAVAILABLE row; `params.resource` is 'TEACHER', 'ROOM' or 'GROUP'. */
  | 'AVAILABILITY'
  | 'FRAME'
  | 'LUNCH'
  | 'GRADE_RULE'
  /** `params.schools`: the other schools by name, "Skola A, Skola B". */
  | 'OTHER_SCHOOL'
  | 'SCHOOL_DAY'
  | 'OVER_DEMAND';

export type PlacementParams = Record<string, string | number>;

/** One förläggning as the judge reads it. */
export interface JudgedPlacement {
  /** The row's id, or null for a draft row at save. */
  id: string | null;
  requirementId: string;
  studentGroupId: string;
  subjectId: string;
  /**
   * Who teaches the lesson: the post's teacher, or on a post with delade
   * lektioner the förläggning's own (teacherOfRow). The clash rule and the
   * other schools' holds are asked about THIS teacher's week.
   */
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: number;
  startMinutes: number;
  minutes: number;
  roomId: string;
  recurrence: LessonRecurrence;
  /** The post's window, which the written lesson carries. */
  startDate: Date | null;
  endDate: Date | null;
}

export interface PlacementVerdict {
  index: number;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: PlacementParams;
}

export interface JudgePlacementsInput {
  academicYearId: string;
  schoolId: string;
  gradeNumbering: GradeNumbering;
  basis: RosterBasis;
  /** Judged, each against every other row here and in `beside`, and against the kept lessons. */
  rows: readonly JudgedPlacement[];
  /** Rows judged beside but not themselves (the year's other posts' rows, at save). */
  beside: readonly JudgedPlacement[];
  /**
   * Each post's lengths, its covering locks' minutes and the lessons its rows
   * place, for OVER_DEMAND. A post that is absent here is not asked; the call
   * without the map skips the question.
   */
  demand?: ReadonlyMap<string /* requirementId */, PlacementDemand>;
}

/** What OVER_DEMAND reads of one post. */
export interface PlacementDemand {
  post: LessonShape & { teacherId?: string | null; shares?: readonly LessonShare[] | null };
  lockedMinutes: number[];
  placed: number[];
  /**
   * Delade lektioner: the covering locks and the placed lessons with their
   * teachers, on a post that shares its lessons. Present, it is what is
   * asked (sharedPlacementsFitBesideLocks: Bo's lock answers Bo's lesson).
   */
  taught?: { locked: TaughtLesson[]; placed: TaughtLesson[] };
}

/** The sentences findConflicts gives an AVAILABILITY hit, one per resource it names. */
export type AvailabilityResource = 'TEACHER' | 'ROOM' | 'GROUP';

/**
 * Which resource an AVAILABILITY hit is about. findConflicts says it only in
 * a sentence ("The teacher is unavailable in this slot." and its two
 * siblings, one for the room and one for the student group), so the sentence
 * is read; the judge's spec runs the real rule over a constraint of each kind
 * to hold this to what the rule says.
 */
export function availabilityResourceOf(message: string): AvailabilityResource {
  if (/\bteacher\b/i.test(message)) return 'TEACHER';
  if (/\broom\b/i.test(message)) return 'ROOM';
  return 'GROUP';
}

const KEPT_SELECT = {
  id: true,
  dayOfWeek: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  studentGroupId: true,
  subjectId: true,
  startTime: true,
  endTime: true,
  recurrence: true,
  startDate: true,
  endDate: true,
  subject: { select: { name: true } },
  studentGroup: { select: { name: true } },
  extraGroups: { select: { studentGroupId: true } },
  participants: { select: { studentId: true } },
} as const;

/** A name in a refusal's params: the exception filter drops the whole member past 200 characters. */
const NAME_LIMIT = 120;
const shortened = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

const pad = (value: number): string => String(value).padStart(2, '0');
export const clockText = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
/** A time of day as the @db.Time column the clash rule reads. */
const timeOf = (minutes: number): Date => new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
const minutesOfTime = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
const holdMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** What a hit names of the other side: which kind it is, its groups and where it stands. */
interface Other {
  kind: 'LESSON' | 'PLACEMENT';
  groupIds: ReadonlySet<string>;
  className: string;
  subjectName: string;
  day: number;
  start: number;
  end: number;
}

/** A lesson of the day a row is held against, and the row it is when it is one. */
interface DayItem {
  lesson: DayLesson;
  other: Other;
  /** The index in `rows` of the row this stands for; null for a kept lesson or a `beside` row. */
  self: number | null;
}

/** The order a person is told the reason in when a row breaks several. */
const CLASH_RANK: Readonly<Record<string, number>> = { TEACHER: 0, ROOM: 1, GROUP: 2, PUPILS: 3, AVAILABILITY: 4 };

/**
 * Judges the förläggningar in `rows`, in their order: a verdict for each.
 * Reads; writes nothing. See the file's first paragraphs for what it holds a
 * row to and what it reads.
 */
export async function judgePlacements(
  tx: PrismaClient,
  masters: Pick<MasterLessonsService, 'findConflicts'>,
  input: JudgePlacementsInput,
): Promise<PlacementVerdict[]> {
  const { rows, beside } = input;
  if (rows.length === 0) return [];

  const verdicts: PlacementVerdict[] = rows.map((_, index) => ({ index, ok: true }));
  const refuse = (index: number, reason: PlacementRefusalReason, params?: PlacementParams): void => {
    verdicts[index] = { index, ok: false, reason, ...(params ? { params } : {}) };
  };

  // 1. The school day, and 2. the post's demand: questions about the row alone.
  const overDemand = new Set<string>();
  for (const [requirementId, post] of input.demand ?? []) {
    const fits = post.taught
      ? sharedPlacementsFitBesideLocks(
          { ...post.post, teacherId: post.post.teacherId ?? null },
          post.taught.locked,
          post.taught.placed,
        )
      : placementsFitBesideLocks(post.post, post.lockedMinutes, post.placed);
    if (!fits) overDemand.add(requirementId);
  }
  const open: number[] = [];
  rows.forEach((row, index) => {
    if (!insideSchoolDay(row)) refuse(index, 'SCHOOL_DAY');
    else if (overDemand.has(row.requirementId)) refuse(index, 'OVER_DEMAND');
    else open.push(index);
  });
  if (open.length === 0) return verdicts;

  // What the other lessons are called, and the lessons themselves.
  const days = [...new Set(open.map((index) => rows[index]!.dayOfWeek))].sort((a, b) => a - b);
  // A row in `rows` is also in `beside` when a caller passes the whole year twice; the judged copy stands.
  const judgedIds = new Set(rows.flatMap((row) => (row.id === null ? [] : [row.id])));
  const besideRows = beside.filter((row) => row.id === null || !judgedIds.has(row.id));
  const everyRow = [...rows, ...besideRows];
  const [groups, subjects, kept] = await Promise.all([
    tx.studentGroup.findMany({
      where: { id: { in: [...new Set(everyRow.map((row) => row.studentGroupId))] } },
      select: { id: true, name: true },
    }),
    tx.subject.findMany({
      where: { id: { in: [...new Set(everyRow.map((row) => row.subjectId))] } },
      select: { id: true, name: true },
    }),
    tx.masterLesson.findMany({
      where: {
        academicYearId: input.academicYearId,
        isParked: false,
        dayOfWeek: { in: days },
        OR: PRESERVED_FROM_REGENERATION,
      },
      select: KEPT_SELECT,
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));

  const itemsOfDay = new Map<number, DayItem[]>();
  const push = (day: number, item: DayItem): void => {
    const list = itemsOfDay.get(day);
    if (list) list.push(item);
    else itemsOfDay.set(day, [item]);
  };
  for (const lesson of kept) {
    const groupsOf = [lesson.studentGroupId, ...lesson.extraGroups.map((entry) => entry.studentGroupId)];
    push(lesson.dayOfWeek, {
      lesson,
      self: null,
      other: {
        kind: 'LESSON',
        groupIds: new Set(groupsOf),
        className: shortened(lesson.studentGroup.name, NAME_LIMIT),
        subjectName: shortened(lesson.subject.name, NAME_LIMIT),
        day: lesson.dayOfWeek,
        start: minutesOfTime(lesson.startTime),
        end: minutesOfTime(lesson.endTime),
      },
    });
  }
  const asItem = (row: JudgedPlacement, id: string, self: number | null): DayItem => {
    const subject = subjectName.get(row.subjectId) ?? '';
    return {
      self,
      lesson: {
        id,
        teacherId: row.teacherId,
        coTeacherId: row.coTeacherId,
        roomId: row.roomId,
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        startTime: timeOf(row.startMinutes),
        endTime: timeOf(row.startMinutes + row.minutes),
        recurrence: row.recurrence,
        startDate: row.startDate,
        endDate: row.endDate,
        subject: { name: subject },
        extraGroups: [],
        participants: [],
      },
      other: {
        kind: 'PLACEMENT',
        groupIds: new Set([row.studentGroupId]),
        className: shortened(groupName.get(row.studentGroupId) ?? '', NAME_LIMIT),
        subjectName: shortened(subject, NAME_LIMIT),
        day: row.dayOfWeek,
        start: row.startMinutes,
        end: row.startMinutes + row.minutes,
      },
    };
  };
  rows.forEach((row, index) => push(row.dayOfWeek, asItem(row, `placement:${row.id ?? index}`, index)));
  besideRows.forEach((row, index) => push(row.dayOfWeek, asItem(row, `placement:${row.id ?? `beside-${index}`}`, null)));

  const reads = new ConflictReads();
  // 3. The clash rule.
  const stillOpen: number[] = [];
  for (const index of open) {
    const row = rows[index]!;
    const against = (itemsOfDay.get(row.dayOfWeek) ?? []).filter((item) => item.self !== index);
    const others = new Map(against.map((item) => [item.lesson.id, item.other]));
    const hits = await masters.findConflicts(
      tx,
      input.basis,
      { id: null, academicYearId: input.academicYearId, studentGroupId: row.studentGroupId, subjectId: row.subjectId },
      {
        dayOfWeek: row.dayOfWeek,
        startMinutes: row.startMinutes,
        endMinutes: row.startMinutes + row.minutes,
        teacherId: row.teacherId,
        coTeacherId: row.coTeacherId,
        roomId: row.roomId,
        extraGroupIds: [],
        studentIds: [],
        recurrence: row.recurrence,
        startDate: row.startDate,
        endDate: row.endDate,
      },
      { against: against.map((item) => item.lesson), reads },
    );
    const refusal = clashRefusal(hits, row, others);
    if (refusal) refuse(index, refusal.reason, refusal.params);
    else stillOpen.push(index);
  }
  if (stillOpen.length === 0) return verdicts;

  // 4. The board's rules, from facts read once per weekday.
  const boards = new Map<number, BoardFacts>();
  const boardOf = async (day: number): Promise<BoardFacts> => {
    let facts = boards.get(day);
    if (!facts) {
      facts = await readBoardFacts(tx, {
        academicYearId: input.academicYearId,
        schoolId: input.schoolId,
        gradeNumbering: input.gradeNumbering,
        basis: input.basis,
        groupIds: [...new Set(stillOpen.filter((i) => rows[i]!.dayOfWeek === day).map((i) => rows[i]!.studentGroupId))],
        weekday: day,
        // The meals the school placed, not the ones Generera laid and lays
        // again around the förläggning (MEDEL-1 of #293); a förläggning that
        // leaves a class no lunch is the engine's to refuse by name.
        handPlacedSittingsOnly: true,
      });
      boards.set(day, facts);
    }
    return facts;
  };
  const lastOpen: number[] = [];
  for (const index of stillOpen) {
    const row = rows[index]!;
    const code = boardCodeOf(
      await boardOf(row.dayOfWeek),
      [row.studentGroupId],
      {
        dayOfWeek: row.dayOfWeek,
        startMinutes: row.startMinutes,
        endMinutes: row.startMinutes + row.minutes,
      },
      // The post's weeks: a meal of another part of the läsår is not its meal.
      windowOf(row),
    );
    if (code !== null) refuse(index, code);
    else lastOpen.push(index);
  }
  if (lastOpen.length === 0) return verdicts;

  // 5. The other schools' hold on the teachers and the room. A hold has no
  // weeks: the generator keeps a shared teacher out of every week of the plan
  // for a lesson elsewhere in odd weeks only (other-school-busy.ts), so a
  // row of any weeks meets it, and the judge is no looser than the engine.
  const holds = (await readOtherSchoolHolds(tx, input.academicYearId, input.schoolId)).holds;
  if (holds.length > 0) {
    for (const index of lastOpen) {
      const row = rows[index]!;
      const schools = holdSchools(holds, row);
      if (schools.length > 0) refuse(index, 'OTHER_SCHOOL', { schools: shortened(schools.join(', '), 200) });
    }
  }
  return verdicts;
}

/** The reason and params of the hit a person is told first, or null when the rule found none. */
function clashRefusal(
  hits: readonly MasterLessonConflict[],
  row: JudgedPlacement,
  others: ReadonlyMap<string, Other>,
): { reason: PlacementRefusalReason; params?: PlacementParams } | null {
  const named = hits.map((hit) => {
    const other = hit.masterLessonId === undefined ? undefined : others.get(hit.masterLessonId);
    const reason: PlacementRefusalReason =
      hit.kind === 'GROUP' ? (other?.groupIds.has(row.studentGroupId) ? 'GROUP' : 'PUPILS') : hit.kind;
    return { hit, other, reason };
  });
  // Stable: among hits of one rank the first the rule gave stays first.
  named.sort((a, b) => (CLASH_RANK[a.reason] ?? 9) - (CLASH_RANK[b.reason] ?? 9));
  const first = named[0];
  if (!first) return null;
  if (first.reason === 'AVAILABILITY') {
    return { reason: 'AVAILABILITY', params: { resource: availabilityResourceOf(first.hit.message) } };
  }
  if (!first.other) return { reason: first.reason };
  const { other } = first;
  return {
    reason: first.reason,
    params: {
      otherKind: other.kind,
      className: other.className,
      subjectName: other.subjectName,
      day: other.day,
      start: clockText(other.start),
      end: clockText(other.end),
    },
  };
}

/** The other schools whose hold on a row's teachers or room it stands in, by name. */
function holdSchools(holds: readonly OtherSchoolHold[], row: JudgedPlacement): string[] {
  const teachers = new Set([row.teacherId, row.coTeacherId].filter((id): id is string => id !== null));
  const schools = new Set<string>();
  for (const hold of holds) {
    if (hold.dayOfWeek !== row.dayOfWeek) continue;
    const mine = hold.resourceKind === 'TEACHER' ? teachers.has(hold.resourceId) : hold.resourceId === row.roomId;
    if (!mine) continue;
    if (!overlaps(row.startMinutes, row.startMinutes + row.minutes, holdMinutes(hold.startTime), holdMinutes(hold.endTime))) continue;
    for (const school of hold.schools) schools.add(school);
  }
  return [...schools].sort((a, b) => a.localeCompare(b, 'sv'));
}
