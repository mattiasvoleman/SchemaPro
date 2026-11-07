import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { readPersonDays } from '../cover/cover-context';
import type { PersonDay } from '../cover/cover-rules';
import type { PrismaService } from '../database/prisma.service';
import type { OptimizationProxyService } from '../optimization/optimization-proxy.service';
import { loadGroupFacts, memberHomes, ownersWithPupils } from '../publication/activity-replacements';
import type { ScheduleActivitiesService } from '../publication/schedule-activities.service';
import { createCreditInTransaction } from '../timplan/timplan-credits.service';
import type { ApplyExamPlanDto, ApplyItemDto } from './dto/exam.dto';
import { ExamPlannerService } from './exam-planner.service';
import type { ExamRow } from './exams.service';
import type { PlanExamsResponse } from './interfaces/exam-engine.interface';

jest.mock('../cover/cover-context', () => ({
  ...jest.requireActual('../cover/cover-context'),
  schoolTimezone: jest.fn().mockResolvedValue('UTC'),
  readPersonDays: jest.fn(),
}));
jest.mock('../publication/activity-replacements', () => ({
  ...jest.requireActual('../publication/activity-replacements'),
  loadGroupFacts: jest.fn(),
  memberHomes: jest.fn(),
  ownersWithPupils: jest.fn(),
}));
jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn().mockResolvedValue('DIRECT') }));
jest.mock('../timplan/timplan-credits.service', () => ({
  ...jest.requireActual('../timplan/timplan-credits.service'),
  createCreditInTransaction: jest.fn(),
}));

const personDays = readPersonDays as jest.MockedFunction<typeof readPersonDays>;
const groupFacts = loadGroupFacts as jest.MockedFunction<typeof loadGroupFacts>;
const homesOf = memberHomes as jest.MockedFunction<typeof memberHomes>;
const owners = ownersWithPupils as jest.MockedFunction<typeof ownersWithPupils>;
const credit = createCreditInTransaction as jest.MockedFunction<typeof createCreditInTransaction>;

