import { zonedTimeToUtc } from '../common/utils/time';
import { liftWindow } from './cover-context';
import {
  hardFindings,
  hasGap,
  isFeasible,
  prefersFree,
  softWarnings,
  type CoverTarget,
  type PersonDay,
  type PersonLesson,
} from './cover-rules';

const TZ = 'Europe/Stockholm';
const D = '2026-10-14'; // a Wednesday
const at = (time: string, date = D) => zonedTimeToUtc(date, time, TZ).getTime();
const clock = (time: string) => new Date(`1970-01-01T${time}:00.000Z`);

const day = (overrides: Partial<PersonDay> = {}): PersonDay => ({
  userId: 'sub',
  isActiveTeacher: true,
  lessons: [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: false, windows: [] },
  ...overrides,
});

const target = (from = '10:00', to = '11:00', date = D, teacherIds: string[] = ['absent']): CoverTarget => ({
  id: 'cover',
  date,
  start: at(from, date),
  end: at(to, date),
  teacherIds,
});

const lesson = (id: string, from: string, to: string, overrides: Partial<PersonLesson> = {}): PersonLesson => ({
  id,
  date: overrides.date ?? D,
  start: at(from, overrides.date ?? D),
  end: at(to, overrides.date ?? D),
  status: 'SCHEDULED',
  studentGroupId: 'g',
  subjectId: 's',
  ...overrides,
});

const codes = (person: PersonDay, cover = target(), added: PersonLesson[] = []) =>
  hardFindings(person, cover, added).map((finding) => finding.code);

