import { breakDaysOf, closuresByDateOf, type PublishDaysContext } from '../calendar/publish-days';
import { masterOccurrencesBetween, masterWalk, publishedGaps, type MasterWalkLesson } from './timplan-delivered';

/*
 * The two pieces of P3's layer 3 that Fas 3 extracted so the staffing
 * reconciliation asks the same questions: which days publish would write a
 * grundschema lesson on, and which past weekdays two publishes left without
 * a row. computeDeliveredCoverage calls both, and its own spec
 * (timplan-delivered.spec.ts) is unchanged and green — that is the "P3
 * unchanged" half; this spec pins the functions on their own.
 */

const ctx = (overrides: Partial<PublishDaysContext> = {}): PublishDaysContext => ({
  breakDays: new Map(),
  closuresByDate: new Map(),
  gradeOfGroup: new Map([['7a', 7]]),
  timezone: 'Europe/Stockholm',
  ...overrides,
});

const monday = (overrides: Partial<MasterWalkLesson> = {}): MasterWalkLesson => ({
  studentGroupId: '7a',
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...overrides,
});

describe('masterOccurrencesBetween', () => {
  it('counts the lesson’s weekday in the range, both ends inclusive', () => {
    // Mondays 7, 14, 21, 28 September 2026.
    expect(masterOccurrencesBetween(monday(), '2026-09-07', '2026-09-28', ctx())).toBe(4);
    expect(masterOccurrencesBetween(monday(), '2026-09-08', '2026-09-27', ctx())).toBe(2);
    expect(masterOccurrencesBetween(monday({ dayOfWeek: 3 }), '2026-09-07', '2026-09-13', ctx())).toBe(1);
  });

  it('honours the recurrence and the lesson’s own window', () => {
    // ISO weeks 37–40: 7 Sep is week 37 (odd).
    expect(masterOccurrencesBetween(monday({ recurrence: 'ODD_WEEKS' }), '2026-09-07', '2026-09-28', ctx())).toBe(2);
    expect(masterOccurrencesBetween(monday({ recurrence: 'EVEN_WEEKS' }), '2026-09-07', '2026-09-28', ctx())).toBe(2);
    expect(masterOccurrencesBetween(monday({ startDate: '2026-09-14', endDate: '2026-09-21' }), '2026-09-07', '2026-09-28', ctx())).toBe(2);
  });

  it('skips a lov for the lesson’s group and a dated closure of its class, as publish does', () => {
    const lov = { startDate: new Date('2026-09-14T00:00:00Z'), endDate: new Date('2026-09-18T00:00:00Z'), minGradeLevel: 7, maxGradeLevel: 9 };
    const closed = ctx({ breakDays: breakDaysOf([lov], '2026-09-07', '2026-09-28') });
    expect(masterOccurrencesBetween(monday(), '2026-09-07', '2026-09-28', closed)).toBe(3);
    // The same lov for åk 8–9 does not reach åk 7.
    const other = { ...lov, minGradeLevel: 8 };
    expect(masterOccurrencesBetween(monday(), '2026-09-07', '2026-09-28', ctx({ breakDays: breakDaysOf([other], '2026-09-07', '2026-09-28') }))).toBe(4);
    const closure = {
      resourceType: 'STUDENT_GROUP', userId: null, roomId: null, studentGroupId: '7a', minGradeLevel: null, maxGradeLevel: null,
      date: new Date('2026-09-21T00:00:00Z'), startTime: new Date('1970-01-01T07:00:00Z'), endTime: new Date('1970-01-01T16:00:00Z'),
    };
    expect(masterOccurrencesBetween(monday(), '2026-09-07', '2026-09-28', ctx({ closuresByDate: closuresByDateOf([closure]) }))).toBe(3);
  });

  it('takes a further test when asked, as P3 does with "not yet ended"', () => {
    expect(masterOccurrencesBetween(monday(), '2026-09-07', '2026-09-28', ctx(), (day) => day > '2026-09-14')).toBe(2);
  });

  it('walks from the first occurrence on or after a day', () => {
    expect(masterWalk(monday(), ctx()).firstFrom('2026-09-09')).toBe('2026-09-14');
    expect(masterWalk(monday(), ctx()).firstFrom('2026-09-14')).toBe('2026-09-14');
  });
});

describe('publishedGaps', () => {
  const recorded = (days: string[]) => days;

  it('finds the past weekdays with no row, one window per run of weekdays across a weekend', () => {
    const gaps = publishedGaps({
      from: '2026-09-07',
      lastRecorded: '2026-09-18',
      // 10–15 September missing: Thu, Fri, then Mon, Tue.
      publishedDays: recorded(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-16', '2026-09-17', '2026-09-18']),
      closures: [],
      classGrades: [7],
    });
    expect(gaps).toEqual({ days: 4, windows: [['2026-09-10', '2026-09-15']], first: '2026-09-10', last: '2026-09-15' });
  });

  it('is no gap on a day a lov closes for every class, and is a gap when one class still had school', () => {
    const lov = { startDate: '2026-09-10', endDate: '2026-09-11', minGradeLevel: 7, maxGradeLevel: 7 };
    const args = { from: '2026-09-10', lastRecorded: '2026-09-11', publishedDays: [], closures: [lov] };
    expect(publishedGaps({ ...args, classGrades: [7] }).days).toBe(0);
    expect(publishedGaps({ ...args, classGrades: [7, 8] }).days).toBe(2);
  });
});
