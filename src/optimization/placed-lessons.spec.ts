import {
  ANY_ROOM,
  NO_BLOCK,
  PLACEMENT_CANNOT_STAND,
  PLACEMENTS_REFUSED_SUMMARY,
  blockPlacedLessonRowsOf,
  blockPlacementsKeyOf,
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
  type BlockMemberPlaced,
  type BlockPlacementRead,
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
          // Not a block's lesson: the value the web's sentence chooses its words on (NO_BLOCK).
          block: 'NO_BLOCK',
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

/*
 * FÖRLAGDA BLOCK (20270218090000): a block's förläggning is one pinned lesson of every member, with a room or none.
 * C1 of the grafisk förläggning: the rows (blockPlacedLessonRowsOf), the line between a lock and a pin that now reads
 * a marker and not the room alone, the room in a pin's place, the key of the block's own rows and the refusal that
 * names the block.
 */
const BLOCK = 'block-sprakval';
const OTHER_BLOCK = 'block-other';

const blockMember = (id: string, overrides: Partial<BlockMemberPlaced> = {}): BlockMemberPlaced => ({
  id,
  subjectId: `subject-${id}`,
  studentGroupId: `group-${id}`,
  teacherId: `teacher-${id}`,
  coTeacherId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  // TB409: every member has the same lessons, here two of an hour.
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  shares: [],
  blockId: BLOCK,
  ...overrides,
});

const blockRead = (overrides: Partial<BlockPlacementRead> = {}): BlockPlacementRead => ({
  id: 'bp-1',
  blockId: BLOCK,
  dayOfWeek: 3,
  startTime: at('10:00'),
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  block: { sameTimesAsBlockId: null },
  rooms: [],
  ...overrides,
});

const trio = (overrides: Partial<BlockMemberPlaced> = {}) => ['m-a', 'm-b', 'm-c'].map((id) => blockMember(id, overrides));

describe('blockPlacedLessonRowsOf', () => {
  it('reads one lesson of a block as one pinned row per member: the derived id, the post’s own fields and the room the member chose', () => {
    const rows = blockPlacedLessonRowsOf([blockRead({ rooms: [{ requirementId: 'm-b', roomId: 'sal-2' }] })], trio());

    expect(rows.map((row) => row.id)).toEqual(['bp-1:m-a', 'bp-1:m-b', 'bp-1:m-c']);
    expect(rows.map((row) => row.roomId)).toEqual([null, 'sal-2', null]);
    expect(rows[0]).toEqual({
      id: 'bp-1:m-a',
      requirementId: 'm-a',
      subjectId: 'subject-m-a',
      studentGroupId: 'group-m-a',
      teacherId: 'teacher-m-a',
      coTeacherId: null,
      roomId: null,
      dayOfWeek: 3,
      startTime: at('10:00'),
      endTime: at('11:00'),
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      minutes: 60,
      extraGroups: [],
      participants: [],
      ownTeacher: false,
      placementTeacherId: null,
      blockPlacementId: 'bp-1',
      blockId: BLOCK,
      blockFit: null,
    });
  });

  it('takes the teacher, the medlärare and the window from each member’s own post, and the weeks from the lesson', () => {
    const rows = blockPlacedLessonRowsOf(
      [blockRead({ recurrence: 'ODD_WEEKS', startTime: at('08:05'), minutes: 45 })],
      [
        blockMember('m-a', { teacherId: 'ulf', coTeacherId: 'kim', recurrence: 'ODD_WEEKS', minutesPerLesson: 45, endDate: POST.endDate }),
        blockMember('m-b', { teacherId: null, recurrence: 'ODD_WEEKS', minutesPerLesson: 45, startDate: new Date('2026-08-17T00:00:00.000Z') }),
      ],
    );

    expect(rows).toEqual([
      expect.objectContaining({ requirementId: 'm-a', teacherId: 'ulf', coTeacherId: 'kim', startDate: null, endDate: POST.endDate, recurrence: 'ODD_WEEKS', startTime: at('08:05'), endTime: at('08:50'), minutes: 45, blockFit: null }),
      expect.objectContaining({ requirementId: 'm-b', teacherId: null, coTeacherId: null, startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: null, recurrence: 'ODD_WEEKS', blockFit: null }),
    ]);
    // A member's teacher is the post's own and no förläggning column: nobody's row says a teacher of its own.
    expect(rows.every((row) => row.ownTeacher === false && row.placementTeacherId === null)).toBe(true);
  });

  it('orders the lessons by day, start and the lesson’s id, and the members of a lesson by id, whatever order they are given in', () => {
    const reads = [
      blockRead({ id: 'bp-d', dayOfWeek: 4 }),
      blockRead({ id: 'bp-a', dayOfWeek: 3, startTime: at('13:00') }),
      blockRead({ id: 'bp-z', dayOfWeek: 3, startTime: at('08:00') }),
      blockRead({ id: 'bp-b', dayOfWeek: 3, startTime: at('08:00') }),
    ];
    const four = trio({ lessonsPerWeek: 4 });
    const expected = ['bp-b', 'bp-z', 'bp-a', 'bp-d'].flatMap((lesson) => ['m-a', 'm-b', 'm-c'].map((member) => `${lesson}:${member}`));

    expect(blockPlacedLessonRowsOf(reads, four).map((row) => row.id)).toEqual(expected);
    expect(blockPlacedLessonRowsOf([...reads].reverse(), [...four].reverse()).map((row) => row.id)).toEqual(expected);
  });

  it('gives no row for a block with no member, a post in no block, a block the posts are not in, or no lesson', () => {
    expect(blockPlacedLessonRowsOf([blockRead()], [])).toEqual([]);
    expect(blockPlacedLessonRowsOf([blockRead()], trio({ blockId: null }))).toEqual([]);
    expect(blockPlacedLessonRowsOf([blockRead()], trio({ blockId: OTHER_BLOCK }))).toEqual([]);
    expect(blockPlacedLessonRowsOf([], trio())).toEqual([]);
  });

  it('gives each block’s lessons to that block’s members only', () => {
    const rows = blockPlacedLessonRowsOf(
      [blockRead(), blockRead({ id: 'bp-x', blockId: OTHER_BLOCK, dayOfWeek: 5 })],
      [...trio(), blockMember('x-1', { blockId: OTHER_BLOCK }), blockMember('x-2', { blockId: OTHER_BLOCK }), blockMember('loose', { blockId: null })],
    );

    expect(rows.map((row) => [row.blockId, row.id])).toEqual([
      [BLOCK, 'bp-1:m-a'],
      [BLOCK, 'bp-1:m-b'],
      [BLOCK, 'bp-1:m-c'],
      [OTHER_BLOCK, 'bp-x:x-1'],
      [OTHER_BLOCK, 'bp-x:x-2'],
    ]);
  });

  describe('a block whose lessons do not fit it (blockFitOf: a membership change left them wrong)', () => {
    const otherBlock = () => ({
      reads: [blockRead({ id: 'bp-x', blockId: OTHER_BLOCK, dayOfWeek: 5 })],
      members: [blockMember('x-1', { blockId: OTHER_BLOCK }), blockMember('x-2', { blockId: OTHER_BLOCK })],
    });

    it.each([
      ['LENGTH', [blockRead({ minutes: 50 })], trio()],
      ['WEEKS', [blockRead({ recurrence: 'ODD_WEEKS' })], trio()],
      ['COUNT', [blockRead({ id: 'bp-1' }), blockRead({ id: 'bp-2', dayOfWeek: 4 }), blockRead({ id: 'bp-3', dayOfWeek: 5 })], trio()],
      ['MEMBER', [blockRead({ rooms: [{ requirementId: 'stranger', roomId: 'sal-1' }] })], trio()],
      ['SHARES', [blockRead()], [blockMember('m-a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] }), blockMember('m-b'), blockMember('m-c')]],
      ['FOLLOWER', [blockRead({ block: { sameTimesAsBlockId: 'block-leader' } })], trio()],
    ] as const)('says %s on every row of the block, and nothing on another block that fits', (rule, reads, members) => {
      const other = otherBlock();

      const rows = blockPlacedLessonRowsOf([...reads, ...other.reads], [...members, ...other.members]);

      const ofBlock = rows.filter((row) => row.blockId === BLOCK);
      expect(ofBlock).toHaveLength(reads.length * members.length);
      expect(ofBlock.every((row) => row.blockFit === rule)).toBe(true);
      const ofOther = rows.filter((row) => row.blockId === OTHER_BLOCK);
      expect(ofOther).toHaveLength(2);
      expect(ofOther.every((row) => row.blockFit === null)).toBe(true);
    });

    it('holds a block of mixed lengths (80 + 40) to its own lengths and counts', () => {
      const mixed = ['m-a', 'm-b'].map((id) => blockMember(id, { minutesPerLesson: 80, lessonLengths: [80, 40] }));
      const fits = (minutes: number[]) =>
        blockPlacedLessonRowsOf(
          minutes.map((one, index) => blockRead({ id: `bp-${index}`, minutes: one, dayOfWeek: 1 + index })),
          mixed,
        ).map((row) => row.blockFit);

      expect(new Set(fits([80, 40]))).toEqual(new Set([null]));
      expect(new Set(fits([40]))).toEqual(new Set([null]));
      expect(new Set(fits([80, 80]))).toEqual(new Set(['COUNT']));
      expect(new Set(fits([40, 40]))).toEqual(new Set(['COUNT']));
      expect(new Set(fits([60]))).toEqual(new Set(['LENGTH']));
    });
  });
});

describe('lockedRowsOf and pinnedRowsOf on a block’s rows', () => {
  const ordinary = placedLessonRowsOf(
    [read({ id: 'with-room', roomId: 'hall' }), read({ id: 'no-room', roomId: null, dayOfWeek: 3 })],
    posts,
  );
  const block = blockPlacedLessonRowsOf(
    [blockRead({ rooms: [{ requirementId: 'm-a', roomId: 'sal-1' }] })],
    [blockMember('m-a'), blockMember('m-b')],
  );
  const all = [...ordinary, ...block];

  it('never locks a block’s row, with a room or without: a lock inside a block is a partly locked block', () => {
    expect(block.map((row) => row.roomId)).toEqual(['sal-1', null]);
    expect(lockedRowsOf(block)).toEqual([]);
    expect(pinnedRowsOf(block).map((row) => row.id)).toEqual(['bp-1:m-a', 'bp-1:m-b']);
  });

  it('still locks an ordinary row with a room and pins an ordinary row with none', () => {
    expect(lockedRowsOf(all).map((row) => row.id)).toEqual(['with-room']);
    expect(pinnedRowsOf(all).map((row) => row.id)).toEqual(['no-room', 'bp-1:m-a', 'bp-1:m-b']);
  });

  it('loses no row between them and puts none in both', () => {
    const locked = lockedRowsOf(all).map((row) => row.id);
    const pinned = pinnedRowsOf(all).map((row) => row.id);
    expect([...locked, ...pinned].sort()).toEqual(all.map((row) => row.id).sort());
    expect(locked.filter((id) => pinned.includes(id))).toEqual([]);
  });
});

describe('pinnedPlacesOf with the payload’s id of a room (a block’s pinned lesson)', () => {
  const rowsOf = (rooms: BlockPlacementRead['rooms'], minutes = 60) =>
    blockPlacedLessonRowsOf([blockRead({ rooms, minutes })], [blockMember('m-a')]);
  const lessons = (...minutes: number[]) => minutes.map((one) => ({ minutes: one, teacherId: 'teacher-m-a' as string | null }));

  it('says the room in the payload’s id of it beside the place', () => {
    const anonRoom = jest.fn((id: string) => `anon:${id}`);

    const { places, unplaced } = pinnedPlacesOf(lessons(60, 60), rowsOf([{ requirementId: 'm-a', roomId: 'sal-1' }]), anonRoom);

    expect(places).toEqual([{ dayOfWeek: 3, startTime: '10:00:00', endTime: '11:00:00', roomId: 'anon:sal-1' }, null]);
    expect(unplaced).toEqual([]);
    expect(anonRoom).toHaveBeenCalledTimes(1);
    expect(anonRoom).toHaveBeenCalledWith('sal-1');
  });

  it('names no room on a place whose row has none: no roomId key at all, and the room namer is never asked', () => {
    const anonRoom = jest.fn((id: string) => `anon:${id}`);

    const { places } = pinnedPlacesOf(lessons(60, 60), rowsOf([]), anonRoom);

    expect(Object.keys(places![0]!)).toEqual(['dayOfWeek', 'startTime', 'endTime']);
    expect(anonRoom).not.toHaveBeenCalled();
    // And a pin with no room needs no namer at all, as it never did.
    expect(pinnedPlacesOf(lessons(60, 60), rowsOf([])).places![0]).toEqual({ dayOfWeek: 3, startTime: '10:00:00', endTime: '11:00:00' });
  });

  it('puts the room on the place of the row’s own length, in the engine’s order (the 40 of 80 + 40 + 40 is the second place)', () => {
    const { places } = pinnedPlacesOf(lessons(80, 40, 40), rowsOf([{ requirementId: 'm-a', roomId: 'sal-1' }], 40), (id) => `anon:${id}`);

    expect(places).toEqual([null, { dayOfWeek: 3, startTime: '10:00:00', endTime: '10:40:00', roomId: 'anon:sal-1' }, null]);
  });

  it('throws for a pinned lesson with a room when it is given no way to say the room: a pin must never lose its room unsaid', () => {
    expect(() => pinnedPlacesOf(lessons(60, 60), rowsOf([{ requirementId: 'm-a', roomId: 'sal-1' }]))).toThrow(/room/);
  });
});

describe('storedPlacementsOf with a block placed', () => {
  const blockRows = blockPlacedLessonRowsOf([blockRead({ rooms: [{ requirementId: 'm-a', roomId: 'sal-1' }] })], [blockMember('m-a'), blockMember('m-b')]);
  const stored = [read({ id: 'a' }), read({ id: 'b', dayOfWeek: 4, roomId: null })];

  it('leaves a block’s rows out: they have no row of their own in the table the key reads', () => {
    const rows = [...placedLessonRowsOf(stored, posts), ...blockRows];

    expect(storedPlacementsOf(rows).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('keeps the key of the posts’ rows what it was, so a block placed gives no false stale', () => {
    const rows = [...placedLessonRowsOf(stored, posts), ...blockRows];

    expect(placementsKeyOf(storedPlacementsOf(rows))).toBe(placementsKeyOf(stored));
    // And a school with only a block placed compares with the table's empty answer.
    expect(placementsKeyOf(storedPlacementsOf(blockRows))).toBe(placementsKeyOf([]));
  });
});

describe('placementsRefusalOf on a block’s rows', () => {
  const rows = [
    ...placedLessonRowsOf([read()], posts),
    ...blockPlacedLessonRowsOf([blockRead({ rooms: [{ requirementId: 'm-a', roomId: 'sal-1' }] })], [blockMember('m-a'), blockMember('m-b')]),
  ];
  const refusedAll = rows.map((_, index) => ({ index, ok: false, reason: 'TEACHER' as const }));
  const names = { requirement: (id: string) => `anon:${id}`, room: (id: string) => `anon:${id}` };

  it('says the block, by the payload’s id of it, on a block’s lines and on no other', () => {
    const block = jest.fn((id: string) => `anon-block:${id}`);

    const refusal = placementsRefusalOf(rows, refusedAll, { ...names, block });

    expect(refusal!.conflicts.map((line) => line.params?.['block'])).toEqual([NO_BLOCK, `anon-block:${BLOCK}`, `anon-block:${BLOCK}`]);
    // Asked of the block rows alone, and of the block's own id.
    expect(block.mock.calls).toEqual([[BLOCK], [BLOCK]]);
  });

  it('names the room a member chose and ANY_ROOM for one that chose none, as a post’s row does', () => {
    const refusal = placementsRefusalOf(rows, refusedAll, { ...names, block: (id) => `anon-block:${id}` });

    expect(refusal!.conflicts.map((line) => [line.params?.['requirement'], line.params?.['room'], line.roomIds])).toEqual([
      [`anon:${POST.id}`, 'anon:hall', ['anon:hall']],
      ['anon:m-a', 'anon:sal-1', ['anon:sal-1']],
      ['anon:m-b', ANY_ROOM, []],
    ]);
    expect(refusal!.conflicts.every((line) => line.code === PLACEMENT_CANNOT_STAND)).toBe(true);
    expect(refusal!.summaryParams).toEqual({ count: 3 });
  });

  it('names no block (NO_BLOCK) when the caller gave no namer for one', () => {
    const refusal = placementsRefusalOf(rows, refusedAll, names);

    expect(refusal!.conflicts.every((line) => line.params?.['block'] === NO_BLOCK)).toBe(true);
  });
});

describe('blockPlacementsKeyOf', () => {
  const a = blockRead({ id: 'bp-a', rooms: [{ requirementId: 'm-a', roomId: 'sal-1' }, { requirementId: 'm-b', roomId: 'sal-2' }] });
  const b = blockRead({ id: 'bp-b', dayOfWeek: 4, startTime: at('13:00') });

  it('is one string for one set in any order of the lessons and of the rooms', () => {
    const reversed = { ...a, rooms: [...a.rooms].reverse() };

    expect(blockPlacementsKeyOf([a, b])).toBe(blockPlacementsKeyOf([b, reversed]));
  });

  it('says every field a write writes from: the lesson, its block, where, how long, the weeks and the rooms', () => {
    const base = blockPlacementsKeyOf([a, b]);

    const changed: [string, readonly Omit<BlockPlacementRead, 'block'>[]][] = [
      ['its own id', [{ ...a, id: 'bp-a2' }, b]],
      ['its block', [{ ...a, blockId: OTHER_BLOCK }, b]],
      ['its day', [{ ...a, dayOfWeek: 2 }, b]],
      ['its start', [{ ...a, startTime: at('10:05') }, b]],
      ['its length', [{ ...a, minutes: 40 }, b]],
      ['its weeks', [{ ...a, recurrence: 'EVEN_WEEKS' }, b]],
      ['a member’s room', [{ ...a, rooms: [{ requirementId: 'm-a', roomId: 'sal-9' }, a.rooms[1]!] }, b]],
      ['the member a room is for', [{ ...a, rooms: [{ requirementId: 'm-c', roomId: 'sal-1' }, a.rooms[1]!] }, b]],
      ['a room taken away', [{ ...a, rooms: [a.rooms[0]!] }, b]],
      ['a room given to another member', [{ ...a, rooms: [...a.rooms, { requirementId: 'm-c', roomId: 'sal-3' }] }, b]],
      ['a lesson taken away', [a]],
      ['a lesson added', [a, b, blockRead({ id: 'bp-c', dayOfWeek: 5 })]],
    ];
    for (const [what, reads] of changed) {
      expect([what, blockPlacementsKeyOf(reads) === base]).toEqual([what, false]);
    }
  });

  it('is built of the rows themselves: their own ids, and the block a row reads beside them changes nothing', () => {
    const key = blockPlacementsKeyOf([a, b]);

    expect(key).toContain('bp-a');
    expect(key).toContain('bp-b');
    // Nothing derived (a member's row id is the lesson's and the post's) is in it.
    expect(key).not.toContain('bp-a:');
    expect(blockPlacementsKeyOf([{ ...a, block: { sameTimesAsBlockId: 'block-leader' } }, b])).toBe(key);
    expect(blockPlacementsKeyOf([])).toBe('');
  });

  it('tells a room given to one member from the same room given to another, and two rooms from one', () => {
    const only = (requirementId: string, roomId: string) => blockPlacementsKeyOf([blockRead({ rooms: [{ requirementId, roomId }] })]);

    expect(only('m-a', 'sal-1')).not.toBe(only('m-b', 'sal-1'));
    expect(only('m-a', 'sal-1')).not.toBe(only('m-a', 'sal-2'));
    expect(only('m-a', 'sal-1')).not.toBe(blockPlacementsKeyOf([blockRead()]));
  });
});

/*
 * THE SAME PLACE k AT EVERY MEMBER (PLACED_LESSONS_OF_BLOCK_DIFFER). The engine holds the lessons of a block's members
 * together by place: the k-th lesson of each member is held with the k-th of the others, and a pinned lesson at place k
 * of one member and at another place of the next is a refusal of a week that has a timetable. The members' lessons are the
 * same (TB409), so the rows' order is what gives each lesson of the block one place k at every member.
 */
describe('a block’s förläggningar take the same place k at every member (property)', () => {
  /** mulberry32: a seeded generator, so a failing case is a number to run again. */
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const SHAPES: number[][] = [[80, 40], [60, 60, 40], [40, 40, 40], [80, 80, 40], [60, 60], [90, 60, 40, 40], [45, 45, 30], [60], [80, 40, 40], [75, 45]];
  const STARTS = ['08:00', '08:05', '09:10', '10:00', '13:30'];
  const anon = (id: string) => `anon:${id}`;
  const shuffled = <T,>(rand: () => number, list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  interface Case {
    lengths: number[];
    members: BlockMemberPlaced[];
    reads: BlockPlacementRead[];
  }
  const caseOf = (seed: number): Case => {
    const rand = seeded(seed);
    const lengths = SHAPES[Math.floor(rand() * SHAPES.length)]!;
    const count = 2 + Math.floor(rand() * 3);
    const ids = shuffled(rand, ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7']).slice(0, count);
    const distinct = new Set(lengths).size > 1;
    const members = ids.map((id) =>
      blockMember(id, {
        lessonsPerWeek: lengths.length,
        minutesPerLesson: Math.max(...lengths),
        lessonLengths: distinct ? [...lengths] : [],
        // Teachers of their own on every member: who teaches never decides a place.
        teacherId: `teacher-${Math.floor(rand() * 1000)}`,
      }),
    );
    // 1..N förläggningar, never more of a length than the block has.
    const chosen: number[] = [];
    for (const minutes of new Set(lengths)) {
      const has = lengths.filter((one) => one === minutes).length;
      for (let n = Math.floor(rand() * (has + 1)); n > 0; n--) chosen.push(minutes);
    }
    if (chosen.length === 0) chosen.push(lengths[0]!);
    const reads = shuffled(rand, chosen).map((minutes, index): BlockPlacementRead => {
      const rooms = members.filter(() => rand() < 0.4 && rand() < 0.8).map((member) => ({ requirementId: member.id, roomId: `sal-${Math.floor(rand() * 4)}` }));
      return blockRead({
        // Ids unrelated to the order they are made in, so the order the rows come in is the rows' own.
        id: `bp-${Math.floor(rand() * 1e6).toString(36)}-${index}`,
        dayOfWeek: 1 + Math.floor(rand() * 3),
        startTime: at(STARTS[Math.floor(rand() * STARTS.length)]!),
        minutes,
        rooms: shuffled(rand, rooms),
      });
    });
    return { lengths, members: shuffled(rand, members), reads: shuffled(rand, reads) };
  };
  const slotOf = (place: { dayOfWeek: number; startTime: string; endTime: string } | null) =>
    place === null ? null : [place.dayOfWeek, place.startTime, place.endTime];
  /** The lessons a member's entry sends, longest first, as remainingLengths gives them. */
  const lessonsOf = (lengths: readonly number[], teacherId: string | null) =>
    [...lengths].sort((x, y) => y - x).map((minutes) => ({ minutes, teacherId }));
  const withoutRoom = <P extends { roomId?: string }>(place: P | null) => (place === null ? null : { ...place, roomId: undefined });

  const CASES = 400;

  it(`holds for ${CASES} seeded blocks of two to four members, mixed lengths and any order of the rows`, () => {
    const seen = { mixed: 0, ties: 0, rooms: 0, repeated: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const { lengths, members, reads } = caseOf(seed);
      const why = `seed ${seed}`;
      if (new Set(lengths).size > 1) seen.mixed++;
      if (new Set(reads.map((one) => `${one.dayOfWeek}|${one.startTime.getTime()}`)).size < reads.length) seen.ties++;
      if (reads.some((one) => one.rooms.length > 0)) seen.rooms++;
      if (reads.length >= 2 && new Set(reads.map((one) => one.minutes)).size < reads.length) seen.repeated++;

      const rows = blockPlacedLessonRowsOf(reads, members);

      // Every row of a block that fits is for every member, and every lesson is a row of each.
      expect([why, rows.length]).toEqual([why, reads.length * members.length]);
      expect([why, rows.every((row) => row.blockFit === null)]).toEqual([why, true]);

      // The places of each member, from the lessons its entry sends.
      const placesOf = new Map(
        members.map((member) => {
          const mine = rows.filter((row) => row.requirementId === member.id);
          const placed = pinnedPlacesOf(lessonsOf(lengths, member.teacherId), mine, anon);
          expect([why, member.id, placed.unplaced.length]).toEqual([why, member.id, 0]);
          return [member.id, { mine, places: placed.places! }] as const;
        }),
      );

      const first = [...placesOf.values()][0]!;
      for (const [id, { places }] of placesOf) {
        // The same place k, the same day and start, at every member; the lesson's end follows from its place's length.
        expect([why, id, places.map(slotOf)]).toEqual([why, id, first.places.map(slotOf)]);
        // Every förläggning got a place, and no place got two.
        expect([why, id, places.filter((place) => place !== null).length]).toEqual([why, id, reads.length]);
      }

      // The room goes with its own lesson to its own place: the place a row takes is the first free of its length, in the
      // rows' order, which an independent count of each length's rows says.
      for (const { mine, places } of placesOf.values()) {
        const sent = lessonsOf(lengths, null);
        const taken = new Map<number, number>();
        for (const row of mine) {
          const nth = taken.get(row.minutes) ?? 0;
          taken.set(row.minutes, nth + 1);
          const index = sent.flatMap((lesson, position) => (lesson.minutes === row.minutes ? [position] : []))[nth]!;
          expect([why, row.id, places[index]?.roomId]).toEqual([why, row.id, row.roomId === null ? undefined : anon(row.roomId)]);
          expect([why, row.id, places[index]?.dayOfWeek]).toEqual([why, row.id, row.dayOfWeek]);
        }
      }

      // The rows come in the order (day, start, id of the lesson) for every member.
      const expectedOrder = [...reads]
        .sort((x, y) => x.dayOfWeek - y.dayOfWeek || x.startTime.getTime() - y.startTime.getTime() || (x.id < y.id ? -1 : 1))
        .map((one) => one.id);
      for (const { mine } of placesOf.values()) {
        expect([why, mine.map((row) => row.blockPlacementId)]).toEqual([why, expectedOrder]);
      }

      // The order the lessons and the members are handed over in changes nothing.
      const rand = seeded(seed + 100_000);
      expect([why, blockPlacedLessonRowsOf(shuffled(rand, reads), shuffled(rand, members))]).toEqual([why, rows]);

      // Rooms chosen for some members change `roomId` of their places and nothing else: the same places without any room.
      const bare = blockPlacedLessonRowsOf(
        reads.map((one) => ({ ...one, rooms: [] })),
        members,
      );
      for (const member of members) {
        const without = pinnedPlacesOf(lessonsOf(lengths, member.teacherId), bare.filter((row) => row.requirementId === member.id)).places!;
        expect([why, member.id, placesOf.get(member.id)!.places.map(withoutRoom)]).toEqual([why, member.id, without.map(withoutRoom)]);
      }
    }
    // The generator reaches what the property is about: mixed lengths, rows tied on a day and a start, rooms and a length twice.
    expect(seen.mixed).toBeGreaterThan(CASES / 2);
    expect(seen.ties).toBeGreaterThan(10);
    expect(seen.rooms).toBeGreaterThan(CASES / 4);
    expect(seen.repeated).toBeGreaterThan(CASES / 5);
  });

  it('would fail a place k that is not the same: the rows of one member read in another order put a lesson of one length elsewhere', () => {
    // What the property guards: members that read the block's lessons each in an order of their own. Two lessons of 60.
    const members = [blockMember('m-a'), blockMember('m-b')];
    const rows = blockPlacedLessonRowsOf([blockRead({ id: 'bp-1', dayOfWeek: 3 }), blockRead({ id: 'bp-2', dayOfWeek: 4 })], members);
    const lessons = lessonsOf([60, 60], null);

    const same = members.map((member) => pinnedPlacesOf(lessons, rows.filter((row) => row.requirementId === member.id), anon).places!.map(slotOf));
    expect(same[0]).toEqual(same[1]);
    const swapped = pinnedPlacesOf(lessons, [...rows.filter((row) => row.requirementId === 'm-b')].reverse(), anon).places!.map(slotOf);
    expect(swapped).not.toEqual(same[0]);
  });
});
