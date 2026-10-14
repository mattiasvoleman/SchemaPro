import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { lockingRead, rawSql, type LockedTable } from '../../test/utils/locking-read';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { Role } from '../auth/enums/role.enum';
import { DUTY_SLOT_REASON, TeacherDutiesService, assertDutySlot, assertDutySlots } from './teacher-duties.service';
import { DUTY_SLOTS_MAX, dutySlotConstraintData, isOnSolverGrid } from './duty-slot';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const DUTY_ID = '55555555-5555-4555-8555-555555555555';
const CONSTRAINT_ID = '66666666-6666-4666-8666-666666666666';
const NEW_CONSTRAINT_ID = '77777777-7777-4777-8777-777777777777';

const USERS: LockedTable = {
  name: 'Users',
  columns: ['id', 'schoolId', 'role', 'firstName', 'lastName', 'email', 'isActive', 'studentGroupId'],
  lock: 'FOR NO KEY UPDATE',
};

const DUTIES: LockedTable = {
  name: 'TeacherDuties',
  columns: [
    'id', 'schoolId', 'userId', 'academicYearId', 'kind', 'label', 'minutesPerWeek',
    'countsAsTeaching', 'subjectId', 'studentGroupId', 'note',
    'validFrom', 'validTo', 'createdAt', 'updatedAt',
  ],
  lock: 'FOR NO KEY UPDATE',
};

const YEARS: LockedTable = {
  name: 'AcademicYears',
  columns: ['id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive'],
  lock: 'FOR SHARE',
};

const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** One link row as the service reads it back: the constraint's weekday and clocks. */
const link = (id: string, constraintId: string, dayOfWeek: number, start: string, end: string) => ({
  id,
  availabilityConstraintId: constraintId,
  availabilityConstraint: { dayOfWeek, startTime: wallClock(start), endTime: wallClock(end) },
});

const storedDuty = (overrides: Record<string, unknown> = {}) => ({
  id: DUTY_ID,
  schoolId: SCHOOL_ID,
  userId: COLLEAGUE,
  academicYearId: YEAR_ID,
  kind: 'RASTVAKT',
  label: 'Rastvakt tisdag',
  minutesPerWeek: 20,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: null,
  note: null,
  validFrom: null,
  validTo: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  slots: [],
  ...overrides,
});

