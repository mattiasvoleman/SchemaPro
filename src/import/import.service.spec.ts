import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { lockingRead, rawSql, transactionsOf, type LockedTable } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { Prisma } from '@prisma/client';
import type {
  ImportRequirementRowDto,
  ImportRequirementsDto,
  ImportTeacherDutyRowDto,
  ImportTeacherRowDto,
} from './dto/import.dto';
import type { UsersService } from '../users/users.service';
import { ImportService } from './import.service';

/**
 * A row as Prisma returns it: only the fields the query selected. The shared
 * mock resolves whatever a spec stubs, whole, so a field the service stopped
 * selecting would still reach its output here and be undefined in production.
 */
const asSelected = (row: unknown, select?: Record<string, unknown>): unknown => {
  if (!select || row === null || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map((item) => asSelected(item, select));
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => [
        field,
        asSelected(
          (row as Record<string, unknown>)[field],
          (wanted as { select?: Record<string, unknown> }).select,
        ),
      ]),
  );
};

/** Stubs a lookup whose rows come back as the query selected them. */
const arrangeRows = (lookup: jest.Mock, rows: unknown) =>
  lookup.mockImplementation((args?: { select?: Record<string, unknown> }) =>
    Promise.resolve(asSelected(rows, args?.select)),
  );

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_7A = '66666666-6666-4666-8666-666666666666';
const schoolless = () => testUser({ schoolId: undefined });
const STUDENT_ID = 'aaaaaaa1-0000-4000-8000-000000000001';

