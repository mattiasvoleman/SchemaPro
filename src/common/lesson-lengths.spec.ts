import {
  canonicalShape,
  isMixed,
  lengthPartsOf,
  lengthsProblem,
  lessonCountOf,
  lessonMinutesOf,
  longestLessonOf,
  shapeFromParts,
  shortestLessonOf,
  weeklyMinutesOf,
} from './lesson-lengths';

describe('lesson-lengths', () => {
  it('counts a uniform row exactly as lessonsPerWeek × minutesPerLesson, with or without the list key', () => {
    for (const row of [
      { lessonsPerWeek: 3, minutesPerLesson: 60 },
      { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] },
      { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: null },
    ]) {
      expect(isMixed(row)).toBe(false);
      expect(weeklyMinutesOf(row)).toBe(180);
      expect(lessonCountOf(row)).toBe(3);
      expect(lessonMinutesOf(row)).toEqual([60, 60, 60]);
      expect(lengthPartsOf(row)).toEqual([{ count: 3, minutes: 60 }]);
      expect(shortestLessonOf(row)).toBe(60);
      expect(longestLessonOf(row)).toBe(60);
    }
  });

  it('counts 1 × 80 + 1 × 40 as 120 minutes in two lessons, not 2 × 80', () => {
    const idrott = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] };
    expect(isMixed(idrott)).toBe(true);
    expect(weeklyMinutesOf(idrott)).toBe(120);
    expect(lessonCountOf(idrott)).toBe(2);
    expect(lessonMinutesOf(idrott)).toEqual([80, 40]);
    expect(shortestLessonOf(idrott)).toBe(40);
    expect(longestLessonOf(idrott)).toBe(80);
    expect(lengthPartsOf(idrott)).toEqual([
      { count: 1, minutes: 80 },
      { count: 1, minutes: 40 },
    ]);
  });

  it('reads a list of one length as the uniform row it is', () => {
    const row = { lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [60, 60] };
    expect(isMixed(row)).toBe(false);
    expect(weeklyMinutesOf(row)).toBe(120);
  });

  it('reads a half-typed form as 0, never NaN', () => {
    expect(weeklyMinutesOf({ lessonsPerWeek: Number.NaN, minutesPerLesson: 60 })).toBe(0);
    expect(weeklyMinutesOf({ lessonsPerWeek: 2, minutesPerLesson: Number.NaN })).toBe(0);
    expect(lessonMinutesOf({ lessonsPerWeek: Number.NaN, minutesPerLesson: 60 })).toEqual([]);
  });

  it('stores any list canonically: sorted, and [] when it is one length', () => {
    expect(canonicalShape([40, 80])).toEqual({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    expect(canonicalShape([60, 60, 60])).toEqual({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
    expect(shapeFromParts([{ count: 2, minutes: 60 }, { count: 1, minutes: 55 }])).toEqual({
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      lessonLengths: [60, 60, 55],
    });
  });

  it('names the first thing wrong with a list, lengths before the list', () => {
    expect(lengthsProblem([])).toBe('EMPTY');
    expect(lengthsProblem([60, 42.5])).toBe('NOT_INTEGER');
    expect(lengthsProblem([300, 42])).toBe('OUT_OF_RANGE');
    expect(lengthsProblem([60, 42])).toBe('OFF_GRID');
    expect(lengthsProblem(new Array(41).fill(40))).toBe('TOO_MANY_LESSONS');
    expect(lengthsProblem([90, 80, 60, 40])).toBe('TOO_MANY_KINDS');
    expect(lengthsProblem([80, 60, 40])).toBeNull();
  });
});
