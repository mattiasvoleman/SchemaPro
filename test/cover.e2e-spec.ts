import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Vikarieplanering over HTTP: the routes resolve, the DTOs take what the
 * board sends and refuse what they must not (no free text anywhere), every
 * admin route refuses a teacher, a pupil and a guardian, a teacher reaches
 * their own absence only when the school allows it, and no response or
 * notice the round-trips write carries an absence's reason.
 *
 * The database is mocked, as in every e2e spec; what the rows do under RLS
 * is section 28 of scripts/test/rls-policies.sql, and the services'
 * transactions against Postgres are the adapter probe's (æ1–æ12).
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TEACHER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const SUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LESSON = '44444444-4444-4444-8444-444444444444';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const REASON = '88888888-8888-4888-8888-888888888888';

const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const FUTURE = isoDay(3);
const at = (date: string, hour: number) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);

const admin = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID });
const teacher = () => asUser({ role: 'TEACHER' as never, userId: TEACHER_ID });
const student = () => asUser({ role: 'STUDENT' as never, userId: OTHER_ID });
const guardian = () => asUser({ role: 'GUARDIAN' as never, userId: OTHER_ID });

describe('Vikarieplanering (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  const lessonRow = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON,
    schoolId: SCHOOL,
    status: 'SCHEDULED',
    cancelCause: null,
    note: null,
    date: new Date(`${FUTURE}T00:00:00.000Z`),
    startsAt: at(FUTURE, 8),
    endsAt: at(FUTURE, 9),
    roomId: null,
    subjectId: 'subj',
    studentGroupId: 'grp',
    subject: { name: 'Matematik' },
    teachers: [{ teacherId: TEACHER_ID, role: 'LEAD' }],
    extraGroups: [],
    participants: [],
    ...overrides,
  });

  beforeEach(() => {
    const { tx } = harness;
    jest.clearAllMocks();
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.teacherAbsence.findUnique.mockResolvedValue({
      id: ABSENCE,
      userId: TEACHER_ID,
      startsAt: at(FUTURE, 0),
      endsAt: at(isoDay(4), 0),
      status: 'ACTIVE',
      wholeDays: true,
      reasonId: REASON,
      createdByUserId: ADMIN_ID,
      createdAt: new Date(),
    });
    tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    tx.calendarLesson.update.mockResolvedValue({ id: LESSON, status: 'SCHEDULED', note: null });
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: LESSON, startsAt: at(FUTURE, 8), studentGroupId: 'grp', roomId: null, subjectId: 'subj' },
    ]);
    tx.teacherAbsenceCover.findMany.mockResolvedValue([]);
    tx.teacherAbsence.findMany.mockResolvedValue([]);
    tx.teacherAbsence.findFirst.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ id: SUB_ID, role: 'TEACHER', isActive: true });
    tx.user.findMany.mockResolvedValue([]);
    tx.coverSettings.findUnique.mockResolvedValue(null);
    tx.notification.createMany.mockResolvedValue({ count: 1 });
    tx.$queryRaw.mockResolvedValue([]);
  });

  describe('who reaches what', () => {
    const adminOnly: Array<[string, string, Record<string, unknown>?]> = [
      ['get', `/api/v1/cover/board?from=${FUTURE}&to=${FUTURE}`],
      ['get', `/api/v1/cover/lessons/${LESSON}/candidates`],
      ['post', `/api/v1/cover/lessons/${LESSON}/decision`, { absenceId: ABSENCE, kind: 'CANCELLED', expected: 'OPEN' }],
      ['delete', `/api/v1/cover/lessons/${LESSON}/decision?absenceId=${ABSENCE}`],
      ['post', '/api/v1/cover/bulk', { action: 'UNDO', items: [{ lessonId: LESSON, absenceId: ABSENCE, expected: 'COVERED' }] }],
      ['post', `/api/v1/cover/days/${FUTURE}/proposal`, {}],
      ['post', `/api/v1/cover/days/${FUTURE}/apply`, { basis: 'a'.repeat(64), items: [{ lessonId: LESSON, absenceId: ABSENCE, userId: SUB_ID }] }],
      ['get', `/api/v1/cover/counter?date=${FUTURE}`],
      ['get', `/api/v1/cover/hours?from=${isoDay(-30)}&to=${isoDay(0)}`],
      ['put', '/api/v1/cover/settings', { poolPreference: 'NEUTRAL', teacherSelfReport: true }],
      ['get', '/api/v1/cover/pool'],
      ['post', '/api/v1/cover/pool', { userId: SUB_ID }],
      ['delete', `/api/v1/cover/pool/${SUB_ID}`],
      ['patch', `/api/v1/teacher-absences/${ABSENCE}`, { to: FUTURE }],
      ['post', '/api/v1/teacher-absence-reasons', { label: 'Egen' }],
      ['patch', `/api/v1/teacher-absence-reasons/${REASON}`, { archived: true }],
    ];
    const staff: Array<[string, string, Record<string, unknown>?]> = [
      ['get', '/api/v1/teacher-absences'],
      ['post', '/api/v1/teacher-absences', { userId: TEACHER_ID, from: FUTURE, to: FUTURE }],
      ['post', `/api/v1/teacher-absences/${ABSENCE}/end`, { at: at(FUTURE, 12).toISOString() }],
      ['post', `/api/v1/teacher-absences/${ABSENCE}/withdraw`, {}],
      ['get', '/api/v1/teacher-absence-reasons'],
      ['get', '/api/v1/cover/settings'],
      ['get', '/api/v1/cover/availability'],
      ['post', '/api/v1/cover/availability', { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      ['delete', `/api/v1/cover/availability/${REASON}`],
    ];
    // Three arguments always: a row of two would make jest read the test's
    // third parameter as a done() callback and wait for it.
    const rows = (list: Array<[string, string, Record<string, unknown>?]>) => list.map(([m, u, b]) => [m, u, b ?? null] as const);
    const send = (method: string, url: string, who: string, body?: Record<string, unknown> | null) => {
      const call = (request(http()) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-test-user', who);
      return body ? call.send(body) : call;
    };

    it.each(rows(adminOnly))('%s %s refuses a teacher, a pupil and a guardian', async (method, url, body) => {
      for (const who of [teacher(), student(), guardian()]) {
        await send(method, url, who, body).expect(403);
      }
    });

    it.each(rows(staff))('%s %s refuses a pupil and a guardian', async (method, url, body) => {
      for (const who of [student(), guardian()]) {
        await send(method, url, who, body).expect(403);
      }
    });

    it('a teacher registers their own absence only when the school allows it, and never somebody else’s', async () => {
      const own = { userId: TEACHER_ID, from: isoDay(0), to: isoDay(0) };
      harness.tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: false });
      const off = await send('post', '/api/v1/teacher-absences', teacher(), own).expect(403);
      expect(off.body.code).toBe('ABSENCE_SELF_REPORT_OFF');
      const other = await send('post', '/api/v1/teacher-absences', teacher(), { ...own, userId: OTHER_ID }).expect(403);
      expect(other.body.code).toBe('ABSENCE_NOT_YOURS');

      harness.tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: true });
      harness.tx.user.findUnique.mockResolvedValue({ id: TEACHER_ID, role: 'TEACHER', isActive: true });
      harness.tx.user.findMany.mockResolvedValue([{ id: ADMIN_ID }]);
      harness.tx.teacherAbsence.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: ABSENCE, status: 'ACTIVE', createdAt: new Date(), ...data }),
      );
      await send('post', '/api/v1/teacher-absences', teacher(), own).expect(201);
      // The admins are told the period, never the reason.
      const notice = harness.tx.notification.createMany.mock.calls.at(-1)![0] as { data: { type: string; meta: object }[] };
      expect(notice.data[0]).toMatchObject({ type: 'TEACHER_ABSENCE_REPORTED' });
      expect(Object.keys(notice.data[0]!.meta).sort()).toEqual(['absenceId', 'endsAt', 'startsAt']);
    });
  });

  describe('the DTOs', () => {
    it('refuse free text: a note on a decision, a reason or a note on an absence', async () => {
      await request(http())
        .post(`/api/v1/cover/lessons/${LESSON}/decision`)
        .set('x-test-user', admin())
        .send({ absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: SUB_ID, expected: 'OPEN', note: 'Sjuk' })
        .expect(400);
      for (const extra of [{ reason: 'migrän' }, { note: 'migrän' }]) {
        await request(http())
          .post('/api/v1/teacher-absences')
          .set('x-test-user', admin())
          .send({ userId: TEACHER_ID, from: FUTURE, to: FUTURE, ...extra })
          .expect(400);
      }
      // There is no userId to change on an edit.
      await request(http())
        .patch(`/api/v1/teacher-absences/${ABSENCE}`)
        .set('x-test-user', admin())
        .send({ userId: OTHER_ID })
        .expect(400);
      expect(harness.tx.teacherAbsence.update).not.toHaveBeenCalled();
    });

    it('refuse an unknown kind, a bulk over 200, a board window over seven days and an hour range over 93', async () => {
      await request(http())
        .post(`/api/v1/cover/lessons/${LESSON}/decision`)
        .set('x-test-user', admin())
        .send({ absenceId: ABSENCE, kind: 'SICK', expected: 'OPEN' })
        .expect(400);
      await request(http())
        .post('/api/v1/cover/bulk')
        .set('x-test-user', admin())
        .send({ action: 'CANCELLED', items: Array.from({ length: 201 }, () => ({ lessonId: LESSON, absenceId: ABSENCE, expected: 'OPEN' })) })
        .expect(400);
      const board = await request(http())
        .get(`/api/v1/cover/board?from=${FUTURE}&to=${isoDay(11)}`)
        .set('x-test-user', admin())
        .expect(400);
      expect(board.body.code).toBe('COVER_RANGE');
      await request(http()).get(`/api/v1/cover/hours?from=${isoDay(-100)}&to=${isoDay(0)}`).set('x-test-user', admin()).expect(400);
      await request(http()).post('/api/v1/cover/days/not-a-day/proposal').set('x-test-user', admin()).send({}).expect(400);
    });
  });

  describe('an admin round-trip', () => {
    it('registers, lists, ends and withdraws an absence; the list carries the reason, to the admin', async () => {
      harness.tx.user.findUnique.mockResolvedValue({ id: TEACHER_ID, role: 'TEACHER', isActive: true });
      harness.tx.teacherAbsenceReason.findUnique.mockResolvedValue({ archivedAt: null });
      harness.tx.teacherAbsence.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: ABSENCE, status: 'ACTIVE', createdAt: new Date(), ...data }),
      );
      const created = await request(http())
        .post('/api/v1/teacher-absences')
        .set('x-test-user', admin())
        .send({ userId: TEACHER_ID, from: FUTURE, to: FUTURE, reasonId: REASON })
        .expect(201);
      expect(created.body).toMatchObject({ id: ABSENCE, reasonId: REASON, wholeDays: true, phase: 'PLANNED' });

      harness.tx.teacherAbsence.findMany.mockResolvedValue([
        { id: ABSENCE, userId: TEACHER_ID, startsAt: at(FUTURE, 0), endsAt: at(isoDay(4), 0), wholeDays: true, reasonId: REASON, status: 'ACTIVE', createdByUserId: ADMIN_ID, createdAt: new Date() },
      ]);
      const listed = await request(http()).get('/api/v1/teacher-absences').set('x-test-user', admin()).expect(200);
      expect(listed.body[0]).toMatchObject({ id: ABSENCE, reasonId: REASON });

      harness.tx.teacherAbsence.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: ABSENCE, userId: TEACHER_ID, startsAt: at(FUTURE, 0), endsAt: at(isoDay(4), 0), wholeDays: true, reasonId: REASON, status: 'ACTIVE', createdByUserId: ADMIN_ID, createdAt: new Date(), ...data }),
      );
      await request(http())
        .post(`/api/v1/teacher-absences/${ABSENCE}/end`)
        .set('x-test-user', admin())
        .send({ at: at(FUTURE, 12).toISOString() })
        .expect(200);
      const withdrawn = await request(http())
        .post(`/api/v1/teacher-absences/${ABSENCE}/withdraw`)
        .set('x-test-user', admin())
        .send({})
        .expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
    });

    it('reasons, settings, the pool and a window', async () => {
      harness.tx.teacherAbsenceReason.findMany.mockResolvedValue([{ id: REASON, builtin: 'SICK', label: null, sortOrder: 0, archivedAt: null }]);
      const reasons = await request(http()).get('/api/v1/teacher-absence-reasons').set('x-test-user', admin()).expect(200);
      expect(reasons.body).toEqual([{ id: REASON, builtin: 'SICK', label: null, sortOrder: 0, archived: false }]);
      harness.tx.teacherAbsenceReason.create.mockResolvedValue({ id: 'r2', builtin: null, label: 'Egen', sortOrder: 500, archivedAt: null });
      await request(http()).post('/api/v1/teacher-absence-reasons').set('x-test-user', admin()).send({ label: 'Egen' }).expect(201);
      harness.tx.coverSettings.upsert.mockResolvedValue({ poolPreference: 'LAST_RESORT', teacherSelfReport: false });
      await request(http())
        .put('/api/v1/cover/settings')
        .set('x-test-user', admin())
        .send({ poolPreference: 'LAST_RESORT', teacherSelfReport: false })
        .expect(200);
      const settings = await request(http()).get('/api/v1/cover/settings').set('x-test-user', teacher()).expect(200);
      expect(settings.body).toEqual({ poolPreference: 'NEUTRAL', teacherSelfReport: false });
      await request(http()).post('/api/v1/cover/pool').set('x-test-user', admin()).send({ userId: SUB_ID }).expect(201);
      harness.tx.substitutePoolMember.deleteMany.mockResolvedValue({ count: 1 });
      await request(http()).delete(`/api/v1/cover/pool/${SUB_ID}`).set('x-test-user', admin()).expect(204);
      harness.tx.substituteAvailability.create.mockResolvedValue({
        id: 'w1',
        userId: TEACHER_ID,
        date: null,
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T08:00:00Z'),
        endTime: new Date('1970-01-01T12:00:00Z'),
      });
      const window = await request(http())
        .post('/api/v1/cover/availability')
        .set('x-test-user', teacher())
        .send({ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' })
        .expect(201);
      expect(window.body).toMatchObject({ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' });
      const notYours = await request(http())
        .post('/api/v1/cover/availability')
        .set('x-test-user', teacher())
        .send({ userId: OTHER_ID, dayOfWeek: 1, startTime: '08:00', endTime: '12:00' })
        .expect(403);
      expect(notYours.body.code).toBe('AVAILABILITY_NOT_YOURS');
    });

    it('decides a substitute, then undoes it — the withdrawn substitute’s notice carries the lesson only', async () => {
      const decided = await request(http())
        .post(`/api/v1/cover/lessons/${LESSON}/decision`)
        .set('x-test-user', admin())
        .send({ absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: SUB_ID, expected: 'OPEN' })
        .expect(200);
      expect(decided.body).toMatchObject({ lessonId: LESSON, absenceId: ABSENCE, warnings: [] });
      expect(harness.tx.teacherAbsenceCover.create).toHaveBeenCalled();

      harness.tx.calendarLesson.findUnique.mockResolvedValue(lessonRow({ teachers: [{ teacherId: SUB_ID, role: 'SUBSTITUTE' }] }));
      harness.tx.teacherAbsenceCover.findMany.mockResolvedValue([
        {
          id: 'dec',
          absenceId: ABSENCE,
          calendarLessonId: LESSON,
          absentTeacherId: TEACHER_ID,
          removedTeachers: [{ teacherId: TEACHER_ID, role: 'LEAD' }],
          decision: 'SUBSTITUTE',
          substituteId: SUB_ID,
          previousNote: null,
          decidedAt: new Date(),
        },
      ]);
      harness.tx.notification.createMany.mockClear();
      await request(http()).delete(`/api/v1/cover/lessons/${LESSON}/decision?absenceId=${ABSENCE}`).set('x-test-user', admin()).expect(200);
      const written = harness.tx.notification.createMany.mock.calls.map(([arg]) => (arg as { data: { type: string; meta: object }[] }).data[0]!);
      expect(written.map((row) => [row.type, Object.keys(row.meta).sort()])).toEqual([
        ['LESSON_COVER_WITHDRAWN', ['groupName', 'roomName', 'startsAt', 'subjectName']],
      ]);
    });

    it('a decision on a held lesson is 409 COVER_LESSON_HELD; a DRAFT publish in progress is 409 PUBLISH_IN_PROGRESS', async () => {
      const past = isoDay(-2);
      harness.tx.teacherAbsence.findUnique.mockResolvedValue({ id: ABSENCE, userId: TEACHER_ID, startsAt: at(past, 0), endsAt: at(isoDay(-1), 0), status: 'ACTIVE' });
      harness.tx.calendarLesson.findUnique.mockResolvedValue(
        lessonRow({ date: new Date(`${past}T00:00:00.000Z`), startsAt: at(past, 8), endsAt: at(past, 9) }),
      );
      const held = await request(http())
        .post(`/api/v1/cover/lessons/${LESSON}/decision`)
        .set('x-test-user', admin())
        .send({ absenceId: ABSENCE, kind: 'SUPERVISED_STUDY', expected: 'OPEN' })
        .expect(409);
      expect(held.body.code).toBe('COVER_LESSON_HELD');

      harness.tx.$queryRaw.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
      const publishing = await request(http())
        .post(`/api/v1/cover/lessons/${LESSON}/decision`)
        .set('x-test-user', admin())
        .send({ absenceId: ABSENCE, kind: 'SUPERVISED_STUDY', expected: 'OPEN' })
        .expect(409);
      expect(publishing.body.code).toBe('PUBLISH_IN_PROGRESS');
    });

    it('the board, candidates, proposal, counter and hours answer, and none carries a reason', async () => {
      const pair = {
        absenceId: ABSENCE,
        absentTeacherId: TEACHER_ID,
        lessonId: LESSON,
        isLive: true,
        decisionId: null,
        decision: null,
        decidedAt: null,
        removedTeachers: null,
        date: FUTURE,
        startsAt: at(FUTURE, 8),
        endsAt: at(FUTURE, 9),
        subjectId: 'subj',
        studentGroupId: 'grp',
        roomId: null,
        lessonStatus: 'SCHEDULED',
        cancelCause: null,
        absenceStartsAt: at(FUTURE, 0),
        absenceEndsAt: at(isoDay(4), 0),
        absenceStatus: 'ACTIVE',
        teachers: [{ teacherId: TEACHER_ID, role: 'LEAD' }],
        extraGroupIds: [],
        coveringSubstituteIds: [],
      };
      harness.tx.$queryRaw.mockResolvedValue([pair]);
      harness.tx.teacherAbsence.findMany.mockResolvedValue([
        { id: ABSENCE, userId: TEACHER_ID, startsAt: at(FUTURE, 0), endsAt: at(isoDay(4), 0) },
      ]);
      const outputs: unknown[] = [];
      const board = await request(http()).get(`/api/v1/cover/board?from=${FUTURE}&to=${FUTURE}`).set('x-test-user', admin()).expect(200);
      expect(board.body.summary).toEqual({ open: 1, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 });
      outputs.push(board.body);

      harness.tx.calendarLesson.findMany.mockResolvedValue([
        { id: LESSON, schoolId: SCHOOL, date: new Date(`${FUTURE}T00:00:00.000Z`), startsAt: at(FUTURE, 8), endsAt: at(FUTURE, 9), status: 'SCHEDULED', subjectId: 'subj', studentGroupId: 'grp', teachers: [{ teacherId: TEACHER_ID }], extraGroups: [], participants: [] },
      ]);
      harness.tx.academicYear.findFirst.mockResolvedValue(null);
      harness.tx.user.findMany.mockResolvedValue([{ id: SUB_ID, role: 'TEACHER', isActive: true }]);
      outputs.push((await request(http()).get(`/api/v1/cover/lessons/${LESSON}/candidates`).set('x-test-user', admin()).expect(200)).body);
      const proposal = await request(http()).post(`/api/v1/cover/days/${FUTURE}/proposal`).set('x-test-user', admin()).send({}).expect(200);
      expect(proposal.body.items.map((item: { userId: string }) => item.userId)).toEqual([SUB_ID]);
      outputs.push(proposal.body);
      const stale = await request(http())
        .post(`/api/v1/cover/days/${FUTURE}/apply`)
        .set('x-test-user', admin())
        .send({ basis: '0'.repeat(64), items: [{ lessonId: LESSON, absenceId: ABSENCE, userId: SUB_ID }] })
        .expect(409);
      expect(stale.body.code).toBe('COVER_PROPOSAL_STALE');

      harness.tx.academicYear.findMany.mockResolvedValue([]);
      outputs.push((await request(http()).get(`/api/v1/cover/counter?date=${FUTURE}`).set('x-test-user', admin()).expect(200)).body);
      outputs.push((await request(http()).get(`/api/v1/cover/hours?from=${isoDay(-30)}&to=${isoDay(0)}`).set('x-test-user', admin()).expect(200)).body);
      expect(JSON.stringify(outputs)).not.toMatch(/"reason(Id)?":/);
      expect(JSON.stringify(outputs)).not.toContain(REASON);
    });

    it('bulk is all or nothing and names the lesson that refused', async () => {
      const bulk = await request(http())
        .post('/api/v1/cover/bulk')
        .set('x-test-user', admin())
        .send({ action: 'CANCELLED', items: [{ lessonId: LESSON, absenceId: ABSENCE, expected: 'HANDLED' }] })
        .expect(409);
      expect(bulk.body).toMatchObject({ code: 'COVER_STALE', params: { current: 'OPEN', lessonId: LESSON } });
      expect(harness.tx.teacherAbsenceCover.create).not.toHaveBeenCalled();
    });
  });

  it('the old PATCH keeps its contract: no replacesTeacherId replaces every row, and the substitute gets their own notice', async () => {
    harness.tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());
    await request(http())
      .patch(`/api/v1/calendar-lessons/${LESSON}/substitute`)
      .set('x-test-user', admin())
      .send({ teacherId: SUB_ID })
      .expect(200);
    expect(harness.tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: LESSON } });
    const types = harness.tx.notification.createMany.mock.calls.map(([arg]) => {
      const rows = (arg as { data: { userId: string; type: string; meta: Record<string, unknown> }[] }).data;
      return [rows[0]!.type, rows.map((row) => row.userId), Object.keys(rows[0]!.meta).sort()];
    });
    expect(types).toContainEqual(['LESSON_SUBSTITUTE', [SUB_ID], ['cover', 'groupName', 'roomName', 'startsAt', 'subjectName']]);
    const replaced = await request(http())
      .patch(`/api/v1/calendar-lessons/${LESSON}/substitute`)
      .set('x-test-user', admin())
      .send({ teacherId: SUB_ID, replacesTeacherId: 'not-a-uuid' })
      .expect(400);
    expect(JSON.stringify(replaced.body)).toContain('replacesTeacherId');
  });
});
