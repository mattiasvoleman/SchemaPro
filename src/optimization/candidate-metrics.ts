import {
  coverageLessonsOf,
  unplacedOf,
  type CandidateLesson,
  type CoverageBase,
  type DraftLesson,
  type RegenerationRequirementRow,
  type UnplacedTally,
} from './optimization-proxy.service';

/*
 * WHAT A CANDIDATE CHANGES, measured once, when the run stores it (design §5).
 *
 * Generated lessons have no stable ids — every regeneration deletes the
 * machine's rows and creates new ones — so a lesson is recognised by what it
 * IS: its class, its subject, its day and its clock. The web's moved list
 * (web/lib/candidates/moved.ts) pairs lessons by exactly this key, so the
 * table's "X av Y" and the list under it agree.
 *
 * Everything here is pure and works on real ids. The håltimmar are not here:
 * they are the browser's (web/lib/gaps.ts), over the same lessons, so the
 * draft and every candidate are measured by the one definition the gaps page
 * already uses.
 */

/** The stored metrics of an applicable (OPTIMAL or FEASIBLE) candidate. */
export interface CandidateMetrics {
  /** Draft lessons the candidate does not keep at the same class, subject, day and clock. */
  moved: number;
  /** The draft's own (non-preserved) lessons, parked ones included: what an apply replaces. */
  movedOf: number;
  /** movedOf − moved. */
  kept: number;
  /** Kept slots whose room differs. */
  roomChanges: number;
  /** An earlier candidate of the run this one differs from in under 1 % of its lessons. */
  sameAs: number | null;
  /** How many lessons the candidate places, so a list need not read them. */
  lessonCount: number;
  /** What the candidate's timetable leaves unplaced (timplan layer 2), or null when it was not measured. */
  unplaced: UnplacedTally | null;
}

/** A lesson by what it is, for the multiset match. */
interface SlotLesson {
  studentGroupId: string;
  subjectId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
}

/** "HH:MM" of "HH:MM" or "HH:MM:SS". */
const clock = (time: string): string => time.slice(0, 5);

const slotKey = (lesson: SlotLesson): string =>
  `${lesson.studentGroupId}|${lesson.subjectId}|${lesson.dayOfWeek}|${clock(lesson.startTime)}|${clock(lesson.endTime)}`;

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

/** The candidate's lessons with their requirement's class and subject; one whose requirement is unknown is left out. */
export function slotLessonsOf(
  requirementRows: readonly Pick<RegenerationRequirementRow, 'id' | 'subjectId' | 'studentGroupId'>[],
  lessons: readonly CandidateLesson[],
): SlotLesson[] {
  const rows = new Map(requirementRows.map((row) => [row.id, row]));
  return lessons.flatMap((lesson) => {
    const row = rows.get(lesson.requirementId);
    if (row === undefined) return [];
    return [
      {
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        dayOfWeek: lesson.dayOfWeek,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        roomId: lesson.roomId,
      },
    ];
  });
}

/**
 * moved, movedOf, kept and roomChanges: a multiset match on (class, subject,
 * day, start, end) between the draft's own lessons and the candidate's.
 *
 * Within one slot as many lessons are kept as both sides have (the smaller
 * count), and of those, equal rooms pair first: two 7A Ma lessons at one time
 * in rooms A and B against B and A change no room. So roomChanges is the
 * kept count less the rooms the two sides share at that slot.
 */
export function movedMetrics(
  draft: readonly Pick<DraftLesson, 'studentGroupId' | 'subjectId' | 'dayOfWeek' | 'startTime' | 'endTime' | 'roomId'>[],
  candidate: readonly SlotLesson[],
): Pick<CandidateMetrics, 'moved' | 'movedOf' | 'kept' | 'roomChanges'> {
  const draftBySlot = new Map<string, SlotLesson[]>();
  for (const lesson of draft) {
    const list = draftBySlot.get(slotKey(lesson)) ?? [];
    list.push(lesson);
    draftBySlot.set(slotKey(lesson), list);
  }
  const candidateBySlot = new Map<string, SlotLesson[]>();
  for (const lesson of candidate) {
    const list = candidateBySlot.get(slotKey(lesson)) ?? [];
    list.push(lesson);
    candidateBySlot.set(slotKey(lesson), list);
  }

  let kept = 0;
  let roomChanges = 0;
  for (const [key, before] of draftBySlot) {
    const after = candidateBySlot.get(key) ?? [];
    const matched = Math.min(before.length, after.length);
    if (matched === 0) continue;
    const roomsAfter = countBy(after, (lesson) => lesson.roomId ?? '');
    let sameRoom = 0;
    for (const [room, count] of countBy(before, (lesson) => lesson.roomId ?? '')) {
      sameRoom += Math.min(count, roomsAfter.get(room) ?? 0);
    }
    kept += matched;
    roomChanges += matched - sameRoom;
  }
  return { moved: draft.length - kept, movedOf: draft.length, kept, roomChanges };
}