describe('ImportService', () => {
  let service: ImportService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let users: { create: jest.Mock };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    users = { create: jest.fn().mockResolvedValue({ id: 'created' }) };
    service = new ImportService(
      prisma as unknown as PrismaService,
      users as unknown as UsersService,
    );
  });

  describe('importTeachers', () => {
    it('creates each row through UsersService so invite semantics never fork', async () => {
      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            { firstName: 'Bo', lastName: 'Alm', email: 'bo@example.com' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 2, skipped: 0, errors: [] });
      expect(users.create).toHaveBeenCalledTimes(2);
      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'TEACHER',
          email: 'karin@example.com',
          studentGroupId: undefined,
          // Uploading a roster is preparation, often weeks before term. It
          // contacts nobody; inviting is a separate decision.
          sendInvitation: false,
        }),
        expect.objectContaining({ userId: testUser().userId }),
      );
    });

    it('counts an already-registered email as skipped — re-upload is idempotent', async () => {
      users.create
        .mockRejectedValueOnce(new ConflictException('exists'))
        .mockResolvedValueOnce({ id: 'ok' });

      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            { firstName: 'Bo', lastName: 'Alm', email: 'bo@example.com' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 1, errors: [] });
    });

    it('reports a failing row with its 1-based number and keeps going', async () => {
      users.create
        .mockRejectedValueOnce(new ServiceUnavailableException('invite down'))
        .mockResolvedValueOnce({ id: 'ok' });

      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            { firstName: 'Bo', lastName: 'Alm', email: 'bo@example.com' },
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('invite down') },
      ]);
    });

    it('skips an email duplicated within the file without a second invite', async () => {
      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            { firstName: 'K', lastName: 'E', email: 'KARIN@example.com' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 1, errors: [] });
      expect(users.create).toHaveBeenCalledTimes(1);
    });

    it('trims the whitespace a spreadsheet leaves around names and addresses', async () => {
      await service.importTeachers(
        {
          rows: [
            { firstName: ' Karin ', lastName: 'Ek\t', email: ' karin@example.com ' },
          ],
        },
        testUser(),
      );

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'Karin',
          lastName: 'Ek',
          email: 'karin@example.com',
        }),
        expect.anything(),
      );
    });
  });

  describe('importStudents', () => {
    beforeEach(() => {
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: '7A' }]);
    });

    it('resolves the class by name (trimmed, case-insensitive) and assigns it', async () => {
      const report = await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '  7a ',
            },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'STUDENT', studentGroupId: GROUP_7A }),
        expect.anything(),
      );
    });

    it('flags an unknown class with the row number and imports the valid rows', async () => {
      const report = await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '7X',
            },
            {
              firstName: 'Nils',
              lastName: 'Ahl',
              email: 'nils@example.com',
              className: '7A',
            },
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('"7X"') },
      ]);
      expect(users.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('importGroups', () => {
    it('creates missing groups and skips existing ones by normalized name', async () => {
      arrangeRows(tx.studentGroup.findMany, [{ name: '7A' }]);
      arrangeRows(tx.studentGroup.create, {});

      const report = await service.importGroups(
        {
          academicYearId: YEAR_ID,
          rows: [
            { name: '7a' }, // exists (case-insensitive)
            { name: '7B', gradeLevel: 7 },
            { name: '7B' }, // duplicate within the file
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 2, errors: [] });
      expect(tx.studentGroup.create).toHaveBeenCalledTimes(1);
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          academicYearId: YEAR_ID,
          name: '7B',
          kind: 'CLASS',
          gradeLevel: 7,
        },
      });
      // Only this läsår's classes count as taken: last year's 7B does not make
      // this year's a duplicate.
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
    });
  });

  describe('importSubjects', () => {
    const rows = (overrides: Record<string, unknown>[] = [{}]) =>
      overrides.map((override) => ({ name: 'Matematik', ...override })) as never;

    it('creates a subject, resolving the room type by name', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, [
        { id: 'rt-slojd', name: 'Trä- och metallslöjd' },
      ]);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      const report = await service.importSubjects(
        { rows: rows([{ name: 'Slöjd', code: 'SL', color: '#4f46e5', roomType: 'trä- och metallslöjd' }]) },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          name: 'Slöjd',
          code: 'SL',
          color: '#4f46e5',
          // Matched case-insensitively: a school types the name as it reads,
          // not as it was stored.
          requiredRoomTypeId: 'rt-slojd',
          // A file without the timplan columns: outside the national timplan,
          // and undervisning — today's behaviour.
          nationalCode: null,
          countsTowardTimplan: true,
        },
      });
    });

    describe('the national code', () => {
      it('writes a known code, read once from the reference table, folded to the table’s case', async () => {
        arrangeRows(tx.subject.findMany, []);
        arrangeRows(tx.roomType.findMany, []);
        arrangeRows(tx.nationalSubject.findMany, [{ code: 'SL' }, { code: 'MA' }]);
        tx.subject.create.mockResolvedValue({ id: 'sub-1' });

        const report = await service.importSubjects(
          { rows: rows([{ name: 'Slöjd', nationalCode: ' sl ' }, { name: 'Matte', nationalCode: 'MA' }]) },
          testUser(),
        );

        expect(report).toEqual({ created: 2, skipped: 0, errors: [] });
        expect(tx.nationalSubject.findMany).toHaveBeenCalledTimes(1);
        expect(tx.subject.create).toHaveBeenNthCalledWith(1, {
          data: expect.objectContaining({ nationalCode: 'SL' }),
        });
        expect(tx.subject.create).toHaveBeenNthCalledWith(2, {
          data: expect.objectContaining({ nationalCode: 'MA' }),
        });
      });

      it('fails the row on an unknown code instead of creating the subject unmapped', async () => {
        // A subject created without the mapping it was given is left out of
        // every timplan sum, and the coverage page's warning is a longer way
        // back to the typo than a row error naming it.
        arrangeRows(tx.subject.findMany, []);
        arrangeRows(tx.roomType.findMany, []);
        arrangeRows(tx.nationalSubject.findMany, [{ code: 'MA' }]);

        const report = await service.importSubjects(
          { rows: rows([{ name: 'Matte', nationalCode: 'MATTE' }]) },
          testUser(),
        );

        expect(report.created).toBe(0);
        expect(tx.subject.create).not.toHaveBeenCalled();
        expect(report.errors).toEqual([
          { row: 1, message: expect.stringMatching(/nationalCode.*"MATTE"/) },
        ]);
      });

      it('reads an empty or blank cell as no mapping', async () => {
        arrangeRows(tx.subject.findMany, []);
        arrangeRows(tx.roomType.findMany, []);
        arrangeRows(tx.nationalSubject.findMany, []);
        tx.subject.create.mockResolvedValue({ id: 'sub-1' });

        const report = await service.importSubjects(
          { rows: rows([{ name: 'Mentorstid', nationalCode: '  ' }, { name: 'Resurs', nationalCode: null }]) },
          testUser(),
        );

        expect(report).toEqual({ created: 2, skipped: 0, errors: [] });
        for (const call of tx.subject.create.mock.calls) {
          const { data } = call[0] as { data: { nationalCode: string | null } };
          expect(data.nationalCode).toBeNull();
        }
      });

      it('writes countsTowardTimplan as given, and true for an empty cell', async () => {
        arrangeRows(tx.subject.findMany, []);
        arrangeRows(tx.roomType.findMany, []);
        tx.subject.create.mockResolvedValue({ id: 'sub-1' });

        await service.importSubjects(
          {
            rows: rows([
              { name: 'Resurs', countsTowardTimplan: false },
              { name: 'Bild', countsTowardTimplan: null },
              { name: 'Musik' },
            ]),
          },
          testUser(),
        );

        const flags = tx.subject.create.mock.calls.map(
          (call) => (call[0] as { data: { countsTowardTimplan: boolean } }).data.countsTowardTimplan,
        );
        expect(flags).toEqual([false, true, true]);
      });
    });

    it('accepts a subject with no room-type requirement at all', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, []);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      await service.importSubjects({ rows: rows([{ roomType: '' }]) }, testUser());

      const { data } = tx.subject.create.mock.calls[0][0] as {
        data: { requiredRoomTypeId: string | null };
      };
      expect(data.requiredRoomTypeId).toBeNull();
    });

    it('reads a room-type cell of nothing but spaces as no requirement, not as an unknown type', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, [
        { id: 'rt-slojd', name: 'Trä- och metallslöjd' },
      ]);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      const report = await service.importSubjects(
        { rows: rows([{ roomType: '   ' }]) },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ requiredRoomTypeId: null }),
      });
    });

    it('stores the name, code and colour without the whitespace around them', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, []);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      await service.importSubjects(
        { rows: rows([{ name: ' Slöjd ', code: ' SL ', color: ' #4f46e5 ' }]) },
        testUser(),
      );

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Slöjd', code: 'SL', color: '#4f46e5' }),
      });
    });

    it('fails the row on an unknown room type instead of dropping the requirement', async () => {
      // Creating the subject anyway would leave it schedulable in any room,
      // which surfaces much later as slöjden in an ordinary classroom.
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, []);

      const report = await service.importSubjects(
        { rows: rows([{ name: 'Slöjd', roomType: 'Slöjdsal' }]) },
        testUser(),
      );

      expect(report.created).toBe(0);
      expect(tx.subject.create).not.toHaveBeenCalled();
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('Slöjdsal') },
      ]);
    });

    it('skips a subject that already exists, so a re-upload is a no-op', async () => {
      arrangeRows(tx.subject.findMany, [{ name: 'Matematik' }]);
      arrangeRows(tx.roomType.findMany, []);

      const report = await service.importSubjects(
        { rows: rows([{ name: ' matematik ' }]) },
        testUser(),
      );

      expect(report).toEqual({ created: 0, skipped: 1, errors: [] });
      expect(tx.subject.create).not.toHaveBeenCalled();
    });

    it('collapses names that differ only by case or whitespace within one file', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, []);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      const report = await service.importSubjects(
        { rows: rows([{ name: 'Biologi' }, { name: ' biologi ' }]) },
        testUser(),
      );

      expect(report).toMatchObject({ created: 1, skipped: 1 });
      expect(tx.subject.create).toHaveBeenCalledTimes(1);
    });

    it('stores empty code and colour as null rather than empty strings', async () => {
      arrangeRows(tx.subject.findMany, []);
      arrangeRows(tx.roomType.findMany, []);
      tx.subject.create.mockResolvedValue({ id: 'sub-1' });

      await service.importSubjects({ rows: rows([{ code: '  ', color: '' }]) }, testUser());

      const { data } = tx.subject.create.mock.calls[0][0] as {
        data: { code: string | null; color: string | null };
      };
      expect(data).toMatchObject({ code: null, color: null });
    });

    it('403s a principal with no school before reading anything', async () => {
      await expect(
        service.importSubjects({ rows: rows() }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('importRoomTypes', () => {
    it('creates missing types and skips existing ones by normalized name', async () => {
      arrangeRows(tx.roomType.findMany, [{ name: 'Klassrum' }]);
      tx.roomType.create.mockResolvedValue({});

      const report = await service.importRoomTypes(
        {
          rows: [
            { name: ' klassrum ' }, // exists, case- and space-insensitive
            { name: 'Hemkunskapssal' },
            { name: 'Hemkunskapssal' }, // duplicated within the file
            { name: 'Trä- och metallslöjd' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 2, skipped: 2, errors: [] });
      expect(tx.roomType.create).toHaveBeenCalledTimes(2);
      expect(tx.roomType.create).toHaveBeenCalledWith({
        data: { schoolId: testUser().schoolId, name: 'Hemkunskapssal' },
      });
    });

    it('does not scope the lookup to an academic year', async () => {
      // Room types belong to the school: a slöjdsal outlives any single
      // läsår. Scoping the existence check to a year would re-create every
      // type each August.
      arrangeRows(tx.roomType.findMany, []);
      tx.roomType.create.mockResolvedValue({});

      await service.importRoomTypes({ rows: [{ name: 'Textilslöjd' }] }, testUser());

      expect(tx.roomType.findMany).toHaveBeenCalledWith({
        select: { name: true },
      });
    });

    it('stamps the tenant from the principal, never from the row', async () => {
      arrangeRows(tx.roomType.findMany, []);
      tx.roomType.create.mockResolvedValue({});

      await service.importRoomTypes(
        { rows: [{ name: 'Bildsal', schoolId: 'someone-elses' } as never] },
        testUser(),
      );

      expect(tx.roomType.create).toHaveBeenCalledWith({
        data: { schoolId: testUser().schoolId, name: 'Bildsal' },
      });
    });

    it('stores the name without the whitespace around it', async () => {
      arrangeRows(tx.roomType.findMany, []);
      tx.roomType.create.mockResolvedValue({});

      await service.importRoomTypes({ rows: [{ name: '  Bildsal ' }] }, testUser());

      expect(tx.roomType.create).toHaveBeenCalledWith({
        data: { schoolId: testUser().schoolId, name: 'Bildsal' },
      });
    });

    it('rejects a school-less principal before any DB call', async () => {
      await expect(
        service.importRoomTypes({ rows: [{ name: 'Musiksal' }] }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('importMemberships', () => {
    beforeEach(() => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, { id: 'g-new' });
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });
    });

    it('creates the teaching group on the fly and adds the member', async () => {
      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(tx.studentGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Ma71', schoolId: testUser().schoolId }),
        }),
      );
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: testUser().schoolId,
            studentGroupId: 'g-new',
            studentId: STUDENT_ID,
          },
        ],
        skipDuplicates: true,
      });
    });

    it('creates the group as a teaching group of the posted läsår, its name trimmed', async () => {
      // A group a membership file names cuts across home classes by
      // definition; that is what the file exists to say.
      await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: ' Ma71 ', email: 'alma@example.com' }],
        },
        testUser(),
      );

      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
      expect(tx.studentGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            schoolId: testUser().schoolId,
            academicYearId: YEAR_ID,
            name: 'Ma71',
            kind: 'TEACHING_GROUP',
            gradeLevel: null,
          },
        }),
      );
    });

    it('reuses one group for many rows instead of creating duplicates', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
        { id: 'aaaaaaa2-0000-4000-8000-000000000002', email: 'nils@example.com' },
      ]);
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 2 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [
            { groupName: 'Ma71', email: 'alma@example.com' },
            { groupName: 'ma71', email: 'nils@example.com' },
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(2);
      expect(tx.studentGroup.create).toHaveBeenCalledTimes(1);
    });

    it('flags an unknown student email and continues with the rest', async () => {
      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [
            { groupName: 'Ma71', email: 'ghost@example.com' },
            { groupName: 'Ma71', email: 'alma@example.com' },
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('ghost@example.com') },
      ]);
    });

    it('reports skipDuplicates leftovers as skipped — idempotent re-upload', async () => {
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 0 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 0, skipped: 1, errors: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Adversarial coverage: tenancy, RLS subject, row numbering, failure modes
  // and report arithmetic. Tests below document CURRENT behaviour; the ones
  // below assert the tenant contract shared by every import method: 403
  // stated invariants and exist so any fix must consciously update them.
  // -------------------------------------------------------------------------

  describe('tenant honesty (schoolId only ever from the principal)', () => {

    it('importGroups rejects a school-less principal before any DB call', async () => {
      await expect(
        service.importGroups(
          { academicYearId: YEAR_ID, rows: [{ name: '7A' }] },
          schoolless(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
    });

    it('importMemberships rejects a school-less principal before any DB call', async () => {
      await expect(
        service.importMemberships(
          {
            academicYearId: YEAR_ID,
            rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
          },
          schoolless(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });

    it('importTeachers rejects a school-less principal up front, before any invite', async () => {
      await expect(
        service.importTeachers(
          {
            rows: [
              { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            ],
          },
          schoolless(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.create).not.toHaveBeenCalled();
    });


    it('importGroups stamps the principal schoolId even when a row smuggles one', async () => {
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, {});

      await service.importGroups(
        {
          academicYearId: YEAR_ID,
          // Extra properties survive JSON parsing; whitelist-validation aside,
          // the service itself must never read a tenant id off a row.
          rows: [{ name: '7C', schoolId: 'evil-school' } as never],
        },
        testUser(),
      );

      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          academicYearId: YEAR_ID,
          name: '7C',
          kind: 'CLASS',
          gradeLevel: null,
        },
      });
    });

    it('importMemberships stamps every membership and on-the-fly group with the principal schoolId', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, { id: 'g-new' });
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });

      await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [
            {
              groupName: 'Ma71',
              email: 'alma@example.com',
              schoolId: 'evil-school',
            } as never,
          ],
        },
        testUser(),
      );

      expect(tx.studentGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schoolId: testUser().schoolId }),
        }),
      );
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: testUser().schoolId,
            studentGroupId: 'g-new',
            studentId: STUDENT_ID,
          },
        ],
        skipDuplicates: true,
      });
    });
  });

  describe('RLS wrapper subject', () => {
    it('importStudents hands the caller — not a substitute — to withRls', async () => {
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: '7A' }]);
      const user = testUser();

      await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '7A',
            },
          ],
        },
        user,
      );

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
    });

    it('importGroups runs its whole body under withRls with the caller as subject', async () => {
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, {});
      const user = testUser();

      await service.importGroups(
        { academicYearId: YEAR_ID, rows: [{ name: '7B' }] },
        user,
      );

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
    });

    it('importMemberships runs its whole body under withRls with the caller as subject', async () => {
      tx.user.findMany.mockResolvedValue([]);
      arrangeRows(tx.studentGroup.findMany, []);
      const user = testUser();

      await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'ghost@example.com' }],
        },
        user,
      );

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
    });

    it('importTeachers never touches prisma directly — each row goes through UsersService with the caller', async () => {
      const user = testUser();

      await service.importTeachers(
        {
          rows: [{ firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' }],
        },
        user,
      );

      // Delegation is the RLS story here: UsersService.create opens its own
      // withRls per row; the import service itself must not bypass it.
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(users.create.mock.calls[0][1]).toBe(user);
    });
  });

  describe('importStudents: row numbering and the single class fetch', () => {
    beforeEach(() => {
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: '7A' }]);
    });

    it('keeps ORIGINAL file row numbers when unresolved rows were filtered out before importPeople', async () => {
      // Rows 1 and 3 have unknown classes and are filtered out before
      // importPeople runs. Row 4 (the SECOND surviving row) then fails.
      // Renumbering-after-filtering would report it as row 2.
      users.create
        .mockResolvedValueOnce({ id: 'u-row2' })
        .mockRejectedValueOnce(new ServiceUnavailableException('invite down'))
        .mockResolvedValueOnce({ id: 'u-row5' });

      const report = await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            { firstName: 'A', lastName: 'A', email: 'a@example.com', className: '7X' },
            { firstName: 'B', lastName: 'B', email: 'b@example.com', className: '7A' },
            { firstName: 'C', lastName: 'C', email: 'c@example.com', className: '7Y' },
            { firstName: 'D', lastName: 'D', email: 'd@example.com', className: '7A' },
            { firstName: 'E', lastName: 'E', email: 'e@example.com', className: '7A' },
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(2);
      expect(report.skipped).toBe(0);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('"7X"') },
        { row: 3, message: expect.stringContaining('"7Y"') },
        { row: 4, message: expect.stringContaining('invite down') },
      ]);
    });

    it('fetches the class map ONCE for the whole file, not per row', async () => {
      await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            { firstName: 'A', lastName: 'A', email: 'a@example.com', className: '7A' },
            { firstName: 'B', lastName: 'B', email: 'b@example.com', className: '7A' },
            { firstName: 'C', lastName: 'C', email: 'c@example.com', className: '7a' },
          ],
        },
        testUser(),
      );

      expect(tx.studentGroup.findMany).toHaveBeenCalledTimes(1);
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
        select: { id: true, name: true },
      });
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('a row with BOTH a duplicated email and an unknown class gets exactly one report entry — the class error wins', async () => {
      const report = await service.importStudents(
        {
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '7A',
            },
            {
              // Same email (case-varied) AND an unknown class: the row is
              // filtered out as unresolved before duplicate detection ever
              // sees it, so it lands in errors — not in skipped — and only once.
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'ALMA@example.com',
              className: '7X',
            },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({
        created: 1,
        skipped: 0,
        errors: [{ row: 2, message: expect.stringContaining('"7X"') }],
      });
      expect(users.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('importPeople failure handling (via importTeachers)', () => {
    it('a non-Error rejection from UsersService is reported with the fallback message, not thrown', async () => {
      users.create
        .mockRejectedValueOnce('kaboom — a bare string, not an Error')
        .mockResolvedValueOnce({ id: 'ok' });

      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' },
            { firstName: 'Bo', lastName: 'Alm', email: 'bo@example.com' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({
        created: 1,
        skipped: 0,
        errors: [{ row: 1, message: 'Raden kunde inte importeras.' }],
      });
      // The run continued past the poisoned row.
      expect(users.create).toHaveBeenCalledTimes(2);
    });

    it('a ConflictException after several successes keeps the earlier creates counted', async () => {
      users.create
        .mockResolvedValueOnce({ id: 'u1' })
        .mockResolvedValueOnce({ id: 'u2' })
        .mockRejectedValueOnce(new ConflictException('exists'));

      const report = await service.importTeachers(
        {
          rows: [
            { firstName: 'A', lastName: 'A', email: 'a@example.com' },
            { firstName: 'B', lastName: 'B', email: 'b@example.com' },
            { firstName: 'C', lastName: 'C', email: 'c@example.com' },
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 2, skipped: 1, errors: [] });
    });
  });

  describe('importGroups: name collapsing', () => {
    it('names differing only by surrounding whitespace collapse to a single trimmed create', async () => {
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, {});

      const report = await service.importGroups(
        {
          academicYearId: YEAR_ID,
          rows: [{ name: '  7B ' }, { name: '7B' }],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 1, errors: [] });
      expect(tx.studentGroup.create).toHaveBeenCalledTimes(1);
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          academicYearId: YEAR_ID,
          name: '7B', // trimmed before persisting
          kind: 'CLASS',
          gradeLevel: null,
        },
      });
    });
  });

  describe('importMemberships: matching and side effects', () => {
    it('matches a row email in UPPER case against a lower-case stored student', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: 'Ma71' }]);
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'ALMA@EXAMPLE.COM' }],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      // The needle sent to the DB is lower-cased, deduplicated and matched
      // case-insensitively at the query itself.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: {
          role: 'STUDENT',
          isActive: true,
          email: expect.objectContaining({
            in: ['alma@example.com'],
            mode: 'insensitive',
          }),
        },
        select: { id: true, email: true },
      });
    });

    it('matches emails case-insensitively both in memory AND at the SQL filter', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'ALMA@EXAMPLE.COM' },
      ]);
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: 'Ma71' }]);
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      // The query itself must be case-insensitive; the in-memory map cannot
      // compensate for a case-sensitive SQL gate against real data.
      const where = tx.user.findMany.mock.calls[0][0].where;
      expect(where.email).toMatchObject({
        in: ['alma@example.com'],
        mode: 'insensitive',
      });
    });

    it('a row whose student is missing does NOT create its group as a side effect', async () => {
      tx.user.findMany.mockResolvedValue([]);
      arrangeRows(tx.studentGroup.findMany, []);

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma99', email: 'ghost@example.com' }],
        },
        testUser(),
      );

      expect(report).toEqual({
        created: 0,
        skipped: 0,
        errors: [{ row: 1, message: expect.stringContaining('ghost@example.com') }],
      });
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    });

    it('the group IS created when another valid row names it — the valid row, not the failed one, triggers the create', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, { id: 'g-new' });
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [
            { groupName: 'Ma99', email: 'ghost@example.com' }, // fails first…
            { groupName: 'Ma99', email: 'alma@example.com' }, // …then this creates Ma99
          ],
        },
        testUser(),
      );

      expect(report).toEqual({
        created: 1,
        skipped: 0,
        errors: [{ row: 1, message: expect.stringContaining('ghost@example.com') }],
      });
      expect(tx.studentGroup.create).toHaveBeenCalledTimes(1);
      // Only the resolved student became a member.
      expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
        data: [
          {
            schoolId: testUser().schoolId,
            studentGroupId: 'g-new',
            studentId: STUDENT_ID,
          },
        ],
        skipDuplicates: true,
      });
    });

    it('created + skipped follows the createMany count when skipDuplicates collapses in-file duplicates', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: 'Ma71' }]);
      // Two identical (group, student) pairs reach createMany; the second is
      // dropped by skipDuplicates, so the DB reports count 1.
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 1 });

      const report = await service.importMemberships(
        {
          academicYearId: YEAR_ID,
          rows: [
            { groupName: 'Ma71', email: 'alma@example.com' },
            { groupName: 'ma71', email: 'ALMA@example.com' }, // same pair, case-varied
          ],
        },
        testUser(),
      );

      expect(tx.studentGroupMember.createMany.mock.calls[0][0].data).toHaveLength(2);
      expect(report).toEqual({ created: 1, skipped: 1, errors: [] });
    });
  });

  describe('report arithmetic: created + skipped + errors accounts for every input row', () => {
    it('importTeachers on a mixed fixture (success, conflict, non-Error failure, in-file duplicate)', async () => {
      users.create
        .mockResolvedValueOnce({ id: 'u1' })
        .mockRejectedValueOnce(new ConflictException('exists'))
        .mockRejectedValueOnce('not-an-error');

      const rows = [
        { firstName: 'A', lastName: 'A', email: 'a@example.com' },
        { firstName: 'B', lastName: 'B', email: 'b@example.com' },
        { firstName: 'C', lastName: 'C', email: 'c@example.com' },
        { firstName: 'A2', lastName: 'A2', email: 'A@example.com' }, // dup of row 1
      ];
      const report = await service.importTeachers({ rows }, testUser());

      expect(report.created).toBe(1);
      expect(report.skipped).toBe(2);
      expect(report.errors).toEqual([
        { row: 3, message: 'Raden kunde inte importeras.' },
      ]);
      expect(report.created + report.skipped + report.errors.length).toBe(rows.length);
    });

    it('importStudents on a mixed fixture (unknown class, success, conflict)', async () => {
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: '7A' }]);
      users.create
        .mockResolvedValueOnce({ id: 'u1' })
        .mockRejectedValueOnce(new ConflictException('exists'));

      const rows = [
        { firstName: 'A', lastName: 'A', email: 'a@example.com', className: '9Z' },
        { firstName: 'B', lastName: 'B', email: 'b@example.com', className: '7A' },
        { firstName: 'C', lastName: 'C', email: 'c@example.com', className: '7A' },
      ];
      const report = await service.importStudents(
        { academicYearId: YEAR_ID, rows },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.skipped).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('"9Z"') },
      ]);
      expect(report.created + report.skipped + report.errors.length).toBe(rows.length);
    });

    it('importGroups on a mixed fixture (existing, new, duplicate, whitespace duplicate)', async () => {
      arrangeRows(tx.studentGroup.findMany, [{ name: '7A' }]);
      arrangeRows(tx.studentGroup.create, {});

      const rows = [
        { name: '7a' }, // exists
        { name: '7B' }, // new
        { name: '7B' }, // in-file duplicate
        { name: ' 7b ' }, // whitespace/case duplicate
      ];
      const report = await service.importGroups(
        { academicYearId: YEAR_ID, rows },
        testUser(),
      );

      expect(report).toEqual({ created: 1, skipped: 3, errors: [] });
      expect(report.created + report.skipped + report.errors.length).toBe(rows.length);
    });

    it('importMemberships on a mixed fixture (missing student, new pair, duplicate pair, second student)', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
        { id: 'aaaaaaa2-0000-4000-8000-000000000002', email: 'nils@example.com' },
      ]);
      arrangeRows(tx.studentGroup.findMany, []);
      arrangeRows(tx.studentGroup.create, { id: 'g-new' });
      // 3 pairs reach createMany; one is an exact duplicate → DB creates 2.
      tx.studentGroupMember.createMany.mockResolvedValue({ count: 2 });

      const rows = [
        { groupName: 'Ma71', email: 'ghost@example.com' }, // error
        { groupName: 'Ma71', email: 'alma@example.com' }, // created
        { groupName: 'ma71', email: 'ALMA@EXAMPLE.COM' }, // duplicate pair → skipped
        { groupName: 'Ma71', email: 'nils@example.com' }, // created
      ];
      const report = await service.importMemberships(
        { academicYearId: YEAR_ID, rows },
        testUser(),
      );

      expect(report.created).toBe(2);
      expect(report.skipped).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('ghost@example.com') },
      ]);
      expect(report.created + report.skipped + report.errors.length).toBe(rows.length);

      // The email needles were deduplicated before the query.
      expect(
        tx.user.findMany.mock.calls[0][0].where.email.in,
      ).toEqual(['ghost@example.com', 'alma@example.com', 'nils@example.com']);
      // One group create serves all four rows.
      expect(tx.studentGroup.create).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The timplan import — the only kind that updates rather than only creating.
   * Everything below is about the two halves of that: resolving a human-written
   * row against the school's own catalogue, and deciding whether the row is new,
   * changed, or already exactly what is stored.
   */
  describe('importTeachers with a post in the file', () => {
    const KARIN = 'ccccccc1-0000-4000-8000-000000000001';
    const BO = 'ccccccc2-0000-4000-8000-000000000002';
    const ACTIVE_YEAR = { id: YEAR_ID, name: '2026/2027' };

    const row = (overrides: Partial<ImportTeacherRowDto> = {}): ImportTeacherRowDto => ({
      firstName: 'Karin',
      lastName: 'Ek',
      email: 'karin@example.com',
      employmentPercent: 80,
      ...overrides,
    });

    /**
     * The staff the school already has, by email. The first read (before the
     * people half) sees exactly these; the second read, per post, also finds
     * whoever the people half has just created, as the table would. A test
     * about an address that is NOT staff pins findFirst to null itself.
     */
    const staff = (people: { id: string; email: string }[]) => {
      tx.user.findMany.mockResolvedValue(people);
      tx.user.findFirst.mockImplementation((query: { where: { email: { equals: string } } }) =>
        Promise.resolve(
          people.find((person) => person.email === query.where.email.equals) ?? {
            id: `created:${query.where.email.equals}`,
          },
        ),
      );
    };

    beforeEach(() => {
      tx.academicYear.findFirst.mockResolvedValue(ACTIVE_YEAR);
      tx.teacherEmployment.findMany.mockResolvedValue([]);
      tx.teacherEmployment.findUnique.mockResolvedValue(null);
      tx.teacherEmployment.create.mockResolvedValue({});
      tx.teacherEmployment.update.mockResolvedValue({});
      staff([]);
    });

    it('leaves a three-column file exactly as it was: no year read, no post written, no updated count', async () => {
      const report = await service.importTeachers(
        { rows: [{ firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' }] },
        testUser(),
      );
      expect(report).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(tx.academicYear.findFirst).not.toHaveBeenCalled();
      expect(tx.teacherEmployment.create).not.toHaveBeenCalled();
    });

    it('creates the person and their post for the active year, defaults filled in', async () => {
      // Created by the people half, so the second read finds them.
      tx.user.findFirst.mockResolvedValue({ id: KARIN });

      const report = await service.importTeachers(
        { rows: [row({ signature: ' KE ', reductionPercent: 20 })] },
        testUser(),
      );

      expect(report).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
      expect(tx.academicYear.findFirst).toHaveBeenCalledWith({
        where: { isActive: true },
        select: { id: true, name: true },
      });
      expect(tx.teacherEmployment.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          userId: KARIN,
          academicYearId: YEAR_ID,
          employmentPercent: 80,
          reductionPercent: 20,
          contractKind: 'FERIE',
          signature: 'KE',
        },
      });
    });

    it('moves an existing person from skipped to updated when the file changes their post', async () => {
      staff([{ id: KARIN, email: 'karin@example.com' }]);
      users.create.mockRejectedValue(new ConflictException('exists'));
      tx.teacherEmployment.findUnique.mockResolvedValue({
        employmentPercent: new Prisma.Decimal('100.000'),
        reductionPercent: new Prisma.Decimal('0.000'),
        contractKind: 'FERIE',
        signature: 'KE',
      });

      const report = await service.importTeachers({ rows: [row({ signature: 'KE' })] }, testUser());

      expect(report).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
      expect(tx.teacherEmployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { employmentPercent: 80, reductionPercent: 0, contractKind: 'FERIE', signature: 'KE' },
        }),
      );
    });

    it('keeps an existing person skipped when the file states the post as it already is', async () => {
      staff([{ id: KARIN, email: 'karin@example.com' }]);
      users.create.mockRejectedValue(new ConflictException('exists'));
      tx.teacherEmployment.findUnique.mockResolvedValue({
        employmentPercent: new Prisma.Decimal('80.000'),
        reductionPercent: new Prisma.Decimal('0.000'),
        contractKind: 'FERIE',
        signature: null,
      });

      const report = await service.importTeachers({ rows: [row()] }, testUser());

      expect(report).toEqual({ created: 0, updated: 0, skipped: 1, errors: [] });
      expect(tx.teacherEmployment.update).not.toHaveBeenCalled();
      expect(tx.teacherEmployment.create).not.toHaveBeenCalled();
    });

    it('writes the post for an existing person with none, counting the row as updated', async () => {
      staff([{ id: KARIN, email: 'karin@example.com' }]);
      users.create.mockRejectedValue(new ConflictException('exists'));

      const report = await service.importTeachers({ rows: [row()] }, testUser());

      expect(report).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
      expect(tx.teacherEmployment.create).toHaveBeenCalled();
    });

    it('refuses a nedsättning outside the post before creating the person', async () => {
      const report = await service.importTeachers(
        { rows: [row({ reductionPercent: 90 }), row({ email: 'bo@example.com' })] },
        testUser(),
      );

      expect(report.errors).toEqual([{ row: 1, message: expect.stringMatching(/90 %.*80 %/) }]);
      expect(report.created).toBe(1);
      expect(users.create).toHaveBeenCalledTimes(1);
      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'bo@example.com' }),
        expect.anything(),
      );
    });

    it('refuses a signature or an avtalsform with no tjänstgöringsgrad', async () => {
      const report = await service.importTeachers(
        { rows: [row({ employmentPercent: null, signature: 'KE' })] },
        testUser(),
      );
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('ingen tjänstgöringsgrad') },
      ]);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('refuses every post row when no year is active, and imports the plain rows', async () => {
      tx.academicYear.findFirst.mockResolvedValue(null);

      const report = await service.importTeachers(
        {
          rows: [
            row(),
            { firstName: 'Bo', lastName: 'Alm', email: 'bo@example.com' },
          ],
        },
        testUser(),
      );

      expect(report.errors).toEqual([{ row: 1, message: expect.stringContaining('Inget läsår är aktivt') }]);
      expect(report.created).toBe(1);
      expect(tx.teacherEmployment.create).not.toHaveBeenCalled();
    });

    it('refuses a signature another teacher holds this year, and one repeated in the file for someone else', async () => {
      staff([{ id: BO, email: 'bo@example.com' }]);
      tx.teacherEmployment.findMany.mockResolvedValue([{ userId: BO, signature: 'XY' }]);

      const report = await service.importTeachers(
        {
          rows: [
            row({ signature: 'XY' }), // Bo's
            row({ email: 'cilla@example.com', signature: 'ZZ' }),
            row({ email: 'dan@example.com', signature: 'ZZ' }), // Cilla's, two rows up
            row({ email: 'bo@example.com', firstName: 'Bo', signature: 'XY' }), // Bo keeping his own
          ],
        },
        testUser(),
      );

      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('"XY" används redan av en annan lärare läsåret 2026/2027') },
        { row: 3, message: expect.stringContaining('står redan på rad 2') },
      ]);
      expect(users.create).toHaveBeenCalledTimes(2);
      expect(report.created + report.skipped + (report.updated ?? 0) + report.errors.length).toBe(4);
    });

    it('reports a race on the signature index on the row, with the person standing', async () => {
      tx.user.findFirst.mockResolvedValue({ id: KARIN });
      tx.teacherEmployment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      const report = await service.importTeachers({ rows: [row({ signature: 'KE' })] }, testUser());

      expect(report.errors).toEqual([{ row: 1, message: expect.stringContaining('"KE" används redan') }]);
      expect(report.created).toBe(0);
      expect(report.created + report.skipped + (report.updated ?? 0) + report.errors.length).toBe(1);
    });

    it('refuses a post for an address that is a pupil’s', async () => {
      // The people half skipped the row as a conflict; the staff read finds
      // no teacher or admin behind the address.
      users.create.mockRejectedValue(new ConflictException('exists'));
      tx.user.findFirst.mockResolvedValue(null);

      const report = await service.importTeachers({ rows: [row()] }, testUser());

      expect(report).toEqual({
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [{ row: 1, message: expect.stringContaining('tillhör ingen lärare') }],
      });
    });

    it('writes the post once for an email duplicated in the file', async () => {
      tx.user.findFirst.mockResolvedValue({ id: KARIN });

      const report = await service.importTeachers(
        { rows: [row(), row({ email: 'KARIN@example.com', employmentPercent: 50 })] },
        testUser(),
      );

      expect(report).toEqual({ created: 1, updated: 0, skipped: 1, errors: [] });
      expect(tx.teacherEmployment.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('importTimplan', () => {
    const PLAN = 'abababab-0000-4000-8000-000000000001';
    const SUBJ_MA = 'bbbbbbb1-0000-4000-8000-000000000001';
    const SUBJ_SV = 'bbbbbbb2-0000-4000-8000-000000000002';
    const draft = { id: PLAN, name: 'Grundskolan 2024', status: 'DRAFT' };

    const row = (overrides: Record<string, unknown> = {}) => ({
      subject: 'MA',
      gradeLevel: 4,
      minutesPerWeek: 180,
      ...overrides,
    });

    beforeEach(() => {
      arrangeRows(tx.localTimplan.findUnique, draft);
      tx.localTimplan.update.mockResolvedValue({});
      arrangeRows(tx.subject.findMany, [
        { id: SUBJ_MA, name: 'Matematik', code: 'MA' },
        { id: SUBJ_SV, name: 'Svenska', code: 'SV' },
      ]);
      arrangeRows(tx.localTimplanEntry.findMany, [
        { id: 'e-ma-4', subjectId: SUBJ_MA, gradeLevel: 4, minutesPerWeek: 180, note: 'skolans val' },
        { id: 'e-sv-4', subjectId: SUBJ_SV, gradeLevel: 4, minutesPerWeek: 240, note: null },
      ]);
      tx.localTimplanEntry.create.mockResolvedValue({});
      tx.localTimplanEntry.update.mockResolvedValue({});
    });

    it('creates a new cell, updates a changed one and skips one stated as stored', async () => {
      const report = await service.importTimplan(
        {
          localTimplanId: PLAN,
          rows: [
            row(),
            row({ subject: 'Svenska', minutesPerWeek: 200 }),
            row({ subject: 'matematik', gradeLevel: 0, minutesPerWeek: 60 }),
          ],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 1, updated: 1, skipped: 1, errors: [] });
      expect(tx.localTimplanEntry.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          localTimplanId: PLAN,
          subjectId: SUBJ_MA,
          gradeLevel: 0,
          minutesPerWeek: 60,
          note: null,
        },
      });
      // No note column in the file: the stored notes are left alone.
      expect(tx.localTimplanEntry.update).toHaveBeenCalledWith({
        where: { id: 'e-sv-4' },
        data: { minutesPerWeek: 200 },
      });
    });

    it('refuses a file that would grow the plan past the 400 cells the grid can save, and writes nothing', async () => {
      // An import only adds and updates, so two files of 300 and 150 cells
      // left a draft of 450 that PUT /entries (max 400) could never save again.
      const stored = Array.from({ length: 399 }, (_, i) => ({
        id: `e-${i}`,
        subjectId: `stored-${i}`,
        gradeLevel: 4,
        minutesPerWeek: 60,
        note: null,
      }));
      arrangeRows(tx.localTimplanEntry.findMany, stored);

      const error = await service
        .importTimplan(
          {
            localTimplanId: PLAN,
            rows: [row({ gradeLevel: 1 }), row({ gradeLevel: 2 })],
          },
          testUser(),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('401');
      expect(tx.localTimplanEntry.create).not.toHaveBeenCalled();
      expect(tx.localTimplanEntry.update).not.toHaveBeenCalled();

      // Updating a stored cell adds none, so a file at the cap still goes in.
      arrangeRows(tx.localTimplanEntry.findMany, [
        ...stored,
        { id: 'e-ma-4', subjectId: SUBJ_MA, gradeLevel: 4, minutesPerWeek: 180, note: null },
      ]);
      await expect(
        service.importTimplan({ localTimplanId: PLAN, rows: [row({ minutesPerWeek: 200 })] }, testUser()),
      ).resolves.toMatchObject({ created: 0, updated: 1 });
    });

    it('is idempotent: the same file uploaded twice reports nothing created or updated', async () => {
      const file = { localTimplanId: PLAN, rows: [row(), row({ subject: 'SV', minutesPerWeek: 240 })] };

      await expect(service.importTimplan(file, testUser())).resolves.toEqual({
        created: 0,
        updated: 0,
        skipped: 2,
        errors: [],
      });
      expect(tx.localTimplanEntry.create).not.toHaveBeenCalled();
      expect(tx.localTimplanEntry.update).not.toHaveBeenCalled();
    });

    it('writes the note only from a file that has the column, an empty cell clearing it', async () => {
      const report = await service.importTimplan(
        {
          localTimplanId: PLAN,
          columns: ['subject', 'gradeLevel', 'minutesPerWeek', 'note'],
          rows: [row({ note: '  ' }), row({ subject: 'SV', minutesPerWeek: 240, note: 'SvA-grupp ingår' })],
        },
        testUser(),
      );

      expect(report).toEqual({ created: 0, updated: 2, skipped: 0, errors: [] });
      expect(tx.localTimplanEntry.update).toHaveBeenCalledWith({
        where: { id: 'e-ma-4' },
        data: { minutesPerWeek: 180, note: null },
      });
      expect(tx.localTimplanEntry.update).toHaveBeenCalledWith({
        where: { id: 'e-sv-4' },
        data: { minutesPerWeek: 240, note: 'SvA-grupp ingår' },
      });
    });

    it('fails the row of an unknown subject and of a repeated cell, and imports the rest', async () => {
      const report = await service.importTimplan(
        {
          localTimplanId: PLAN,
          rows: [
            row({ subject: 'Fysik' }),
            row({ gradeLevel: 5 }),
            row({ subject: 'Matematik', gradeLevel: 5, minutesPerWeek: 120 }),
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('Ämnet "Fysik" finns inte') },
        { row: 3, message: expect.stringContaining('Samma ämne och årskurs står redan på rad 2') },
      ]);
    });

    it('touches the plan before writing a cell — the entries have no timestamps of their own', async () => {
      await service.importTimplan({ localTimplanId: PLAN, rows: [row({ gradeLevel: 6 })] }, testUser());

      expect(tx.localTimplan.update).toHaveBeenCalledWith({
        where: { id: PLAN },
        data: { updatedAt: expect.any(Date) },
      });
      expect(tx.localTimplan.update.mock.invocationCallOrder[0]).toBeLessThan(
        tx.localTimplanEntry.create.mock.invocationCallOrder[0]!,
      );
    });

    it('409s a decided plan, naming it, before a single row is read', async () => {
      arrangeRows(tx.localTimplan.findUnique, { ...draft, status: 'DECIDED' });

      const error = await service
        .importTimplan({ localTimplanId: PLAN, rows: [row()] }, testUser())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'TIMPLAN_IS_DECIDED',
        message: expect.stringContaining('"Grundskolan 2024" är beslutad'),
      });
      expect(tx.localTimplan.update).not.toHaveBeenCalled();
      expect(tx.subject.findMany).not.toHaveBeenCalled();
    });

    it('turns the trigger’s refusal — decided between the read and the touch — into the same 409', async () => {
      const message = 'TIMPLAN_IS_DECIDED: lokal timplan "Grundskolan 2024" är beslutad och kan inte ändras; öppna den igen som ett nytt utkast';
      tx.localTimplan.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Database error', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: { driverAdapterError: { cause: { originalCode: 'TP409', originalMessage: message } } },
        }),
      );

      await expect(
        service.importTimplan({ localTimplanId: PLAN, rows: [row()] }, testUser()),
      ).rejects.toMatchObject({ response: { code: 'TIMPLAN_IS_DECIDED' } });
    });

    it('404s a plan RLS hides', async () => {
      arrangeRows(tx.localTimplan.findUnique, null);

      await expect(
        service.importTimplan({ localTimplanId: PLAN, rows: [row()] }, testUser()),
      ).rejects.toThrow('Den lokala timplanen finns inte.');
    });
  });

  describe('importTeacherQualifications', () => {
    const KARIN = 'ccccccc1-0000-4000-8000-000000000001';
    const SUBJ_MA = 'bbbbbbb1-0000-4000-8000-000000000001';
    const SUBJ_SV = 'bbbbbbb2-0000-4000-8000-000000000002';

    const row = (overrides: Record<string, unknown> = {}) => ({
      teacherEmail: 'karin@example.com',
      subject: 'MA',
      minGrade: 7,
      maxGrade: 9,
      kind: 'LEGITIMATION' as const,
      ...overrides,
    });

    beforeEach(() => {
      tx.user.findMany.mockResolvedValue([{ id: KARIN, email: 'karin@example.com' }]);
      arrangeRows(tx.subject.findMany, [
        { id: SUBJ_MA, name: 'Matematik', code: 'MA' },
        { id: SUBJ_SV, name: 'Svenska', code: 'SV' },
      ]);
      arrangeRows(tx.teacherSubjectQualification.findMany, []);
      tx.teacherSubjectQualification.create.mockResolvedValue({});
      tx.teacherSubjectQualification.update.mockResolvedValue({});
    });

    it('creates a row per teacher and subject, stamped with the caller’s school', async () => {
      const report = await service.importTeacherQualifications(
        { rows: [row(), row({ subject: 'Svenska', kind: 'BEHORIG', minGrade: 4, maxGrade: 6 })] },
        testUser(),
      );

      expect(report).toEqual({ created: 2, updated: 0, skipped: 0, errors: [] });
      expect(tx.teacherSubjectQualification.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          userId: KARIN,
          subjectId: SUBJ_SV,
          minGradeLevel: 4,
          maxGradeLevel: 6,
          kind: 'BEHORIG',
        },
      });
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ email: { in: ['karin@example.com'], mode: 'insensitive' } }),
        }),
      );
    });

    it('skips an unchanged row and updates a changed span or kind, touching no other column', async () => {
      arrangeRows(tx.teacherSubjectQualification.findMany, [
        { id: 'q-ma', userId: KARIN, subjectId: SUBJ_MA, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION' },
        { id: 'q-sv', userId: KARIN, subjectId: SUBJ_SV, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION' },
      ]);

      const report = await service.importTeacherQualifications(
        { rows: [row(), row({ subject: 'SV', minGrade: 4 })] },
        testUser(),
      );

      expect(report).toEqual({ created: 0, updated: 1, skipped: 1, errors: [] });
      expect(tx.teacherSubjectQualification.update).toHaveBeenCalledWith({
        where: { id: 'q-sv' },
        data: { minGradeLevel: 4, maxGradeLevel: 9, kind: 'LEGITIMATION' },
      });
    });

    it('reports an unknown teacher, an unknown subject, a reversed span and an in-file duplicate, and keeps going', async () => {
      const report = await service.importTeacherQualifications(
        {
          rows: [
            row({ teacherEmail: 'nobody@example.com' }),
            row({ subject: 'Fysik' }),
            row({ minGrade: 9, maxGrade: 7 }),
            row(),
            row({ kind: 'BEHORIG' }), // same teacher and subject as row 4
          ],
        },
        testUser(),
      );

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([
        { row: 1, message: expect.stringContaining('nobody@example.com') },
        { row: 2, message: expect.stringContaining('"Fysik" finns inte') },
        { row: 3, message: expect.stringMatching(/\(7\).*\(9\)/) },
        { row: 5, message: expect.stringContaining('rad 4') },
      ]);
      expect(report.created + report.skipped + (report.updated ?? 0) + report.errors.length).toBe(5);
    });

    it('rejects a school-less principal before reading anything', async () => {
      await expect(
        service.importTeacherQualifications({ rows: [row()] }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('importRequirements', () => {
    const GROUP_7B = '66666666-6666-4666-8666-666666666667';
    const SUBJ_MA = 'bbbbbbb1-0000-4000-8000-000000000001';
    const SUBJ_SV = 'bbbbbbb2-0000-4000-8000-000000000002';
    const TEACHER_ID = 'ccccccc1-0000-4000-8000-000000000001';
    const CO_TEACHER_ID = 'ccccccc2-0000-4000-8000-000000000002';
    const YEAR_START = new Date('2026-08-17T00:00:00.000Z');
    const YEAR_END = new Date('2027-06-11T00:00:00.000Z');

    /**
     * AcademicYears as the upload's read of the year has to name it: FOR SHARE,
     * the lock a year PATCH moving the bounds waits on.
     */
    const YEARS: LockedTable = {
      name: 'AcademicYears',
      columns: [
        'id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive', 'createdAt',
        'updatedAt',
      ],
      lock: 'FOR SHARE',
    };
    /** The years the read of the bounds can find. */
    let years: Record<string, unknown>[];
    /** The read of the year's bounds. */
    let queryRaw: jest.Mock;

    /** A valid row; each test overrides only the column it is about. */
    const row = (
      overrides: Partial<ImportRequirementRowDto> = {},
    ): ImportRequirementRowDto => ({
      groupName: '7A',
      subject: 'MA',
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      teacherEmail: null,
      coTeacherEmail: null,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      ...overrides,
    });

    /**
     * Every optional column, which is what the template ships and therefore
     * what most files carry. A test about a file that LACKS a column calls
     * `runWithColumns` instead and says which ones it had — the distinction is
     * load-bearing, because a column the file never had must not be written.
     */
    const ALL_COLUMNS = [
      'minutesBefore',
      'minutesAfter',
      'teacherEmail',
      'coTeacherEmail',
      'teacherLoadPercent',
      'coTeacherLoadPercent',
      'recurrence',
      'startDate',
      'endDate',
    ] as const;

    const runWithColumns = (
      columns: ImportRequirementsDto['columns'],
      ...rows: ImportRequirementRowDto[]
    ) =>
      service.importRequirements(
        { academicYearId: YEAR_ID, columns, rows },
        testUser(),
      );

    const run = (...rows: ImportRequirementRowDto[]) =>
      runWithColumns([...ALL_COLUMNS], ...rows);

    /** What the file says, stored: the shape `existing` rows are compared to. */
    const stored = (overrides: Record<string, unknown> = {}) => ({
      id: 'req-1',
      studentGroupId: GROUP_7A,
      subjectId: SUBJ_MA,
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      // A stored row always has both, never null: the columns are NOT NULL with
      // a default of 0. A fixture that left them out would read as `undefined`
      // through the select and make every unchanged row look changed.
      minutesBefore: 0,
      minutesAfter: 0,
      // NOT NULL DEFAULT 100, like the buffers' 0.
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      ...overrides,
    });

    beforeEach(() => {
      arrangeRows(tx.studentGroup.findMany, [
        { id: GROUP_7A, name: '7A' },
        { id: GROUP_7B, name: '7B' },
      ]);
      arrangeRows(tx.subject.findMany, [
        { id: SUBJ_MA, name: 'Matematik', code: 'MA' },
        { id: SUBJ_SV, name: 'Svenska', code: 'SV' },
      ]);
      tx.user.findMany.mockResolvedValue([
        { id: TEACHER_ID, email: 'karin@example.com' },
        { id: CO_TEACHER_ID, email: 'bo@example.com' },
      ]);
      arrangeRows(tx.teachingRequirement.findMany, []);
      tx.teachingRequirement.create.mockResolvedValue({});
      tx.teachingRequirement.update.mockResolvedValue({});
      years = [
        {
          id: YEAR_ID,
          schoolId: testUser().schoolId,
          name: '2026/2027',
          isActive: true,
          startDate: YEAR_START,
          endDate: YEAR_END,
        },
      ];
      // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
      // and a proxy is not callable. It answers as the table would, from the
      // years above, and throws on a read that takes another lock or none.
      queryRaw = jest.fn((...call: unknown[]) =>
        Promise.resolve(lockingRead(YEARS, years, call)),
      );
      Object.assign(tx, { $queryRaw: queryRaw });
    });

    describe('resolution', () => {
      it('creates a requirement from a row with no counterpart, stamped with the school of the caller and the posted year', async () => {
        const report = await run(
          row({ teacherEmail: 'karin@example.com', coTeacherEmail: 'bo@example.com' }),
        );

        expect(report).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
        expect(tx.teachingRequirement.create).toHaveBeenCalledWith({
          data: {
            schoolId: testUser().schoolId,
            academicYearId: YEAR_ID,
            studentGroupId: GROUP_7A,
            subjectId: SUBJ_MA,
            teacherId: TEACHER_ID,
            coTeacherId: CO_TEACHER_ID,
            // Empty cells in the two percentage columns: the whole row each.
            teacherLoadPercent: 100,
            coTeacherLoadPercent: 100,
            lessonsPerWeek: 3,
            minutesPerLesson: 60,
            minutesBefore: 0,
            minutesAfter: 0,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
          },
        });
        // Compared against this läsår's timplan only: last year's 7A/MA is not
        // the row this file updates.
        expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
        );
      });

      it('matches the subject by CODE or by NAME, either one case-insensitively', async () => {
        const report = await run(
          row({ subject: '  ma ' }),
          row({ subject: 'svenska' }),
        );

        expect(report).toMatchObject({ created: 2, errors: [] });
        const subjectIds = tx.teachingRequirement.create.mock.calls.map(
          (call) => call[0].data.subjectId,
        );
        expect(subjectIds).toEqual([SUBJ_MA, SUBJ_SV]);
      });

      it('resolves the group by name, trimmed and case-insensitively', async () => {
        await run(row({ groupName: ' 7b ' }));

        expect(tx.teachingRequirement.create.mock.calls[0][0].data.studentGroupId).toBe(
          GROUP_7B,
        );
        expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
          where: { academicYearId: YEAR_ID },
          select: { id: true, name: true },
        });
      });

      it('an unknown group is a ROW error and does not create the group — unlike a membership file, a timplan only points at groups', async () => {
        const report = await run(row({ groupName: '7X' }), row({ groupName: '7A' }));

        expect(report).toEqual({
          created: 1,
          updated: 0,
          skipped: 0,
          errors: [{ row: 1, message: expect.stringContaining('"7X"') }],
        });
        expect(tx.studentGroup.create).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.create).toHaveBeenCalledTimes(1);
      });

      it('an unknown subject is a row error and the surrounding rows still import', async () => {
        const report = await run(row({ subject: 'Fysik' }), row({ subject: 'SV' }));

        expect(report.created).toBe(1);
        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('"Fysik"') },
        ]);
      });

      it('a string that hits one subject by CODE and another by NAME is ambiguous, and the error names both', async () => {
        // A real collision: "MU" is the code of Musik and the name a school
        // gave its "MU"-project subject. Picking either one silently would put
        // a whole subject's lessons somewhere nobody asked for.
        arrangeRows(tx.subject.findMany, [
          { id: SUBJ_MA, name: 'Musik', code: 'MU' },
          { id: SUBJ_SV, name: 'MU', code: 'MUPROJ' },
        ]);

        const report = await run(row({ subject: 'mu' }));

        expect(report.created).toBe(0);
        expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
        const [error] = report.errors;
        expect(error!.row).toBe(1);
        expect(error!.message).toContain('Musik');
        expect(error!.message).toContain('MUPROJ');
      });

      it('names both candidates of an ambiguous subject, with a code only where one exists', async () => {
        arrangeRows(tx.subject.findMany, [
          { id: SUBJ_MA, name: 'Biologi', code: 'BI' },
          { id: SUBJ_SV, name: 'BI', code: null },
        ]);

        const report = await run(row({ subject: 'bi' }));

        expect(report.errors).toEqual([
          {
            row: 1,
            message:
              'Ämnet "bi" är tvetydigt: det matchar "Biologi" (kod BI) och "BI". ' +
              'Skriv något som bara passar ett av dem.',
          },
        ]);
      });

      it('an unknown teacher email is a row error naming the address', async () => {
        const report = await run(row({ teacherEmail: 'ghost@example.com' }));

        expect(report).toEqual({
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [{ row: 1, message: expect.stringContaining('ghost@example.com') }],
        });
        expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
      });

      it('an unknown CO-teacher email is a row error that says which column it was', async () => {
        const report = await run(
          row({ teacherEmail: 'karin@example.com', coTeacherEmail: 'ghost@example.com' }),
        );

        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('medlärare') },
        ]);
        expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
      });

      it('asks the database for teachers case-insensitively — the map alone cannot save a mixed-case stored address', async () => {
        tx.user.findMany.mockResolvedValue([
          { id: TEACHER_ID, email: 'Karin@Example.com' },
        ]);

        const report = await run(row({ teacherEmail: 'KARIN@EXAMPLE.COM' }));

        expect(report).toMatchObject({ created: 1, errors: [] });
        expect(tx.user.findMany).toHaveBeenCalledWith({
          where: {
            role: 'TEACHER',
            isActive: true,
            email: expect.objectContaining({
              in: ['karin@example.com'],
              mode: 'insensitive',
            }),
          },
          select: { id: true, email: true },
        });
      });

      it('resolves teacher and co-teacher addresses written with spaces around them', async () => {
        const report = await run(
          row({ teacherEmail: ' karin@example.com ', coTeacherEmail: 'bo@example.com  ' }),
        );

        expect(report).toMatchObject({ created: 1, errors: [] });
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
        });
      });

      it('a file with no teacher columns at all asks for no teachers and leaves the requirement unassigned', async () => {
        const report = await run(row(), row({ subject: 'SV' }));

        expect(report).toMatchObject({ created: 2, errors: [] });
        expect(tx.user.findMany).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          teacherId: null,
          coTeacherId: null,
        });
      });
    });

    describe('the period', () => {
      it('a date outside the läsår fails THAT row, with its number — one typo must not cost the other rows', async () => {
        const report = await run(
          row({ startDate: '2027-08-01' }), // next year entirely
          row({ subject: 'SV', startDate: '2026-09-01', endDate: '2026-12-20' }),
        );

        expect(report.created).toBe(1);
        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('2027-08-01') },
        ]);
        expect(report.errors[0]!.message).toContain('2026-08-17');
      });

      it('an end date before the start date is a row error', async () => {
        const report = await run(
          row({ startDate: '2026-12-20', endDate: '2026-09-01' }),
        );

        expect(report.created).toBe(0);
        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('2026-09-01') },
        ]);
      });

      it('does not read the academic year at all when no row states a period', async () => {
        await run(row(), row({ subject: 'SV' }));

        // Nor lock it: an upload that dates nothing cannot strand anything, so
        // it has no reason to hold up a year PATCH for its whole run.
        expect(queryRaw).not.toHaveBeenCalled();
      });

      it('says nothing about a year the caller cannot see, and lets the foreign key refuse the row', async () => {
        // Under RLS a year belonging to another school reads as null. Answering
        // "outside its year" would confirm that it exists; the composite
        // foreign key on the insert is what refuses it. Same silence as
        // TeachingRequirementsService.assertPeriodFitsYear.
        years = [];

        const report = await run(row({ startDate: '2027-08-01' }));

        expect(report.errors).toEqual([]);
        expect(report.created).toBe(1);
      });

      it('says which date falls outside which läsår, in dates a school reads', async () => {
        // A row stating only a start date is checked as well.
        const report = await run(row({ startDate: '2027-08-01' }));

        expect(report.errors).toEqual([
          {
            row: 1,
            message: 'Startdatumet (2027-08-01) ligger utanför läsåret (2026-08-17–2027-06-11).',
          },
        ]);
        expect(queryRaw.mock.calls.map((call) => call.slice(1))).toEqual([[YEAR_ID]]);
      });

      it('checks a dated row against the year even when the other rows state no period', async () => {
        const report = await run(row(), row({ subject: 'SV', endDate: '2027-07-01' }));

        expect(report.created).toBe(1);
        expect(report.errors).toEqual([
          { row: 2, message: expect.stringContaining('2027-07-01') },
        ]);
      });

      it('accepts a period that spans the läsår exactly, first day to last', async () => {
        const report = await run(row({ startDate: '2026-08-17', endDate: '2027-06-11' }));

        expect(report).toMatchObject({ created: 1, errors: [] });
      });

      it('refuses a start date the day before the läsår begins', async () => {
        const report = await run(row({ startDate: '2026-08-16' }));

        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('2026-08-16') },
        ]);
      });

      it('accepts a period of a single day', async () => {
        const report = await run(row({ startDate: '2026-10-05', endDate: '2026-10-05' }));

        expect(report).toMatchObject({ created: 1, errors: [] });
      });

      // Every dated row is measured against bounds read once, before the first
      // write. A year PATCH counts only committed periods, so one committing
      // between that read and the upload's commit counts none of these rows and
      // strands them. FOR SHARE is what the PATCH's FOR NO KEY UPDATE waits on,
      // and it holds only while the transaction that took it is open: the one
      // that writes every row.
      it('reads the year FOR SHARE once, before the first write, in the transaction that writes every row', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [stored({ subjectId: SUBJ_SV })]);
        const ranIn = transactionsOf(prisma);
        const readIn = ranIn(queryRaw);
        const createdIn = ranIn(tx.teachingRequirement.create);
        const updatedIn = ranIn(tx.teachingRequirement.update);

        const report = await run(
          row({ startDate: '2026-09-01' }),
          row({ subject: 'SV', endDate: '2027-01-15' }),
        );

        expect(report).toEqual({ created: 1, updated: 1, skipped: 0, errors: [] });
        expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
        expect(createdIn).toEqual(readIn);
        expect(updatedIn).toEqual(readIn);
        const [call] = queryRaw.mock.calls;
        expect(rawSql(call)).toMatch(
          /SELECT "startDate", "endDate"\s+FROM "AcademicYears"\s+WHERE "id" = \?::uuid\s+FOR SHARE/,
        );
        expect(call.slice(1)).toEqual([YEAR_ID]);
        expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          tx.teachingRequirement.create.mock.invocationCallOrder[0],
        );
      });
    });

    describe('duplicates inside the file', () => {
      it('flags the second row for a group and subject, naming the number of the first', async () => {
        const report = await run(
          row({ subject: 'MA' }),
          row({ subject: 'SV' }),
          row({ subject: 'Matematik' }), // same pair as row 1, written by name
        );

        expect(report.created).toBe(2);
        expect(report.errors).toEqual([
          { row: 3, message: expect.stringContaining('rad 1') },
        ]);
        expect(tx.teachingRequirement.create).toHaveBeenCalledTimes(2);
      });

      it('a first row that failed on its teacher still claims the pair — the duplicate is a defect in the file either way', async () => {
        const report = await run(
          row({ teacherEmail: 'ghost@example.com' }),
          row(),
        );

        expect(report.created).toBe(0);
        expect(report.errors).toEqual([
          { row: 1, message: expect.stringContaining('ghost@example.com') },
          { row: 2, message: expect.stringContaining('rad 1') },
        ]);
      });
    });

    describe('created / updated / skipped', () => {
      it('an existing row the file changes is UPDATED, by id and with every column the row states', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [stored()]);

        const report = await run(
          row({ lessonsPerWeek: 4, teacherEmail: 'karin@example.com' }),
        );

        expect(report).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
        expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
          where: { id: 'req-1' },
          data: {
            teacherId: TEACHER_ID,
            coTeacherId: null,
            teacherLoadPercent: 100,
            coTeacherLoadPercent: 100,
            lessonsPerWeek: 4,
            minutesPerLesson: 60,
            minutesBefore: 0,
            minutesAfter: 0,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
          },
        });
      });

      it('an identical row is SKIPPED, not counted as an update — the number is what tells a school the upload did something', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ teacherId: TEACHER_ID }),
        ]);

        const report = await run(row({ teacherEmail: 'karin@example.com' }));

        expect(report).toEqual({ created: 0, updated: 0, skipped: 1, errors: [] });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('an unchanged PERIOD is compared by day, not by Date identity — Prisma hands back a fresh object per read', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({
            startDate: new Date('2026-09-01T00:00:00.000Z'),
            endDate: new Date('2026-12-20T00:00:00.000Z'),
          }),
        ]);

        const report = await run(
          row({ startDate: '2026-09-01', endDate: '2026-12-20' }),
        );

        expect(report).toEqual({ created: 0, updated: 0, skipped: 1, errors: [] });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('a moved end date alone is enough to count as an update', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ endDate: new Date('2026-12-20T00:00:00.000Z') }),
        ]);

        const report = await run(row({ endDate: '2027-01-15' }));

        expect(report).toMatchObject({ updated: 1, skipped: 0 });
      });

      it('a cleared column clears the stored value — within a row the file is what is true', async () => {
        // Otherwise a teacher or a period entered by mistake could never be
        // taken back by editing the file, only in the UI, and re-uploading an
        // edited timplan would be half a mechanism.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({
            teacherId: TEACHER_ID,
            startDate: new Date('2026-09-01T00:00:00.000Z'),
          }),
        ]);

        const report = await run(row({ teacherEmail: null, startDate: null }));

        expect(report).toMatchObject({ updated: 1 });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).toMatchObject({
          teacherId: null,
          startDate: null,
        });
      });

      /*
       * A COLUMN THE FILE NEVER HAD is a different silence from an empty cell,
       * and the one above is the only one the file gets to be authoritative
       * about.
       *
       * A school's own spreadsheet is usually just the four required columns —
       * the teachers and the terms were set in the app, not in Excel. Uploading
       * it to correct a lesson count used to strip the teacher, the co-teacher
       * and the whole period off every requirement it matched, and report
       * `updated` with no errors. Nothing on any screen said so.
       *
       * The rows cannot carry the distinction: the ValidationPipe runs
       * class-transformer, which materialises every declared property, so a row
       * posted without `teacherEmail` arrives here holding `undefined` under
       * that very key. The file's column set travels separately, and these
       * tests are what hold the two silences apart.
       */
      it('leaves the teacher alone when the file had no teacher columns', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ teacherId: TEACHER_ID, coTeacherId: CO_TEACHER_ID }),
        ]);

        const report = await runWithColumns(
          [],
          row({ lessonsPerWeek: 4, teacherEmail: null, coTeacherEmail: null }),
        );

        expect(report).toMatchObject({ updated: 1 });
        const { data } = tx.teachingRequirement.update.mock.calls[0][0];
        expect(data).toEqual({ lessonsPerWeek: 4, minutesPerLesson: 60 });
      });

      it('leaves an alternating course alternating when the file had no veckor column', async () => {
        // "Slöjd udda veckor" becoming "slöjd every week" doubles the subject's
        // hours and the next generation packs twice the lessons — from an
        // upload that only meant to change a number in another column.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ recurrence: 'ODD_WEEKS' }),
        ]);

        const report = await runWithColumns([], row({ lessonsPerWeek: 4 }));

        expect(report).toMatchObject({ updated: 1 });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).not.toHaveProperty(
          'recurrence',
        );
      });

      it('leaves a half-term period standing when the file had no date columns', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({
            startDate: new Date('2027-01-11T00:00:00.000Z'),
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          }),
        ]);

        const report = await runWithColumns(
          ['teacherEmail', 'coTeacherEmail', 'recurrence'],
          row({ lessonsPerWeek: 4 }),
        );

        const { data } = tx.teachingRequirement.update.mock.calls[0][0];
        expect(data).not.toHaveProperty('startDate');
        expect(data).not.toHaveProperty('endDate');
        expect(report).toMatchObject({ updated: 1 });
      });

      it('counts a four-column file that changes nothing as skipped, not updated', async () => {
        // The count is what a school reads to decide whether the upload did
        // what they meant. Comparing fields the upload will not write would
        // report "updated" for a file that altered nothing.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({
            teacherId: TEACHER_ID,
            recurrence: 'EVEN_WEEKS',
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          }),
        ]);

        const report = await runWithColumns([], row());

        expect(report).toMatchObject({ created: 0, updated: 0, skipped: 1 });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('reads a missing columns key as "change nothing else"', async () => {
        // The recoverable direction. A caller that forgets the key writes too
        // little, which is visible and fixable by uploading the full file; the
        // other reading empties five fields across a läsår.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ teacherId: TEACHER_ID }),
        ]);

        const report = await service.importRequirements(
          { academicYearId: YEAR_ID, rows: [row({ lessonsPerWeek: 4 })] },
          testUser(),
        );

        expect(report).toMatchObject({ updated: 1 });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).toEqual({
          lessonsPerWeek: 4,
          minutesPerLesson: 60,
        });
      });

      /*
       * Every field the comparison claims to look at, one at a time.
       *
       * The suite pinned two of seven: five of them could be struck out of
       * `requirementIsUnchanged` and stay green, which turns "0 updated" — the
       * number a school reads to decide whether the upload did what they meant
       * — into a number that means nothing.
       */
      it.each([
        ['teacher', { teacherId: TEACHER_ID }, { teacherEmail: null }],
        ['co-teacher', { coTeacherId: CO_TEACHER_ID }, { coTeacherEmail: null }],
        ['lesson count', { lessonsPerWeek: 5 }, { lessonsPerWeek: 3 }],
        ['lesson length', { minutesPerLesson: 45 }, { minutesPerLesson: 60 }],
        ['recurrence', { recurrence: 'ODD_WEEKS' }, { recurrence: 'ALL_WEEKS' }],
        [
          'start date',
          { startDate: new Date('2026-09-01T00:00:00.000Z') },
          { startDate: null },
        ],
        [
          'end date',
          { endDate: new Date('2027-03-27T00:00:00.000Z') },
          { endDate: null },
        ],
      ])(
        'a differing %s alone is enough to count as an update',
        async (_field, storedOverride, rowOverride) => {
          arrangeRows(tx.teachingRequirement.findMany, [
            stored(storedOverride),
          ]);

          const report = await run(row(rowOverride as Partial<ImportRequirementRowDto>));

          expect(report).toMatchObject({ updated: 1, skipped: 0 });
          expect(tx.teachingRequirement.update).toHaveBeenCalledTimes(1);
        },
      );

      it('counts an untouched re-upload of the full file as skipped', async () => {
        // The other half: with every field equal, nothing may be written. A
        // comparison that always returns false would pass the seven above.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({
            teacherId: TEACHER_ID,
            coTeacherId: CO_TEACHER_ID,
            recurrence: 'ODD_WEEKS',
            startDate: new Date('2026-09-01T00:00:00.000Z'),
            endDate: new Date('2027-03-27T00:00:00.000Z'),
          }),
        ]);

        const report = await run(
          row({
            teacherEmail: 'karin@example.com',
            coTeacherEmail: 'bo@example.com',
            recurrence: 'ODD_WEEKS',
            startDate: '2026-09-01',
            endDate: '2027-03-27',
          }),
        );

        expect(report).toMatchObject({ created: 0, updated: 0, skipped: 1 });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('never deletes: a requirement absent from the file is left standing and counted nowhere', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored(),
          stored({ id: 'req-2', subjectId: SUBJ_SV, lessonsPerWeek: 5 }),
        ]);

        const report = await run(row({ lessonsPerWeek: 4 }));

        expect(report).toEqual({ created: 0, updated: 1, skipped: 0, errors: [] });
        expect(tx.teachingRequirement.delete).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.deleteMany).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.update).toHaveBeenCalledTimes(1);
      });

      it('created + updated + skipped + errors accounts for every input row', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored(), // 7A/MA, unchanged by row 1
          stored({ id: 'req-2', subjectId: SUBJ_SV, lessonsPerWeek: 5 }), // changed by row 2
        ]);

        const rows = [
          row(), // skipped: identical
          row({ subject: 'Svenska', lessonsPerWeek: 4 }), // updated
          row({ groupName: '7B', subject: 'SV' }), // created
          row({ groupName: '9Z' }), // error: unknown group
          row({ subject: 'MA' }), // error: duplicate of row 1
        ];
        const report = await service.importRequirements(
          { academicYearId: YEAR_ID, rows },
          testUser(),
        );

        expect(report.created).toBe(1);
        expect(report.updated).toBe(1);
        expect(report.skipped).toBe(1);
        expect(report.errors.map((error) => error.row)).toEqual([4, 5]);
        expect(
          report.created +
            report.updated! +
            report.skipped +
            report.errors.length,
        ).toBe(rows.length);
      });
    });

    /*
     * Ombyte och dusch through the file.
     *
     * The two columns are the CSV round trip's own half of the pupil buffer, and
     * they meet both silences the block above is about: a file that HAS the
     * columns and leaves a cell blank says 0, and a file that never had them says
     * nothing at all. The first is what makes an ombyte removable by editing the
     * spreadsheet; the second is what keeps a four-column file from sending a
     * class to matematik straight out of duschen.
     */
    describe('ombyte och dusch (minutesBefore / minutesAfter)', () => {
      it('writes both buffers from a file that carries the columns', async () => {
        const report = await run(row({ minutesBefore: 10, minutesAfter: 20 }));

        expect(report).toMatchObject({ created: 1, errors: [] });
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          minutesBefore: 10,
          minutesAfter: 20,
        });
      });

      it('writes 0 on a create even when the file has neither column', async () => {
        // The schema defaults both to 0, so this is belt and braces on purpose:
        // the row the import creates is the row the method describes, and an
        // omitted column must not leave the two numbers to be inferred.
        const report = await runWithColumns([], row());

        expect(report).toMatchObject({ created: 1, errors: [] });
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          minutesBefore: 0,
          minutesAfter: 0,
        });
      });

      it('reads an EMPTY cell in a column the file has as 0, and clears a stored buffer with it', async () => {
        // Otherwise an ombyte entered by mistake could only be taken back in the
        // app, and re-uploading a corrected timplan would be half a mechanism —
        // the same argument the teacher and the period columns already make.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ minutesBefore: 10, minutesAfter: 20 }),
        ]);

        // The browser spells an empty cell as an omitted key or a null; both
        // arrive here as "no number in a column that exists".
        const report = await run(row({ minutesBefore: undefined, minutesAfter: null }));

        expect(report).toMatchObject({ updated: 1, errors: [] });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).toMatchObject({
          minutesBefore: 0,
          minutesAfter: 0,
        });
      });

      it('leaves a stored ombyte standing when the file had no ombyte columns', async () => {
        // The silent loss this guard exists for: a school sets 20 minutes of
        // dusch on idrotten in the app, then uploads its own four-column
        // spreadsheet to fix one lesson count. Zeroing the buffer here would put
        // the class in its next lesson while it is still in omklädningsrummet,
        // under a report that says "updated" and lists no errors.
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ minutesBefore: 10, minutesAfter: 20 }),
        ]);

        const report = await runWithColumns([], row({ lessonsPerWeek: 4 }));

        expect(report).toMatchObject({ updated: 1 });
        const { data } = tx.teachingRequirement.update.mock.calls[0][0];
        expect(data).toEqual({ lessonsPerWeek: 4, minutesPerLesson: 60 });
      });

      it.each<[string, Partial<ImportRequirementRowDto>]>([
        ['ombyte before', { minutesBefore: 10 }],
        ['dusch after', { minutesAfter: 20 }],
      ])('a differing %s alone is enough to count as an update', async (_case, patch) => {
        arrangeRows(tx.teachingRequirement.findMany, [stored()]);

        const report = await run(row(patch));

        expect(report).toMatchObject({ created: 0, updated: 1, skipped: 0 });
      });

      it('an unchanged buffer is SKIPPED — a re-upload of an idrottstimplan reports 0 updated', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [
          stored({ minutesBefore: 10, minutesAfter: 20 }),
        ]);

        const report = await run(row({ minutesBefore: 10, minutesAfter: 20 }));

        expect(report).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: [] });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('reads the stored buffers, or every unchanged row would look changed', async () => {
        // The select is what makes the comparison possible at all: a column the
        // query does not ask for comes back undefined, which never equals the
        // 0 the file states.
        await run(row());

        expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({ minutesBefore: true, minutesAfter: true }),
          }),
        );
      });
    });

    describe('vad varje lärare belastas med (teacherLoadPercent / coTeacherLoadPercent)', () => {
      it('writes both percentages from a file that carries the columns', async () => {
        const report = await run(
          row({ teacherEmail: 'karin@example.com', coTeacherEmail: 'bo@example.com', teacherLoadPercent: 200, coTeacherLoadPercent: 0 }),
        );
        expect(report).toMatchObject({ created: 1, errors: [] });
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          teacherLoadPercent: 200,
          coTeacherLoadPercent: 0,
        });
      });

      it('writes 100 on a create when the file has neither column', async () => {
        await runWithColumns([], row());
        expect(tx.teachingRequirement.create.mock.calls[0][0].data).toMatchObject({
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
        });
      });

      it('reads an EMPTY cell in a column the file has as 100, and restores a stored 50 with it', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [stored({ coTeacherLoadPercent: 50 })]);
        const report = await run(row({ coTeacherLoadPercent: null }));
        expect(report).toMatchObject({ updated: 1, errors: [] });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).toMatchObject({
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
        });
      });

      it('leaves a stored percentage standing when the file had no such column', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [stored({ coTeacherLoadPercent: 50 })]);
        const report = await runWithColumns([], row({ lessonsPerWeek: 4 }));
        expect(report).toMatchObject({ updated: 1 });
        expect(tx.teachingRequirement.update.mock.calls[0][0].data).toEqual({ lessonsPerWeek: 4, minutesPerLesson: 60 });
      });

      it('counts a changed percentage alone as an update, and an unchanged one as skipped', async () => {
        arrangeRows(tx.teachingRequirement.findMany, [stored({ teacherLoadPercent: 50 })]);
        await expect(run(row({ teacherLoadPercent: 75 }))).resolves.toMatchObject({ updated: 1, skipped: 0 });
        tx.teachingRequirement.update.mockClear();
        await expect(run(row({ teacherLoadPercent: 50 }))).resolves.toMatchObject({ updated: 0, skipped: 1 });
        expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
      });

      it('reads the stored percentages, or every unchanged row would look changed', async () => {
        await run(row());
        expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({ teacherLoadPercent: true, coTeacherLoadPercent: true }),
          }),
        );
      });
    });

    it('403s a principal with no school before touching the database', async () => {
      await expect(
        service.importRequirements({ academicYearId: YEAR_ID, rows: [row()] }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('importTeacherDuties', () => {
    const KARIN = 'ccccccc1-0000-4000-8000-000000000001';
    const BO = 'ccccccc2-0000-4000-8000-000000000002';
    const SUBJ_MA = 'bbbbbbb1-0000-4000-8000-000000000001';
    const ALL = ['teacherEmail', 'kind', 'label', 'minutesPerWeek', 'countsAsTeaching', 'subject', 'groupName', 'note'] as const;

    /** Users as the upload re-reads its teachers: by id list, FOR NO KEY UPDATE. */
    let lockedRoles: Record<string, string>;
    let queryRaw: jest.Mock;

    const row = (overrides: Partial<ImportTeacherDutyRowDto> = {}): ImportTeacherDutyRowDto => ({
      teacherEmail: 'karin@example.com',
      kind: 'MENTORSKAP',
      label: 'Mentor 7A',
      minutesPerWeek: 60,
      countsAsTeaching: null,
      subject: null,
      groupName: '7A',
      note: null,
      ...overrides,
    });
    const stored = (overrides: Record<string, unknown> = {}) => ({
      id: 'duty-1',
      userId: KARIN,
      kind: 'MENTORSKAP',
      label: 'Mentor 7A',
      minutesPerWeek: 60,
      countsAsTeaching: false,
      subjectId: null,
      studentGroupId: GROUP_7A,
      note: null,
      ...overrides,
    });
    const run = (rows: ImportTeacherDutyRowDto[], columns: readonly string[] = ALL) =>
      service.importTeacherDuties(
        { academicYearId: YEAR_ID, columns: [...columns] as never, rows },
        testUser(),
      );

    beforeEach(() => {
      tx.user.findMany.mockResolvedValue([
        { id: KARIN, email: 'karin@example.com' },
        { id: BO, email: 'Bo@Example.com' },
      ]);
      lockedRoles = { [KARIN]: 'TEACHER', [BO]: 'SCHOOL_ADMIN' };
      queryRaw = jest.fn((...call: unknown[]) => {
        const sql = rawSql(call).replace(/\s+/g, ' ').trim();
        if (sql !== 'SELECT "id", "role" FROM "Users" WHERE "id" = ANY(?::uuid[]) FOR NO KEY UPDATE') {
          throw new Error(`unexpected raw read: ${sql}`);
        }
        const ids = call[1] as string[];
        return Promise.resolve(ids.filter((id) => id in lockedRoles).map((id) => ({ id, role: lockedRoles[id] })));
      });
      Object.assign(tx, { $queryRaw: queryRaw });
      arrangeRows(tx.subject.findMany, [{ id: SUBJ_MA, name: 'Matematik', code: 'MA' }]);
      arrangeRows(tx.studentGroup.findMany, [{ id: GROUP_7A, name: '7A' }]);
      arrangeRows(tx.teacherDuty.findMany, []);
      tx.teacherDuty.create.mockResolvedValue({});
      tx.teacherDuty.update.mockResolvedValue({});
    });

    it('creates an uppdrag per row, stamped with the caller’s school and the dialog’s year, never with a slot', async () => {
      const report = await run([
        row(),
        row({ teacherEmail: 'bo@example.com', kind: 'AMNESANSVAR', label: 'Ämnesansvar Ma', subject: 'MA', groupName: null, minutesPerWeek: 40, countsAsTeaching: true, note: ' Halvår ' }),
      ]);
      expect(report).toEqual({ created: 2, updated: 0, skipped: 0, errors: [] });
      expect(tx.teacherDuty.create).toHaveBeenNthCalledWith(1, {
        data: {
          schoolId: testUser().schoolId,
          userId: KARIN,
          academicYearId: YEAR_ID,
          kind: 'MENTORSKAP',
          label: 'Mentor 7A',
          minutesPerWeek: 60,
          countsAsTeaching: false,
          subjectId: null,
          studentGroupId: GROUP_7A,
          note: null,
        },
      });
      expect(tx.teacherDuty.create.mock.calls[1][0].data).toMatchObject({
        userId: BO,
        subjectId: SUBJ_MA,
        studentGroupId: null,
        countsAsTeaching: true,
        note: 'Halvår',
      });
      expect(tx.teacherDuty.create.mock.calls[0][0].data).not.toHaveProperty('blockedConstraintId');
      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
    });

    it('re-reads the teachers under the role PATCH’s lock, and drops one who stopped being staff', async () => {
      lockedRoles = { [KARIN]: 'STUDENT', [BO]: 'TEACHER' };
      const report = await run([row()]);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(queryRaw.mock.calls[0][1]).toEqual([KARIN, BO]);
      expect(report.errors).toEqual([
        { row: 1, message: 'Ingen aktiv lärare med e-postadressen "karin@example.com". Importera lärarna först.' },
      ]);
      expect(tx.teacherDuty.create).not.toHaveBeenCalled();
    });

    it('is idempotent: the same file again is all skipped, matched on teacher, kind and label case-folded', async () => {
      arrangeRows(tx.teacherDuty.findMany, [stored({ label: 'mentor 7a ' })]);
      const report = await run([row()]);
      expect(report).toEqual({ created: 0, updated: 0, skipped: 1, errors: [] });
      expect(tx.teacherDuty.update).not.toHaveBeenCalled();
    });

    it('updates the figures a file changes and nothing it has no column for', async () => {
      arrangeRows(tx.teacherDuty.findMany, [stored({ note: 'satt i appen', countsAsTeaching: true })]);
      const report = await run([row({ minutesPerWeek: 90 })], ['teacherEmail', 'kind', 'label', 'minutesPerWeek']);
      expect(report).toMatchObject({ updated: 1, skipped: 0 });
      expect(tx.teacherDuty.update).toHaveBeenCalledWith({ where: { id: 'duty-1' }, data: { minutesPerWeek: 90 } });
    });

    it('reads an empty cell in a column the file has as none, and clears with it', async () => {
      arrangeRows(tx.teacherDuty.findMany, [stored({ note: 'gammal', countsAsTeaching: true })]);
      const report = await run([row({ note: '  ', countsAsTeaching: null })]);
      expect(report).toMatchObject({ updated: 1 });
      expect(tx.teacherDuty.update.mock.calls[0][0].data).toMatchObject({ note: null, countsAsTeaching: false });
    });

    it.each<[string, Partial<ImportTeacherDutyRowDto>, string]>([
      ['an unknown teacher', { teacherEmail: 'okand@example.com' }, 'Ingen aktiv lärare med e-postadressen "okand@example.com"'],
      ['an unknown subject', { subject: 'Fysik' }, 'Ämnet "Fysik" finns inte'],
      ['an unknown group', { groupName: '9Z' }, 'Gruppen "9Z" finns inte för det valda läsåret'],
    ])('reports %s as a row error and imports the rest', async (_case, patch, message) => {
      const report = await run([row(patch), row({ label: 'Mentor 7A bis' })]);
      expect(report.created).toBe(1);
      expect(report.errors).toEqual([{ row: 1, message: expect.stringContaining(message) }]);
    });

    it('refuses a second row for the same uppdrag in the file, naming the first', async () => {
      const report = await run([row(), row({ label: ' MENTOR 7a', minutesPerWeek: 30 })]);
      expect(report.created).toBe(1);
      expect(report.errors).toEqual([{ row: 2, message: expect.stringContaining('rad 1') }]);
    });

    it('refuses to guess between two stored uppdrag with the same identity', async () => {
      arrangeRows(tx.teacherDuty.findMany, [stored(), stored({ id: 'duty-2' })]);
      const report = await run([row({ minutesPerWeek: 90 })]);
      expect(report.errors).toEqual([{ row: 1, message: expect.stringContaining('redan 2 uppdrag') }]);
      expect(tx.teacherDuty.update).not.toHaveBeenCalled();
    });

    it('reads no lock at all for a file naming nobody it knows', async () => {
      tx.user.findMany.mockResolvedValue([]);
      const report = await run([row()]);
      expect(queryRaw).not.toHaveBeenCalled();
      expect(report.errors).toHaveLength(1);
    });

    it('403s a principal with no school before touching the database', async () => {
      await expect(
        service.importTeacherDuties({ academicYearId: YEAR_ID, rows: [row()] }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });
});
