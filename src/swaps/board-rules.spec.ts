import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import {
  boardCodeOf,
  constraintOf,
  frameOf,
  indexSittings,
  minutesOfTime,
  readBoardFacts,
  sittingKey,
  sittingOf,
  type BoardFacts,
} from './board-rules';

jest.mock('../optimization/room-eligibility', () => ({ loadRosters: jest.fn(), gradeSpanOf: jest.fn() }));

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const slot = (dayOfWeek: number, from: string, to: string) => ({ dayOfWeek, startMinutes: minutesOfTime(time(from)), endMinutes: minutesOfTime(time(to)) });

/** Class 4A is in årskurs 4; the others are unknown to the judge. */
const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  frames: [],
  sittings: new Map(),
  gradeRules: [],
  spans: new Map([['4A', [4, 4]]]),
  ...over,
});
const rule = (over: Record<string, unknown> = {}) => ({
  resourceType: 'GRADE_LEVEL',
  userId: null,
  roomId: null,
  studentGroupId: null,
  minGradeLevel: 1,
  maxGradeLevel: 6,
  dayOfWeek: 2,
  startMinutes: 600,
  endMinutes: 660,
  ...over,
});

describe('the mappers', () => {
  it('reads a TIME column as minutes after midnight', () => {
    expect(minutesOfTime(time('00:00'))).toBe(0);
    expect(minutesOfTime(time('08:30'))).toBe(510);
    expect(minutesOfTime(time('23:59'))).toBe(1439);
  });

  it('states a frame, a sitting and a constraint in minutes', () => {
    expect(frameOf({ minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: null, startTime: time('08:00'), endTime: time('15:00') })).toEqual({ min: 1, max: 6, day: null, start: 480, end: 900 });
    expect(sittingOf({ studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30') })).toEqual({ studentGroupId: '4A', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 });
    expect(
      constraintOf({ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 1, maxGradeLevel: 3, dayOfWeek: 4, startTime: time('13:00'), endTime: time('14:00') }),
    ).toEqual({ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 1, maxGradeLevel: 3, dayOfWeek: 4, startMinutes: 780, endMinutes: 840 });
  });

  it('indexes sittings by group and weekday, keeping every sitting of the day', () => {
    const a = { studentGroupId: '4A', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 };
    const b = { studentGroupId: '4A', dayOfWeek: 2, startMinutes: 720, endMinutes: 750 };
    const c = { studentGroupId: '4A', dayOfWeek: 3, startMinutes: 660, endMinutes: 690 };
    const index = indexSittings([a, b, c]);
    expect(index.get(sittingKey('4A', 2))).toEqual([a, b]);
    expect(index.get(sittingKey('4A', 3))).toEqual([c]);
    expect(index.get(sittingKey('4B', 2))).toBeUndefined();
  });
});

describe('boardCodeOf', () => {
  it('finds nothing in a school that holds nothing', () => {
    expect(boardCodeOf(facts(), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
  });

  describe('FRAME', () => {
    const frames = [{ min: 1, max: 6, day: null, start: 480, end: 900 }];
    it('refuses a lesson that starts before, or ends after, the stage’s day, and takes the edges', () => {
      expect(boardCodeOf(facts({ frames }), ['4A'], slot(2, '07:59', '09:00'))).toBe('FRAME');
      expect(boardCodeOf(facts({ frames }), ['4A'], slot(2, '14:00', '15:01'))).toBe('FRAME');
      expect(boardCodeOf(facts({ frames }), ['4A'], slot(2, '08:00', '09:00'))).toBeNull();
      expect(boardCodeOf(facts({ frames }), ['4A'], slot(2, '14:00', '15:00'))).toBeNull();
    });

    it('reads the frames that reach the class’s years, on the day, and the intersection of those that do', () => {
      const onlyHigher = [{ min: 7, max: 9, day: null, start: 600, end: 700 }];
      expect(boardCodeOf(facts({ frames: onlyHigher }), ['4A'], slot(2, '08:00', '09:00'))).toBeNull();
      const wednesdayShort = [...frames, { min: 1, max: 6, day: 3, start: 480, end: 720 }];
      expect(boardCodeOf(facts({ frames: wednesdayShort }), ['4A'], slot(3, '12:00', '13:00'))).toBe('FRAME');
      expect(boardCodeOf(facts({ frames: wednesdayShort }), ['4A'], slot(2, '12:00', '13:00'))).toBeNull();
    });

    it('refuses a day the frames leave no hour of, and lets a class with no known years through', () => {
      const nothing = [{ min: 1, max: 6, day: null, start: 480, end: 600 }, { min: 1, max: 6, day: null, start: 700, end: 900 }];
      expect(boardCodeOf(facts({ frames: nothing }), ['4A'], slot(2, '08:00', '08:30'))).toBe('FRAME');
      expect(boardCodeOf(facts({ frames, spans: new Map() }), ['4A'], slot(2, '16:00', '17:00'))).toBeNull();
    });

    it('is any of the groups outside its stage’s day', () => {
      const both = facts({ frames: [{ min: 1, max: 3, day: null, start: 480, end: 900 }, { min: 7, max: 9, day: null, start: 600, end: 700 }], spans: new Map([['3A', [3, 3]], ['8A', [8, 8]]]) });
      expect(boardCodeOf(both, ['3A', '8A'], slot(2, '08:00', '09:00'))).toBe('FRAME');
      expect(boardCodeOf(both, ['3A'], slot(2, '08:00', '09:00'))).toBeNull();
    });
  });

  describe('LUNCH', () => {
    const meal = (from: string, to: string, day = 2) => new Map([[sittingKey('4A', day), [{ studentGroupId: '4A', dayOfWeek: day, startMinutes: minutesOfTime(time(from)), endMinutes: minutesOfTime(time(to)) }]]]);
    it('refuses a lesson on top of the class’s sitting, by overlap and not by touching', () => {
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4A'], slot(2, '10:30', '11:15'))).toBe('LUNCH');
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4A'], slot(2, '11:15', '12:15'))).toBe('LUNCH');
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4A'], slot(2, '11:30', '12:30'))).toBeNull();
    });

    it('is the class’s sitting of that day, and any of the groups’', () => {
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30', 3) }), ['4A'], slot(2, '11:00', '11:30'))).toBeNull();
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4B'], slot(2, '11:00', '11:30'))).toBeNull();
      expect(boardCodeOf(facts({ sittings: meal('11:00', '11:30') }), ['4B', '4A'], slot(2, '11:00', '11:30'))).toBe('LUNCH');
    });
  });

  describe('GRADE_RULE', () => {
    it('refuses an hour a weekly row closes to the class’s years, by overlap', () => {
      expect(boardCodeOf(facts({ gradeRules: [rule()] }), ['4A'], slot(2, '10:30', '11:30'))).toBe('GRADE_RULE');
      expect(boardCodeOf(facts({ gradeRules: [rule()] }), ['4A'], slot(2, '09:00', '10:00'))).toBeNull();
      expect(boardCodeOf(facts({ gradeRules: [rule()] }), ['4A'], slot(2, '11:00', '12:00'))).toBeNull();
    });

    it('reads the day, the years of the row (an open bound reaching all) and the class’s years', () => {
      expect(boardCodeOf(facts({ gradeRules: [rule({ dayOfWeek: 3 })] }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
      expect(boardCodeOf(facts({ gradeRules: [rule({ minGradeLevel: 5, maxGradeLevel: 6 })] }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
      expect(boardCodeOf(facts({ gradeRules: [rule({ minGradeLevel: 1, maxGradeLevel: 3 })] }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
      expect(boardCodeOf(facts({ gradeRules: [rule({ minGradeLevel: null, maxGradeLevel: 4 })] }), ['4A'], slot(2, '10:00', '11:00'))).toBe('GRADE_RULE');
      expect(boardCodeOf(facts({ gradeRules: [rule({ minGradeLevel: 4, maxGradeLevel: null })] }), ['4A'], slot(2, '10:00', '11:00'))).toBe('GRADE_RULE');
      expect(boardCodeOf(facts({ gradeRules: [rule({ minGradeLevel: null, maxGradeLevel: null })] }), ['4A'], slot(2, '10:00', '11:00'))).toBe('GRADE_RULE');
      expect(boardCodeOf(facts({ gradeRules: [rule()], spans: new Map() }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
    });

    it('ignores a row that is not about whole årskurser', () => {
      expect(boardCodeOf(facts({ gradeRules: [rule({ resourceType: 'STUDENT_GROUP', studentGroupId: '4A' })] }), ['4A'], slot(2, '10:00', '11:00'))).toBeNull();
    });
  });

  it('names the first of FRAME, LUNCH and GRADE_RULE that a lesson breaks, in that order', () => {
    const all = facts({
      frames: [{ min: 1, max: 6, day: null, start: 480, end: 900 }],
      sittings: new Map([[sittingKey('4A', 2), [{ studentGroupId: '4A', dayOfWeek: 2, startMinutes: 600, endMinutes: 660 }]]]),
      gradeRules: [rule()],
    });
    expect(boardCodeOf(all, ['4A'], slot(2, '07:00', '08:30'))).toBe('FRAME');
    expect(boardCodeOf(all, ['4A'], slot(2, '10:00', '11:00'))).toBe('LUNCH');
    const noMeal = { ...all, sittings: new Map() };
    expect(boardCodeOf(noMeal, ['4A'], slot(2, '10:00', '11:00'))).toBe('GRADE_RULE');
  });
});

describe('readBoardFacts', () => {
  const basis = { kind: 'CURRENT' } as never;
  function world() {
    const tx: TxMock = createTxMock();
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: '4A', gradeLevel: 4, halfOfId: null }]);
    tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: null, startTime: time('08:00'), endTime: time('15:00') }]);
    tx['lunchSitting']!['findMany']!.mockResolvedValue([{ studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30') }]);
    tx['availabilityConstraint']!['findMany']!.mockResolvedValue([]);
    tx['calendarLunch']!['findMany']!.mockResolvedValue([]);
    (loadRosters as jest.Mock).mockReset().mockResolvedValue({ rosters: true });
    (gradeSpanOf as jest.Mock).mockReset().mockReturnValue({ min: 4, max: 4 });
    return tx;
  }
  const read = (tx: TxMock, over: Record<string, unknown> = {}) =>
    readBoardFacts(tx as never, { academicYearId: 'year-1', schoolId: 'school-1', gradeNumbering: 'NIOARIG', basis, groupIds: ['4A'], weekday: 2, ...over });

  it('reads only the sittings the school placed when asked (Förlagda poster), and every sitting otherwise', async () => {
    const tx = world();
    await read(tx, { handPlacedSittingsOnly: true });
    expect(tx['lunchSitting']!['findMany']!.mock.calls[0]![0].where).toEqual({
      academicYearId: 'year-1',
      studentGroupId: { in: ['4A'] },
      dayOfWeek: 2,
      isGenerated: false,
    });
    await read(tx);
    expect(tx['lunchSitting']!['findMany']!.mock.calls[1]![0].where).not.toHaveProperty('isGenerated');
  });

  it('reads the school’s frames, the groups’ sittings of the weekday, the weekly rows on årskurser and the groups’ years in NIOARIG', async () => {
    const tx = world();
    const read1 = await read(tx);
    expect(read1.frames).toEqual([{ min: 1, max: 6, day: null, start: 480, end: 900 }]);
    expect(read1.sittings.get(sittingKey('4A', 2))).toEqual([{ studentGroupId: '4A', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 }]);
    expect(read1.spans.get('4A')).toEqual([4, 4]);
    expect(tx['frameTime']!['findMany']!.mock.calls[0]![0].where).toEqual({ schoolId: 'school-1' });
    expect(tx['lunchSitting']!['findMany']!.mock.calls[0]![0].where).toEqual({ academicYearId: 'year-1', studentGroupId: { in: ['4A'] }, dayOfWeek: 2 });
    const where = tx['availabilityConstraint']!['findMany']!.mock.calls[0]![0].where;
    expect(where).toMatchObject({ type: 'UNAVAILABLE', resourceType: 'GRADE_LEVEL', OR: [{ date: null, dayOfWeek: 2 }] });
    expect(loadRosters).toHaveBeenCalledWith(tx, basis, ['4A'], [{ id: '4A', gradeLevel: 4, halfOfId: null }]);
    // A template has no dated meal to read.
    expect(tx['calendarLunch']!['findMany']).not.toHaveBeenCalled();
  });

  it('puts a TIOARIG läsår’s years in NIOARIG, as every school-wide span is stated', async () => {
    const tx = world();
    (gradeSpanOf as jest.Mock).mockReturnValue({ min: 8, max: 8 });
    expect((await read(tx, { gradeNumbering: 'TIOARIG' })).spans.get('4A')).toEqual([7, 7]);
  });

  it('knows no years for a group that has no pupils and no year of its own', async () => {
    const tx = world();
    (gradeSpanOf as jest.Mock).mockReturnValue(null);
    expect((await read(tx)).spans.size).toBe(0);
  });

  describe('for one date', () => {
    const date = { day: '2027-03-23', localMinutes: (instant: Date) => instant.getUTCHours() * 60 + instant.getUTCMinutes() + 60 };

    it('also reads a row closed for the date, and states it on the date’s weekday', async () => {
      const tx = world();
      tx['availabilityConstraint']!['findMany']!.mockResolvedValue([
        { resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: null, date: new Date('2027-03-23T00:00:00.000Z'), startTime: time('10:00'), endTime: time('11:00') },
        { resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: 2, date: null, startTime: time('13:00'), endTime: time('14:00') },
      ]);
      const result = await read(tx, { date });
      expect(tx['availabilityConstraint']!['findMany']!.mock.calls[0]![0].where.OR).toEqual([{ date: null, dayOfWeek: 2 }, { date: new Date('2027-03-23T00:00:00.000Z') }]);
      expect(result.gradeRules.map((one) => [one.dayOfWeek, one.startMinutes])).toEqual([[2, 600], [2, 780]]);
    });

    it('takes the meal laid for the date in place of the weekly sitting of the same class, and keeps the weekly one of another', async () => {
      const tx = world();
      tx['lunchSitting']!['findMany']!.mockResolvedValue([
        { studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30') },
        { studentGroupId: '4B', dayOfWeek: 2, startTime: time('12:00'), endTime: time('12:30') },
      ]);
      tx['calendarLunch']!['findMany']!.mockResolvedValue([{ studentGroupId: '4A', startsAt: new Date('2027-03-23T11:00:00.000Z'), endsAt: new Date('2027-03-23T11:40:00.000Z') }]);
      const result = await read(tx, { groupIds: ['4A', '4B'], date });
      expect(tx['calendarLunch']!['findMany']!.mock.calls[0]![0].where).toEqual({ studentGroupId: { in: ['4A', '4B'] }, date: new Date('2027-03-23T00:00:00.000Z') });
      expect(result.sittings.get(sittingKey('4A', 2))).toEqual([{ studentGroupId: '4A', dayOfWeek: 2, startMinutes: 720, endMinutes: 760 }]);
      expect(result.sittings.get(sittingKey('4B', 2))).toEqual([{ studentGroupId: '4B', dayOfWeek: 2, startMinutes: 720, endMinutes: 750 }]);
    });

    it('falls back on the weekly sitting where the publication laid no meal for the class', async () => {
      const tx = world();
      const result = await read(tx, { date });
      expect(result.sittings.get(sittingKey('4A', 2))).toEqual([{ studentGroupId: '4A', dayOfWeek: 2, startMinutes: 660, endMinutes: 690 }]);
    });
  });
});
