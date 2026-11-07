import { buildSoftMeasure, SCORE, type SoftInput } from './swap-soft';
import type { SwapLesson, SwapMove } from './swap-types';

const lesson = (id: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: 'ma',
  subjectName: 'Matematik',
  studentGroupId: '7A',
  groupName: '7A',
  teacherId: 't1',
  coTeacherId: null,
  roomId: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

const move = (l: SwapLesson, day: number, start: number): SwapMove => ({
  lessonId: l.id,
  from: { dayOfWeek: l.dayOfWeek, startMinutes: l.startMinutes, endMinutes: l.endMinutes },
  to: { dayOfWeek: day, startMinutes: start, endMinutes: start + (l.endMinutes - l.startMinutes) },
});

/** One class of `pupils` pupils sitting every lesson, and nothing else. */
function input(lessons: SwapLesson[], over: Partial<SoftInput> = {}, pupils = 2): SoftInput {
  return {
    lessons,
    cohorts: [{ pupils, lessonIds: new Set(lessons.map((l) => l.id)), groups: ['7A'] }],
    margins: new Map(),
    spans: new Map([['7A', [7, 7] as const]]),
    constraints: [],
    frames: [],
    lunch: null,
    teacherRules: new Map(),
    distribution: new Map(),
    ...over,
  };
}

const cost = (costs: { code: string }[], code: string) => costs.find((c) => c.code === code) as { before: number; after: number; delta: number };

describe('the soft costs of a set of moves', () => {
  it('counts the pupils’ håltimmar before and after, weighted by the pupils, and is negative for a closed gap', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 600);
    const measure = buildSoftMeasure(input([a, b]));
    // Monday 08-09 and 10-11: one hole of 60 minutes for two pupils.
    expect(measure.baseline().pupilIdleMinutes).toBe(120);
    const { costs, score } = measure.evaluate([move(b, 1, 540)]);
    expect(cost(costs, 'PUPIL_GAPS')).toMatchObject({ before: 120, after: 0, delta: -120 });
    // Closing 120 pupil-minutes is worth 120 / 25, the teacher's 60 minutes a minute each,
    // against the one lesson that moved.
    expect(score).toBeCloseTo(-120 / SCORE.PUPIL_CLASS - 60 + SCORE.MOVED_LESSON, 6);
  });

  it('counts a gap opened as a cost, and leaves a day it does not touch alone', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 540);
    const c = lesson('c', 2, 480);
    const measure = buildSoftMeasure(input([a, b, c]));
    const { costs } = measure.evaluate([move(b, 1, 660)]);
    expect(cost(costs, 'PUPIL_GAPS').delta).toBe(2 * (660 - 540));
    // The Tuesday lesson is in the baseline of the cohort's week, before and after alike.
    expect(cost(costs, 'PUPIL_GAPS').before).toBe(0);
  });

  it('counts the teachers’ håltimmar, a teacher with two lessons a day at a time', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 600);
    const { costs } = buildSoftMeasure(input([a, b])).evaluate([move(b, 2, 600)]);
    expect(cost(costs, 'TEACHER_GAPS')).toMatchObject({ before: 60, after: 0, delta: -60 });
  });

  it('counts both teachers of a lesson', () => {
    const a = lesson('a', 1, 480, { teacherId: 't1', coTeacherId: 't2' });
    const b = lesson('b', 1, 600, { teacherId: 't1' });
    const c = lesson('c', 1, 720, { teacherId: 't2' });
    const { costs } = buildSoftMeasure(input([a, b, c])).evaluate([move(a, 1, 780)]);
    // t1 teaches 08 and 10, t2 teaches 08 and 12: holes of 60 and 180. At 13:00 t1 has 10 and 13
    // (120) and t2 has 12 and 13 (none): one teacher worse off, the other better.
    expect(cost(costs, 'TEACHER_GAPS')).toMatchObject({ before: 60 + 180, after: 120, delta: -120 });
  });

  it('counts the ämnesfördelning’s breaches of the posts the moves touch', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 600);
    const distribution = new Map([['7A:ma', { maxLessonsPerDay: 1, minDaysBetween: null }]]);
    const measure = buildSoftMeasure(input([a, b], { distribution }));
    expect(cost(measure.evaluate([move(b, 3, 600)]).costs, 'DISTRIBUTION')).toMatchObject({ before: 1, after: 0, delta: -1 });
    expect(cost(measure.evaluate([move(b, 1, 720)]).costs, 'DISTRIBUTION').delta).toBe(0);
  });

  it('counts the breaches of a teacher’s day, never their figures', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 540);
    const teacherRules = new Map([
      ['t1', { maxTeachingMinutesPerDay: 90, maxTeachingDaysPerWeek: null, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null }],
    ]);
    const measure = buildSoftMeasure(input([a, b], { teacherRules }));
    const { costs } = measure.evaluate([move(b, 2, 480)]);
    expect(cost(costs, 'TEACHER_DAY')).toMatchObject({ before: 1, after: 0, delta: -1 });
    expect(Object.keys(cost(costs, 'TEACHER_DAY')).sort()).toEqual(['after', 'before', 'code', 'delta', 'unit']);
    // A teacher with no rule costs nothing, on any move.
    expect(cost(buildSoftMeasure(input([a, b])).evaluate([move(b, 2, 480)]).costs, 'TEACHER_DAY')).toMatchObject({ before: 0, after: 0 });
  });

  it('counts the lessons moved, and orders a quiet move before a costly one', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 540);
    const c = lesson('c', 1, 720);
    const measure = buildSoftMeasure(input([a, b, c]));
    const quiet = measure.evaluate([move(c, 1, 600)]);
    const costly = measure.evaluate([move(b, 1, 780)]);
    expect(cost(quiet.costs, 'MOVED_LESSONS')).toMatchObject({ before: 0, after: 1 });
    expect(quiet.score).toBeLessThan(costly.score);
  });

  it('takes margins as busy time, and closures as closed time, and lunch once', () => {
    const a = lesson('a', 1, 480);
    const b = lesson('b', 1, 600);
    // 20 minutes of dusch after a: the hole between a and b shrinks to 40.
    const margins = new Map([['a', { before: 0, after: 20 }]]);
    expect(buildSoftMeasure(input([a, b], { margins })).baseline().pupilIdleMinutes).toBe(2 * 40);
    // The class is closed 09:00-10:00 by a weekly rule: no hole at all.
    const closed = input([a, b], { constraints: [{ kind: 'STUDENT_GROUP', group: '7A', min: null, max: null, day: 1, start: 540, end: 600 }] });
    expect(buildSoftMeasure(closed).baseline().pupilIdleMinutes).toBe(0);
    // Lunch credited against the hole.
    expect(buildSoftMeasure(input([a, b], { lunch: { start: 540, end: 600, minutes: 60 } })).baseline().pupilIdleMinutes).toBe(0);
  });

  it('counts an alternating week as half of each', () => {
    const a = lesson('a', 1, 480);
    const odd = lesson('odd', 1, 540, { recurrence: 'ODD_WEEKS' });
    const c = lesson('c', 1, 660);
    // Odd weeks: 08-09, 09-10, 11-12 -> a 60-minute hole; even weeks: 08-09, 11-12 -> 120.
    expect(buildSoftMeasure(input([a, odd, c], {}, 1)).baseline().pupilIdleMinutes).toBe((60 + 120) / 2);
  });
});
