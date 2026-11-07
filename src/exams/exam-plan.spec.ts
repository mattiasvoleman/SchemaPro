import {
  candidateSlots,
  clockOf,
  datesBetween,
  indexDates,
  invigilatorsNeeded,
  isCalendarDate,
  minuteOf,
  seatGroups,
  weekKeyOf,
  windowDays,
  type ExamToPlan,
  type PlanLesson,
} from './exam-plan';

// 2030-10-07 is a Monday.
const exam = (over: Partial<ExamToPlan> = {}): ExamToPlan => ({
  id: 'e1',
  subjectId: 'math',
  lengthMinutes: 60,
  windowKind: 'WEEK',
  from: '2030-10-07',
  to: '2030-10-11',
  fixedStart: null,
  earliestStart: null,
  latestEnd: null,
  named: ['g7a'],
  coverOf: new Map([['g7a', new Set(['g7a', 'g7a-half'])]]),
  closed: new Set(),
  ...over,
});

const lesson = (id: string, date: string, start: number, end: number, subjectId: string, groupIds: string[] = ['g7a']): PlanLesson => ({
  id,
  date,
  start,
  end,
  subjectId,
  groupIds,
});

const byDate = (lessons: PlanLesson[]) => {
  const map = new Map<string, PlanLesson[]>();
  for (const l of lessons) map.set(l.date, [...(map.get(l.date) ?? []), l]);
  return map;
};

describe('the clock helpers', () => {
  it('turns minutes into a clock and back', () => {
    expect(clockOf(0)).toBe('00:00');
    expect(clockOf(485)).toBe('08:05');
    expect(minuteOf('08:05')).toBe(485);
    expect(minuteOf(clockOf(1439))).toBe(1439);
  });

  it('lists the dates of a span, both ends included', () => {
    expect(datesBetween('2030-10-07', '2030-10-09')).toEqual(['2030-10-07', '2030-10-08', '2030-10-09']);
    expect(datesBetween('2030-10-07', '2030-10-07')).toEqual(['2030-10-07']);
  });
});

describe('a date', () => {
  it('is a day of the calendar or it is not: the pattern lets 31 November and 32 November through', () => {
    for (const real of ['2030-10-07', '2032-02-29', '2030-12-31', '2030-01-01']) expect(isCalendarDate(real)).toBe(true);
    for (const unreal of ['2030-11-31', '2030-11-32', '2031-02-29', '2030-02-30', '2030-00-10', '2030-13-01', '0000-00-00', '2030-1-7', '2030-10-07T00:00', '', 'idag']) {
      expect(isCalendarDate(unreal)).toBe(false);
    }
  });
});

describe('the days an exam can take', () => {
  it('keeps the weekdays after today that are not closed', () => {
    const e = exam({ from: '2030-10-04', to: '2030-10-14', closed: new Set(['2030-10-09']) });
    expect(windowDays(e, '2030-10-06')).toEqual(['2030-10-07', '2030-10-08', '2030-10-10', '2030-10-11', '2030-10-14']);
  });

  it('starts tomorrow: today is not a day, the activity takes lessons that have not begun', () => {
    expect(windowDays(exam(), '2030-10-07')).toEqual(['2030-10-08', '2030-10-09', '2030-10-10', '2030-10-11']);
  });
});

