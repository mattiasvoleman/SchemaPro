import { otherSchoolClashes, shareADate, type BusyLesson, type LoanWindow, type PublishedLesson } from './other-school-clashes';

/**
 * PUB_OTHER_SCHOOL's three findings, read the way the board reads weeks:
 * a shared teacher's lesson that meets the teacher's lesson at the other
 * school with the walk counted, a lesson in a lent room in an approved
 * window, and a lesson in a borrowed room that no approved loan covers.
 */

const ANNA = 'a0000000-0000-4000-8000-000000000001';
const NORRA = 'b0000000-0000-4000-8000-000000000002';
const HALL = 'c0000000-0000-4000-8000-000000000003';
const LOCAL = 'd0000000-0000-4000-8000-000000000004';

// 2030-09-03 is a Tuesday in ISO week 36 (even).
const lesson = (patch: Partial<PublishedLesson>): PublishedLesson => ({
  id: 'L',
  teacherIds: [ANNA],
  roomId: null,
  dayOfWeek: 2,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...patch,
});
const busy = (patch: Partial<BusyLesson>): BusyLesson => ({
  teacherId: ANNA,
  schoolId: NORRA,
  dayOfWeek: 2,
  startTime: '09:10',
  endTime: '10:00',
  recurrence: 'ALL_WEEKS',
  startDate: '2030-08-15',
  endDate: '2031-06-15',
  travelMinutes: 15,
  ...patch,
});
const window = (patch: Partial<LoanWindow>): LoanWindow => ({
  loanId: 'W',
  roomId: HALL,
  schoolId: NORRA,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:30',
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...patch,
});
const run = (input: Partial<Parameters<typeof otherSchoolClashes>[0]>) =>
  otherSchoolClashes({ lessons: [], busy: [], lent: [], borrowed: [], localRoomIds: new Set(), ...input }).map((c) => c.kind);

describe('shareADate', () => {
  it('reads parity and periods exactly', () => {
    const all = { recurrence: 'ALL_WEEKS' as const, startDate: '2030-08-19', endDate: '2031-06-13' };
    expect(shareADate(2, all, { ...all, recurrence: 'ODD_WEEKS' })).toBe(true);
    expect(shareADate(2, { ...all, recurrence: 'ODD_WEEKS' }, { ...all, recurrence: 'EVEN_WEEKS' })).toBe(false);
    // One Tuesday in common, 2030-09-03 (week 36, even): an odd-week lesson never meets it.
    expect(shareADate(2, { ...all, startDate: '2030-09-02', endDate: '2030-09-08' }, { ...all, recurrence: 'ODD_WEEKS' })).toBe(false);
    expect(shareADate(2, { ...all, startDate: '2030-09-02', endDate: '2030-09-08' }, { ...all, recurrence: 'EVEN_WEEKS' })).toBe(true);
    // Periods that do not meet, and a common period with no Tuesday.
    expect(shareADate(2, { ...all, endDate: '2030-12-20' }, { ...all, startDate: '2031-01-07' })).toBe(false);
    expect(shareADate(2, { ...all, startDate: '2030-09-04', endDate: '2030-09-09' }, all)).toBe(false);
  });

  it('looks past ISO week 53, which is odd as week 1 after it is', () => {
    // 2026-12-28 is the Monday of week 53, 2027-01-04 of week 1 and
    // 2027-01-11 of week 2, the first even week of the spring.
    const spring = { recurrence: 'ALL_WEEKS' as const, startDate: '2026-12-28', endDate: '2027-06-11' };
    expect(shareADate(1, spring, { ...spring, recurrence: 'EVEN_WEEKS', startDate: '2026-08-17' })).toBe(true);
    expect(shareADate(1, { ...spring, startDate: '2027-01-04' }, { ...spring, recurrence: 'EVEN_WEEKS' })).toBe(true);
    // Weeks 53 and 1 alone hold no even week.
    expect(shareADate(1, { ...spring, endDate: '2027-01-10' }, { ...spring, recurrence: 'EVEN_WEEKS' })).toBe(false);
  });
});

