import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * GET /api/v1/family/schedule over HTTP: the roles, the DTO, the one 404 and
 * the whitelist. The database is mocked, so RLS is modelled here only as far
 * as "the guardian's own child is the one row findFirst answers"; that the
 * arms really confine a guardian is the RLS suite's section 29 and the
 * adapter probe's (ey-a), against Postgres.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const OWN_CHILD = '55555555-5555-4555-8555-555555555555';
const OTHER_CHILD = '66666666-6666-4666-8666-666666666666';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const guardian = asUser({ role: 'GUARDIAN' as never, userId: '44444444-4444-4444-8444-444444444444', schoolId: SCHOOL });
const admin = asUser({ role: 'SCHOOL_ADMIN' as never, schoolId: SCHOOL });
const student = asUser({ role: 'STUDENT' as never, userId: OWN_CHILD, schoolId: SCHOOL });
const teacher = asUser({ role: 'TEACHER' as never, schoolId: SCHOOL });

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('the family schedule (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    const { tx } = harness;
    // RLS, modelled: the caller's own child is the only pupil findFirst sees.
    tx.user.findFirst.mockReset();
    tx.user.findFirst.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === OWN_CHILD ? { id: OWN_CHILD, firstName: 'Ella', studentGroupId: HOME } : null,
    );
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.academicYear.findFirst.mockResolvedValue({ endDate: day('2027-06-11') });
    tx.studentGroupMember.findMany.mockResolvedValue([]);
    tx.studentEnrollment.findMany.mockResolvedValue([{ validFrom: day('2026-08-17'), validTo: null }]);
    tx.calendarLesson.findMany.mockReset();
    tx.calendarLesson.findMany.mockResolvedValue([
      {
        id: 'l-1',
        date: day('2026-10-13'),
        startsAt: new Date('2026-10-13T06:00:00.000Z'),
        endsAt: new Date('2026-10-13T06:45:00.000Z'),
        status: 'CANCELLED',
        subjectId: 'subject-ma',
        studentGroupId: HOME,
        subject: { name: 'Matematik', color: null },
        room: { name: 'B204' },
        extraGroups: [],
        participants: [],
        // What the mock's row carries beyond the select must never come out.
        note: 'Inställd: Friluftsdag',
        cancelCause: 'EVENT',
      },
    ]);
    tx.calendarLunch.findMany.mockResolvedValue([]);
    tx.calendarRast.findMany.mockResolvedValue([]);
    tx.$queryRaw.mockReset();
    tx.$queryRaw.mockImplementation(async (first: unknown) =>
      Array.isArray(first) ? [{ today: '2026-10-14' }] : [{ lesson_id: 'l-1', substitute: false, labels: [] }],
    );
  });

  const get = (who: string, query: string) => request(http()).get(`/api/v1/family/schedule${query}`).set('x-test-user', who);

  it('answers an admin the shape, Swedish times and nothing more', async () => {
    const response = await get(admin, `?studentId=${OWN_CHILD}&week=2026-10-13`).expect(200);
    expect(response.body).toEqual({
      student: { id: OWN_CHILD, firstName: 'Ella' },
      week: { from: '2026-10-12', to: '2026-10-18', isoWeek: '2026-W42' },
      today: '2026-10-14',
      bounds: { earliest: '2026-10-05', latest: '2027-06-07' },
      timezone: 'Europe/Stockholm',
      lessons: [
        {
          id: 'l-1',
          date: '2026-10-13',
          start: '08:00',
          end: '08:45',
          startsAt: '2026-10-13T06:00:00.000Z',
          endsAt: '2026-10-13T06:45:00.000Z',
          subjectId: 'subject-ma',
          subject: 'Matematik',
          subjectColor: null,
          room: 'B204',
          teachers: [],
          status: 'CANCELLED',
          substitute: false,
        },
      ],
      lunches: [],
      rasts: [],
    });
    expect(response.text).not.toContain('Friluftsdag');
    expect(response.text).not.toContain('EVENT');
  });

  it('answers a guardian their own child, defaulting to the school’s week', async () => {
    const response = await get(guardian, `?studentId=${OWN_CHILD}`).expect(200);
    expect(response.body.week.from).toBe('2026-10-12');
    expect(response.body.lessons).toHaveLength(1);
  });

  it('answers another family’s child and an unknown id with the identical 404', async () => {
    const other = await get(guardian, `?studentId=${OTHER_CHILD}`).expect(404);
    const unknown = await get(guardian, `?studentId=77777777-7777-4777-8777-777777777777`).expect(404);
    expect(other.body.code).toBe('STUDENT_NOT_FOUND');
    expect(other.body.detail ?? other.body.message).toBe(unknown.body.detail ?? unknown.body.message);
    const strip = (body: Record<string, unknown>) => {
      const { instance: _i, traceId: _t, ...rest } = body;
      return rest;
    };
    expect(strip(other.body)).toEqual(strip(unknown.body));
    expect(harness.tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['no studentId', ''],
    ['a studentId that is not a uuid', '?studentId=ella'],
    ['a week that is not a date', `?studentId=${OWN_CHILD}&week=v42`],
    ['a date that does not exist', `?studentId=${OWN_CHILD}&week=2026-02-30`],
    ['an unknown parameter', `?studentId=${OWN_CHILD}&teacherId=x`],
  ])('refuses %s with 400', async (_name, query) => {
    await get(guardian, query).expect(400);
  });

  it('refuses a week out of range with WEEK_OUT_OF_RANGE', async () => {
    const response = await get(guardian, `?studentId=${OWN_CHILD}&week=2026-01-05`).expect(400);
    expect(response.body.code).toBe('WEEK_OUT_OF_RANGE');
  });

  it.each([
    ['a pupil', student],
    ['a teacher', teacher],
  ])('refuses %s with 403 before reading anything', async (_name, who) => {
    await get(who, `?studentId=${OWN_CHILD}`).expect(403);
    expect(harness.tx.user.findFirst).not.toHaveBeenCalled();
  });
});
