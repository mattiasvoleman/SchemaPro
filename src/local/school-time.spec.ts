import { clockOfMinutes, mergeWindows, minutesOfClock, overlapMinutes, schoolWindows, wholeSchoolHolidays, type FrameLike } from './school-time';

const frame = (min: number, max: number, day: number | null, start: string, end: string): FrameLike => ({
  minGradeLevel: min,
  maxGradeLevel: max,
  dayOfWeek: day,
  start: minutesOfClock(start),
  end: minutesOfClock(end),
});

describe('school time', () => {
  it('reads and writes the clock in minutes', () => {
    expect(minutesOfClock('08:30')).toBe(510);
    expect(minutesOfClock('18:00:00')).toBe(1080);
    expect(clockOfMinutes(510)).toBe('08:30');
    expect(clockOfMinutes(0)).toBe('00:00');
  });

  it('merges overlapping and touching windows and drops empty ones', () => {
    expect(mergeWindows([{ start: 60, end: 120 }, { start: 100, end: 200 }, { start: 200, end: 210 }, { start: 400, end: 400 }, { start: 300, end: 350 }])).toEqual([
      { start: 60, end: 210 },
      { start: 300, end: 350 },
    ]);
  });

  describe('windows of a room', () => {
    const frames = [frame(0, 3, null, '08:00', '14:30'), frame(7, 9, null, '08:00', '16:00'), frame(0, 3, 5, '08:00', '12:00')];

    it('is the union of the years the room may host, on a teaching day', () => {
      expect(schoolWindows(frames, 2)).toEqual([{ start: 480, end: 960 }]);
      expect(schoolWindows(frames, 2, { min: 0, max: 3 })).toEqual([{ start: 480, end: 870 }]);
      expect(schoolWindows(frames, 2, { min: 7, max: 9 })).toEqual([{ start: 480, end: 960 }]);
    });

    it('lets a weekday row narrow an every-day row by intersection', () => {
      expect(schoolWindows(frames, 5, { min: 0, max: 3 })).toEqual([{ start: 480, end: 720 }]);
      // The upper years have no Friday row and keep the every-day one.
      expect(schoolWindows(frames, 5, { min: 7, max: 9 })).toEqual([{ start: 480, end: 960 }]);
    });

    it('has no school time on a weekend that no frame names, nor for years no frame covers', () => {
      expect(schoolWindows(frames, 6)).toEqual([]);
      expect(schoolWindows(frames, 7)).toEqual([]);
      expect(schoolWindows(frames, 2, { min: 4, max: 6 })).toEqual([]);
      expect(schoolWindows([], 2)).toEqual([]);
    });

    it('lets a frame that names a weekend day count on that day', () => {
      expect(schoolWindows([frame(0, 12, 6, '09:00', '12:00')], 6)).toEqual([{ start: 540, end: 720 }]);
    });

    it('drops a frame whose intersection is empty', () => {
      expect(schoolWindows([frame(0, 12, null, '08:00', '12:00'), frame(0, 12, 2, '13:00', '15:00')], 2)).toEqual([]);
    });
  });

  it('counts only a lov for the whole school as taking the frames off its days', () => {
    const days = wholeSchoolHolidays(
      [
        { kind: 'HOLIDAY', startDate: '2027-02-22', endDate: '2027-02-26', minGradeLevel: null, maxGradeLevel: null },
        { kind: 'STAFF_DAY', startDate: '2027-03-01', endDate: '2027-03-01', minGradeLevel: null, maxGradeLevel: null },
        { kind: 'HOLIDAY', startDate: '2027-03-02', endDate: '2027-03-02', minGradeLevel: 9, maxGradeLevel: 9 },
        { kind: 'HOLIDAY', startDate: '2027-01-01', endDate: '2027-01-10', minGradeLevel: null, maxGradeLevel: null },
      ],
      '2027-02-24',
      '2027-03-31',
    );
    expect([...days]).toEqual(['2027-02-24', '2027-02-25', '2027-02-26']);
  });

  it('counts the minutes a span shares with windows', () => {
    const windows = [{ start: 480, end: 720 }, { start: 780, end: 900 }];
    expect(overlapMinutes({ start: 600, end: 800 }, windows)).toBe(120 + 20);
    expect(overlapMinutes({ start: 0, end: 480 }, windows)).toBe(0);
    expect(overlapMinutes({ start: 720, end: 780 }, windows)).toBe(0);
  });
});
