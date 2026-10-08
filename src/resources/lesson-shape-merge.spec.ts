import { BadRequestException } from '@nestjs/common';
import {
  CREATE_DEFAULT_SHAPE,
  LESSON_LENGTHS_MISMATCH,
  LESSON_LENGTHS_TOO_MANY_KINDS,
  mergeLessonShape,
  resolveLessonShape,
  touchesLessonShape,
} from './lesson-shape-merge';

const UNIFORM = { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] };
const SPLIT = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] };

describe('resolveLessonShape', () => {
  it.each<[string, object, object, object, object]>([
    // [case, stored, patch, shape after, fields written]
    ['a uniform row PATCHed with scalars writes them, as before', UNIFORM, { lessonsPerWeek: 4 },
      { lessonsPerWeek: 4, minutesPerLesson: 60, lessonLengths: [] }, { lessonsPerWeek: 4 }],
    ['a uniform row PATCHed with both scalars writes both', UNIFORM, { lessonsPerWeek: 2, minutesPerLesson: 90 },
      { lessonsPerWeek: 2, minutesPerLesson: 90, lessonLengths: [] }, { lessonsPerWeek: 2, minutesPerLesson: 90 }],
    ['a list makes a uniform row split, all three written', UNIFORM, { lessonLengths: [40, 80] },
      SPLIT, SPLIT],
    ['a list with agreeing scalars is the same split', UNIFORM, { lessonLengths: [80, 40], lessonsPerWeek: 2, minutesPerLesson: 80 },
      SPLIT, SPLIT],
    ['a list of one length is a uniform row, the list cleared', SPLIT, { lessonLengths: [60, 60, 60] },
      UNIFORM, UNIFORM],
    ['[] makes a split row uniform at its count and longest', SPLIT, { lessonLengths: [] },
      { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [] }, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [] }],
    ['[] with scalars makes it uniform as they say', SPLIT, { lessonLengths: [], lessonsPerWeek: 3, minutesPerLesson: 40 },
      { lessonsPerWeek: 3, minutesPerLesson: 40, lessonLengths: [] }, { lessonsPerWeek: 3, minutesPerLesson: 40, lessonLengths: [] }],
    ['an old client re-saving equal scalars keeps the split and writes nothing', SPLIT, { lessonsPerWeek: 2, minutesPerLesson: 80 },
      SPLIT, {}],
    ['an old client sending one equal scalar keeps the split', SPLIT, { minutesPerLesson: 80 },
      SPLIT, {}],
    ['an old client typing 3 × 60 states a uniform row', SPLIT, { lessonsPerWeek: 3, minutesPerLesson: 60 },
      UNIFORM, UNIFORM],
    ['an old client changing only the count makes it uniform at the longest', SPLIT, { lessonsPerWeek: 3 },
      { lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [] }, { lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [] }],
    ['a create over the defaults takes the list', CREATE_DEFAULT_SHAPE, { lessonLengths: [80, 40] },
      SPLIT, SPLIT],
    ['a create without lengths is the defaults', CREATE_DEFAULT_SHAPE, {},
      CREATE_DEFAULT_SHAPE, {}],
  ])('%s', (_case, stored, patch, shape, write) => {
    expect(resolveLessonShape(stored as never, patch)).toEqual({ shape, write });
  });

  it('refuses scalars that contradict the list, naming both', () => {
    expect(resolveLessonShape(UNIFORM, { lessonLengths: [80, 40], lessonsPerWeek: 3, minutesPerLesson: 60 })).toEqual({
      code: LESSON_LENGTHS_MISMATCH,
      message:
        'lessonLengths: 2 lektioner med längsta 80 minuter, men lessonsPerWeek och minutesPerLesson säger 3 × 60. ' +
        'Skicka bara lessonLengths, eller värden som stämmer med den.',
    });
    // One scalar is enough to contradict it.
    expect(resolveLessonShape(UNIFORM, { lessonLengths: [80, 40], minutesPerLesson: 60 })).toMatchObject({
      code: LESSON_LENGTHS_MISMATCH,
    });
  });

  it('refuses a fourth different length', () => {
    expect(resolveLessonShape(UNIFORM, { lessonLengths: [90, 80, 60, 40] })).toEqual({
      code: LESSON_LENGTHS_TOO_MANY_KINDS,
      message: 'lessonLengths: högst tre olika lektionslängder i en timplanspost.',
    });
  });

  it('reads a stored list of one length as the uniform row it is', () => {
    expect(resolveLessonShape({ lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [60, 60] }, { lessonsPerWeek: 3 }))
      .toEqual({ shape: { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] }, write: { lessonsPerWeek: 3 } });
  });
});

describe('mergeLessonShape', () => {
  it('answers a problem as a coded 400', () => {
    let thrown: unknown;
    try {
      mergeLessonShape(UNIFORM, { lessonLengths: [90, 80, 60, 40] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toEqual({
      message: 'lessonLengths: högst tre olika lektionslängder i en timplanspost.',
      code: LESSON_LENGTHS_TOO_MANY_KINDS,
    });
  });
});

describe('touchesLessonShape', () => {
  it('is any of the three fields, [] included', () => {
    expect(touchesLessonShape({})).toBe(false);
    expect(touchesLessonShape({ lessonLengths: [] })).toBe(true);
    expect(touchesLessonShape({ lessonsPerWeek: 1 })).toBe(true);
    expect(touchesLessonShape({ minutesPerLesson: 60 })).toBe(true);
  });
});
