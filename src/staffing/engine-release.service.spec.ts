import { BadRequestException, NotFoundException } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import { givenRolloverWorld, prismaFor, type RolloverWorld, type Row } from '../../test/utils/rollover-world';
import type { PrismaService } from '../database/prisma.service';
import { EngineReleaseService, ENGINE_RELEASE_POST_NOT_IN_YEAR } from './engine-release.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const OTHER_YEAR = 'a0000000-0000-4000-8000-0000000000a0';
const ADMIN = 'd0000000-0000-4000-8000-0000000000ad';
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const P3 = '00000000-0000-4000-8000-000000000003';
const P_OTHER = '00000000-0000-4000-8000-0000000000f1';

const rows = (): Record<string, Row[]> => ({
  academicYear: [
    { id: YEAR, schoolId: SCHOOL, name: '2026/27', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), isActive: true },
    { id: OTHER_YEAR, schoolId: SCHOOL, name: '2025/26', startDate: new Date('2025-08-18'), endDate: new Date('2026-06-12'), isActive: false },
  ],
  teachingRequirement: [
    { id: P1, academicYearId: YEAR, subjectId: 's1', studentGroupId: 'g1', teacherId: null },
    { id: P2, academicYearId: YEAR, subjectId: 's2', studentGroupId: 'g1', teacherId: null },
    { id: P3, academicYearId: YEAR, subjectId: 's3', studentGroupId: 'g1', teacherId: null },
    { id: P_OTHER, academicYearId: OTHER_YEAR, subjectId: 's1', studentGroupId: 'g0', teacherId: null },
  ],
  teachingRequirementRelease: [],
  scheduleChangeLog: [],
});

function setup(initial: Record<string, Row[]> = rows()) {
  const world: RolloverWorld = givenRolloverWorld(initial);
  // The year's lock is a raw statement; the world answers any it is not told about.
  const prisma = prismaFor(world);
  const service = new EngineReleaseService(prisma as unknown as PrismaService);
  return { world, service };
}

const admin = () => testUser({ schoolId: SCHOOL, userId: ADMIN });
const releasesOf = (world: RolloverWorld) => (world.rows['teachingRequirementRelease'] ?? []).map((row) => row['requirementId']);
const logs = (world: RolloverWorld) => world.rows['scheduleChangeLog'] ?? [];

