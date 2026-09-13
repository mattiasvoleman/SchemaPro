import { BadRequestException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { Ss12000Service } from './ss12000.service';

/**
 * A row as Prisma returns it: only the fields the query selected. The shared
 * mock resolves whatever a spec stubs, whole, so a field the service stopped
 * selecting would still reach its output here and be undefined in production,
 * which is to say in the payload a kommun reads.
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

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('Ss12000Service', () => {
  let service: Ss12000Service;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new Ss12000Service(prisma as unknown as PrismaService);
  });

  /**
   * Every list endpoint returns `[count, rows]` from a Promise.all. The rows
   * come back as the query selected them.
   */
  const arrangeList = (model: string, count: number, rows: unknown[]) => {
    tx[model]!['count']!.mockResolvedValue(count);
    tx[model]!['findMany']!.mockImplementation(
      ({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(asSelected(rows, select)),
    );
  };

  describe('tenancy', () => {
    it.each([
      ['organisation', () => service.organisation(SCHOOL_ID)],
      ['persons', () => service.persons(SCHOOL_ID)],
      ['groups', () => service.groups(SCHOOL_ID)],
      ['activities', () => service.activities(SCHOOL_ID)],
      [
        'calendarEvents',
        () => service.calendarEvents(SCHOOL_ID, '2026-08-01', '2026-08-31'),
      ],
    ])(
      '%s runs under the service principal for its school',
      async (_name, call) => {
        tx.school.findUnique.mockResolvedValue(null);
        arrangeList('user', 0, []);
        arrangeList('studentGroup', 0, []);
        arrangeList('masterLesson', 0, []);
        arrangeList('calendarLesson', 0, []);

        await call();

        // Regression guard: these used withSystemTransaction, which does not
        // bypass RLS — every endpoint silently returned an empty payload.
        expect(prisma.withServicePrincipal).toHaveBeenCalledWith(
          SCHOOL_ID,
          expect.any(Function),
        );
        expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('organisation', () => {
    it('maps a school to the SS12000 organisation shape', async () => {
      // The key's own school, found by its id; any other id finds nothing.
      tx.school.findUnique.mockImplementation(({ where, select }: any) =>
        Promise.resolve(
          where?.id === SCHOOL_ID
            ? asSelected(
                {
                  id: SCHOOL_ID,
                  name: 'Demo Skola',
                  timezone: 'Europe/Stockholm',
                  createdAt: new Date('2026-01-01T00:00:00.000Z'),
                },
                select,
              )
            : null,
        ),
      );

      await expect(service.organisation(SCHOOL_ID)).resolves.toEqual({
        id: SCHOOL_ID,
        displayName: 'Demo Skola',
        organisationType: 'Skolenhet',
        timezone: 'Europe/Stockholm',
      });
    });

    it('does not throw when the school row is missing', async () => {
      tx.school.findUnique.mockResolvedValue(null);

      await expect(service.organisation(SCHOOL_ID)).resolves.toEqual({
        id: undefined,
        displayName: undefined,
        organisationType: 'Skolenhet',
        timezone: undefined,
      });
    });
  });

  describe('pagination', () => {
    beforeEach(() => arrangeList('user', 0, []));

    it('defaults to 100 per page from offset 0', async () => {
      await service.persons(SCHOOL_ID);
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 0 }),
      );
    });

    it('caps the page size at 500', async () => {
      await service.persons(SCHOOL_ID, '99999');
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 }),
      );
    });

    it('floors the page size at 1', async () => {
      await service.persons(SCHOOL_ID, '0');
      // Number("0") is falsy, so the default applies rather than 0.
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('clamps a negative offset to 0', async () => {
      await service.persons(SCHOOL_ID, '10', '-5');
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 }),
      );
    });

    it('ignores non-numeric paging input rather than producing NaN', async () => {
      await service.persons(SCHOOL_ID, 'abc', 'xyz');
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 0 }),
      );
    });

    it('echoes the applied paging back to the caller', async () => {
      await expect(service.persons(SCHOOL_ID, '25', '50')).resolves.toMatchObject(
        { limit: 25, offset: 50, totalCount: 0 },
      );
    });
  });

  describe('persons', () => {
    const user = (overrides: Record<string, unknown> = {}) => ({
      id: 'u1',
      role: 'STUDENT',
      firstName: 'Karin',
      lastName: 'Andersson',
      email: 'karin@example.test',
      isActive: true,
      studentGroupId: null,
      guardianLinks: [],
      studentLinks: [],
      ...overrides,
    });

    it.each([
      ['SCHOOL_ADMIN', 'Personal'],
      ['TEACHER', 'Lärare'],
      ['GUARDIAN', 'Vårdnadshavare'],
      ['STUDENT', 'Elev'],
    ])('maps role %s to personRole %s', async (role, expected) => {
      arrangeList('user', 1, [user({ role })]);

      const result = await service.persons(SCHOOL_ID);
      expect((result.data[0] as { personRole: string }).personRole).toBe(
        expected,
      );
    });

    it('treats an unknown role as a pupil rather than failing', async () => {
      arrangeList('user', 1, [user({ role: 'SOMETHING_NEW' })]);

      const result = await service.persons(SCHOOL_ID);
      expect((result.data[0] as { personRole: string }).personRole).toBe('Elev');
    });

    it('filters by role when one is supplied', async () => {
      arrangeList('user', 0, []);

      await service.persons(SCHOOL_ID, undefined, undefined, 'TEACHER');

      expect(tx.user.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, role: 'TEACHER' },
      });
    });

    it('omits the role filter when none is supplied', async () => {
      arrangeList('user', 0, []);

      await service.persons(SCHOOL_ID);

      expect(tx.user.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
      });
    });

    it('emits enrolments only when the pupil belongs to a group', async () => {
      arrangeList('user', 2, [
        user({ id: 'a', studentGroupId: 'g1' }),
        user({ id: 'b', studentGroupId: null }),
      ]);

      const result = await service.persons(SCHOOL_ID);
      const [a, b] = result.data as Array<{ enrolments: unknown[] }>;
      expect(a!.enrolments).toEqual([{ groupId: 'g1' }]);
      expect(b!.enrolments).toEqual([]);
    });

    it('maps guardian relationships in both directions', async () => {
      arrangeList('user', 1, [
        user({
          guardianLinks: [{ studentId: 'child-1' }],
          studentLinks: [{ guardianId: 'parent-1' }],
        }),
      ]);

      const result = await service.persons(SCHOOL_ID);
      expect(result.data[0]).toMatchObject({
        responsibleFor: [{ personId: 'child-1' }],
        responsibles: [{ personId: 'parent-1' }],
      });
    });

    it('exposes the account status as `enabled`', async () => {
      arrangeList('user', 1, [user({ isActive: false })]);

      const result = await service.persons(SCHOOL_ID);
      expect(result.data[0]).toMatchObject({ enabled: false });
    });

    it('maps a person to the SS12000 person shape', async () => {
      arrangeList('user', 1, [
        user({
          id: 'u9',
          studentGroupId: 'g1',
          studentLinks: [{ guardianId: 'parent-1' }],
        }),
      ]);

      const result = await service.persons(SCHOOL_ID);
      expect(result.data).toEqual([
        {
          id: 'u9',
          givenName: 'Karin',
          familyName: 'Andersson',
          eduPersonPrincipalNames: ['karin@example.test'],
          enabled: true,
          personRole: 'Elev',
          enrolments: [{ groupId: 'g1' }],
          responsibleFor: [],
          responsibles: [{ personId: 'parent-1' }],
        },
      ]);
    });

    it('pages persons sorted by family name', async () => {
      arrangeList('user', 0, []);

      await service.persons(SCHOOL_ID);

      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { lastName: 'asc' } }),
      );
    });
  });

  describe('groups', () => {
    it('maps a student group to the SS12000 group shape', async () => {
      arrangeList('studentGroup', 1, [
        {
          id: 'g1',
          name: '7A',
          gradeLevel: 7,
          academicYearId: 'ay1',
          members: [{ id: 'm1' }, { id: 'm2' }],
        },
      ]);

      const result = await service.groups(SCHOOL_ID);
      expect(result.data[0]).toMatchObject({
        id: 'g1',
        displayName: '7A',
        groupType: 'Klass',
        schoolYear: 7,
        schoolYearId: 'ay1',
        groupMemberships: [{ person: { id: 'm1' } }, { person: { id: 'm2' } }],
      });
    });

    it('counts and lists the key’s school only, sorted by name', async () => {
      arrangeList('studentGroup', 0, []);

      await service.groups(SCHOOL_ID);

      expect(tx.studentGroup.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
      });
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: SCHOOL_ID },
          orderBy: { name: 'asc' },
        }),
      );
    });

    it('counts only active members', async () => {
      arrangeList('studentGroup', 0, []);

      await service.groups(SCHOOL_ID);

      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            members: { select: { id: true }, where: { isActive: true } },
          }),
        }),
      );
    });
  });

  describe('activities', () => {
    it('sends the kommun no lesson that is set aside', async () => {
      await service.activities(SCHOOL_ID);

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isParked: false }),
        }),
      );
    });

    const masterLesson = (overrides: Record<string, unknown> = {}) => ({
      id: 'l1',
      dayOfWeek: 2,
      startTime: new Date('1970-01-01T08:15:00.000Z'),
      endTime: new Date('1970-01-01T09:00:00.000Z'),
      teacherId: 't1',
      coTeacherId: null,
      roomId: 'r1',
      subject: { id: 's1', name: 'Matematik' },
      studentGroup: { id: 'g1', name: '7A' },
      extraGroups: [],
      participants: [],
      ...overrides,
    });

    it('restricts to the active academic year', async () => {
      arrangeList('masterLesson', 0, []);

      await service.activities(SCHOOL_ID);

      expect(tx.masterLesson.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, academicYear: { isActive: true }, isParked: false },
      });
    });

    it('lists the week in timetable order, day by day and lesson by lesson', async () => {
      arrangeList('masterLesson', 0, []);

      await service.activities(SCHOOL_ID);

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        }),
      );
    });

    it('maps a master lesson to the SS12000 activity shape', async () => {
      arrangeList('masterLesson', 1, [
        masterLesson({
          extraGroups: [{ studentGroupId: 'g2' }],
          participants: [{ studentId: 'p1' }, { studentId: 'p2' }],
        }),
      ]);

      const result = await service.activities(SCHOOL_ID);
      expect(result.data[0]).toEqual({
        id: 'l1',
        displayName: 'Matematik — 7A',
        activityType: 'Undervisning',
        subject: { id: 's1', displayName: 'Matematik' },
        groupIds: ['g1', 'g2'],
        teacherIds: ['t1'],
        studentIds: ['p1', 'p2'],
        roomId: 'r1',
        dayOfWeek: 2,
        startTime: '08:15:00',
        endTime: '09:00:00',
      });
    });

    it('includes the co-teacher when one is assigned', async () => {
      arrangeList('masterLesson', 1, [masterLesson({ coTeacherId: 't2' })]);

      const result = await service.activities(SCHOOL_ID);
      expect(result.data[0]).toMatchObject({ teacherIds: ['t1', 't2'] });
    });

    it('renders times as zero-padded HH:MM:00 in UTC', async () => {
      arrangeList('masterLesson', 1, [
        masterLesson({
          startTime: new Date('1970-01-01T07:05:00.000Z'),
          endTime: new Date('1970-01-01T13:40:00.000Z'),
        }),
      ]);

      const result = await service.activities(SCHOOL_ID);
      expect(result.data[0]).toMatchObject({
        startTime: '07:05:00',
        endTime: '13:40:00',
      });
    });
  });

  describe('calendarEvents', () => {
    beforeEach(() => arrangeList('calendarLesson', 0, []));

    it.each([
      [undefined, '2026-08-31'],
      ['2026-08-01', undefined],
      [undefined, undefined],
    ])('requires both from (%s) and to (%s)', async (from, to) => {
      await expect(
        service.calendarEvents(SCHOOL_ID, from, to),
      ).rejects.toThrow(
        new BadRequestException('from and to (YYYY-MM-DD) are required.'),
      );
    });

    it('accepts a complete range', async () => {
      await expect(
        service.calendarEvents(SCHOOL_ID, '2026-08-01', '2026-08-31'),
      ).resolves.toMatchObject({ totalCount: 0 });
    });

    it('bounds the query to the requested dates within the tenant', async () => {
      await service.calendarEvents(SCHOOL_ID, '2026-08-01', '2026-08-31');

      expect(tx.calendarLesson.count).toHaveBeenCalledWith({
        where: {
          schoolId: SCHOOL_ID,
          date: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lte: new Date('2026-08-31T00:00:00.000Z'),
          },
        },
      });
      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            schoolId: SCHOOL_ID,
            date: {
              gte: new Date('2026-08-01T00:00:00.000Z'),
              lte: new Date('2026-08-31T00:00:00.000Z'),
            },
          },
          orderBy: { startsAt: 'asc' },
        }),
      );
    });

    const calendarLesson = (overrides: Record<string, unknown> = {}) => ({
      id: 'cl1',
      masterLessonId: 'l1',
      startsAt: new Date('2026-08-10T08:15:00.000Z'),
      endsAt: new Date('2026-08-10T09:00:00.000Z'),
      status: 'SCHEDULED',
      subject: { id: 's1', name: 'Matematik' },
      studentGroup: { id: 'g1', name: '7A' },
      room: { id: 'r1', name: 'Sal 12' },
      teachers: [{ teacherId: 't1', role: 'PRIMARY' }],
      extraGroups: [],
      participants: [],
      ...overrides,
    });

    it('maps a dated lesson to the SS12000 calendarEvent shape', async () => {
      arrangeList('calendarLesson', 1, [
        calendarLesson({
          extraGroups: [{ studentGroupId: 'g2' }],
          participants: [{ studentId: 'p1' }],
        }),
      ]);

      const result = await service.calendarEvents(
        SCHOOL_ID,
        '2026-08-01',
        '2026-08-31',
      );
      expect(result.data[0]).toEqual({
        id: 'cl1',
        activityId: 'l1',
        startTime: '2026-08-10T08:15:00.000Z',
        endTime: '2026-08-10T09:00:00.000Z',
        cancelled: false,
        subject: { id: 's1', displayName: 'Matematik' },
        groupIds: ['g1', 'g2'],
        teachers: [{ personId: 't1', role: 'PRIMARY' }],
        studentIds: ['p1'],
        room: { id: 'r1', displayName: 'Sal 12' },
      });
    });

    it('flags a CANCELLED lesson and tolerates a missing room', async () => {
      arrangeList('calendarLesson', 1, [
        calendarLesson({ status: 'CANCELLED', room: null }),
      ]);

      const result = await service.calendarEvents(
        SCHOOL_ID,
        '2026-08-01',
        '2026-08-31',
      );
      expect(result.data[0]).toMatchObject({ cancelled: true, room: null });
    });
  });

  describe('importPersons', () => {
    const STUDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const GUARDIAN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const YEAR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    /**
     * `tx.user.findFirst` serves two lookups: the person by email, and each
     * guardian (whose where-clause carries `role: 'GUARDIAN'`). Route on that.
     */
    const arrangeUsers = (
      person: { id: string; role: string } | null,
      guardian: { id: string } | null = null,
    ) => {
      tx.user.findFirst.mockImplementation(
        ({ where }: { where: { role?: string } }) =>
          Promise.resolve(where.role === 'GUARDIAN' ? guardian : person),
      );
    };

    beforeEach(() => {
      tx.academicYear.findFirst.mockImplementation(
        ({ select }: { select?: Record<string, unknown> }) =>
          Promise.resolve(
            asSelected({ id: YEAR_ID, name: '2026/27', isActive: true }, select),
          ),
      );
      tx.user.update.mockResolvedValue({});
      tx.guardianStudent.upsert.mockResolvedValue({});
    });

    it('runs under the service principal for the key’s school', async () => {
      arrangeUsers(null);

      await service.importPersons(SCHOOL_ID, [{ email: 'a@b.se' }]);

      expect(prisma.withServicePrincipal).toHaveBeenCalledWith(
        SCHOOL_ID,
        expect.any(Function),
      );
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
    });

    it('rejects an empty batch before opening a transaction', async () => {
      await expect(service.importPersons(SCHOOL_ID, [])).rejects.toThrow(
        'persons must be a non-empty array (max 2000).',
      );
      expect(prisma.withServicePrincipal).not.toHaveBeenCalled();
    });

    it('rejects a batch above 2000 but accepts exactly 2000', async () => {
      arrangeUsers(null);
      const person = (i: number) => ({ email: `p${i}@example.test` });

      await expect(
        service.importPersons(
          SCHOOL_ID,
          Array.from({ length: 2001 }, (_, i) => person(i)),
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.importPersons(
          SCHOOL_ID,
          Array.from({ length: 2000 }, (_, i) => person(i)),
        ),
      ).resolves.toMatchObject({ updated: 0 });
    });

    it('skips entries without an email entirely', async () => {
      await expect(
        service.importPersons(SCHOOL_ID, [{ givenName: 'Karin' }]),
      ).resolves.toEqual({
        updated: 0,
        groupsCreated: 0,
        guardianLinks: 0,
        needsProvisioning: [],
      });
      expect(tx.user.findFirst).not.toHaveBeenCalled();
    });

    it('matches the person case-insensitively on a normalized email, tenant-scoped', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });

      await service.importPersons(SCHOOL_ID, [
        { email: '  Karin.Andersson@Example.TEST ' },
      ]);

      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: {
          schoolId: SCHOOL_ID,
          email: { equals: 'karin.andersson@example.test', mode: 'insensitive' },
        },
        select: { id: true, role: true },
      });
    });

    it('reports unknown persons for provisioning instead of creating accounts', async () => {
      arrangeUsers(null);

      await expect(
        service.importPersons(SCHOOL_ID, [{ email: 'Ny@Example.test' }]),
      ).resolves.toMatchObject({
        updated: 0,
        needsProvisioning: ['ny@example.test'],
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('deduplicates the provisioning list', async () => {
      arrangeUsers(null);

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'dubblett@example.test' },
        { email: 'DUBBLETT@example.test' },
      ]);
      expect(result.needsProvisioning).toEqual(['dubblett@example.test']);
    });

    it('syncs both names when the roster supplies them', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });

      await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', givenName: 'Karin', familyName: 'Nygren' },
      ]);

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: STUDENT_ID },
        data: { firstName: 'Karin', lastName: 'Nygren' },
      });
    });

    it('updates only the name fields that were supplied', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', familyName: 'Nygren' },
      ]);

      // Exact data object: no firstName, no studentGroupId slipped in.
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: STUDENT_ID },
        data: { lastName: 'Nygren' },
      });
      expect(result.updated).toBe(1);
      // The roster named no guardians, so none was looked for or reported.
      expect(result).toMatchObject({ guardianLinks: 0, needsProvisioning: [] });
    });

    it('reuses an existing class for a student, matched within the tenant', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      tx.studentGroup.findFirst.mockResolvedValue({ id: 'g-existing' });

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', groupDisplayName: '7A' },
      ]);

      expect(tx.studentGroup.findFirst).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, name: '7A' },
        select: { id: true },
      });
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentGroupId: 'g-existing' }),
        }),
      );
      expect(result.groupsCreated).toBe(0);
    });

    it('creates an unknown class in the active year and enrols the student', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      tx.studentGroup.findFirst.mockResolvedValue(null);
      tx.studentGroup.create.mockResolvedValue({ id: 'g-new' });

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', groupDisplayName: '7B' },
      ]);

      expect(tx.academicYear.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schoolId: SCHOOL_ID, isActive: true } }),
      );
      expect(tx.studentGroup.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, name: '7B' },
        select: { id: true },
      });
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentGroupId: 'g-new' }),
        }),
      );
      expect(result.groupsCreated).toBe(1);
    });

    it('ignores group membership for non-students', async () => {
      arrangeUsers({ id: 'teacher-1', role: 'TEACHER' });

      await service.importPersons(SCHOOL_ID, [
        { email: 'lars@example.test', groupDisplayName: '7A' },
      ]);

      expect(tx.studentGroup.findFirst).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ studentGroupId: expect.anything() }),
        }),
      );
    });

    it('skips group handling when no academic year is active', async () => {
      tx.academicYear.findFirst.mockResolvedValue(null);
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', groupDisplayName: '7A' },
      ]);

      expect(tx.studentGroup.findFirst).not.toHaveBeenCalled();
      expect(result).toMatchObject({ updated: 1, groupsCreated: 0 });
    });

    it('links an existing guardian to the student, scoped to the tenant', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' }, { id: GUARDIAN_ID });

      const result = await service.importPersons(SCHOOL_ID, [
        {
          email: 'karin@example.test',
          responsibleEmails: [' Mor.Andersson@Example.Test '],
        },
      ]);

      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: {
          schoolId: SCHOOL_ID,
          role: 'GUARDIAN',
          email: {
            equals: 'mor.andersson@example.test',
            mode: 'insensitive',
          },
        },
        select: { id: true },
      });
      expect(tx.guardianStudent.upsert).toHaveBeenCalledWith({
        where: {
          guardianId_studentId: {
            guardianId: GUARDIAN_ID,
            studentId: STUDENT_ID,
          },
        },
        create: {
          schoolId: SCHOOL_ID,
          guardianId: GUARDIAN_ID,
          studentId: STUDENT_ID,
        },
        update: {},
      });
      expect(result.guardianLinks).toBe(1);
    });

    it('reports unknown guardians for provisioning without linking', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' }, null);

      const result = await service.importPersons(SCHOOL_ID, [
        {
          email: 'karin@example.test',
          responsibleEmails: [' Okand@Example.test '],
        },
      ]);

      expect(tx.guardianStudent.upsert).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        guardianLinks: 0,
        needsProvisioning: ['okand@example.test'],
      });
    });
  });
});
