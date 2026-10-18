import {
  candidateMetricsOf,
  differenceOf,
  lessonCountOf,
  metricsViewOf,
  movedMetrics,
  runUnplacedOf,
  sameAsOf,
  slotLessonsOf,
} from './candidate-metrics';
import type {
  CandidateLesson,
  CoverageBase,
  DraftLesson,
  RegenerationRequirementRow,
} from './optimization-proxy.service';

/*
 * The figures a candidate is stored with. "moved" is the web's moved list
 * counted (web/lib/candidates/moved.ts): a multiset match on (class, subject,
 * day, start, end), equal rooms paired first. These cases are the list's own,
 * so the table's "X av Y" and the list under it cannot disagree.
 */

const G7A = '7a000000-0000-4000-8000-000000000000';
const G7B = '7b000000-0000-4000-8000-000000000000';
const MA = 'aa000000-0000-4000-8000-000000000000';
const SV = 'bb000000-0000-4000-8000-000000000000';
const R1 = 'r1000000-0000-4000-8000-000000000000';
const R2 = 'r2000000-0000-4000-8000-000000000000';

const requirement = (id: string, studentGroupId: string, subjectId: string): RegenerationRequirementRow => ({
  id,
  subjectId,
  studentGroupId,
  teacherId: null,
  coTeacherId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
});
const ROWS = [requirement('req-ma-7a', G7A, MA), requirement('req-sv-7a', G7A, SV), requirement('req-ma-7b', G7B, MA)];

const draft = (
  studentGroupId: string,
  subjectId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  roomId: string | null = R1,
): DraftLesson => ({
  id: `d-${studentGroupId}-${subjectId}-${dayOfWeek}-${startTime}-${roomId}`,
  subjectId,
  studentGroupId,
  teacherId: null,
  coTeacherId: null,
  roomId,
  dayOfWeek,
  startTime,
  endTime,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
});

const placed = (
  requirementId: string,
  dayOfWeek: CandidateLesson['dayOfWeek'],
  startTime: string,
  endTime: string,
  roomId: string | null = R1,
): CandidateLesson => ({ requirementId, roomId, dayOfWeek, startTime, endTime });

describe('movedMetrics', () => {
  it('keeps a lesson at its class, subject, day and clock, and moves one that is elsewhere', () => {
    const before = [draft(G7A, MA, 1, '08:00', '09:00'), draft(G7A, MA, 3, '10:00', '11:00')];
    const after = slotLessonsOf(ROWS, [placed('req-ma-7a', 1, '08:00', '09:00'), placed('req-ma-7a', 2, '10:00', '11:00')]);
    expect(movedMetrics(before, after)).toEqual({ moved: 1, movedOf: 2, kept: 1, roomChanges: 0 });
  });

  it('counts a kept slot in another room as a room change, and pairs equal rooms first', () => {
    // Two 7A Ma lessons at one time in A and B against B and A: no change.
    const before = [draft(G7A, MA, 1, '08:00', '09:00', R1), draft(G7A, MA, 1, '08:00', '09:00', R2)];
    const swapped = slotLessonsOf(ROWS, [placed('req-ma-7a', 1, '08:00', '09:00', R2), placed('req-ma-7a', 1, '08:00', '09:00', R1)]);
    expect(movedMetrics(before, swapped)).toEqual({ moved: 0, movedOf: 2, kept: 2, roomChanges: 0 });

    const moved = slotLessonsOf(ROWS, [placed('req-ma-7a', 1, '08:00', '09:00', R2), placed('req-ma-7a', 1, '08:00', '09:00', null)]);
    expect(movedMetrics(before, moved)).toEqual({ moved: 0, movedOf: 2, kept: 2, roomChanges: 1 });
  });

  it('never keeps a lesson of another class or subject at the same clock', () => {
    const before = [draft(G7A, MA, 1, '08:00', '09:00')];
    const after = slotLessonsOf(ROWS, [placed('req-sv-7a', 1, '08:00', '09:00'), placed('req-ma-7b', 1, '08:00', '09:00')]);
    expect(movedMetrics(before, after)).toEqual({ moved: 1, movedOf: 1, kept: 0, roomChanges: 0 });
  });

  it('reads a clock with seconds as the same clock, and counts a lesson the demand dropped as moved', () => {
    const before = [draft(G7A, MA, 1, '08:00:00', '09:00:00'), draft(G7A, MA, 2, '08:00', '09:00')];
    const after = slotLessonsOf(ROWS, [placed('req-ma-7a', 1, '08:00', '09:00')]);
    expect(movedMetrics(before, after)).toEqual({ moved: 1, movedOf: 2, kept: 1, roomChanges: 0 });
  });

  it('measures an empty draft as nothing moved of nothing', () => {
    expect(movedMetrics([], slotLessonsOf(ROWS, [placed('req-ma-7a', 1, '08:00', '09:00')]))).toEqual({
      moved: 0,
      movedOf: 0,
      kept: 0,
      roomChanges: 0,
    });
  });
});

describe('slotLessonsOf', () => {
  it('takes the class and subject from the requirement, and leaves out a lesson of an unknown one', () => {
    expect(slotLessonsOf(ROWS, [placed('req-sv-7a', 4, '13:00', '14:00', null), placed('gone', 1, '08:00', '09:00')])).toEqual([
      { studentGroupId: G7A, subjectId: SV, dayOfWeek: 4, startTime: '13:00', endTime: '14:00', roomId: null },
    ]);
  });
});

