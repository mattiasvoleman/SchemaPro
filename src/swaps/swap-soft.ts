import {
  hasTeacherDayRule,
  teacherDayBreaches,
  type TeacherDayRule,
} from '../common/teacher-day';
import { distributionBreaches, type DistributionRule } from '../common/subject-distribution';
import {
  alternates,
  closedMinutes,
  dayIdleHalves,
  parityOf,
  type GapConstraint,
  type GapFrame,
  type GapSpan,
  type Interval,
  type LunchRule,
  type WeekInterval,
} from './swap-gaps';
import type { SoftCost, SwapLesson, SwapMove, SwapSlot } from './swap-types';

/*
 * WHAT A PROPOSAL COSTS IN THE SOFT RULES.
 *
 * Four figures, each the figure the school already has somewhere else, taken
 * before the moves and after them over the bodies the moves touch:
 *
 *   PUPIL_GAPS      the pupils' idle minutes, weighted by pupils (swap-gaps.ts,
 *                   the håltimmesrapport's number)
 *   TEACHER_GAPS    the teachers' idle minutes between lessons, the same hole
 *   DISTRIBUTION    the ämnesfördelning's breaches on the posts of the moved
 *                   lessons (common/subject-distribution.ts, the rule the
 *                   hand edit warns about and the generator keeps)
 *   TEACHER_DAY     the breaches of a teacher's day, week and stretch
 *                   (common/teacher-day.ts), counted and never worded: the
 *                   limits are the post's, HR data
 *
 * and MOVED_LESSONS, how many lessons the proposal moves, parallel ones
 * included. A figure is a count of what stands in the way of a better
 * timetable, so a negative delta is a better one.
 *
 * NOT MEASURED, SAID HERE: the walks between sites (travel-warnings.ts) and the
 * delade lektioner's shares. Neither moves with a swap that leaves rooms and
 * teachers where they are, except through a site the lesson's room is on; a
 * school with a travel figure reads the walk on the page it already has.
 *
 * PURE and cheap: a candidate costs the (body, day) pairs it touches.
 */

/** A cohort: the pupils booked alike, and the lessons they sit. */
export interface SoftCohort {
  pupils: number;
  lessonIds: ReadonlySet<string>;
  /** The groups whose closures bind the cohort (its groups and derived keys). */
  groups: readonly string[];
}

export interface SoftInput {
  lessons: readonly SwapLesson[];
  cohorts: readonly SoftCohort[];
  /** The pupils' ombyte and dusch around a lesson: counted as busy time. */
  margins: ReadonlyMap<string, { before: number; after: number }>;
  spans: ReadonlyMap<string, GapSpan>;
  constraints: readonly GapConstraint[];
  frames: readonly GapFrame[];
  lunch: LunchRule | null;
  /** Only the teachers who have a rule of their day. */
  teacherRules: ReadonlyMap<string, TeacherDayRule>;
  /** Only the posts that have a distribution rule; key `${group}:${subject}`. */
  distribution: ReadonlyMap<string, DistributionRule>;
}

/** The weights that order the proposals. Heuristic ordering only: the figures shown are the real ones. */
export const SCORE = {
  /** The engine's PUPIL_GAP_SCALE: a class of this many pupils pays what a teacher pays. */
  PUPIL_CLASS: 25,
  BREACH: 60,
  MOVED_LESSON: 5,
} as const;

interface DayEntry extends WeekInterval {
  id: string;
}

interface Body {
  /** Weight of its idle minutes: pupils for a cohort, 1 for a teacher. */
  weight: number;
  both: boolean;
  byDay: Map<number, DayEntry[]>;
  closures: Map<number, Interval[]>;
  lunch: LunchRule | null;
  groups: readonly string[];
  /** The base idle of each day, in halves. */
  baseHalves: Map<number, number>;
}

export interface SoftMeasure {
  /** The whole timetable's idle minutes today: the number the håltimmesrapport gives. */
  baseline(): { pupilIdleMinutes: number; teacherIdleMinutes: number };
  /** The four figures and the lessons moved, for these moves (parallel lessons included). */
  evaluate(moves: readonly SwapMove[]): { costs: SoftCost[]; score: number };
}

const asCost = (code: SoftCost['code'], unit: SoftCost['unit'], before: number, after: number): SoftCost => ({
  code,
  unit,
  before,
  after,
  delta: after - before,
});