describe('EngineReleaseService (släppt för motorn)', () => {
  describe('set', () => {
    it('releases the posts, signed by the administrator who asked, and writes one log row with the ids', async () => {
      const { world, service } = setup();
      const result = await service.set({ academicYearId: YEAR, requirementIds: [P2, P1], released: true }, admin());
      expect(result).toEqual({ changed: 2, unchanged: 0 });
      expect(releasesOf(world).sort()).toEqual([P1, P2]);
      expect(world.rows['teachingRequirementRelease']![0]).toMatchObject({ schoolId: SCHOOL, releasedById: ADMIN });
      expect(logs(world)).toHaveLength(1);
      expect(logs(world)[0]).toMatchObject({
        action: 'UPDATE',
        masterLessonId: null,
        actorId: ADMIN,
        before: { kind: 'ENGINE_RELEASE', released: false, requirementIds: [P1, P2] },
        after: { kind: 'ENGINE_RELEASE', released: true, requirementIds: [P1, P2] },
      });
    });

    it('is a no-op for a post already released: the first person and time are kept, and nothing is logged', async () => {
      const first = { requirementId: P1, schoolId: SCHOOL, releasedById: 'first-admin', releasedAt: new Date('2026-01-01T00:00:00Z') };
      const initial = rows();
      initial['teachingRequirementRelease'] = [first];
      const { world, service } = setup(initial);
      const result = await service.set({ academicYearId: YEAR, requirementIds: [P1], released: true }, admin());
      expect(result).toEqual({ changed: 0, unchanged: 1 });
      expect(world.rows['teachingRequirementRelease']).toEqual([first]);
      expect(logs(world)).toHaveLength(0);
    });

    it('writes only the posts that are not released yet, and says how many were', async () => {
      const initial = rows();
      initial['teachingRequirementRelease'] = [{ requirementId: P1, schoolId: SCHOOL, releasedById: 'first-admin', releasedAt: new Date() }];
      const { world, service } = setup(initial);
      const result = await service.set({ academicYearId: YEAR, requirementIds: [P1, P2, P3], released: true }, admin());
      expect(result).toEqual({ changed: 2, unchanged: 1 });
      expect(releasesOf(world).sort()).toEqual([P1, P2, P3]);
      expect(world.rows['teachingRequirementRelease']!.find((row) => row['requirementId'] === P1)).toMatchObject({ releasedById: 'first-admin' });
      expect(logs(world)[0]).toMatchObject({ after: { requirementIds: [P2, P3] } });
    });

    it('takes a release back, for those that are released, and logs the ids it took back', async () => {
      const initial = rows();
      initial['teachingRequirementRelease'] = [P1, P2].map((requirementId) => ({ requirementId, schoolId: SCHOOL, releasedById: ADMIN, releasedAt: new Date() }));
      const { world, service } = setup(initial);
      const result = await service.set({ academicYearId: YEAR, requirementIds: [P2, P3], released: false }, admin());
      expect(result).toEqual({ changed: 1, unchanged: 1 });
      expect(releasesOf(world)).toEqual([P1]);
      expect(logs(world)[0]).toMatchObject({
        before: { kind: 'ENGINE_RELEASE', released: true, requirementIds: [P2] },
        after: { kind: 'ENGINE_RELEASE', released: false, requirementIds: [P2] },
      });
    });

    it('treats a post named twice as one', async () => {
      const { world, service } = setup();
      const result = await service.set({ academicYearId: YEAR, requirementIds: [P1, P1], released: true }, admin());
      expect(result).toEqual({ changed: 1, unchanged: 0 });
      expect(releasesOf(world)).toEqual([P1]);
    });

    it('400s a post of another year with its own code and a flat count, writing nothing', async () => {
      const { world, service } = setup();
      let thrown: unknown;
      try {
        await service.set({ academicYearId: YEAR, requirementIds: [P1, P_OTHER], released: true }, admin());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({ code: ENGINE_RELEASE_POST_NOT_IN_YEAR, params: { count: 1 } });
      expect(releasesOf(world)).toEqual([]);
      expect(logs(world)).toHaveLength(0);
    });

    it('404s a year RLS hides, before it looks at a post', async () => {
      const { service } = setup();
      await expect(
        service.set({ academicYearId: 'a0000000-0000-4000-8000-0000000000ff', requirementIds: [P1], released: true }, admin()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('takes the year’s staffing lock first, so a release and an apply of one year queue', async () => {
      const { world, service } = setup();
      await service.set({ academicYearId: YEAR, requirementIds: [P1], released: true }, admin());
      const statements = (world.calls ?? []).map((call: unknown) => JSON.stringify(call));
      expect(statements.some((text: string) => text.includes('pg_advisory_xact_lock'))).toBe(true);
    });
  });

  describe('list', () => {
    it('lists the year’s released posts with who and when, in post order (the year filter is the database’s: the adapter probe asks it)', async () => {
      const initial = rows();
      initial['teachingRequirementRelease'] = [
        { requirementId: P2, schoolId: SCHOOL, releasedById: ADMIN, releasedAt: new Date('2026-11-19T08:00:00.000Z') },
        { requirementId: P1, schoolId: SCHOOL, releasedById: null, releasedAt: new Date('2026-11-18T08:00:00.000Z') },
      ];
      const { service } = setup(initial);
      await expect(service.list(YEAR, admin())).resolves.toEqual({
        releases: [
          { requirementId: P1, releasedAt: '2026-11-18T08:00:00.000Z', releasedById: null },
          { requirementId: P2, releasedAt: '2026-11-19T08:00:00.000Z', releasedById: ADMIN },
        ],
      });
    });

    it('404s a year RLS hides', async () => {
      const { service } = setup();
      await expect(service.list('a0000000-0000-4000-8000-0000000000ff', admin())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
