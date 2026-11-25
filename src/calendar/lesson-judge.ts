import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import type { GradeNumbering } from '../common/grade-numbering';
import { windowOf } from '../common/lunch-window';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { boardCodeOf, readBoardFacts, type BoardCode, type BoardFacts } from '../swaps/board-rules';
import type { RosterBasis } from '../year-rollover/projected-rosters';
import type { ConflictReads } from './conflict-reads';
import type { DayLesson, MasterLessonConflict, MasterLessonsService } from './master-lessons.service';

/*
 * E1, EN DOMARE MED ORD: IS THIS LESSON ALLOWED TO STAND HERE?
 *
 * The grundschema's lessons are written by hand along four roads (create, the
 * PATCH, a block's card, and the swaps' apply), and until now three of them
 * held a lesson to less than the fourth and the förläggning did: the clash rule
 * (findConflicts) and nothing else. A lesson could be saved through the dialog
 * onto the class's lunch, out of the stage's ramtid, on an hour closed to the
 * årskurs, or on top of a shared teacher's lesson at another school, which a
 * swap and a förläggning would have refused by name.
 *
 * This is the one place the hand edit asks. It holds a candidate to:
 *
 *   TEACHER, ROOM, GROUP, PUPILS, AVAILABILITY
 *                 MasterLessonsService.findConflicts, the clash rule itself, and
 *                 its answer named: the other lesson by class, subject, day and
 *                 time, never a person
 *   FRAME, LUNCH, GRADE_RULE
 *                 the board's rules (swaps/board-rules.ts), as the swaps and the
 *                 klasslärare hold a landing to them
 *   OTHER_SCHOOL  a shared teacher's lessons at another school of the huvudman,
 *                 a room lent out or borrowed (optimization/other-school-holds.ts)
 *
 * and answers every reason it finds, the heaviest first, in the order the
 * förläggning's judge gives a person its reason (requirement-placements/
 * placement-judge.ts). It reads; it writes nothing.
 *
 * "LÅT STÅ" (the user's decision 4). A lesson that already stands against FRAME,
 * LUNCH, GRADE_RULE or OTHER_SCHOOL (a timetable read in from a file, a rule
 * written after the lesson was) may be changed on anything but where it stands,
 * as a förläggning that has stopped holding may (placement-unchanged.ts): the
 * rule is asked of a candidate whose slot, weeks or classes moved, and for
 * OTHER_SCHOOL also one whose teacher or room did. A caller that gives no
 * `stands` has a lesson that stands nowhere yet (a new lesson, one back from the
 * tray) and gets every rule. The clash arm is NOT eased: findConflicts has always
 * judged the whole candidate, and a PATCH that only changes a room on a lesson in
 * a clash is refused as it was.
 *
 * WHICH MEALS. The class's meals as they lie, those Generera laid as well as
 * those the school placed: the grid paints them all and a swap holds a landing to
 * them all. A förläggning is held to the school's own only (it is laid again
 * around the engine's meals), which is the one difference the property probe
 * (scripts/test/probe-domaren.ts) names.
 *
 * ONE READ PER FACT. The board's facts are read once per weekday for every group
 * the items name, the other schools' holds once, the names of the lessons a clash
 * names once, however many items are asked. A call that finds nothing wrong sends
 * the clash rule's own reads, the board's, and the holds'.
 */

export type LessonRefusalReason =
  /** The day is not a school day (Monday to Friday): the förläggning's own first question, asked here of the day alone. */
  | 'SCHOOL_DAY'
  | 'TEACHER'
  | 'ROOM'
  | 'GROUP'
  | 'PUPILS'
  | 'AVAILABILITY'
  | BoardCode
  | 'OTHER_SCHOOL';

/** Flat, as the exception filter forwards it: strings and numbers only. */
export type LessonRefusalParams = Record<string, string | number>;

export interface LessonRefusal {
  reason: LessonRefusalReason;
  params: LessonRefusalParams;
}

export interface LessonVerdict {
  ok: boolean;
  /** Every reason found, the heaviest first. Empty when `ok`. */
  refusals: LessonRefusal[];
}

/** The läsande frågan's answer for one tänkt drag: the verdict, each reason with its sentence, and whether the lesson may be moved at all. */
export interface MoveJudgement {
  lessonId: string;
  ok: boolean;
  /** The lesson is a förläggning's, written by Generera: it is changed on the timplan, and no drag of it stands (LESSON_IS_PLACED). */
  placed?: true;
  refusals: Array<LessonRefusal & { text: string }>;
}

export interface LessonJudgement {
  /** Every drag stands. */
  ok: boolean;
  moves: MoveJudgement[];
}

/** Where a lesson stands, or is asked to stand: findConflicts' candidate. */
export interface JudgedCandidate {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  extraGroupIds?: string[];
  studentIds?: string[];
  recurrence?: LessonRecurrence;
  startDate?: Date | null;
  endDate?: Date | null;
}