describe('otherSchoolClashes', () => {
  it('counts the walk between the schools on both sides of the lesson elsewhere', () => {
    // 08:00–09:00 here, 09:10 there, 15 minutes between: a clash.
    expect(run({ lessons: [lesson({})], busy: [busy({})] })).toEqual(['TEACHER']);
    // With 10 minutes the teacher makes it.
    expect(run({ lessons: [lesson({})], busy: [busy({ travelMinutes: 10 })] })).toEqual([]);
    // No figure stated: only a real overlap is one.
    expect(run({ lessons: [lesson({})], busy: [busy({ travelMinutes: null })] })).toEqual([]);
    expect(run({ lessons: [lesson({})], busy: [busy({ startTime: '08:30', travelMinutes: null })] })).toEqual(['TEACHER']);
  });

  it('finds the teacher as co-teacher too, and never another teacher or another day', () => {
    expect(run({ lessons: [lesson({ teacherIds: ['x', ANNA] })], busy: [busy({})] })).toEqual(['TEACHER']);
    expect(run({ lessons: [lesson({ teacherIds: ['x'] })], busy: [busy({})] })).toEqual([]);
    expect(run({ lessons: [lesson({ dayOfWeek: 3 })], busy: [busy({})] })).toEqual([]);
  });

  it('reads the weeks: odd here and even there never meet', () => {
    expect(run({ lessons: [lesson({ recurrence: 'ODD_WEEKS' })], busy: [busy({ recurrence: 'EVEN_WEEKS' })] })).toEqual([]);
    expect(run({ lessons: [lesson({ endDate: '2030-12-20' })], busy: [busy({ startDate: '2031-01-07' })] })).toEqual([]);
  });

  it('names a lesson in a lent room in an approved window, and not beside it', () => {
    expect(run({ lessons: [lesson({ roomId: HALL, startTime: '11:00', endTime: '12:00' })], lent: [window({})] })).toEqual(['LENT_ROOM']);
    expect(run({ lessons: [lesson({ roomId: HALL, startTime: '11:30', endTime: '12:30' })], lent: [window({})] })).toEqual([]);
    expect(run({ lessons: [lesson({ roomId: HALL, startTime: '10:00', endTime: '11:00', dayOfWeek: 3 })], lent: [window({})] })).toEqual([]);
    expect(run({ lessons: [lesson({ roomId: HALL, startTime: '10:00', endTime: '11:00', startDate: '2031-06-14', endDate: '2031-06-20' })], lent: [window({})] })).toEqual([]);
  });

  it('names a lesson in a borrowed room that no approved window holds', () => {
    const local = new Set([LOCAL]);
    const held = window({ roomId: LOCAL });
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:30' })], borrowed: [held], localRoomIds: local })).toEqual([]);
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:45' })], borrowed: [held], localRoomIds: local })).toEqual(['BORROWED_ROOM']);
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00', dayOfWeek: 4 })], borrowed: [held], localRoomIds: local })).toEqual(['BORROWED_ROOM']);
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00', endDate: '2031-06-20' })], borrowed: [held], localRoomIds: local })).toEqual(['BORROWED_ROOM']);
    // No loan approved: every lesson in the room is outside.
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00' })], borrowed: [], localRoomIds: local })).toEqual(['BORROWED_ROOM']);
    // A room that is no local room is none of this.
    expect(run({ lessons: [lesson({ roomId: 'other', startTime: '10:00', endTime: '11:00' })], borrowed: [], localRoomIds: local })).toEqual([]);
  });

  it('reads a borrowed room’s loans together: side by side, autumn and spring, and only the weeks the lesson runs', () => {
    const local = new Set([LOCAL]);
    const tue = (patch: Partial<LoanWindow>) => window({ roomId: LOCAL, ...patch });
    // 10–11 and 11–12 cover 10:30–11:30, which neither does alone.
    expect(
      run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:30', endTime: '11:30' })], borrowed: [tue({ endTime: '11:00' }), tue({ startTime: '11:00', endTime: '12:00' })], localRoomIds: local }),
    ).toEqual([]);
    // An autumn loan and a spring loan cover a lesson that runs all year.
    const terms = [tue({ endDate: '2030-12-20' }), tue({ startDate: '2030-12-21' })];
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00' })], borrowed: terms, localRoomIds: local })).toEqual([]);
    // A week between the terms with no loan: the lesson that week is outside.
    const gap = [tue({ endDate: '2030-12-20' }), tue({ startDate: '2031-01-08' })];
    expect(run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00' })], borrowed: gap, localRoomIds: local })).toEqual([
      'BORROWED_ROOM',
    ]);
    // Unless the group is on lov those Tuesdays: the publish writes nothing then.
    const jul = new Set(['2030-12-24', '2030-12-31', '2031-01-07']);
    expect(
      run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00', offDays: jul })], borrowed: gap, localRoomIds: local }),
    ).toEqual([]);
    // An odd-week lesson needs only the odd weeks covered: the uncovered
    // Tuesday 2030-12-24 is in week 52, even.
    const oddGap = [tue({ endDate: '2030-12-20' }), tue({ startDate: '2030-12-25' })];
    expect(
      run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00', recurrence: 'ODD_WEEKS' })], borrowed: oddGap, localRoomIds: local }),
    ).toEqual([]);
    expect(
      run({ lessons: [lesson({ roomId: LOCAL, startTime: '10:00', endTime: '11:00', recurrence: 'EVEN_WEEKS' })], borrowed: oddGap, localRoomIds: local }),
    ).toEqual(['BORROWED_ROOM']);
  });

  it('skips a lesson the publish does not materialise', () => {
    expect(run({ lessons: [lesson({ startDate: '2031-01-01', endDate: '2030-12-31' })], busy: [busy({})] })).toEqual([]);
  });
});
