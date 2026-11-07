import { zonedTimeToUtc } from '../common/utils/time';
import { liftWindow } from './cover-context';
import {
  hardFindings,
  hasGap,
  isFeasible,
  maskFindings,
  maskWarnings,
  occupancyFindings,
  passTargetId,
  poolNotDeclared,
  prefersFree,
  softWarnings,
  toldFromPost,
  type CoverTarget,
  type PersonDay,
  type PersonLesson,
  type PersonPass,
  type RuleFinding,
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

  describe('the daily cap (Lärarens dag)', () => {
    it('an exact fit is fine; a minute over is not, and names the cap', () => {
      // 08:00–10:00 own, 10:00–11:00 the cover: 180 minutes.
      const person = (cap: number) => day({ dailyCapMinutes: cap, lessons: [lesson('a', '08:00', '10:00')] });
      expect(codes(person(180))).toEqual([]);
      expect(hardFindings(person(175), target())).toEqual([{ code: 'DAILY_CAP', params: { minutes: 175 } }]);
    });

    it('counts two overlapping lessons as their union, as src/common/teacher-day.ts does', () => {
      // 08:00–09:20 and 09:00–10:00 are 120 minutes together, not 140: with the cover's 60, 180.
      const person = day({ dailyCapMinutes: 180, lessons: [lesson('a', '08:00', '09:20'), lesson('b', '09:00', '10:00')] });
      expect(codes(person)).toEqual([]);
      expect(codes({ ...person, dailyCapMinutes: 179 })).toEqual(['DAILY_CAP']);
    });

    it('counts the cover’s date only, lessons that hold their time only, and the cover once', () => {
      const person = day({
        dailyCapMinutes: 60,
        lessons: [
          lesson('tomorrow', '08:00', '12:00', { date: '2026-10-15' }),
          lesson('off', '08:00', '09:00', { status: 'CANCELLED' }),
          // Their own row on the covered lesson is the cover's span again.
          lesson('cover', '10:00', '11:00'),
        ],
      });
      expect(codes(person)).toEqual([]);
      expect(codes({ ...person, lessons: [lesson('held', '08:00', '09:00', { status: 'COMPLETED' })] })).toEqual(['DAILY_CAP']);
    });

    it('fires on a day already over the cap: unlike the lunch, every lesson makes it longer', () => {
      expect(codes(day({ dailyCapMinutes: 60, lessons: [lesson('a', '08:00', '10:00')] }), target('13:00', '14:00'))).toEqual(['DAILY_CAP']);
    });

    it('counts a pick given earlier in the same proposal', () => {
      const person = day({ dailyCapMinutes: 120, lessons: [lesson('a', '08:00', '09:00')] });
      expect(codes(person)).toEqual([]);
      expect(codes(person, target(), [lesson('earlier', '13:00', '14:00')])).toEqual(['DAILY_CAP']);
    });

    it('no cap, no rule', () => {
      expect(codes(day({ lessons: [lesson('a', '00:00', '10:00'), lesson('b', '11:00', '23:00')] }))).toEqual([]);
    });
  });

  describe('the stretch of teaching (Sammanhängande undervisning)', () => {
    /** At most two hours in a row, then half an hour free. */
    const IN_A_ROW = { maxConsecutiveTeachingMinutes: 120, consecutiveBreakMinutes: 30 };
    const limit = (max: number, pause: number) => ({ maxConsecutiveTeachingMinutes: max, consecutiveBreakMinutes: pause });
    const stretch = (max: number, pause: number) => ({
      code: 'CONSECUTIVE_TEACHING',
      params: { minutes: max, breakMinutes: pause },
    });

    it('an exact fit is fine; a minute over is not, and names the limit and the free time', () => {
      // 09:00–10:00 own, 10:00–11:00 the cover: 120 minutes in a row.
      expect(codes(day({ ...IN_A_ROW, lessons: [lesson('a', '09:00', '10:00')] }))).toEqual([]);
      expect(hardFindings(day({ ...IN_A_ROW, lessons: [lesson('a', '08:59', '10:00')] }), target())).toEqual([
        stretch(120, 30),
      ]);
    });

    it('a gap of exactly the free time is a break; five minutes short of it is not', () => {
      // 08:00–09:30 own, then the cover 10:00–11:00: 90 and 60 minutes, or 180 together.
      const at90 = limit(90, 30);
      expect(codes(day({ ...at90, lessons: [lesson('a', '08:00', '09:30')] }))).toEqual([]);
      expect(codes(day({ ...at90, lessons: [lesson('a', '08:00', '09:35')] }))).toEqual(['CONSECUTIVE_TEACHING']);
      // And after the cover, the same way round.
      expect(codes(day({ ...at90, lessons: [lesson('a', '11:30', '13:00')] }))).toEqual([]);
      expect(codes(day({ ...at90, lessons: [lesson('a', '11:25', '13:00')] }))).toEqual(['CONSECUTIVE_TEACHING']);
    });

    it('only the cover’s own stretch counts: one it does not touch is not its fault, and the cap, unlike it, fires', () => {
      const morning = [lesson('a', '08:00', '11:00')];
      // A three-hour morning stands; a lesson after the lunch break joins nothing.
      expect(codes(day({ ...IN_A_ROW, lessons: morning }), target('13:00', '14:00'))).toEqual([]);
      expect(codes(day({ dailyCapMinutes: 60, lessons: morning }), target('13:00', '14:00'))).toEqual(['DAILY_CAP']);
      // One that lengthens the stretch is.
      expect(codes(day({ ...IN_A_ROW, lessons: morning }), target('11:00', '12:00'))).toEqual(['CONSECUTIVE_TEACHING']);
      // And one that is already too long and is lengthened by the cover at its front.
      expect(codes(day({ ...IN_A_ROW, lessons: [lesson('a', '10:00', '13:00')] }), target('09:00', '10:00'))).toEqual([
        'CONSECUTIVE_TEACHING',
      ]);
    });

    it('a cover that joins two short stretches into a long one is refused', () => {
      const person = day({ ...IN_A_ROW, lessons: [lesson('a', '08:00', '09:00'), lesson('b', '10:30', '11:30')] });
      // Alone, 60 and 60; with the cover between them, 08:00–11:30.
      expect(codes(person, target('09:00', '10:30'))).toEqual(['CONSECUTIVE_TEACHING']);
      // Between them with room to spare on both sides, it is a stretch of its own.
      expect(codes(person, target('09:30', '10:00'))).toEqual([]);
    });

    it('counts two overlapping lessons as one stretch', () => {
      // 08:00–09:20 and 09:00–10:00 with the cover 10:00–11:00: 08:00–11:00.
      const person = day({ lessons: [lesson('a', '08:00', '09:20'), lesson('b', '09:00', '10:00')] });
      expect(codes({ ...person, ...limit(180, 30) })).toEqual([]);
      expect(codes({ ...person, ...limit(175, 30) })).toEqual(['CONSECUTIVE_TEACHING']);
    });

    it('counts the cover’s date only, lessons that hold their time only, and the cover once', () => {
      const person = day({
        ...limit(60, 30),
        lessons: [
          // A night ends a stretch, and tomorrow's lessons are another day's.
          lesson('yesterday', '15:00', '20:00', { date: '2026-10-13' }),
          lesson('tomorrow', '08:00', '12:00', { date: '2026-10-15' }),
          lesson('off', '08:00', '10:00', { status: 'CANCELLED' }),
          lesson('moved', '08:00', '10:00', { status: 'RESCHEDULED' }),
          // Their own row on the covered lesson is the cover's span again.
          lesson('cover', '10:00', '11:00'),
        ],
      });
      expect(codes(person)).toEqual([]);
      expect(codes({ ...person, lessons: [lesson('held', '09:00', '10:00', { status: 'COMPLETED' })] })).toEqual([
        'CONSECUTIVE_TEACHING',
      ]);
    });

    it('a night ends a stretch: the evening before is not in the cover’s stretch after midnight', () => {
      const person = day({ ...limit(60, 30), lessons: [lesson('late', '22:00', '23:55', { date: '2026-10-13' })] });
      expect(codes(person, target('00:05', '01:00'))).toEqual([]);
    });

    it('counts a pick given earlier in the same proposal, as a scheduled lesson', () => {
      const person = day({ ...IN_A_ROW, lessons: [lesson('a', '09:00', '10:00')] });
      expect(codes(person)).toEqual([]);
      expect(codes(person, target(), [lesson('earlier', '11:00', '12:00')])).toEqual(['CONSECUTIVE_TEACHING']);
      // A pick that stands apart from the cover's stretch leaves it alone.
      expect(codes(person, target(), [lesson('earlier', '13:00', '14:00')])).toEqual([]);
    });

    it('a rastvaktspass of theirs is not teaching: it neither makes a stretch longer nor bridges two', () => {
      // 08:00–09:00 and the cover 09:30–10:30 are 60 minutes each; a pass between them is no lesson.
      const person = day({ ...limit(90, 30), lessons: [lesson('a', '08:00', '09:00')], supervision: [
        { id: passTargetId('yard', D), date: D, start: at('09:00'), end: at('09:30') },
      ] });
      expect(codes(person, target('09:30', '10:30'))).toEqual([]);
    });

    it('no limit, no rule: neither figure, nor only one of them', () => {
      const lessons = [lesson('a', '00:00', '10:00'), lesson('b', '11:00', '23:00')];
      expect(codes(day({ lessons }))).toEqual([]);
      expect(codes(day({ lessons, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null }))).toEqual([]);
      // The table's CHECK keeps the pair whole; the rule is not read from half of one.
      expect(codes(day({ lessons, maxConsecutiveTeachingMinutes: 30 }))).toEqual([]);
      expect(codes(day({ lessons, consecutiveBreakMinutes: 30 }))).toEqual([]);
    });

    it('is a finding of its own, between the cap and the days', () => {
      const person = day({
        ...limit(60, 30),
        dailyCapMinutes: 60,
        maxTeachingDaysPerWeek: 1,
        weekTeachingDates: ['2026-10-12'],
        lessons: [lesson('a', '09:00', '10:00')],
      });
      expect(codes(person)).toEqual(['DAILY_CAP', 'CONSECUTIVE_TEACHING', 'WORK_DAYS']);
    });

    it('is HR data, the post’s like the days: the verdict is the same for every reader, the figures reach those with HR-läs only', () => {
      const finding: RuleFinding = { code: 'CONSECUTIVE_TEACHING', params: { minutes: 120, breakMinutes: 30 } };
      // hardFindings never asks who is reading: the finding carries the figures.
      expect(maskFindings([finding], true)).toEqual([finding]);
      expect(maskFindings([finding], false)).toEqual([{ code: 'CONSECUTIVE_TEACHING_HIDDEN', params: {} }]);
      // And the warning a manual pick hears, from the unmasked finding.
      const warnings = softWarnings([finding]);
      expect(warnings).toEqual([{ code: 'COVER_EXCEEDS_CONSECUTIVE_TEACHING', params: { minutes: 120, breakMinutes: 30 } }]);
      expect(maskWarnings(warnings, true)).toEqual(warnings);
      expect(maskWarnings(warnings, false)).toEqual([{ code: 'COVER_EXCEEDS_CONSECUTIVE_TEACHING_HIDDEN', params: {} }]);
    });

    it('without HR-läs not one figure of the limit is left in what a reader is told, finding or warning', () => {
      const person = day({ ...limit(137, 43), lessons: [lesson('a', '08:00', '10:00')] });
      const found = hardFindings(person, target());
      expect(found).toEqual([stretch(137, 43)]);
      const told = JSON.stringify([maskFindings(found, false), maskWarnings(softWarnings(found), false)]);
      expect(told).toContain('CONSECUTIVE_TEACHING_HIDDEN');
      expect(told).toContain('COVER_EXCEEDS_CONSECUTIVE_TEACHING_HIDDEN');
      expect(told).not.toMatch(/137|43|minutes|breakMinutes/);
      // With HR-läs they are there.
      expect(JSON.stringify([maskFindings(found, true), maskWarnings(softWarnings(found), true)])).toMatch(/137[^]*43/);
    });

    it('is a read of the post for the callers to record, masked or not', () => {
      const found = hardFindings(day({ ...limit(137, 43), lessons: [lesson('a', '08:00', '10:00')] }), target());
      expect(toldFromPost(found)).toBe(true);
      expect(toldFromPost(maskFindings(found, false))).toBe(true);
      expect(toldFromPost(hardFindings(day({ lessons: [lesson('a', '08:00', '10:00')] }), target()))).toBe(false);
    });

    describe('property: the cover’s own stretch, against a closure over the lessons, and monotone', () => {
      /** mulberry32 — a fixed seed per day, so a failure names its day. */
      const rng = (seed: number) => () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
      const MIN = 60_000;
      type Slot = { id: string; from: number; to: number };

      /**
       * The oracle, by another road than the sweep: the lessons that chain to
       * the cover when two belong together if each starts before the other's
       * end plus the free time, taken to a fixpoint — and that stretch is as
       * long as from its first start to its last end.
       */
      function oracle(slots: Slot[], cover: Slot, max: number, pause: number): boolean {
        const joined = new Set<Slot>([cover]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const slot of slots) {
            if (joined.has(slot)) continue;
            if ([...joined].some((m) => slot.from < m.to + pause && m.from < slot.to + pause)) {
              joined.add(slot);
              grew = true;
            }
          }
        }
        const members = [...joined];
        return Math.max(...members.map((m) => m.to)) - Math.min(...members.map((m) => m.from)) > max;
      }

      const fired = (person: PersonDay, cover: CoverTarget, added: PersonLesson[]) =>
        hardFindings(person, cover, added).some((finding) => finding.code === 'CONSECUTIVE_TEACHING');

      it.each(Array.from({ length: 300 }, (_, seed) => [seed]))('day %i', (seed) => {
        const random = rng(seed + 1);
        const grid = (minutes: number) => at('07:00') + minutes * MIN;
        const pause = 5 * (1 + Math.floor(random() * 12));
        const max = 30 + 15 * Math.floor(random() * 12);
        // Lessons and the cover on a five-minute grid, never sharing a minute with the
        // cover (that is BUSY_LESSON's, not this rule's), with gaps around the free time.
        const coverFrom = 120 + 5 * Math.floor(random() * 60);
        const coverTo = coverFrom + 30 + 5 * Math.floor(random() * 12);
        const slots: Slot[] = [];
        for (let k = 0; k < 2 + Math.floor(random() * 6); k++) {
          const from = 5 * Math.floor(random() * 150);
          const to = from + 20 + 5 * Math.floor(random() * 14);
          if (from < coverTo && coverFrom < to) continue;
          slots.push({ id: `s${k}`, from, to });
        }
        const lessonOf = (slot: Slot): PersonLesson => ({
          id: slot.id,
          date: D,
          start: grid(slot.from),
          end: grid(slot.to),
          status: 'SCHEDULED',
          studentGroupId: 'g',
          subjectId: 's',
        });
        const cover: CoverTarget = { id: 'cover', date: D, start: grid(coverFrom), end: grid(coverTo), teacherIds: ['absent'] };
        const coverSlot: Slot = { id: 'cover', from: coverFrom, to: coverTo };
        const person = day({ ...limit(max, pause) });

        // The stored lessons and the picks given earlier are one set to the rule.
        const split = Math.floor(random() * (slots.length + 1));
        const whole = (picked: Slot[]) =>
          fired({ ...person, lessons: slots.slice(0, split).map(lessonOf) }, cover, picked.map(lessonOf));
        const stored = slots.slice(0, split);
        const added = slots.slice(split);
        expect({ seed, fires: fired({ ...person, lessons: stored.map(lessonOf) }, cover, added.map(lessonOf)) }).toEqual({
          seed,
          fires: oracle(slots, coverSlot, max, pause),
        });

        // Monotone: a subset of the picks never fires where the whole set does not.
        for (let mask = 0; mask < 1 << added.length; mask++) {
          const subset = added.filter((_, index) => (mask >> index) & 1);
          if (!whole(added)) expect({ seed, mask, fires: whole(subset) }).toEqual({ seed, mask, fires: false });
        }
      });
    });
  });

  describe('the deltid in days (Lärarens dag)', () => {
    // D is Wednesday 14 October; its ISO week runs 12–18 October.
    const week = (...dates: string[]) => dates.map((d) => `2026-10-${d}`);

    it('a date the person already teaches on costs no day, however many the week holds', () => {
      expect(codes(day({ maxTeachingDaysPerWeek: 3, weekTeachingDates: week('12', '13', '14', '15') }))).toEqual([]);
    });

    it('a new date fires once the week would hold more than the post allows, and names the limit', () => {
      expect(hardFindings(day({ maxTeachingDaysPerWeek: 3, weekTeachingDates: week('12', '13', '15') }), target())).toEqual([
        { code: 'WORK_DAYS', params: { days: 3 } },
      ]);
      expect(codes(day({ maxTeachingDaysPerWeek: 3, weekTeachingDates: week('12', '13') }))).toEqual([]);
    });

    it('two picks on one new date: each is judged against the stored week, so neither passes for the other', () => {
      const person = day({ maxTeachingDaysPerWeek: 3, weekTeachingDates: week('12', '13', '15') });
      // Judged against the stored week and the picks, the second would find
      // Wednesday taught by the first and pass: a fourth day for a three-day post.
      expect(codes(person, target('13:00', '14:00'), [lesson('first', '10:00', '11:00')])).toEqual(['WORK_DAYS']);
      // Two picks on one new date that fits stay one day.
      const room = day({ maxTeachingDaysPerWeek: 3, weekTeachingDates: week('12', '13') });
      expect(codes(room, target('13:00', '14:00'), [lesson('first', '10:00', '11:00')])).toEqual([]);
    });

    it('a pick on another new date of the week is a day too', () => {
      const person = day({ maxTeachingDaysPerWeek: 2, weekTeachingDates: week('12') });
      expect(codes(person)).toEqual([]);
      expect(codes(person, target(), [lesson('thursday', '10:00', '11:00', { date: '2026-10-15' })])).toEqual(['WORK_DAYS']);
    });

    it('no limit, no rule; no stored week is a week with nothing in it', () => {
      expect(codes(day({ weekTeachingDates: week('12', '13', '15', '16') }))).toEqual([]);
      expect(codes(day({ maxTeachingDaysPerWeek: 1 }))).toEqual([]);
      expect(codes(day({ maxTeachingDaysPerWeek: 1 }), target(), [lesson('thursday', '10:00', '11:00', { date: '2026-10-15' })])).toEqual([
        'WORK_DAYS',
      ]);
    });
  });

  describe('masking for a reader without HR-läs', () => {
    const findings: RuleFinding[] = [
      { code: 'DAILY_CAP', params: { minutes: 240 } },
      { code: 'WORK_DAYS', params: { days: 3 } },
      { code: 'LUNCH', params: { minutes: 30 } },
    ];

    it('the days lose their figure and their code; the cap, which staff read, keeps its minutes', () => {
      expect(maskFindings(findings, false)).toEqual([
        { code: 'DAILY_CAP', params: { minutes: 240 } },
        { code: 'WORK_DAYS_HIDDEN', params: {} },
        { code: 'LUNCH', params: { minutes: 30 } },
      ]);
      expect(maskFindings(findings, true)).toEqual(findings);
    });

    it('the stretch limit, the post’s too, loses its figures and its code beside them', () => {
      const both: RuleFinding[] = [
        { code: 'DAILY_CAP', params: { minutes: 240 } },
        { code: 'CONSECUTIVE_TEACHING', params: { minutes: 120, breakMinutes: 30 } },
        { code: 'WORK_DAYS', params: { days: 3 } },
      ];
      expect(maskFindings(both, false)).toEqual([
        { code: 'DAILY_CAP', params: { minutes: 240 } },
        { code: 'CONSECUTIVE_TEACHING_HIDDEN', params: {} },
        { code: 'WORK_DAYS_HIDDEN', params: {} },
      ]);
      expect(maskFindings(both, true)).toEqual(both);
      expect(maskWarnings(softWarnings(both), false)).toEqual([
        { code: 'COVER_EXCEEDS_DAILY_CAP', params: { minutes: 240 } },
        { code: 'COVER_EXCEEDS_CONSECUTIVE_TEACHING_HIDDEN', params: {} },
        { code: 'COVER_BEYOND_WORK_DAYS_HIDDEN', params: {} },
      ]);
    });

    it('the warnings a manual pick gets: the cap and the days, the days masked the same way', () => {
      const warnings = softWarnings(findings);
      expect(warnings).toEqual([
        { code: 'COVER_EXCEEDS_DAILY_CAP', params: { minutes: 240 } },
        { code: 'COVER_BEYOND_WORK_DAYS', params: { days: 3 } },
        { code: 'COVER_BREAKS_LUNCH', params: { minutes: 30 } },
      ]);
      expect(maskWarnings(warnings, false)).toEqual([
        { code: 'COVER_EXCEEDS_DAILY_CAP', params: { minutes: 240 } },
        { code: 'COVER_BEYOND_WORK_DAYS_HIDDEN', params: {} },
        { code: 'COVER_BREAKS_LUNCH', params: { minutes: 30 } },
      ]);
      expect(maskWarnings(warnings, true)).toEqual(warnings);
    });
  });

  describe('rastvaktspass (Rastvakt i vardagen)', () => {
    const pass = (from: string, to: string, id = passTargetId('shift', D)): PersonPass => ({
      id,
      date: D,
      start: at(from),
      end: at(to),
    });
    const passTarget = (from: string, to: string): CoverTarget => ({
      ...target(from, to),
      id: passTargetId('yard', D),
      kind: 'PASS',
    });

    it('a pass of theirs that shares a minute excludes a lesson; one ending at the start is free', () => {
      expect(codes(day({ supervision: [pass('09:50', '10:10')] }))).toEqual(['BUSY_SUPERVISION']);
      expect(codes(day({ supervision: [pass('09:40', '10:00')] }))).toEqual([]);
    });

    it('excludes a pass target as it excludes a lesson, and never the pass being covered itself', () => {
      expect(codes(day({ supervision: [pass('10:00', '10:20', passTargetId('yard', D))] }), passTarget('10:00', '10:20'))).toEqual([]);
      expect(codes(day({ supervision: [pass('10:10', '10:30')] }), passTarget('10:00', '10:20'))).toEqual(['BUSY_SUPERVISION']);
      expect(codes(day({ lessons: [lesson('a', '10:00', '11:00')] }), passTarget('10:00', '10:20'))).toEqual(['BUSY_LESSON']);
    });

    it('a pass takes the lunch’s time, for a lesson and for a pass alike', () => {
      const lunch = { minutes: 30, window: { start: at('11:00'), end: at('12:00') } };
      // The pass 11:30–12:00 leaves 11:00–11:30 for lunch, which the lesson takes.
      expect(codes(day({ lunch, supervision: [pass('11:30', '12:00')] }), target('11:00', '11:30'))).toEqual(['LUNCH']);
      expect(codes(day({ lunch }), target('11:00', '11:30'))).toEqual([]);
      // And a pass at lunch is judged as a lesson there is.
      expect(codes(day({ lunch, lessons: [lesson('a', '11:00', '11:30')] }), passTarget('11:30', '12:00'))).toEqual(['LUNCH']);
    });

    it('a pass is not teaching: the daily cap does not judge it', () => {
      const capped = day({ dailyCapMinutes: 60, lessons: [lesson('a', '08:00', '09:00')] });
      expect(codes(capped, target('10:00', '10:20'))).toEqual(['DAILY_CAP']);
      expect(codes(capped, passTarget('10:00', '10:20'))).toEqual([]);
    });

    it('a pass is not teaching: the stretch does not judge it', () => {
      const long = day({ maxConsecutiveTeachingMinutes: 60, consecutiveBreakMinutes: 30, lessons: [lesson('a', '08:00', '10:00')] });
      expect(codes(long, target('10:00', '10:20'))).toEqual(['CONSECUTIVE_TEACHING']);
      expect(codes(long, passTarget('10:00', '10:20'))).toEqual([]);
    });

    it('the deltid in days judges a pass as a working day', () => {
      const partTimer = day({ maxTeachingDaysPerWeek: 1, weekTeachingDates: ['2026-10-12'] });
      expect(codes(partTimer, passTarget('10:00', '10:20'))).toEqual(['WORK_DAYS']);
    });

    it('a manual pick hears a pass of theirs as a warning a rektor may override', () => {
      expect(softWarnings([{ code: 'BUSY_SUPERVISION', params: {} }])).toEqual([
        { code: 'COVER_TEACHER_ON_SUPERVISION', params: {} },
      ]);
    });
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

describe('occupancyFindings (the rules that say occupied, as Skolans dag asks them)', () => {
  const span = (from: string, to: string) => ({ start: at(from), end: at(to) });
  const occupied = (person: PersonDay, from = '10:00', to = '11:00') => occupancyFindings(person, span(from, to)).map((finding) => finding.code);

  it('finds nothing in a free day, and ends at the touch: a lesson to 10:00 does not occupy 10:00', () => {
    expect(occupied(day())).toEqual([]);
    expect(occupied(day({ lessons: [lesson('l', '09:00', '10:00')] }))).toEqual([]);
    expect(occupied(day({ lessons: [lesson('l', '11:00', '12:00')] }))).toEqual([]);
  });

  it('names every occupying rule, in the order hardFindings tells them', () => {
    const person = day({
      lessons: [lesson('l', '10:30', '11:30')],
      supervision: [{ id: 'pass:1:d', date: D, start: at('10:00'), end: at('10:20') }],
      closures: [
        { span: span('10:00', '11:00'), kind: 'DUTY', label: 'Mentor' },
        { span: span('10:00', '11:00'), kind: 'UNAVAILABLE', label: null },
      ],
      bookings: [span('10:00', '11:00')],
      absences: [span('08:00', '12:00')],
    });
    expect(occupied(person)).toEqual(['ABSENT', 'BUSY_LESSON', 'BUSY_SUPERVISION', 'BUSY_DUTY', 'UNAVAILABLE', 'BOOKED_ROOM']);
  });

  it('is the first half of hardFindings and not another copy of it', () => {
    const person = day({
      lessons: [lesson('l', '10:30', '11:30'), lesson('m', '09:00', '10:30', { status: 'CANCELLED' })],
      closures: [{ span: span('10:00', '11:00'), kind: 'UNAVAILABLE', label: null }],
      bookings: [span('10:00', '11:00')],
      absences: [span('08:00', '12:00')],
    });
    const asked = hardFindings(person, target()).map((finding) => finding.code);
    expect(asked.filter((code) => ['ABSENT', 'BUSY_LESSON', 'BUSY_SUPERVISION', 'BUSY_DUTY', 'UNAVAILABLE', 'BOOKED_ROOM'].includes(code))).toEqual(
      occupied(person),
    );
  });

  it('lets a cancelled lesson free its time, and a lesson be no clash with itself', () => {
    expect(occupied(day({ lessons: [lesson('l', '10:00', '11:00', { status: 'CANCELLED' })] }))).toEqual([]);
    expect(occupied(day({ lessons: [lesson('l', '10:00', '11:00', { status: 'RESCHEDULED' })] }))).toEqual([]);
    expect(occupied(day({ lessons: [lesson('l', '10:00', '11:00', { status: 'COMPLETED' })] }))).toEqual(['BUSY_LESSON']);
    expect(occupancyFindings(day({ lessons: [lesson('cover', '10:00', '11:00')] }), span('10:00', '11:00'), undefined, 'cover')).toEqual([]);
  });
});

describe('poolNotDeclared', () => {
  const whole = { start: at('10:00'), end: at('11:00') };

  it('is true only for a member without a post whose windows do not hold the whole span', () => {
    expect(poolNotDeclared(day(), whole)).toBe(false);
    expect(poolNotDeclared(day({ pool: { member: true, hasEmployment: true, windows: [] } }), whole)).toBe(false);
    expect(poolNotDeclared(day({ pool: { member: true, hasEmployment: false, windows: [] } }), whole)).toBe(true);
    expect(poolNotDeclared(day({ pool: { member: true, hasEmployment: false, windows: [{ start: at('09:00'), end: at('10:30') }] } }), whole)).toBe(true);
    expect(poolNotDeclared(day({ pool: { member: true, hasEmployment: false, windows: [{ start: at('09:00'), end: at('12:00') }] } }), whole)).toBe(false);
  });
});