export function buildSoftMeasure(input: SoftInput): SoftMeasure {
  const lessonById = new Map(input.lessons.map((lesson) => [lesson.id, lesson]));
  const closuresFor = (body: Pick<Body, 'groups'>, day: number): Interval[] =>
    closedMinutes(body.groups, day, input.spans, input.constraints, input.frames);

  // --- the bodies: cohorts and teachers, each with its days -----------------
  const entryOf = (lesson: SwapLesson, margin: boolean): DayEntry => {
    const m = margin ? input.margins.get(lesson.id) : undefined;
    return {
      id: lesson.id,
      start: lesson.startMinutes - (m?.before ?? 0),
      end: lesson.endMinutes + (m?.after ?? 0),
      runs: parityOf(lesson.recurrence),
    };
  };
  const bodyOf = (
    weight: number,
    lessonIds: Iterable<string>,
    groups: readonly string[],
    lunch: LunchRule | null,
    margin: boolean,
    withClosures: boolean,
  ): Body => {
    const byDay = new Map<number, DayEntry[]>();
    for (const id of lessonIds) {
      const lesson = lessonById.get(id);
      if (!lesson) continue;
      const list = byDay.get(lesson.dayOfWeek);
      const entry = entryOf(lesson, margin);
      if (list) list.push(entry);
      else byDay.set(lesson.dayOfWeek, [entry]);
    }
    const body: Body = {
      weight,
      both: alternates([...byDay.values()].flat()),
      byDay,
      closures: new Map(),
      lunch,
      groups: withClosures ? groups : [],
      baseHalves: new Map(),
    };
    for (const [day, entries] of byDay) {
      const closures = withClosures ? closuresFor(body, day) : [];
      body.closures.set(day, closures);
      body.baseHalves.set(day, dayIdleHalves(entries, body.both, closures, lunch));
    }
    return body;
  };

  const cohortBodies = input.cohorts.map((cohort) =>
    bodyOf(cohort.pupils, cohort.lessonIds, cohort.groups, input.lunch, true, true),
  );
  const cohortsOfLesson = new Map<string, number[]>();
  input.cohorts.forEach((cohort, index) => {
    for (const id of cohort.lessonIds) {
      const list = cohortsOfLesson.get(id);
      if (list) list.push(index);
      else cohortsOfLesson.set(id, [index]);
    }
  });

  const teacherLessons = new Map<string, string[]>();
  for (const lesson of input.lessons) {
    for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) {
      if (teacherId === null) continue;
      const list = teacherLessons.get(teacherId);
      if (list) list.push(lesson.id);
      else teacherLessons.set(teacherId, [lesson.id]);
    }
  }
  const teacherBodies = new Map<string, Body>();
  const teacherBody = (teacherId: string): Body => {
    let body = teacherBodies.get(teacherId);
    if (!body) {
      body = bodyOf(1, teacherLessons.get(teacherId) ?? [], [], null, false, false);
      teacherBodies.set(teacherId, body);
    }
    return body;
  };

  /** A body's idle minutes over the week, the moved lessons laid at their new slots on the days they touch. */
  const idleAfter = (
    body: Body,
    moved: ReadonlyMap<string, SwapSlot>,
    mine: readonly string[],
    margin: boolean,
  ): { before: number; after: number } => {
    const days = new Set<number>();
    for (const id of mine) {
      days.add(lessonById.get(id)!.dayOfWeek);
      days.add(moved.get(id)!.dayOfWeek);
    }
    let before = 0;
    let after = 0;
    // The body's weeks are the same after the move: a move changes no recurrence.
    for (const base of body.baseHalves.values()) before += base;
    after = before;
    for (const day of days) {
      const base = body.baseHalves.get(day) ?? 0;
      const kept = (body.byDay.get(day) ?? []).filter((entry) => !moved.has(entry.id));
      const arriving = mine
        .filter((id) => moved.get(id)!.dayOfWeek === day)
        .map((id) => {
          const lesson = lessonById.get(id)!;
          const slot = moved.get(id)!;
          const m = margin ? input.margins.get(id) : undefined;
          return {
            id,
            start: slot.startMinutes - (m?.before ?? 0),
            end: slot.endMinutes + (m?.after ?? 0),
            runs: parityOf(lesson.recurrence),
          };
        });
      const closures = body.closures.get(day) ?? (body.groups.length > 0 ? closuresFor(body, day) : []);
      after += dayIdleHalves([...kept, ...arriving], body.both, closures, body.lunch) - base;
    }
    return { before: before * body.weight, after: after * body.weight };
  };

  // --- the posts' distribution rules and the teachers' day rules ----------
  const postLessons = new Map<string, string[]>();
  for (const lesson of input.lessons) {
    const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
    if (!input.distribution.has(key)) continue;
    const list = postLessons.get(key);
    if (list) list.push(lesson.id);
    else postLessons.set(key, [lesson.id]);
  }
  const distributionCount = (key: string, moved: ReadonlyMap<string, SwapSlot>): number => {
    const rule = input.distribution.get(key)!;
    const week = (postLessons.get(key) ?? []).map((id) => {
      const lesson = lessonById.get(id)!;
      return {
        id,
        dayOfWeek: moved.get(id)?.dayOfWeek ?? lesson.dayOfWeek,
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
      };
    });
    return distributionBreaches(rule, week).length;
  };
  const teacherDayCount = (teacherId: string, moved: ReadonlyMap<string, SwapSlot>): number => {
    const rule = input.teacherRules.get(teacherId);
    if (!rule || !hasTeacherDayRule(rule)) return 0;
    const week = (teacherLessons.get(teacherId) ?? []).map((id) => {
      const lesson = lessonById.get(id)!;
      const slot = moved.get(id) ?? lesson;
      return {
        id,
        dayOfWeek: slot.dayOfWeek,
        startMinutes: slot.startMinutes,
        endMinutes: slot.endMinutes,
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
      };
    });
    return teacherDayBreaches(rule, week).length;
  };

  return {
    baseline() {
      let pupils = 0;
      for (const body of cohortBodies) for (const base of body.baseHalves.values()) pupils += base * body.weight;
      let teachers = 0;
      for (const teacherId of teacherLessons.keys()) {
        for (const base of teacherBody(teacherId).baseHalves.values()) teachers += base;
      }
      return { pupilIdleMinutes: pupils / 2, teacherIdleMinutes: teachers / 2 };
    },
    evaluate(moves) {
      const moved = new Map(moves.map((move) => [move.lessonId, move.to]));
      const none: ReadonlyMap<string, SwapSlot> = new Map();

      // Pupils: the cohorts that sit a moved lesson.
      const byCohort = new Map<number, string[]>();
      for (const move of moves) {
        for (const index of cohortsOfLesson.get(move.lessonId) ?? []) {
          const list = byCohort.get(index);
          if (list) list.push(move.lessonId);
          else byCohort.set(index, [move.lessonId]);
        }
      }
      let pupilBefore = 0;
      let pupilAfter = 0;
      for (const [index, mine] of byCohort) {
        const result = idleAfter(cohortBodies[index]!, moved, mine, true);
        pupilBefore += result.before;
        pupilAfter += result.after;
      }

      // Teachers: both of a lesson's.
      const byTeacher = new Map<string, string[]>();
      for (const move of moves) {
        const lesson = lessonById.get(move.lessonId)!;
        for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) {
          if (teacherId === null) continue;
          const list = byTeacher.get(teacherId);
          if (list) list.push(move.lessonId);
          else byTeacher.set(teacherId, [move.lessonId]);
        }
      }
      let teacherBefore = 0;
      let teacherAfter = 0;
      let dayBefore = 0;
      let dayAfter = 0;
      for (const [teacherId, mine] of byTeacher) {
        const result = idleAfter(teacherBody(teacherId), moved, mine, false);
        teacherBefore += result.before;
        teacherAfter += result.after;
        dayBefore += teacherDayCount(teacherId, none);
        dayAfter += teacherDayCount(teacherId, moved);
      }

      // Posts: the distribution of every post a moved lesson belongs to.
      const posts = new Set<string>();
      for (const move of moves) {
        const lesson = lessonById.get(move.lessonId)!;
        const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
        if (input.distribution.has(key)) posts.add(key);
      }
      let distBefore = 0;
      let distAfter = 0;
      for (const key of posts) {
        distBefore += distributionCount(key, none);
        distAfter += distributionCount(key, moved);
      }

      const costs: SoftCost[] = [
        asCost('PUPIL_GAPS', 'MINUTES', pupilBefore / 2, pupilAfter / 2),
        asCost('TEACHER_GAPS', 'MINUTES', teacherBefore / 2, teacherAfter / 2),
        asCost('DISTRIBUTION', 'BREACHES', distBefore, distAfter),
        asCost('TEACHER_DAY', 'BREACHES', dayBefore, dayAfter),
        asCost('MOVED_LESSONS', 'LESSONS', 0, moves.length),
      ];
      const score =
        costs[0]!.delta / SCORE.PUPIL_CLASS +
        costs[1]!.delta +
        SCORE.BREACH * (costs[2]!.delta + costs[3]!.delta) +
        SCORE.MOVED_LESSON * costs[4]!.delta;
      return { costs, score };
    },
  };
}
