import { createTxMock } from '../../test/utils/prisma-mock';
import type { GroupFacts } from '../publication/activity-plan';
import {
  datesToRead,
  examFacts,
  homeClassesOf,
  instantOf,
  loanCheck,
  readCancellableLessons,
  readLoans,
  readRoomUses,
  standingOf,
  type Facts,
} from './exam-reads';
import type { ExamRow } from './exams.service';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const clock = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

const GROUPS: GroupFacts[] = [
  { id: 'g7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: 'g7b', name: '7B', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: 'half', name: '7A-halva', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: 'g7a' },
  { id: 'span', name: 'Spanska', kind: 'TEACHING_GROUP', gradeLevel: null, halfOfId: null },
  { id: 'empty', name: 'Tom grupp', kind: 'TEACHING_GROUP', gradeLevel: null, halfOfId: null },
];
const facts = (): Facts => ({
  groups: GROUPS,
  byId: new Map(GROUPS.map((group) => [group.id, group])),
  homes: new Map([['span', ['g7a', 'g7b', 'g7a', 'none']]]),
});

const row = (over: Partial<ExamRow> = {}): ExamRow => ({
  id: 'e1',
  academicYearId: 'y',
  subjectId: 'math',
  name: 'Prov',
  lengthMinutes: 60,
  writers: 40,
  windowKind: 'WEEK',
  windowFrom: day('2030-10-07'),
  windowTo: day('2030-10-11'),
  fixedStart: null,
  earliestStart: clock('08:00'),
  latestEnd: clock('15:00'),
  activityId: null,
  lastReason: null,
  lastReasonParams: null,
  lastPlannedAt: null,
  updatedAt: new Date(),
  groups: [{ studentGroupId: 'g7a' }],
  sittings: [],
  activity: null,
  ...over,
});

describe('the home classes of the pupils who write', () => {
  it('is the class itself, a half’s class, and a teaching group’s pupils’ classes, once each', () => {
    const f = facts();
    expect(homeClassesOf(['g7a'], f.byId, f.homes)).toEqual(['g7a']);
    expect(homeClassesOf(['half'], f.byId, f.homes)).toEqual(['g7a']);
    expect(homeClassesOf(['span'], f.byId, f.homes)).toEqual(['g7a', 'g7b']);
    // A teaching group with nobody on its roll is its own class, so it still shares a time with itself.
    expect(homeClassesOf(['empty'], f.byId, f.homes)).toEqual(['empty']);
    expect(homeClassesOf(['gone', 'g7b'], f.byId, f.homes)).toEqual(['g7b']);
  });
});

describe('an exam as the planner reads it', () => {
  it('names what the avbokning takes, what each named group covers, the classes, and the days they are off', () => {
    const f = facts();
    const exam = examFacts(row({ groups: [{ studentGroupId: 'g7a' }, { studentGroupId: 'deleted' }] }), f, [
      { startDate: day('2030-10-09'), endDate: day('2030-10-09'), minGradeLevel: 7, maxGradeLevel: 7 },
      { startDate: day('2030-10-10'), endDate: day('2030-10-10'), minGradeLevel: 8, maxGradeLevel: 9 },
    ])!;
    expect(exam.named).toEqual(['g7a']);
    expect([...exam.affected].sort()).toEqual(['g7a', 'half']);
    expect([...exam.coverOf.get('g7a')!].sort()).toEqual(['g7a', 'half']);
    expect(exam.classes).toEqual(['g7a']);
    expect([...exam.closed]).toEqual(['2030-10-09']);
    expect([exam.earliestStart, exam.latestEnd, exam.fixedStart]).toEqual([480, 900, null]);
    expect([exam.from, exam.to, exam.windowKind]).toEqual(['2030-10-07', '2030-10-11', 'WEEK']);
  });

  it('reads a fixed start, and nothing when none of its classes is in the year', () => {
    const fixed = examFacts(row({ windowKind: 'FIXED', fixedStart: clock('08:20'), earliestStart: null, latestEnd: null }), facts(), [])!;
    expect(fixed.fixedStart).toBe(500);
    expect(examFacts(row({ groups: [{ studentGroupId: 'deleted' }] }), facts(), [])).toBeNull();
  });
});

describe('the exams that stand', () => {
  const laid = (over: Partial<ExamRow> = {}) =>
    row({
      activityId: 'a',
      activity: { id: 'a', removedAt: null, batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: null } },
      ...over,
    });

  it('are those whose activity stands, with their date, time and classes', () => {
    const gone = laid({ id: 'e2', activity: { id: 'b', removedAt: new Date(), batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: null } } });
    expect(standingOf([laid(), gone, row({ id: 'e3' })], facts())).toEqual([{ id: 'e1', date: '2030-10-08', start: 500, end: 560, classes: ['g7a'] }]);
  });

  it('skips a laid exam whose activity carries no window', () => {
    const open = laid({ activity: { id: 'a', removedAt: null, batch: { fromDate: day('2030-10-08'), startTime: null, endTime: null, reversedAt: null } } });
    expect(standingOf([open], facts())).toEqual([]);
  });
});

