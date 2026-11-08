import {
  PLACEMENT_CANNOT_STAND,
  PLACEMENTS_REFUSED_SUMMARY,
  placedLessonRowsOf,
  placedLessonWritesOf,
  placedMinutesOf,
  placementsKeyOf,
  placementsRefusalOf,
  withoutPlaced,
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
  ...overrides,
});

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
      },
    ]);
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
    expect(placementsKeyOf([])).toBe('');
  });
});
