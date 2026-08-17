import {
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
import type { PrismaService } from '../database/prisma.service';
import type { UsersService } from '../users/users.service';
import { ImportService } from './import.service';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_7A = '66666666-6666-4666-8666-666666666666';
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
  });

  describe('importStudents', () => {
    beforeEach(() => {
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: '7A' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([{ name: '7A' }]);
      tx.studentGroup.create.mockResolvedValue({});

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
          gradeLevel: 7,
        },
      });
    });
  });

  describe('importMemberships', () => {
    beforeEach(() => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({ id: 'g-new' });
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
    const schoolless = () => testUser({ schoolId: undefined });

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
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({});

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
          gradeLevel: null,
        },
      });
    });

    it('importMemberships stamps every membership and on-the-fly group with the principal schoolId', async () => {
      tx.user.findMany.mockResolvedValue([
        { id: STUDENT_ID, email: 'alma@example.com' },
      ]);
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({ id: 'g-new' });
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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: '7A' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({});
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
      tx.studentGroup.findMany.mockResolvedValue([]);
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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: '7A' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({});

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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: 'Ma71' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: 'Ma71' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([]);

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
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({ id: 'g-new' });
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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: 'Ma71' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, name: '7A' }]);
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
      tx.studentGroup.findMany.mockResolvedValue([{ name: '7A' }]);
      tx.studentGroup.create.mockResolvedValue({});

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
      tx.studentGroup.findMany.mockResolvedValue([]);
      tx.studentGroup.create.mockResolvedValue({ id: 'g-new' });
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
});