export interface JudgeItem {
  lesson: {
    /** Null for a lesson that is not stored yet. */
    id: string | null;
    studentGroupId: string;
    subjectId: string;
  };
  candidate: JudgedCandidate;
  /**
   * Where the lesson stands now, for "låt stå". Absent: it stands nowhere, and
   * every rule is asked.
   */
  stands?: JudgedCandidate | null;
  /** A block card's move: the lessons not where they stood, and the ones moved with this. */
  excludeIds?: readonly string[];
  alongside?: readonly DayLesson[];
}

export interface JudgeWorld {
  academicYearId: string;
  schoolId: string;
  /** The year's roster basis: every pupil read is read through it. */
  basis: RosterBasis;
  /** The year's numbering of its stages, when the caller has read the year already: spares the judge one statement. */
  gradeNumbering?: GradeNumbering;
}

/** The order a person is told the reason in when a lesson breaks several (placement-judge.ts CLASH_RANK). */
const CLASH_RANK: Readonly<Record<string, number>> = { TEACHER: 0, ROOM: 1, GROUP: 2, PUPILS: 3, AVAILABILITY: 4 };

/** A name in a refusal's params: the exception filter drops the whole member past 200 characters. */
const NAME_LIMIT = 120;
const shortened = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

const pad = (value: number): string => String(value).padStart(2, '0');
const clockText = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const minutesOfTime = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const holdMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/** The sentences findConflicts gives an AVAILABILITY hit, one per resource it names. */
function availabilityResourceOf(message: string): 'TEACHER' | 'ROOM' | 'GROUP' {
  if (/\bteacher\b/i.test(message)) return 'TEACHER';
  if (/\broom\b/i.test(message)) return 'ROOM';
  return 'GROUP';
}

// The dates a lesson runs in, and not which weeks of them (`recurrence`): a meal is read by dates (lunch-window.ts windowOf) and an
// other school's hold has no weeks, so every week, the odd ones and the even ones stand in the same place as far as a rule can see.
const sameWindow = (a: JudgedCandidate, b: JudgedCandidate): boolean =>
  (a.startDate?.getTime() ?? null) === (b.startDate?.getTime() ?? null) &&
  (a.endDate?.getTime() ?? null) === (b.endDate?.getTime() ?? null);
const sameGroups = (a: JudgedCandidate, b: JudgedCandidate): boolean => {
  const left = [...new Set(a.extraGroupIds ?? [])].sort().join(',');
  const right = [...new Set(b.extraGroupIds ?? [])].sort().join(',');
  return left === right;
};

const LAST_SCHOOL_DAY = 5;

/** Whether an edit puts a lesson on a day that is no school day: asked of an edit that changes the day (låt stå). */
function outsideSchoolDay(item: JudgeItem): boolean {
  const day = item.candidate.dayOfWeek;
  return (day < 1 || day > LAST_SCHOOL_DAY) && (!item.stands || item.stands.dayOfWeek !== day);
}

/** What the board's three rules read of a candidate: where it stands, in which weeks, for which classes. */
export function placementChanged(now: JudgedCandidate, was: JudgedCandidate): boolean {
  return (
    now.dayOfWeek !== was.dayOfWeek ||
    now.startMinutes !== was.startMinutes ||
    now.endMinutes !== was.endMinutes ||
    !sameWindow(now, was) ||
    !sameGroups(now, was)
  );
}

/** What the other schools' holds read besides that: who teaches it, and in which room. */
function holdsChanged(now: JudgedCandidate, was: JudgedCandidate): boolean {
  return (
    placementChanged(now, was) ||
    now.teacherId !== was.teacherId ||
    (now.coTeacherId ?? null) !== (was.coTeacherId ?? null) ||
    now.roomId !== was.roomId
  );
}

/**
 * What the other schools' holds are asked of. A lesson that moved, or stands nowhere yet, is asked of all its teachers and its room.
 * One that stays where it stands is asked only of what the edit CHANGED (låt stå): a lesson whose teacher is held at another school
 * may be given another room, and one whose room is lent out may be given another teacher, without the hold it already stands in
 * being said again. A teacher or a room that is itself held in that hour is refused as before.
 */
function heldOf({ candidate, stands }: Pick<JudgeItem, 'candidate' | 'stands'>): JudgedCandidate {
  if (!stands || placementChanged(candidate, stands)) return candidate;
  const taught = new Set([stands.teacherId, stands.coTeacherId ?? null]);
  const kept = (id: string | null | undefined): boolean => id !== null && id !== undefined && taught.has(id);
  return {
    ...candidate,
    teacherId: kept(candidate.teacherId) ? null : candidate.teacherId,
    coTeacherId: kept(candidate.coTeacherId) ? null : (candidate.coTeacherId ?? null),
    roomId: candidate.roomId === stands.roomId ? null : candidate.roomId,
  };
}

