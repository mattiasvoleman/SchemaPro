import {
  ANY_ROOM,
  PLACEMENT_CANNOT_STAND,
  PLACEMENTS_REFUSED_SUMMARY,
  lockedRowsOf,
  pinnedPlacesOf,
  pinnedRowsOf,
  placedLessonRowsOf,
  placedLessonWritesOf,
  placedMinutesOf,
  placedTaughtByPost,
  placementsKeyOf,
  placementsRefusalOf,
  storedPlacementsOf,
  withoutPlaced,
  withoutPlacedShared,
  writtenFromPins,
  type PlacedLessonRow,
  type PlacedPost,
  type PlacementRead,
} from './placed-lessons';

const at = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);

const POST: PlacedPost = {
  id: 'post-7a-idrott',
  subjectId: 'idrott',
  studentGroupId: '7a',
  teacherId: 'ulf',
  coTeacherId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: new Date('2027-01-15T00:00:00.000Z'),
};
const posts = new Map([[POST.id, POST]]);

const read = (overrides: Partial<PlacementRead> = {}): PlacementRead => ({
  id: 'row-1',
  requirementId: POST.id,
  dayOfWeek: 2,
  startTime: at('10:00'),
  minutes: 60,
  roomId: 'hall',
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  ...overrides,
});
/** 7A's matematik: Ulf's two lessons of 60, Bo's one. */
const SHARED: PlacedPost = {
  ...POST,
  id: 'post-7a-ma',
  subjectId: 'ma',
  shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }],
};
const sharedPosts = new Map([[SHARED.id, SHARED]]);

describe('placedLessonRowsOf', () => {
  it('turns a förläggning into its post’s lesson at the row’s day, clock and room, with the post’s window', () => {
    expect(placedLessonRowsOf([read()], posts)).toEqual([
      {
        id: 'row-1',
        requirementId: POST.id,
        subjectId: 'idrott',
        studentGroupId: '7a',
        teacherId: 'ulf',
        coTeacherId: null,
        roomId: 'hall',
        dayOfWeek: 2,
        startTime: at('10:00'),
        endTime: at('11:00'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: POST.endDate,
        minutes: 60,
        extraGroups: [],
        participants: [],
        ownTeacher: false,
        placementTeacherId: null,
      },
    ]);
  });

  it('makes a shared post’s förläggning its own teacher’s lesson, with the post’s medlärare as before', () => {
    const coTaught = new Map([[SHARED.id, { ...SHARED, coTeacherId: 'kim' }]]);
    const [row] = placedLessonRowsOf([read({ requirementId: SHARED.id, teacherId: 'bo' })], coTaught);
    expect(row).toMatchObject({ teacherId: 'bo', coTeacherId: 'kim', ownTeacher: true, placementTeacherId: 'bo' });
    // A removed teacher's lesson stands, nobody's.
    const [nobody] = placedLessonRowsOf([read({ requirementId: SHARED.id, teacherId: null })], sharedPosts);
    expect(nobody).toMatchObject({ teacherId: null, ownTeacher: true });
  });

  it('leaves out a row whose post was not read, and orders the rest by post, day, clock and id', () => {
    const rows = placedLessonRowsOf(
      [
        read({ id: 'c', dayOfWeek: 3 }),
        read({ id: 'b', dayOfWeek: 2, startTime: at('13:00') }),
        read({ id: 'a', dayOfWeek: 2 }),
        read({ id: 'z', dayOfWeek: 2 }),
        read({ id: 'gone', requirementId: 'post-deleted' }),
      ],
      posts,
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'z', 'b', 'c']);
  });
});

describe('placedMinutesOf and withoutPlaced', () => {
  it('counts a pair of odd and even rows as one lesson of the post', () => {
    const rows = placedLessonRowsOf(
      [read({ id: 'odd', recurrence: 'ODD_WEEKS' }), read({ id: 'even', dayOfWeek: 4, recurrence: 'EVEN_WEEKS' })],
      posts,
    );
    expect(placedMinutesOf(rows, posts)).toEqual(new Map([[POST.id, [60]]]));
  });

  it('knows no post it was not given', () => {
    const rows = placedLessonRowsOf([read()], posts);
    expect(placedMinutesOf(rows, new Map())).toEqual(new Map());
  });

  it('takes each placed length off exactly, and nothing for a length that is not left', () => {
    expect(withoutPlaced([80, 40, 40], [40])).toEqual([80, 40]);
    expect(withoutPlaced([80], [40])).toEqual([80]);
  });
});

