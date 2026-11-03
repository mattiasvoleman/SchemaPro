import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { BULK_TIMEOUT_MS } from '../common/bulk';
import { WRITE_CONFLICT } from '../common/utils/prisma-errors';
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

  describe('Ersättande grupper: a teaching group replaces a subject', () => {
    const SUBJECT_ID = '77777777-7777-4777-8777-777777777777';

    it('creates a teaching group replacing a subject of the school', async () => {
      tx.subject.findUnique.mockResolvedValue({ id: SUBJECT_ID });
      tx.studentGroup.create.mockResolvedValue({ id: GROUP_ID });
      await service.create(dto({ name: 'SvA7', kind: 'TEACHING_GROUP', replacesSubjectId: SUBJECT_ID }), testUser());
      expect(tx.subject.findUnique).toHaveBeenCalledWith({ where: { id: SUBJECT_ID }, select: { id: true } });
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'TEACHING_GROUP', replacesSubjectId: SUBJECT_ID }),
      });
    });

    it('refuses a class, writing nothing', async () => {
      await expect(service.create(dto({ replacesSubjectId: SUBJECT_ID }), testUser())).rejects.toMatchObject({
        response: { code: 'REPLACING_GROUP_NOT_A_TEACHING_GROUP' },
      });
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
    });

    it('refuses a subject the school does not have (another school’s is invisible under RLS)', async () => {
      tx.subject.findUnique.mockResolvedValue(null);
      await expect(
        service.create(dto({ kind: 'TEACHING_GROUP', replacesSubjectId: SUBJECT_ID }), testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
    });

    it('writes nothing about it for a group that replaces nothing', async () => {
      tx.studentGroup.create.mockResolvedValue({ id: GROUP_ID });
      await service.create(dto({ kind: 'TEACHING_GROUP' }), testUser());
      expect(tx.studentGroup.create.mock.calls[0][0].data).not.toHaveProperty('replacesSubjectId');
      expect(tx.subject.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a half on update, and lets a teaching group start or stop replacing', async () => {
      tx.subject.findUnique.mockResolvedValue({ id: SUBJECT_ID });
      tx.studentGroup.findUnique.mockResolvedValueOnce({ kind: 'TEACHING_GROUP', halfOfId: 'class-7a' });
      await expect(service.update(GROUP_ID, { replacesSubjectId: SUBJECT_ID }, testUser())).rejects.toMatchObject({
        response: { code: 'REPLACING_GROUP_NOT_A_TEACHING_GROUP' },
      });
      expect(tx.studentGroup.update).not.toHaveBeenCalled();

      tx.studentGroup.findUnique.mockResolvedValueOnce({ kind: 'TEACHING_GROUP', halfOfId: null });
      tx.studentGroup.update.mockResolvedValue({ id: GROUP_ID, kind: 'TEACHING_GROUP' });
      await service.update(GROUP_ID, { replacesSubjectId: SUBJECT_ID }, testUser());
      expect(tx.studentGroup.update).toHaveBeenLastCalledWith({ where: { id: GROUP_ID }, data: { replacesSubjectId: SUBJECT_ID } });

      await service.update(GROUP_ID, { replacesSubjectId: null }, testUser());
      expect(tx.studentGroup.update).toHaveBeenLastCalledWith({ where: { id: GROUP_ID }, data: { replacesSubjectId: null } });
    });

    it('refuses turning a teaching group into a class in the same PATCH that makes it replace, by the new kind', async () => {
      // The group is a teaching group now; the PATCH makes it a class AND a
      // replacing group. The kind it is judged by is the one it will have.
      tx.subject.findUnique.mockResolvedValue({ id: SUBJECT_ID });
      tx.studentGroup.findUnique.mockResolvedValueOnce({ kind: 'TEACHING_GROUP', halfOfId: null });
      await expect(service.update(GROUP_ID, { kind: 'CLASS', replacesSubjectId: SUBJECT_ID }, testUser())).rejects.toMatchObject({
        response: { code: 'REPLACING_GROUP_NOT_A_TEACHING_GROUP' },
      });
      expect(tx.studentGroup.update).not.toHaveBeenCalled();
    });

    it('answers the CHECK’s refusal of a class that keeps replacing with a 400 naming the field', async () => {
      tx.studentGroup.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('check', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: {
              cause: {
                originalCode: '23514',
                originalMessage:
                  'new row for relation "StudentGroups" violates check constraint "StudentGroups_only_a_teaching_group_replaces"',
              },
            },
          },
        }),
      );
      await expect(service.update(GROUP_ID, { kind: 'CLASS' }, testUser())).rejects.toThrow(/replacesSubjectId/);
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

  describe('Massåtgärder (bulk)', () => {
    const G1 = 'aaaaaaaa-0000-4000-8000-000000000001';
    const G2 = 'bbbbbbbb-0000-4000-8000-000000000002';
    const G3 = 'cccccccc-0000-4000-8000-000000000003';
    const MISSING = 'dddddddd-0000-4000-8000-000000000004';
    const HALF = 'eeeeeeee-0000-4000-8000-000000000005';
    const SUBJECT = '77777777-7777-4777-8777-777777777777';
    const MENTOR = '78787878-7878-4878-8878-787878787878';
    const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const TELL = 'app.leave_requests_tell_new_mentors()';
    const user = testUser();

    interface GroupRow {
      id: string;
      kind: 'CLASS' | 'TEACHING_GROUP';
      halfOfId: string | null;
      gradeLevel: number | null;
      replacesSubjectId: string | null;
      ss12000Id: string | null;
    }
    const group = (id: string, overrides: Partial<GroupRow> = {}): GroupRow => ({
      id,
      kind: 'CLASS',
      halfOfId: null,
      gradeLevel: 6,
      replacesSubjectId: null,
      ss12000Id: null,
      ...overrides,
    });
    const teachingGroup = (id: string, overrides: Partial<GroupRow> = {}): GroupRow =>
      group(id, { kind: 'TEACHING_GROUP', ...overrides });

    type GroupsWhere = { id?: { in?: string[]; notIn?: string[] }; halfOfId?: { in: string[] } };

    /**
     * The groups table as the bulk calls' reads see it: the rows an `id in`
     * names (minus any `id notIn`) and the rows that are a half of an
     * `halfOfId in`, each with the fields the query selected. A condition the
     * service starts to send that this does not know throws, rather than being
     * ignored.
     */
    const givenGroups = (...rows: GroupRow[]) =>
      tx.studentGroup.findMany.mockImplementation(({ where, select }: { where: GroupsWhere; select: Selection }) => {
        const unknown = Object.keys(where).filter((key) => key !== 'id' && key !== 'halfOfId');
        if (unknown.length > 0) throw new Error(`The groups read grew a condition tests do not know: ${unknown.join(', ')}`);
        return Promise.resolve(
          rows
            .filter(
              (row) =>
                (where.id?.in === undefined || where.id.in.includes(row.id)) &&
                (where.id?.notIn === undefined || !where.id.notIn.includes(row.id)) &&
                (where.halfOfId === undefined || (row.halfOfId !== null && where.halfOfId.in.includes(row.halfOfId))),
            )
            .map((row) => selected(row as unknown as Record<string, unknown>, select)),
        );
      });

    /** The transaction of the last withRls call: it rejects when its body threw, which rolls it back. */
    const lastTransaction = (): Promise<unknown> =>
      prisma.withRls.mock.results[prisma.withRls.mock.results.length - 1]!.value as Promise<unknown>;
    const expectCommitted = () => expect(lastTransaction()).resolves.toMatchObject({ applied: true });
    const expectRolledBack = () => expect(lastTransaction()).rejects.toThrow();

    /** The SQL of every statement sent with $executeRaw: the savepoints a bulk write takes. */
    const savepoints = () =>
      tx.$executeRaw.mock.calls.map(([strings]) => (strings as readonly string[]).join('?'));

    /**
     * A bulk statement's answer as Prisma gives it: the rows it wrote, here
     * every row its `id in` names. writeAll tries the rows one by one when
     * the count falls short, so an unstubbed statement would not pass as one.
     */
    const writesEveryRowNamed = ({ where }: { where?: { id?: { in?: string[] } } }) =>
      Promise.resolve({ count: where?.id?.in?.length ?? 0 });

    beforeEach(() => {
      tx.studentGroup.updateMany.mockImplementation(writesEveryRowNamed);
      tx.studentGroup.deleteMany.mockImplementation(writesEveryRowNamed);
    });

    describe('bulkUpdate', () => {
      it('refuses a body whose changes name nothing before it opens a transaction', async () => {
        await expect(service.bulkUpdate({ ids: [G1], changes: {}, dryRun: false }, user)).rejects.toThrow(BadRequestException);
        await expect(
          service.bulkUpdate({ ids: [G1], changes: { gradeLevel: undefined }, dryRun: false }, user),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('locks the groups FOR NO KEY UPDATE in id order before it judges them', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G3));

        await service.bulkUpdate({ ids: [G3, G1], changes: { gradeLevel: 7 }, dryRun: false }, user);

        const [first] = tx.$queryRaw.mock.calls;
        expect((first![0] as string[]).join('?').replace(/\s+/g, ' ').trim()).toBe(
          'SELECT 1 FROM "StudentGroups" WHERE "id" = ANY(?::uuid[]) ORDER BY "id" FOR NO KEY UPDATE',
        );
        expect(first![1]).toEqual([G1, G3]);
      });

      it('reads each id once, in id order, in one transaction with the bulk timeout', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G3));

        await service.bulkUpdate({ ids: [G3, G1, G3], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(prisma.withRls).toHaveBeenCalledTimes(1);
        expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: BULK_TIMEOUT_MS });
        expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
          where: { id: { in: [G1, G3] } },
          select: { id: true, kind: true, halfOfId: true, gradeLevel: true, replacesSubjectId: true },
        });
      });

      it('writes the groups that move in one statement, sending only the fields asked, and commits', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2, { gradeLevel: null }));

        const result = await service.bulkUpdate({ ids: [G2, G1], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [G1, G2], refused: [] });
        expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [G1, G2] } },
          data: { gradeLevel: 7 },
        });
        expect(tx.studentGroup.update).not.toHaveBeenCalled();
        expect(savepoints()).toEqual(['SAVEPOINT bulk_whole', 'RELEASE SAVEPOINT bulk_whole']);
        await expectCommitted();
      });

      it('does not write a group that already holds the values: an UPDATE would move updatedAt, which the sync reads as a local edit', async () => {
        givenGroups(teachingGroup(G1, { gradeLevel: 7 }), teachingGroup(G2, { gradeLevel: 6 }));
        await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7 }, dryRun: false }, user);
        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({ where: { id: { in: [G2] } }, data: { gradeLevel: 7 } });

        tx.studentGroup.updateMany.mockClear();
        tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
        givenGroups(teachingGroup(G1, { replacesSubjectId: SUBJECT }), teachingGroup(G2));
        const result = await service.bulkUpdate({ ids: [G1, G2], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);
        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [G2] } },
          data: { replacesSubjectId: SUBJECT },
        });
        // Judged all the same: the group that holds it is done, not skipped.
        expect(result.done).toEqual([G1, G2]);
      });

      it('writes nothing, and says applied, when every group holds the values already', async () => {
        givenGroups(teachingGroup(G1, { gradeLevel: 7 }), teachingGroup(G2, { gradeLevel: 7 }));

        const result = await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [G1, G2], refused: [] });
        expect(tx.studentGroup.updateMany).not.toHaveBeenCalled();
        expect(savepoints()).toEqual([]);
      });

      it('moves a group when either field differs, and sends both fields then', async () => {
        tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
        givenGroups(teachingGroup(G1, { gradeLevel: 7 }), teachingGroup(G2, { gradeLevel: 7, replacesSubjectId: SUBJECT }));

        await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7, replacesSubjectId: SUBJECT }, dryRun: false }, user);

        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [G1] } },
          data: { gradeLevel: 7, replacesSubjectId: SUBJECT },
        });
      });

      it('takes null as a change: no årskurs, replaces nothing, and asks the school for no subject', async () => {
        givenGroups(teachingGroup(G1, { gradeLevel: 7, replacesSubjectId: SUBJECT }), group(G2, { gradeLevel: 7 }));

        const result = await service.bulkUpdate(
          { ids: [G1, G2], changes: { gradeLevel: null, replacesSubjectId: null }, dryRun: false },
          user,
        );

        // A class is no refusal for "replaces nothing": only the subject it would replace is.
        expect(result).toMatchObject({ applied: true, done: [G1, G2], refused: [] });
        expect(tx.studentGroup.updateMany).toHaveBeenNthCalledWith(1, {
          where: { id: { in: [G1, G2] } },
          data: { gradeLevel: null, replacesSubjectId: null },
        });
        expect(tx.subject.findUnique).not.toHaveBeenCalled();
      });

      it('refuses a group another request deleted after the read, by name, rather than counting it done unwritten', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2));
        // The groups are read without a lock: G2 goes before the UPDATE, which passes over it.
        tx.studentGroup.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.studentGroup.update.mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === G2 ? Promise.reject(prismaError('P2025')) : Promise.resolve({ id: where.id }),
        );

        const result = await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G1],
          refused: [{ id: G2, code: 'BULK_ROW_NOT_FOUND', message: 'Raden finns inte längre, eller får inte ändras härifrån.' }],
        });
        await expectRolledBack();
      });

      it('names an id that is not there and writes nothing: the report, applied false, the rest in done', async () => {
        givenGroups(teachingGroup(G1));

        const result = await service.bulkUpdate({ ids: [G1, MISSING], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G1],
          refused: [{ id: MISSING, code: 'BULK_ROW_NOT_FOUND', message: expect.stringContaining('finns inte längre') }],
        });
        // The group that passed was written in the transaction, which the body's throw rolls back.
        await expectRolledBack();
      });

      it('refuses a class and a half as a replacing group, in the single route’s sentences, while a teaching group passes', async () => {
        tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
        givenGroups(group(G1), teachingGroup(G2), teachingGroup(G3, { halfOfId: G1 }));

        const result = await service.bulkUpdate({ ids: [G3, G2, G1], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G2],
          refused: [
            {
              id: G1,
              code: 'REPLACING_GROUP_NOT_A_TEACHING_GROUP',
              message:
                'En klass är elevernas hemklass och kan inte ersätta sina egna lektioner i ett ämne. Gör en undervisningsgrupp för SvA.',
            },
            {
              id: G3,
              code: 'REPLACING_GROUP_NOT_A_TEACHING_GROUP',
              message: 'En halvklass är en del av klassen och kan inte ersätta klassens lektioner i ett ämne.',
            },
          ],
        });
        // Only the teaching group was offered to the database, and the transaction is rolled back with it.
        expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [G2] } },
          data: { replacesSubjectId: SUBJECT },
        });
        await expectRolledBack();
      });

      it('asks once whether the subject is the school’s, and answers 400 for the whole call when it is not', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2));
        tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
        await service.bulkUpdate({ ids: [G1, G2], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);
        expect(tx.subject.findUnique).toHaveBeenCalledTimes(1);
        expect(tx.subject.findUnique).toHaveBeenCalledWith({ where: { id: SUBJECT }, select: { id: true } });

        tx.studentGroup.updateMany.mockClear();
        tx.subject.findUnique.mockResolvedValue(null);
        const error = await service
          .bulkUpdate({ ids: [G1, G2], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toBe('replacesSubjectId: ämnet finns inte i skolan.');
        expect(tx.studentGroup.updateMany).not.toHaveBeenCalled();
      });

      it('asks about the subject only for the groups that may replace one', async () => {
        // Every group refused: nothing to ask the subject for.
        givenGroups(group(G1));
        tx.subject.findUnique.mockResolvedValue(null);

        const result = await service.bulkUpdate({ ids: [G1], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);

        expect(result.refused).toHaveLength(1);
        expect(tx.subject.findUnique).not.toHaveBeenCalled();
      });

      it('names the group the database refused when it refuses the statement, trying the groups one by one', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2), teachingGroup(G3));
        tx.studentGroup.updateMany.mockRejectedValue(prismaError('P2003'));
        tx.studentGroup.update.mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === G2 ? Promise.reject(prismaError('P2003')) : Promise.resolve({ id: where.id }),
        );

        const result = await service.bulkUpdate({ ids: [G1, G2, G3], changes: { gradeLevel: 7 }, dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G1, G3],
          refused: [{ id: G2, code: 'BULK_ROW_REFERENCE_GONE', message: 'Raden skulle peka på något som inte längre finns.' }],
        });
        expect(tx.studentGroup.update.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual([
          G1,
          G2,
          G3,
        ]);
        await expectRolledBack();
      });

      it('on a dry run does the work and rolls it back, saying what would be done', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2, { gradeLevel: 7 }));

        const result = await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7 }, dryRun: true }, user);

        expect(result).toEqual({ applied: false, dryRun: true, done: [G1, G2], refused: [] });
        expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({ where: { id: { in: [G1] } }, data: { gradeLevel: 7 } });
        await expectRolledBack();
      });

      it('rethrows a failure that is no group’s refusal: the call fails, it is not a report', async () => {
        givenGroups(teachingGroup(G1));
        tx.studentGroup.updateMany.mockRejectedValue(new Error('connection reset'));

        await expect(service.bulkUpdate({ ids: [G1], changes: { gradeLevel: 7 }, dryRun: false }, user)).rejects.toThrow(
          'connection reset',
        );
        expect(tx.studentGroup.update).not.toHaveBeenCalled();
      });

      describe('a class’s årskurs is its halves’', () => {
        it('moves the halves that do not hold it, whether they hold nothing or another årskurs', async () => {
          givenGroups(group(G1, { gradeLevel: 6 }), teachingGroup(G2, { gradeLevel: 6 }));

          await service.bulkUpdate({ ids: [G1, G2], changes: { gradeLevel: 7 }, dryRun: false }, user);

          expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(2);
          expect(tx.studentGroup.updateMany).toHaveBeenNthCalledWith(2, {
            where: { halfOfId: { in: [G1] }, OR: [{ gradeLevel: null }, { gradeLevel: { not: 7 } }] },
            data: { gradeLevel: 7 },
          });
        });

        it('clears the halves’ årskurs with the class’s, touching only those that hold one', async () => {
          givenGroups(group(G1, { gradeLevel: 6 }));

          await service.bulkUpdate({ ids: [G1], changes: { gradeLevel: null }, dryRun: false }, user);

          expect(tx.studentGroup.updateMany).toHaveBeenNthCalledWith(2, {
            where: { halfOfId: { in: [G1] }, gradeLevel: { not: null } },
            data: { gradeLevel: null },
          });
        });

        it('brings the halves of a class along that already holds the årskurs, as update() does when it is sent', async () => {
          givenGroups(group(G1, { gradeLevel: 7 }));

          const result = await service.bulkUpdate({ ids: [G1], changes: { gradeLevel: 7 }, dryRun: false }, user);

          expect(result).toMatchObject({ applied: true, done: [G1] });
          // The class itself is not written; its halves, which may have been left behind, are.
          expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(1);
          expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({
            where: { halfOfId: { in: [G1] }, OR: [{ gradeLevel: null }, { gradeLevel: { not: 7 } }] },
            data: { gradeLevel: 7 },
          });
        });

        it('leaves halves alone for a teaching group, and for a change that is not an årskurs', async () => {
          tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
          givenGroups(teachingGroup(G1), teachingGroup(G2));
          await service.bulkUpdate({ ids: [G1], changes: { gradeLevel: 7 }, dryRun: false }, user);
          await service.bulkUpdate({ ids: [G2], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);

          expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(2);
          for (const [args] of tx.studentGroup.updateMany.mock.calls) {
            expect(args).not.toHaveProperty('where.halfOfId');
          }
        });

        it('does not reach the halves when a group is refused', async () => {
          givenGroups(group(G1));

          const result = await service.bulkUpdate({ ids: [G1, MISSING], changes: { gradeLevel: 7 }, dryRun: false }, user);

          expect(result.applied).toBe(false);
          // The statement for the class itself, and no second one for its halves.
          expect(tx.studentGroup.updateMany).toHaveBeenCalledTimes(1);
        });
      });

      // The new årskurs of a class can give a mentor a leave request
      // (app.leave_school_days), as update() tells them.
      describe('the mentors, told once after every group', () => {
        let deliver: jest.Mock;
        let queryRaw: jest.Mock;
        const told = () => queryRaw.mock.calls.filter((call) => String((call[0] as string[]).join('?')).includes(TELL));

        beforeEach(() => {
          deliver = jest.fn();
          service = new StudentGroupsService(prisma as unknown as PrismaService, { deliver } as unknown as NotificationsService);
          queryRaw = jest.fn(() =>
            Promise.resolve([
              { notificationId: NOTICE, userId: MENTOR, email: null, meta: { leaveRequestId: 'r1', schoolDays: 2 } },
            ]),
          );
          Object.assign(tx, { $queryRaw: queryRaw });
        });

        it('tells them once for the whole call, after the last statement, in its transaction', async () => {
          givenGroups(group(G1), group(G2), teachingGroup(G3));

          await service.bulkUpdate({ ids: [G1, G2, G3], changes: { gradeLevel: 7 }, dryRun: false }, user);

          expect(told()).toHaveLength(1);
          const updates = tx.studentGroup.updateMany.mock.invocationCallOrder;
          const tell = queryRaw.mock.calls.findIndex((call) => String((call[0] as string[]).join('?')).includes(TELL));
          expect(queryRaw.mock.invocationCallOrder[tell]!).toBeGreaterThan(updates[updates.length - 1]!);
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(deliver).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
              schoolId: SCHOOL_ID,
              type: 'LEAVE_REQUESTED',
              recipients: [{ userId: MENTOR, notificationId: NOTICE }],
            }),
          );
          await expectCommitted();
        });

        it('tells nobody on a dry run: the notices would be written in a transaction that is rolled back', async () => {
          givenGroups(group(G1));

          await service.bulkUpdate({ ids: [G1], changes: { gradeLevel: 7 }, dryRun: true }, user);

          expect(told()).toEqual([]);
          expect(deliver).not.toHaveBeenCalled();
        });

        it('tells nobody of a change that is not an årskurs, of groups that already hold it, or of a refusal', async () => {
          tx.subject.findUnique.mockResolvedValue({ id: SUBJECT });
          givenGroups(teachingGroup(G1), group(G2, { gradeLevel: 7 }));

          await service.bulkUpdate({ ids: [G1], changes: { replacesSubjectId: SUBJECT }, dryRun: false }, user);
          await service.bulkUpdate({ ids: [G2], changes: { gradeLevel: 7 }, dryRun: false }, user);
          await service.bulkUpdate({ ids: [G1, MISSING], changes: { gradeLevel: 7 }, dryRun: false }, user);

          expect(told()).toEqual([]);
          expect(deliver).not.toHaveBeenCalled();
        });
      });
    });

    describe('bulkRemove', () => {
      /** How many each count answers, per model; the keys are the tables the counts read. */
      /** What each table holds for the groups, as the inventory's SQL counts it (GROUP_KEYS). */
      const TABLE_COUNTS: Record<string, number> = {
        Users: 12,
        StudentGroupMembers: 30,
        TeachingRequirements: 4,
        MasterLessons: 7,
        MasterLessonGroups: 2,
        CalendarLessonGroups: 1,
        CalendarLessons: 200,
        AvailabilityConstraints: 3,
        LunchSittings: 5,
        CalendarLunches: 6,
        CalendarRasts: 4,
        TimplanCredits: 1,
        PublicTimetableLinks: 2,
        StudentEnrollments: 25,
        TeacherDuties: 1,
      };
      /** The SQL of a $queryRaw call: a tagged template's strings, or a Prisma.sql's text. */
      const textOf = (first: unknown): string =>
        typeof (first as { text?: unknown }).text === 'string'
          ? (first as { text: string }).text
          : (first as string[]).join('?');
      /** The count statements sent, with the ids each was sent. */
      const countStatements = () =>
        tx.$queryRaw.mock.calls
          .filter(([first]) => textOf(first).startsWith('SELECT count(*)'))
          .map(([first]) => ({ text: textOf(first), values: (first as { values: unknown[] }).values }));
      const givenCounts = () => {
        tx.$queryRaw.mockImplementation((first: unknown) => {
          const text = textOf(first);
          if (!text.startsWith('SELECT count(*)')) return Promise.resolve([]);
          return Promise.resolve([{ n: TABLE_COUNTS[/FROM "(\w+)"/.exec(text)![1]!] ?? 0 }]);
        });
        tx.attendanceRecord.count.mockResolvedValue(1000);
        tx.lessonLog.count.mockResolvedValue(9);
        tx.studentGroup.count.mockResolvedValue(1);
      };
      const counted = () => [
        ...countStatements(),
        ...tx.attendanceRecord.count.mock.calls,
        ...tx.lessonLog.count.mock.calls,
        ...tx.studentGroup.count.mock.calls,
      ];

      it('reads each id once, in id order, and names an id that is not there: the rest in done, nothing applied', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G3));

        const result = await service.bulkRemove({ ids: [G3, MISSING, G1, G3], dryRun: false }, user);

        expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
          where: { id: { in: [G1, G3, MISSING] } },
          select: { id: true, halfOfId: true, ss12000Id: true },
        });
        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G1, G3],
          refused: [{ id: MISSING, code: 'BULK_ROW_NOT_FOUND', message: expect.stringContaining('finns inte längre') }],
        });
        expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: BULK_TIMEOUT_MS });
        await expectRolledBack();
      });

      it('deletes the groups in one statement, halves first, and counts nothing on a real call', async () => {
        // The half's id sorts after its class's: id order is not the order it is written in.
        givenGroups(group(G1), teachingGroup(G2, { halfOfId: G1 }), teachingGroup(G3));

        const result = await service.bulkRemove({ ids: [G3, G2, G1], dryRun: false }, user);

        expect(result).toEqual({ applied: true, dryRun: false, done: [G1, G2, G3], refused: [] });
        expect(result).not.toHaveProperty('consequences');
        expect(tx.studentGroup.deleteMany).toHaveBeenCalledTimes(1);
        expect(tx.studentGroup.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [G2, G1, G3] } } });
        expect(savepoints()).toEqual(['SAVEPOINT bulk_whole', 'RELEASE SAVEPOINT bulk_whole']);
        // Only the one read of the rows themselves: no halves lookup, no counts.
        expect(tx.studentGroup.findMany).toHaveBeenCalledTimes(1);
        expect(counted()).toEqual([]);
        await expectCommitted();
      });

      it('on a dry run counts what goes with the groups, every kind, and rolls the delete back', async () => {
        // G1 is a class with a half the call does not name; G2 is linked to the school’s SS12000 source.
        givenGroups(
          group(G1),
          teachingGroup(G2, { ss12000Id: 'ss-group-2' }),
          teachingGroup(HALF, { halfOfId: G1 }),
        );
        givenCounts();

        const result = await service.bulkRemove({ ids: [G1, G2], dryRun: true }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: true,
          done: [G1, G2],
          refused: [],
          consequences: {
            halves: 1,
            homePupils: 12,
            memberships: 30,
            requirements: 4,
            masterLessons: 7,
            sharedLessons: 3,
            calendarLessons: 200,
            availabilityConstraints: 3,
            lunchSittings: 5,
            calendarBreaks: 10,
            timplanCredits: 1,
            publicLinks: 2,
            successors: 1,
            attendanceMarks: 1000,
            lessonLogs: 9,
            enrolments: 25,
            mentorDuties: 1,
            fromSource: 1,
          },
        });
        expect(tx.studentGroup.findMany).toHaveBeenNthCalledWith(2, {
          where: { halfOfId: { in: [G1, G2] }, id: { notIn: [G1, G2] } },
          select: { id: true },
        });
        // The groups, and the halves that go with them: every table counted by
        // the same ids, once, and the groups' own table only by its two
        // special counts (halves, successors).
        const statements = countStatements();
        expect(statements).toHaveLength(Object.keys(TABLE_COUNTS).length);
        for (const statement of statements) {
          expect(statement.values).toEqual([[G1, G2, HALF]]);
          expect(statement.text).not.toContain('"StudentGroups"');
        }
        const inGroups = { studentGroupId: { in: [G1, G2, HALF] } };
        // The attendance marks and lesson logs are on the groups’ calendar lessons.
        expect(tx.attendanceRecord.count).toHaveBeenCalledWith({ where: { calendarLesson: inGroups } });
        expect(tx.lessonLog.count).toHaveBeenCalledWith({ where: { calendarLesson: inGroups } });
        // A successor the call deletes as well loses nothing it keeps.
        expect(tx.studentGroup.count).toHaveBeenCalledWith({
          where: { predecessorId: { in: [G1, G2, HALF] }, id: { notIn: [G1, G2, HALF] } },
        });
        // The delete was done, so it is counted before it is rolled back, and rolled back.
        expect(tx.studentGroup.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [G1, G2] } } });
        await expectRolledBack();
      });

      it('counts the halves a class takes with it once: not those the call names itself', async () => {
        givenGroups(group(G1), teachingGroup(G2, { halfOfId: G1 }));
        givenCounts();

        const result = await service.bulkRemove({ ids: [G1, G2], dryRun: true }, user);

        expect(result.consequences).toMatchObject({ halves: 0 });
        const pupils = countStatements().find((statement) => statement.text.includes('FROM "Users"'));
        expect(pupils?.values).toEqual([[G1, G2]]);
      });

      it('locks the named groups and the halves they take along FOR UPDATE, in id order, before it reads or counts', async () => {
        givenGroups(group(G1));
        givenCounts();

        await service.bulkRemove({ ids: [G1], dryRun: true }, user);

        const [first] = tx.$queryRaw.mock.calls;
        expect(textOf(first![0]).replace(/\s+/g, ' ').trim()).toBe(
          'SELECT 1 FROM "StudentGroups" WHERE "id" = ANY(?::uuid[]) OR "halfOfId" = ANY(?::uuid[]) ORDER BY "id" FOR UPDATE',
        );
        expect(first!.slice(1)).toEqual([[G1], [G1]]);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.studentGroup.findMany.mock.invocationCallOrder[0]!);
      });

      describe('the confirmation binds the counts (expected)', () => {
        const dryRunCounts = {
          halves: 0, homePupils: 12, memberships: 30, requirements: 4, masterLessons: 7, sharedLessons: 3,
          calendarLessons: 200, availabilityConstraints: 3, lunchSittings: 5, calendarBreaks: 10, timplanCredits: 1,
          publicLinks: 2, successors: 1, attendanceMarks: 1000, lessonLogs: 9, enrolments: 25, mentorDuties: 1, fromSource: 0,
        };

        it('deletes when nothing grew since the dry run, and answers no counts', async () => {
          givenGroups(group(G1));
          givenCounts();

          const result = await service.bulkRemove({ ids: [G1], dryRun: false, expected: dryRunCounts }, user);

          expect(result).toEqual({ applied: true, dryRun: false, done: [G1], refused: [] });
          expect(tx.studentGroup.deleteMany).toHaveBeenCalledTimes(1);
          await expectCommitted();
        });

        it('deletes nothing when a kind grew, and answers which and the new counts so the dialog can ask again', async () => {
          givenGroups(group(G1));
          givenCounts();

          const result = await service.bulkRemove(
            { ids: [G1], dryRun: false, expected: { ...dryRunCounts, calendarLessons: 199, attendanceMarks: 990 } },
            user,
          );

          expect(result).toMatchObject({
            applied: false,
            dryRun: false,
            done: [G1],
            refused: [],
            consequencesGrew: ['attendanceMarks', 'calendarLessons'],
            consequences: expect.objectContaining({ calendarLessons: 200, attendanceMarks: 1000 }),
          });
          expect(tx.studentGroup.deleteMany).not.toHaveBeenCalled();
          await expectRolledBack();
        });

        it('deletes when a count fell, or the dry run did not name a kind', async () => {
          givenGroups(group(G1));
          givenCounts();
          const { lessonLogs: _dropped, ...withoutLogs } = dryRunCounts;

          const result = await service.bulkRemove(
            { ids: [G1], dryRun: false, expected: { ...withoutLogs, homePupils: 40 } },
            user,
          );

          expect(result.applied).toBe(true);
        });
      });

      it('tries the groups one by one when the database refuses the statement, halves first, and lists the refused', async () => {
        givenGroups(group(G1), teachingGroup(G2, { halfOfId: G1 }), teachingGroup(G3));
        tx.studentGroup.deleteMany.mockRejectedValue(prismaError('P2003'));
        tx.studentGroup.delete.mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === G1) return Promise.reject(prismaError('P2003'));
          if (where.id === G3) {
            return Promise.reject(
              new ConflictException({ message: 'Gruppen används.', code: 'GROUP_IN_USE', params: { lessons: 2 } }),
            );
          }
          return Promise.resolve({ id: where.id });
        });

        const result = await service.bulkRemove({ ids: [G1, G2, G3], dryRun: false }, user);

        expect(result).toEqual({
          applied: false,
          dryRun: false,
          done: [G2],
          refused: [
            { id: G1, code: 'BULK_ROW_REFERENCE_GONE', message: 'Raden skulle peka på något som inte längre finns.' },
            { id: G3, code: 'GROUP_IN_USE', message: 'Gruppen används.', params: { lessons: 2 } },
          ],
        });
        // The half before its class, which would take it with it and then not find it.
        expect(tx.studentGroup.delete.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual([
          G2,
          G1,
          G3,
        ]);
        expect(savepoints()).toEqual([
          'SAVEPOINT bulk_whole',
          'ROLLBACK TO SAVEPOINT bulk_whole',
          'SAVEPOINT bulk_row',
          'RELEASE SAVEPOINT bulk_row',
          'SAVEPOINT bulk_row',
          'ROLLBACK TO SAVEPOINT bulk_row',
          'SAVEPOINT bulk_row',
          'ROLLBACK TO SAVEPOINT bulk_row',
        ]);
        await expectRolledBack();
      });

      it('answers a refusal of one group by a ConflictException from the single delete as that group’s line', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2));
        tx.studentGroup.deleteMany.mockRejectedValue(prismaError('P2003'));
        tx.studentGroup.delete.mockImplementation(({ where }: { where: { id: string } }) =>
          where.id === G2 ? Promise.reject(new ConflictException('Gruppen har ett beslut.')) : Promise.resolve({}),
        );

        const result = await service.bulkRemove({ ids: [G1, G2], dryRun: false }, user);

        expect(result.refused).toEqual([{ id: G2, code: null, message: 'Gruppen har ett beslut.' }]);
        expect(result.done).toEqual([G1]);
      });

      it('fails the call, with the deadlock’s own answer, when the database’s error is no group’s refusal', async () => {
        givenGroups(teachingGroup(G1), teachingGroup(G2));
        tx.studentGroup.deleteMany.mockRejectedValue(prismaError('P2034'));

        await expect(service.bulkRemove({ ids: [G1, G2], dryRun: false }, user)).rejects.toMatchObject({
          status: 409,
          response: { code: WRITE_CONFLICT },
        });
        expect(tx.studentGroup.delete).not.toHaveBeenCalled();
      });
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
      tx.studentGroup.createManyAndReturn.mockResolvedValue([
        { id: H1, name: '7A:1' },
        { id: H2, name: '7A:2' },
      ]);

      await expect(service.split(GROUP_ID, {}, testUser())).resolves.toEqual([
        { id: H1, name: '7A:1' },
        { id: H2, name: '7A:2' },
      ]);

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
      tx.studentGroup.createManyAndReturn.mockResolvedValue([
        { id: H1, name: 'Grupp A' },
        { id: H2, name: 'Grupp B' },
      ]);

      await service.split(GROUP_ID, { names: [' Grupp A ', 'Grupp B'] }, testUser());

      expect(tx.studentGroup.createManyAndReturn).toHaveBeenCalledWith({
        data: [expect.objectContaining({ name: 'Grupp A' }), expect.objectContaining({ name: 'Grupp B' })],
      });
    });

    it('answers the halves in the order they were named, whatever order the insert returns them in', async () => {
      tx.studentGroup.findUnique.mockResolvedValue(theClass());
      tx.studentGroup.createManyAndReturn.mockResolvedValue([
        { id: H2, name: 'Grupp B' },
        { id: H1, name: 'Grupp A' },
      ]);

      const halves = await service.split(GROUP_ID, { names: ['Grupp A', 'Grupp B'] }, testUser());

      expect(halves.map((half) => half.id)).toEqual([H1, H2]);
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
