import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { ExamDescriptionDto } from './dto/exam.dto';
import { ExamsService, clearLeftovers, isPlanned, viewsOf, watchMinutes, type ExamRow } from './exams.service';

const YEAR = 'year';
const SUBJECT = 'math';
const G7A = 'g7a';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const clock = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse?: () => { code?: string } }).getResponse?.().code ?? (error as Error).constructor.name;
  }
  return 'resolved';
};

const description = (over: Partial<ExamDescriptionDto> = {}): ExamDescriptionDto =>
  ({
    subjectId: SUBJECT,
    name: 'Matematik, algebra',
    lengthMinutes: 60,
    writers: 55,
    windowKind: 'WEEK',
    windowFrom: '2030-10-07',
    windowTo: '2030-10-11',
    groupIds: [G7A],
    ...over,
  }) as ExamDescriptionDto;

const row = (over: Partial<ExamRow> = {}): ExamRow => ({
  id: 'e1',
  academicYearId: YEAR,
  subjectId: SUBJECT,
  name: 'Matematik, algebra',
  lengthMinutes: 60,
  writers: 55,
  windowKind: 'WEEK',
  windowFrom: day('2030-10-07'),
  windowTo: day('2030-10-11'),
  fixedStart: null,
  earliestStart: null,
  latestEnd: null,
  activityId: null,
  lastReason: null,
  lastReasonParams: null,
  lastPlannedAt: null,
  updatedAt: new Date('2030-09-01T08:00:00.000Z'),
  groups: [{ studentGroupId: G7A }],
  sittings: [],
  activity: null,
  ...over,
});

const planned = (over: Partial<ExamRow> = {}): ExamRow =>
  row({
    activityId: 'act',
    activity: { id: 'act', removedAt: null, batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: null } },
    sittings: [{ roomId: 'r1', writers: 55, bookingId: 'b1', invigilators: [{ teacherId: 't1' }, { teacherId: 't2' }] }],
    ...over,
  });

