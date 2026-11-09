import type { PrismaClient } from '@prisma/client';
import { toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import type { RosterBasis } from '../year-rollover/projected-rosters';
import { frameWindow, type GapSpan } from './swap-gaps';
import type { SwapConstraint, SwapFrame, SwapSitting } from './swap-snapshot';
import type { SwapSlot } from './swap-types';

/*
 * THE BOARD'S HARD RULES, ONE JUDGE.
 *
 * Three hard rules are not part of the clash rule (MasterLessonsService.
 * findConflicts: teacher, room, class and pupils, availability) but are held
 * all the same, because the grid paints them red and the generator keeps them:
 *
 *   FRAME       the stage's ramtid (lib/frame-times.ts, the engine's frames.py):
 *               a lesson of any of its groups outside the stage's day
 *   LUNCH       the class's meal: a lesson on top of the group's sitting
 *   GRADE_RULE  a weekly row that closes the hour to whole årskurser
 *
 * G1's swap search (SwapContext) is the first to judge a landing by them; the
 * klasslärare's schedule (G5) is the second, for a lesson of the weekly
 * template and for one date. This file is the single place that says what a
 * breach is. Both build the same BoardFacts and ask `boardCodeOf`; neither has
 * a second reading of a ramtid, a sitting or a rule on årskurser. The fourth
 * board kind, OTHER_SCHOOL (a shared teacher's lessons elsewhere, a room lent
 * out), stays in SwapContext: it reads other schools' holds, which the
 * klasslärare's frame already refuses by name (SHARED_TEACHER, SHARED_ROOM).
 *
 * PURE except `readBoardFacts`, which reads what the judge needs for ONE lesson
 * (the school's frames, the groups' sittings, the rules on årskurser and the
 * groups' years) and nothing of the rest of the week.
 */

export type BoardCode = 'FRAME' | 'LUNCH' | 'GRADE_RULE';

export interface BoardFacts {
  /** The school's ramtider. */
  frames: readonly SwapFrame[];
  /** `group|weekday` -> the group's meal on that day. */
  sittings: ReadonlyMap<string, readonly SwapSitting[]>;
  /** The weekly rows on whole årskurser (resourceType GRADE_LEVEL), each with its weekday. */
  gradeRules: readonly SwapConstraint[];
  /** group -> its years in NIOARIG; a group with no known years is reached by no frame and no rule. */
  spans: ReadonlyMap<string, GapSpan>;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

export const sittingKey = (studentGroupId: string, dayOfWeek: number): string => `${studentGroupId}|${dayOfWeek}`;

/** Sittings indexed the way the judge asks for them. */
export function indexSittings(sittings: Iterable<SwapSitting>): Map<string, SwapSitting[]> {
  const index = new Map<string, SwapSitting[]>();
  for (const sitting of sittings) {
    const key = sittingKey(sitting.studentGroupId, sitting.dayOfWeek);
    const list = index.get(key);
    if (list) list.push(sitting);
    else index.set(key, [sitting]);
  }
  return index;
}

/**
 * The hard rule among FRAME, LUNCH and GRADE_RULE that a lesson of `groups`
 * breaks standing at `to`, or null. In that order: the first found names it.
 */
export function boardCodeOf(facts: BoardFacts, groups: readonly string[], to: SwapSlot): BoardCode | null {
  const day = to.dayOfWeek;
  // FRAME: any group outside its stage's day is enough (breaksFrame).
  if (facts.frames.length > 0) {
    for (const groupId of groups) {
      const span = facts.spans.get(groupId);
      if (!span) continue;
      const window = frameWindow(facts.frames, span, day);
      if (window === null || to.startMinutes < window[0] || to.endMinutes > window[1]) return 'FRAME';
    }
  }
  for (const groupId of groups) {
    for (const sitting of facts.sittings.get(sittingKey(groupId, day)) ?? []) {
      if (overlaps(to.startMinutes, to.endMinutes, sitting.startMinutes, sitting.endMinutes)) return 'LUNCH';
    }
  }
  for (const row of facts.gradeRules) {
    if (row.resourceType !== 'GRADE_LEVEL' || row.dayOfWeek !== day) continue;
    const meets = groups.some((groupId) => {
      const span = facts.spans.get(groupId);
      if (!span) return false;
      if (row.minGradeLevel !== null && span[1] < row.minGradeLevel) return false;
      return !(row.maxGradeLevel !== null && span[0] > row.maxGradeLevel);
    });
    if (meets && overlaps(to.startMinutes, to.endMinutes, row.startMinutes, row.endMinutes)) return 'GRADE_RULE';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rows as facts. One mapping, used by the swap snapshot and by the reader below.
// ---------------------------------------------------------------------------

export const minutesOfTime = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

export const frameOf = (row: { minGradeLevel: number; maxGradeLevel: number; dayOfWeek: number | null; startTime: Date; endTime: Date }): SwapFrame => ({
  min: row.minGradeLevel,
  max: row.maxGradeLevel,
  day: row.dayOfWeek,
  start: minutesOfTime(row.startTime),
  end: minutesOfTime(row.endTime),
});

export const sittingOf = (row: { studentGroupId: string; dayOfWeek: number; startTime: Date; endTime: Date }): SwapSitting => ({
  studentGroupId: row.studentGroupId,
  dayOfWeek: row.dayOfWeek,
  startMinutes: minutesOfTime(row.startTime),
  endMinutes: minutesOfTime(row.endTime),
});

export const constraintOf = (row: {
  resourceType: string;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  dayOfWeek: number | null;
  startTime: Date;
  endTime: Date;
}): SwapConstraint => ({
  resourceType: row.resourceType,
  userId: row.userId,
  roomId: row.roomId,
  studentGroupId: row.studentGroupId,
  minGradeLevel: row.minGradeLevel,
  maxGradeLevel: row.maxGradeLevel,
  dayOfWeek: row.dayOfWeek,
  startMinutes: minutesOfTime(row.startTime),
  endMinutes: minutesOfTime(row.endTime),
});

// ---------------------------------------------------------------------------
// The reader: what the judge needs for one lesson.
// ---------------------------------------------------------------------------

export interface BoardReadInput {
  academicYearId: string;
  schoolId: string;
  gradeNumbering: GradeNumbering;
  basis: RosterBasis;
  /** The groups attending the lesson, its class first. */
  groupIds: readonly string[];
  /** ISO weekday the lesson stands on. */
  weekday: number;
  /**
   * One date (YYYY-MM-DD) and the school's clock for it, or absent for the
   * week's template. A date has its own meal (CalendarLunches, where the
   * publication laid one for the class; the weekly sitting otherwise) and its
   * own closures (a dated row on årskurser counts besides the weekly one).
   */
  date?: { day: string; localMinutes: (instant: Date) => number };
  /**
   * Förlagda poster: hold the lesson to the meals the SCHOOL placed only
   * (LunchSittings with isGenerated false), and not to the ones Generera
   * itself laid, which the next Generera deletes and lays again around the
   * förläggning (review of #293, MEDEL-1): a förläggning in the lunch window
   * is the engine's to fit a meal around, or to refuse by name. Absent for
   * the swaps and the klasslärare, for whom the week's meals are as they lie.
   */
  handPlacedSittingsOnly?: boolean;
}

export async function readBoardFacts(tx: PrismaClient, input: BoardReadInput): Promise<BoardFacts> {
  const { academicYearId, schoolId, groupIds, weekday } = input;
  const groupRows = await tx.studentGroup.findMany({
    where: { id: { in: [...groupIds] } },
    select: { id: true, gradeLevel: true, halfOfId: true },
  });
  const [frames, weeklySittings, rules] = [
    await tx.frameTime.findMany({
      where: { schoolId },
      select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
    }),
    await tx.lunchSitting.findMany({
      where: {
        academicYearId,
        studentGroupId: { in: [...groupIds] },
        dayOfWeek: weekday,
        ...(input.handPlacedSittingsOnly ? { isGenerated: false } : {}),
      },
      select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true },
    }),
    await tx.availabilityConstraint.findMany({
      where: {
        type: 'UNAVAILABLE',
        resourceType: 'GRADE_LEVEL',
        AND: [constraintsOfYear(academicYearId)],
        OR: [
          { date: null, dayOfWeek: weekday },
          ...(input.date ? [{ date: new Date(`${input.date.day}T00:00:00.000Z`) }] : []),
        ],
      },
      select: {
        resourceType: true,
        userId: true,
        roomId: true,
        studentGroupId: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
      },
    }),
  ];

  let sittings = weeklySittings.map(sittingOf);
  if (input.date) {
    const lunches = await tx.calendarLunch.findMany({
      where: { studentGroupId: { in: [...groupIds] }, date: new Date(`${input.date.day}T00:00:00.000Z`) },
      select: { studentGroupId: true, startsAt: true, endsAt: true },
    });
    // The meal laid for the date replaces the weekly one of the same class.
    const dated = new Map(lunches.map((lunch) => [lunch.studentGroupId, lunch]));
    sittings = [
      ...sittings.filter((sitting) => !dated.has(sitting.studentGroupId)),
      ...lunches.map((lunch) => ({
        studentGroupId: lunch.studentGroupId,
        dayOfWeek: weekday,
        startMinutes: input.date!.localMinutes(lunch.startsAt),
        endMinutes: input.date!.localMinutes(lunch.endsAt),
      })),
    ];
  }

  const rosters = await loadRosters(tx, input.basis, [...groupIds], groupRows);
  const spans = new Map<string, GapSpan>();
  for (const group of groupRows) {
    const span = toNioarigSpan(gradeSpanOf(rosters, [group.id]), input.gradeNumbering);
    if (span) spans.set(group.id, [span.min, span.max]);
  }

  return {
    frames: frames.map(frameOf),
    sittings: indexSittings(sittings),
    // A dated row stands on the weekday of its date.
    gradeRules: rules.map((row) => constraintOf({ ...row, dayOfWeek: row.date ? weekday : row.dayOfWeek })),
    spans,
  };
}