describe('the times an exam can take', () => {
  it('offers the lesson starts of the exam’s groups, with what each takes away', () => {
    const lessons = [
      lesson('a', '2030-10-08', 500, 560, 'swe'),
      lesson('b', '2030-10-08', 560, 620, 'math'),
      lesson('c', '2030-10-08', 640, 700, 'eng'),
    ];
    const { slots, shortage } = candidateSlots(exam(), byDate(lessons), '2030-10-07');
    expect(shortage).toBeNull();
    // 500 takes the swedish lesson (60) and, to 560, nothing of the math lesson that starts at 560.
    expect(slots).toEqual([
      { date: '2030-10-08', start: 500, end: 560, loss: 60 },
      { date: '2030-10-08', start: 560, end: 620, loss: 0 },
      { date: '2030-10-08', start: 640, end: 700, loss: 60 },
    ]);
  });

  it('does not count the minutes of the exam’s own subject as lost', () => {
    const lessons = [lesson('a', '2030-10-08', 500, 560, 'math')];
    const { slots } = candidateSlots(exam(), byDate(lessons), '2030-10-07');
    expect(slots).toEqual([{ date: '2030-10-08', start: 500, end: 560, loss: 0 }]);
  });

  it('counts a long lesson whole when the exam only overlaps it', () => {
    const lessons = [lesson('a', '2030-10-08', 500, 600, 'swe'), lesson('b', '2030-10-08', 560, 620, 'eng', ['g7a'])];
    const { slots } = candidateSlots(exam({ lengthMinutes: 30 }), byDate(lessons), '2030-10-07');
    expect(slots.find((slot) => slot.start === 560)?.loss).toBe(100 + 60);
  });

  it('wants every named group to have a lesson to cancel in the time', () => {
    const e = exam({
      named: ['g7a', 'g7b'],
      coverOf: new Map([
        ['g7a', new Set(['g7a'])],
        ['g7b', new Set(['g7b'])],
      ]),
    });
    const lessons = [
      lesson('a', '2030-10-08', 500, 560, 'swe', ['g7a']),
      lesson('b', '2030-10-08', 500, 560, 'swe', ['g7b']),
      lesson('c', '2030-10-09', 500, 560, 'swe', ['g7a']),
    ];
    const { slots } = candidateSlots(e, byDate(lessons), '2030-10-07');
    expect(slots.map((slot) => slot.date)).toEqual(['2030-10-08']);
  });

  it('says why when there is nothing: a window that is closed', () => {
    const closed = new Set(datesBetween('2030-10-07', '2030-10-11'));
    expect(candidateSlots(exam({ closed }), new Map(), '2030-10-01')).toEqual({ slots: [], shortage: 'EXAM_WINDOW_CLOSED' });
  });

  it('says why when there is nothing: no lesson to replace, whether no group has a lesson or none starts', () => {
    expect(candidateSlots(exam(), new Map(), '2030-10-01')).toEqual({ slots: [], shortage: 'EXAM_NO_LESSON_TO_REPLACE' });
  });

  it('says no lesson to replace when the times fit the day but cover no group', () => {
    const lessons = [lesson('a', '2030-10-08', 500, 560, 'swe', ['other'])];
    // The start 500 exists (a lesson starts there) and fits, but it is another group's lesson.
    expect(candidateSlots(exam(), byDate(lessons), '2030-10-07').shortage).toBe('EXAM_NO_LESSON_TO_REPLACE');
  });

  it('keeps inside the daily bounds of a week window', () => {
    const lessons = [lesson('a', '2030-10-08', 480, 540, 'swe'), lesson('b', '2030-10-08', 600, 660, 'swe')];
    const { slots } = candidateSlots(exam({ earliestStart: 540, latestEnd: 700 }), byDate(lessons), '2030-10-07');
    expect(slots.map((slot) => slot.start)).toEqual([600]);
  });

  it('has one start for a fixed exam, and none when no lesson is in it', () => {
    const lessons = [lesson('a', '2030-10-08', 500, 560, 'swe')];
    const fixed = exam({ windowKind: 'FIXED', from: '2030-10-08', to: '2030-10-08', fixedStart: 510 });
    expect(candidateSlots(fixed, byDate(lessons), '2030-10-07').slots).toEqual([{ date: '2030-10-08', start: 510, end: 570, loss: 60 }]);
    const elsewhere = exam({ windowKind: 'FIXED', from: '2030-10-08', to: '2030-10-08', fixedStart: 900 });
    expect(candidateSlots(elsewhere, byDate(lessons), '2030-10-07').slots).toEqual([]);
  });

  it('drops a start the exam would carry past midnight, and a start outside the daily bounds, and says so', () => {
    const lessons = [lesson('a', '2030-10-08', 1400, 1430, 'swe')];
    expect(candidateSlots(exam({ lengthMinutes: 60 }), byDate(lessons), '2030-10-07')).toEqual({ slots: [], shortage: 'EXAM_OUTSIDE_HOURS' });
    expect(candidateSlots(exam({ latestEnd: 400 }), byDate([lesson('b', '2030-10-08', 500, 560, 'swe')]), '2030-10-07').shortage).toBe('EXAM_OUTSIDE_HOURS');
  });
});

