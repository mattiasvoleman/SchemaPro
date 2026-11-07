import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { landingContextOf } from '../publication/draft-publish';
import { datedConflicts, localMinutes, type DatedPlacement } from './dated-conflicts';

jest.mock('../publication/draft-publish', () => ({ landingContextOf: jest.fn() }));

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const noLand = { breakDays: new Map(), closuresByDate: new Map(), gradeOfGroup: new Map([['class-1', 4]]), timezone: 'Europe/Stockholm' };

// Tuesday 23 March 2027, CET (UTC+1): 10:00-11:00 on the school's clock is 09:00-10:00 UTC.
const placement = (over: Partial<DatedPlacement> = {}): DatedPlacement => ({
  lessonId: 'lesson-1',
  academicYearId: 'year-1',
  date: '2027-03-23',
  startsAt: new Date('2027-03-23T09:00:00.000Z'),
  endsAt: new Date('2027-03-23T10:00:00.000Z'),
  roomId: 'room-1',
  studentGroupId: 'class-1',
  teacherIds: ['teacher-1'],
  extraGroupIds: [],
  timezone: 'Europe/Stockholm',
  ...over,
});

const other = (over: Record<string, unknown> = {}) => ({
  roomId: null,
  startsAt: new Date('2027-03-23T09:30:00.000Z'),
  endsAt: new Date('2027-03-23T10:30:00.000Z'),
  studentGroupId: 'class-9',
  studentGroup: { name: '5B', halfOfId: null },
  subject: { name: 'Svenska' },
  teachers: [],
  extraGroups: [],
  ...over,
});

function setup() {
  const tx: TxMock = createTxMock();
  (landingContextOf as jest.Mock).mockResolvedValue(noLand);
  return tx;
}

describe('localMinutes', () => {
  it('is the wall clock of the school, winter and summer', () => {
    expect(localMinutes(new Date('2027-03-23T09:00:00.000Z'), 'Europe/Stockholm')).toBe(600);
    expect(localMinutes(new Date('2027-06-15T08:00:00.000Z'), 'Europe/Stockholm')).toBe(600);
    expect(localMinutes(new Date('2027-03-23T23:30:00.000Z'), 'Europe/Stockholm')).toBe(30);
  });
});

