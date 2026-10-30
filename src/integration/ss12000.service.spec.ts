import { BadRequestException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { recordedReads } from '../../test/utils/recorded-reads';
import { PUPIL_LIST, lessonNamed, pupilNamed, WITH_SVA, WITHOUT, type PupilListSchool } from '../../test/utils/pupil-list';
import { Ss12000Service } from './ss12000.service';
import { dutyStretchId } from './ss12000-v2/ids';

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

    it('counts and lists the key’s school’s active läsår only, sorted by name', async () => {
      arrangeList('studentGroup', 0, []);

      await service.groups(SCHOOL_ID);

      expect(tx.studentGroup.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, academicYear: { isActive: true } },
      });
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: SCHOOL_ID, academicYear: { isActive: true } },
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

  describe('duties (SS12000 2.1.0 Duty)', () => {
    const YEAR = { id: 'year-1', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') };
    const post = (overrides: Record<string, unknown> = {}) => ({
      id: 'emp-1',
      userId: 'user-1',
      employmentPercent: { toString: () => '80.000' },
      reductionPercent: '20.000',
      contractKind: 'FERIE',
      teachingTargetMinutesPerWeek: 700,
      signature: 'ANN',
      note: 'Förhandlat 2026-04-14',
      ss12000StretchKey: 'aaaabbbb-0000-4000-8000-00000000c0de',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    });
    const arrange = (share: boolean | null, posts = [post()]) => {
      tx.academicYear.findFirst.mockResolvedValue(YEAR);
      tx.staffingPolicy.findUnique.mockResolvedValue(
        share === null ? null : { shareEmploymentWithIntegrations: share, fullTimeAnnualHours: 1767 },
      );
      tx.teacherEmployment.count.mockResolvedValue(posts.length);
      tx.teacherEmployment.findMany.mockImplementation((args: { select: Record<string, unknown> }) =>
        Promise.resolve(posts.map((row) => asSelected({ ...row, employmentPercent: Number(String(row.employmentPercent)) }, args.select))),
      );
      tx.teacherDuty.findMany.mockResolvedValue([
        { userId: 'user-1', studentGroupId: 'g-7b', updatedAt: new Date('2026-09-15T00:00:00.000Z') },
      ]);
    };

    it('maps a post to a Duty: the person, the school, Lärare, the signature, the mentorship, the year’s dates', async () => {
      arrange(false);
      const page = await service.duties(SCHOOL_ID);
      expect(prisma.withServicePrincipal).toHaveBeenCalledWith(SCHOOL_ID, expect.any(Function));
      expect(page).toEqual({
        totalCount: 1,
        limit: 100,
        offset: 0,
        data: [
          {
            id: 'emp-1',
            meta: { created: '2026-08-01T00:00:00.000Z', modified: '2026-09-15T00:00:00.000Z' },
            person: { id: 'user-1' },
            assignmentRole: [{ group: { id: 'g-7b' }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2027-06-11' }],
            dutyAt: { id: SCHOOL_ID },
            dutyRole: 'Lärare',
            signature: 'ANN',
            startDate: '2026-08-17',
            endDate: '2027-06-11',
          },
        ],
      });
    });

    it('never selects the nedsättning, the target or the note — with the switch off or on', async () => {
      for (const share of [false, true]) {
        arrange(share);
        await service.duties(SCHOOL_ID);
        const select = (tx.teacherEmployment.findMany.mock.calls.at(-1)![0] as { select: Record<string, unknown> }).select;
        expect(Object.keys(select).sort()).toEqual(
          ['createdAt', 'employmentPercent', 'id', 'signature', 'updatedAt', 'userId', ...(share ? ['contractKind', 'ss12000StretchKey'] : [])].sort(),
        );
        expect(select).not.toHaveProperty('reductionPercent');
        expect(select).not.toHaveProperty('teachingTargetMinutesPerWeek');
        expect(select).not.toHaveProperty('note');
      }
    });

    it('emits dutyPercent and hoursPerYear only when the school shares them, hoursPerYear for a ferietjänst only, from the post', async () => {
      arrange(true, [post(), post({ id: 'emp-2', userId: 'user-2', contractKind: 'SEMESTER', employmentPercent: { toString: () => '100.000' } })]);
      const { data } = await service.duties(SCHOOL_ID);
      // 80 % of 1 767: never (post − nedsättning).
      expect(data[0]).toMatchObject({ dutyPercent: 80, hoursPerYear: 1414 });
      expect(data[1]).toMatchObject({ dutyPercent: 100 });
      expect(data[1]).not.toHaveProperty('hoursPerYear');
      arrange(null);
      const off = await service.duties(SCHOOL_ID);
      expect(off.data[0]).not.toHaveProperty('dutyPercent');
      expect(off.data[0]).not.toHaveProperty('hoursPerYear');
    });

    it('reads the active year’s posts of active users, and only mentorships on classes of that year', async () => {
      arrange(false);
      await service.duties(SCHOOL_ID, '10', '20');
      expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: SCHOOL_ID, academicYearId: 'year-1', user: { isActive: true } },
          orderBy: { id: 'asc' },
          take: 10,
          skip: 20,
        }),
      );
      expect(tx.teacherDuty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: 'MENTORSKAP', academicYearId: 'year-1', studentGroup: { academicYearId: 'year-1' } }),
        }),
      );
    });

    it('pages a changing post as a Duty per stretch of its grad while the school shares, and reads no period otherwise', async () => {
      arrange(true, [post(), post({ id: 'emp-2', userId: 'user-2', employmentPercent: { toString: () => '100.000' } })]);
      tx.teacherEmploymentPeriod.findMany.mockResolvedValue([
        {
          id: 'per-1',
          employmentId: 'emp-1',
          validFrom: new Date('2027-01-11T00:00:00.000Z'),
          validTo: null,
          employmentPercent: '50.000',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ]);
      const page = await service.duties(SCHOOL_ID, '2', '1');
      // emp-1 is two Duties and emp-2 one: the page counts Duties, not posts.
      expect(page.totalCount).toBe(3);
      expect(page.data.map((duty) => [duty.id, duty.startDate, duty.endDate, duty.dutyPercent])).toEqual([
        [dutyStretchId('emp-1', 'aaaabbbb-0000-4000-8000-00000000c0de', '2027-01-11'), '2027-01-11', '2027-06-11', 50],
        ['emp-2', '2026-08-17', '2027-06-11', 100],
      ]);
      // The spring's own hours and its mentorship within its dates; created with the post.
      expect(page.data[0]).toMatchObject({
        hoursPerYear: 884,
        assignmentRole: [{ group: { id: 'g-7b' }, assignmentRoleType: 'Mentor', startDate: '2027-01-11', endDate: '2027-06-11' }],
        meta: { created: '2026-08-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' },
      });
      // Every post is read, the page is cut from the Duties.
      expect(tx.teacherEmployment.findMany.mock.calls.at(-1)![0]).not.toHaveProperty('take');
      const first = await service.duties(SCHOOL_ID, '1', '0');
      expect(first.data.map((duty) => [duty.id, duty.endDate, duty.dutyPercent])).toEqual([['emp-1', '2027-01-10', 80]]);

      // Without the opt-in no period is read, and the posts page as they always have.
      tx.teacherEmploymentPeriod.findMany.mockClear();
      arrange(false);
      const off = await service.duties(SCHOOL_ID);
      expect(tx.teacherEmploymentPeriod.findMany).not.toHaveBeenCalled();
      expect(off.data.map((duty) => [duty.id, duty.endDate])).toEqual([['emp-1', '2027-06-11']]);
    });

    it('answers an empty page for a school with no active year, asking nothing more', async () => {
      tx.academicYear.findFirst.mockResolvedValue(null);
      await expect(service.duties(SCHOOL_ID)).resolves.toEqual({ totalCount: 0, limit: 100, offset: 0, data: [] });
      expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
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

  describe('Elevlistan i uppföljningen: excludedStudentIds', () => {
    // The shared school (src/common/__fixtures__/pupil-list-cases.json): Alva
    // in SvA7, Bo in Stöd7, Cim in 7A only. v1 lists a group's home pupils
    // and leaves the rest to the consumer, so an activity or event of a
    // group says which of its pupils it does not hold.
    type Where = Record<string, unknown> & { id?: { in: string[] }; studentGroupId?: { in: string[] }; studentId?: { in: string[] } };
    const inList = (condition: { in: string[] } | undefined, value: string) => !condition || condition.in.includes(value);
    const groupName = (school: PupilListSchool, id: string) => school.groups.find((group) => group.id === id)!.name;
    const subject = (id: string) => PUPIL_LIST.subjects.find((row) => row.id === id)!;

    const arrangeSchool = (school: PupilListSchool, inactive: ReadonlySet<string> = new Set()) => {
      tx.studentGroup.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          school.groups
            .filter((group) => (where['replacesSubjectId'] ? group.replacesSubjectId !== null : inList(where.id, group.id)))
            .map(({ id, kind, halfOfId, academicYearId, replacesSubjectId }) => ({ id, kind, halfOfId, academicYearId, replacesSubjectId })),
        ),
      );
      const memberships = PUPIL_LIST.pupils.flatMap((pupil) => pupil.groupIds.map((studentGroupId) => ({ studentGroupId, studentId: pupil.id })));
      tx.studentGroupMember.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(memberships.filter((row) => inList(where.studentGroupId, row.studentGroupId) && inList(where.studentId, row.studentId))),
      );
      tx.user.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          PUPIL_LIST.pupils
            .filter((pupil) => inList(where.id, pupil.id) && (where['isActive'] !== true || !inactive.has(pupil.id)))
            .map((pupil) => ({ id: pupil.id, studentGroupId: pupil.homeGroupId })),
        ),
      );
      const shape = (lesson: (typeof PUPIL_LIST.lessons)[number]) => ({
        id: lesson.id,
        subject: { id: lesson.subjectId, name: subject(lesson.subjectId).name },
        studentGroup: { id: lesson.groupIds[0]!, name: groupName(school, lesson.groupIds[0]!) },
        extraGroups: lesson.groupIds.slice(1).map((studentGroupId) => ({ studentGroupId })),
        participants: lesson.named.map((studentId) => ({ studentId })),
      });
      arrangeList(
        'calendarLesson',
        PUPIL_LIST.lessons.length,
        PUPIL_LIST.lessons.map((lesson, index) => ({
          ...shape(lesson),
          masterLessonId: null,
          startsAt: new Date(`2026-10-19T${String(6 + index).padStart(2, '0')}:00:00.000Z`),
          endsAt: new Date(`2026-10-19T${String(7 + index).padStart(2, '0')}:00:00.000Z`),
          status: 'SCHEDULED',
          room: null,
          teachers: [],
        })),
      );
      arrangeList(
        'masterLesson',
        PUPIL_LIST.lessons.length,
        PUPIL_LIST.lessons.map((lesson) => ({
          ...shape(lesson),
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T08:00:00.000Z'),
          endTime: new Date('1970-01-01T09:00:00.000Z'),
          teacherId: null,
          coTeacherId: null,
          roomId: null,
        })),
      );
    };

    const excludedBy = (data: Array<{ id: string; excludedStudentIds?: string[] }>) =>
      Object.fromEntries(PUPIL_LIST.lessons.map((lesson) => [lesson.name, data.find((row) => row.id === lesson.id)!.excludedStudentIds ?? null]));
    const expectedBy = (school: PupilListSchool) =>
      Object.fromEntries(PUPIL_LIST.lessons.map((lesson) => [lesson.name, school.expected[lesson.id]!.off.length > 0 ? school.expected[lesson.id]!.off : null]));

    it.each([WITH_SVA, WITHOUT].map((school) => [school.name, school] as const))('%s: activities and events leave out exactly the pupils THE RULE takes off', async (_name, school) => {
      arrangeSchool(school);
      const events = await service.calendarEvents(SCHOOL_ID, '2026-10-19', '2026-10-19');
      expect(excludedBy(events.data)).toEqual(expectedBy(school));
      const activities = await service.activities(SCHOOL_ID);
      expect(excludedBy(activities.data)).toEqual(expectedBy(school));
    });

    it('a school with no replacing group sends the very payload it sent before: no excludedStudentIds key, nothing more read', async () => {
      arrangeSchool(WITHOUT);
      const events = await service.calendarEvents(SCHOOL_ID, '2026-10-19', '2026-10-19');
      expect(events.data.every((event) => !('excludedStudentIds' in event))).toBe(true);
      const activities = await service.activities(SCHOOL_ID);
      expect(activities.data.every((activity) => !('excludedStudentIds' in activity))).toBe(true);
      // Only the list of replacing groups was asked: no membership, no pupil.
      expect(tx.studentGroupMember.findMany).not.toHaveBeenCalled();
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('names a left-out pupil in the läslogg as ROSTER, as a named one is', async () => {
      arrangeSchool(WITH_SVA);
      await service.calendarEvents(SCHOOL_ID, '2026-10-19', '2026-10-19');
      await service.activities(SCHOOL_ID);
      const reads = recordedReads(tx).filter((read) => read.kind === 'ROSTER');
      expect(reads).toHaveLength(2);
      // Eva is left out of 7A's svenska and named on no lesson: only the exclusion names her.
      for (const read of reads) expect(read.ids).toContain(pupilNamed('Eva'));
      // The event that names Alva keeps her in studentIds; Eva, named nowhere, is left out.
      const events = await service.calendarEvents(SCHOOL_ID, '2026-10-19', '2026-10-19');
      const named = events.data.find((event) => event.id === lessonNamed('7A:s svenska, Alva namngiven').id)!;
      expect(named).toMatchObject({ studentIds: [pupilNamed('Alva')], excludedStudentIds: [pupilNamed('Eva')] });
    });
  });

  describe('Elevlistan i uppföljningen: only active pupils are left out (review L3)', () => {
    it('a deactivated pupil of SvA7 is in no excludedStudentIds, as v1 lists no inactive member either', async () => {
      // Reuses the block above's arrangement through the describe's own tx.
      const eva = pupilNamed('Eva');
      const alva = pupilNamed('Alva');
      tx.studentGroup.findMany.mockImplementation(({ where }: { where: Record<string, any> }) =>
        Promise.resolve(
          WITH_SVA.groups
            .filter((group) => (where['replacesSubjectId'] ? group.replacesSubjectId !== null : !where['id'] || where['id'].in.includes(group.id)))
            .map(({ id, kind, halfOfId, academicYearId, replacesSubjectId }) => ({ id, kind, halfOfId, academicYearId, replacesSubjectId })),
        ),
      );
      const memberships = PUPIL_LIST.pupils.flatMap((pupil) => pupil.groupIds.map((studentGroupId) => ({ studentGroupId, studentId: pupil.id })));
      tx.studentGroupMember.findMany.mockImplementation(({ where }: { where: Record<string, any> }) =>
        Promise.resolve(
          memberships.filter(
            (row) => (!where['studentGroupId'] || where['studentGroupId'].in.includes(row.studentGroupId)) && (!where['studentId'] || where['studentId'].in.includes(row.studentId)),
          ),
        ),
      );
      tx.user.findMany.mockImplementation(({ where }: { where: Record<string, any> }) =>
        Promise.resolve(
          PUPIL_LIST.pupils
            .filter((pupil) => (!where['id'] || where['id'].in.includes(pupil.id)) && (where['isActive'] !== true || pupil.id !== eva))
            .map((pupil) => ({ id: pupil.id, studentGroupId: pupil.homeGroupId })),
        ),
      );
      const classSvenska = lessonNamed('7A:s svenska');
      arrangeList('calendarLesson', 1, [
        {
          id: classSvenska.id,
          masterLessonId: null,
          startsAt: new Date('2026-10-19T06:00:00.000Z'),
          endsAt: new Date('2026-10-19T07:00:00.000Z'),
          status: 'SCHEDULED',
          subject: { id: classSvenska.subjectId, name: 'Svenska' },
          studentGroup: { id: classSvenska.groupIds[0]!, name: '7A' },
          room: null,
          teachers: [],
          extraGroups: [],
          participants: [],
        },
      ]);
      const events = await service.calendarEvents(SCHOOL_ID, '2026-10-19', '2026-10-19');
      expect(events.data[0]).toMatchObject({ excludedStudentIds: [alva] });
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
      tx.user.updateMany.mockResolvedValue({ count: 1 });
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
        classesKept: 0,
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

    describe('the leave requests a class move gives a mentor (20261101090000)', () => {
      const TELL = 'app.leave_requests_tell_new_mentors()';
      const MENTOR = '77777777-7777-4777-8777-777777777777';
      const NOTICE = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
      let deliverCommitted: jest.Mock;
      let open: boolean;
      const asks = () => tx.$queryRaw.mock.calls.filter((call) => String((call[0] as string[]).join('?')).includes(TELL));

      beforeEach(() => {
        open = false;
        deliverCommitted = jest.fn(() => expect(open).toBe(false));
        prisma.withServicePrincipal.mockImplementation(async (_school: string, fn: (client: unknown) => Promise<unknown>) => {
          open = true;
          try {
            return await fn(tx);
          } finally {
            open = false;
          }
        });
        tx.$queryRaw = jest.fn().mockResolvedValue([
          { notificationId: NOTICE, userId: MENTOR, email: 'mentor@example.test', meta: { leaveRequestId: 'r1', schoolDays: 1 } },
        ]);
        tx.studentGroup.findFirst.mockResolvedValue({ id: 'g-new' });
        service = new Ss12000Service(prisma as unknown as PrismaService, { deliverCommitted } as unknown as NotificationsService);
      });

      it('asks once after the writes when a pupil changed class, and delivers after the transaction', async () => {
        // The class write found the pupil in another class, at the write.
        tx.user.findFirst.mockResolvedValue({ id: STUDENT_ID, role: 'STUDENT' });

        await service.importPersons(SCHOOL_ID, [
          { email: 'karin@example.test', groupDisplayName: '7B' },
          { email: 'karin@example.test', groupDisplayName: '7B' },
        ]);

        expect(asks()).toHaveLength(1);
        const at = tx.$queryRaw.mock.invocationCallOrder[0]!;
        expect(at).toBeGreaterThan(tx.user.updateMany.mock.invocationCallOrder.at(-1)!);
        expect(deliverCommitted).toHaveBeenCalledWith([
          expect.objectContaining({ schoolId: SCHOOL_ID, type: 'LEAVE_REQUESTED', recipients: [{ userId: MENTOR, notificationId: NOTICE }] }),
        ]);
      });

      it('asks nothing when the class write found the pupil already there, or no pupil, and writes the names alone', async () => {
        tx.user.findFirst.mockResolvedValue({ id: STUDENT_ID, role: 'STUDENT' });
        tx.user.updateMany.mockResolvedValue({ count: 0 });
        await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '7B', givenName: 'Karin' }]);

        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'g-new' } }] },
          data: { firstName: 'Karin', studentGroupId: 'g-new' },
        });
        expect(tx.user.update).toHaveBeenCalledWith({ where: { id: STUDENT_ID }, data: { firstName: 'Karin' } });
        expect(asks()).toEqual([]);
        expect(deliverCommitted).not.toHaveBeenCalled();
      });
    });

    it('reuses an existing class for a student, matched within the tenant', async () => {
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      tx.studentGroup.findFirst.mockResolvedValue({ id: 'g-existing' });

      const result = await service.importPersons(SCHOOL_ID, [
        { email: 'karin@example.test', groupDisplayName: '7A' },
      ]);

      expect(tx.studentGroup.findFirst).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, name: '7A' },
        select: { id: true },
      });
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
      // Keyed on the role as well as the id: the role was read without a lock,
      // so the write is where it is judged.
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'g-existing' } }] },
        data: { studentGroupId: 'g-existing' },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ updated: 1, groupsCreated: 0 });
    });

    it('puts a pupil in the active läsår’s 8A when next year has an 8A too', async () => {
      // After a läsårsrullning the school has two classes named 8A: this
      // year's, and next year's (the promoted 7A). The table answers by the
      // where it is asked: a lookup without the year would get either.
      const NEXT_YEAR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const classes = [
        { id: 'g-next-8a', academicYearId: NEXT_YEAR_ID, name: '8A' },
        { id: 'g-this-8a', academicYearId: YEAR_ID, name: '8A' },
      ];
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      tx.studentGroup.findFirst.mockImplementation(
        ({ where }: { where: { name: string; academicYearId?: string } }) =>
          Promise.resolve(
            classes.find(
              (group) =>
                group.name === where.name &&
                (where.academicYearId === undefined || group.academicYearId === where.academicYearId),
            ) ?? null,
          ),
      );

      await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '8A' }]);

      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'g-this-8a' } }] },
        data: { studentGroupId: 'g-this-8a' },
      });
      expect(tx.studentGroup.create).not.toHaveBeenCalled();
    });

    describe('around a läsår hand-over, when the roster still names last year’s classes (or already next year’s)', () => {
      const PREVIOUS_YEAR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      // B (active) was rolled from A: A-7A → B-8A, A-8A → B-9A, A-9A graduated.
      // B also opened an intake 7A. The table answers by the where it gets.
      const classes = [
        { id: 'a-7a', academicYearId: PREVIOUS_YEAR_ID, name: '7A', kind: 'CLASS', gradeLevel: 7, successor: 'b-8a', predecessor: null },
        { id: 'a-8a', academicYearId: PREVIOUS_YEAR_ID, name: '8A', kind: 'CLASS', gradeLevel: 8, successor: 'b-9a', predecessor: null },
        { id: 'a-9a', academicYearId: PREVIOUS_YEAR_ID, name: '9A', kind: 'CLASS', gradeLevel: 9, successor: null, predecessor: null },
        { id: 'b-7a', academicYearId: YEAR_ID, name: '7A', kind: 'CLASS', gradeLevel: 7, successor: null, predecessor: null },
        { id: 'b-8a', academicYearId: YEAR_ID, name: '8A', kind: 'CLASS', gradeLevel: 8, successor: null, predecessor: 'a-7a' },
        { id: 'b-9a', academicYearId: YEAR_ID, name: '9A', kind: 'CLASS', gradeLevel: 9, successor: null, predecessor: 'a-8a' },
      ];
      const nameOf = (id: string | null) => (id ? { name: classes.find((group) => group.id === id)!.name } : null);
      let homeOf: string | null = null;

      beforeEach(() => {
        tx.academicYear.findFirst.mockImplementation(({ select }: { select?: Record<string, unknown> }) =>
          Promise.resolve(
            asSelected({ id: YEAR_ID, name: '2027/28', isActive: true, predecessorId: PREVIOUS_YEAR_ID, graduatingGradeLevel: 9 }, select),
          ),
        );
        tx.studentGroup.findMany.mockImplementation(
          ({ where }: { where: { academicYearId: string; kind: string; gradeLevel: { gte: number }; successor: { is: null } } }) =>
            Promise.resolve(
              classes
                .filter(
                  (group) =>
                    group.academicYearId === where.academicYearId &&
                    group.kind === where.kind &&
                    group.gradeLevel >= where.gradeLevel.gte &&
                    group.successor === null,
                )
                .map((group) => ({ name: group.name })),
            ),
        );
        tx.studentGroup.findFirst.mockImplementation(
          ({ where }: { where: { name?: string; academicYearId?: string; members?: unknown } }) => {
            if (where.members !== undefined) {
              const home = classes.find((group) => group.id === homeOf);
              return Promise.resolve(
                home ? { name: home.name, predecessor: nameOf(home.predecessor), successor: nameOf(home.successor) } : null,
              );
            }
            return Promise.resolve(
              classes.find((group) => group.name === where.name && group.academicYearId === where.academicYearId) ?? null,
            );
          },
        );
        arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      });

      it('keeps a promoted pupil in 8A when the roster still says 7A, instead of the intake 7A', async () => {
        homeOf = 'b-8a';
        const result = await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '7A' }]);
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(tx.studentGroup.create).not.toHaveBeenCalled();
        expect(result).toMatchObject({ updated: 1, classesKept: 1, groupsCreated: 0 });
      });

      it('keeps a graduate without a class when the roster still says 9A, instead of the promoted 9A', async () => {
        homeOf = null;
        const result = await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '9A' }]);
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(result).toMatchObject({ classesKept: 1 });
      });

      it('keeps a pupil not yet moved when the roster already says next year’s name', async () => {
        // The register rolled first: A-7A's pupil (A still active here) arrives as 8A.
        homeOf = 'a-7a';
        const result = await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '8A' }]);
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(result).toMatchObject({ classesKept: 1 });
      });

      it('still moves a pupil whose roster names an unrelated class, and leaves a matching one where it is', async () => {
        homeOf = 'b-8a';
        await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '9A' }]);
        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'b-9a' } }] },
          data: { studentGroupId: 'b-9a' },
        });
        tx.user.updateMany.mockClear();
        const same = await service.importPersons(SCHOOL_ID, [{ email: 'karin@example.test', groupDisplayName: '8A' }]);
        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'b-8a' } }] },
          data: { studentGroupId: 'b-8a' },
        });
        expect(same).toMatchObject({ classesKept: 0 });
      });
    });

    it('gives a person made a teacher mid-sync their names and no class', async () => {
      // Read as a student; an admin's PATCH commits before the write, so the
      // role-keyed UPDATE matches no row.
      arrangeUsers({ id: STUDENT_ID, role: 'STUDENT' });
      tx.studentGroup.findFirst.mockResolvedValue({ id: 'g-existing' });
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.importPersons(SCHOOL_ID, [
        {
          email: 'karin@example.test',
          givenName: 'Karin',
          familyName: 'Nygren',
          groupDisplayName: '7A',
        },
      ]);

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: STUDENT_ID },
        data: { firstName: 'Karin', lastName: 'Nygren' },
      });
      // What the sync reports had the PATCH landed before the read: the row
      // was written, and a teacher listed in a class has nothing to report.
      expect(result).toEqual({
        updated: 1,
        groupsCreated: 0,
        guardianLinks: 0,
        classesKept: 0,
        needsProvisioning: [],
      });
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
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: STUDENT_ID, role: 'STUDENT', OR: [{ studentGroupId: null }, { studentGroupId: { not: 'g-new' } }] },
        data: { studentGroupId: 'g-new' },
      });
      expect(result.groupsCreated).toBe(1);
    });

    it('ignores group membership for non-students', async () => {
      arrangeUsers({ id: 'teacher-1', role: 'TEACHER' });

      await service.importPersons(SCHOOL_ID, [
        { email: 'lars@example.test', groupDisplayName: '7A' },
      ]);

      expect(tx.studentGroup.findFirst).not.toHaveBeenCalled();
      expect(tx.user.updateMany).not.toHaveBeenCalled();
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