describe('ExamsService', () => {
  let tx: TxMock;
  let service: ExamsService;
  const user = testUser();

  beforeEach(() => {
    tx = createTxMock();
    service = new ExamsService(createPrismaMock(tx) as unknown as PrismaService);
    tx.academicYear.findUnique.mockResolvedValue({ id: YEAR, startDate: day('2030-08-20'), endDate: day('2031-06-10') });
    tx.subject.findUnique.mockResolvedValue({ name: 'Matematik', countsTowardTimplan: true });
    tx.studentGroup.findMany.mockResolvedValue([{ id: G7A, name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null }]);
  });

  describe('the school’s decisions', () => {
    it('are the defaults, with the planner off, until the school saves', async () => {
      tx.examPlanSettings.findUnique.mockResolvedValue(null);
      expect(await service.settings(user)).toEqual({
        enabled: false,
        maxPerClassPerDay: 1,
        maxPerClassPerWeek: 3,
        writersPerInvigilator: 30,
        turnoverMinutes: 10,
        replacementSubject: null,
      });
    });

    it('name the replacement subject when there is one', async () => {
      tx.examPlanSettings.findUnique.mockResolvedValue({
        enabled: true,
        maxPerClassPerDay: 2,
        maxPerClassPerWeek: 4,
        writersPerInvigilator: 25,
        turnoverMinutes: 5,
        replacementSubjectId: 'prov',
      });
      tx.subject.findUnique.mockResolvedValue({ id: 'prov', name: 'Prov' });
      expect((await service.settings(user)).replacementSubject).toEqual({ id: 'prov', name: 'Prov' });
    });

    const save = (over = {}) => ({
      enabled: true,
      maxPerClassPerDay: 1,
      maxPerClassPerWeek: 3,
      writersPerInvigilator: 30,
      turnoverMinutes: 10,
      replacementSubjectId: 'prov',
      ...over,
    });

    it('are refused when a week holds fewer exams than a day', async () => {
      expect(await code(service.updateSettings(save({ maxPerClassPerDay: 3, maxPerClassPerWeek: 2 }), user))).toBe('EXAM_CAPS');
      expect(tx.examPlanSettings.upsert).not.toHaveBeenCalled();
    });

    it('are refused for a replacement subject that is missing or counts toward the timplan', async () => {
      tx.subject.findUnique.mockResolvedValueOnce(null);
      expect(await code(service.updateSettings(save(), user))).toBe('EXAM_SUBJECT');
      tx.subject.findUnique.mockResolvedValueOnce({ name: 'Matematik', countsTowardTimplan: true });
      expect(await code(service.updateSettings(save(), user))).toBe('EXAM_REPLACEMENT_SUBJECT_COUNTS');
    });

    it('are saved as the one row of the school, and read back', async () => {
      tx.subject.findUnique.mockResolvedValue({ id: 'prov', name: 'Prov', countsTowardTimplan: false });
      tx.examPlanSettings.findUnique.mockResolvedValue({ enabled: true, maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10, replacementSubjectId: 'prov' });
      const view = await service.updateSettings(save(), user);
      expect(tx.examPlanSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schoolId: user.schoolId }, create: expect.objectContaining({ schoolId: user.schoolId, enabled: true, replacementSubjectId: 'prov' }) }),
      );
      expect(view.enabled).toBe(true);
    });

    it('may leave the replacement subject unchosen', async () => {
      tx.examPlanSettings.findUnique.mockResolvedValue({ enabled: false, maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10, replacementSubjectId: null });
      await service.updateSettings(save({ enabled: false, replacementSubjectId: undefined }), user);
      expect(tx.examPlanSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ replacementSubjectId: null }) }));
      expect(tx.subject.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('the skrivsalar', () => {
    beforeEach(() => {
      tx.room.findMany.mockResolvedValue([
        { id: 'r2', name: 'Sal 10', code: null, capacity: null },
        { id: 'r1', name: 'Matsalen', code: 'M', capacity: 120 },
      ]);
      tx.examRoom.findMany.mockResolvedValue([{ roomId: 'r1', seats: 90 }]);
    });

    it('lists every room by name with the seats of the marked ones', async () => {
      expect(await service.rooms(user)).toEqual([
        { roomId: 'r1', name: 'Matsalen', code: 'M', capacity: 120, seats: 90 },
        { roomId: 'r2', name: 'Sal 10', code: null, capacity: null, seats: null },
      ]);
    });

    it('marks a room that exists, with its seats', async () => {
      tx.room.findUnique.mockResolvedValue({ id: 'r1' });
      await service.markRoom('r1', 80, user);
      expect(tx.examRoom.upsert).toHaveBeenCalledWith({
        where: { roomId: 'r1' },
        create: { roomId: 'r1', schoolId: user.schoolId, seats: 80 },
        update: { seats: 80 },
      });
    });

    it('refuses to mark a room that is not there', async () => {
      tx.room.findUnique.mockResolvedValue(null);
      expect(await code(service.markRoom('nope', 80, user))).toBe('EXAM_ROOM');
      expect(tx.examRoom.upsert).not.toHaveBeenCalled();
    });

    it('unmarks a room', async () => {
      await service.unmarkRoom('r1', user);
      expect(tx.examRoom.deleteMany).toHaveBeenCalledWith({ where: { roomId: 'r1' } });
    });
  });

  describe('an exam', () => {
    it('is written with its groups as flat rows, school and all', async () => {
      tx.exam.create.mockResolvedValue({ id: 'e1' });
      tx.exam.findUnique.mockResolvedValue(row());
      tx.subject.findMany.mockResolvedValue([{ id: SUBJECT, name: 'Matematik' }]);
      const view = await service.create({ ...description(), academicYearId: YEAR }, user);
      expect(tx.exam.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schoolId: user.schoolId,
          academicYearId: YEAR,
          subjectId: SUBJECT,
          name: 'Matematik, algebra',
          windowKind: 'WEEK',
          fixedStart: null,
          createdByUserId: user.userId,
        }),
        select: { id: true },
      });
      expect(tx.examGroup.createMany).toHaveBeenCalledWith({ data: [{ examId: 'e1', studentGroupId: G7A, schoolId: user.schoolId }] });
      expect(view.subjectName).toBe('Matematik');
    });

    const refused = async (over: Partial<ExamDescriptionDto>) => {
      const result = await code(service.create({ ...description(over), academicYearId: YEAR }, user));
      expect(tx.exam.create).not.toHaveBeenCalled();
      return result;
    };

    it('is refused without a year, a subject that counts, or groups of the year', async () => {
      tx.academicYear.findUnique.mockResolvedValueOnce(null);
      expect(await refused({})).toBe('EXAM_WINDOW');
      tx.subject.findUnique.mockResolvedValueOnce(null);
      expect(await refused({})).toBe('EXAM_SUBJECT');
      tx.subject.findUnique.mockResolvedValueOnce({ name: 'Prov', countsTowardTimplan: false });
      expect(await refused({})).toBe('EXAM_SUBJECT');
      expect(await refused({ groupIds: ['elsewhere'] })).toBe('EXAM_GROUPS');
    });

    it('is refused for a window backwards, over 31 days, or outside the year', async () => {
      expect(await refused({ windowFrom: '2030-10-11', windowTo: '2030-10-07' })).toBe('EXAM_WINDOW');
      expect(await refused({ windowFrom: '2030-10-01', windowTo: '2030-11-15' })).toBe('EXAM_WINDOW');
      expect(await refused({ windowFrom: '2030-08-01', windowTo: '2030-08-05' })).toBe('EXAM_WINDOW');
      expect(await refused({ windowFrom: '2031-06-08', windowTo: '2031-06-12' })).toBe('EXAM_WINDOW');
    });

    it('is refused for a fixed exam that is not a date and a start, or a week with a fixed start', async () => {
      expect(await refused({ windowKind: 'FIXED' })).toBe('EXAM_WINDOW');
      expect(await refused({ windowKind: 'FIXED', fixedStart: '08:20' })).toBe('EXAM_WINDOW');
      expect(await refused({ windowKind: 'FIXED', windowTo: '2030-10-07', fixedStart: '08:20', earliestStart: '08:00' })).toBe('EXAM_WINDOW');
      expect(await refused({ fixedStart: '08:20' })).toBe('EXAM_WINDOW');
      expect(await refused({ earliestStart: '12:00', latestEnd: '09:00' })).toBe('EXAM_WINDOW');
    });

    it('is written as a fixed exam with its start, and daily bounds on a week', async () => {
      tx.exam.create.mockResolvedValue({ id: 'e1' });
      tx.exam.findUnique.mockResolvedValue(row());
      await service.create({ ...description({ windowKind: 'FIXED', windowFrom: '2030-10-08', windowTo: '2030-10-08', fixedStart: '08:20' }), academicYearId: YEAR }, user);
      expect(tx.exam.create.mock.calls[0][0].data.fixedStart).toEqual(clock('08:20'));
      await service.create({ ...description({ earliestStart: '08:00', latestEnd: '15:00' }), academicYearId: YEAR }, user);
      expect(tx.exam.create.mock.calls[1][0].data).toEqual(expect.objectContaining({ earliestStart: clock('08:00'), latestEnd: clock('15:00') }));
    });

    it('is changed as a whole, and its last reason is forgotten', async () => {
      tx.exam.findUnique.mockResolvedValue(row({ lastReason: 'EXAM_NO_SLOT', lastPlannedAt: new Date() }));
      await service.update('e1', description({ name: 'Nytt namn' }), user);
      expect(tx.exam.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: expect.objectContaining({ name: 'Nytt namn', lastReason: null, lastPlannedAt: null }),
      });
      expect(tx.examGroup.deleteMany).toHaveBeenCalledWith({ where: { examId: 'e1' } });
      expect(tx.examGroup.createMany).toHaveBeenCalledWith({ data: [{ examId: 'e1', studentGroupId: G7A, schoolId: user.schoolId }] });
    });

    it('is not changed or removed while it is laid, and is not found when it is not there', async () => {
      tx.exam.findUnique.mockResolvedValue(planned());
      expect(await code(service.update('e1', description(), user))).toBe('EXAM_IS_PLANNED');
      expect(await code(service.remove('e1', user))).toBe('EXAM_IS_PLANNED');
      expect(tx.exam.update).not.toHaveBeenCalled();
      expect(tx.exam.delete).not.toHaveBeenCalled();
      tx.exam.findUnique.mockResolvedValue(null);
      expect(await code(service.update('e1', description(), user))).toBe('EXAM_NOT_FOUND');
    });

    it('is removed when it is not laid, with what a gone activity left', async () => {
      tx.exam.findUnique.mockResolvedValue(
        row({ activityId: 'act', activity: { id: 'act', removedAt: new Date(), batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: null } }, sittings: [{ roomId: 'r1', writers: 55, bookingId: 'b1', invigilators: [] }] }),
      );
      expect(await service.remove('e1', user)).toEqual({ removed: true });
      expect(tx.roomBooking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['b1'] }, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
      expect(tx.examSitting.deleteMany).toHaveBeenCalledWith({ where: { examId: { in: ['e1'] } } });
      expect(tx.exam.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });
  });

  describe('the counter', () => {
    it('counts each unmarked teacher’s passes and minutes from the exams that stand, most first', async () => {
      tx.personProtection.findMany.mockResolvedValue([{ userId: 't3' }]);
      tx.user.findMany.mockResolvedValue([
        { id: 't1', firstName: 'Anna', lastName: 'Åberg' },
        { id: 't2', firstName: 'Bo', lastName: 'Berg' },
        { id: 't3', firstName: 'Skyddad', lastName: 'Person' },
        { id: 't4', firstName: 'Cia', lastName: 'Cedr' },
      ]);
      tx.examInvigilator.findMany.mockResolvedValue([
        { teacherId: 't2', sitting: { exam: { lengthMinutes: 60 } } },
        { teacherId: 't2', sitting: { exam: { lengthMinutes: 80 } } },
        { teacherId: 't1', sitting: { exam: { lengthMinutes: 60 } } },
        { teacherId: 't3', sitting: { exam: { lengthMinutes: 60 } } },
      ]);
      const rows = await service.counter(YEAR, user);
      expect(rows).toEqual([
        { teacherId: 't2', name: 'Bo Berg', passes: 2, minutes: 140 },
        { teacherId: 't1', name: 'Anna Åberg', passes: 1, minutes: 60 },
        { teacherId: 't4', name: 'Cia Cedr', passes: 0, minutes: 0 },
      ]);
      // A marked teacher is on no list, and not counted as missing.
      expect(JSON.stringify(rows)).not.toContain('Skyddad');
    });
  });
});

