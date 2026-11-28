import { teachingWeeks, teachingWeeksByDays, type ClosedRange } from './teaching-weeks';

/*
 * TWO CHOICES R1 LEFT OPEN, said as what they are and pinned (R1b: #400 L-2 and L-3).
 *
 *   1. THE TIMPLAN COUNTS WHOLE WEEKS, THE OMFATTNING COUNTS SCHOOL DAYS (L-2). teachingWeeks charges a week whole when the window covers any
 *      day of it, which is how the pupil's guaranteed time is planned: a standard week is a week, and the timplan's target and its planned
 *      figure are counted by one function, so the plan is compared with its own unit. teachingWeeksByDays counts the Monday-Friday days that
 *      are in the window, a fifth of a week each, which is what a teacher's hours over a läsår are (the ordinance counts time, 2 §). The
 *      same lesson is therefore one week more in the timplan's year in a läsår that starts or ends in the middle of a week, and the
 *      timplan page says so (requirements.target.legend). Changing the timplan to school days would move every school's guaranteed-time
 *      statement and its published copies, for a difference of a fraction of a week: not done.
 *
 *   2. SCHOOL DAYS ARE MONDAY TO FRIDAY (L-3). Nothing in a school's data says which weekdays it teaches (the engine's SCHEDULE_DAYS is an
 *      operator's setting, not the school's), and a requirement carries no weekday: its minutes are a week's, whatever day they fall on.
 *      So a lesson on a Saturday costs the same minutes as one on a Friday, and the only thing five days decides is how much of a week a
 *      window or a closure covers at its edges. A closure that lies on a Saturday or a Sunday takes no school day.
 */
const YEAR = { startDate: '2026-08-15', endDate: '2026-08-28' }; // Saturday to Friday

describe('the timplan counts whole weeks and the omfattning counts school days', () => {
  it('differ by the week a year that starts on a Saturday touches: three whole weeks, ten school days', () => {
    // Saturday 15 touches the week of Monday 10, which is a whole week to the timplan and no school day to the omfattning.
    expect(teachingWeeks({}, YEAR)).toBe(3);
    expect(teachingWeeksByDays({}, YEAR)).toBe(2);
  });

  it('agree for a year that runs from a Monday to a Friday, so a school whose years do is counted as it always was', () => {
    const monday = { startDate: '2026-08-17', endDate: '2027-06-11' };
    expect(teachingWeeksByDays({}, monday)).toBe(teachingWeeks({}, monday));
  });

  it('differ by a week at the end too: a year that ends on a Monday holds one school day of the last week, a whole week to the timplan', () => {
    const endsMonday = { startDate: '2026-08-17', endDate: '2026-09-07' };
    expect(teachingWeeks({}, endsMonday)).toBe(4);
    expect(teachingWeeksByDays({}, endsMonday)).toBe(3.2);
  });
});

describe('school days are Monday to Friday', () => {
  const full = { startDate: '2026-08-17', endDate: '2026-08-28' };

  it('takes no school day for a closure on a Saturday and a Sunday', () => {
    const weekend: ClosedRange[] = [{ startDate: '2026-08-22', endDate: '2026-08-23' }];
    expect(teachingWeeksByDays({}, full, weekend)).toBe(2);
    expect(teachingWeeks({}, full, weekend)).toBe(2);
  });

  it('takes one fifth of a week for a closure on a Friday, and a whole week for one from Monday to Friday', () => {
    expect(teachingWeeksByDays({}, full, [{ startDate: '2026-08-21', endDate: '2026-08-21' }])).toBe(1.8);
    expect(teachingWeeksByDays({}, full, [{ startDate: '2026-08-17', endDate: '2026-08-21' }])).toBe(1);
  });

  it('holds no school day in a window that is a Saturday and a Sunday: no hour of lessons, though the timplan would call it a week', () => {
    const weekend = { startDate: '2026-08-15', endDate: '2026-08-16' };
    expect(teachingWeeksByDays({}, weekend)).toBe(0);
    expect(teachingWeeks({}, weekend)).toBe(1);
  });

  it('counts a lesson the same minutes whatever day it falls on: the figure is a requirement\'s week, which carries no weekday', () => {
    // Weeks are the only thing a weekday could change, and a window of whole Monday-to-Friday weeks gives the same count for any set of days.
    expect(teachingWeeksByDays({}, full)).toBe(2);
  });
});