describe('the days to read', () => {
  it('are the weekdays after today inside any window, once, in order', () => {
    expect(
      datesToRead(
        [
          { from: '2030-10-04', to: '2030-10-09' },
          { from: '2030-10-08', to: '2030-10-10' },
        ],
        '2030-10-06',
      ),
    ).toEqual(['2030-10-07', '2030-10-08', '2030-10-09', '2030-10-10']);
  });

  it('turns a minute of a school day into an instant in the school’s zone', () => {
    expect(instantOf('2030-07-08', 500, 'Europe/Stockholm')).toBe(Date.parse('2030-07-08T06:20:00.000Z'));
    expect(instantOf('2030-12-09', 500, 'Europe/Stockholm')).toBe(Date.parse('2030-12-09T07:20:00.000Z'));
  });
});

describe('the lessons an activity could take', () => {
  it('are asked for the groups, as scheduled and not begun, and read in the school’s minutes', async () => {
    const tx = createTxMock();
    tx.calendarLesson.findMany.mockResolvedValue([
      {
        id: 'l1',
        date: day('2030-07-09'),
        startsAt: new Date('2030-07-09T06:20:00.000Z'),
        endsAt: new Date('2030-07-09T07:20:00.000Z'),
        subjectId: 'swe',
        studentGroupId: 'g7a',
        extraGroups: [{ studentGroupId: 'g7b' }],
      },
      {
        id: 'l2',
        date: day('2030-07-09'),
        startsAt: new Date('2030-07-09T21:30:00.000Z'),
        endsAt: new Date('2030-07-09T22:00:00.000Z'),
        subjectId: 'swe',
        studentGroupId: 'g7a',
        extraGroups: [],
      },
    ]);
    const now = new Date('2030-07-01T00:00:00.000Z');
    const lessons = await readCancellableLessons(tx as never, ['g7a', 'g7b'], '2030-07-08', '2030-07-12', 'Europe/Stockholm', now);
    expect(lessons).toEqual([
      { id: 'l1', date: '2030-07-09', start: 500, end: 560, subjectId: 'swe', groupIds: ['g7a', 'g7b'] },
      { id: 'l2', date: '2030-07-09', start: 1410, end: 1440, subjectId: 'swe', groupIds: ['g7a'] },
    ]);
    expect(tx.calendarLesson.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ status: 'SCHEDULED', startsAt: { gt: now }, attendanceRecords: { none: {} }, activityLinks: { none: {} } }),
    );
  });

  it('are none when no group is named', async () => {
    const tx = createTxMock();
    expect(await readCancellableLessons(tx as never, [], '2030-07-08', '2030-07-12', 'UTC', new Date())).toEqual([]);
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });
});

