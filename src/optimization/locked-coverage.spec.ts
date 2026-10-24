import { coverLockedLessons, coverLockedSharedLessons, type TaughtLesson } from './locked-coverage';

describe('coverLockedLessons', () => {
  it.each<[string, number[], number[], number[]]>([
    // [case, the requirement's lengths, the locked lessons' minutes, what is left]
    ['a locked 40 cancels the 40', [80, 40], [40], [80]],
    ['a locked 80 cancels the 80', [80, 40], [80], [40]],
    ['a locked 50 cancels the nearest, the 40', [80, 40], [50], [80]],
    ['a locked 75 cancels the nearest, the 80', [80, 40], [75], [40]],
    ['a locked 60 is a tie and cancels the shorter', [80, 40], [60], [80]],
    // Nearest can under-deliver: 70 + 40 is 110 of 120, as a 45 on 3 × 60 is today.
    ['a locked 70 cancels the nearest, the 80, and the week is 10 short', [80, 40], [70], [40]],
    ['an exact match is never taken by a nearer guess', [80, 60, 40], [70, 60], [40]],
    ['a locked 80 and a locked 75 cancel both', [80, 40], [80, 75], []],
    ['locks beyond the demand cancel nothing more', [80, 40], [80, 40, 60], []],
    ['no lock leaves every length, longest first', [40, 80], [], [80, 40]],
    ['2 × 60 + 1 × 40 with a locked 45 keeps both hours', [60, 60, 40], [45], [60, 60]],
  ])('%s', (_case, lengths, locked, left) => {
    expect(coverLockedLessons(lengths, locked)).toEqual(left);
  });

  it('is today’s count for a uniform requirement, whatever a lock lasts', () => {
    // Three a week; locks of 60, 45 and 90 minutes each cancel one lesson.
    expect(coverLockedLessons([60, 60, 60], [60])).toEqual([60, 60]);
    expect(coverLockedLessons([60, 60, 60], [45])).toEqual([60, 60]);
    expect(coverLockedLessons([60, 60, 60], [90, 45])).toEqual([60]);
    expect(coverLockedLessons([60, 60, 60], [60, 60, 60, 60])).toEqual([]);
  });

  it('does not change the lengths it is handed', () => {
    const lengths = [80, 40];
    coverLockedLessons(lengths, [40]);
    expect(lengths).toEqual([80, 40]);
  });
});

describe('coverLockedSharedLessons (delade lektioner)', () => {
  const lesson = (minutes: number, teacherId: string | null): TaughtLesson => ({ minutes, teacherId });
  // 9A's three matematik: Anna's two, Bo's one, in the post's order.
  const ma = [lesson(60, 'anna'), lesson(60, 'anna'), lesson(60, 'bo')];

  it.each<[string, TaughtLesson[], TaughtLesson[], TaughtLesson[]]>([
    ['Bo’s own lock answers Bo’s lesson, and Anna’s two are left', ma, [lesson(60, 'bo')], [lesson(60, 'anna'), lesson(60, 'anna')]],
    ['Anna’s own lock answers one of hers', ma, [lesson(60, 'anna')], [lesson(60, 'anna'), lesson(60, 'bo')]],
    ['a lock by a substitute answers the lead’s first', ma, [lesson(60, 'vikarie')], [lesson(60, 'anna'), lesson(60, 'bo')]],
    ['a lock with no teacher answers the lead’s first', ma, [lesson(60, null)], [lesson(60, 'anna'), lesson(60, 'bo')]],
    ['two of Anna’s and Bo’s own leave nothing', ma, [lesson(60, 'anna'), lesson(60, 'bo'), lesson(60, 'anna')], []],
    ['a lock beyond the demand cancels nothing more', ma, [lesson(60, 'x'), lesson(60, 'x'), lesson(60, 'x'), lesson(60, 'x')], []],
    // Idrott 1 × 80 + 1 × 40, Bo the 40.
    ['Bo’s locked 40 answers his 40', [lesson(80, 'anna'), lesson(40, 'bo')], [lesson(40, 'bo')], [lesson(80, 'anna')]],
    ['Anna’s locked 40 answers the 40 by length, Bo’s though it is', [lesson(80, 'anna'), lesson(40, 'bo')], [lesson(40, 'anna')], [lesson(80, 'anna')]],
    ['a locked 70 answers the nearest, the 80', [lesson(80, 'anna'), lesson(40, 'bo')], [lesson(70, 'x')], [lesson(40, 'bo')]],
    ['a locked 60 between them answers the shorter on the tie', [lesson(80, 'anna'), lesson(40, 'bo')], [lesson(60, 'x')], [lesson(80, 'anna')]],
  ])('%s', (_case, lessons, locked, left) => {
    expect(coverLockedSharedLessons(lessons, locked)).toEqual(left);
  });

  it('agrees with coverLockedLessons on the lengths when every lesson is one teacher’s', () => {
    const one = [lesson(80, 'anna'), lesson(60, 'anna'), lesson(40, 'anna')];
    for (const locked of [[70], [60, 50], [45, 45, 45], [80, 40, 100]]) {
      expect(coverLockedSharedLessons(one, locked.map((minutes) => lesson(minutes, 'x'))).map((l) => l.minutes)).toEqual(
        coverLockedLessons([80, 60, 40], locked),
      );
    }
  });
});
