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
import type { PrismaService } from '../database/prisma.service';
import { Role } from '../auth/enums/role.enum';
import { TeacherDutiesService, assertDutySlot } from './teacher-duties.service';

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
    'countsAsTeaching', 'subjectId', 'studentGroupId', 'blockedConstraintId', 'note',
    'createdAt', 'updatedAt',
  ],
  lock: 'FOR NO KEY UPDATE',
};

const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

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
  blockedConstraintId: null,
  note: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  blockedConstraint: null,
  ...overrides,
});

const linkedSlot = { dayOfWeek: 2, startTime: wallClock('10:00'), endTime: wallClock('10:20') };

describe('TeacherDutiesService', () => {
  let service: TeacherDutiesService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let users: Record<string, unknown>[];
  let duties: Record<string, unknown>[];
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeacherDutiesService(prisma as unknown as PrismaService);
    users = [{ id: COLLEAGUE, role: 'TEACHER' }];
    duties = [storedDuty()];
    // Two locking reads, one per table; each is held to its own lock and columns.
    queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(
        rawSql(call).includes('"TeacherDuties"')
          ? lockingRead(DUTIES, duties, call)
          : lockingRead(USERS, users, call),
      ),
    );
    Object.assign(tx, { $queryRaw: queryRaw });
  });

  describe('list', () => {
    it('hands an admin the year, narrowed to one teacher when asked, with the slot read back', async () => {
      tx.teacherDuty.findMany.mockResolvedValue([
        storedDuty({ blockedConstraintId: CONSTRAINT_ID, blockedConstraint: linkedSlot }),
      ]);

      const all = await service.list(YEAR_ID, undefined, testUser());
      expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
      expect(all[0]).toMatchObject({
        id: DUTY_ID,
        blockedConstraintId: CONSTRAINT_ID,
        blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' },
      });
      expect(all[0]).not.toHaveProperty('blockedConstraint');

      await service.list(YEAR_ID, COLLEAGUE, testUser());
      expect(tx.teacherDuty.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: COLLEAGUE } }),
      );
    });

    it('hands a teacher their own uppdrag, filtered here as well as by RLS', async () => {
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

    it('writes the uppdrag under the teacher’s row lock, with no slot and the defaults stated', async () => {
      tx.teacherDuty.create.mockResolvedValue(storedDuty());

      await service.create(body(), testUser());

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(rawSql(queryRaw.mock.calls[0]!)).toContain('"Users"');
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
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
          blockedConstraintId: null,
          note: null,
        },
        include: expect.any(Object),
      });
    });

    it('turns a blocked slot into the teacher’s own weekly UNAVAILABLE constraint, linked in the same transaction', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: NEW_CONSTRAINT_ID });
      tx.teacherDuty.create.mockResolvedValue(
        storedDuty({ blockedConstraintId: NEW_CONSTRAINT_ID, blockedConstraint: linkedSlot }),
      );

      const answer = await service.create(
        body({ kind: 'RASTVAKT', label: 'Rastvakt', blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' } }),
        testUser(),
      );

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          resourceType: 'TEACHER',
          userId: COLLEAGUE,
          type: 'UNAVAILABLE',
          reason: 'Uppdrag: Rastvakt',
          dayOfWeek: 2,
          date: null,
          startTime: wallClock('10:00'),
          endTime: wallClock('10:20'),
        },
        select: { id: true },
      });
      expect(tx.teacherDuty.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ blockedConstraintId: NEW_CONSTRAINT_ID }) }),
      );
      expect(answer.blockedSlot).toEqual({ dayOfWeek: 2, startTime: '10:00', endTime: '10:20' });
    });

    it('refuses an uppdrag for a pupil before a slot is made', async () => {
      users = [{ id: COLLEAGUE, role: 'STUDENT' }];
      await expect(
        service.create(body({ blockedSlot: { dayOfWeek: 1, startTime: '08:00', endTime: '08:30' } }), testUser()),
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

    it('answers the database’s slot refusal as the named 409', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: NEW_CONSTRAINT_ID });
      tx.teacherDuty.create.mockRejectedValue(
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
        service.create(body({ blockedSlot: { dayOfWeek: 1, startTime: '08:00', endTime: '08:30' } }), testUser()),
      ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'TEACHER_DUTY_BLOCK_MISMATCH' }) });
    });
  });

  describe('the slot’s own rules, before a transaction', () => {
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

    it('accepts a slot on the grid, HH:MM:SS with zero seconds included', () => {
      expect(() => assertDutySlot({ dayOfWeek: 5, startTime: '15:00:00', endTime: '16:30' })).not.toThrow();
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

    it('writes only what the PATCH names, and leaves the slot alone when it says nothing of it', async () => {
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { minutesPerWeek: 30, countsAsTeaching: true, note: '  ' }, testUser());
      expect(tx.teacherDuty.update).toHaveBeenCalledWith({
        where: { id: DUTY_ID },
        data: { minutesPerWeek: 30, countsAsTeaching: true, note: null },
        include: expect.any(Object),
      });
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('locks the duty row before touching its slot', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: NEW_CONSTRAINT_ID });
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { blockedSlot: { dayOfWeek: 3, startTime: '12:00', endTime: '12:30' } }, testUser());
      expect(rawSql(queryRaw.mock.calls[0]!)).toContain('"TeacherDuties"');
      expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.availabilityConstraint.create.mock.invocationCallOrder[0]!,
      );
    });

    it('creates and links a slot for a duty that had none', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: NEW_CONSTRAINT_ID });
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { blockedSlot: { dayOfWeek: 3, startTime: '12:00', endTime: '12:30' } }, testUser());
      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resourceType: 'TEACHER',
          type: 'UNAVAILABLE',
          userId: COLLEAGUE,
          dayOfWeek: 3,
          date: null,
          reason: 'Uppdrag: Rastvakt tisdag',
        }),
        select: { id: true },
      });
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { blockedConstraintId: NEW_CONSTRAINT_ID } }),
      );
    });

    it('moves the slot it already has rather than making a second one', async () => {
      duties = [storedDuty({ blockedConstraintId: CONSTRAINT_ID })];
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(
        DUTY_ID,
        { label: 'Rastvakt onsdag', blockedSlot: { dayOfWeek: 3, startTime: '10:00', endTime: '10:20' } },
        testUser(),
      );
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: {
          dayOfWeek: 3,
          date: null,
          startTime: wallClock('10:00'),
          endTime: wallClock('10:20'),
          reason: 'Uppdrag: Rastvakt onsdag',
        },
        select: { id: true },
      });
      // The link itself is unchanged, so it is not rewritten.
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { label: 'Rastvakt onsdag' } }),
      );
    });

    it('renames the slot’s reason when only the label moves', async () => {
      duties = [storedDuty({ blockedConstraintId: CONSTRAINT_ID })];
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { label: 'Rastvakt B-gården' }, testUser());
      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: { reason: 'Uppdrag: Rastvakt B-gården' },
        select: { id: true },
      });
    });

    it('removes the slot on null: unlinks first, then deletes the constraint', async () => {
      duties = [storedDuty({ blockedConstraintId: CONSTRAINT_ID })];
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { blockedSlot: null }, testUser());
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { blockedConstraintId: null } }),
      );
      expect(tx.availabilityConstraint.deleteMany).toHaveBeenCalledWith({ where: { id: CONSTRAINT_ID } });
      expect(tx.teacherDuty.update.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.availabilityConstraint.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('reads null on a duty with no slot as nothing to do', async () => {
      tx.teacherDuty.update.mockResolvedValue(storedDuty());
      await service.update(DUTY_ID, { blockedSlot: null }, testUser());
      expect(tx.availabilityConstraint.deleteMany).not.toHaveBeenCalled();
      expect(tx.teacherDuty.update).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
    });
  });

  describe('remove', () => {
    it('deletes the uppdrag and then the time it blocked, in one transaction', async () => {
      duties = [storedDuty({ blockedConstraintId: CONSTRAINT_ID })];
      await service.remove(DUTY_ID, testUser());
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.teacherDuty.delete).toHaveBeenCalledWith({ where: { id: DUTY_ID } });
      expect(tx.availabilityConstraint.deleteMany).toHaveBeenCalledWith({ where: { id: CONSTRAINT_ID } });
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
});
