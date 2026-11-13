import type { LessonRecurrence } from '@prisma/client';
import { lessonMinutesOf } from '../common/lesson-lengths';
import { lessonTeachersOf } from '../common/lesson-shares';
import { coverLockedLessons, coverLockedSharedLessons } from '../optimization/locked-coverage';
import { withoutPlaced, withoutPlacedShared } from '../optimization/placed-lessons';
import {
  boardPostOf,
  boardPostShape,
  coveringLocksOf,
  keptViewOf,
  mealViewOf,
  type BoardPost,
  type KeptForCount,
} from './placement-board';
import { placedLessonsOf, placedTaughtOf, type PlacementShape } from './placement-fit';

const ANNA = 'anna';
const BO = 'bo';
const GROUP = 'g-7a';
const SUBJECT = 'sub-ma';

const post = (over: Partial<BoardPost> = {}): BoardPost => ({
  id: 'post-1',
  studentGroupId: GROUP,
  subjectId: SUBJECT,
  teacherId: ANNA,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  shares: [],
  ...over,
});

const row = (minutes: number, recurrence: LessonRecurrence = 'ALL_WEEKS', teacherId: string | null = null): PlacementShape => ({
  minutes,
  recurrence,
  teacherId,
});

const kept = (over: Partial<KeptForCount> = {}): KeptForCount => ({
  studentGroupId: GROUP,
  subjectId: SUBJECT,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  teacherId: ANNA,
  minutes: 60,
  ...over,
});

const date = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