describe('datedConflicts', () => {
  it('finds nothing in an empty day', async () => {
    expect(await datedConflicts(setup() as never, placement())).toEqual([]);
  });

  it('asks only about lessons that hold their hour and overlap this one, and names a clash by what clashes', async () => {
    const tx = setup();
    tx['calendarLesson']!['findMany']!.mockResolvedValue([
      other({ teachers: [{ teacherId: 'teacher-1' }], roomId: 'room-1' }),
    ]);
    const found = await datedConflicts(tx as never, placement());
    expect(found.map((view) => view.kind).sort()).toEqual(['ROOM', 'TEACHER']);
    expect(found[0]!.other).toEqual({ className: '5B', subjectName: 'Svenska', date: '2027-03-23', start: '10:30', end: '11:30' });
    const where = tx['calendarLesson']!['findMany']!.mock.calls[0]![0].where;
    expect(where).toEqual({
      id: { not: 'lesson-1' },
      status: { in: ['SCHEDULED', 'COMPLETED'] },
      startsAt: { lt: new Date('2027-03-23T10:00:00.000Z') },
      endsAt: { gt: new Date('2027-03-23T09:00:00.000Z') },
    });
    // Nobody is named: no teacher id or name in what is told.
    expect(JSON.stringify(found)).not.toContain('teacher-1');
  });

  it('counts the class, its halves and a class that joins as the same children', async () => {
    const tx = setup();
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'half-1' }]);
    tx['calendarLesson']!['findMany']!.mockResolvedValue([
      other({ studentGroupId: 'half-1', studentGroup: { name: '4A-h1', halfOfId: 'class-1' } }),
      other({ studentGroupId: 'class-9', extraGroups: [{ studentGroupId: 'class-1' }] }),
      other({ studentGroupId: 'class-9' }),
    ]);
    const found = await datedConflicts(tx as never, placement({ roomId: null, teacherIds: [] }));
    expect(found.map((view) => view.kind)).toEqual(['GROUP', 'GROUP']);
    expect(tx['studentGroup']!['findMany']).toHaveBeenCalledWith({ where: { halfOfId: { in: ['class-1'] } }, select: { id: true } });
  });

  it('tells a clash once, however many ways it clashes', async () => {
    const tx = setup();
    const same = other({ studentGroupId: 'class-1', teachers: [{ teacherId: 'teacher-1' }] });
    tx['calendarLesson']!['findMany']!.mockResolvedValue([same, same]);
    const found = await datedConflicts(tx as never, placement({ roomId: null }));
    expect(found.map((view) => view.kind).sort()).toEqual(['GROUP', 'TEACHER']);
  });

  it('is blocked by an approved booking of the room, and only of a room', async () => {
    const tx = setup();
    tx['roomBooking']!['findFirst']!.mockResolvedValue({ id: 'booking-1' });
    expect(await datedConflicts(tx as never, placement())).toEqual([{ kind: 'BOOKING' }]);
    tx['roomBooking']!['findFirst']!.mockClear();
    await datedConflicts(tx as never, placement({ roomId: null }));
    expect(tx['roomBooking']!['findFirst']).not.toHaveBeenCalled();
  });

  it('is blocked by an unavailable hour, weekly or for the date, of the teacher, the room or the class', async () => {
    const weekly = { dayOfWeek: 2, date: null, startTime: time('10:30'), endTime: time('11:30') };
    const dated = { dayOfWeek: null, date: new Date('2027-03-23T00:00:00.000Z'), startTime: time('08:00'), endTime: time('10:30') };
    const wrongDay = { dayOfWeek: 3, date: null, startTime: time('08:00'), endTime: time('17:00') };
    const wrongDate = { dayOfWeek: null, date: new Date('2027-03-24T00:00:00.000Z'), startTime: time('08:00'), endTime: time('17:00') };
    const wrongHour = { dayOfWeek: 2, date: null, startTime: time('11:00'), endTime: time('12:00') };
    const touching = { dayOfWeek: 2, date: null, startTime: time('11:00'), endTime: time('12:00') };
    for (const [constraint, blocks] of [[weekly, true], [dated, true], [wrongDay, false], [wrongDate, false], [wrongHour, false], [touching, false]] as const) {
      const tx = setup();
      tx['availabilityConstraint']!['findMany']!.mockResolvedValue([constraint]);
      const found = await datedConflicts(tx as never, placement());
      expect(found.some((view) => view.kind === 'AVAILABILITY')).toBe(blocks);
    }
    const tx = setup();
    await datedConflicts(tx as never, placement({ roomId: null, teacherIds: [] }));
    expect(tx['availabilityConstraint']!['findMany']!.mock.calls[0]![0].where).toEqual({
      type: 'UNAVAILABLE',
      OR: [{ studentGroupId: { in: ['class-1'] } }],
    });
    await datedConflicts(tx as never, placement());
    expect(tx['availabilityConstraint']!['findMany']!.mock.calls[1]![0].where.OR).toEqual([
      { userId: { in: ['teacher-1'] } },
      { roomId: 'room-1' },
      { studentGroupId: { in: ['class-1'] } },
    ]);
  });

  it('is blocked by a lov, or by the class being closed, as a publish is', async () => {
    const tx = setup();
    (landingContextOf as jest.Mock).mockResolvedValue({
      ...noLand,
      breakDays: new Map([['2027-03-23', [{ startDate: new Date('2027-03-22'), endDate: new Date('2027-03-26'), minGradeLevel: null, maxGradeLevel: null }]]]),
    });
    expect(await datedConflicts(tx as never, placement())).toEqual([{ kind: 'BREAK' }]);
    expect(landingContextOf).toHaveBeenCalledWith(tx, 'year-1', '2027-03-23', '2027-03-23', 'Europe/Stockholm');
  });
});
