import {
  followPlacements,
  insideSchoolDay,
  placedLessonsOf,
  placedTaughtOf,
  placementFitOf,
  placementsFitBesideLocks,
  sharedPlacementsFitBesideLocks,
  teacherFitOf,
  teacherMisfitOf,
  teacherOfRow,
  teacherPartsOf,
  type FollowedRow,
  type PlacementPost,
  type PlacementShape,
} from './placement-fit';

const post = (overrides: Partial<PlacementPost> = {}): PlacementPost => ({
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  teacherId: 'anna',
  shares: [],
  ...overrides,
});
const row = (
  minutes: number,
  recurrence: PlacementShape['recurrence'] = 'ALL_WEEKS',
  teacherId: string | null = null,
): PlacementShape => ({
  minutes,
  recurrence,
  teacherId,
});
/** 9A's matematik: Anna's two lessons of 60 and Bo's one. */
const shared = (overrides: Partial<PlacementPost> = {}): PlacementPost =>
  post({ shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }], ...overrides });
/** Idrott 1 × 80 + 1 × 40, Bo takes the 40. */
const mixedShared = (overrides: Partial<PlacementPost> = {}): PlacementPost =>
  post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40], shares: [{ teacherId: 'bo', lessons: 1, minutes: 40 }], ...overrides });

