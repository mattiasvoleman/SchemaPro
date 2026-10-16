import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { StudentGroupsService } from './student-groups.service';
import type {
  CreateStudentGroupDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

type Selection = Record<string, unknown>;

/**
 * What Prisma hands back for a `select`: the fields asked for and nothing else,
 * a relation through its own nested `select` (or whole, when it is named
 * without one), and a refusal for a selection with no truthy field in it
 * ("needs at least one truthy value"). A stub that returns the whole row
 * whatever the query asked for proves only that the service trusts its stub.
 */
function selected(
  row: Record<string, unknown>,
  select?: Selection,
): Record<string, unknown> {
  if (select === undefined) return row;
  const fields = Object.entries(select).filter(([, value]) => value);
  if (fields.length === 0) {
    throw new Error('Prisma: a `select` needs at least one truthy value.');
  }
  return Object.fromEntries(
    fields.map(([field, value]) => {
      const nested = (value as { select?: Selection }).select;
      const related = row[field];
      if (!nested) return [field, related];
      // A to-one relation that is not there reads null, as Prisma gives it.
      if (related === null || related === undefined) return [field, null];
      return [
        field,
        Array.isArray(related)
          ? related.map((entry: Record<string, unknown>) => selected(entry, nested))
          : selected(related as Record<string, unknown>, nested),
      ];
    }),
  );
}

/** The user filter setMembers sends, read the way Prisma reads it. */
function personMatches(
  where: Record<string, unknown>,
  person: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'id') {
      // `id: {}` is no condition at all; `id: { in }` is membership.
      const { in: ids, ...rest } = condition as { in?: string[] };
      if (Object.keys(rest).length > 0) {
        throw new Error(`Unhandled id condition: ${Object.keys(rest).join(', ')}`);
      }
      return ids === undefined || ids.includes(person['id'] as string);
    }
    if (key === 'role' || key === 'isActive') return person[key] === condition;
    throw new Error(`The student filter grew a condition tests do not know: ${key}`);
  });
}

/**
 * Rows in the order a single-path `orderBy` asks for (`{ student: { lastName:
 * 'asc' } }`), following the path into the relation. Anything else throws
 * rather than being ignored, so a sort that loses its field fails loudly.
 */
function sortedBy<T>(rows: T[], orderBy: unknown): T[] {
  if (orderBy === undefined) return rows;
  const path: string[] = [];
  let node: unknown = orderBy;
  while (typeof node === 'object' && node !== null) {
    const entries = Object.entries(node);
    if (entries.length !== 1) {
      throw new Error(`An orderBy names one field per level: ${JSON.stringify(orderBy)}`);
    }
    path.push(entries[0][0]);
    node = entries[0][1];
  }
  if (node !== 'asc' && node !== 'desc') {
    throw new Error(`An orderBy direction is asc or desc, not ${JSON.stringify(node)}`);
  }
  const direction = node === 'asc' ? 1 : -1;
  const valueOf = (row: T) =>
    path.reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)[key],
      row,
    ) as string;
  return [...rows].sort((a, b) =>
    valueOf(a) === valueOf(b) ? 0 : valueOf(a) < valueOf(b) ? -direction : direction,
  );
}

