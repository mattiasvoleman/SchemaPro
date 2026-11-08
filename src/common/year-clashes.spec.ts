import { clashPairs, yearClashes, type YearClashInput, type YearClashLesson } from './year-clashes';

/**
 * Ersättande grupper in the publish check (PUB_CLASHES) and the board: the
 * cases the shared fixture (year-clashes.contract.spec.ts) does not reach.
 * Alva is in 7A; SvA7 replaces Svenska (SV).
 */
const lesson = (id: string, studentGroupId: string, subjectId: string, extra: Partial<YearClashLesson> = {}): YearClashLesson => ({
  id,
  subjectId,
  dayOfWeek: 1,
  startTime: '10:00',
  endTime: '11:00',
  teacherId: `t-${id}`,
  roomId: `r-${id}`,
  studentGroupId,
  ...extra,
});

const base = (overrides: Partial<YearClashInput>): YearClashInput => ({
  lessons: [],
  constraints: [],
  studentGroupOf: [['alva', '7A']],
  memberships: [],
  pupilBuffers: [],
  ...overrides,
});

const groupClash = (input: YearClashInput, id: string) => (yearClashes(input).get(id) ?? []).some((hit) => hit.kind === 'GROUP');

describe('year clashes with replacing groups', () => {
  it('lets no replacing group of another läsår hide a named pupil’s clash, whatever the reader passed', () => {
    // Alva was in last year's SvA6, which replaced Svenska; the rollover kept
    // the membership. She is named on Ma7's lesson at the hour of 7A's svenska.
    const input = base({
      lessons: [lesson('sv', '7A', 'SV'), lesson('named', 'Ma7', 'MA', { studentIds: ['alva'] })],
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA6' }],
      replacing: [{ id: 'SvA6', replacesSubjectId: 'SV', academicYearId: 'y25' }],
      academicYearId: 'y26',
    });
    expect(groupClash(input, 'sv')).toBe(true);
    // This year's SvA7 does take her off 7A's svenska: no clash.
    const thisYear = base({
      ...input,
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA7' }],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
    });
    expect(groupClash(thisYear, 'sv')).toBe(false);
  });

  it('keeps a teaching group’s own svenska apart from SvA7 when they share a pupil', () => {
    // Sv7n is Svenska fördjupning, a teaching group and not a half; Alva is
    // in it and in SvA7. Placed in it, she goes there.
    const input = base({
      lessons: [lesson('fd', 'Sv7n', 'SV'), lesson('sva', 'SvA7', 'SVA')],
      memberships: [
        { studentId: 'alva', studentGroupId: 'Sv7n' },
        { studentId: 'alva', studentGroupId: 'SvA7' },
      ],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
      academicYearId: 'y26',
      kept: ['Sv7n'],
    });
    expect(groupClash(input, 'fd')).toBe(true);
  });

  it('keeps the lessons of two groups replacing svenska apart when a pupil is in both', () => {
    const input = base({
      lessons: [lesson('a', 'SvA7', 'SV'), lesson('b', 'SvA7s', 'SV')],
      memberships: [
        { studentId: 'alva', studentGroupId: 'SvA7' },
        { studentId: 'alva', studentGroupId: 'SvA7s' },
      ],
      replacing: [
        { id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' },
        { id: 'SvA7s', replacesSubjectId: 'SV', academicYearId: 'y26' },
      ],
      academicYearId: 'y26',
      kept: ['SvA7', 'SvA7s'],
    });
    expect(groupClash(input, 'a')).toBe(true);
  });

  it('still lets SvA7 sit beside 7A’s svenska', () => {
    const input = base({
      lessons: [lesson('sv', '7A', 'SV'), lesson('sva', 'SvA7', 'SVA')],
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA7' }],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
      academicYearId: 'y26',
      kept: ['SvA7'],
    });
    expect(groupClash(input, 'sv')).toBe(false);
  });
});

describe('year clashes in A/B-veckor', () => {
  /*
   * The generator now lays slöjd udda veckor and hemkunskap jämna veckor in
   * one hour of one class, one teacher and one room. The publish check
   * (PUB_CLASHES) reads them as the engine does: no week holds both, so they
   * are no clash — and an every-week lesson in the same hour still is, in
   * each week.
   */
  const shared = { teacherId: 't-1', roomId: 'r-1' };
  const clashes = (input: YearClashInput, id: string) => (yearClashes(input).get(id) ?? []).map((hit) => hit.kind).sort();

  it('lets an odd-week and an even-week lesson share a class, a teacher and a room', () => {
    const input = base({
      lessons: [
        lesson('slojd', '7A', 'SL', { ...shared, recurrence: 'ODD_WEEKS' }),
        lesson('hkk', '7A', 'HKK', { ...shared, recurrence: 'EVEN_WEEKS' }),
      ],
    });
    expect(clashes(input, 'slojd')).toEqual([]);
    expect(clashes(input, 'hkk')).toEqual([]);
  });

  it('still clashes an every-week lesson, or two of one parity, in the same hour', () => {
    const input = base({
      lessons: [
        lesson('slojd', '7A', 'SL', { ...shared, recurrence: 'ODD_WEEKS' }),
        lesson('bild', '7A', 'BL', { ...shared, recurrence: 'ODD_WEEKS' }),
        lesson('hkk', '7A', 'HKK', { ...shared, recurrence: 'EVEN_WEEKS' }),
        lesson('sv', '7A', 'SV', { ...shared }),
      ],
    });
    expect(clashes(input, 'slojd')).toEqual(['GROUP', 'GROUP', 'ROOM', 'ROOM', 'TEACHER', 'TEACHER']);
    expect(clashes(input, 'hkk')).toEqual(['GROUP', 'ROOM', 'TEACHER']);
  });
});

describe('year clashes in a shared room (Delade salar)', () => {
  /*
   * The generator may lay two classes in a hall the school has marked shareable
   * while the rule is on; the publish check must not paint that as a double
   * booking, or the timetable it laid could never be published. Two pupils in
   * each of 7A, 7B and 7C; the hall holds `seats`.
   */
  const pupils: Array<[string, string | null]> = [
    ['a1', '7A'],
    ['a2', '7A'],
    ['b1', '7B'],
    ['b2', '7B'],
    ['c1', '7C'],
    ['c2', '7C'],
  ];
  const hall = { roomId: 'hall' };
  const inHall = (id: string, group: string, extra: Partial<YearClashLesson> = {}) =>
    lesson(id, group, `S-${id}`, { ...hall, ...extra });
  const school = (lessons: YearClashLesson[], seats: number | null = 4, extra: Partial<YearClashInput> = {}) =>
    base({
      lessons,
      studentGroupOf: pupils,
      ...(seats === null ? {} : { sharedRooms: [{ roomId: 'hall', seats }] }),
      ...extra,
    });
  const kinds = (input: YearClashInput, id: string) => (yearClashes(input).get(id) ?? []).map((hit) => hit.kind).sort();

  it('shared hall, pupils fit: no clash for either lesson', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7B')]);
    expect(kinds(input, 'a')).toEqual([]);
    expect(kinds(input, 'b')).toEqual([]);
    expect(clashPairs(yearClashes(input))).toEqual([]);
  });

  it('shared hall, pupils do not fit: a ROOM clash for both, once as a pair', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7B')], 3);
    expect(kinds(input, 'a')).toEqual(['ROOM']);
    expect(kinds(input, 'b')).toEqual(['ROOM']);
    expect(clashPairs(yearClashes(input))).toEqual([{ kind: 'ROOM', lessonIds: ['a', 'b'] }]);
  });

  it('a room not marked shared (no entry) clashes as before', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7B')], null);
    expect(kinds(input, 'a')).toEqual(['ROOM']);
    expect(kinds(input, 'b')).toEqual(['ROOM']);
  });

  it('another room that is shared leaves this one exclusive', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7B')], null, { sharedRooms: [{ roomId: 'gym', seats: 100 }] });
    expect(kinds(input, 'a')).toEqual(['ROOM']);
  });

  it('three lessons whose pairs fit but not all three: every pair is a clash', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7B'), inHall('c', '7C')]);
    expect(kinds(input, 'a')).toEqual(['ROOM', 'ROOM']);
    expect(kinds(input, 'b')).toEqual(['ROOM', 'ROOM']);
    expect(kinds(input, 'c')).toEqual(['ROOM', 'ROOM']);
    expect(clashPairs(yearClashes(input))).toEqual([
      { kind: 'ROOM', lessonIds: ['a', 'b'] },
      { kind: 'ROOM', lessonIds: ['a', 'c'] },
      { kind: 'ROOM', lessonIds: ['b', 'c'] },
    ]);
  });

  it('three lessons that are never in the hall all at once fit', () => {
    const input = school([
      inHall('long', '7A', { startTime: '08:00', endTime: '10:00' }),
      inHall('first', '7B', { startTime: '08:00', endTime: '09:00' }),
      inHall('second', '7C', { startTime: '09:00', endTime: '10:00' }),
    ]);
    expect(clashPairs(yearClashes(input))).toEqual([]);
  });

  it('names only the pairs that stand in the overfull stretch', () => {
    const input = school(
      [
        inHall('long', '7A', { startTime: '08:00', endTime: '10:00' }),
        inHall('first', '7B', { startTime: '08:00', endTime: '09:30' }),
        inHall('second', '7C', { startTime: '09:00', endTime: '10:00' }),
        inHall('late', '7C', { startTime: '10:00', endTime: '11:00', teacherId: 't-late' }),
      ],
      4,
    );
    // 09:00-09:30 holds long, first and second: six pupils in four seats.
    expect(clashPairs(yearClashes(input)).filter((pair) => pair.kind === 'ROOM')).toEqual([
      { kind: 'ROOM', lessonIds: ['first', 'long'] },
      { kind: 'ROOM', lessonIds: ['first', 'second'] },
      { kind: 'ROOM', lessonIds: ['long', 'second'] },
    ]);
  });

  it('odd and even weeks share the hall as they always did, and add no pupils to each other', () => {
    const input = school(
      [
        inHall('every', '7A', { recurrence: 'ALL_WEEKS' }),
        inHall('odd', '7B', { recurrence: 'ODD_WEEKS' }),
        inHall('even', '7C', { recurrence: 'EVEN_WEEKS' }),
      ],
      4,
    );
    expect(clashPairs(yearClashes(input))).toEqual([]);
    // With the rule off they share a room just the same: the weeks never meet.
    const exclusive = school(
      [inHall('odd', '7B', { recurrence: 'ODD_WEEKS' }), inHall('even', '7C', { recurrence: 'EVEN_WEEKS' })],
      null,
    );
    expect(clashPairs(yearClashes(exclusive))).toEqual([]);
  });

  it('counts a pupil named on a lesson, and a pupil of both lessons once', () => {
    // 7B's lesson names a1 as well: a1 is already on 7A's lesson, so the hall
    // holds a1, a2, b1, b2 and no more.
    const input = school([inHall('a', '7A'), inHall('b', '7B', { studentIds: ['a1'] })], 4);
    expect(clashPairs(yearClashes(input)).filter((pair) => pair.kind === 'ROOM')).toEqual([]);
    // Named but not in either class, the hall holds five in four seats.
    const over = school([inHall('a', '7A'), inHall('b', '7B', { studentIds: ['c1'] })], 4);
    expect(clashPairs(yearClashes(over)).filter((pair) => pair.kind === 'ROOM')).toEqual([
      { kind: 'ROOM', lessonIds: ['a', 'b'] },
    ]);
  });

  it('keeps a hall exclusive for a lesson whose class nobody knows', () => {
    const input = school([inHall('a', '7A'), inHall('b', '7X')], 1000);
    expect(kinds(input, 'a')).toEqual(['ROOM']);
    expect(kinds(input, 'b')).toEqual(['ROOM']);
  });

  it('leaves the teacher and the class alone: they clash in a shared hall as before', () => {
    const sameTeacher = school([inHall('a', '7A', { teacherId: 't-1' }), inHall('b', '7B', { teacherId: 't-1' })]);
    expect(kinds(sameTeacher, 'a')).toEqual(['TEACHER']);
    const sameClass = school([inHall('a', '7A'), inHall('b', '7A')]);
    expect(kinds(sameClass, 'a')).toEqual(['GROUP']);
  });

  it('lets a lesson in an exclusive room beside the hall clash with nothing', () => {
    const input = school([inHall('a', '7A'), lesson('b', '7B', 'S-b', { roomId: 'lab' })]);
    expect(clashPairs(yearClashes(input))).toEqual([]);
  });
});