/** A candidate lesson's whole placement, for telling two candidates apart. */
const placementKey = (lesson: CandidateLesson): string =>
  `${lesson.requirementId}|${lesson.dayOfWeek}|${clock(lesson.startTime)}|${clock(lesson.endTime)}|${lesson.roomId ?? ''}`;

/**
 * The share of lessons two candidates do not have in common, by placement
 * (requirement, day, clock and room), over the larger of the two. Two empty
 * candidates are the same timetable.
 */
export function differenceOf(a: readonly CandidateLesson[], b: readonly CandidateLesson[]): number {
  const larger = Math.max(a.length, b.length);
  if (larger === 0) return 0;
  const inB = countBy(b, placementKey);
  let common = 0;
  for (const [key, count] of countBy(a, placementKey)) common += Math.min(count, inB.get(key) ?? 0);
  return (larger - common) / larger;
}

/** Below this share of differing lessons a candidate is shown as "Samma som förslag N". */
export const SAME_AS_THRESHOLD = 0.01;

/**
 * The first earlier applicable candidate this one is the same as, by its
 * ordinal, or null. Seeds and weights differ between the variants and the
 * solver still often lands on one timetable; showing it twice under two
 * labels would claim a choice that is not there.
 */
export function sameAsOf(
  lessons: readonly CandidateLesson[],
  earlier: readonly { ordinal: number; lessons: readonly CandidateLesson[] }[],
): number | null {
  for (const candidate of earlier) {
    if (differenceOf(lessons, candidate.lessons) < SAME_AS_THRESHOLD) return candidate.ordinal;
  }
  return null;
}

/**
 * Everything an applicable candidate stores about itself: moved against the
 * draft, sameAs against the run's earlier candidates, and — when the run read
 * the timplan — what the preserved lessons plus this candidate leave
 * unplaced, by the PUB_UNPLACED rule.
 */
export function candidateMetricsOf(input: {
  requirementRows: readonly RegenerationRequirementRow[];
  draftLessons: readonly DraftLesson[];
  coverage: CoverageBase | null;
  lessons: readonly CandidateLesson[];
  earlier: readonly { ordinal: number; lessons: readonly CandidateLesson[] }[];
}): CandidateMetrics {
  const moved = movedMetrics(input.draftLessons, slotLessonsOf(input.requirementRows, input.lessons));
  return {
    ...moved,
    sameAs: sameAsOf(input.lessons, input.earlier),
    lessonCount: input.lessons.length,
    unplaced: input.coverage
      ? unplacedOf(input.coverage, coverageLessonsOf({ requirementRows: [...input.requirementRows] }, input.lessons))
      : null,
  };
}

/** The run's figure: the batch's unplaced and the current draft's, side by side. */
export interface RunUnplaced {
  lines: number;
  minutes: number;
  draftLines: number;
  draftMinutes: number;
}

/**
 * Run-level, from the first applicable candidate: every feasible candidate
 * places exactly the demand it was sent, so they leave the same lines short
 * in practice, and the page shows the figure once beside the draft's.
 */
export function runUnplacedOf(coverage: CoverageBase | null, first: UnplacedTally | null): RunUnplaced | null {
  if (!coverage || !first) return null;
  const draft = unplacedOf(coverage, coverage.draftLessons);
  return { lines: first.lines, minutes: first.minutes, draftLines: draft.lines, draftMinutes: draft.minutes };
}

/** The five figures the page reads (design §3 CandidateView.metrics), from a stored blob. */
export interface CandidateMetricsView {
  moved: number;
  movedOf: number;
  roomChanges: number;
  kept: number;
  sameAs: number | null;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * The stored metrics as the view promises them: integers, sameAs an ordinal
 * or null, and nothing else. A row is written by the run alone, but a blob is
 * read back as `unknown`, and a page should not render a hand-edited object
 * as a number.
 */
export function metricsViewOf(stored: unknown): CandidateMetricsView | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const blob = stored as Record<string, unknown>;
  const sameAs = blob['sameAs'];
  return {
    moved: count(blob['moved']),
    movedOf: count(blob['movedOf']),
    roomChanges: count(blob['roomChanges']),
    kept: count(blob['kept']),
    sameAs: typeof sameAs === 'number' && Number.isInteger(sameAs) && sameAs >= 1 && sameAs <= 4 ? sameAs : null,
  };
}

/** The lesson count a stored blob carries, 0 when it carries none. */
export function lessonCountOf(stored: unknown): number {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return 0;
  return count((stored as Record<string, unknown>)['lessonCount']);
}