/** What a lesson that a clash names is called: its class, its subject, and where it stands. */
export interface NamedLesson {
  groupIds: ReadonlySet<string>;
  className: string;
  subjectName: string;
  day: number;
  start: number;
  end: number;
}

/**
 * A hit of the clash rule as a refusal: the reason it is told as (a class that holds the other lesson is GROUP, one that only
 * shares a pupil with it PUPILS) and the other lesson by class, subject, day and clock, never a person. One mapping, for the hand
 * edit's judge and for the swaps' apply (lesson-refusal.ts clashRefusedConflict), so that a clash is worded alike wherever it is found.
 *
 * `groups` are the classes the candidate is for; `slot` is where it stands.
 */
export function clashRefusalOf(
  hit: MasterLessonConflict,
  other: NamedLesson | undefined,
  groups: ReadonlySet<string>,
  slot: { startMinutes: number; endMinutes: number },
): LessonRefusal {
  const reason: LessonRefusalReason = hit.kind === 'GROUP' ? ([...(other?.groupIds ?? [])].some((id) => groups.has(id)) ? 'GROUP' : 'PUPILS') : hit.kind;
  const params: LessonRefusalParams =
    reason === 'AVAILABILITY'
      ? { resource: availabilityResourceOf(hit.message) }
      : other
        ? {
            otherKind: 'LESSON',
            className: other.className,
            subjectName: other.subjectName,
            day: other.day,
            start: clockText(other.start),
            end: clockText(other.end),
            // A clash the pupils' ombyte or dusch made alone (the two lessons share no minute): the rule's own
            // sentence says whose ombyte and how many minutes, which no other reason's sentence can.
            ...(!overlaps(slot.startMinutes, slot.endMinutes, other.start, other.end) ? { pupilTime: 1, note: shortened(hit.message, 200) } : {}),
          }
        : {};
  return { reason, params };
}

/** The other schools whose hold on a lesson's teachers or room it stands in, by name. */
function holdSchools(holds: readonly OtherSchoolHold[], candidate: JudgedCandidate): string[] {
  const teachers = new Set([candidate.teacherId, candidate.coTeacherId ?? null].filter((id): id is string => id !== null));
  const schools = new Set<string>();
  for (const hold of holds) {
    if (hold.dayOfWeek !== candidate.dayOfWeek) continue;
    // A lesson with no room stands in no room, so no hold on a room is its own.
    const mine = hold.resourceKind === 'TEACHER' ? teachers.has(hold.resourceId) : candidate.roomId !== null && hold.resourceId === candidate.roomId;
    if (!mine) continue;
    if (!overlaps(candidate.startMinutes, candidate.endMinutes, holdMinutes(hold.startTime), holdMinutes(hold.endTime))) continue;
    for (const school of hold.schools) schools.add(school);
  }
  return [...schools].sort((a, b) => a.localeCompare(b, 'sv'));
}

/**
 * Judges every item, in their order. Reads; writes nothing. See the file's first
 * paragraphs for what a candidate is held to.
 */
