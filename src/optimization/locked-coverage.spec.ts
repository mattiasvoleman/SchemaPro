import { coverLockedLessons } from './locked-coverage';

describe('coverLockedLessons', () => {
  it.each<[string, number[], number[], number[]]>([
    // [case, the requirement's lengths, the locked lessons' minutes, what is left]
    ['a locked 40 cancels the 40', [80, 40], [40], [80]],
    ['a locked 80 cancels the 80', [80, 40], [80], [40]],
    ['a locked 50 cancels the nearest, the 40', [80, 40], [50], [80]],
    ['a locked 75 cancels the nearest, the 80', [80, 40], [75], [40]],
    ['a locked 60 is a tie and cancels the shorter', [80, 40], [60], [80]],
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