describe('seating the classes', () => {
  it('keeps a class together in the room where it begins, and overflows into the next', () => {
    const rooms = [
      { roomId: 'r1', writers: 40 },
      { roomId: 'r2', writers: 20 },
    ];
    const seated = seatGroups(
      [
        { groupId: 'a', pupils: 25 },
        { groupId: 'b', pupils: 25 },
        { groupId: 'c', pupils: 10 },
      ],
      60,
      rooms,
    );
    expect(seated[0].groups).toEqual([
      { groupId: 'a', writers: 25 },
      { groupId: 'b', writers: 15 },
    ]);
    expect(seated[1].groups).toEqual([
      { groupId: 'b', writers: 10 },
      { groupId: 'c', writers: 10 },
    ]);
  });

  it('shares the writers by the classes’ pupils when fewer write than are on the roll', () => {
    const seated = seatGroups(
      [
        { groupId: 'a', pupils: 30 },
        { groupId: 'b', pupils: 10 },
      ],
      20,
      [{ roomId: 'r1', writers: 20 }],
    );
    expect(seated[0].groups).toEqual([
      { groupId: 'a', writers: 15 },
      { groupId: 'b', writers: 5 },
    ]);
  });

  it('splits evenly when nobody is on the roll, and seats nobody for no groups', () => {
    const seated = seatGroups(
      [
        { groupId: 'a', pupils: 0 },
        { groupId: 'b', pupils: 0 },
      ],
      5,
      [{ roomId: 'r1', writers: 5 }],
    );
    expect(seated[0].groups).toEqual([
      { groupId: 'a', writers: 3 },
      { groupId: 'b', writers: 2 },
    ]);
    expect(seatGroups([], 5, [{ roomId: 'r1', writers: 5 }])).toEqual([{ roomId: 'r1', groups: [] }]);
  });

  it('hands the remainder of an uneven share to the largest fractions', () => {
    const seated = seatGroups(
      [
        { groupId: 'a', pupils: 1 },
        { groupId: 'b', pupils: 1 },
        { groupId: 'c', pupils: 1 },
      ],
      10,
      [{ roomId: 'r1', writers: 10 }],
    );
    const total = seated[0].groups.reduce((sum, seat) => sum + seat.writers, 0);
    expect(total).toBe(10);
    expect(seated[0].groups.map((seat) => seat.writers).sort()).toEqual([3, 3, 4]);
  });
});

describe('the invigilators a room needs', () => {
  it('is one for the first writers and one more for each full ratio', () => {
    expect(invigilatorsNeeded(1, 30)).toBe(1);
    expect(invigilatorsNeeded(30, 30)).toBe(1);
    expect(invigilatorsNeeded(31, 30)).toBe(2);
    expect(invigilatorsNeeded(90, 30)).toBe(3);
  });
});

describe('the indexes of days and weeks', () => {
  it('numbers the ISO weeks across a year end', () => {
    expect(weekKeyOf('2030-12-30')).toBe('2031-01');
    expect(weekKeyOf('2030-10-07')).toBe(weekKeyOf('2030-10-11'));
    expect(weekKeyOf('2030-10-07')).not.toBe(weekKeyOf('2030-10-14'));
  });

  it('numbers dates in order, once each, and weeks by first appearance', () => {
    const { day, week } = indexDates(['2030-10-14', '2030-10-07', '2030-10-08', '2030-10-07']);
    expect([...day]).toEqual([
      ['2030-10-07', 0],
      ['2030-10-08', 1],
      ['2030-10-14', 2],
    ]);
    expect(week.size).toBe(2);
  });
});
