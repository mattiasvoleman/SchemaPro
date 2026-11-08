import {
  insideSchoolDay,
  placedLessonsOf,
  placementFitOf,
  placementsFitBesideLocks,
  type PlacementPost,
  type PlacementShape,
} from './placement-fit';

const post = (overrides: Partial<PlacementPost> = {}): PlacementPost => ({
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  shareCount: 0,
  ...overrides,
});
const row = (minutes: number, recurrence: PlacementShape['recurrence'] = 'ALL_WEEKS'): PlacementShape => ({
  minutes,
  recurrence,
});

describe('placementFitOf', () => {
  it('lets a post without rows fit, whatever it is', () => {
    expect(placementFitOf(post({ blockId: 'b', shareCount: 2 }), [])).toBeNull();
  });

  it('fits every-week rows of the post’s length, up to its lessons', () => {
    expect(placementFitOf(post(), [row(60), row(60), row(60)])).toBeNull();
    expect(placementFitOf(post(), [row(60), row(60), row(60), row(60)])).toBe('COUNT');
  });

  it('refuses a post in a parallel block, and one that shares its lessons, before anything else', () => {
    expect(placementFitOf(post({ blockId: 'block' }), [row(45)])).toBe('BLOCK');
    expect(placementFitOf(post({ shareCount: 1 }), [row(45)])).toBe('SHARES');
  });

  it('refuses a length the post does not have, and counts each of a split post’s lengths', () => {
    expect(placementFitOf(post(), [row(45)])).toBe('LENGTH');
    const split = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    expect(placementFitOf(split, [row(80), row(40)])).toBeNull();
    expect(placementFitOf(split, [row(80), row(80)])).toBe('COUNT');
  });

  it('holds a post of odd weeks to odd rows', () => {
    const odd = post({ recurrence: 'ODD_WEEKS' });
    expect(placementFitOf(odd, [row(60, 'ODD_WEEKS'), row(60, 'ODD_WEEKS')])).toBeNull();
    expect(placementFitOf(odd, [row(60)])).toBe('WEEKS');
    expect(placementFitOf(odd, [row(60, 'EVEN_WEEKS')])).toBe('WEEKS');
  });

  it('pairs odd and even rows of one length on an every-week post, and refuses one that pairs with nothing', () => {
    expect(placementFitOf(post(), [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toBeNull();
    expect(placementFitOf(post(), [row(60, 'ODD_WEEKS')])).toBe('PAIRS');
    const split = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    expect(placementFitOf(split, [row(80, 'ODD_WEEKS'), row(40, 'EVEN_WEEKS')])).toBe('PAIRS');
  });

  it('counts a pair as one lesson against the post’s', () => {
    const one = post({ lessonsPerWeek: 1 });
    expect(placementFitOf(one, [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toBeNull();
    expect(placementFitOf(one, [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS'), row(60)])).toBe('COUNT');
  });
});

describe('placedLessonsOf', () => {
  it('reads each row of an alternating post as a lesson of its weeks, and nothing of the others', () => {
    expect(placedLessonsOf({ recurrence: 'EVEN_WEEKS' }, [row(60, 'EVEN_WEEKS'), row(60, 'ODD_WEEKS')])).toEqual([60]);
  });

  it('reads an every-week row as one lesson and a pair as one, longest first', () => {
    expect(
      placedLessonsOf({ recurrence: 'ALL_WEEKS' }, [
        row(40),
        row(80, 'ODD_WEEKS'),
        row(80, 'EVEN_WEEKS'),
        row(80, 'ODD_WEEKS'),
      ]),
    ).toEqual([80, 40]);
  });
});

describe('placementsFitBesideLocks', () => {
  it('leaves room when the locks leave a lesson of each placed length', () => {
    expect(placementsFitBesideLocks({ lessonsPerWeek: 3, minutesPerLesson: 60 }, [60], [60, 60])).toBe(true);
  });

  it('refuses when the locks already take the lesson', () => {
    expect(placementsFitBesideLocks({ lessonsPerWeek: 1, minutesPerLesson: 60 }, [60], [60])).toBe(false);
  });

  it('reads a lock of another length by Generera’s rule: a 60 on 80 + 40 cancels the 40', () => {
    const split = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] };
    expect(placementsFitBesideLocks(split, [60], [80])).toBe(true);
    expect(placementsFitBesideLocks(split, [60], [40])).toBe(false);
  });
});

describe('insideSchoolDay', () => {
  it('admits Monday to Friday, 08:00 to 18:00, on the five-minute grid', () => {
    expect(insideSchoolDay({ dayOfWeek: 1, startMinutes: 8 * 60, minutes: 60 })).toBe(true);
    expect(insideSchoolDay({ dayOfWeek: 5, startMinutes: 17 * 60, minutes: 60 })).toBe(true);
  });

  it('refuses a weekend, an edge outside the day, and a start off the grid', () => {
    expect(insideSchoolDay({ dayOfWeek: 6, startMinutes: 9 * 60, minutes: 60 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 1, startMinutes: 7 * 60 + 55, minutes: 60 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 1, startMinutes: 17 * 60 + 5, minutes: 60 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 1, startMinutes: 9 * 60 + 2, minutes: 60 })).toBe(false);
  });
});