describe('the loans between schools', () => {
  it('are read as the booking page reads them, and a room they name is judged by the same rule', async () => {
    const tx = createTxMock();
    tx.roomLoan.findMany.mockResolvedValue([
      { status: 'APPROVED', roomId: 'hall', localRoomId: null, dayOfWeek: 2, startTime: clock('08:00'), endTime: clock('12:00'), startDate: day('2030-09-01'), endDate: day('2030-12-31') },
    ]);
    const loans = await readLoans(tx as never);
    expect(loans).toEqual([
      { status: 'APPROVED', roomId: 'hall', localRoomId: null, dayOfWeek: 2, startTime: '08:00', endTime: '12:00', startDate: '2030-09-01', endDate: '2030-12-31' },
    ]);
    const lent = loanCheck(loans, 'UTC');
    const tuesday = { date: '2030-10-08', start: Date.parse('2030-10-08T09:00:00.000Z'), end: Date.parse('2030-10-08T10:00:00.000Z') };
    expect(lent('hall', tuesday)).toBe(true);
    expect(lent('other', tuesday)).toBe(false);
    expect(lent('hall', { ...tuesday, date: '2030-10-09', start: tuesday.start + 86_400_000, end: tuesday.end + 86_400_000 })).toBe(false);
  });
});

describe('what holds a room', () => {
  it('is its lessons, its bookings and its closures, the weekly ones on their weekday', async () => {
    const tx = createTxMock();
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: 'rl', date: day('2030-10-08'), roomId: 'r1', startsAt: new Date('2030-10-08T08:00:00.000Z'), endsAt: new Date('2030-10-08T09:00:00.000Z'), status: 'SCHEDULED', studentGroupId: 'g7a', extraGroups: [{ studentGroupId: 'g7b' }] },
    ]);
    tx.roomBooking.findMany.mockResolvedValue([{ roomId: 'r1', startsAt: new Date('2030-10-09T08:00:00.000Z'), endsAt: new Date('2030-10-09T10:00:00.000Z') }]);
    tx.availabilityConstraint.findMany.mockResolvedValue([
      { roomId: 'r2', date: day('2030-10-09'), dayOfWeek: null, startTime: clock('10:00'), endTime: clock('11:00') },
      { roomId: 'r2', date: null, dayOfWeek: 1, startTime: clock('13:00'), endTime: clock('14:00') },
      { roomId: 'r2', date: null, dayOfWeek: 2, startTime: clock('13:00'), endTime: clock('14:00') },
      { roomId: null, date: day('2030-10-09'), dayOfWeek: null, startTime: clock('10:00'), endTime: clock('11:00') },
    ]);
    const uses = await readRoomUses(tx as never, ['r1', 'r2'], ['2030-10-07', '2030-10-08', '2030-10-09'], 'UTC');
    expect(uses.get('r1')).toEqual({
      lessons: [{ id: 'rl', date: '2030-10-08', start: Date.parse('2030-10-08T08:00:00.000Z'), end: Date.parse('2030-10-08T09:00:00.000Z'), status: 'SCHEDULED', groupIds: ['g7a', 'g7b'] }],
      bookings: [{ start: Date.parse('2030-10-09T08:00:00.000Z'), end: Date.parse('2030-10-09T10:00:00.000Z') }],
      closures: [],
    });
    // The dated closure on its date, the Monday one on the 7th, the Tuesday one on the 8th.
    expect(uses.get('r2')!.closures.map((span) => new Date(span.start).toISOString())).toEqual([
      '2030-10-07T13:00:00.000Z',
      '2030-10-08T13:00:00.000Z',
      '2030-10-09T10:00:00.000Z',
    ]);
  });

  it('is nothing to read for no rooms or no days', async () => {
    const tx = createTxMock();
    expect((await readRoomUses(tx as never, [], ['2030-10-08'], 'UTC')).size).toBe(0);
    expect((await readRoomUses(tx as never, ['r1'], [], 'UTC')).size).toBe(0);
  });
});