export async function judgeLessons(
  tx: PrismaClient,
  masters: Pick<MasterLessonsService, 'findConflicts'>,
  world: JudgeWorld,
  items: readonly JudgeItem[],
  options: { reads?: ConflictReads } = {},
): Promise<LessonVerdict[]> {
  // 0. The school day, a question about the day alone and the heaviest there is, as the förläggning asks it first. The engine reads
  // SCHEDULE_DAYS, Monday to Friday, so a lesson on a Saturday or a Sunday is one a file brought in: it may stand (låt stå) and be changed
  // on anything but its day, and no edit puts one there.
  const refusals: LessonRefusal[][] = items.map((item) => (outsideSchoolDay(item) ? [{ reason: 'SCHOOL_DAY', params: {} }] : []));

  // 1. The clash rule.
  const hits: MasterLessonConflict[][] = [];
  for (const item of items) {
    hits.push(
      await masters.findConflicts(
        tx,
        world.basis,
        { id: item.lesson.id, academicYearId: world.academicYearId, studentGroupId: item.lesson.studentGroupId, subjectId: item.lesson.subjectId },
        item.candidate,
        {
          ...(item.excludeIds ? { excludeIds: item.excludeIds } : {}),
          ...(item.alongside ? { alongside: item.alongside } : {}),
          ...(options.reads ? { reads: options.reads } : {}),
        },
      ),
    );
  }
  const named = await namesOf(tx, hits.flat(), items);
  items.forEach((item, index) => {
    const groups = new Set([item.lesson.studentGroupId, ...(item.candidate.extraGroupIds ?? [])]);
    const found = (hits[index] ?? []).map((hit) => clashRefusalOf(hit, hit.masterLessonId === undefined ? undefined : named.get(hit.masterLessonId), groups, item.candidate));
    // Stable: among hits of one rank the first the rule gave stays first.
    found.sort((a, b) => (CLASH_RANK[a.reason] ?? 9) - (CLASH_RANK[b.reason] ?? 9));
    const seen = new Set<string>();
    for (const refusal of found) {
      const key = `${refusal.reason}|${JSON.stringify(refusal.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refusals[index]!.push(refusal);
    }
  });

  // 2. The board's rules, from facts read once per weekday, for the items that moved where they stand.
  const boardItems = items.flatMap((item, index) => (item.stands && !placementChanged(item.candidate, item.stands) ? [] : [index]));
  if (boardItems.length > 0) {
    const gradeNumbering = world.gradeNumbering ?? (await gradeNumberingOf(tx, world.academicYearId));
    const days = [...new Set(boardItems.map((index) => items[index]!.candidate.dayOfWeek))];
    const boards = new Map<number, BoardFacts>();
    for (const day of days) {
      const groupIds = [
        ...new Set(
          boardItems
            .filter((index) => items[index]!.candidate.dayOfWeek === day)
            .flatMap((index) => [items[index]!.lesson.studentGroupId, ...(items[index]!.candidate.extraGroupIds ?? [])]),
        ),
      ];
      boards.set(
        day,
        await readBoardFacts(tx, {
          academicYearId: world.academicYearId,
          schoolId: world.schoolId,
          gradeNumbering,
          basis: world.basis,
          groupIds,
          weekday: day,
        }),
      );
    }
    for (const index of boardItems) {
      const item = items[index]!;
      const code = boardCodeOf(
        boards.get(item.candidate.dayOfWeek)!,
        [item.lesson.studentGroupId, ...(item.candidate.extraGroupIds ?? [])],
        { dayOfWeek: item.candidate.dayOfWeek, startMinutes: item.candidate.startMinutes, endMinutes: item.candidate.endMinutes },
        // The lesson's weeks: a meal of another part of the läsår is not its meal.
        windowOf(item.candidate),
      );
      if (code !== null) refusals[index]!.push({ reason: code, params: {} });
    }
  }

  // 3. The other schools' hold on the teachers and the room. A hold has no weeks: the generator keeps
  // a shared teacher out of every week of the plan for a lesson elsewhere in odd weeks only, so a lesson
  // of any weeks meets it, and the judge is no looser than the engine.
  const holdItems = items.flatMap((item, index) => (item.stands && !holdsChanged(item.candidate, item.stands) ? [] : [index]));
  if (holdItems.length > 0) {
    const holds = (await readOtherSchoolHolds(tx, world.academicYearId, world.schoolId)).holds;
    if (holds.length > 0) {
      for (const index of holdItems) {
        const schools = holdSchools(holds, heldOf(items[index]!));
        if (schools.length > 0) refusals[index]!.push({ reason: 'OTHER_SCHOOL', params: { schools: shortened(schools.join(', '), 200) } });
      }
    }
  }

  return refusals.map((found) => ({ ok: found.length === 0, refusals: found }));
}

/** The lessons the clash rule named, called by class and subject, and where they stand (a card's own movers: where they will). */
async function namesOf(tx: PrismaClient, hits: readonly MasterLessonConflict[], items: readonly JudgeItem[]): Promise<Map<string, NamedLesson>> {
  const ids = [...new Set(hits.flatMap((hit) => (hit.masterLessonId === undefined ? [] : [hit.masterLessonId])))];
  const out = new Map<string, NamedLesson>();
  if (ids.length === 0) return out;
  const rows = await tx.masterLesson.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      studentGroupId: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  // A mover of a card stands, for the judge, where the card lands: its own `alongside` row says so.
  const moving = new Map<string, { item: JudgeItem; row: DayLesson }>();
  for (const item of items) for (const row of item.alongside ?? []) moving.set(row.id, { item, row });
  for (const row of rows) {
    const mover = moving.get(row.id);
    out.set(row.id, {
      groupIds: new Set([row.studentGroupId, ...row.extraGroups.map((entry) => entry.studentGroupId)]),
      className: shortened(row.studentGroup.name, NAME_LIMIT),
      subjectName: shortened(row.subject.name, NAME_LIMIT),
      day: mover ? mover.item.candidate.dayOfWeek : row.dayOfWeek,
      start: minutesOfTime(mover ? mover.row.startTime : row.startTime),
      end: minutesOfTime(mover ? mover.row.endTime : row.endTime),
    });
  }
  return out;
}

async function gradeNumberingOf(tx: PrismaClient, academicYearId: string): Promise<GradeNumbering> {
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { gradeNumbering: true } });
  return (year?.gradeNumbering as GradeNumbering | undefined) ?? 'NIOARIG';
}
