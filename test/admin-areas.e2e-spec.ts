import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Roller i skolan, through the whole app: RolesGuard holds an
 * administrator's write to the route's areas, the users routes answer the
 * role history, and the posts come back without tjänst % for a profile that
 * does not read it. Each a request that reaches its handler (or is refused
 * just before it), not a 403 row the guard answers alone.
 */
describe('Administrator profiles and areas (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const YEAR_ID = '99999999-9999-4999-8999-999999999999';
  const as = (adminProfile: string, hrRead = false) => asUser({ adminProfile, hrRead } as never);

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses the planner the roster with a 403 that names the area, and writes nothing", async () => {
    const response = await request(http())
      .post('/api/v1/users')
      .set('x-test-user', as('SCHEMALAGGARE'))
      .send({ role: 'TEACHER', firstName: 'Ny', lastName: 'Lärare', email: 'ny@skola.se' })
      .expect(403);

    expect(response.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    expect(response.body.detail).toBe('Schemaläggare ändrar inte personal. Be rektor eller en administratör som har det området.');
    expect(harness.tx['user']!['create']).not.toHaveBeenCalled();
  });

  it("lets the expedition add a teacher, and refuses it an administrator in the service", async () => {
    harness.tx['user']!['create']!.mockResolvedValue({ id: USER_ID });
    await request(http())
      .post('/api/v1/users')
      .set('x-test-user', as('EXPEDITION'))
      .send({ role: 'TEACHER', firstName: 'Ny', lastName: 'Lärare', email: 'ny@skola.se' })
      .expect(201);
    expect(harness.tx['user']!['create']).toHaveBeenCalledTimes(1);

    const refused = await request(http())
      .post('/api/v1/users')
      .set('x-test-user', as('EXPEDITION'))
      .send({ role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Ny', lastName: 'Admin', email: 'admin@skola.se' })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
    expect(harness.tx['user']!['create']).toHaveBeenCalledTimes(1);
  });

  it('lets every profile read what it does not write', async () => {
    for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
      await request(http()).get('/api/v1/room-types').set('x-test-user', as(profile)).expect(200);
    }
  });

  it("refuses the expedition the planner's rooms and the planner the expedition's guardian links", async () => {
    await request(http())
      .post('/api/v1/rooms')
      .set('x-test-user', as('EXPEDITION'))
      .send({ name: 'Sal 1' })
      .expect(403);
    await request(http())
      .post('/api/v1/guardian-links')
      .set('x-test-user', as('SCHEMALAGGARE'))
      .send({ guardianId: USER_ID, studentId: USER_ID })
      .expect(403);
    expect(harness.tx['room']!['create']).not.toHaveBeenCalled();
  });

  it('leaves a decision to rektor: the dataskydd decision and a post', async () => {
    for (const profile of ['SCHEMALAGGARE', 'EXPEDITION']) {
      const decision = await request(http())
        .post('/api/v1/retention/decisions')
        .set('x-test-user', as(profile, true))
        .send({ dataType: 'NOTIFICATIONS', decision: 'KEEP' })
        .expect(403);
      expect(decision.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
      await request(http())
        .put(`/api/v1/teacher-employments/${USER_ID}?academicYearId=${YEAR_ID}`)
        .set('x-test-user', as(profile, true))
        .send({ employmentPercent: 80 })
        .expect(403);
    }
  });

  it("leaves sharing the pupils' attendance with integrations to rektor, and lets every profile read it", async () => {
    for (const profile of ['SCHEMALAGGARE', 'EXPEDITION']) {
      const refused = await request(http())
        .post('/api/v1/integrations/attendance-sharing')
        .set('x-test-user', as(profile))
        .send({ shares: true, reference: 'Dnr 2026:12' })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
      await request(http()).get('/api/v1/integrations/attendance-sharing').set('x-test-user', as(profile)).expect(200);
    }
    expect(harness.tx['attendanceSharingDecision']!['create']).not.toHaveBeenCalled();

    harness.tx['attendanceSharingDecision']!['create']!.mockResolvedValue({
      shares: true,
      reference: 'Dnr 2026:12',
      decidedAt: new Date('2026-11-14T08:00:00Z'),
      decidedById: USER_ID,
    });
    const decided = await request(http())
      .post('/api/v1/integrations/attendance-sharing')
      .set('x-test-user', as('REKTOR'))
      .send({ shares: true, reference: 'Dnr 2026:12' })
      .expect(201);
    expect(decided.body).toMatchObject({ shares: true, reference: 'Dnr 2026:12' });
    expect(harness.tx['attendanceSharingDecision']!['create']).toHaveBeenCalledTimes(1);
  });

  it("answers the school's administrators to the expedition, who may not change them", async () => {
    harness.tx['user']!['findMany']!.mockResolvedValue([{ id: USER_ID, adminProfile: 'REKTOR', hrRead: false }]);
    const response = await request(http())
      .get('/api/v1/users/administrators')
      .set('x-test-user', as('EXPEDITION'))
      .expect(200);
    expect(response.body).toEqual([{ id: USER_ID, adminProfile: 'REKTOR', hrRead: false }]);
  });

  it("answers a person's role history to any administrator", async () => {
    harness.tx['userRoleChange']!['findMany']!.mockResolvedValue([
      {
        id: 'c1', fromRole: 'TEACHER', toRole: 'SCHOOL_ADMIN', fromProfile: null, toProfile: 'SCHEMALAGGARE',
        fromHrRead: false, toHrRead: false, actorId: null, createdAt: new Date('2026-10-25T08:00:00Z'),
      },
    ]);
    const response = await request(http())
      .get(`/api/v1/users/${USER_ID}/role-changes`)
      .set('x-test-user', as('EXPEDITION'))
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({ toProfile: 'SCHEMALAGGARE', actorName: null, createdAt: '2026-10-25T08:00:00.000Z' }),
    ]);
    expect(harness.tx['userRoleChange']!['findMany']).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it('hands the posts back without tjänst % to a planner without HR-läs, and with them to one with it', async () => {
    const post = {
      id: 'p1', schoolId: '33333333-3333-4333-8333-333333333333', userId: USER_ID, academicYearId: YEAR_ID,
      employmentPercent: new Prisma.Decimal('80.000'), reductionPercent: new Prisma.Decimal('20.000'),
      contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: 'KOL', note: 'skäl',
      createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
    };
    harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([post]);

    const hidden = await request(http())
      .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE'))
      .expect(200);
    expect(hidden.body[0]).toMatchObject({
      employmentPercent: null, reductionPercent: null, note: null, signature: 'KOL', hrHidden: true,
    });

    const shown = await request(http())
      .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE', true))
      .expect(200);
    expect(shown.body[0]).toMatchObject({ employmentPercent: 80, reductionPercent: 20, note: 'skäl' });
  });
});