describe('placedTaughtByPost and withoutPlacedShared (delade lektioner)', () => {
  it('reads each shared post’s förläggningar as its teachers’ lessons, a pair once, and no post that shares nothing', () => {
    const rows = placedLessonRowsOf(
      [
        read({ id: 'odd', requirementId: SHARED.id, recurrence: 'ODD_WEEKS', teacherId: 'bo' }),
        read({ id: 'even', requirementId: SHARED.id, dayOfWeek: 4, recurrence: 'EVEN_WEEKS', teacherId: 'bo' }),
        read({ id: 'plain' }),
      ],
      new Map([...posts, ...sharedPosts]),
    );
    expect(placedTaughtByPost(rows, new Map([...posts, ...sharedPosts]))).toEqual(
      new Map([[SHARED.id, [{ minutes: 60, teacherId: 'bo' }]]]),
    );
  });

  it('takes Bo’s förläggning off Bo’s lesson and never off Ulf’s, in the post’s order', () => {
    const lessons = [
      { minutes: 60, teacherId: 'ulf' },
      { minutes: 60, teacherId: 'ulf' },
      { minutes: 60, teacherId: 'bo' },
    ];
    expect(withoutPlacedShared(lessons, [{ minutes: 60, teacherId: 'bo' }])).toEqual(lessons.slice(0, 2));
    expect(withoutPlacedShared(lessons, [{ minutes: 60, teacherId: 'ulf' }])).toEqual([lessons[1], lessons[2]]);
    // Nothing of its own left: nothing is taken (the judge refused it as OVER_DEMAND before).
    expect(withoutPlacedShared(lessons.slice(0, 2), [{ minutes: 60, teacherId: 'bo' }])).toEqual(lessons.slice(0, 2));
  });

  // Review of #298, MEDEL-2 (mutant PL5: the length left out of the match).
  it('takes the exact length too: a placed 40 of Bo’s leaves Bo’s 60 and Ulf’s lessons, a placed 60 of Bo’s leaves his 40', () => {
    const lessons = [
      { minutes: 80, teacherId: 'ulf' },
      { minutes: 60, teacherId: 'ulf' },
      { minutes: 60, teacherId: 'bo' },
      { minutes: 40, teacherId: 'bo' },
    ];
    expect(withoutPlacedShared(lessons, [{ minutes: 40, teacherId: 'bo' }])).toEqual(lessons.slice(0, 3));
    expect(withoutPlacedShared(lessons, [{ minutes: 60, teacherId: 'bo' }])).toEqual([lessons[0], lessons[1], lessons[3]]);
  });
});

describe('placementsRefusalOf', () => {
  const rows = placedLessonRowsOf([read(), read({ id: 'row-2', dayOfWeek: 4 })], posts);
  const anon = { requirement: (id: string) => `anon:${id}`, room: (id: string) => `anon:${id}` };

  it('is null when every förläggning stands', () => {
    expect(placementsRefusalOf(rows, [{ index: 0, ok: true }, { index: 1, ok: true }], anon)).toBeNull();
  });

  it('names each one that cannot stand, in the payload’s ids, under one summary', () => {
    const refusal = placementsRefusalOf(
      rows,
      [
        { index: 0, ok: true },
        {
          index: 1,
          ok: false,
          reason: 'TEACHER',
          params: { otherKind: 'LESSON', className: '8B', subjectName: 'Matematik', day: 4, start: '10:30', end: '11:30' },
        },
      ],
      anon,
    );
    expect(refusal).toMatchObject({ summaryCode: PLACEMENTS_REFUSED_SUMMARY, summaryParams: { count: 1 } });
    expect(refusal!.conflicts).toEqual([
      expect.objectContaining({
        category: 'PLACEMENT',
        code: PLACEMENT_CANNOT_STAND,
        requirementIds: [`anon:${POST.id}`],
        roomIds: ['anon:hall'],
        params: {
          requirement: `anon:${POST.id}`,
          room: 'anon:hall',
          day: 4,
          start: '10:00',
          end: '11:00',
          reason: 'TEACHER',
          // The lesson it meets, as one phrase; its clock is not the row's.
          other: '8B Matematik',
        },
      }),
    ]);
  });

  it('carries a reservation’s resource and the other schools, and nothing it was not given', () => {
    const refusal = placementsRefusalOf(
      rows,
      [
        { index: 0, ok: false, reason: 'AVAILABILITY', params: { resource: 'ROOM' } },
        { index: 1, ok: false, reason: 'OTHER_SCHOOL', params: { schools: 'Ekskolan, Granskolan' } },
      ],
      anon,
    );
    expect(refusal!.conflicts[0]!.params).toMatchObject({ resource: 'ROOM', start: '10:00' });
    expect(refusal!.conflicts[0]!.params).not.toHaveProperty('other');
    expect(refusal!.conflicts[1]!.params).toMatchObject({ schools: 'Ekskolan, Granskolan' });
  });

  it('says UNKNOWN for a refusal without a reason and skips a verdict for a row it does not have', () => {
    const refusal = placementsRefusalOf(rows, [{ index: 0, ok: false }, { index: 9, ok: false }], anon);
    expect(refusal!.summaryParams).toEqual({ count: 2 });
    expect(refusal!.conflicts.map((line) => line.params?.['reason'])).toEqual(['UNKNOWN']);
  });
});