describe('cover rules', () => {
  describe('lessons', () => {
    it('an overlapping lesson excludes; one ending at the start is free', () => {
      expect(codes(day({ lessons: [lesson('a', '09:30', '10:30')] }))).toEqual(['BUSY_LESSON']);
      expect(codes(day({ lessons: [lesson('a', '09:00', '10:00')] }))).toEqual([]);
      expect(codes(day({ lessons: [lesson('a', '11:00', '12:00')] }))).toEqual([]);
    });

    it('a COMPLETED lesson holds its time as a SCHEDULED one does', () => {
      expect(codes(day({ lessons: [lesson('a', '10:15', '10:45', { status: 'COMPLETED' })] }))).toEqual(['BUSY_LESSON']);
    });

    it('an own CANCELLED lesson at that time leaves the person free', () => {
      expect(codes(day({ lessons: [lesson('a', '10:00', '11:00', { status: 'CANCELLED' })] }))).toEqual([]);
    });

    it('somebody already on the lesson is ON_LESSON', () => {
      expect(codes(day({ userId: 'absent' }))).toEqual(['ON_LESSON']);
    });

    it('an inactive or non-teacher person is INACTIVE', () => {
      expect(codes(day({ isActiveTeacher: false }))).toEqual(['INACTIVE']);
    });
  });

  describe('closures', () => {
    it('a weekly duty slot excludes and names the uppdrag, never a note', () => {
      const span = liftWindow(D, clock('10:30'), clock('11:30'), TZ);
      const findings = hardFindings(day({ closures: [{ span, kind: 'DUTY', label: 'Rastvakt' }] }), target());
      expect(findings).toEqual([{ code: 'BUSY_DUTY', params: { label: 'Rastvakt' } }]);
    });

    it('a dated UNAVAILABLE row excludes with no params at all (its reason is free text)', () => {
      const span = liftWindow(D, clock('08:00'), clock('10:30'), TZ);
      expect(hardFindings(day({ closures: [{ span, kind: 'UNAVAILABLE', label: null }] }), target())).toEqual([
        { code: 'UNAVAILABLE', params: {} },
      ]);
    });

    it('a full-day 00:00–23:59 row covers the whole day', () => {
      const span = liftWindow(D, clock('00:00'), clock('23:59'), TZ);
      expect(span).toEqual({ start: at('00:00'), end: zonedTimeToUtc('2026-10-15', '00:00', TZ).getTime() });
      expect(codes(day({ closures: [{ span, kind: 'UNAVAILABLE', label: null }] }), target('16:00', '17:00'))).toEqual([
        'UNAVAILABLE',
      ]);
    });

    it('PREFERRED_FREE does not exclude; it is a ranking penalty', () => {
      const person = day({ preferredFree: [{ start: at('10:00'), end: at('12:00') }] });
      expect(codes(person)).toEqual([]);
      expect(prefersFree(person, target())).toBe(true);
    });
  });

  it('a booking the person holds excludes (the reader keeps PENDING and APPROVED only)', () => {
    expect(codes(day({ bookings: [{ start: at('10:30'), end: at('11:30') }] }))).toEqual(['BOOKED_ROOM']);
    expect(codes(day({ bookings: [{ start: at('11:00'), end: at('12:00') }] }))).toEqual([]);
  });

  describe('lunch', () => {
    const lunch = { minutes: 30, window: { start: at('11:00'), end: at('13:00') } };

    it('excludes a cover that takes the last 30-minute gap in the window', () => {
      const person = day({ lunch, lessons: [lesson('a', '11:00', '12:00'), lesson('b', '12:30', '13:00')] });
      expect(codes(person, target('12:00', '12:30'))).toEqual(['LUNCH']);
    });

    it('does not blame the cover for a lunch already impossible', () => {
      const person = day({ lunch, lessons: [lesson('a', '11:00', '12:40'), lesson('b', '12:50', '13:00')] });
      expect(codes(person, target('12:40', '12:50'))).toEqual([]);
    });

    it('an exact fit is fine', () => {
      const person = day({ lunch, lessons: [lesson('a', '11:00', '12:00')] });
      expect(codes(person, target('12:30', '13:00'))).toEqual([]);
    });

    it('a cover outside the window is irrelevant to it', () => {
      const person = day({ lunch, lessons: [lesson('a', '11:00', '12:40')] });
      expect(codes(person, target('14:00', '15:00'))).toEqual([]);
    });

    it('bookings and closures count as busy inside the window', () => {
      const person = day({
        lunch,
        bookings: [{ start: at('11:00'), end: at('12:00') }],
        closures: [{ span: { start: at('12:30'), end: at('13:00') }, kind: 'DUTY', label: 'Rastvakt' }],
      });
      expect(codes(person, target('12:00', '12:30'))).toEqual(['LUNCH']);
    });
  });

  describe('daily rest', () => {
    const rest = 11 * 60;

    it('is broken against the day before', () => {
      const person = day({ minDailyRestMinutes: rest, lessons: [lesson('y', '19:00', '21:00', { date: '2026-10-13' }), lesson('a', '10:00', '11:00')] });
      // 21:00 → 08:00 is exactly 11 h: fine; 21:00 → 07:00 is not.
      expect(codes(person, target('08:00', '09:00'))).toEqual([]);
      expect(codes(person, target('07:00', '08:00'))).toEqual(['DAILY_REST']);
    });

    it('is broken against the day after', () => {
      const person = day({ minDailyRestMinutes: rest, lessons: [lesson('t', '07:00', '08:00', { date: '2026-10-15' })] });
      expect(codes(person, target('19:00', '20:00'))).toEqual([]);
      expect(codes(person, target('20:00', '21:00'))).toEqual(['DAILY_REST']);
    });

    it('a rest already broken is not newly broken', () => {
      const person = day({
        minDailyRestMinutes: rest,
        lessons: [lesson('y', '21:00', '22:00', { date: '2026-10-13' }), lesson('a', '07:00', '08:00')],
      });
      expect(codes(person, target('08:00', '09:00'))).toEqual([]);
    });
  });

  describe('absence', () => {
    it('an absence starting inside the lesson excludes', () => {
      const person = day({ absences: [{ start: at('11:00'), end: at('15:00') }] });
      expect(codes(person, target('10:30', '11:30'))).toEqual(['ABSENT']);
    });

    it('an absence ending at the lesson’s start does not', () => {
      const person = day({ absences: [{ start: at('08:00'), end: at('10:00') }] });
      expect(codes(person, target('10:00', '11:00'))).toEqual([]);
    });
  });

  describe('the pool', () => {
    const member = (windows: { start: number; end: number }[], hasEmployment = false) =>
      day({ pool: { member: true, hasEmployment, windows } });

    it('a member without a post and no window is excluded', () => {
      expect(codes(member([]))).toEqual(['POOL_NOT_DECLARED']);
    });

    it('a window covering only part of the lesson is not enough', () => {
      expect(codes(member([{ start: at('10:30'), end: at('16:00') }]))).toEqual(['POOL_NOT_DECLARED']);
    });

    it('a weekly window lifted onto the weekday contains it', () => {
      expect(codes(member([liftWindow(D, clock('08:00'), clock('16:00'), TZ)]))).toEqual([]);
    });

    it('a member with a post follows the normal rules', () => {
      expect(codes(member([], true))).toEqual([]);
    });
  });

  it('DST: Monday 2026-10-26, the day after Stockholm left summer time, lifts wall clocks at +01:00', () => {
    const monday = '2026-10-26';
    const window = liftWindow(monday, clock('10:00'), clock('11:00'), TZ);
    expect(new Date(window.start).toISOString()).toBe('2026-10-26T09:00:00.000Z');
    const person = day({ closures: [{ span: window, kind: 'UNAVAILABLE', label: null }] });
    expect(codes(person, target('10:00', '11:00', monday))).toEqual(['UNAVAILABLE']);
    expect(codes(person, target('11:00', '12:00', monday))).toEqual([]);
    // The Sunday of the change is 25 hours long.
    const sunday = liftWindow('2026-10-25', clock('00:00'), clock('23:59'), TZ);
    expect((sunday.end - sunday.start) / 3_600_000).toBe(25);
  });

  it('a lesson given earlier in the same proposal counts as SCHEDULED', () => {
    expect(isFeasible(day(), target())).toBe(true);
    expect(codes(day(), target(), [lesson('earlier', '10:30', '11:30')])).toEqual(['BUSY_LESSON']);
  });

  it('hasGap counts a gap at either edge and an exact fit', () => {
    const window = { start: 0, end: 60 * 60_000 };
    expect(hasGap([{ start: 0, end: 30 * 60_000 }], window, 30)).toBe(true);
    expect(hasGap([{ start: 30 * 60_000, end: 60 * 60_000 }], window, 30)).toBe(true);
    expect(hasGap([{ start: 10 * 60_000, end: 40 * 60_000 }], window, 30)).toBe(false);
  });

  it('a manual pick hears the overridable rules as warnings, once each', () => {
    expect(
      softWarnings([
        { code: 'LUNCH', params: { minutes: 30 } },
        { code: 'BUSY_DUTY', params: { label: 'APT' } },
        { code: 'UNAVAILABLE', params: {} },
        { code: 'BUSY_LESSON', params: { lessonId: 'x' } },
        { code: 'ABSENT', params: {} },
      ]),
    ).toEqual([
      { code: 'COVER_BREAKS_LUNCH', params: { minutes: 30 } },
      { code: 'COVER_TEACHER_UNAVAILABLE', params: { label: 'APT' } },
    ]);
  });
});
