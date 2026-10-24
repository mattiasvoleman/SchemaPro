import { lessonClashesOf, type ClashLesson, type ClashShift } from './lesson-clashes';

/**
 * A pass during the teacher's own lesson (Rastvaktsschema): the review's
 * case — the lågstadiegård's rast is 10:00–10:20, and the högstadielärare who
 * is given it teaches 8A on Mondays 10:00–11:00.
 */

const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const PASS: ClashShift = { userId: 'anna', dayOfWeek: 1, start: clock('10:00'), end: clock('10:20'), validFrom: null, validTo: null };
const lesson = (rest: Partial<ClashLesson> = {}): ClashLesson => ({
  teacherIds: ['anna', null],
  dayOfWeek: 1,
  start: clock('10:00'),
  end: clock('11:00'),
  startDate: null,
  endDate: null,
  subject: 'Matematik',
  group: '8A',
  ...rest,
});

describe('lessonClashesOf', () => {
  it('names the teacher’s lesson the pass shares a minute with', () => {
    expect(lessonClashesOf(PASS, [lesson()])).toEqual([
      { subject: 'Matematik', group: '8A', dayOfWeek: 1, startTime: '10:00', endTime: '11:00' },
    ]);
  });

  it('counts a lesson the teacher co-teaches, and not a colleague’s', () => {
    expect(lessonClashesOf(PASS, [lesson({ teacherIds: ['bo', 'anna'] })])).toHaveLength(1);
    expect(lessonClashesOf(PASS, [lesson({ teacherIds: ['bo', null] })])).toEqual([]);
  });

  it('meets no lesson on another day, one that only touches the pass, or one dated apart from it', () => {
    expect(lessonClashesOf(PASS, [lesson({ dayOfWeek: 2 })])).toEqual([]);
    // 10:20–11:00 begins as the pass ends; 09:00–10:00 ends as it begins.
    expect(lessonClashesOf(PASS, [lesson({ start: clock('10:20') }), lesson({ start: clock('09:00'), end: clock('10:00') })])).toEqual([]);
    const autumn = { ...PASS, validTo: '2026-12-21' };
    expect(lessonClashesOf(autumn, [lesson({ startDate: '2027-01-11' })])).toEqual([]);
    expect(lessonClashesOf(autumn, [lesson({ startDate: '2026-12-21' })])).toHaveLength(1);
    const spring = { ...PASS, validFrom: '2027-01-11' };
    expect(lessonClashesOf(spring, [lesson({ endDate: '2027-01-10' })])).toEqual([]);
  });

  it('lists several in the order of the day', () => {
    const long = { ...PASS, end: clock('12:00') };
    expect(
      lessonClashesOf(long, [
        lesson({ start: clock('11:00'), end: clock('12:00'), subject: 'Svenska', group: '7B' }),
        lesson(),
      ]).map((row) => row.subject),
    ).toEqual(['Matematik', 'Svenska']);
  });
});