describe('sameAsOf', () => {
  const week = (count: number, roomId: string | null = R1): CandidateLesson[] =>
    Array.from({ length: count }, (_, index) =>
      placed('req-ma-7a', ((index % 5) + 1) as CandidateLesson['dayOfWeek'], `${String(8 + Math.floor(index / 5)).padStart(2, '0')}:00`, `${String(9 + Math.floor(index / 5)).padStart(2, '0')}:00`, roomId),
    );

  it('names the first earlier candidate this one differs from in under 1 % of its lessons', () => {
    const base = week(200);
    const one = [...base.slice(0, 199), placed('req-ma-7a', 5, '15:30', '16:30')];
    expect(differenceOf(one, base)).toBeCloseTo(0.005);
    expect(sameAsOf(one, [{ ordinal: 1, lessons: base }, { ordinal: 2, lessons: base }])).toBe(1);
  });

  it('is null at 1 % and over, and a room counts', () => {
    const base = week(100);
    const two = [...base.slice(0, 99), placed('req-ma-7a', 5, '15:30', '16:30')];
    expect(differenceOf(two, base)).toBeCloseTo(0.01);
    expect(sameAsOf(two, [{ ordinal: 1, lessons: base }])).toBeNull();
    expect(sameAsOf(week(100, R2), [{ ordinal: 1, lessons: base }])).toBeNull();
  });

  it('reads two empty candidates as one timetable, and nothing earlier as no match', () => {
    expect(differenceOf([], [])).toBe(0);
    expect(sameAsOf([], [{ ordinal: 2, lessons: [] }])).toBe(2);
    expect(sameAsOf(week(3), [])).toBeNull();
  });
});

describe('candidateMetricsOf and runUnplacedOf', () => {
  /** A year with 7A's Ma at 120 minutes a week and nothing preserved. */
  const coverage = (draftLessons: CoverageBase['draftLessons']): CoverageBase => ({
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    closures: [],
    subjects: [{ id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true }],
    groups: [{ id: G7A, name: '7A', kind: 'CLASS', gradeLevel: 7 }],
    requirements: [
      {
        id: 'req-ma-7a',
        studentGroupId: G7A,
        subjectId: MA,
        lessonsPerWeek: 2,
        minutesPerLesson: 60,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
    ],
    preservedLessons: [],
    draftLessons,
  });
  const scheduled = (startTime: string, endTime: string) => ({
    id: `s-${startTime}`,
    studentGroupId: G7A,
    subjectId: MA,
    startTime,
    endTime,
    recurrence: 'ALL_WEEKS' as const,
    startDate: null,
    endDate: null,
    isParked: false,
    extraGroupIds: [],
    studentIds: [],
  });

  it('stores moved, sameAs, the count and what the candidate leaves unplaced', () => {
    const base = coverage([scheduled('08:00', '09:00')]);
    const lessons = [placed('req-ma-7a', 1, '08:00', '09:00'), placed('req-ma-7a', 2, '08:00', '09:00')];
    const metrics = candidateMetricsOf({
      requirementRows: ROWS,
      draftLessons: [draft(G7A, MA, 1, '08:00', '09:00')],
      coverage: base,
      lessons,
      earlier: [],
    });
    expect(metrics).toEqual({
      moved: 0,
      movedOf: 1,
      kept: 1,
      roomChanges: 0,
      sameAs: null,
      lessonCount: 2,
      unplaced: { lines: 0, minutes: 0 },
    });

    // The draft has one of the two lessons: one line SHORT by an hour.
    expect(runUnplacedOf(base, metrics.unplaced)).toEqual({ lines: 0, minutes: 0, draftLines: 1, draftMinutes: 60 });
  });

  it('measures no unplaced figure without the timplan rows, and no run figure without an applicable candidate', () => {
    const metrics = candidateMetricsOf({ requirementRows: ROWS, draftLessons: [], coverage: null, lessons: [], earlier: [] });
    expect(metrics.unplaced).toBeNull();
    expect(runUnplacedOf(null, { lines: 0, minutes: 0 })).toBeNull();
    expect(runUnplacedOf(coverage([]), null)).toBeNull();
  });
});

describe('metricsViewOf and lessonCountOf', () => {
  it('gives the page the five figures and nothing else', () => {
    expect(
      metricsViewOf({ moved: 3, movedOf: 10, kept: 7, roomChanges: 1, sameAs: 2, lessonCount: 10, unplaced: { lines: 0, minutes: 0 } }),
    ).toEqual({ moved: 3, movedOf: 10, roomChanges: 1, kept: 7, sameAs: 2 });
    expect(lessonCountOf({ lessonCount: 10 })).toBe(10);
  });

  it('reads a blob that is not the run\'s as zeros and no sameAs, and no blob as none', () => {
    expect(metricsViewOf({ moved: '3', movedOf: -1, kept: 1.5, sameAs: 9 })).toEqual({
      moved: 0,
      movedOf: 0,
      roomChanges: 0,
      kept: 0,
      sameAs: null,
    });
    expect(metricsViewOf(null)).toBeNull();
    expect(metricsViewOf([1])).toBeNull();
    expect(lessonCountOf(null)).toBe(0);
    expect(lessonCountOf([])).toBe(0);
  });
});
