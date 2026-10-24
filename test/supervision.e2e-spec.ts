import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Rastvaktsschema over HTTP (20261202090000): every route an administrator's
 * round trip, so the wire contract is what the page reads — clocks as
 * "10:00", dates as yyyy-mm-dd, schoolId stamped from the principal — and
 * the guards: administrators read, planering writes, nobody else either.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const GARDEN = '50000000-0000-4000-8000-000000000001';
const ANNA = '70000000-0000-4000-8000-000000000001';
const SHIFT = '80000000-0000-4000-8000-000000000001';
const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const area = {
  id: GARDEN,
  schoolId: SCHOOL_ID,
  name: 'Skolgården',
  siteId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  duringRasts: true,
  duringLunch: false,
  guardsNeeded: 1,
  countsAsTeaching: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const shift = {
  id: SHIFT,
  schoolId: SCHOOL_ID,
  academicYearId: YEAR_ID,
  areaId: GARDEN,
  userId: ANNA,
  dayOfWeek: 1,
  startTime: time('10:00'),
  endTime: time('10:20'),
  validFrom: null,
  validTo: day('2026-12-18'),
  note: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Rastvaktsschema (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['$executeRaw']!.mockResolvedValue(1);
    Object.assign(harness.tx, { $queryRaw: jest.fn() });
  });

  afterEach(() => {
    delete (harness.tx as Record<string, unknown>)['$queryRaw'];
  });

  it('lists, creates, changes and removes the school’s areas as its admin', async () => {
    const server = harness.app.getHttpServer();
    harness.tx['supervisionArea']!['findMany']!.mockResolvedValue([{ ...area, _count: { shifts: 2 } }]);
    const listed = await request(server).get('/api/v1/supervision-areas').set('x-test-user', asUser({})).expect(200);
    expect(listed.body).toEqual([
      {
        id: GARDEN,
        name: 'Skolgården',
        siteId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
        duringRasts: true,
        duringLunch: false,
        guardsNeeded: 1,
        countsAsTeaching: false,
        shiftCount: 2,
      },
    ]);

    harness.tx['supervisionArea']!['count']!.mockResolvedValue(0);
    harness.tx['supervisionArea']!['create']!.mockResolvedValue({ ...area, name: 'Matsalen', duringLunch: true });
    await request(server)
      .post('/api/v1/supervision-areas')
      .set('x-test-user', asUser({}))
      .send({ name: ' Matsalen ', duringRasts: false, duringLunch: true, guardsNeeded: 2 })
      .expect(201);
    expect(harness.tx['supervisionArea']!['create']).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: SCHOOL_ID, name: 'Matsalen', duringRasts: false, duringLunch: true, guardsNeeded: 2 }),
    });

    harness.tx['supervisionArea']!['findFirst']!.mockResolvedValue(area);
    harness.tx['supervisionArea']!['update']!.mockResolvedValue({ ...area, minGradeLevel: 0, maxGradeLevel: 3, _count: { shifts: 2 } });
    const changed = await request(server)
      .patch(`/api/v1/supervision-areas/${GARDEN}`)
      .set('x-test-user', asUser({}))
      .send({ minGradeLevel: 0, maxGradeLevel: 3 })
      .expect(200);
    expect(changed.body).toMatchObject({ minGradeLevel: 0, maxGradeLevel: 3, shiftCount: 2 });

    harness.tx['supervisionArea']!['deleteMany']!.mockResolvedValue({ count: 1 });
    await request(server).delete(`/api/v1/supervision-areas/${GARDEN}`).set('x-test-user', asUser({})).expect(204);
  });

  it('creates, moves and removes a pass, and reads the schedule in clocks and days', async () => {
    const server = harness.app.getHttpServer();
    const queryRaw = harness.tx['$queryRaw'] as unknown as jest.Mock;
    queryRaw
      .mockResolvedValueOnce([{ role: 'TEACHER' }])
      .mockResolvedValueOnce([{ startDate: day('2026-08-17'), endDate: day('2027-06-11') }]);
    harness.tx['supervisionArea']!['findUnique']!.mockResolvedValue({ id: GARDEN });
    harness.tx['supervisionShift']!['count']!.mockResolvedValue(0);
    harness.tx['supervisionShift']!['findFirst']!.mockResolvedValue(null);
    harness.tx['supervisionShift']!['create']!.mockResolvedValue(shift);
    const created = await request(server)
      .post('/api/v1/supervision-shifts')
      .set('x-test-user', asUser({}))
      .send({ academicYearId: YEAR_ID, areaId: GARDEN, userId: ANNA, dayOfWeek: 1, startTime: '10:00', endTime: '10:20', validTo: '2026-12-18' })
      .expect(201);
    expect(created.body).toEqual({
      id: SHIFT,
      academicYearId: YEAR_ID,
      areaId: GARDEN,
      userId: ANNA,
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '10:20',
      validFrom: null,
      validTo: '2026-12-18',
      note: null,
    });
    expect(harness.tx['supervisionShift']!['create']).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: SCHOOL_ID, startTime: time('10:00'), validTo: day('2026-12-18') }),
    });

    harness.tx['supervisionShift']!['findUnique']!.mockResolvedValue(shift);
    queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]);
    harness.tx['supervisionShift']!['update']!.mockResolvedValue({ ...shift, endTime: time('10:30') });
    const moved = await request(server)
      .patch(`/api/v1/supervision-shifts/${SHIFT}`)
      .set('x-test-user', asUser({}))
      .send({ endTime: '10:30' })
      .expect(200);
    expect(moved.body).toMatchObject({ startTime: '10:00', endTime: '10:30' });

    harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ startDate: day('2026-08-17'), endDate: day('2027-06-11') });
    harness.tx['supervisionArea']!['findMany']!.mockResolvedValue([{ ...area, _count: { shifts: 1 } }]);
    harness.tx['supervisionShift']!['findMany']!.mockResolvedValue([shift]);
    harness.tx['rast']!['findMany']!.mockResolvedValue([
      { name: 'Förmiddagsrast', minGradeLevel: 0, maxGradeLevel: 6, dayOfWeek: null, startTime: time('10:00'), endTime: time('10:20') },
    ]);
    harness.tx['lunchSetting']!['findUnique']!.mockResolvedValue(null);
    harness.tx['schoolBreak']!['findMany']!.mockResolvedValue([]);
    harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ gradeLevel: 2 }]);
    harness.tx['teacherDuty']!['findMany']!.mockResolvedValue([]);
    const rota = await request(server)
      .get(`/api/v1/supervision-rota?academicYearId=${YEAR_ID}`)
      .set('x-test-user', asUser({}))
      .expect(200);
    expect(rota.body.year).toEqual({ startDate: '2026-08-17', endDate: '2027-06-11' });
    expect(rota.body.breaks[0]).toEqual({
      areaId: GARDEN,
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '10:20',
      names: ['Förmiddagsrast'],
      lunch: false,
      needed: 1,
      shiftIds: [SHIFT],
    });
    // Monday after the jullov, and Tuesday to Friday all year.
    expect(rota.body.gaps[0]).toMatchObject({ dayOfWeek: 1, from: '2026-12-19', to: '2027-06-11', fewest: 0, shortFrom: '10:00', shortTo: '10:20' });
    expect(rota.body.gaps).toHaveLength(5);
    expect(rota.body.teachers).toEqual([expect.objectContaining({ userId: ANNA, shiftCount: 1, ramMinutesPerWeek: null })]);

    harness.tx['supervisionShift']!['deleteMany']!.mockResolvedValue({ count: 1 });
    await request(server).delete(`/api/v1/supervision-shifts/${SHIFT}`).set('x-test-user', asUser({})).expect(204);
  });

  it('refuses a body the DTOs do not take', async () => {
    const server = harness.app.getHttpServer();
    await request(server).post('/api/v1/supervision-areas').set('x-test-user', asUser({})).send({ name: 'x'.repeat(61) }).expect(400);
    await request(server).post('/api/v1/supervision-areas').set('x-test-user', asUser({})).send({ name: 'X', guardsNeeded: 11 }).expect(400);
    await request(server).post('/api/v1/supervision-areas').set('x-test-user', asUser({})).send({ name: 'X', schoolId: SCHOOL_ID }).expect(400);
    const pass = { academicYearId: YEAR_ID, areaId: GARDEN, userId: ANNA, dayOfWeek: 1, startTime: '10:00', endTime: '10:20' };
    for (const body of [{ ...pass, dayOfWeek: 8 }, { ...pass, startTime: '10' }, { ...pass, validFrom: '2026-02-30' }, { ...pass, note: 'x'.repeat(201) }]) {
      await request(server).post('/api/v1/supervision-shifts').set('x-test-user', asUser({})).send(body).expect(400);
    }
    await request(server).get('/api/v1/supervision-rota?academicYearId=nope').set('x-test-user', asUser({})).expect(400);
    expect(harness.tx['supervisionArea']!['create']).not.toHaveBeenCalled();
    expect(harness.tx['supervisionShift']!['create']).not.toHaveBeenCalled();
  });

  it('is read by every administrator, written by planering, and nobody else’s', async () => {
    const server = harness.app.getHttpServer();
    for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
      const who = asUser({ role: role as never });
      await request(server).get('/api/v1/supervision-areas').set('x-test-user', who).expect(403);
      await request(server).get(`/api/v1/supervision-rota?academicYearId=${YEAR_ID}`).set('x-test-user', who).expect(403);
      await request(server).post('/api/v1/supervision-shifts').set('x-test-user', who).send({}).expect(403);
    }
    for (const profile of ['EXPEDITION', 'LASARE']) {
      const admin = asUser({ adminProfile: profile } as never);
      harness.tx['supervisionArea']!['findMany']!.mockResolvedValue([]);
      await request(server).get('/api/v1/supervision-areas').set('x-test-user', admin).expect(200);
      await request(server).post('/api/v1/supervision-areas').set('x-test-user', admin).send({ name: 'X' }).expect(403);
      await request(server).delete(`/api/v1/supervision-shifts/${SHIFT}`).set('x-test-user', admin).expect(403);
    }
    expect(harness.tx['supervisionArea']!['create']).not.toHaveBeenCalled();
    expect(harness.tx['supervisionShift']!['deleteMany']).not.toHaveBeenCalled();
  });
});
