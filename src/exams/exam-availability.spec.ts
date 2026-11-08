import type { PersonDay, PersonLesson } from '../cover/cover-rules';
import { roomBlocks, roomFreeFor, teacherBlocks, teacherFreeFor, type RoomDayUse, type SlotSpan } from './exam-availability';

const H = 3_600_000;
// 2030-10-08 08:00 UTC as the base instant; the slots below are hours from it.
const BASE = Date.UTC(2030, 9, 8, 8, 0, 0);
const slot = (fromHour: number, toHour: number, date = '2030-10-08'): SlotSpan => ({ date, start: BASE + fromHour * H, end: BASE + toHour * H });

const lessonOf = (id: string, fromHour: number, toHour: number, group: string, status: PersonLesson['status'] = 'SCHEDULED'): PersonLesson => ({
  id,
  date: '2030-10-08',
  start: BASE + fromHour * H,
  end: BASE + toHour * H,
  status,
  studentGroupId: group,
  subjectId: 's',
});

const day = (over: Partial<PersonDay> = {}): PersonDay => ({
  userId: 't1',
  isActiveTeacher: true,
  lessons: [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: true, windows: [] },
  ...over,
});

const none: ReadonlySet<string> = new Set();
const takes = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('who is free for an exam', () => {
  it('is free when nothing holds the time', () => {
    expect(teacherFreeFor(day(), slot(0, 1), none)).toBe(true);
  });

  it('is busy in a lesson the exam does not take, and free in one it does', () => {
    const busy = day({ lessons: [lessonOf('l1', 0, 1, '7a')] });
    expect(teacherFreeFor(busy, slot(0, 1), none)).toBe(false);
    expect(teacherFreeFor(busy, slot(0, 1), takes('9b'))).toBe(false);
    expect(teacherFreeFor(busy, slot(0, 1), takes('7a'))).toBe(true);
  });

  it('frees a teacher only by the exam’s own day: a lesson dated otherwise is read as it stands', () => {
    const other: PersonLesson = { ...lessonOf('l1', 0, 1, '7a'), date: '2030-10-09' };
    expect(teacherFreeFor(day({ lessons: [other] }), slot(0, 1), takes('7a'))).toBe(false);
  });

  it('stays busy when absent, on a supervision pass, in a duty or a closure, or holding a room', () => {
    expect(teacherFreeFor(day({ absences: [slot(0, 2)] }), slot(0, 1), takes('7a'))).toBe(false);
    expect(teacherFreeFor(day({ bookings: [slot(0, 2)] }), slot(0, 1), takes('7a'))).toBe(false);
    expect(teacherFreeFor(day({ closures: [{ span: slot(0, 2), kind: 'DUTY', label: 'möte' }] as unknown as PersonDay['closures'] }), slot(0, 1), takes('7a'))).toBe(false);
  });

  it('is not free for a substitute-pool member without a post who declared no window over the time', () => {
    const pool = { member: true, hasEmployment: false, windows: [] };
    expect(teacherFreeFor(day({ pool }), slot(0, 1), none)).toBe(false);
    expect(teacherFreeFor(day({ pool: { ...pool, windows: [slot(0, 2)] } }), slot(0, 1), none)).toBe(true);
  });

  it('touching is free: a lesson that ends where the exam begins', () => {
    expect(teacherFreeFor(day({ lessons: [lessonOf('l1', 0, 1, '9b')] }), slot(1, 2), none)).toBe(true);
  });
});

describe('the slots a teacher is busy at', () => {
  const slots = [slot(0, 1), slot(1, 2), slot(2, 3)];

  it('lists the busy slots by index and leaves out a teacher who is free at all', () => {
    const days = new Map([
      [
        '2030-10-08',
        new Map([
          ['t1', day({ userId: 't1', lessons: [lessonOf('l1', 1, 2, '9b')] })],
          ['t2', day({ userId: 't2' })],
        ]),
      ],
    ]);
    const blocks = teacherBlocks(['t1', 't2'], days, none, slots);
    expect([...blocks]).toEqual([['t1', [1]]]);
  });

  it('counts a teacher with no day as busy at every slot of that date', () => {
    const blocks = teacherBlocks(['t3'], new Map([['2030-10-08', new Map()]]), none, slots);
    expect(blocks.get('t3')).toEqual([0, 1, 2]);
  });
});

const roomUse = (over: Partial<RoomDayUse> = {}): RoomDayUse => ({ lessons: [], bookings: [], closures: [], ...over });
const roomLesson = (id: string, fromHour: number, toHour: number, groupIds: string[], status: 'SCHEDULED' | 'CANCELLED' = 'SCHEDULED') => ({
  id,
  date: '2030-10-08',
  start: BASE + fromHour * H,
  end: BASE + toHour * H,
  status,
  groupIds,
});
const noLoan = () => false;

describe('what room is free for an exam', () => {
  it('is free when no lesson, booking or closure holds it', () => {
    expect(roomFreeFor('r1', undefined, slot(0, 1), none, noLoan)).toBe(true);
    expect(roomFreeFor('r1', roomUse(), slot(0, 1), none, noLoan)).toBe(true);
  });

  it('is taken by a lesson of a group the exam does not take, and emptied by one it does', () => {
    const use = roomUse({ lessons: [roomLesson('l1', 0, 1, ['7a'])] });
    expect(roomFreeFor('r1', use, slot(0, 1), none, noLoan)).toBe(false);
    expect(roomFreeFor('r1', use, slot(0, 1), takes('7a'), noLoan)).toBe(true);
    // A shared lesson with the group among its extra groups is the exam's too.
    const shared = roomUse({ lessons: [roomLesson('l2', 0, 1, ['9b', '7a'])] });
    expect(roomFreeFor('r1', shared, slot(0, 1), takes('7a'), noLoan)).toBe(true);
  });

  it('ignores the lessons of other dates and cancelled lessons', () => {
    const other = roomUse({ lessons: [{ ...roomLesson('l1', 0, 1, ['9b']), date: '2030-10-09' }] });
    expect(roomFreeFor('r1', other, slot(0, 1), none, noLoan)).toBe(true);
    const cancelled = roomUse({ lessons: [roomLesson('l1', 0, 1, ['9b'], 'CANCELLED')] });
    expect(roomFreeFor('r1', cancelled, slot(0, 1), none, noLoan)).toBe(true);
  });

  it('is taken by a booking, a closure, or a loan', () => {
    expect(roomFreeFor('r1', roomUse({ bookings: [slot(0, 2)] }), slot(0, 1), takes('7a'), noLoan)).toBe(false);
    expect(roomFreeFor('r1', roomUse({ closures: [slot(0, 2)] }), slot(0, 1), takes('7a'), noLoan)).toBe(false);
    expect(roomFreeFor('r1', roomUse(), slot(0, 1), none, (id) => id === 'r1')).toBe(false);
  });

  it('lists the rooms’ taken slots by index, leaving out a room free at all', () => {
    const uses = new Map([['r1', roomUse({ lessons: [roomLesson('l1', 2, 3, ['9b'])] })]]);
    const blocks = roomBlocks(['r1', 'r2'], uses, none, [slot(0, 1), slot(2, 3)], noLoan);
    expect([...blocks]).toEqual([['r1', [1]]]);
  });
});
