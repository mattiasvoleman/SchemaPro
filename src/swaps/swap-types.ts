/*
 * Byten och flyttar (G1): the shapes the swap search and its apply share.
 *
 * Everything here is data. The rules live where they have always lived: the
 * clash rule in MasterLessonsService.findConflicts, the ramtider and the meal
 * in the sittings the grid reads, the other schools' holds in
 * other-school-holds.ts, the soft figures in common/subject-distribution.ts and
 * common/teacher-day.ts, the pupils' håltimmar in the contract fixture
 * common/__fixtures__/pupil-gaps-cases.json. The search proposes and measures;
 * it holds no rule of its own (swap-search.ts says what it prunes with and why
 * that can only lose a proposal, never admit one).
 */

import type { LessonRecurrence } from '@prisma/client';

/** A placed lesson of the grundschema as the search reads it: times in minutes, dates as YYYY-MM-DD. */
export interface SwapLesson {
  id: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
  isLocked: boolean;
  isGenerated: boolean;
  extraGroupIds: string[];
  studentIds: string[];
}

/** A day and a clock: where a unit stands, or where it is offered to stand. */
export interface SwapSlot {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Why a lesson stands beside another and goes with it.
 *
 *   BLOCK       the other member of a parallel block, at the same day, clock and
 *               weeks (a block card, block-lessons.ts)
 *   SAME_TIMES  a block on this one's times, or whose times this one takes
 *   HALF        the other half of the class, or the class itself, at the same
 *               time (Halvklasser: the rotation the school laid)
 *   REPLACING   a group replacing the subject, or the class's lesson in the
 *               subject it replaces, at the same time (Ersättande grupper)
 */
export type ParallelKind = 'BLOCK' | 'SAME_TIMES' | 'HALF' | 'REPLACING';

export interface ParallelLink {
  kind: ParallelKind;
  /** The lesson that is parallel. */
  lessonId: string;
  /** The lesson it stands beside. */
  viaLessonId: string;
}

/**
 * The lessons that move as one: a lesson and everything the school laid beside
 * it. A unit is never split by a proposal — its members land in one slot and
 * leave one slot — so a block, a pair of halves or a replacing group is moved
 * whole or not at all, and the proposal names every member.
 */
export interface SwapUnit {
  /** The lowest member id: a stable name for the unit. */
  id: string;
  members: SwapLesson[];
  links: ParallelLink[];
  slot: SwapSlot;
  /** A member the generation keeps where it stands: the unit does not go as a partner. */
  locked: boolean;
}

/** One lesson's move in a proposal. */
export interface SwapMove {
  lessonId: string;
  from: SwapSlot;
  to: SwapSlot;
}

export type SoftCode =
  | 'PUPIL_GAPS'
  | 'TEACHER_GAPS'
  | 'DISTRIBUTION'
  | 'TEACHER_DAY'
  | 'MOVED_LESSONS';

/** What a proposal does to one of the soft rules: a number before, a number after. */
export interface SoftCost {
  code: SoftCode;
  /** Minutes (the gaps), breaches (the rules) or lessons (MOVED_LESSONS). */
  unit: 'MINUTES' | 'BREACHES' | 'LESSONS';
  before: number;
  after: number;
  delta: number;
}

/**
 * The hard rules a proposal is held to, each by name and each judged by the
 * rule that already stands for it. A proposal that breaks one is never offered,
 * so the list only ever says what was checked.
 */
export type HardCode =
  | 'CLASH' // findConflicts: teacher, room, class and pupils, availability
  | 'FRAME' // the stage's ramtid
  | 'LUNCH' // the class's meal
  | 'GRADE_RULE' // a weekly rule on whole årskurser
  | 'OTHER_SCHOOL'; // a shared teacher's lessons, a lent or borrowed room

export interface ParallelTouch extends ParallelLink {
  /** The unit member the link hangs on, as the move list names it. */
  outcome: 'FOLLOWS';
}

/**
 * What a move leaves untouched on purpose and says so: the other school's hold
 * on a shared teacher or a room that is lent or borrowed, kept at the new
 * times. Naming it is the point; the hold is never ours to move.
 */
export interface ExternalTouch {
  kind: 'SHARED_TEACHER' | 'ROOM_LENT' | 'ROOM_BORROWED';
  /** The lesson of ours it concerns. */
  lessonId: string;
  /** Our teacher or room. */
  resourceId: string;
  /** The other schools, by name. */
  schools: string[];
  /** Where the hold stands on the day the lesson lands, as it was held clear of. */
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

export interface SwapProposal {
  /** A name that is the same for the same moves, so a page can tell a proposal it showed before. */
  id: string;
  kind: 'SWAP' | 'CHAIN';
  moves: SwapMove[];
  /** Every parallel lesson the moves take along, by the lesson it stands beside. */
  parallels: ParallelTouch[];
  external: ExternalTouch[];
  /** Hard rules held: all of them, or the proposal is not here. */
  hard: HardCode[];
  soft: SoftCost[];
  /** The order the proposals are listed in; lower is better. Not a figure to show. */
  score: number;
}