describe('StudentGroupsService', () => {
  let service: StudentGroupsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StudentGroupsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateStudentGroupDto> = {},
  ): CreateStudentGroupDto => ({
    academicYearId: YEAR_ID,
    name: '7A',
    ...overrides,
  });

  describe('create', () => {
    it('creates the group with the tenant from the principal, gradeLevel defaulting to null', async () => {
      const row = { id: GROUP_ID };
      tx.studentGroup.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          name: '7A',
          // A group is a home class unless somebody says otherwise: mislabelling
          // one as a teaching group would stop it being its members' home class.
          kind: 'CLASS',
          gradeLevel: null,
        },
      });
    });

    it('persists an explicit grade level', async () => {
      tx.studentGroup.create.mockResolvedValue({ id: GROUP_ID });

      await service.create(dto({ gradeLevel: 7 }), testUser());

      expect(tx.studentGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ gradeLevel: 7 }),
        }),
      );
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a bad academicYearId (P2003, invisible under RLS) to 409', async () => {
      tx.studentGroup.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('sends only the provided fields', async () => {
      const row = { id: GROUP_ID, name: '7B' };
      tx.studentGroup.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(GROUP_ID, { name: '7B' }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.update).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
        data: { name: '7B' },
      });
    });

    it('moves a class’s halves to its new årskurs with it, and nothing for any other group', async () => {
      tx.studentGroup.update.mockResolvedValueOnce({ id: GROUP_ID, kind: 'CLASS', schoolId: SCHOOL_ID });
      tx.studentGroup.updateMany.mockResolvedValue({ count: 2 });

      await service.update(GROUP_ID, { gradeLevel: 8 }, testUser());
      expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({ where: { halfOfId: GROUP_ID }, data: { gradeLevel: 8 } });

      tx.studentGroup.updateMany.mockClear();
      tx.studentGroup.update.mockResolvedValueOnce({ id: GROUP_ID, kind: 'CLASS', schoolId: SCHOOL_ID });
      await service.update(GROUP_ID, { name: '7B' }, testUser());
      tx.studentGroup.update.mockResolvedValueOnce({ id: GROUP_ID, kind: 'TEACHING_GROUP', schoolId: SCHOOL_ID });
      await service.update(GROUP_ID, { gradeLevel: 8 }, testUser());
      expect(tx.studentGroup.updateMany).not.toHaveBeenCalled();
    });

    it('clears the grade level with an explicit null', async () => {
      tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID });

      await service.update(GROUP_ID, { gradeLevel: null }, testUser());

      expect(tx.studentGroup.update).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
        data: { gradeLevel: null },
      });
    });

    it.each<[string, UpdateStudentGroupDto]>([
      ['the academic year', { academicYearId: YEAR_ID }],
      ['the kind', { kind: 'TEACHING_GROUP' }],
    ])('writes %s when that is what the PATCH names', async (_field, patch) => {
      // The kind decides whether the group is its members' home class; a PATCH
      // that drops it leaves a språkval eating lunch as a class.
      tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID });

      await service.update(GROUP_ID, patch, testUser());

      expect(tx.studentGroup.update).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
        data: patch,
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.studentGroup.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(GROUP_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });

    describe('a class with pupils’ class history keeps its läsår (timplan P4)', () => {
      const OTHER_YEAR = '88888888-8888-4888-8888-888888888888';
      beforeEach(() => {
        tx.studentGroup.findUnique.mockResolvedValue({ academicYearId: YEAR_ID, academicYear: { name: '2026/27' } });
      });

      it('refuses another year with 409 STUDENT_GROUP_HAS_ENROLMENT_HISTORY naming the year, writing nothing', async () => {
        tx.studentEnrollment.count.mockResolvedValue(3);

        const error = await service.update(GROUP_ID, { academicYearId: OTHER_YEAR }, testUser()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual(
          expect.objectContaining({ code: 'STUDENT_GROUP_HAS_ENROLMENT_HISTORY', params: { year: '2026/27' } }),
        );
        expect(tx.studentEnrollment.count).toHaveBeenCalledWith({ where: { studentGroupId: GROUP_ID } });
        expect(tx.studentGroup.update).not.toHaveBeenCalled();
      });

      it('moves a class without history, and asks nothing when the year is unchanged', async () => {
        tx.studentEnrollment.count.mockResolvedValue(0);
        tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID });

        await service.update(GROUP_ID, { academicYearId: OTHER_YEAR }, testUser());
        expect(tx.studentGroup.update).toHaveBeenCalledWith({ where: { id: GROUP_ID }, data: { academicYearId: OTHER_YEAR } });

        tx.studentEnrollment.count.mockClear();
        await service.update(GROUP_ID, { academicYearId: YEAR_ID, name: '7B' }, testUser());
        expect(tx.studentEnrollment.count).not.toHaveBeenCalled();
      });

      it('answers the history key’s own refusal of a race with the same 409', async () => {
        tx.studentEnrollment.count.mockResolvedValue(0);
        tx.studentGroup.update.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
            code: 'P2003',
            clientVersion: Prisma.prismaVersion.client,
            meta: {
              modelName: 'StudentGroup',
              driverAdapterError: {
                cause: {
                  originalCode: '23503',
                  originalMessage:
                    'update or delete on table "StudentGroups" violates foreign key constraint "StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey" on table "StudentEnrollments"',
                  constraint: { index: 'StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey' },
                },
              },
            },
          }),
        );

        const error = await service.update(GROUP_ID, { academicYearId: OTHER_YEAR }, testUser()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual(
          expect.objectContaining({ code: 'STUDENT_GROUP_HAS_ENROLMENT_HISTORY' }),
        );
      });
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.studentGroup.delete.mockResolvedValue({ id: GROUP_ID });
      const user = testUser();

      await expect(service.remove(GROUP_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.studentGroup.delete).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.studentGroup.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(GROUP_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

describe('StudentGroupsService — teaching-group members', () => {
  let service: StudentGroupsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  const STUDENT_A = 'aaaaaaa1-0000-4000-8000-000000000001';
  const STUDENT_B = 'aaaaaaa2-0000-4000-8000-000000000002';

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StudentGroupsService(prisma as unknown as PrismaService);
  });

  describe('setMembers', () => {
    const FORMER_STUDENT = 'aaaaaaa3-0000-4000-8000-000000000003';
    const TEACHER = 'bbbbbbb1-0000-4000-8000-000000000001';

    /*
     * The school's people as a table the membership check reads through its
     * own query: filtered by the ids, role and activity it names, cut to the
     * fields it selects. A stub that hands back "the valid ones" whatever was
     * asked proves only that the service trusts its stub — drop `role` from the
     * filter and a teacher joins the group while every test stays green.
     */
    const PEOPLE = [
      { id: STUDENT_A, role: 'STUDENT', isActive: true, firstName: 'Alva' },
      { id: STUDENT_B, role: 'STUDENT', isActive: true, firstName: 'Bo' },
      { id: FORMER_STUDENT, role: 'STUDENT', isActive: false, firstName: 'Cleo' },
      { id: TEACHER, role: 'TEACHER', isActive: true, firstName: 'Dan' },
    ];

    const arrange = () => {
      tx.studentGroup.findUnique.mockImplementation(
        ({ where, select }: { where?: { id?: string }; select?: Selection }) => {
          if (where?.id === undefined) {
            throw new Error('Prisma: findUnique needs a unique field in `where`.');
          }
          return Promise.resolve(
            where.id === GROUP_ID
              ? selected({ id: GROUP_ID, name: 'Spanska 7' }, select)
              : null,
          );
        },
      );
      tx.user.findMany.mockImplementation(
        ({
          where = {},
          select,
        }: { where?: Record<string, unknown>; select?: Selection } = {}) =>
          Promise.resolve(
            PEOPLE.filter((person) => personMatches(where, person)).map((person) =>
              selected(person, select),
            ),
          ),
      );
      tx.studentGroupMember.deleteMany.mockResolvedValue({ count: 0 });
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 2 });
    };

    it('replaces the whole membership under the caller RLS session', async () => {
      arrange();

      const result = await service.setMembers(
        GROUP_ID,
        { studentIds: [STUDENT_A, STUDENT_B] },
        testUser(),
      );

      expect(result).toEqual({ count: 2 });
      expect(prisma.withRls).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser().userId }),
        expect.any(Function),
      );
      // Replace semantics: wipe first, then insert exactly the new list with
      // the tenant taken from the principal — never from the payload.
      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { studentGroupId: GROUP_ID },
      });
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_A },
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_B },
        ],
      });
    });

    it('deduplicates repeated ids before writing', async () => {
      arrange();

      const result = await service.setMembers(
        GROUP_ID,
        { studentIds: [STUDENT_A, STUDENT_A] },
        testUser(),
      );

      expect(result).toEqual({ count: 1 });
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: testUser().schoolId, studentGroupId: GROUP_ID, studentId: STUDENT_A },
        ],
      });
    });

    it('clears the membership when given an empty list, inserting nothing', async () => {
      arrange();

      const result = await service.setMembers(GROUP_ID, { studentIds: [] }, testUser());

      expect(result).toEqual({ count: 0 });
      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });

    it('404s on an unknown group before touching memberships', async () => {
      arrange();
      tx.studentGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.setMembers(GROUP_ID, { studentIds: [STUDENT_A] }, testUser()),
      ).rejects.toThrow(new NotFoundException('Student group not found.'));
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects ids that are not active students, naming the offenders, and writes nothing', async () => {
      arrange();

      // A pupil who has left and a teacher: both real people in this school,
      // and neither can be taught in a teaching group.
      await expect(
        service.setMembers(
          GROUP_ID,
          { studentIds: [STUDENT_A, TEACHER, FORMER_STUDENT] },
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException(
          `Not active students in this school: ${TEACHER}, ${FORMER_STUDENT}`,
        ),
      );
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });
  });

  describe('listMembers', () => {
    it('returns members by last name, each with their home group, via the caller RLS session', async () => {
      const HOME_7A = '77777777-7777-4777-8777-777777777777';
      const HOME_7B = '78787878-7878-4878-8878-787878787878';
      // Membership rows as the table holds them, each student a whole user row,
      // read through the service's own filter, nested select and sort. They
      // arrive out of order, so the order that comes back is the query's.
      const rows = [
        {
          studentGroupId: GROUP_ID,
          student: { id: STUDENT_B, firstName: 'Bo', lastName: 'Lind', studentGroupId: HOME_7B, isActive: true },
        },
        {
          studentGroupId: '79797979-7979-4979-8979-797979797979',
          student: { id: 'not-a-member', firstName: 'Ej', lastName: 'Medlem', studentGroupId: HOME_7A, isActive: true },
        },
        {
          studentGroupId: GROUP_ID,
          student: { id: STUDENT_A, firstName: 'Alva', lastName: 'Berg', studentGroupId: HOME_7A, isActive: true },
        },
      ];
      tx.studentGroupMember.findMany.mockImplementation(
        ({
          where,
          select,
          orderBy,
        }: { where: { studentGroupId: string }; select?: Selection; orderBy?: unknown }) =>
          Promise.resolve(
            sortedBy(
              rows.filter((row) => row.studentGroupId === where.studentGroupId),
              orderBy,
            ).map((row) => selected(row, select)),
          ),
      );

      const members = await service.listMembers(GROUP_ID, testUser());

      expect(members).toEqual([
        { id: STUDENT_A, firstName: 'Alva', lastName: 'Berg', homeGroupId: HOME_7A },
        { id: STUDENT_B, firstName: 'Bo', lastName: 'Lind', homeGroupId: HOME_7B },
      ]);
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { studentGroupId: GROUP_ID } }),
      );
      expect(prisma.withRls).toHaveBeenCalled();
    });
  });

  // A lov spanning årskurser closes a pupil's day by the årskurs of their
  // class (app.leave_school_days).
  describe('the leave requests an årskurs gives a mentor (Mentorns ledighetsbeslut)', () => {
    const TELL = 'app.leave_requests_tell_new_mentors()';
    const MENTOR = '77777777-7777-4777-8777-777777777777';
    const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const NOTICE_ROW = { notificationId: NOTICE, userId: MENTOR, email: null, meta: { leaveRequestId: 'r1', schoolDays: 2 } };
    let deliver: jest.Mock;
    let queryRaw: jest.Mock;

    beforeEach(() => {
      deliver = jest.fn();
      service = new StudentGroupsService(prisma as unknown as PrismaService, { deliver } as unknown as NotificationsService);
      queryRaw = jest.fn(() => Promise.resolve([NOTICE_ROW]));
      Object.assign(tx, { $queryRaw: queryRaw });
      tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID, schoolId: SCHOOL_ID });
    });

    const told = () => queryRaw.mock.calls.filter((call) => String((call[0] as string[]).join('?')).includes(TELL));

    it('tells the mentors after a new årskurs, in its transaction', async () => {
      await service.update(GROUP_ID, { gradeLevel: 8 }, testUser());
      expect(told()).toHaveLength(1);
      expect(queryRaw.mock.invocationCallOrder[0]!).toBeGreaterThan(tx.studentGroup.update.mock.invocationCallOrder[0]!);
      expect(deliver).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ schoolId: SCHOOL_ID, type: 'LEAVE_REQUESTED', recipients: [{ userId: MENTOR, notificationId: NOTICE }] }),
      );
    });

    it('asks nothing of a rename', async () => {
      await service.update(GROUP_ID, { name: '7B' }, testUser());
      expect(told()).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});