describe('TeacherDutiesService', () => {
  let service: TeacherDutiesService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let users: Record<string, unknown>[];
  let duties: Record<string, unknown>[];
  let years: Record<string, unknown>[];
  /** The duty's link rows, as replaceSlots and remove read them. */
  let links: ReturnType<typeof link>[];
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeacherDutiesService(prisma as unknown as PrismaService);
    users = [{ id: COLLEAGUE, role: 'TEACHER' }];
    duties = [storedDuty()];
    years = [{ id: YEAR_ID, startDate: day('2026-08-17'), endDate: day('2027-06-11') }];
    links = [];
    // Three locking reads, one per table; each is held to its own lock and columns.
    queryRaw = jest.fn((...call: unknown[]) => {
      const sql = rawSql(call);
      if (sql.includes('"TeacherDuties"')) return Promise.resolve(lockingRead(DUTIES, duties, call));
      if (sql.includes('"AcademicYears"')) return Promise.resolve(lockingRead(YEARS, years, call));
      return Promise.resolve(lockingRead(USERS, users, call));
    });
    Object.assign(tx, { $queryRaw: queryRaw });
    tx.teacherDutySlot.findMany.mockImplementation(() => Promise.resolve(links));
    let created = 0;
    tx.availabilityConstraint.create.mockImplementation(() =>
      Promise.resolve({ id: `c0000000-0000-4000-8000-${String(++created).padStart(12, '0')}` }),
    );
    tx.teacherDuty.create.mockResolvedValue({ id: DUTY_ID });
    tx.teacherDuty.findUniqueOrThrow.mockResolvedValue(storedDuty());
    tx.teacherDuty.update.mockResolvedValue(storedDuty());
  });

  const tableReads = (table: string) => queryRaw.mock.calls.filter((call) => rawSql(call).includes(`"${table}"`));

  describe('list', () => {
    it('hands an admin the year, narrowed to one teacher when asked, with the times read back Monday first and the dates as days', async () => {
      tx.teacherDuty.findMany.mockResolvedValue([
        storedDuty({
          validTo: day('2026-12-18'),
          slots: [link('l3', 'c3', 5, '10:00', '10:20'), link('l1', 'c1', 1, '10:00', '10:20'), link('l2', 'c2', 3, '10:00', '10:20')],
        }),
      ]);

      const all = await service.list(YEAR_ID, undefined, testUser());
      expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
      expect(all[0]).toMatchObject({
        id: DUTY_ID,
        validFrom: null,
        validTo: '2026-12-18',
        slots: [
          { dayOfWeek: 1, startTime: '10:00', endTime: '10:20' },
          { dayOfWeek: 3, startTime: '10:00', endTime: '10:20' },
          { dayOfWeek: 5, startTime: '10:00', endTime: '10:20' },
        ],
        // The previous web's one time, for one release: the first.
        blockedSlot: { dayOfWeek: 1, startTime: '10:00', endTime: '10:20' },
      });

      await service.list(YEAR_ID, COLLEAGUE, testUser());
      expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: COLLEAGUE } }),
      );
    });

    it('records whose uppdrag it handed out as EMPLOYMENT, in its transaction; an empty answer records nothing', async () => {
      tx.teacherDuty.findMany.mockResolvedValue([storedDuty(), storedDuty({ id: 'other', userId: ME })]);
      await service.list(YEAR_ID, undefined, testUser({ channel: 'WEB' }));
      // The reader's own id goes too; app.personal_data_read drops it.
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE, ME] }]);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);

      tx.teacherDuty.findMany.mockResolvedValue([]);
      await service.list(YEAR_ID, COLLEAGUE, testUser());
      expect(recordedReads(tx)).toHaveLength(1);
    });

    it('reads a link whose constraint has no weekday as no time rather than half of one', async () => {
      tx.teacherDuty.findMany.mockResolvedValue([
        storedDuty({ slots: [{ id: 'l', availabilityConstraintId: 'c', availabilityConstraint: { dayOfWeek: null, startTime: wallClock('10:00'), endTime: wallClock('11:00') } }] }),
      ]);
      const [row] = await service.list(YEAR_ID, undefined, testUser());
      expect(row).toMatchObject({ slots: [], blockedSlot: null });
    });

    it('hands a teacher their own uppdrag, filtered here as well as by RLS', async () => {
      tx.teacherDuty.findMany.mockResolvedValue([]);
      await service.list(YEAR_ID, undefined, testUser({ role: Role.TEACHER }));
      expect(tx.teacherDuty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: ME } }),
      );
      // Asking for themselves by id is the same question.
      await service.list(YEAR_ID, ME, testUser({ role: Role.TEACHER }));
      expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: ME } }),
      );
    });

    it('403s a teacher naming a colleague, before anything is read', async () => {
      await expect(
        service.list(YEAR_ID, COLLEAGUE, testUser({ role: Role.TEACHER })),
      ).rejects.toThrow(new ForbiddenException('Du kan bara läsa dina egna uppdrag.'));
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      userId: COLLEAGUE,
      academicYearId: YEAR_ID,
      kind: 'MENTORSKAP' as const,
      label: '  Mentor 7B ',
      minutesPerWeek: 60,
      ...overrides,
    });

    it('writes the uppdrag under the teacher’s row lock, with no time, undated, the defaults stated', async () => {
      await service.create(body(), testUser());

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(rawSql(queryRaw.mock.calls[0]!)).toContain('"Users"');
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.teacherDutySlot.createMany).not.toHaveBeenCalled();
      expect(tx.teacherDuty.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          userId: COLLEAGUE,
          academicYearId: YEAR_ID,
          kind: 'MENTORSKAP',
          label: 'Mentor 7B',
          minutesPerWeek: 60,
          countsAsTeaching: false,
          subjectId: null,
          studentGroupId: null,
          validFrom: null,
          validTo: null,
          note: null,
        },
        select: { id: true },
      });
      // The old one-time column is never written.
      expect(tx.teacherDuty.create.mock.calls[0]![0].data).not.toHaveProperty('blockedConstraintId');
    });

    it('turns each time into the teacher’s own weekly UNAVAILABLE constraint, Monday first, and links them all in ONE statement', async () => {
      tx.teacherDuty.findUniqueOrThrow.mockResolvedValue(
        storedDuty({ slots: [link('l1', 'c1', 1, '10:00', '10:20'), link('l2', 'c3', 5, '10:00', '10:20')] }),
      );

      const answer = await service.create(
        body({
          kind: 'RASTVAKT',
          label: 'Rastvakt',
          slots: [
            { dayOfWeek: 5, startTime: '10:00', endTime: '10:20' },
            { dayOfWeek: 1, startTime: '10:00', endTime: '10:20' },
            { dayOfWeek: 3, startTime: '10:00', endTime: '10:20' },
          ],
        }),
        testUser(),
      );

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.availabilityConstraint.create.mock.calls.map((call) => call[0])).toEqual(
        [1, 3, 5].map((dayOfWeek) => ({
          data: dutySlotConstraintData(SCHOOL_ID, COLLEAGUE, { dayOfWeek, startTime: '10:00', endTime: '10:20' }),
          select: { id: true },
        })),
      );
      expect(tx.availabilityConstraint.create.mock.calls[0]![0].data).toEqual({
        schoolId: SCHOOL_ID,
        resourceType: 'TEACHER',
        userId: COLLEAGUE,
        roomId: null,
        studentGroupId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
        type: 'UNAVAILABLE',
        reason: DUTY_SLOT_REASON,
        dayOfWeek: 1,
        date: null,
        startTime: wallClock('10:00'),
        endTime: wallClock('10:20'),
      });
      // One statement for the links: the history writes one version, "0 → 3".
      expect(tx.teacherDutySlot.createMany).toHaveBeenCalledTimes(1);
      expect(tx.teacherDutySlot.createMany).toHaveBeenCalledWith({
        data: [1, 2, 3].map((n) => ({
          schoolId: SCHOOL_ID,
          teacherDutyId: DUTY_ID,
          availabilityConstraintId: `c0000000-0000-4000-8000-00000000000${n}`,
        })),
      });
      // The links after the duty, the answer after both.
      expect(tx.teacherDuty.create.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.teacherDutySlot.createMany.mock.invocationCallOrder[0]!,
      );
      expect(tx.teacherDuty.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: DUTY_ID } }),
      );
      expect(answer.slots).toEqual([
        { dayOfWeek: 1, startTime: '10:00', endTime: '10:20' },
        { dayOfWeek: 5, startTime: '10:00', endTime: '10:20' },
      ]);
      expect(answer.blockedSlot).toEqual({ dayOfWeek: 1, startTime: '10:00', endTime: '10:20' });
    });

    it('takes the previous web’s single blockedSlot as a list of one, for one release', async () => {
      await service.create(
        body({ kind: 'RASTVAKT', label: 'Rastvakt', blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' } }),
        testUser(),
      );
      expect(tx.availabilityConstraint.create).toHaveBeenCalledTimes(1);
      expect(tx.availabilityConstraint.create.mock.calls[0]![0].data).toEqual(
        dutySlotConstraintData(SCHOOL_ID, COLLEAGUE, { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' }),
      );
      expect(tx.teacherDutySlot.createMany).toHaveBeenCalledTimes(1);
    });

    it('refuses a body with both slots and blockedSlot before a transaction', async () => {
      await expect(
        service.create(
          body({ slots: [], blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' } }),
          testUser(),
        ),
      ).rejects.toThrow('slots och blockedSlot: ange uppdragets tider i slots');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('never copies the label into a time: every colleague reads AvailabilityConstraints', async () => {
      // availability_teacher_select hands every TEACHER of the school every
      // constraint row; the label is HR data that teacher_own_select keeps
      // from colleagues, so it must not ride along in `reason`.
      expect(DUTY_SLOT_REASON).toBe('Uppdrag');
      await service.create(
        body({ kind: 'FORSTELARARE', label: 'Förstelärare matematik', slots: [{ dayOfWeek: 4, startTime: '13:00', endTime: '15:00' }] }),
        testUser(),
      );
      const written = JSON.stringify([tx.availabilityConstraint.create.mock.calls, tx.teacherDutySlot.createMany.mock.calls]);
      expect(written).not.toContain('Förstelärare');
      expect(written).not.toContain('FORSTELARARE');
    });

    it('refuses an uppdrag for a pupil before a time is made', async () => {
      users = [{ id: COLLEAGUE, role: 'STUDENT' }];
      await expect(
        service.create(body({ slots: [{ dayOfWeek: 1, startTime: '08:00', endTime: '08:30' }] }), testUser()),
      ).rejects.toThrow(
        new BadRequestException('Ett uppdrag hör till en lärare. Elever och vårdnadshavare undervisar inte.'),
      );
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.teacherDuty.create).not.toHaveBeenCalled();
    });

    it('404s a person RLS hides', async () => {
      users = [];
      await expect(service.create(body(), testUser())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers the database’s refusal of a link as the named 409', async () => {
      tx.teacherDutySlot.createMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('TEACHER_DUTY_BLOCK_MISMATCH: x', {
          code: 'P2010',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: {
              cause: {
                originalCode: 'TD409',
                originalMessage: 'TEACHER_DUTY_BLOCK_MISMATCH: x',
                detail: `teacherDutyId=${DUTY_ID} availabilityConstraintId=${NEW_CONSTRAINT_ID}`,
                kind: 'postgres',
              },
            },
          },
        }),
      );
      await expect(
        service.create(body({ slots: [{ dayOfWeek: 1, startTime: '08:00', endTime: '08:30' }] }), testUser()),
      ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'TEACHER_DUTY_BLOCK_MISMATCH' }) });
    });

    describe('Från and Till', () => {
      it('measures them against the year’s bounds read FOR SHARE, after the staff lock, and writes them as days', async () => {
        await service.create(body({ validFrom: '2027-01-07', validTo: '2027-06-11' }), testUser());
        expect(tableReads('AcademicYears')).toHaveLength(1);
        expect(rawSql(queryRaw.mock.calls[0]!)).toContain('"Users"');
        expect(rawSql(queryRaw.mock.calls[1]!)).toContain('"AcademicYears"');
        expect(tx.teacherDuty.create.mock.calls[0]![0].data).toMatchObject({
          validFrom: day('2027-01-07'),
          validTo: day('2027-06-11'),
        });
      });

      it('reads no bounds for an undated uppdrag: null follows the year wherever it goes', async () => {
        await service.create(body({ validFrom: null, validTo: null }), testUser());
        expect(tableReads('AcademicYears')).toHaveLength(0);
      });

      it.each([
        ['a Från before the year', { validFrom: '2026-08-16' }, 'validFrom: 2026-08-16 ligger utanför läsåret (2026-08-17 – 2027-06-11).'],
        ['a Till after the year', { validTo: '2027-06-12' }, 'validTo: 2027-06-12 ligger utanför läsåret (2026-08-17 – 2027-06-11).'],
      ])('refuses %s, naming the field and the year', async (_case, dates, message) => {
        await expect(service.create(body(dates), testUser())).rejects.toThrow(message);
        expect(tx.teacherDuty.create).not.toHaveBeenCalled();
      });

      it('accepts both bounds on the year’s own first and last day', async () => {
        await service.create(body({ validFrom: '2026-08-17', validTo: '2027-06-11' }), testUser());
        expect(tx.teacherDuty.create).toHaveBeenCalled();
      });

      it('refuses Till before Från before a transaction', async () => {
        await expect(
          service.create(body({ validFrom: '2027-01-07', validTo: '2026-12-18' }), testUser()),
        ).rejects.toThrow('validTo: Till (2026-12-18) ligger före Från (2027-01-07).');
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('leaves a year RLS hides to the foreign key rather than describing it', async () => {
        years = [];
        await service.create(body({ validFrom: '2030-01-01' }), testUser());
        expect(tx.teacherDuty.create).toHaveBeenCalled();
      });
    });
  });

  describe('the times’ own rules, before a transaction', () => {
    it.each([
      ['seconds', { dayOfWeek: 2, startTime: '10:00:30', endTime: '10:20' }, 'blockedSlot.startTime: anges i hela minuter'],
      ['off the grid', { dayOfWeek: 2, startTime: '10:00', endTime: '10:22' }, 'blockedSlot.endTime: 10:22 ligger inte på schemats 5-minutersrutnät. Närmast är 10:20 eller 10:25.'],
      ['an empty window', { dayOfWeek: 2, startTime: '10:20', endTime: '10:20' }, 'blockedSlot: starttiden (10:20) måste ligga före sluttiden (10:20).'],
      ['an inverted window', { dayOfWeek: 2, startTime: '11:00', endTime: '10:00' }, 'måste ligga före sluttiden'],
    ])('refuses %s', async (_case, slot, message) => {
      expect(() => assertDutySlot(slot)).toThrow(message);
      await expect(
        service.create(
          { userId: COLLEAGUE, academicYearId: YEAR_ID, kind: 'RASTVAKT', label: 'R', minutesPerWeek: 20, blockedSlot: slot },
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('names the time by its place in `slots`', async () => {
      await expect(
        service.create(
          {
            userId: COLLEAGUE,
            academicYearId: YEAR_ID,
            kind: 'RASTVAKT',
            label: 'R',
            minutesPerWeek: 20,
            slots: [
              { dayOfWeek: 1, startTime: '10:00', endTime: '10:20' },
              { dayOfWeek: 3, startTime: '10:00', endTime: '10:22' },
            ],
          },
          testUser(),
        ),
      ).rejects.toThrow('slots[1].endTime: 10:22 ligger inte på schemats 5-minutersrutnät.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses two times of one uppdrag sharing a minute, naming both; touching ends and other days are two times', () => {
      expect(() =>
        assertDutySlots([
          { dayOfWeek: 3, startTime: '10:00', endTime: '10:30' },
          { dayOfWeek: 3, startTime: '10:25', endTime: '10:45' },
        ]),
      ).toThrow('slots[1]: onsdag 10:25–10:45 överlappar 10:00–10:30 samma dag. Ett uppdrag håller en tid en gång.');
      expect(() =>
        assertDutySlots([
          { dayOfWeek: 3, startTime: '10:00', endTime: '10:30' },
          { dayOfWeek: 3, startTime: '10:30', endTime: '10:45' },
          { dayOfWeek: 4, startTime: '10:00', endTime: '10:30' },
        ]),
      ).not.toThrow();
    });

    it('holds fifteen times, three rasts a day for five days', () => {
      expect(DUTY_SLOTS_MAX).toBe(15);
    });

    it('accepts a slot on the grid, HH:MM:SS with zero seconds included', () => {
      expect(() => assertDutySlot({ dayOfWeek: 5, startTime: '15:00:00', endTime: '16:30' })).not.toThrow();
    });

    it('answers the same question as the non-throwing isOnSolverGrid the rollover asks', () => {
      for (const slot of [
        { dayOfWeek: 2, startTime: '10:00:30', endTime: '10:20' },
        { dayOfWeek: 2, startTime: '10:00', endTime: '10:22' },
        { dayOfWeek: 2, startTime: '10:20', endTime: '10:20' },
        { dayOfWeek: 2, startTime: '11:00', endTime: '10:00' },
        { dayOfWeek: 5, startTime: '15:00:00', endTime: '16:30' },
        { dayOfWeek: 1, startTime: '07:55', endTime: '08:10' },
      ]) {
        let throws = false;
        try {
          assertDutySlot(slot);
        } catch {
          throws = true;
        }
        expect({ slot, onGrid: isOnSolverGrid(slot) }).toEqual({ slot, onGrid: !throws });
      }
    });
  });

  describe('update', () => {
    it('404s a duty RLS hides, before writing anything', async () => {
      duties = [];
      await expect(service.update(DUTY_ID, { minutesPerWeek: 30 }, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.teacherDuty.update).not.toHaveBeenCalled();
    });

    it('writes only what the PATCH names, and reads no time when it says nothing of the times', async () => {
      await service.update(DUTY_ID, { minutesPerWeek: 30, countsAsTeaching: true, note: '  ' }, testUser());
      expect(tx.teacherDuty.update).toHaveBeenCalledWith({
        where: { id: DUTY_ID },
        data: { minutesPerWeek: 30, countsAsTeaching: true, note: null },
        include: expect.any(Object),
      });
      expect(tx.teacherDutySlot.findMany).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('locks the duty row before reading or touching its times', async () => {
      await service.update(DUTY_ID, { slots: [{ dayOfWeek: 3, startTime: '12:00', endTime: '12:30' }] }, testUser());
      expect(rawSql(queryRaw.mock.calls[0]!)).toContain('"TeacherDuties"');
      expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.teacherDutySlot.findMany.mock.invocationCallOrder[0]!);
      expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.availabilityConstraint.create.mock.invocationCallOrder[0]!);
    });

    it('creates and links times for a duty that had none, in one link statement', async () => {
      await service.update(
        DUTY_ID,
        { slots: [{ dayOfWeek: 3, startTime: '12:00', endTime: '12:30' }, { dayOfWeek: 1, startTime: '12:00', endTime: '12:30' }] },
        testUser(),
      );
      expect(tx.availabilityConstraint.create.mock.calls.map((call) => call[0].data.dayOfWeek)).toEqual([1, 3]);
      expect(tx.teacherDutySlot.createMany).toHaveBeenCalledTimes(1);
      expect(tx.teacherDutySlot.createMany.mock.calls[0]![0].data).toHaveLength(2);
      expect(tx.teacherDutySlot.deleteMany).not.toHaveBeenCalled();
      // The duty row itself is untouched by a change of times.
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
    });

    it('keeps a time that stays, and adds the new one beside it', async () => {
      links = [link('l-tue', CONSTRAINT_ID, 2, '10:00', '10:20')];
      await service.update(
        DUTY_ID,
        { slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '10:20' }, { dayOfWeek: 4, startTime: '10:00', endTime: '10:20' }] },
        testUser(),
      );
      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.create).toHaveBeenCalledTimes(1);
      expect(tx.availabilityConstraint.create.mock.calls[0]![0].data).toMatchObject({ dayOfWeek: 4 });
      expect(tx.teacherDutySlot.deleteMany).not.toHaveBeenCalled();
    });

    it('moves a time it already has rather than making a second one: the link stays, the history counts no change', async () => {
      links = [link('l-tue', CONSTRAINT_ID, 2, '10:00', '10:20')];
      await service.update(
        DUTY_ID,
        { label: 'Rastvakt onsdag', slots: [{ dayOfWeek: 3, startTime: '10:00', endTime: '10:20' }] },
        testUser(),
      );
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.teacherDutySlot.createMany).not.toHaveBeenCalled();
      expect(tx.teacherDutySlot.deleteMany).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: {
          dayOfWeek: 3,
          date: null,
          startTime: wallClock('10:00'),
          endTime: wallClock('10:20'),
          reason: DUTY_SLOT_REASON,
        },
        select: { id: true },
      });
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { label: 'Rastvakt onsdag' } }),
      );
    });

    it('removes the times no longer wanted in ONE statement on their links, which takes their constraints', async () => {
      links = [
        link('l-mon', 'c-mon', 1, '10:00', '10:20'),
        link('l-wed', 'c-wed', 3, '10:00', '10:20'),
        link('l-fri', 'c-fri', 5, '10:00', '10:20'),
      ];
      await service.update(DUTY_ID, { slots: [{ dayOfWeek: 3, startTime: '10:00', endTime: '10:20' }] }, testUser());
      expect(tx.teacherDutySlot.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.teacherDutySlot.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['l-mon', 'l-fri'] } } });
      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
    });

    it('removes every time on an empty list, and on the previous web’s null', async () => {
      links = [link('l-tue', CONSTRAINT_ID, 2, '10:00', '10:20')];
      await service.update(DUTY_ID, { slots: [] }, testUser());
      expect(tx.teacherDutySlot.deleteMany).toHaveBeenLastCalledWith({ where: { id: { in: ['l-tue'] } } });
      await service.update(DUTY_ID, { blockedSlot: null }, testUser());
      expect(tx.teacherDutySlot.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('reads an empty list on a duty with no times as nothing to do', async () => {
      await service.update(DUTY_ID, { slots: [] }, testUser());
      expect(tx.teacherDutySlot.deleteMany).not.toHaveBeenCalled();
      expect(tx.teacherDutySlot.createMany).not.toHaveBeenCalled();
    });

    it('replaces a link whose constraint has no weekday like any unwanted time', async () => {
      links = [{ id: 'l-odd', availabilityConstraintId: 'c-odd', availabilityConstraint: { dayOfWeek: null, startTime: wallClock('10:00'), endTime: wallClock('11:00') } } as never];
      await service.update(DUTY_ID, { slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '10:20' }] }, testUser());
      expect(tx.availabilityConstraint.create).toHaveBeenCalledTimes(1);
      expect(tx.teacherDutySlot.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['l-odd'] } } });
    });

    describe('Från and Till', () => {
      it('measures a PATCH of Till alone with the Från on the row, against the year read FOR SHARE', async () => {
        duties = [storedDuty({ validFrom: day('2027-01-07') })];
        await expect(service.update(DUTY_ID, { validTo: '2026-12-18' }, testUser())).rejects.toThrow(
          'validTo: Till (2026-12-18) ligger före Från (2027-01-07).',
        );
        expect(tx.teacherDuty.update).not.toHaveBeenCalled();

        await service.update(DUTY_ID, { validTo: '2027-03-31' }, testUser());
        expect(tableReads('AcademicYears')).toHaveLength(2);
        expect(tx.teacherDuty.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: { validTo: day('2027-03-31') } }),
        );
      });

      it('refuses a date outside the year, and clears with null without reading the year', async () => {
        await expect(service.update(DUTY_ID, { validFrom: '2027-07-01' }, testUser())).rejects.toThrow(
          'validFrom: 2027-07-01 ligger utanför läsåret',
        );
        queryRaw.mockClear();
        duties = [storedDuty({ validFrom: day('2027-01-07') })];
        await service.update(DUTY_ID, { validFrom: null, validTo: null }, testUser());
        expect(tableReads('AcademicYears')).toHaveLength(0);
        expect(tx.teacherDuty.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: { validFrom: null, validTo: null } }),
        );
      });

      it('reads no bounds when the PATCH names no date', async () => {
        await service.update(DUTY_ID, { minutesPerWeek: 45 }, testUser());
        expect(tableReads('AcademicYears')).toHaveLength(0);
      });
    });
  });

  describe('remove', () => {
    it('deletes the uppdrag and then the times it blocked, in one transaction', async () => {
      links = [link('l1', CONSTRAINT_ID, 2, '10:00', '10:20'), link('l2', NEW_CONSTRAINT_ID, 4, '10:00', '10:20')];
      await service.remove(DUTY_ID, testUser());
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.teacherDuty.delete).toHaveBeenCalledWith({ where: { id: DUTY_ID } });
      expect(tx.availabilityConstraint.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [CONSTRAINT_ID, NEW_CONSTRAINT_ID] } },
      });
      expect(tx.teacherDuty.delete.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.availabilityConstraint.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('deletes no constraint for an uppdrag without a time', async () => {
      await service.remove(DUTY_ID, testUser());
      expect(tx.teacherDuty.delete).toHaveBeenCalled();
      expect(tx.availabilityConstraint.deleteMany).not.toHaveBeenCalled();
    });

    it('404s a duty RLS hides', async () => {
      duties = [];
      await expect(service.remove(DUTY_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.teacherDuty.delete).not.toHaveBeenCalled();
    });
  });

  describe('the leave requests a MENTORSKAP gives (Mentorns ledighetsbeslut)', () => {
    const MENTOR_NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const LEAVE_ID = '88888888-8888-4888-8888-888888888888';
    let deliver: jest.Mock;

    beforeEach(() => {
      deliver = jest.fn();
      service = new TeacherDutiesService(
        prisma as unknown as PrismaService,
        { deliver } as unknown as NotificationsService,
      );
      const locking = queryRaw.getMockImplementation()!;
      queryRaw.mockImplementation((...call: unknown[]) =>
        rawSql(call).includes('app.leave_requests_tell_new_mentors()')
          ? Promise.resolve([
              { notificationId: MENTOR_NOTICE, userId: COLLEAGUE, email: null, meta: { leaveRequestId: LEAVE_ID, schoolDays: 2 } },
            ])
          : locking(...call),
      );
    });

    const toldMentors = () => queryRaw.mock.calls.filter((call) => rawSql(call).includes('app.leave_requests_tell_new_mentors()'));

    it('tells the mentors a new MENTORSKAP gives pending requests, in the same transaction', async () => {
      await service.create(
        { userId: COLLEAGUE, academicYearId: YEAR_ID, kind: 'MENTORSKAP', label: 'Mentor 7B', minutesPerWeek: 60 },
        testUser(),
      );

      expect(toldMentors()).toHaveLength(1);
      expect(deliver).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: 'LEAVE_REQUESTED', recipients: [{ userId: COLLEAGUE, notificationId: MENTOR_NOTICE }] }),
      );
    });

    it('tells them after an update that leaves the uppdrag a MENTORSKAP, and asks nothing of another kind', async () => {
      tx.teacherDuty.update.mockResolvedValue(storedDuty({ kind: 'MENTORSKAP' }));
      await service.update(DUTY_ID, { minutesPerWeek: 30 }, testUser());
      expect(toldMentors()).toHaveLength(1);

      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { minutesPerWeek: 30 }, testUser());
      await service.create({ userId: COLLEAGUE, academicYearId: YEAR_ID, kind: 'RASTVAKT', label: 'Rastvakt', minutesPerWeek: 20 }, testUser());
      expect(toldMentors()).toHaveLength(1);
    });
  });
});
