import { Prisma } from '@prisma/client';
import request from 'supertest';
import { rawSql } from './utils/locking-read';
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
    expect(response.body.detail).toBe(
      'Schemaläggare ändrar inte personal. Personal ändras av rektor, en fullständig administratör eller expeditionen.',
    );
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
    for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
      await request(http()).get('/api/v1/room-types').set('x-test-user', as(profile)).expect(200);
    }
  });

  it('refuses the läsare every write by name, saying it changes nothing and who does (Läsbehörighet)', async () => {
    const room = await request(http()).post('/api/v1/rooms').set('x-test-user', as('LASARE', true)).send({ name: 'Sal 1' }).expect(403);
    expect(room.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    expect(room.body.detail).toBe(
      'Läsare ändrar inte planering: profilen läser men ändrar ingenting. Planering ändras av rektor, en fullständig administratör eller en schemaläggare.',
    );
    const person = await request(http())
      .post('/api/v1/users')
      .set('x-test-user', as('LASARE'))
      .send({ role: 'TEACHER', firstName: 'Ny', lastName: 'Lärare', email: 'ny@skola.se' })
      .expect(403);
    expect(person.body.detail).toMatch(/^Läsare ändrar inte personal/);
    expect(harness.tx['room']!['create']).not.toHaveBeenCalled();
    expect(harness.tx['user']!['create']).not.toHaveBeenCalled();
  });

  it("lets the läsare reach the activation preview, a read by POST that /admin/years shows (Läsbehörighet)", async () => {
    // Past the guard to the handler, which finds no year here: 404, not 403.
    await request(http())
      .post(`/api/v1/academic-years/${YEAR_ID}/activation/preview`)
      .set('x-test-user', as('LASARE'))
      .expect(404);
    // The activation itself stays planering's.
    await request(http())
      .post(`/api/v1/academic-years/${YEAR_ID}/activation`)
      .set('x-test-user', as('LASARE'))
      .send({ planHash: 'x'.repeat(64) })
      .expect(403);
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

  it("lets every profile read the marks of a protected identity, Personal's writers set one, and only those who decide remove one (skyddad identitet)", async () => {
    harness.tx['personProtection']!['findMany']!.mockResolvedValue([{ userId: USER_ID, source: 'MANUAL' }]);
    harness.tx['user']!['findFirst']!.mockResolvedValue({ id: USER_ID });
    for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
      const read = await request(http()).get('/api/v1/person-protections').set('x-test-user', as(profile)).expect(200);
      expect(read.body).toEqual([{ userId: USER_ID, source: 'MANUAL' }]);
      await request(http()).get(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', as(profile)).expect(200);
    }

    for (const profile of ['FULL', 'REKTOR', 'EXPEDITION']) {
      await request(http()).put(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', as(profile)).expect(200);
    }
    expect(harness.tx['personProtection']!['createMany']).toHaveBeenCalledTimes(3);
    for (const profile of ['SCHEMALAGGARE', 'LASARE']) {
      const set = await request(http()).put(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', as(profile)).expect(403);
      expect(set.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    }
    expect(harness.tx['personProtection']!['createMany']).toHaveBeenCalledTimes(3);

    // Lifting a protection is a decision: rektor and full, not the expedition.
    for (const profile of ['FULL', 'REKTOR']) {
      await request(http()).delete(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', as(profile)).expect(200);
    }
    for (const profile of ['EXPEDITION', 'SCHEMALAGGARE', 'LASARE']) {
      const removed = await request(http()).delete(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', as(profile)).expect(403);
      expect(removed.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
    }
    expect(harness.tx['personProtection']!['deleteMany']).toHaveBeenCalledTimes(2);
  });

  it("refuses a teacher, a pupil and a guardian the marks altogether (skyddad identitet)", async () => {
    for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
      await request(http()).get('/api/v1/person-protections').set('x-test-user', asUser({ role } as never)).expect(403);
      await request(http()).put(`/api/v1/person-protections/${USER_ID}`).set('x-test-user', asUser({ role } as never)).expect(403);
    }
    expect(harness.tx['personProtection']!['findMany']).not.toHaveBeenCalled();
  });

  it("refuses the planner the pupils' bulk routes and the expedition the groups', by area, and lets the profile that owns each through (Massåtgärder)", async () => {
    const pupils = ['/api/v1/users/students/bulk-delete', '/api/v1/users/students/bulk-update'];
    const groups = ['/api/v1/student-groups/bulk-delete', '/api/v1/student-groups/bulk-update'];
    // The delete takes no changes (an unknown field is a 400), the update needs them.
    const bodyOf = (path: string) =>
      path.endsWith('bulk-delete')
        ? { ids: [USER_ID], dryRun: true }
        : { ids: [USER_ID], changes: path.includes('/users/') ? { isActive: false } : { gradeLevel: 7 }, dryRun: true };

    // Dry runs too: they do the write and roll it back, so the profile that
    // may not write may not ask in this way either.
    for (const path of pupils) {
      const refused = await request(http()).post(path).set('x-test-user', as('SCHEMALAGGARE')).send(bodyOf(path)).expect(403);
      expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(refused.body.detail).toBe(
        'Schemaläggare ändrar inte personal. Personal ändras av rektor, en fullständig administratör eller expeditionen.',
      );
    }
    for (const path of groups) {
      const refused = await request(http()).post(path).set('x-test-user', as('EXPEDITION')).send(bodyOf(path)).expect(403);
      expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(refused.body.detail).toMatch(/^Expedition ändrar inte planering\. Planering ändras av rektor/);
    }
    // Refused before anything is read or written.
    expect(harness.prisma.withRls).not.toHaveBeenCalled();
    expect(harness.tx['user']!['updateMany']).not.toHaveBeenCalled();
    expect(harness.tx['studentGroup']!['updateMany']).not.toHaveBeenCalled();

    // The owner of each area reaches the handler: rows that are not there are a 200 report.
    Object.assign(harness.tx, { $queryRaw: jest.fn().mockResolvedValue([]) });
    try {
      for (const path of pupils) {
        const reported = await request(http()).post(path).set('x-test-user', as('EXPEDITION')).send(bodyOf(path)).expect(200);
        expect(reported.body).toMatchObject({ applied: false, dryRun: true, refused: [{ id: USER_ID, code: 'BULK_ROW_NOT_FOUND' }] });
      }
    } finally {
      delete (harness.tx as Record<string, unknown>)['$queryRaw'];
    }
    for (const path of groups) {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValueOnce([]);
      const reported = await request(http()).post(path).set('x-test-user', as('SCHEMALAGGARE')).send(bodyOf(path)).expect(200);
      expect(reported.body).toMatchObject({ applied: false, dryRun: true, refused: [{ id: USER_ID, code: 'BULK_ROW_NOT_FOUND' }] });
    }
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
      // Rektorns bedömning av lärarens omfattning (20270306090000) is a decision too: the same profiles, the same refusal, nothing written.
      await request(http())
        .put(`/api/v1/scope-assessments/${USER_ID}?academicYearId=${YEAR_ID}`)
        .set('x-test-user', as(profile, true))
        .send({ teachingLevelHours: 600 })
        .expect(403);
      await request(http())
        .delete(`/api/v1/scope-assessments/${USER_ID}?academicYearId=${YEAR_ID}`)
        .set('x-test-user', as(profile, true))
        .expect(403);
    }
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).not.toHaveBeenCalled();
    expect(harness.tx['assignmentScopeAssessment']!['delete']).not.toHaveBeenCalled();
  });

  it("hands the rektor's assessments back masked to a planner without HR-läs (and to the huvudman's reader), whole to one with it, and a planner's own row whole", async () => {
    // The table's arms let every administrator read every row of the school, the huvudman's reader included, and a row cannot hide a
    // column: what is about the person (the level, the day, the note, who decided and when) is the gateway's to leave out (hr-visibility).
    const row = {
      id: 'a1', schoolId: '33333333-3333-4333-8333-333333333333', userId: USER_ID, academicYearId: YEAR_ID,
      teachingLevelHours: 560, exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: new Date('2099-05-02T00:00:00Z'), note: 'skäl',
      decidedById: '77777777-7777-4777-8777-777777777777', decidedAt: new Date('2099-05-03T08:00:00Z'),
      createdAt: new Date('2099-05-03T08:00:00Z'), updatedAt: new Date('2099-05-03T08:00:00Z'),
    };
    harness.tx['assignmentScopeAssessment']!['findMany']!.mockResolvedValue([row]);
    const list = (header: string) =>
      request(http()).get(`/api/v1/scope-assessments?academicYearId=${YEAR_ID}`).set('x-test-user', header).expect(200);

    for (const profile of ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
      const hidden = await list(as(profile));
      expect(hidden.body[0]).toMatchObject({
        userId: USER_ID, teachingLevelHours: null, ownInitiativeOn: null, note: null, decidedById: null, decidedAt: null, hrHidden: true,
        exceptionKind: 'OWN_INITIATIVE',
      });
      const shown = await list(as(profile, true));
      expect(shown.body[0]).toMatchObject({ teachingLevelHours: 560, ownInitiativeOn: '2099-05-02', note: 'skäl', hrHidden: false });
    }
    for (const profile of ['REKTOR', 'FULL']) {
      expect((await list(as(profile))).body[0]).toMatchObject({ teachingLevelHours: 560, note: 'skäl', hrHidden: false });
    }
    // A planner without HR-läs who is the person: their own row is theirs.
    const own = await list(asUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false, userId: USER_ID } as never));
    expect(own.body[0]).toMatchObject({ teachingLevelHours: 560, note: 'skäl', hrHidden: false });
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
    harness.tx['user']!['findMany']!.mockResolvedValue([{ id: USER_ID, adminProfile: 'REKTOR', hrRead: false, teaches: true }]);
    const response = await request(http())
      .get('/api/v1/users/administrators')
      .set('x-test-user', as('EXPEDITION'))
      .expect(200);
    // Whether they teach (Users.teaches) is as visible as the profile is: the role chooser reads both.
    expect(response.body).toEqual([{ id: USER_ID, adminProfile: 'REKTOR', hrRead: false, teaches: true }]);
  });

  it("answers a person's role history to any administrator", async () => {
    harness.tx['userRoleChange']!['findMany']!.mockResolvedValue([
      {
        id: 'c1', fromRole: 'TEACHER', toRole: 'SCHOOL_ADMIN', fromProfile: null, toProfile: 'SCHEMALAGGARE',
        fromHrRead: false, toHrRead: false, fromTeaches: null, toTeaches: false, actorId: null, createdAt: new Date('2026-10-25T08:00:00Z'),
      },
    ]);
    const response = await request(http())
      .get(`/api/v1/users/${USER_ID}/role-changes`)
      .set('x-test-user', as('EXPEDITION'))
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({ toProfile: 'SCHEMALAGGARE', fromTeaches: null, toTeaches: false, actorName: null, createdAt: '2026-10-25T08:00:00.000Z' }),
    ]);
    expect(harness.tx['userRoleChange']!['findMany']).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  // Administratör som lärare (Users.teaches): the mark is set with a PATCH, which only rektor or a full administrator
  // makes, and the refusals reach the client as themselves. A unit spec reads getResponse() and sees a nested value
  // that the filter drops; only a request through the real filter shows what a client gets (the code, flat params).
  describe('the mark that an administrator teaches, through PATCH /users/:id', () => {
    // The mark changes who is a mentor (app.leave_mentors), so a PATCH that changes it asks the database to tell the mentors of the
    // requests they have not been told of (PR 4): that statement answers nothing, and every other raw statement the stored row.
    const stored = (overrides: Record<string, unknown> = {}) =>
      harness.tx.$queryRaw.mockImplementation(async (...call: unknown[]) =>
        rawSql(call).includes('app.leave_requests_tell_new_mentors()')
          ? []
          : [
              {
                role: 'SCHOOL_ADMIN', studentGroupId: null, pseudonymisedAt: null, adminProfile: 'SCHEMALAGGARE', hrRead: false,
                teaches: false, isActive: true, schoolId: '33333333-3333-4333-8333-333333333333', ...overrides,
              },
            ],
      );
    const patch = (principal: string, body: Record<string, unknown>) =>
      request(http()).patch(`/api/v1/users/${USER_ID}`).set('x-test-user', principal).send(body);

    // The harness's mocks outlive a test; what these set must not reach the next one.
    afterEach(() => {
      harness.tx.$queryRaw.mockResolvedValue([]);
      for (const [model, method] of [['user', 'update'], ['user', 'count'], ['teacherEmployment', 'delete'], ['academicYear', 'delete']] as const) {
        harness.tx[model]![method]!.mockReset();
      }
      harness.tx['user']!['findMany']!.mockResolvedValue([]);
    });

    it('is set by rektor with an UPDATE of the mark, and answers the row as stored', async () => {
      stored();
      harness.tx['user']!['update']!.mockResolvedValue({ id: USER_ID, role: 'SCHOOL_ADMIN', teaches: true });
      const response = await patch(as('REKTOR'), { teaches: true }).expect(200);
      expect(response.body).toMatchObject({ id: USER_ID, teaches: true });
      expect(harness.tx['user']!['update']).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { teaches: true } });
      // The mark is a mentor's coming (app.leave_mentors), so the requests waiting for a mentor nobody told are asked after the write.
      expect(harness.tx.$queryRaw.mock.calls.some((call) => rawSql(call).includes('app.leave_requests_tell_new_mentors()'))).toBe(true);
    });

    it('is refused to the expedition, which may edit people but does not decide: 403 with the decision’s code, nothing written', async () => {
      stored();
      const response = await patch(as('EXPEDITION'), { teaches: true }).expect(403);
      expect(response.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
      expect(harness.tx['user']!['update']).not.toHaveBeenCalled();
    });

    it('is refused on a teacher with 400 and its own code, which reaches the client', async () => {
      stored({ role: 'TEACHER', adminProfile: null });
      const response = await patch(as('REKTOR'), { teaches: true }).expect(400);
      expect(response.body).toMatchObject({ code: 'A_TEACHER_TEACHES_ALREADY' });
      expect(harness.tx['user']!['update']).not.toHaveBeenCalled();
    });

    it('answers a person with no post 409 TEACHES_NEEDS_A_POST with the person in flat params: the trigger’s refusal, as itself', async () => {
      stored();
      harness.tx['user']!['update']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Database error. Code: `TE409`.', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: { driverAdapterError: { cause: { originalCode: 'TE409', originalMessage: 'TEACHES_NEEDS_A_POST: x', detail: `userId=${USER_ID}` } } },
        }),
      );
      const response = await patch(as('FULL'), { teaches: true }).expect(409);
      expect(response.body).toMatchObject({ code: 'TEACHES_NEEDS_A_POST', params: { userId: USER_ID } });
    });

    it('answers a deadlock against the mark 409 WRITE_CONFLICT, which says to try again', async () => {
      stored();
      harness.tx['user']!['update']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: Prisma.prismaVersion.client }),
      );
      const response = await patch(as('FULL'), { teaches: true }).expect(409);
      expect(response.body).toMatchObject({ code: 'WRITE_CONFLICT' });
    });

    it('is no field of a creation: POST /users with teaches is a 400 from the validation pipe, and nothing is created', async () => {
      await request(http())
        .post('/api/v1/users')
        .set('x-test-user', as('REKTOR'))
        .send({ role: 'SCHOOL_ADMIN', firstName: 'Ola', lastName: 'Rektor', email: 'ola@skola.se', teaches: true })
        .expect(400);
      expect(harness.tx['user']!['create']).not.toHaveBeenCalled();
    });

    it('stops the removal of a marked person’s last post, and of the läsår that holds it, with the code and flat params', async () => {
      const refused = new Prisma.PrismaClientKnownRequestError('Database error. Code: `TE410`.', {
        code: 'P2039',
        clientVersion: Prisma.prismaVersion.client,
        meta: { driverAdapterError: { cause: { originalCode: 'TE410', originalMessage: 'A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS: x', detail: `userId=${USER_ID} academicYearId=${YEAR_ID}` } } },
      });
      harness.tx['teacherEmployment']!['delete']!.mockRejectedValue(refused);
      const post = await request(http()).delete(`/api/v1/teacher-employments/${USER_ID}?academicYearId=${YEAR_ID}`).set('x-test-user', as('REKTOR'));
      expect([post.status, post.body.code, post.body.params]).toEqual([409, 'A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS', { userId: USER_ID, academicYearId: YEAR_ID }]);

      harness.tx['user']!['count']!.mockResolvedValue(0);
      harness.tx['user']!['findMany']!.mockResolvedValue([{ id: USER_ID }]);
      const year = await request(http()).delete(`/api/v1/academic-years/${YEAR_ID}`).set('x-test-user', as('REKTOR')).expect(409);
      expect(year.body).toMatchObject({ code: 'A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS', params: { administrators: 1, userIds: USER_ID } });
      expect(harness.tx['academicYear']!['delete']).not.toHaveBeenCalled();
    });
  });

  it('hands the posts back without tjänst % to a planner without HR-läs, and with them to one with it', async () => {
    const post = {
      id: 'p1', schoolId: '33333333-3333-4333-8333-333333333333', userId: USER_ID, academicYearId: YEAR_ID,
      employmentPercent: new Prisma.Decimal('80.000'), reductionPercent: new Prisma.Decimal('20.000'),
      contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: 'KOL', note: 'skäl',
      // Deltid in days (20261123090000): HR data, like the tjänst % beside it.
      maxTeachingDaysPerWeek: 4,
      createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
    };
    harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([post]);

    const hidden = await request(http())
      .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE'))
      .expect(200);
    expect(hidden.body[0]).toMatchObject({
      employmentPercent: null, reductionPercent: null, note: null, maxTeachingDaysPerWeek: null, signature: 'KOL', hrHidden: true,
    });

    const shown = await request(http())
      .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE', true))
      .expect(200);
    expect(shown.body[0]).toMatchObject({ employmentPercent: 80, reductionPercent: 20, note: 'skäl', maxTeachingDaysPerWeek: 4 });
  });

  it("lets the planner set a teacher's daily cap and wished free day, and refuses the expedition before the table", async () => {
    /*
     * Lärarens dag (20261123090000) is planering's, on the work rule: not HR,
     * so a planner without HR-läs sets it, and the expedition, which does not
     * plan, is refused by the route's area before anything is read.
     */
    harness.tx['user']!['findUnique']!.mockResolvedValue({ role: 'TEACHER' });
    harness.tx['teacherWorkRule']!['upsert']!.mockResolvedValue({
      id: 'r1', schoolId: '33333333-3333-4333-8333-333333333333', userId: USER_ID,
      lunchMinutes: null, lunchStartTime: null, lunchEndTime: null, minDailyRestMinutes: null,
      maxTeachingMinutesPerDay: 240, preferredFreeDayOfWeek: 3,
      createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const planned = await request(http())
      .put(`/api/v1/teacher-work-rules/${USER_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE'))
      .send({ maxTeachingMinutesPerDay: 240, preferredFreeDayOfWeek: 3 })
      .expect(200);
    expect(planned.body).toMatchObject({ maxTeachingMinutesPerDay: 240, preferredFreeDayOfWeek: 3 });

    const refused = await request(http())
      .put(`/api/v1/teacher-work-rules/${USER_ID}`)
      .set('x-test-user', as('EXPEDITION', true))
      .send({ maxTeachingMinutesPerDay: 300 })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    expect(harness.tx['teacherWorkRule']!['upsert']).toHaveBeenCalledTimes(1);
  });

  it("lets rektor set a teacher's limit on teaching in a row on the post, and refuses the planner and a half pair before the table", async () => {
    /*
     * Sammanhängande undervisning (20261218090000) is HR data on the post,
     * written with it: the post's PUT is a decision (@Decides), so rektor and
     * a full administrator set the limit, and a planner does not, whether or
     * not they read HR. A limit with no break (or the other way round) is
     * refused as the 400 the pair CHECK would otherwise have been.
     */
    const post = {
      id: 'p1', schoolId: '33333333-3333-4333-8333-333333333333', userId: USER_ID, academicYearId: YEAR_ID,
      employmentPercent: new Prisma.Decimal('80.000'), reductionPercent: new Prisma.Decimal('0.000'),
      contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: 'KOL', note: null,
      maxTeachingDaysPerWeek: null, maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30,
      createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
      periods: [],
    };
    Object.assign(harness.tx, { $queryRaw: jest.fn().mockResolvedValue([{ role: 'TEACHER' }]) });
    harness.tx['teacherEmployment']!['upsert']!.mockResolvedValue(post);
    const url = `/api/v1/teacher-employments/${USER_ID}?academicYearId=${YEAR_ID}`;
    const body = { employmentPercent: 80, signature: 'KOL', maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 };

    const set = await request(http()).put(url).set('x-test-user', as('REKTOR')).send(body).expect(200);
    expect(set.body).toMatchObject({ maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 });
    expect(harness.tx['teacherEmployment']!['upsert']).toHaveBeenCalledTimes(1);

    const half = await request(http())
      .put(url)
      .set('x-test-user', as('REKTOR'))
      .send({ employmentPercent: 80, maxConsecutiveTeachingMinutes: 180 })
      .expect(400);
    expect(half.body).toMatchObject({ status: 400, detail: expect.stringContaining('en halv regel') });
    expect(harness.tx['teacherEmployment']!['upsert']).toHaveBeenCalledTimes(1);

    for (const planner of [as('SCHEMALAGGARE', true), as('EXPEDITION', true)]) {
      const refused = await request(http()).put(url).set('x-test-user', planner).send(body).expect(403);
      expect(refused.body).toMatchObject({ code: 'DECISION_NOT_YOURS' });
    }
    expect(harness.tx['teacherEmployment']!['upsert']).toHaveBeenCalledTimes(1);

    // The work rule, which every colleague reads, no longer carries the limit.
    const rule = await request(http())
      .put(`/api/v1/teacher-work-rules/${USER_ID}`)
      .set('x-test-user', as('SCHEMALAGGARE'))
      .send({ maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 });
    expect(rule.status).toBe(400);
    expect(harness.tx['teacherWorkRule']!['upsert']).not.toHaveBeenCalled();
  });
});
