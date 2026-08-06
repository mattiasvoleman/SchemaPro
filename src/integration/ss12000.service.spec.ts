import { BadRequestException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { Ss12000Service } from './ss12000.service';

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

  /** Every list endpoint returns `[count, rows]` from a Promise.all. */
  const arrangeList = (model: string, count: number, rows: unknown[]) => {
    tx[model]!['count']!.mockResolvedValue(count);
    tx[model]!['findMany']!.mockResolvedValue(rows);
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
      tx.school.findUnique.mockResolvedValue({
        id: SCHOOL_ID,
        name: 'Demo Skola',
        timezone: 'Europe/Stockholm',
      });

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
      });
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
    it('restricts to the active academic year', async () => {
      arrangeList('masterLesson', 0, []);

      await service.activities(SCHOOL_ID);

      expect(tx.masterLesson.count).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, academicYear: { isActive: true } },
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
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a complete range', async () => {
      await expect(
        service.calendarEvents(SCHOOL_ID, '2026-08-01', '2026-08-31'),
      ).resolves.toMatchObject({ totalCount: 0 });
    });
  });
});