describe('StudentGroupsService — Halvklasser', () => {
  let service: StudentGroupsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  const H1 = '7a000001-0000-4000-8000-000000000001';
  const H2 = '7a000002-0000-4000-8000-000000000002';
  const PREDECESSOR = '6a000000-0000-4000-8000-000000000000';
  const pupil = (n: number) => `aaaaaaa${n}-0000-4000-8000-00000000000${n}`;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StudentGroupsService(prisma as unknown as PrismaService);
    Object.assign(tx, { $queryRaw: jest.fn(() => Promise.resolve([])) });
  });

  describe('split ("Dela klassen")', () => {
    const theClass = (overrides: Record<string, unknown> = {}) => ({
      name: '7A',
      kind: 'CLASS',
      academicYearId: YEAR_ID,
      gradeLevel: 7,
      _count: { halves: 0 },
      ...overrides,
    });

    it('holds the class, then makes two halves named after it, in its year and årskurs', async () => {
      tx.studentGroup.findUnique.mockResolvedValue(theClass());
      tx.studentGroup.createManyAndReturn.mockResolvedValue([{ id: H1 }, { id: H2 }]);

      await expect(service.split(GROUP_ID, {}, testUser())).resolves.toEqual([{ id: H1 }, { id: H2 }]);

      const [held] = (tx.$queryRaw as jest.Mock).mock.calls[0] as [string[]];
      expect(held.join('?')).toContain('FOR NO KEY UPDATE');
      expect((tx.$queryRaw as jest.Mock).mock.invocationCallOrder[0]!).toBeLessThan(
        tx.studentGroup.findUnique.mock.invocationCallOrder[0]!,
      );
      expect(tx.studentGroup.createManyAndReturn).toHaveBeenCalledWith({
        data: ['7A:1', '7A:2'].map((name) => ({
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          name,
          kind: 'TEACHING_GROUP',
          gradeLevel: 7,
          halfOfId: GROUP_ID,
        })),
      });
    });

    it('takes the school’s names, trimmed', async () => {
      tx.studentGroup.findUnique.mockResolvedValue(theClass());

      await service.split(GROUP_ID, { names: [' Grupp A ', 'Grupp B'] }, testUser());

      expect(tx.studentGroup.createManyAndReturn).toHaveBeenCalledWith({
        data: [expect.objectContaining({ name: 'Grupp A' }), expect.objectContaining({ name: 'Grupp B' })],
      });
    });

    it.each([
      ['a teaching group', { kind: 'TEACHING_GROUP' }, BadRequestException, 'NOT_A_CLASS'],
      ['a class already split', { _count: { halves: 2 } }, ConflictException, 'CLASS_ALREADY_SPLIT'],
    ])('refuses %s and writes nothing', async (_what, overrides, kind, code) => {
      tx.studentGroup.findUnique.mockResolvedValue(theClass(overrides));

      const error = await service.split(GROUP_ID, {}, testUser()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(kind);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code });
      expect(tx.studentGroup.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('refuses two names alike, and a name the year has, naming it', async () => {
      tx.studentGroup.findUnique.mockResolvedValue(theClass());
      await expect(service.split(GROUP_ID, { names: ['A', 'a'] }, testUser())).rejects.toThrow(BadRequestException);

      tx.studentGroup.findMany.mockResolvedValue([{ name: '7a:1' }]);
      const error = await service.split(GROUP_ID, {}, testUser()).catch((thrown: unknown) => thrown);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'GROUP_NAME_TAKEN',
        message: expect.stringContaining('7a:1'),
      });
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            academicYearId: YEAR_ID,
            OR: [
              { name: { equals: '7A:1', mode: 'insensitive' } },
              { name: { equals: '7A:2', mode: 'insensitive' } },
            ],
          },
        }),
      );
      expect(tx.studentGroup.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('answers 404 for a class it cannot see', async () => {
      tx.studentGroup.findUnique.mockResolvedValue(null);

      await expect(service.split(GROUP_ID, {}, testUser())).rejects.toThrow(NotFoundException);
    });
  });

  describe('placeHalves', () => {
    const arrange = (pupils: string[], predecessorId: string | null = null) => {
      tx.studentGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: '7A',
        predecessorId,
        halves: [{ id: H1 }, { id: H2 }],
      });
      tx.user.findMany.mockResolvedValue(pupils.map((id) => ({ id })));
    };

    it('replaces the class’s placement in both halves in one transaction, and counts who is left', async () => {
      arrange([pupil(1), pupil(2), pupil(3)]);

      const result = await service.placeHalves(
        GROUP_ID,
        { halves: [{ groupId: H1, studentIds: [pupil(1)] }, { groupId: H2, studentIds: [pupil(2)] }] },
        testUser(),
      );

      expect(result).toEqual({ placed: 2, unplaced: 1 });
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { role: 'STUDENT', isActive: true, studentGroupId: { in: [GROUP_ID] } },
        select: { id: true },
      });
      // Only the pupils it judges: a past year's placement, or an inactive pupil's, stays.
      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: [H1, H2] }, studentId: { in: [pupil(1), pupil(2), pupil(3)] } },
      });
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          { schoolId: SCHOOL_ID, studentGroupId: H1, studentId: pupil(1) },
          { schoolId: SCHOOL_ID, studentGroupId: H2, studentId: pupil(2) },
        ],
      });
      expect(tx.studentGroupMember.deleteMany.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.studentGroupMember.createMany.mock.invocationCallOrder[0]!,
      );
      // The class's row first, as split takes it: a second placement waits.
      const [lock] = tx.$queryRaw.mock.calls[0]! as [readonly string[]];
      expect(lock.join('?')).toMatch(/FROM "StudentGroups" WHERE "id" = \?::uuid FOR NO KEY UPDATE/);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.studentGroup.findUnique.mock.invocationCallOrder[0]!);
      // Then the class's pupils, in id order, before any membership row: the
      // order a class change takes them in, so the two cannot deadlock.
      const [held, ids] = tx.$queryRaw.mock.calls[1]! as [readonly string[], string[]];
      expect(held.join('?')).toMatch(/FROM "Users" WHERE "id" = ANY\(\?::uuid\[\]\) ORDER BY "id" FOR SHARE/);
      expect(ids).toEqual([pupil(1), pupil(2), pupil(3)].sort());
      expect(tx.$queryRaw.mock.invocationCallOrder[1]!).toBeLessThan(
        tx.studentGroupMember.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('reads the predecessor’s pupils too, for a rolled läsår not yet activated', async () => {
      arrange([pupil(1)], PREDECESSOR);

      await service.placeHalves(GROUP_ID, { halves: [{ groupId: H1, studentIds: [pupil(1)] }, { groupId: H2, studentIds: [] }] }, testUser());

      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ studentGroupId: { in: [GROUP_ID, PREDECESSOR] } }) }),
      );
    });

    it.each([
      ['a half left out', [{ groupId: H1, studentIds: [] }], 'NOT_THE_CLASS_HALVES'],
      ['a group that is not the class’s half', [{ groupId: H1, studentIds: [] }, { groupId: GROUP_ID, studentIds: [] }], 'NOT_THE_CLASS_HALVES'],
      ['one half twice', [{ groupId: H1, studentIds: [] }, { groupId: H1, studentIds: [] }], 'NOT_THE_CLASS_HALVES'],
      ['a pupil in both lists', [{ groupId: H1, studentIds: ['P1'] }, { groupId: H2, studentIds: ['P1'] }], 'PUPIL_IN_TWO_HALVES'],
      ['a pupil of another class', [{ groupId: H1, studentIds: ['STRANGER'] }, { groupId: H2, studentIds: [] }], 'PUPIL_NOT_IN_CLASS'],
    ])('refuses %s and writes nothing', async (_what, halves, code) => {
      arrange([pupil(1)]);
      const named = halves.map((half) => ({
        ...half,
        studentIds: half.studentIds.map((id) => (id === 'P1' ? pupil(1) : id === 'STRANGER' ? pupil(9) : id)),
      }));

      const error = await service.placeHalves(GROUP_ID, { halves: named }, testUser()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code });
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });

    it('refuses a class with no halves', async () => {
      tx.studentGroup.findUnique.mockResolvedValue({ id: GROUP_ID, name: '7A', predecessorId: null, halves: [] });

      await expect(service.placeHalves(GROUP_ID, { halves: [{ groupId: H1, studentIds: [] }] }, testUser())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('turns the one-half index met by a concurrent placement into a 409', async () => {
      arrange([pupil(1)]);
      tx.studentGroupMember.createMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: 'StudentGroupMembers_one_half_per_class' },
        }),
      );

      const error = await service
        .placeHalves(GROUP_ID, { halves: [{ groupId: H1, studentIds: [pupil(1)] }, { groupId: H2, studentIds: [] }] }, testUser())
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'HALF_MEMBER_IN_OTHER_HALF' });
    });
  });

  describe('setMembers on a half', () => {
    it('takes the class’s pupils only, saying how many are not', async () => {
      tx.studentGroup.findUnique.mockResolvedValue({ id: H1, halfOf: { id: GROUP_ID, name: '7A', predecessorId: null } });
      tx.user.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'studentGroupId' in where ? [{ id: pupil(1) }] : [{ id: pupil(1) }, { id: pupil(2) }],
      );

      const error = await service.setMembers(H1, { studentIds: [pupil(1), pupil(2)] }, testUser()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PUPIL_NOT_IN_CLASS',
        message: expect.stringContaining('går inte i 7A'),
      });
      expect(tx.studentGroupMember.deleteMany).not.toHaveBeenCalled();
    });

    it('replaces the class’s pupils’ rows only, so a past year’s placement or an inactive pupil’s stays', async () => {
      tx.studentGroup.findUnique.mockResolvedValue({ id: H1, halfOf: { id: GROUP_ID, name: '7A', predecessorId: null } });
      tx.user.findMany.mockResolvedValue([{ id: pupil(1) }, { id: pupil(2) }]);
      tx.studentGroupMember.deleteMany.mockResolvedValue({ count: 0 });

      await service.setMembers(H1, { studentIds: [] }, testUser());

      expect(tx.studentGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { studentGroupId: H1, studentId: { in: [pupil(1), pupil(2)] } },
      });
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
      // The class's pupils held first, as placeHalves holds them.
      const [held] = tx.$queryRaw.mock.calls[0]! as [readonly string[]];
      expect(held.join('?')).toMatch(/FROM "Users" .* FOR SHARE/);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.studentGroupMember.deleteMany.mock.invocationCallOrder[0]!,
      );
    });
  });
});