describe('boardPostOf: what a post has left', () => {
  it('has every lesson left when nothing answers one', () => {
    expect(boardPostOf(post(), [], [])).toEqual({
      id: 'post-1',
      studentGroupId: GROUP,
      subjectId: SUBJECT,
      teacherId: ANNA,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      cannotPlace: null,
      parts: [{ teacherId: ANNA, minutes: 60, count: 3, locked: 0, placed: 0, left: 3, cannotPlace: null }],
    });
  });

  it('counts a lock first, then each förläggning, and leaves the rest to Generera', () => {
    const view = boardPostOf(post(), [{ minutes: 60, teacherId: ANNA }], [row(60), row(60)]);
    expect(view.parts).toEqual([{ teacherId: ANNA, minutes: 60, count: 3, locked: 1, placed: 2, left: 0, cannotPlace: null }]);
  });

  it('counts an odd and an even row of one length as one lesson in two places', () => {
    const view = boardPostOf(post(), [], [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')]);
    expect(view.parts[0]).toMatchObject({ count: 3, placed: 1, left: 2 });
    // A lone half places nothing: the row is in the list with its refusal, the post still has all three.
    expect(boardPostOf(post(), [], [row(60, 'ODD_WEEKS')]).parts[0]).toMatchObject({ placed: 0, left: 3 });
  });

  it('takes a förläggning off the length it places, not the nearest', () => {
    const split = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    const view = boardPostOf(split, [], [row(40)]);
    expect(view.parts).toEqual([
      { teacherId: ANNA, minutes: 80, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null },
      { teacherId: ANNA, minutes: 40, count: 1, locked: 0, placed: 1, left: 0, cannotPlace: null },
    ]);
  });

  it('lets a lock cancel the nearest length, as Generera does (70 on 80 + 40 is the 80)', () => {
    const split = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    const view = boardPostOf(split, [{ minutes: 70, teacherId: 'x' }], []);
    expect(view.parts.map((part) => [part.minutes, part.locked, part.left])).toEqual([
      [80, 1, 0],
      [40, 0, 1],
    ]);
  });

  it('adds a förläggning no lesson is left for to nothing: the row has its refusal, the post its lessons', () => {
    const view = boardPostOf(post({ lessonsPerWeek: 1 }), [{ minutes: 60, teacherId: ANNA }], [row(60)]);
    expect(view.parts[0]).toMatchObject({ count: 1, locked: 1, placed: 0, left: 0 });
  });

  it('counts a shared post per teacher: Bo\'s lock answers Bo\'s lesson, and Bo\'s förläggning none of Anna\'s', () => {
    const shared = post({ shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] });
    const view = boardPostOf(shared, [{ minutes: 60, teacherId: BO }], [row(60, 'ALL_WEEKS', BO), row(60, 'ALL_WEEKS', ANNA)]);
    expect(view.parts).toEqual([
      { teacherId: ANNA, minutes: 60, count: 2, locked: 0, placed: 1, left: 1, cannotPlace: null },
      { teacherId: BO, minutes: 60, count: 1, locked: 1, placed: 0, left: 0, cannotPlace: null },
    ]);
  });

  it('says a part nobody teaches cannot be placed, on a shared post only', () => {
    const shared = post({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    expect(boardPostOf(shared, [], []).parts).toEqual([
      { teacherId: ANNA, minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null },
      { teacherId: null, minutes: 60, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: 'NO_TEACHER' },
    ]);
    // A post that shares nothing and has no huvudlärare is placed as it always was.
    expect(boardPostOf(post({ teacherId: null }), [], []).parts[0]!.cannotPlace).toBeNull();
  });

  it('says a post in a parallel block cannot be placed, and states its dates as days', () => {
    const view = boardPostOf(post({ blockId: 'block-1', startDate: date('2026-08-24'), endDate: date('2026-12-20') }), [], []);
    expect(view).toMatchObject({ cannotPlace: 'BLOCK', startDate: '2026-08-24', endDate: '2026-12-20' });
  });

  /*
   * THE SAME COUNT AS GENERERA, over many shapes: the helpers its fetch reads (coverLockedLessons, withoutPlaced and,
   * on a shared post, their per-teacher twins), called here in the order the fetch calls them, against what the week
   * of förläggningar says. A figure that moved from the one to the other would fail here.
   */
  it('equals Generera\'s count over a sweep of posts, locks and rows', () => {
    const lengths = [[60, 60, 60], [80, 40], [80, 60, 40], [45], [60, 60]];
    const lockSets = [[], [60], [80], [70], [60, 60], [40, 80], [100]];
    const rowSets: PlacementShape[][] = [
      [],
      [row(60)],
      [row(40), row(80)],
      [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')],
      [row(60, 'ODD_WEEKS')],
      [row(60), row(60), row(60), row(60)],
    ];
    let cases = 0;
    for (const set of lengths) {
      for (const lockMinutes of lockSets) {
        for (const rows of rowSets) {
          const unit = post({ lessonsPerWeek: set.length, minutesPerLesson: Math.max(...set), lessonLengths: new Set(set).size > 1 ? set : [] });
          const locks = lockMinutes.map((minutes) => ({ minutes, teacherId: ANNA }));
          const view = boardPostOf(unit, locks, rows);
          const afterLocks = coverLockedLessons(lessonMinutesOf(unit), lockMinutes);
          const left = withoutPlaced(afterLocks, placedLessonsOf(unit, rows));
          expect(view.parts.flatMap((part) => Array<number>(part.left).fill(part.minutes)).sort((a, b) => b - a)).toEqual(left);
          for (const part of view.parts) expect(part.locked + part.placed + part.left).toBe(part.count);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(lengths.length * lockSets.length * rowSets.length);
  });

  it('equals Generera\'s count on a shared post, teacher by teacher', () => {
    const shared = post({ lessonsPerWeek: 4, shares: [{ teacherId: BO, lessons: 2, minutes: 60 }] });
    const lockSets = [[], [{ minutes: 60, teacherId: BO }], [{ minutes: 60, teacherId: 'cecilia' }], [{ minutes: 40, teacherId: ANNA }]];
    const rowSets: PlacementShape[][] = [[], [row(60, 'ALL_WEEKS', BO)], [row(60, 'ALL_WEEKS', ANNA), row(60, 'ALL_WEEKS', BO), row(60, 'ALL_WEEKS', BO), row(60, 'ALL_WEEKS', BO)]];
    for (const locks of lockSets) {
      for (const rows of rowSets) {
        const view = boardPostOf(shared, locks, rows);
        const afterLocks = coverLockedSharedLessons(lessonTeachersOf(shared), locks);
        const left = rows.length > 0 ? withoutPlacedShared(afterLocks, placedTaughtOf(shared, rows)) : afterLocks;
        const fromView = view.parts.flatMap((part) => Array.from({ length: part.left }, () => `${part.teacherId}|${part.minutes}`));
        expect(fromView.sort()).toEqual(left.map((lesson) => `${lesson.teacherId}|${lesson.minutes}`).sort());
        for (const part of view.parts) expect(part.locked + part.placed + part.left).toBe(part.count);
      }
    }
  });
});

describe('coveringLocksOf', () => {
  const unit = boardPostShape({ ...post(), lessonLengths: [] });

  it('takes the kept lessons of the post\'s class and subject that run the post\'s weeks, each its length and teacher', () => {
    const locks = coveringLocksOf(unit, [
      kept({ minutes: 60 }),
      kept({ minutes: 45, teacherId: BO }),
      kept({ studentGroupId: 'g-7b' }),
      kept({ subjectId: 'sub-sv' }),
    ]);
    expect(locks).toEqual([
      { minutes: 60, teacherId: ANNA },
      { minutes: 45, teacherId: BO },
    ]);
  });

  it('leaves out a lesson of other weeks, and one that stops before the post does (lockCoversDemand)', () => {
    const dated = boardPostShape({ ...post(), lessonLengths: [], startDate: date('2026-08-24'), endDate: date('2026-12-20') });
    expect(coveringLocksOf(unit, [kept({ recurrence: 'ODD_WEEKS' })])).toEqual([]);
    expect(coveringLocksOf(dated, [kept({ endDate: date('2026-10-04') })])).toEqual([]);
    // A lesson that runs the whole year covers a post that runs a term.
    expect(coveringLocksOf(dated, [kept()])).toHaveLength(1);
  });
});

describe('the views', () => {
  it('states a kept lesson with ids and clock times, and no pupil', () => {
    const view = keptViewOf({
      id: 'l-1',
      dayOfWeek: 3,
      startTime: new Date('1970-01-01T09:05:00.000Z'),
      endTime: new Date('1970-01-01T10:05:00.000Z'),
      studentGroupId: GROUP,
      extraGroups: [{ studentGroupId: 'g-7b' }],
      subjectId: SUBJECT,
      teacherId: ANNA,
      coTeacherId: null,
      roomId: null,
      recurrence: 'ODD_WEEKS',
      startDate: date('2026-08-24'),
      endDate: null,
      isLocked: true,
      isGenerated: false,
    });
    expect(view).toEqual({
      id: 'l-1',
      dayOfWeek: 3,
      startTime: '09:05',
      endTime: '10:05',
      studentGroupId: GROUP,
      extraGroupIds: ['g-7b'],
      subjectId: SUBJECT,
      teacherId: ANNA,
      coTeacherId: null,
      roomId: null,
      recurrence: 'ODD_WEEKS',
      startDate: '2026-08-24',
      endDate: null,
      locked: true,
      generated: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/participants|studentId/);
  });

  it('states a hand-placed meal with its weeks', () => {
    expect(
      mealViewOf({
        id: 'm-1',
        studentGroupId: GROUP,
        dayOfWeek: 2,
        startTime: new Date('1970-01-01T11:00:00.000Z'),
        endTime: new Date('1970-01-01T11:30:00.000Z'),
        startDate: null,
        endDate: date('2026-12-20'),
      }),
    ).toEqual({ id: 'm-1', studentGroupId: GROUP, dayOfWeek: 2, startTime: '11:00', endTime: '11:30', startDate: null, endDate: '2026-12-20' });
  });
});