describe('what an exam is, as a page reads it', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
    tx.studentGroup.findMany.mockResolvedValue([{ id: G7A, name: '7A' }]);
    tx.subject.findMany.mockResolvedValue([{ id: SUBJECT, name: 'Matematik' }]);
    tx.room.findMany.mockResolvedValue([{ id: 'r1', name: 'Matsalen' }]);
    tx.user.findMany.mockResolvedValue([
      { id: 't1', firstName: 'Anna', lastName: 'Åberg' },
      { id: 't2', firstName: 'Bo', lastName: 'Berg' },
    ]);
  });

  it('is laid when its activity stands, and shows the plan with the rooms and invigilators by name', async () => {
    const [view] = await viewsOf(tx as never, 'school', [planned()]);
    expect(isPlanned(planned())).toBe(true);
    expect(view.plan).toEqual({
      activityId: 'act',
      date: '2030-10-08',
      start: '08:20',
      end: '09:20',
      sittings: [{ roomId: 'r1', roomName: 'Matsalen', writers: 55, invigilators: [{ teacherId: 't1', name: 'Anna Åberg' }, { teacherId: 't2', name: 'Bo Berg' }] }],
    });
    expect(view.groups).toEqual([{ id: G7A, name: '7A' }]);
    expect(view.version).toBe('2030-09-01T08:00:00.000Z');
    expect(view.lastReason).toBeNull();
  });

  it('names no invigilator the school has marked, and says nothing of who is left out', async () => {
    tx.personProtection.findMany.mockResolvedValue([{ userId: 't2' }]);
    const [view] = await viewsOf(tx as never, 'school', [planned()]);
    expect(view.plan?.sittings[0].invigilators).toEqual([{ teacherId: 't1', name: 'Anna Åberg' }]);
    expect(JSON.stringify(view)).not.toContain('Bo Berg');
    expect(JSON.stringify(view)).not.toContain('t2');
  });

  it('is not laid when the activity is removed or its avbokning reversed, and keeps the last reason', async () => {
    const gone = planned({ activity: { id: 'act', removedAt: new Date(), batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: null } }, lastReason: 'EXAM_ROOMS_TAKEN', lastReasonParams: { n: 2 }, lastPlannedAt: new Date('2030-09-02T10:00:00.000Z') });
    const [view] = await viewsOf(tx as never, 'school', [gone]);
    expect(view.plan).toBeNull();
    expect(view.lastReason).toEqual({ code: 'EXAM_ROOMS_TAKEN', params: { n: 2 }, at: '2030-09-02T10:00:00.000Z' });
    const reversed = planned({ activity: { id: 'act', removedAt: null, batch: { fromDate: day('2030-10-08'), startTime: clock('08:20'), endTime: clock('09:20'), reversedAt: new Date() } } });
    expect(isPlanned(reversed)).toBe(false);
  });

  it('reads no reason as none, whatever the column holds', async () => {
    const [view] = await viewsOf(tx as never, 'school', [row({ lastReason: 'EXAM_NO_SLOT', lastReasonParams: 'x', lastPlannedAt: null })]);
    expect(view.lastReason).toEqual({ code: 'EXAM_NO_SLOT', params: {}, at: '' });
    expect(await viewsOf(tx as never, 'school', [])).toEqual([]);
  });

  it('leaves a group the year no longer has out of the exam', async () => {
    tx.studentGroup.findMany.mockResolvedValue([]);
    const [view] = await viewsOf(tx as never, 'school', [row()]);
    expect(view.groups).toEqual([]);
  });
});