describe('placedLessonWritesOf', () => {
  const rows = placedLessonRowsOf([read()], posts);
  const ids = { schoolId: 'school', academicYearId: 'year' };

  it('writes the lesson locked and as the run’s own, with the post as the write reads it', () => {
    const now = { teacherId: 'vera', coTeacherId: 'kim', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: null };
    expect(placedLessonWritesOf(rows, new Map([[POST.id, now]]), ids)).toEqual([
      {
        schoolId: 'school',
        academicYearId: 'year',
        subjectId: 'idrott',
        studentGroupId: '7a',
        teacherId: 'vera',
        coTeacherId: 'kim',
        roomId: 'hall',
        dayOfWeek: 2,
        startTime: at('10:00'),
        endTime: at('11:00'),
        recurrence: 'ALL_WEEKS',
        startDate: now.startDate,
        endDate: null,
        isGenerated: true,
        isLocked: true,
        fromPlacement: true,
      },
    ]);
  });

  it('writes a shared post’s förläggning with its own teacher, whoever the post’s lead is at the write', () => {
    const shared = placedLessonRowsOf([read({ requirementId: SHARED.id, teacherId: 'bo' })], sharedPosts);
    const now = { teacherId: 'vera', coTeacherId: 'kim', startDate: null, endDate: null };
    expect(placedLessonWritesOf(shared, new Map([[SHARED.id, now]]), ids)).toEqual([
      expect.objectContaining({ teacherId: 'bo', coTeacherId: 'kim', fromPlacement: true }),
    ]);
  });

  it('is null when a förläggning’s post is gone', () => {
    expect(placedLessonWritesOf(rows, new Map(), ids)).toBeNull();
  });
});

describe('placementsKeyOf', () => {
  it('is one string for one set in any order, and another when a row moves', () => {
    const a = read({ id: 'a' });
    const b = read({ id: 'b', dayOfWeek: 4 });
    expect(placementsKeyOf([a, b])).toBe(placementsKeyOf([b, a]));
    expect(placementsKeyOf([a, b])).not.toBe(placementsKeyOf([a, { ...b, startTime: at('13:00') }]));
    // Every field a write writes from: the room and the weeks too, so a
    // förläggning given another room or weeks while the solver ran is stale.
    expect(placementsKeyOf([a, b])).not.toBe(placementsKeyOf([a, { ...b, roomId: 'pool' }]));
    expect(placementsKeyOf([a, b])).not.toBe(placementsKeyOf([a, { ...b, recurrence: 'ODD_WEEKS' }]));
    expect(placementsKeyOf([a, b])).not.toBe(placementsKeyOf([a, { ...b, minutes: 40 }]));
    // Delade lektioner: a förläggning handed to another teacher while the solver ran.
    expect(placementsKeyOf([a, b])).not.toBe(placementsKeyOf([a, { ...b, teacherId: 'bo' }]));
    expect(placementsKeyOf([])).toBe('');
  });

  it('compares a run’s rows by the stored column, not by the teacher a post that shares nothing lends them', () => {
    const stored = [read({ id: 'a' }), read({ id: 's', requirementId: SHARED.id, teacherId: 'bo' })];
    const rows = placedLessonRowsOf(stored, new Map([...posts, ...sharedPosts]));
    expect(rows.find((row) => row.id === 'a')!.teacherId).toBe('ulf');
    expect(placementsKeyOf(storedPlacementsOf(rows))).toBe(placementsKeyOf(stored));
  });
});


