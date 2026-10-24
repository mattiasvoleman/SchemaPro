import {
  canonicalShares,
  hasShares,
  lessonTeachersOf,
  sharesProblem,
  teacherIdsOf,
  teacherPartsOf,
  type SharedRow,
} from './lesson-shares';

const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CILLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const uniform = (extra: Partial<SharedRow> = {}): SharedRow => ({
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  ...extra,
});
const idrott = (extra: Partial<SharedRow> = {}): SharedRow => ({
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 80,
  lessonLengths: [80, 40],
  ...extra,
});

describe('delade lektioner: which lesson is whose', () => {
  it('is the row it always was with no share: one part, every lesson its teacher’s', () => {
    expect(hasShares(uniform())).toBe(false);
    expect(teacherPartsOf(uniform())).toEqual([{ teacherId: ANNA, role: 'LEAD', lessons: 3, minutes: 180 }]);
    expect(lessonTeachersOf(uniform())).toEqual([
      { minutes: 60, teacherId: ANNA },
      { minutes: 60, teacherId: ANNA },
      { minutes: 60, teacherId: ANNA },
    ]);
    expect(teacherIdsOf(uniform())).toEqual([ANNA]);
  });

  it('gives Bo one of three and Anna the rest, the lead first', () => {
    const row = uniform({ shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] });
    expect(teacherPartsOf(row)).toEqual([
      { teacherId: ANNA, role: 'LEAD', lessons: 2, minutes: 120 },
      { teacherId: BO, role: 'SHARE', lessons: 1, minutes: 60 },
    ]);
    expect(lessonTeachersOf(row).map((lesson) => lesson.teacherId)).toEqual([ANNA, ANNA, BO]);
  });

  it('lays a split row out longest first, the lead before the shares within each length', () => {
    const row = idrott({ shares: [{ teacherId: BO, lessons: 1, minutes: 40 }] });
    expect(lessonTeachersOf(row)).toEqual([
      { minutes: 80, teacherId: ANNA },
      { minutes: 40, teacherId: BO },
    ]);
    expect(teacherPartsOf(row)).toEqual([
      { teacherId: ANNA, role: 'LEAD', lessons: 1, minutes: 80 },
      { teacherId: BO, role: 'SHARE', lessons: 1, minutes: 40 },
    ]);
  });

  it('sums a teacher’s shares of two lengths into one part, and keeps a deleted teacher’s last', () => {
    const row: SharedRow = {
      teacherId: ANNA,
      lessonsPerWeek: 5,
      minutesPerLesson: 80,
      lessonLengths: [80, 80, 40, 40, 40],
      shares: [
        { teacherId: null, lessons: 1, minutes: 40 },
        { teacherId: BO, lessons: 1, minutes: 80 },
        { teacherId: BO, lessons: 1, minutes: 40 },
      ],
    };
    expect(teacherPartsOf(row)).toEqual([
      { teacherId: ANNA, role: 'LEAD', lessons: 2, minutes: 120 },
      { teacherId: BO, role: 'SHARE', lessons: 2, minutes: 120 },
      { teacherId: null, role: 'SHARE', lessons: 1, minutes: 40 },
    ]);
    expect(lessonTeachersOf(row).map((lesson) => `${lesson.minutes}:${lesson.teacherId ?? '-'}`)).toEqual([
      `80:${ANNA}`,
      `80:${BO}`,
      `40:${ANNA}`,
      `40:${BO}`,
      '40:-',
    ]);
  });

  it('names everyone who teaches the row once: lead, shares, medlärare', () => {
    const row = uniform({
      coTeacherId: CILLA,
      shares: [
        { teacherId: BO, lessons: 1, minutes: 60 },
        { teacherId: null, lessons: 1, minutes: 60 },
      ],
    });
    expect(teacherIdsOf(row)).toEqual([ANNA, BO, CILLA]);
  });

  it('merges one teacher’s rows of one length, longest first, null last', () => {
    expect(
      canonicalShares([
        { teacherId: null, lessons: 1, minutes: 40 },
        { teacherId: BO, lessons: 1, minutes: 40 },
        { teacherId: null, lessons: 1, minutes: 40 },
        { teacherId: BO, lessons: 1, minutes: 80 },
      ]),
    ).toEqual([
      { teacherId: BO, lessons: 1, minutes: 80 },
      { teacherId: BO, lessons: 1, minutes: 40 },
      { teacherId: null, lessons: 2, minutes: 40 },
    ]);
  });
});

describe('delade lektioner: what cannot be stored', () => {
  const bo = (lessons: number, minutes = 60) => ({ teacherId: BO, lessons, minutes });

  it.each([
    ['no share at all', uniform(), [], null],
    ['one of three', uniform(), [bo(1)], null],
    ['two of three', uniform(), [bo(2)], null],
    ['half a lesson', uniform(), [bo(0.5)], 'NOT_INTEGER'],
    ['no lesson', uniform(), [bo(0)], 'OUT_OF_RANGE'],
    ['forty lessons', uniform(), [bo(40)], 'OUT_OF_RANGE'],
    ['Bo twice at one length', uniform(), [bo(1), bo(1)], 'TEACHER_TWICE'],
    ['the lead as a share', uniform(), [{ teacherId: ANNA, lessons: 1, minutes: 60 }], 'TEACHER_ON_POST'],
    ['the medlärare as a share', uniform({ coTeacherId: BO }), [bo(1)], 'TEACHER_ON_POST'],
    ['a length the row lacks', uniform(), [bo(1, 45)], 'LENGTH_NOT_ON_POST'],
    ['two of the one 40', idrott(), [bo(1, 40), { teacherId: CILLA, lessons: 1, minutes: 40 }], 'TOO_MANY_OF_LENGTH'],
    ['every lesson', uniform(), [bo(2), { teacherId: CILLA, lessons: 1, minutes: 60 }], 'LEAD_KEEPS_NONE'],
    ['the only lesson', uniform({ lessonsPerWeek: 1 }), [bo(1)], 'LEAD_KEEPS_NONE'],
    ['two deleted teachers', uniform(), [{ teacherId: null, lessons: 1, minutes: 60 }, { teacherId: null, lessons: 1, minutes: 60 }], null],
    ['a lead nobody is', uniform({ teacherId: null }), [bo(2)], null],
  ] as const)('%s', (_name, row, shares, problem) => {
    expect(sharesProblem(row, shares)).toBe(problem);
  });
});