describe('what a gone activity leaves', () => {
  it('is cleared: bookings cancelled, sittings and the activity link gone', async () => {
    const tx = createTxMock();
    await clearLeftovers(tx as never, [row({ activityId: 'act', sittings: [{ roomId: 'r1', writers: 5, bookingId: 'b1', invigilators: [] }, { roomId: 'r2', writers: 5, bookingId: null, invigilators: [] }] })]);
    expect(tx.roomBooking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['b1'] } }) }));
    expect(tx.examSitting.deleteMany).toHaveBeenCalledWith({ where: { examId: { in: ['e1'] } } });
    expect(tx.exam.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['e1'] }, activityId: { not: null } }, data: { activityId: null } });
  });

  it('leaves a laid exam and an exam that never was laid alone', async () => {
    const tx = createTxMock();
    await clearLeftovers(tx as never, [planned(), row()]);
    expect(tx.examSitting.deleteMany).not.toHaveBeenCalled();
    expect(tx.roomBooking.updateMany).not.toHaveBeenCalled();
  });

  it('cancels no booking when the sittings held none', async () => {
    const tx = createTxMock();
    await clearLeftovers(tx as never, [row({ sittings: [{ roomId: 'r1', writers: 5, bookingId: null, invigilators: [] }] })]);
    expect(tx.roomBooking.updateMany).not.toHaveBeenCalled();
    expect(tx.examSitting.deleteMany).toHaveBeenCalled();
  });

  it('sums a year’s watch only from the exams that stand', async () => {
    const tx = createTxMock();
    tx.examInvigilator.findMany.mockResolvedValue([{ teacherId: 't1', sitting: { exam: { lengthMinutes: 45 } } }]);
    expect(await watchMinutes(tx as never, YEAR)).toEqual(new Map([['t1', { passes: 1, minutes: 45 }]]));
    expect(tx.examInvigilator.findMany.mock.calls[0][0].where).toEqual({
      sitting: { is: { exam: { is: { academicYearId: YEAR, activity: { is: { removedAt: null, batch: { is: { reversedAt: null } } } } } } } },
    });
  });
});
