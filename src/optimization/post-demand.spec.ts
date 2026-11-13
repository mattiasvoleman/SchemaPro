import { coverLockedLessons, coverLockedSharedLessons } from './locked-coverage';
import { demandLeftOf } from './post-demand';
import { lessonTeachersOf } from '../common/lesson-shares';
import { placedLessonsOf, placedTaughtOf } from '../requirement-placements/placement-fit';
import { withoutPlaced, withoutPlacedShared } from './placed-lessons';

const ANNA = 'anna';
const BO = 'bo';
const minutes = (lessons: readonly { minutes: number }[]): number[] => lessons.map((lesson) => lesson.minutes);

const UNIFORM = { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] as number[], teacherId: ANNA };
const SPLIT = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40], teacherId: ANNA };
const SHARED = {
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [] as number[],
  teacherId: ANNA,
  shares: [{ teacherId: BO, lessons: 1, minutes: 60 }],
};

describe('demandLeftOf: a post that shares nothing', () => {
  it('leaves every lesson when nothing answers one', () => {
    const demand = demandLeftOf(UNIFORM, [], {});
    expect(minutes(demand.left)).toEqual([60, 60, 60]);
    expect(demand.shared).toBe(false);
    expect(demand.placed).toBe(false);
    expect(demand.locks).toEqual([]);
  });

  it('takes the lock off first and each förläggning after it, the order the judge holds them to', () => {
    const demand = demandLeftOf(SPLIT, [{ minutes: 80, teacherId: null }], { minutes: [40] });
    expect(minutes(demand.afterLocks)).toEqual([40]);
    expect(minutes(demand.left)).toEqual([]);
    expect(demand.placed).toBe(true);
  });

  it('is the helpers Generera counts with, call for call', () => {
    // A locked 70 on 1 × 80 + 1 × 40 cancels the 80 (the nearest), and a förläggning of 40 is then the post's last.
    const locks = [{ minutes: 70, teacherId: 'x' }];
    const placed = placedLessonsOf({ recurrence: 'ALL_WEEKS' }, [{ minutes: 40, recurrence: 'ALL_WEEKS' }]);
    const demand = demandLeftOf(SPLIT, locks, { minutes: placed });
    const afterLocks = coverLockedLessons([80, 40], [70]);
    expect(minutes(demand.afterLocks)).toEqual(afterLocks);
    expect(minutes(demand.left)).toEqual(withoutPlaced(afterLocks, placed));
  });

  it('counts a pair of odd and even rows as one lesson, and an empty answer as placed', () => {
    const rows = [
      { minutes: 60, recurrence: 'ODD_WEEKS' as const },
      { minutes: 60, recurrence: 'EVEN_WEEKS' as const },
    ];
    const placed = placedLessonsOf({ recurrence: 'ALL_WEEKS' }, rows);
    expect(placed).toEqual([60]);
    expect(minutes(demandLeftOf(UNIFORM, [], { minutes: placed }).left)).toEqual([60, 60]);
    // A lone odd row places nothing, but the post has rows for the count to read.
    const lone = placedLessonsOf({ recurrence: 'ALL_WEEKS' }, [rows[0]!]);
    const demand = demandLeftOf(UNIFORM, [], { minutes: lone });
    expect(lone).toEqual([]);
    expect(demand.placed).toBe(true);
    expect(minutes(demand.left)).toEqual([60, 60, 60]);
  });

  it('takes nothing from a length with no lesson left', () => {
    expect(minutes(demandLeftOf(UNIFORM, [], { minutes: [45] }).left)).toEqual([60, 60, 60]);
  });

  it('tags the lessons with the post teacher, who is nobody for a post with none', () => {
    expect(demandLeftOf(UNIFORM, [], {}).left.every((lesson) => lesson.teacherId === ANNA)).toBe(true);
    expect(demandLeftOf({ ...UNIFORM, teacherId: null }, [], {}).left.every((lesson) => lesson.teacherId === null)).toBe(true);
  });
});

describe('demandLeftOf: a post that shares its lessons', () => {
  it("answers Bo's lock with Bo's lesson and Bo's förläggning with none of Anna's", () => {
    const locks = [{ minutes: 60, teacherId: BO }];
    const placed = placedTaughtOf({ recurrence: 'ALL_WEEKS', teacherId: ANNA, shares: SHARED.shares }, [
      { minutes: 60, recurrence: 'ALL_WEEKS', teacherId: BO },
    ]);
    const demand = demandLeftOf(SHARED, locks, { taught: placed });
    expect(demand.shared).toBe(true);
    // Bo has one lesson, the lock took it; Bo's förläggning finds none and takes nothing of Anna's.
    expect(demand.left).toEqual([
      { minutes: 60, teacherId: ANNA },
      { minutes: 60, teacherId: ANNA },
    ]);
    expect(demand.afterLocks).toEqual(coverLockedSharedLessons(lessonTeachersOf(SHARED), locks));
    expect(demand.left).toEqual(withoutPlacedShared(demand.afterLocks, placed));
    expect(demand.locks).toEqual(locks);
  });

  it('lets a lock of a teacher the post does not name fall to the length rule', () => {
    const demand = demandLeftOf(SHARED, [{ minutes: 60, teacherId: 'cecilia' }], { taught: [] });
    // The huvudlärare's lesson goes first (the post's order), so Bo's lesson stays.
    expect(demand.afterLocks).toEqual([
      { minutes: 60, teacherId: ANNA },
      { minutes: 60, teacherId: BO },
    ]);
    expect(demand.placed).toBe(true);
  });

  it('reads the förläggningar of the shared path only from `taught`', () => {
    const demand = demandLeftOf(SHARED, [], { minutes: [60] });
    expect(demand.placed).toBe(false);
    expect(demand.left).toHaveLength(3);
  });
});
