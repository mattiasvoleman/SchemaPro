import {
  breakCoversGroup,
  breakDaysOf,
  closuresByDateOf,
  coversTime,
  isoWeekday,
  iterateDates,
  publishSkips,
  type PublishClosure,
  type PublishDaysContext,
} from './publish-days';

/*
 * The date walk publish and the timplan projection share. calendar.service.spec
 * pins publish's behaviour end to end; these pin the pieces one by one.
 */

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const clock = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const CLASS = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const GROUP = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';

const closure = (overrides: Partial<PublishClosure>): PublishClosure => ({
  resourceType: 'STUDENT_GROUP',
  userId: null,
  roomId: null,
  studentGroupId: CLASS,
  minGradeLevel: null,
  maxGradeLevel: null,
  date: day('2026-10-07'),
  startTime: clock('00:00'),
  endTime: clock('00:00'),
  ...overrides,
});

const context = (overrides: Partial<PublishDaysContext> = {}): PublishDaysContext => ({
  breakDays: new Map(),
  closuresByDate: new Map(),
  gradeOfGroup: new Map<string, number | null>([
    [CLASS, 7],
    [GROUP, null],
  ]),
  timezone: 'Europe/Stockholm',
  ...overrides,
});

const template = (studentGroupId = CLASS) => ({
  studentGroupId,
  startTime: clock('09:00'),
  endTime: clock('10:00'),
});

describe('the publish date walk', () => {
  it('walks days inclusively and names ISO weekdays', () => {
    expect([...iterateDates('2026-10-30', '2026-11-02')]).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(['2026-10-05', '2026-10-11'].map(isoWeekday)).toEqual([1, 7]);
  });

  it('closes a lov over a class by its årskurs, and a teaching group only by a school-wide one', () => {
    const span = { minGradeLevel: 7, maxGradeLevel: 9 };
    expect(breakCoversGroup(span, 7)).toBe(true);
    expect(breakCoversGroup(span, 6)).toBe(false);
    expect(breakCoversGroup(span, null)).toBe(false);
    expect(breakCoversGroup({ minGradeLevel: null, maxGradeLevel: null }, null)).toBe(true);
  });

  it('expands breaks onto the days of the window they cover', () => {
    const lov = { startDate: day('2026-10-24'), endDate: day('2026-10-28'), minGradeLevel: null, maxGradeLevel: null };
    expect([...breakDaysOf([lov], '2026-10-26', '2026-11-30').keys()]).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect([...closuresByDateOf([closure({}), closure({ date: null })]).keys()]).toEqual(['2026-10-07']);
  });

  it('reads a closure’s clock in the school’s timezone', () => {
    // 09:00–10:00 in Stockholm is 07:00Z–08:00Z in October.
    const startsAt = new Date('2026-10-07T07:00:00.000Z');
    const endsAt = new Date('2026-10-07T08:00:00.000Z');
    expect(coversTime({ startTime: clock('09:30'), endTime: clock('09:45') }, '2026-10-07', startsAt, endsAt, 'Europe/Stockholm')).toBe(true);
    expect(coversTime({ startTime: clock('07:00'), endTime: clock('08:00') }, '2026-10-07', startsAt, endsAt, 'Europe/Stockholm')).toBe(false);
  });

  it('skips a day for a lov, a closed class or a closed årskurs, and never for a teacher or a room', () => {
    const lov = { startDate: day('2026-10-07'), endDate: day('2026-10-07'), minGradeLevel: 7, maxGradeLevel: 9 };
    const withBreak = context({ breakDays: breakDaysOf([lov], '2026-10-01', '2026-10-31') });
    expect(publishSkips(template(), '2026-10-07', withBreak)).toBe('BREAK');
    expect(publishSkips(template(GROUP), '2026-10-07', withBreak)).toBeNull();

    const at = (closures: PublishClosure[]) => context({ closuresByDate: closuresByDateOf(closures) });
    expect(publishSkips(template(), '2026-10-07', at([closure({})]))).toBe('CLASS_CLOSED');
    expect(
      publishSkips(template(), '2026-10-07', at([closure({ resourceType: 'GRADE_LEVEL', studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7 })])),
    ).toBe('CLASS_CLOSED');
    // An hour that misses the lesson, and closures that are not the class's.
    expect(publishSkips(template(), '2026-10-07', at([closure({ startTime: clock('13:00'), endTime: clock('14:00') })]))).toBeNull();
    expect(
      publishSkips(template(), '2026-10-07', at([closure({ resourceType: 'TEACHER', studentGroupId: null, userId: GROUP })])),
    ).toBeNull();
    expect(
      publishSkips(template(GROUP), '2026-10-07', at([closure({ resourceType: 'GRADE_LEVEL', studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 9 })])),
    ).toBeNull();
  });
});