/*
 * FÖRLÄGGNING UTAN SAL (20270213090000): a row with no room is a pinned lesson of its post, no lock.
 */
describe('lockedRowsOf and pinnedRowsOf', () => {
  it('tell a lock (a room) from a pinned lesson (none) and lose no row between them', () => {
    const rows = placedLessonRowsOf(
      [read({ id: 'a', roomId: 'hall' }), read({ id: 'b', roomId: null, dayOfWeek: 3 }), read({ id: 'c', roomId: 'gym', dayOfWeek: 4 })],
      posts,
    );
    expect(lockedRowsOf(rows).map((row) => row.id)).toEqual(['a', 'c']);
    expect(pinnedRowsOf(rows).map((row) => row.id)).toEqual(['b']);
    expect(lockedRowsOf(rows).length + pinnedRowsOf(rows).length).toBe(rows.length);
  });

  it('reads a row with no room as a lesson with none, on the post’s window', () => {
    const [row] = placedLessonRowsOf([read({ roomId: null })], posts);
    expect(row).toMatchObject({ roomId: null, dayOfWeek: 2, endDate: POST.endDate, ownTeacher: false });
  });
});

describe('pinnedPlacesOf', () => {
  const lessons = (...minutes: number[]) => minutes.map((m) => ({ minutes: m, teacherId: 'ulf' as string | null }));
  const pinned = (overrides: Partial<PlacementRead> = {}) => placedLessonRowsOf([read({ roomId: null, ...overrides })], posts);

  it('puts a pinned lesson at its length’s place, with the clock the payload carries and its end as start plus length', () => {
    expect(pinnedPlacesOf(lessons(60, 60), pinned())).toEqual({
      places: [{ dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00' }, null],
      unplaced: [],
    });
  });

  it('takes the place of the row’s own length in the engine’s order, longest first', () => {
    // 1 × 80 and 2 × 40: a pinned 40 is the second place, not the first.
    expect(pinnedPlacesOf(lessons(80, 40, 40), pinned({ minutes: 40 })).places).toEqual([
      null,
      { dayOfWeek: 2, startTime: '10:00:00', endTime: '10:40:00' },
      null,
    ]);
    expect(pinnedPlacesOf(lessons(80, 40, 40), pinned({ minutes: 80 })).places).toEqual([
      { dayOfWeek: 2, startTime: '10:00:00', endTime: '11:20:00' },
      null,
      null,
    ]);
  });

  it('gives two rows of one length two places, in the order the rows come, and none the same place twice', () => {
    const rows = placedLessonRowsOf(
      [read({ id: 'a', roomId: null, dayOfWeek: 1 }), read({ id: 'b', roomId: null, dayOfWeek: 3, startTime: at('08:05') })],
      posts,
    );
    expect(pinnedPlacesOf(lessons(60, 60, 60), rows).places).toEqual([
      { dayOfWeek: 1, startTime: '10:00:00', endTime: '11:00:00' },
      { dayOfWeek: 3, startTime: '08:05:00', endTime: '09:05:00' },
      null,
    ]);
  });

  it('has exactly as many places as the entry has lessons, null where the engine places the lesson', () => {
    const { places } = pinnedPlacesOf(lessons(60, 60, 60, 60), pinned());
    expect(places).toHaveLength(4);
    expect(places!.filter((place) => place === null)).toHaveLength(3);
  });

  it('says nothing when nothing is pinned: no key at all, never a list of nulls, which the engine refuses', () => {
    expect(pinnedPlacesOf(lessons(60, 60), [])).toEqual({ places: undefined, unplaced: [] });
  });

  it('leaves a row with no lesson of its length unplaced and pins nothing on another length’s place', () => {
    const row = pinned({ minutes: 45 });
    expect(pinnedPlacesOf(lessons(60, 60), row)).toEqual({ places: undefined, unplaced: row });
    // Two rows, one place of the length: the second finds none.
    const two = placedLessonRowsOf([read({ id: 'a', roomId: null }), read({ id: 'b', roomId: null, dayOfWeek: 4 })], posts);
    const { places, unplaced } = pinnedPlacesOf(lessons(60, 40), two);
    expect(places).toEqual([{ dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00' }, null]);
    expect(unplaced.map((row) => row.id)).toEqual(['b']);
  });

  it('on a shared post takes the place of the row’s own teacher and length, never another teacher’s', () => {
    const shared = [
      { minutes: 60, teacherId: 'ulf' as string | null },
      { minutes: 60, teacherId: 'ulf' as string | null },
      { minutes: 60, teacherId: 'bo' as string | null },
    ];
    const [bo] = placedLessonRowsOf([read({ requirementId: SHARED.id, roomId: null, teacherId: 'bo' })], sharedPosts);
    expect(pinnedPlacesOf(shared, [bo!]).places).toEqual([null, null, { dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00' }]);
    const [ulf] = placedLessonRowsOf([read({ requirementId: SHARED.id, roomId: null, teacherId: 'ulf' })], sharedPosts);
    expect(pinnedPlacesOf(shared, [ulf!]).places).toEqual([{ dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00' }, null, null]);
    // Bo has no lesson of 40: his pinned 40 is unplaced, and Ulf's 60s are not taken for it.
    const [bo40] = placedLessonRowsOf([read({ requirementId: SHARED.id, roomId: null, teacherId: 'bo', minutes: 40 })], sharedPosts);
    expect(pinnedPlacesOf(shared, [bo40!])).toEqual({ places: undefined, unplaced: [bo40] });
  });

  it('a lesson nobody teaches is pinned by the row that names nobody', () => {
    const lessonsOfNobody = [{ minutes: 60, teacherId: null as string | null }, { minutes: 60, teacherId: 'ulf' as string | null }];
    const [row] = placedLessonRowsOf([read({ requirementId: SHARED.id, roomId: null, teacherId: null })], sharedPosts);
    expect(pinnedPlacesOf(lessonsOfNobody, [row!]).places).toEqual([{ dayOfWeek: 2, startTime: '10:00:00', endTime: '11:00:00' }, null]);
  });
});

describe('writtenFromPins', () => {
  const pin = (overrides: Partial<PlacementRead> = {}): PlacedLessonRow =>
    placedLessonRowsOf([read({ roomId: null, ...overrides })], posts)[0]!;
  const engineLesson = (overrides: Partial<{ requirementId: string | null; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string; teacherId: string | null }> = {}) => ({
    requirementId: POST.id,
    roomId: 'sal-9',
    dayOfWeek: 2,
    startTime: '10:00:00',
    endTime: '11:00:00',
    ...overrides,
  });

  it('knows the lesson of the answer by post, weekday, start and length, and writes the row with the room the engine chose', () => {
    const answer = [engineLesson({ dayOfWeek: 1, startTime: '08:00:00', endTime: '09:00:00', roomId: 'sal-1' }), engineLesson()];
    const { rest, pinned, missing } = writtenFromPins([pin()], answer);
    expect(missing).toEqual([]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ id: 'row-1', roomId: 'sal-9', dayOfWeek: 2, minutes: 60 });
    expect(rest).toEqual([answer[0]]);
  });

  it('reads a stored candidate’s HH:MM as it reads the engine’s HH:MM:SS', () => {
    const { pinned, missing } = writtenFromPins([pin()], [engineLesson({ startTime: '10:00', endTime: '11:00' })]);
    expect(missing).toEqual([]);
    expect(pinned[0]!.roomId).toBe('sal-9');
  });

  it.each([
    ['another post', { requirementId: 'other' }],
    ['another weekday', { dayOfWeek: 3 }],
    ['another start', { startTime: '10:05:00', endTime: '11:05:00' }],
    ['another length', { endTime: '10:45:00' }],
  ])('does not take a lesson of %s for the pinned one: the row is missing from the answer', (_name, change) => {
    const answer = [engineLesson(change)];
    const { rest, pinned, missing } = writtenFromPins([pin()], answer);
    expect(pinned).toEqual([]);
    expect(missing.map((row) => row.id)).toEqual(['row-1']);
    expect(rest).toEqual(answer);
  });

  it('leaves a lesson on the same weekday and start of another post to the engine', () => {
    const { rest, pinned } = writtenFromPins([pin()], [engineLesson({ requirementId: 'other' }), engineLesson()]);
    expect(pinned).toHaveLength(1);
    expect(rest).toEqual([engineLesson({ requirementId: 'other' })]);
  });

  it('on a shared post takes the lesson of the row’s own teacher, and not a lesson of the same hour of another', () => {
    const bo = placedLessonRowsOf([read({ requirementId: SHARED.id, roomId: null, teacherId: 'bo' })], sharedPosts)[0]!;
    const wrong = engineLesson({ requirementId: SHARED.id, teacherId: 'ulf', roomId: 'sal-1' });
    const right = engineLesson({ requirementId: SHARED.id, teacherId: 'bo', roomId: 'sal-2' });
    const { pinned, rest, missing } = writtenFromPins([bo], [wrong, right]);
    expect(missing).toEqual([]);
    expect(pinned[0]).toMatchObject({ teacherId: 'bo', roomId: 'sal-2' });
    expect(rest).toEqual([wrong]);
    expect(writtenFromPins([bo], [wrong]).missing).toHaveLength(1);
  });

  it('writes a lesson the engine gave no room with none (a room is the engine’s to choose, and it may find none)', () => {
    expect(writtenFromPins([pin()], [engineLesson({ roomId: null })]).pinned[0]!.roomId).toBeNull();
  });

  it('gives each of two rows its own lesson and leaves the rest', () => {
    const rows = placedLessonRowsOf([read({ id: 'a', roomId: null, dayOfWeek: 1 }), read({ id: 'b', roomId: null, dayOfWeek: 3 })], posts);
    const answer = [engineLesson({ dayOfWeek: 3, roomId: 'sal-3' }), engineLesson({ dayOfWeek: 5 }), engineLesson({ dayOfWeek: 1, roomId: 'sal-1' })];
    const { pinned, rest, missing } = writtenFromPins(rows, answer);
    expect(missing).toEqual([]);
    expect(pinned.map((row) => [row.id, row.roomId])).toEqual([['a', 'sal-1'], ['b', 'sal-3']]);
    expect(rest).toEqual([answer[1]]);
  });

  it('is written as a lock marked as the run’s own, in the engine’s room, by the one writer of a förläggning', () => {
    const { pinned } = writtenFromPins([pin()], [engineLesson()]);
    expect(placedLessonWritesOf(pinned, new Map([[POST.id, POST]]), { schoolId: 's', academicYearId: 'y' })).toEqual([
      expect.objectContaining({ roomId: 'sal-9', dayOfWeek: 2, isLocked: true, isGenerated: true, fromPlacement: true, studentGroupId: '7a', subjectId: 'idrott', teacherId: 'ulf' }),
    ]);
  });
});

describe('no room in the refusal and in the key', () => {
  it('names a refused row with no room as ANY_ROOM, in no room’s id, and lists no room under it', () => {
    const [row] = placedLessonRowsOf([read({ roomId: null })], posts);
    const refusal = placementsRefusalOf([row!], [{ index: 0, ok: false, reason: 'TEACHER', params: { className: '7B', subjectName: 'Matematik' } }], {
      requirement: (id) => `anon-${id}`,
      room: () => {
        throw new Error('a row with no room has no room to name');
      },
    });
    expect(refusal!.conflicts[0]).toMatchObject({
      code: PLACEMENT_CANNOT_STAND,
      params: { requirement: 'anon-post-7a-idrott', room: ANY_ROOM, day: 2, start: '10:00', end: '11:00', reason: 'TEACHER', other: '7B Matematik' },
      roomIds: [],
    });
  });

  it('reads a row with no room as part of the key, and another key for the same row given a room', () => {
    const [none] = placedLessonRowsOf([read({ roomId: null })], posts);
    const [some] = placedLessonRowsOf([read({ roomId: 'hall' })], posts);
    expect(placementsKeyOf(storedPlacementsOf([none!]))).not.toBe(placementsKeyOf(storedPlacementsOf([some!])));
    // Stable, and never the word null.
    expect(placementsKeyOf(storedPlacementsOf([none!]))).toBe(placementsKeyOf(storedPlacementsOf([none!])));
    expect(placementsKeyOf(storedPlacementsOf([none!]))).not.toContain('null');
  });
});