describe('placementFitOf', () => {
  it('lets a post without rows fit, whatever it is', () => {
    expect(placementFitOf(post({ blockId: 'b', shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] }), [])).toBeNull();
  });

  it('fits every-week rows of the post’s length, up to its lessons', () => {
    expect(placementFitOf(post(), [row(60), row(60), row(60)])).toBeNull();
    expect(placementFitOf(post(), [row(60), row(60), row(60), row(60)])).toBe('COUNT');
  });

  it('refuses a post in a parallel block before anything else', () => {
    expect(placementFitOf(post({ blockId: 'block' }), [row(45)])).toBe('BLOCK');
    expect(placementFitOf(shared({ blockId: 'block' }), [row(45, 'ALL_WEEKS', 'bo')])).toBe('BLOCK');
  });

  it('refuses a length the post does not have, and counts each of a split post’s lengths', () => {
    expect(placementFitOf(post(), [row(45)])).toBe('LENGTH');
    // One row of a length the post lacks is enough, beside rows that fit.
    expect(placementFitOf(post(), [row(60), row(45)])).toBe('LENGTH');
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

describe('placementFitOf on a post with delade lektioner', () => {
  it('places one, some or all of the lessons, each its teacher’s', () => {
    expect(placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'bo')])).toBeNull();
    expect(placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'anna')])).toBeNull();
    expect(
      placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'bo'), row(60, 'ALL_WEEKS', 'anna')]),
    ).toBeNull();
  });

  it('asks the post’s own rules first, as on a post that shares nothing', () => {
    expect(placementFitOf(shared(), [row(45, 'ALL_WEEKS', 'bo')])).toBe('LENGTH');
    expect(placementFitOf(shared(), [row(60, 'ODD_WEEKS', 'anna')])).toBe('PAIRS');
    expect(placementFitOf(shared({ lessonsPerWeek: 2 }), [row(60, 'ALL_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'bo')])).toBe(
      'COUNT',
    );
  });

  it('refuses a row that names nobody (a lesson nobody teaches is not placed), and before the rules per teacher', () => {
    expect(placementFitOf(shared(), [row(60)])).toBe('NO_TEACHER');
    expect(placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'carl'), row(60)])).toBe('NO_TEACHER');
  });

  it('refuses a teacher with no lesson of the post, and one without the length', () => {
    expect(placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'carl')])).toBe('TEACHER');
    expect(placementFitOf(mixedShared(), [row(80, 'ALL_WEEKS', 'bo')])).toBe('TEACHER_LENGTH');
    expect(placementFitOf(mixedShared(), [row(40, 'ALL_WEEKS', 'anna')])).toBe('TEACHER_LENGTH');
    expect(placementFitOf(mixedShared(), [row(80, 'ALL_WEEKS', 'anna'), row(40, 'ALL_WEEKS', 'bo')])).toBeNull();
  });

  it('pairs odd and even weeks of one length per teacher: a pair is one lesson, so it is one teacher’s', () => {
    expect(placementFitOf(shared(), [row(60, 'ODD_WEEKS', 'anna'), row(60, 'EVEN_WEEKS', 'bo')])).toBe('TEACHER_PAIRS');
    expect(placementFitOf(shared(), [row(60, 'ODD_WEEKS', 'bo'), row(60, 'EVEN_WEEKS', 'bo')])).toBeNull();
  });

  it('places no more of a teacher’s lessons than their part has, a pair counted once', () => {
    expect(placementFitOf(shared(), [row(60, 'ALL_WEEKS', 'bo'), row(60, 'ALL_WEEKS', 'bo')])).toBe('TEACHER_COUNT');
    expect(
      placementFitOf(shared(), [row(60, 'ODD_WEEKS', 'bo'), row(60, 'EVEN_WEEKS', 'bo'), row(60, 'ALL_WEEKS', 'bo')]),
    ).toBe('TEACHER_COUNT');
    expect(
      placementFitOf(shared(), [row(60, 'ODD_WEEKS', 'anna'), row(60, 'EVEN_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'anna')]),
    ).toBeNull();
  });

  it('keeps a post that shares nothing exactly as it was: rows name nobody, and naming somebody is refused', () => {
    expect(placementFitOf(post(), [row(60), row(60)])).toBeNull();
    expect(placementFitOf(post(), [row(60, 'ALL_WEEKS', 'anna')])).toBe('TEACHER');
    expect(placementFitOf(post({ teacherId: null }), [row(60)])).toBeNull();
  });
});

describe('teacherFitOf and teacherMisfitOf (the deferred trigger’s rules)', () => {
  it('holds a row that names nobody to the lessons nobody teaches, which a removed teacher leaves', () => {
    const removed = shared({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    expect(teacherFitOf(removed, [row(60)])).toBeNull();
    expect(teacherFitOf(removed, [row(60), row(60)])).toBe('TEACHER_COUNT');
    expect(teacherFitOf(shared(), [row(60)])).toBe('TEACHER');
    // A post with no huvudlärare: its lessons no share takes are nobody's.
    expect(teacherFitOf(shared({ teacherId: null }), [row(60), row(60)])).toBeNull();
  });

  it('says which row: the first of a kind, the last of a count', () => {
    expect(teacherMisfitOf(shared(), [row(60, 'ALL_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'carl')])).toEqual({
      reason: 'TEACHER',
      index: 1,
    });
    expect(
      teacherMisfitOf(shared(), [row(60, 'ALL_WEEKS', 'bo'), row(60, 'ALL_WEEKS', 'anna'), row(60, 'ALL_WEEKS', 'bo')]),
    ).toEqual({ reason: 'TEACHER_COUNT', index: 2 });
    expect(teacherMisfitOf(shared(), [row(60, 'ODD_WEEKS', 'anna'), row(60, 'EVEN_WEEKS', 'bo')])).toEqual({
      reason: 'TEACHER_PAIRS',
      index: 0,
    });
    expect(teacherMisfitOf(post(), [row(60), row(60, 'ALL_WEEKS', 'bo')])).toEqual({ reason: 'TEACHER', index: 1 });
    expect(teacherMisfitOf(shared(), [])).toBeNull();
  });

  it('pairs odd and even rows per teacher AND per length: one teacher’s 80 on odd weeks and 40 on even weeks are two unpaired rows (review of #298, LÅG-2)', () => {
    // Anna has an 80 and a 40, Bo a 40.
    const twoLengths = post({ lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [80, 40, 40], shares: [{ teacherId: 'bo', lessons: 1, minutes: 40 }] });
    expect(teacherPartsOf(twoLengths)).toEqual(new Map([['anna', new Map([[80, 1], [40, 1]])], ['bo', new Map([[40, 1]])]]));
    expect(teacherMisfitOf(twoLengths, [row(80, 'ODD_WEEKS', 'anna'), row(40, 'EVEN_WEEKS', 'anna')])).toEqual({ reason: 'TEACHER_PAIRS', index: 0 });
    // Paired by length they fit.
    expect(teacherMisfitOf(twoLengths, [row(80, 'ODD_WEEKS', 'anna'), row(80, 'EVEN_WEEKS', 'anna')])).toBeNull();
    // And the count is per length too: two 40 rows of Anna's, though Anna has two lessons, are one more than her one 40.
    expect(teacherMisfitOf(twoLengths, [row(40, 'ALL_WEEKS', 'anna'), row(40, 'ALL_WEEKS', 'anna')])).toEqual({ reason: 'TEACHER_COUNT', index: 1 });
  });

  it('reads an odd-weeks post’s rows as one lesson each', () => {
    const odd = shared({ recurrence: 'ODD_WEEKS' });
    expect(teacherFitOf(odd, [row(60, 'ODD_WEEKS', 'bo')])).toBeNull();
    expect(teacherFitOf(odd, [row(60, 'ODD_WEEKS', 'bo'), row(60, 'ODD_WEEKS', 'bo')])).toBe('TEACHER_COUNT');
  });
});

describe('teacherPartsOf, teacherOfRow and placedTaughtOf', () => {
  it('counts each teacher’s lessons by length, the huvudlärare’s being what no share takes', () => {
    expect(teacherPartsOf(mixedShared())).toEqual(
      new Map([
        ['anna', new Map([[80, 1]])],
        ['bo', new Map([[40, 1]])],
      ]),
    );
    expect(teacherPartsOf(post())).toEqual(new Map([['anna', new Map([[60, 3]])]]));
  });

  it('reads the row’s own teacher on a shared post and the post’s otherwise', () => {
    expect(teacherOfRow(shared(), row(60, 'ALL_WEEKS', 'bo'))).toBe('bo');
    expect(teacherOfRow(post(), row(60, 'ALL_WEEKS', 'bo'))).toBe('anna');
    expect(teacherOfRow(post(), { minutes: 60, recurrence: 'ALL_WEEKS' })).toBe('anna');
  });

  it('places a pair as one lesson of the teacher both rows name, longest first and nobody last', () => {
    expect(
      placedTaughtOf(mixedShared(), [row(40, 'ALL_WEEKS', 'bo'), row(80, 'ODD_WEEKS', 'anna'), row(80, 'EVEN_WEEKS', 'anna')]),
    ).toEqual([
      { minutes: 80, teacherId: 'anna' },
      { minutes: 40, teacherId: 'bo' },
    ]);
    expect(placedTaughtOf(shared(), [row(60), row(60, 'ALL_WEEKS', 'bo')])).toEqual([
      { minutes: 60, teacherId: 'bo' },
      { minutes: 60, teacherId: null },
    ]);
    expect(placedTaughtOf(post(), [row(60)])).toEqual([{ minutes: 60, teacherId: 'anna' }]);
  });
});

describe('sharedPlacementsFitBesideLocks', () => {
  it('lets a lock of Bo’s answer Bo’s lesson, so Bo’s förläggning finds none left', () => {
    const locked = [{ minutes: 60, teacherId: 'bo' }];
    expect(sharedPlacementsFitBesideLocks(shared(), locked, [{ minutes: 60, teacherId: 'bo' }])).toBe(false);
    expect(sharedPlacementsFitBesideLocks(shared(), locked, [{ minutes: 60, teacherId: 'anna' }])).toBe(true);
    expect(sharedPlacementsFitBesideLocks(shared(), [], [{ minutes: 60, teacherId: 'bo' }])).toBe(true);
  });
});

describe('followPlacements: a change of teacher carries the förläggningar when it says where to', () => {
  const stored = (id: string, teacherId: string | null, minutes = 60, recurrence: PlacementShape['recurrence'] = 'ALL_WEEKS'): FollowedRow => ({
    id,
    teacherId,
    minutes,
    recurrence,
  });

  it('leaves a post that shares nothing before and after alone, as before', () => {
    expect(followPlacements(post(), post({ teacherId: 'carl' }), [stored('p1', null)])).toEqual({ ok: true, moves: [] });
    expect(followPlacements(post(), post({ teacherId: null }), [stored('p1', null)])).toEqual({ ok: true, moves: [] });
  });

  it('hands a share’s förläggning to the new teacher of the same lessons (Bo out, Carl in)', () => {
    const after = shared({ shares: [{ teacherId: 'carl', lessons: 1, minutes: 60 }] });
    expect(followPlacements(shared(), after, [stored('p1', 'bo'), stored('p2', 'anna')])).toEqual({
      ok: true,
      moves: [{ id: 'p1', teacherId: 'carl' }],
    });
  });

  it('hands the huvudlärare’s förläggningar to the new huvudlärare (the tillsättning, the staffing proposal)', () => {
    expect(followPlacements(shared(), shared({ teacherId: 'xena' }), [stored('p1', 'anna'), stored('p2', 'bo')])).toEqual({
      ok: true,
      moves: [{ id: 'p1', teacherId: 'xena' }],
    });
  });

  it('gives a removed teacher’s lesson to the teacher a share nobody teaches is given', () => {
    const before = shared({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    expect(followPlacements(before, shared({ shares: [{ teacherId: 'dan', lessons: 1, minutes: 60 }] }), [stored('p1', null)])).toEqual({
      ok: true,
      moves: [{ id: 'p1', teacherId: 'dan' }],
    });
  });

  it('names the huvudlärare on a post that starts to share, and nobody on one that stops', () => {
    expect(followPlacements(post(), shared(), [stored('p1', null)])).toEqual({ ok: true, moves: [{ id: 'p1', teacherId: 'anna' }] });
    expect(followPlacements(shared(), post(), [stored('p1', 'anna')])).toEqual({ ok: true, moves: [{ id: 'p1', teacherId: null }] });
  });

  it('stops a change it cannot settle and names the förläggning: two teachers in for one out', () => {
    const before = post({ lessonsPerWeek: 4, shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] });
    const after = post({
      lessonsPerWeek: 4,
      shares: [
        { teacherId: 'carl', lessons: 1, minutes: 60 },
        { teacherId: 'dan', lessons: 1, minutes: 60 },
      ],
    });
    const row = stored('p1', 'bo');
    expect(followPlacements(before, after, [stored('p0', 'anna'), row])).toEqual({ ok: false, reason: 'TEACHER', row, unstaffed: false, startsSharing: false });
  });

  it('is a change of teacher only when exactly one teacher leaves and exactly one comes in: two out for one in, and one out for two in, are not (review of #298, LÅG-2)', () => {
    // Anna's two lessons and Bo's two, then both gone for Carl, who has two: Anna's lessons are the very ones Carl has, and still it is two teachers changed at once.
    const twoOut = followPlacements(
      post({ lessonsPerWeek: 4, shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] }),
      post({ lessonsPerWeek: 2, teacherId: 'carl' }),
      [stored('p1', 'anna')],
    );
    expect(twoOut).toEqual({ ok: false, reason: 'TEACHER', row: stored('p1', 'anna'), unstaffed: false, startsSharing: false });
    // Anna's two lessons, then Carl's two and Dan's two: one out, two in, and Anna's förläggning is not Carl's for being the first of the two.
    const twoIn = followPlacements(
      post({ lessonsPerWeek: 2, teacherId: 'anna' }),
      post({ lessonsPerWeek: 4, teacherId: 'carl', shares: [{ teacherId: 'dan', lessons: 2, minutes: 60 }] }),
      [stored('p1', null)],
    );
    expect(twoIn).toEqual({ ok: false, reason: 'TEACHER', row: stored('p1', null), unstaffed: false, startsSharing: true });
  });

  it('says a refusal is a post starting to share only when it is TEACHER on a post that shared nothing before (review of #298, LÅG-3 of the second round)', () => {
    // Anna keeps the post and gives Bo one of three lessons: three förläggningar are one too many for Anna's two (TEACHER_COUNT, not the two steps' reason).
    const count = followPlacements(post(), shared(), [stored('p1', null), stored('p2', null), stored('p3', null)]);
    expect(count).toMatchObject({ ok: false, reason: 'TEACHER_COUNT', startsSharing: false });
    // A post that shared before and loses its huvudlärare's lesson to two new ones: TEACHER, but not a post that starts to share.
    expect(followPlacements(shared(), post({ teacherId: 'carl', shares: [{ teacherId: 'dan', lessons: 1, minutes: 60 }] }), [stored('p1', 'anna')])).toMatchObject({
      ok: false,
      reason: 'TEACHER',
      startsSharing: false,
    });
  });

  it('stops a share removed under its förläggning, and a share whose new teacher has other lessons', () => {
    const row = stored('p1', 'bo');
    expect(followPlacements(shared(), post(), [row])).toEqual({ ok: false, reason: 'TEACHER', row, unstaffed: false, startsSharing: false });
    // Bo's one 60 becomes Carl's two: not the same lessons, so not a change of teacher alone.
    const after = post({ lessonsPerWeek: 4, shares: [{ teacherId: 'carl', lessons: 2, minutes: 60 }] });
    expect(followPlacements(shared({ lessonsPerWeek: 4 }), after, [row])).toEqual({ ok: false, reason: 'TEACHER', row, unstaffed: false, startsSharing: false });
  });

  it('never makes a lesson nobody’s: a share’s teacher taken away, or the huvudlärare cleared', () => {
    const row = stored('p1', 'bo');
    expect(followPlacements(shared(), shared({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] }), [row])).toEqual({
      ok: false,
      reason: 'NO_TEACHER',
      row,
      unstaffed: false,
      startsSharing: false,
    });
    const lead = stored('p2', 'anna');
    expect(followPlacements(shared(), shared({ teacherId: null }), [lead])).toEqual({ ok: false, reason: 'NO_TEACHER', row: lead, unstaffed: false, startsSharing: false });
  });

  it('keeps a lesson that was nobody’s where it is while nobody’s lessons are left', () => {
    const before = shared({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    expect(followPlacements(before, { ...before, lessonsPerWeek: 4 }, [stored('p1', null)])).toEqual({ ok: true, moves: [] });
  });

  it('stops a teacher who stays with fewer lessons, or without the length, than are placed', () => {
    const two = [stored('p1', 'anna'), stored('p2', 'anna')];
    // Bo takes a second lesson from Anna's two: Anna keeps one.
    expect(followPlacements(shared(), shared({ shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] }), two)).toEqual({
      ok: false,
      reason: 'TEACHER_COUNT',
      row: two[1],
      unstaffed: false,
      startsSharing: false,
    });
    // Bo's 40 becomes an 80 on a post of 80 + 80 + 40 where Anna keeps the 40 and an 80.
    const before = post({ lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [80, 80, 40], shares: [{ teacherId: 'bo', lessons: 1, minutes: 40 }] });
    const after = { ...before, shares: [{ teacherId: 'bo', lessons: 1, minutes: 80 }] };
    const row = stored('p1', 'bo', 40);
    expect(followPlacements(before, after, [row])).toEqual({ ok: false, reason: 'TEACHER_LENGTH', row, unstaffed: false, startsSharing: false });
  });

  it('keeps two teachers who swap their parts as they are, by person', () => {
    const before = post({ lessonsPerWeek: 3, shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] });
    const after = post({ lessonsPerWeek: 3, teacherId: 'bo', shares: [{ teacherId: 'anna', lessons: 1, minutes: 60 }] });
    expect(followPlacements(before, after, [stored('p1', 'anna'), stored('p2', 'bo')])).toEqual({ ok: true, moves: [] });
    const a1 = stored('p1', 'anna');
    expect(followPlacements(before, after, [a1, stored('p3', 'anna')])).toEqual({
      ok: false,
      reason: 'TEACHER_COUNT',
      row: stored('p3', 'anna'),
      unstaffed: false,
      startsSharing: false,
    });
  });

  // Review of #298, MEDEL-3: "nobody's because the teacher was removed" is only a row naming nobody on a post that shared already.
  it('calls a refused row unstaffed only when it names nobody on a post that shared its lessons before the change', () => {
    // Anna's three on a post that shares nothing, two placed (NULL, the post's teacher's); Bo is given two: Anna keeps one.
    const starts = followPlacements(post(), post({ shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] }), [stored('p1', null), stored('p2', null)]);
    expect(starts).toMatchObject({ ok: false, reason: 'TEACHER_COUNT', unstaffed: false });
    // The same, with a new lead in the same change: nobody of before is left (TEACHER), and still nobody was removed.
    const swaps = followPlacements(post(), shared({ teacherId: 'xena', shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] }), [stored('p1', null)]);
    expect(swaps).toMatchObject({ ok: false, reason: 'TEACHER', unstaffed: false });
    // A post with no lead that shares nothing: its rows are nobody's, and not because anybody was removed.
    const noLead = followPlacements(post({ teacherId: null }), post({ teacherId: null, shares: [{ teacherId: 'bo', lessons: 2, minutes: 60 }] }), [stored('p1', null), stored('p2', null)]);
    expect(noLead).toMatchObject({ ok: false, reason: 'TEACHER_COUNT', unstaffed: false });
    // A shared post whose share's teacher was removed (the row is NULL): the change leaves no lesson nobody teaches.
    const removed = shared({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    const gone = followPlacements(removed, shared({ shares: [{ teacherId: 'dan', lessons: 1, minutes: 60 }], teacherId: 'xena' }), [stored('p1', null)]);
    expect(gone).toMatchObject({ ok: false, reason: 'TEACHER', unstaffed: true });
    const fewer = followPlacements(removed, { ...removed, lessonsPerWeek: 2, shares: [{ teacherId: null, lessons: 1, minutes: 60 }] }, [stored('p1', null), stored('p2', null)]);
    expect(fewer).toMatchObject({ ok: false, reason: 'TEACHER_COUNT', unstaffed: true });
  });

  it('flags exactly the rows naming nobody on a post that shared before, over many random changes', () => {
    let seed = 298;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    let refused = 0;
    let wrong = 0;
    for (let i = 0; i < 3000; i += 1) {
      const lessons = 2 + Math.floor(next() * 3);
      const wasShared = next() < 0.5;
      const lead = pick(['anna', null] as const);
      const shares = wasShared ? [{ teacherId: pick(['bo', null] as const), lessons: 1, minutes: 60 }] : [];
      const before = post({ lessonsPerWeek: lessons, teacherId: lead, shares });
      const placed = Math.max(1, Math.floor(next() * lessons));
      const rows = Array.from({ length: placed }, (_, k) =>
        stored(`p${k}`, wasShared ? (k === 0 && shares[0] ? shares[0].teacherId : lead) : null),
      );
      const after = post({
        lessonsPerWeek: pick([lessons, Math.max(2, lessons - 1)]),
        teacherId: pick([lead, 'xena', null] as const),
        shares: next() < 0.7 ? [{ teacherId: pick(['bo', 'carl', null] as const), lessons: pick([1, 2]), minutes: 60 }] : [],
      });
      const follow = followPlacements(before, after, rows);
      if (follow.ok) continue;
      refused += 1;
      if (follow.unstaffed !== (wasShared && follow.row.teacherId === null)) wrong += 1;
    }
    expect(refused).toBeGreaterThan(100);
    expect(wrong).toBe(0);
  });

  it('answers no rows with nothing to do', () => {
    expect(followPlacements(shared(), post(), [])).toEqual({ ok: true, moves: [] });
  });
});