const YEAR = 'year';
const SUBJECT = 'math';
const PROV = 'prov';
const G7A = 'g7a';
const R1 = 'r1';
const R2 = 'r2';
const DATE = '2030-10-08'; // a Tuesday
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const clockOf = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const instant = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00.000Z`);

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse?: () => { code?: string } }).getResponse?.().code ?? (error as Error).constructor.name;
  }
  return 'resolved';
};

const row = (over: Partial<ExamRow> = {}): ExamRow => ({
  id: 'e1',
  academicYearId: YEAR,
  subjectId: SUBJECT,
  name: 'Matematik, algebra',
  lengthMinutes: 60,
  writers: 28,
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

const standing = (id: string, date: string, from: string, to: string, group = G7A): ExamRow =>
  row({
    id,
    groups: [{ studentGroupId: group }],
    activityId: `act-${id}`,
    activity: { id: `act-${id}`, removedAt: null, batch: { fromDate: day(date), startTime: clockOf(from), endTime: clockOf(to), reversedAt: null } },
  });

const teacherDay = (userId: string, busyFrom?: string, busyTo?: string): PersonDay => ({
  userId,
  isActiveTeacher: true,
  lessons:
    busyFrom && busyTo
      ? [{ id: `${userId}-l`, date: DATE, start: instant(DATE, busyFrom).getTime(), end: instant(DATE, busyTo).getTime(), status: 'SCHEDULED', studentGroupId: 'other', subjectId: 'swe' }]
      : [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: true, windows: [] },
});

const lessonRow = (id: string, date: string, from: string, to: string, subjectId = 'swe', group = G7A) => ({
  id,
  date: day(date),
  startsAt: instant(date, from),
  endsAt: instant(date, to),
  subjectId,
  studentGroupId: group,
  extraGroups: [],
});

describe('ExamPlannerService', () => {
  let tx: TxMock;
  let service: ExamPlannerService;
  let engine: jest.Mock;
  let activities: { createWithin: jest.Mock; settleCreated: jest.Mock; remove: jest.Mock };
  const user = testUser();

  let world: {
    settings: Record<string, unknown> | null;
    exams: ExamRow[];
    lessons: ReturnType<typeof lessonRow>[];
    roomLessons: unknown[];
    teachers: string[];
    marked: string[];
    days: Record<string, PersonDay>;
    examRooms: Array<{ roomId: string; seats: number }>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx = createTxMock();
    engine = jest.fn();
    activities = { createWithin: jest.fn(), settleCreated: jest.fn(), remove: jest.fn() };
    service = new ExamPlannerService(
      createPrismaMock(tx) as unknown as PrismaService,
      { callAiEngine: engine } as unknown as OptimizationProxyService,
      activities as unknown as ScheduleActivitiesService,
    );
    world = {
      settings: { enabled: true, maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10, replacementSubjectId: PROV },
      exams: [row()],
      lessons: [lessonRow('l1', DATE, '08:20', '09:20'), lessonRow('l2', '2030-10-09', '08:20', '09:20', SUBJECT)],
      roomLessons: [],
      teachers: ['t1', 't2', 't3'],
      marked: [],
      days: { t1: teacherDay('t1'), t2: teacherDay('t2'), t3: teacherDay('t3', '08:00', '10:00') },
      examRooms: [
        { roomId: R1, seats: 30 },
        { roomId: R2, seats: 60 },
      ],
    };
    tx.examPlanSettings.findUnique.mockImplementation(async () => world.settings);
    tx.subject.findUnique.mockImplementation(async () => ({ id: PROV, name: 'Prov' }));
    tx.examRoom.findMany.mockImplementation(async () => world.examRooms);
    tx.exam.findMany.mockImplementation(async () => world.exams);
    tx.schoolBreak.findMany.mockResolvedValue([]);
    tx.calendarLesson.findMany.mockImplementation(async (args: { where?: { roomId?: unknown } }) => (args?.where?.roomId ? world.roomLessons : world.lessons));
    tx.personProtection.findMany.mockImplementation(async () => world.marked.map((userId) => ({ userId })));
    tx.user.findMany.mockImplementation(async (args: { where?: { id?: { in: string[] } } }) => {
      const wanted = args?.where?.id?.in;
      return world.teachers.filter((id) => !wanted || wanted.includes(id)).map((id) => ({ id, firstName: id.toUpperCase(), lastName: 'Lärare' }));
    });
    tx.room.findMany.mockResolvedValue([
      { id: R1, name: 'Sal 1' },
      { id: R2, name: 'Matsalen' },
    ]);
    tx.examInvigilator.findMany.mockResolvedValue([{ teacherId: 't1', sitting: { exam: { lengthMinutes: 60 } } }]);
    personDays.mockImplementation(async (_tx, options) => ({
      days: new Map(Object.entries(world.days).filter(([id]) => (options.known ?? []).some((known) => known.id === id))),
      employments: new Map(),
      poolMembers: new Set(),
    }));
    groupFacts.mockResolvedValue([{ id: G7A, name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null }]);
    homesOf.mockResolvedValue(new Map());
    owners.mockResolvedValue({ owners: [], planOwners: [{ groupId: G7A, pupils: new Set(['p1', 'p2', 'p3']) }] });
  });

  const answerFor = (build: (ids: { exam: string; rooms: Map<string, string>; teachers: Map<string, string> }) => Partial<PlanExamsResponse>) => {
    engine.mockImplementation(async (_path: string, payload: { requestId: string; exams: Array<{ id: string }>; rooms: Array<{ id: string }>; teachers: Array<{ id: string }> }) => {
      // The payload carries only fresh ids: the i-th of each kind stands for the i-th real one.
      const rooms = new Map([[R1, payload.rooms[0].id], [R2, payload.rooms[1].id]]);
      const teachers = new Map(world.teachers.map((id, index) => [id, payload.teachers[index]?.id ?? '']));
      return {
        requestId: payload.requestId,
        status: 'OPTIMAL',
        placed: [],
        unplaced: [],
        invigilatorMinutes: [],
        metrics: { placed: 0, unplaced: 0, loss: 0, roomsUsed: 0, invigilatorPasses: 0, maxLoad: 0, minLoad: 0, solveSeconds: 0.1 },
        ...build({ exam: payload.exams[0].id, rooms, teachers }),
      };
    });
  };

  describe('proposing', () => {
    it('is refused while the school has not turned the planner on', async () => {
      world.settings = { ...world.settings!, enabled: false };
      expect(await code(service.propose({ academicYearId: YEAR }, user))).toBe('EXAM_PLANNING_OFF');
      expect(engine).not.toHaveBeenCalled();
    });

    it('is refused without a replacement subject, and without a single skrivsal', async () => {
      world.settings = null;
      expect(await code(service.propose({ academicYearId: YEAR }, user))).toBe('EXAM_PLANNING_OFF');
      world.settings = { enabled: true, maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10, replacementSubjectId: null };
      expect(await code(service.propose({ academicYearId: YEAR }, user))).toBe('EXAM_NO_REPLACEMENT_SUBJECT');
      world.settings = { ...world.settings, replacementSubjectId: PROV };
      world.examRooms = [];
      expect(await code(service.propose({ academicYearId: YEAR }, user))).toBe('EXAM_NO_ROOMS');
    });

    it('has nothing to plan when no exam is left unplaced', async () => {
      world.exams = [standing('x', DATE, '10:00', '11:00', 'g9z')];
      expect(await service.propose({ academicYearId: YEAR }, user)).toEqual({ status: 'NOTHING_TO_PLAN', placed: [], unplaced: [], counter: [], metrics: null });
      expect(engine).not.toHaveBeenCalled();
    });

    it('sends the engine fresh ids only, and answers with the placement in names', async () => {
      answerFor(({ exam, rooms, teachers }) => ({
        placed: [{ exam, slot: 0, rooms: [{ room: rooms.get(R1)!, writers: 28, invigilators: [teachers.get('t2')!] }] }],
        invigilatorMinutes: [{ teacher: teachers.get('t2')!, minutes: 60 }],
        metrics: { placed: 1, unplaced: 0, loss: 60, roomsUsed: 1, invigilatorPasses: 1, maxLoad: 60, minLoad: 0, solveSeconds: 0.2 },
      }));
      const proposal = await service.propose({ academicYearId: YEAR }, user);
      const [path, payload, , options] = engine.mock.calls[0];
      expect(path).toBe('/api/v1/plan-exams');
      expect(options).toEqual({ timeoutMs: 90_000 });
      const wire = JSON.stringify(payload);
      for (const real of ['e1', G7A, R1, R2, 't1', 't2', 't3']) expect(wire).not.toContain(`"${real}"`);
      expect(payload.limits).toEqual({ maxPerClassPerDay: 1, maxPerClassPerWeek: 3, writersPerInvigilator: 30, turnoverMinutes: 10 });
      // t3 is busy 08:00-10:00 on the first day: blocked at that slot.
      expect(payload.exams[0].teacherBlocks).toHaveLength(1);

      expect(proposal.status).toBe('OPTIMAL');
      expect(proposal.placed).toEqual([
        {
          examId: 'e1',
          name: 'Matematik, algebra',
          version: '2030-09-01T08:00:00.000Z',
          date: DATE,
          start: '08:20',
          end: '09:20',
          loss: 60,
          rooms: [{ roomId: R1, roomName: 'Sal 1', writers: 28, classes: ['7A'], invigilators: [{ teacherId: 't2', name: 'T2 Lärare' }] }],
        },
      ]);
      expect(proposal.unplaced).toEqual([]);
      // The counter: t1 has a pass already; t2 gets one.
      expect(proposal.counter).toEqual([
        { teacherId: 't1', name: 'T1 Lärare', passes: 1, minutes: 60, addedPasses: 0, addedMinutes: 0 },
        { teacherId: 't2', name: 'T2 Lärare', passes: 0, minutes: 0, addedPasses: 1, addedMinutes: 60 },
      ]);
      // A placed exam has no reason on it, and its version did not move.
      expect(tx.exam.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: expect.objectContaining({ lastReason: null, updatedAt: new Date('2030-09-01T08:00:00.000Z') }),
      });
    });

    it('leaves a teacher with a protected identity out of the pool and off every list', async () => {
      world.marked = ['t2'];
      answerFor(({ exam, rooms, teachers }) => ({ placed: [{ exam, slot: 0, rooms: [{ room: rooms.get(R1)!, writers: 28, invigilators: [teachers.get('t1')!] }] }] }));
      const proposal = await service.propose({ academicYearId: YEAR }, user);
      const [, payload] = engine.mock.calls[0];
      // The pool the engine sees is t1 and t3: the marked teacher is not in it, whoever the engine would have picked.
      expect(payload.teachers).toHaveLength(2);
      expect(JSON.stringify(proposal)).not.toContain('T2 Lärare');
    });

    it('asks for no more exams than the engine takes in one request', async () => {
      world.exams = Array.from({ length: 301 }, (_, index) => row({ id: `many-${index}` }));
      expect(await code(service.propose({ academicYearId: YEAR }, user))).toBe('EXAM_TOO_MANY');
      expect(engine).not.toHaveBeenCalled();
    });

    it('keeps what the engine says of an exam it left out, on the exam', async () => {
      answerFor(({ exam }) => ({
        unplaced: [{ exam, reason: 'EXAM_ROOMS_TAKEN', params: { rooms: 2 }, message: 'rooms taken' }],
      }));
      const proposal = await service.propose({ academicYearId: YEAR }, user);
      expect(proposal.unplaced).toEqual([{ examId: 'e1', name: 'Matematik, algebra', reason: 'EXAM_ROOMS_TAKEN', params: { rooms: 2 }, message: 'rooms taken' }]);
      expect(tx.exam.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: expect.objectContaining({ lastReason: 'EXAM_ROOMS_TAKEN', lastReasonParams: { rooms: 2 }, updatedAt: new Date('2030-09-01T08:00:00.000Z') }),
      });
    });

    it('does not ask the engine about an exam that has no time, and says why itself', async () => {
      world.lessons = [];
      const proposal = await service.propose({ academicYearId: YEAR }, user);
      expect(engine).not.toHaveBeenCalled();
      expect(proposal.status).toBe('OPTIMAL');
      expect(proposal.unplaced).toEqual([{ examId: 'e1', name: 'Matematik, algebra', reason: 'EXAM_NO_LESSON_TO_REPLACE', params: {}, message: null }]);
      expect(proposal.metrics).toEqual(expect.objectContaining({ placed: 0, unplaced: 1 }));
    });

    it('gives a reason for an exam whose classes are gone, and plans only the exams asked for', async () => {
      world.exams = [row({ groups: [{ studentGroupId: 'deleted' }] }), row({ id: 'e2' })];
      answerFor(({ exam }) => ({ unplaced: [{ exam, reason: 'EXAM_NO_SLOT', params: {}, message: 'no slot' }] }));
      const all = await service.propose({ academicYearId: YEAR }, user);
      expect(all.unplaced.map((one) => [one.examId, one.reason]).sort()).toEqual([['e1', 'EXAM_GROUPS_GONE'], ['e2', 'EXAM_NO_SLOT']]);
      engine.mockClear();
      const only = await service.propose({ academicYearId: YEAR, examIds: ['e1'] }, user);
      expect(engine).not.toHaveBeenCalled();
      expect(only.unplaced.map((one) => one.reason)).toEqual(['EXAM_GROUPS_GONE']);
    });

    it('asks again about an exam whose activity is gone, and cleans up what it left', async () => {
      world.exams = [
        row({ activityId: 'act', activity: { id: 'act', removedAt: new Date(), batch: { fromDate: day(DATE), startTime: clockOf('08:20'), endTime: clockOf('09:20'), reversedAt: null } }, sittings: [{ roomId: R1, writers: 28, bookingId: 'b1', invigilators: [] }] }),
      ];
      answerFor(({ exam }) => ({ unplaced: [{ exam, reason: 'EXAM_NOT_REACHED', params: {}, message: 'late' }] }));
      await service.propose({ academicYearId: YEAR }, user);
      expect(tx.roomBooking.updateMany).toHaveBeenCalled();
      expect(engine).toHaveBeenCalled();
    });

    it('counts the exams that stand toward the caps and the clash, and as watch already done', async () => {
      world.exams = [row(), standing('x', DATE, '08:00', '09:30')];
      answerFor(({ exam }) => ({ unplaced: [{ exam, reason: 'EXAM_NOT_REACHED', params: {}, message: '' }] }));
      await service.propose({ academicYearId: YEAR }, user);
      const [, payload] = engine.mock.calls[0];
      // The first day's time lies on the exam that stands for the same class: one slot is left.
      expect(payload.exams[0].slots).toHaveLength(1);
      expect(payload.existingDayLoad).toHaveLength(1);
    });
  });

  describe('applying', () => {
    const item = (over: Partial<ApplyItemDto> = {}): ApplyItemDto => ({
      examId: 'e1',
      examVersion: '2030-09-01T08:00:00.000Z',
      date: DATE,
      start: '08:20',
      rooms: [{ roomId: R1, writers: 28, teacherIds: ['t2'] }],
      ...over,
    });
    const dto = (items: ApplyItemDto[] = [item()], over: Partial<ApplyExamPlanDto> = {}): ApplyExamPlanDto => ({ academicYearId: YEAR, items, ...over });

    beforeEach(() => {
      world.exams = [row()];
      tx.exam.findUnique.mockImplementation(async () => world.exams[0]);
      activities.createWithin.mockResolvedValue({ id: 'act-new', batchId: 'batch-new', schoolId: user.schoolId, mode: 'DIRECT', take: [], synced: { created: [], updated: [], deleted: [], kept: [] }, credits: 0, range: { from: DATE, to: DATE } });
      tx.scheduleActivity.findUniqueOrThrow.mockResolvedValue({ batchId: 'batch-new' });
      credit.mockResolvedValue({ id: 'credit-1' } as never);
      tx.roomBooking.create.mockResolvedValue({ id: 'booking-1' });
      tx.scheduleActivityLesson.findFirst.mockResolvedValue({ calendarLessonId: 'cl-1' });
      tx.user.findMany.mockImplementation(async () => [{ id: 't2' }]);
      owners.mockResolvedValue({ owners: [], planOwners: [{ groupId: G7A, pupils: new Set(['p1', 'p2', 'p3']) }] });
    });

    it('makes the exam an activity with its credit, booking, sitting, invigilators and room', async () => {
      const result = await service.apply(dto(), user);
      expect(result).toEqual({ outcomes: [{ examId: 'e1', ok: true, activityId: 'act-new' }], applied: 1, failed: 0 });

      expect(activities.createWithin).toHaveBeenCalledWith(
        tx,
        user,
        expect.objectContaining({
          academicYearId: YEAR,
          name: 'Prov: Matematik, algebra',
          fromDate: DATE,
          toDate: DATE,
          startTime: '08:20',
          endTime: '09:20',
          scope: 'GROUPS',
          groupIds: [G7A],
          replacementSubjectId: PROV,
          teachers: [{ studentGroupId: G7A, teacherId: 't2', role: 'LEAD' }],
          notify: true,
        }),
      );
      // The credit: the exam's own minutes to its own subject, linked to the activity's avbokning.
      expect(credit).toHaveBeenCalledWith(
        tx,
        user.schoolId,
        expect.objectContaining({ date: DATE, minutes: 60, subjectId: SUBJECT, name: 'Prov: Matematik, algebra', studentGroupId: G7A }),
        expect.anything(),
      );
      expect(tx.cancellationBatchCredit.create).toHaveBeenCalledWith({ data: { batchId: 'batch-new', creditId: 'credit-1', schoolId: user.schoolId } });
      // The booking holds the room for the exam, and the sitting and invigilators follow it.
      expect(tx.roomBooking.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ roomId: R1, bookedById: user.userId, status: 'APPROVED', startsAt: instant(DATE, '08:20'), endsAt: instant(DATE, '09:20') }),
      );
      expect(tx.examSitting.create).toHaveBeenCalledWith({ data: { examId: 'e1', roomId: R1, schoolId: user.schoolId, writers: 28, bookingId: 'booking-1' } });
      expect(tx.examInvigilator.createMany).toHaveBeenCalledWith({ data: [{ examId: 'e1', roomId: R1, teacherId: 't2', schoolId: user.schoolId }] });
      // The class's lesson is held where its writers sit.
      expect(tx.calendarLesson.update).toHaveBeenCalledWith({ where: { id: 'cl-1' }, data: { roomId: R1 } });
      expect(tx.exam.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: expect.objectContaining({ activityId: 'act-new', lastReason: null }) });
      expect(activities.settleCreated).toHaveBeenCalledTimes(1);
    });

    it('puts every invigilator of a room on the replacement lesson of each class that sits there', async () => {
      world.exams = [row({ writers: 50, groups: [{ studentGroupId: G7A }, { studentGroupId: 'g7b' }] })];
      groupFacts.mockResolvedValue([
        { id: G7A, name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
        { id: 'g7b', name: '7B', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
      ]);
      owners.mockResolvedValue({
        owners: [],
        planOwners: [
          { groupId: G7A, pupils: new Set(Array.from({ length: 25 }, (_, i) => `a${i}`)) },
          { groupId: 'g7b', pupils: new Set(Array.from({ length: 25 }, (_, i) => `b${i}`)) },
        ],
      });
      tx.user.findMany.mockImplementation(async () => [{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
      world.days = { t1: teacherDay('t1'), t2: teacherDay('t2'), t3: teacherDay('t3') };
      await service.apply(dto([item({ rooms: [{ roomId: R2, writers: 50, teacherIds: ['t1', 't2'] }] })]), user);
      const sent = activities.createWithin.mock.calls[0][2];
      expect(sent.teachers).toEqual([
        { studentGroupId: G7A, teacherId: 't1', role: 'LEAD' },
        { studentGroupId: G7A, teacherId: 't2', role: 'ASSISTANT' },
        { studentGroupId: 'g7b', teacherId: 't1', role: 'LEAD' },
        { studentGroupId: 'g7b', teacherId: 't2', role: 'ASSISTANT' },
      ]);
    });

    it('lays one exam of a year at a time: it takes the year’s lock first, and answers busy when it cannot get it', async () => {
      await service.apply(dto(), user);
      const statements = tx.$executeRaw.mock.calls.map((call) => (call[0] as TemplateStringsArray).join('?'));
      expect(statements[0]).toContain("lock_timeout = '5s'");
      expect(statements[1]).toContain("pg_advisory_xact_lock(hashtext('exam-apply')");
      tx.$executeRaw.mockRejectedValue(new Error('canceling statement due to lock timeout (55P03)'));
      const busy = await service.apply(dto(), user);
      expect(busy.outcomes).toEqual([{ examId: 'e1', ok: false, code: 'EXAM_BUSY', message: 'Ett annat prov läggs just nu: försök igen om en stund.' }]);
    });

    it('does not tell the families when asked not to', async () => {
      await service.apply(dto([item()], { notify: false }), user);
      expect(activities.createWithin.mock.calls[0][2].notify).toBe(false);
    });

    const refused = async (over: Partial<ApplyItemDto> | null, prep?: () => void) => {
      prep?.();
      const result = await service.apply(dto(over === null ? [item()] : [item(over)]), user);
      expect(result.applied).toBe(0);
      expect(activities.createWithin).not.toHaveBeenCalled();
      expect(tx.roomBooking.create).not.toHaveBeenCalled();
      return result.outcomes[0].code;
    };

    it('refuses an exam that has changed since the proposal, is laid already, or is of another year', async () => {
      expect(await refused({ examVersion: '2030-09-02T00:00:00.000Z' })).toBe('EXAM_STALE');
      expect(await refused(null, () => { world.exams = [standing('e1', DATE, '10:00', '11:00')]; })).toBe('EXAM_IS_PLANNED');
      world.exams = [row({ academicYearId: 'other' })];
      expect(await refused(null)).toBe('EXAM_PLACEMENT');
    });

    it('refuses when the planner is off, the exam is gone, or its classes are', async () => {
      expect(await refused(null, () => { world.settings = { ...world.settings!, enabled: false }; })).toBe('EXAM_PLANNING_OFF');
      world.settings = { ...world.settings!, enabled: true };
      tx.exam.findUnique.mockResolvedValueOnce(null);
      expect(await refused(null)).toBe('EXAM_NOT_FOUND');
      expect(await refused(null, () => { world.exams = [row({ groups: [{ studentGroupId: 'deleted' }] })]; })).toBe('EXAM_PLACEMENT');
    });

    it('refuses a time that is not tomorrow or later, a weekend, outside the window, or past the bounds', async () => {
      expect(await refused({ date: '2020-10-08' })).toBe('EXAM_PLACEMENT');
      expect(await refused({ date: '2030-10-12' })).toBe('EXAM_PLACEMENT');
      expect(await refused({ date: '2030-10-14' })).toBe('EXAM_PLACEMENT');
      expect(await refused({ start: '23:30' })).toBe('EXAM_PLACEMENT');
      expect(await refused({}, () => { world.exams = [row({ earliestStart: clockOf('09:00') })]; })).toBe('EXAM_PLACEMENT');
      expect(await refused({}, () => { world.exams = [row({ latestEnd: clockOf('09:00') })]; })).toBe('EXAM_PLACEMENT');
      expect(await refused({}, () => { world.exams = [row({ windowKind: 'FIXED', windowFrom: day(DATE), windowTo: day(DATE), fixedStart: clockOf('10:00') })]; })).toBe('EXAM_PLACEMENT');
    });

    it('refuses a day the exam’s classes have off', async () => {
      expect(await refused({}, () => { tx.schoolBreak.findMany.mockResolvedValue([{ startDate: day(DATE), endDate: day(DATE), minGradeLevel: null, maxGradeLevel: null }]); })).toBe('EXAM_PLACEMENT');
    });

    it('refuses rooms that are not skrivsalar, too small, repeated, or seat the wrong number', async () => {
      expect(await refused({ rooms: [{ roomId: 'elsewhere', writers: 28, teacherIds: ['t2'] }] })).toBe('EXAM_PLACEMENT');
      expect(await refused({ rooms: [{ roomId: R1, writers: 31, teacherIds: ['t2'] }] })).toBe('EXAM_PLACEMENT');
      expect(await refused({ rooms: [{ roomId: R1, writers: 14, teacherIds: ['t2'] }, { roomId: R1, writers: 14, teacherIds: ['t1'] }] })).toBe('EXAM_PLACEMENT');
      expect(await refused({ rooms: [{ roomId: R1, writers: 20, teacherIds: ['t2'] }] })).toBe('EXAM_PLACEMENT');
    });

    it('refuses fewer invigilators than a room needs, a teacher in two rooms, and a teacher who may not keep watch', async () => {
      world.exams = [row({ writers: 40 })];
      expect(await refused({ rooms: [{ roomId: R2, writers: 40, teacherIds: ['t2'] }] })).toBe('EXAM_PLACEMENT');
      expect(await refused({ rooms: [{ roomId: R1, writers: 20, teacherIds: ['t2'] }, { roomId: R2, writers: 20, teacherIds: ['t2'] }] })).toBe('EXAM_PLACEMENT');
      world.exams = [row()];
      tx.user.findMany.mockImplementation(async () => []);
      expect(await refused({})).toBe('EXAM_PLACEMENT');
      tx.user.findMany.mockImplementation(async () => [{ id: 't2' }]);
      world.marked = ['t2'];
      expect(await refused({})).toBe('EXAM_PLACEMENT');
    });

    it('refuses an invigilator who is no longer free, and a room that is no longer free', async () => {
      world.marked = [];
      world.days = { t2: teacherDay('t2', '08:00', '10:00') };
      expect(await refused({})).toBe('EXAM_PLACEMENT');
      world.days = { t2: teacherDay('t2') };
      expect(await refused({}, () => { world.roomLessons = [{ id: 'rl', date: day(DATE), roomId: R1, startsAt: instant(DATE, '08:00'), endsAt: instant(DATE, '10:00'), status: 'SCHEDULED', studentGroupId: 'other', extraGroups: [] }]; })).toBe('EXAM_ROOM_TAKEN');
    });

    it('refuses a time on an exam that stands for the same class, and the caps', async () => {
      world.days = { t2: teacherDay('t2') };
      world.roomLessons = [];
      const standingRows = (rows: ExamRow[]) => tx.exam.findMany.mockImplementation(async () => rows);
      expect(await refused({}, () => standingRows([standing('x', DATE, '08:00', '09:00')]))).toBe('EXAM_PLACEMENT');
      // One exam that day already, the cap is one a day.
      expect(await refused({}, () => standingRows([standing('x', DATE, '12:00', '13:00')]))).toBe('EXAM_PLACEMENT');
      world.settings = { ...world.settings!, maxPerClassPerDay: 2, maxPerClassPerWeek: 2 };
      expect(await refused({}, () => standingRows([standing('x', '2030-10-10', '12:00', '13:00'), standing('y', '2030-10-09', '12:00', '13:00')]))).toBe('EXAM_PLACEMENT');
    });

    it('says the room was taken when the booking meets another booking, and lays nothing', async () => {
      world.days = { t2: teacherDay('t2') };
      world.roomLessons = [];
      const { Prisma } = jest.requireActual('@prisma/client');
      tx.roomBooking.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Database error: RoomBookings_room_is_held_once', { code: 'P2039', clientVersion: '7' }),
      );
      const result = await service.apply(dto(), user);
      expect(result.outcomes).toEqual([{ examId: 'e1', ok: false, code: 'EXAM_ROOM_TAKEN', message: 'En sal hann bokas av någon annan.' }]);
      expect(tx.examSitting.create).not.toHaveBeenCalled();
      expect(activities.settleCreated).not.toHaveBeenCalled();
    });

    it('lets one exam fail without stopping the others, and names why', async () => {
      world.days = { t2: teacherDay('t2') };
      world.exams = [row(), row({ id: 'e2' })];
      tx.exam.findUnique.mockImplementation(async (args: { where: { id: string } }) => world.exams.find((exam) => exam.id === args.where.id) ?? null);
      activities.createWithin.mockRejectedValueOnce(new Error('boom'));
      const result = await service.apply(dto([item(), item({ examId: 'e2' })]), user);
      expect(result.outcomes).toEqual([
        { examId: 'e1', ok: false, code: 'EXAM_APPLY_FAILED', message: 'Provet kunde inte läggas.' },
        { examId: 'e2', ok: true, activityId: 'act-new' },
      ]);
      expect(result).toEqual(expect.objectContaining({ applied: 1, failed: 1 }));
    });
  });

  describe('unplanning', () => {
    it('removes the activity by its own remove, then what the exam holds beside it', async () => {
      tx.exam.findUnique.mockResolvedValue(standing('e1', DATE, '08:20', '09:20'));
      await service.unplan('e1', user);
      expect(activities.remove).toHaveBeenCalledWith('act-e1', user);
      expect(tx.exam.findUnique).toHaveBeenCalledTimes(2);
    });

    it('says an exam that is not laid is not laid, and cleans up an exam whose activity is gone', async () => {
      tx.exam.findUnique.mockResolvedValue(row());
      expect(await code(service.unplan('e1', user))).toBe('EXAM_NOT_PLANNED');
      expect(activities.remove).not.toHaveBeenCalled();
      tx.exam.findUnique.mockResolvedValue(row({ activityId: 'act', activity: { id: 'act', removedAt: new Date(), batch: { fromDate: day(DATE), startTime: clockOf('08:20'), endTime: clockOf('09:20'), reversedAt: null } }, sittings: [{ roomId: R1, writers: 28, bookingId: 'b1', invigilators: [] }] }));
      expect(await service.unplan('e1', user)).toEqual({ removed: true });
      expect(activities.remove).not.toHaveBeenCalled();
      expect(tx.examSitting.deleteMany).toHaveBeenCalled();
    });
  });
});
