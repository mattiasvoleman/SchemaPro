import request from 'supertest';
import { Prisma } from '@prisma/client';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Delade lokaler och lärare (20261217090000) through the real routing table,
 * validation, RolesGuard and handlers: every administrator reads what the
 * school shares, planering writes the travel, the marks of shared teachers
 * and the loans, and the huvudman's reader writes nothing. The database's own rules (who sees which
 * row, which side may act on a loan) are RLS sections 275–279 and the probe
 * (scripts/test/probe-delade.ts); here each request reaches its handler, or
 * is refused just before it.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ROLLER = '44444444-4444-4444-8444-444444444444';
const HALL = '55555555-5555-4555-8555-555555555555';
const LOAN = '77777777-7777-4777-8777-777777777777';
const LOCAL_HALL = '88888888-8888-4888-8888-888888888888';
const HUVUDMAN_ID = '99999999-9999-4999-8999-999999999999';
const MEMBER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const;
const as = (adminProfile: string) => asUser({ adminProfile } as never);
const teacher = () => asUser({ role: 'TEACHER' as never });
const reader = () =>
  asUser({
    role: 'SCHOOL_ADMIN' as never,
    userId: undefined,
    adminProfile: 'LASARE',
    hrRead: false,
    huvudman: { id: HUVUDMAN_ID, name: 'Vimmerby kommun', memberId: MEMBER_ID, role: 'PLANERARE', firstName: 'Pia', lastName: 'P' },
  } as never);

/** The adapter's form of a database refusal of an SQLSTATE PostgreSQL does not define. */
const refusal = (state: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${state}\`. Message: \`${message}\``, {
    code: 'P2039',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: state, originalMessage: message } } },
  });

const sqlText = (call: unknown[]): string => (call[0] as Prisma.Sql).strings.join('?');

const validLoan = () => ({
  roomId: HALL,
  windows: [{ dayOfWeek: 2, startTime: '10:00', endTime: '11:30' }],
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  note: 'Idrott åk 7',
});

describe('Delade lokaler och lärare (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  let raw: jest.Mock;
  let exec: jest.Mock;

  /** The calls to the four acting functions: a request reads its id, a decision returns void ($executeRaw). */
  const acts = () => [...raw.mock.calls, ...exec.mock.calls].filter((call) => /app\.room_loan_/.test(sqlText(call)));

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => harness.close());

  beforeEach(() => {
    jest.clearAllMocks();
    // What the database's functions answer: one other school with one room.
    raw = jest.fn(async (sql: Prisma.Sql) => {
      const text = sql.strings.join('?');
      if (text.includes('app.sibling_schools()')) return [{ school_id: ROLLER, name: 'RLS Roller' }];
      if (text.includes('app.lendable_rooms()')) {
        return [{ school_id: ROLLER, room_id: HALL, name: 'Roller hall', capacity: 60, room_type_name: null }];
      }
      if (text.includes('app.shared_teachers()')) return [];
      return [{ id: LOAN }];
    });
    harness.tx.$queryRaw = raw;
    exec = jest.fn().mockResolvedValue(1);
    harness.tx.$executeRaw = exec;
    harness.tx['schoolTravelTime']!['findMany']!.mockResolvedValue([]);
    harness.tx['schoolTravelTime']!['findUnique']!.mockResolvedValue(null);
    harness.tx['schoolTravelTime']!['create']!.mockResolvedValue({});
    harness.tx['schoolTravelTime']!['update']!.mockResolvedValue({});
    harness.tx['schoolTravelTime']!['deleteMany']!.mockResolvedValue({ count: 1 });
    harness.tx['roomLoan']!['findMany']!.mockResolvedValue([]);
    harness.tx['sharedTeacherMark']!['findMany']!.mockResolvedValue([]);
    harness.tx['sharedTeacherMark']!['createMany']!.mockResolvedValue({ count: 1 });
    harness.tx['sharedTeacherMark']!['deleteMany']!.mockResolvedValue({ count: 1 });
    harness.tx['user']!['findMany']!.mockResolvedValue([]);
    harness.tx['user']!['findFirst']!.mockResolvedValue({ id: ANNA });
  });

  /** The school had LOCAL_HALL for the hall: the request names it. */
  const hadLocalHall = () => {
    harness.tx['roomLoan']!['findMany']!.mockImplementation(async (args: { where?: { localRoomId?: unknown } }) =>
      args?.where?.localRoomId ? [{ roomId: HALL, localRoomId: LOCAL_HALL }] : [],
    );
  };

  describe('every administrator reads what the school shares', () => {
    it.each(PROFILES)('%s reads the sharing, the loans and the rooms to ask for', async (profile) => {
      const sharing = await request(http()).get('/api/v1/sharing').set('x-test-user', as(profile)).expect(200);
      expect(sharing.body).toEqual({
        schools: [{ id: ROLLER, name: 'RLS Roller', travelMinutes: null, travelSetByUs: null }],
        teachers: [],
        staff: [],
      });
      const loans = await request(http()).get('/api/v1/room-loans').set('x-test-user', as(profile)).expect(200);
      expect(loans.body).toEqual({ lent: [], borrowed: [] });
      const rooms = await request(http()).get('/api/v1/room-loans/rooms').set('x-test-user', as(profile)).expect(200);
      expect(rooms.body).toEqual([
        { id: ROLLER, name: 'RLS Roller', rooms: [{ id: HALL, name: 'Roller hall', capacity: 60, roomTypeName: null, localRoomId: null }] },
      ]);
    });

    it('the huvudman\'s reader reads them too', async () => {
      await request(http()).get('/api/v1/sharing').set('x-test-user', reader()).expect(200);
      await request(http()).get('/api/v1/room-loans').set('x-test-user', reader()).expect(200);
      await request(http()).get('/api/v1/room-loans/rooms').set('x-test-user', reader()).expect(200);
    });

    it('a teacher reads none of it', async () => {
      await request(http()).get('/api/v1/sharing').set('x-test-user', teacher()).expect(403);
      await request(http()).get('/api/v1/room-loans').set('x-test-user', teacher()).expect(403);
      expect(raw).not.toHaveBeenCalled();
    });
  });

  describe('the travel to another school', () => {
    it('is written by planering, signed with the school, the pair lower id first', async () => {
      const response = await request(http())
        .put(`/api/v1/sharing/travel/${ROLLER}`)
        .set('x-test-user', as('FULL'))
        .send({ minutes: 15 })
        .expect(200);

      expect(harness.tx['schoolTravelTime']!['create']).toHaveBeenCalledWith({
        data: { schoolAId: SCHOOL_ID, schoolBId: ROLLER, minutes: 15, setBySchoolId: SCHOOL_ID },
      });
      expect(response.body.schools).toHaveLength(1);
    });

    it('changes a figure the other school wrote', async () => {
      harness.tx['schoolTravelTime']!['findUnique']!.mockResolvedValue({ minutes: 10 });

      await request(http()).put(`/api/v1/sharing/travel/${ROLLER}`).set('x-test-user', as('SCHEMALAGGARE')).send({ minutes: 0 }).expect(200);

      expect(harness.tx['schoolTravelTime']!['update']).toHaveBeenCalledWith({
        where: { schoolAId_schoolBId: { schoolAId: SCHOOL_ID, schoolBId: ROLLER } },
        data: { minutes: 0, setBySchoolId: SCHOOL_ID },
      });
    });

    it('removes the figure on null', async () => {
      await request(http()).put(`/api/v1/sharing/travel/${ROLLER}`).set('x-test-user', as('REKTOR')).send({ minutes: null }).expect(200);

      expect(harness.tx['schoolTravelTime']!['deleteMany']).toHaveBeenCalledWith({ where: { schoolAId: SCHOOL_ID, schoolBId: ROLLER } });
    });

    it('answers a school that is not another school of the huvudman with a 404', async () => {
      const response = await request(http())
        .put(`/api/v1/sharing/travel/${LOAN}`)
        .set('x-test-user', as('FULL'))
        .send({ minutes: 15 })
        .expect(404);

      expect(response.body).toMatchObject({ code: 'SCHOOL_NOT_SIBLING' });
      expect(harness.tx['schoolTravelTime']!['create']).not.toHaveBeenCalled();
    });

    it.each(['EXPEDITION', 'LASARE'])('refuses %s by the area, before any write', async (profile) => {
      const response = await request(http())
        .put(`/api/v1/sharing/travel/${ROLLER}`)
        .set('x-test-user', as(profile))
        .send({ minutes: 15 })
        .expect(403);

      expect(response.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(raw).not.toHaveBeenCalled();
      expect(harness.tx['schoolTravelTime']!['create']).not.toHaveBeenCalled();
    });

    it('refuses a teacher and the huvudman\'s reader', async () => {
      await request(http()).put(`/api/v1/sharing/travel/${ROLLER}`).set('x-test-user', teacher()).send({ minutes: 15 }).expect(403);
      const response = await request(http())
        .put(`/api/v1/sharing/travel/${ROLLER}`)
        .set('x-test-user', reader())
        .send({ minutes: 15 })
        .expect(403);
      expect(response.body.code).toBe('HUVUDMAN_READS_ONLY');
      expect(raw).not.toHaveBeenCalled();
    });

    it.each([
      [{ minutes: 241 }],
      [{ minutes: -1 }],
      [{ minutes: 1.5 }],
      [{ minutes: '15' }],
      [{}],
      [{ minutes: 15, setBySchoolId: ROLLER }],
    ])('refuses the body %j with a 400', async (body) => {
      await request(http()).put(`/api/v1/sharing/travel/${ROLLER}`).set('x-test-user', as('FULL')).send(body).expect(400);
      expect(raw).not.toHaveBeenCalled();
    });

    it('refuses an id that is no uuid with a 400', async () => {
      await request(http()).put('/api/v1/sharing/travel/not-a-school').set('x-test-user', as('FULL')).send({ minutes: 15 }).expect(400);
    });
  });

  describe('a shared teacher', () => {
    it('is marked by planering, the school\'s own row towards another school of the huvudman', async () => {
      const response = await request(http())
        .put(`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`)
        .set('x-test-user', as('SCHEMALAGGARE'))
        .expect(200);

      expect(harness.tx['sharedTeacherMark']!['createMany']).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL_ID, teacherId: ANNA, withSchoolId: ROLLER }],
        skipDuplicates: true,
      });
      expect(response.body).toMatchObject({ teachers: [], staff: [] });
    });

    it('is unmarked by planering', async () => {
      await request(http()).delete(`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`).set('x-test-user', as('REKTOR')).expect(200);

      expect(harness.tx['sharedTeacherMark']!['deleteMany']).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, teacherId: ANNA, withSchoolId: ROLLER },
      });
    });

    it('answers a row that is not the school\'s active staff, and a school that is not the huvudman\'s, with a 404', async () => {
      harness.tx['user']!['findFirst']!.mockResolvedValue(null);
      const notStaff = await request(http()).put(`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`).set('x-test-user', as('FULL')).expect(404);
      expect(notStaff.body).toMatchObject({ code: 'SHARED_TEACHER_NOT_STAFF' });
      const notSibling = await request(http()).put(`/api/v1/sharing/teachers/${ANNA}/schools/${LOAN}`).set('x-test-user', as('FULL')).expect(404);
      expect(notSibling.body).toMatchObject({ code: 'SCHOOL_NOT_SIBLING' });
      expect(harness.tx['sharedTeacherMark']!['createMany']).not.toHaveBeenCalled();
    });

    it.each(['EXPEDITION', 'LASARE'])('refuses %s by the area, either way', async (profile) => {
      for (const method of ['put', 'delete'] as const) {
        const response = await request(http())[method](`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`).set('x-test-user', as(profile)).expect(403);
        expect(response.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      }
      expect(raw).not.toHaveBeenCalled();
    });

    it('refuses a teacher and the huvudman\'s reader', async () => {
      await request(http()).put(`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`).set('x-test-user', teacher()).expect(403);
      const response = await request(http()).delete(`/api/v1/sharing/teachers/${ANNA}/schools/${ROLLER}`).set('x-test-user', reader()).expect(403);
      expect(response.body.code).toBe('HUVUDMAN_READS_ONLY');
      expect(raw).not.toHaveBeenCalled();
    });

    it('refuses ids that are no uuids with a 400', async () => {
      await request(http()).put(`/api/v1/sharing/teachers/anna/schools/${ROLLER}`).set('x-test-user', as('FULL')).expect(400);
      await request(http()).put(`/api/v1/sharing/teachers/${ANNA}/schools/roller`).set('x-test-user', as('FULL')).expect(400);
      expect(raw).not.toHaveBeenCalled();
    });
  });

  describe('a loan of another school\'s room', () => {
    it('is asked for by planering, one request per window, through the database\'s function', async () => {
      hadLocalHall();
      await request(http())
        .post('/api/v1/room-loans')
        .set('x-test-user', as('SCHEMALAGGARE'))
        .send({ ...validLoan(), windows: [...validLoan().windows, { dayOfWeek: 4, startTime: '13:00', endTime: '14:00:00' }] })
        .expect(201);

      expect(acts()).toHaveLength(2);
      expect(acts().every((call) => sqlText(call).includes('app.room_loan_request('))).toBe(true);
      expect((acts()[0]![0] as Prisma.Sql).values).toEqual([
        HALL, LOCAL_HALL, null, null, 2, '10:00', '11:30', '2030-08-19', '2031-06-13', 'Idrott åk 7',
      ]);
    });

    it('makes no room of the school\'s own the first time: it passes the name on for the approval', async () => {
      await request(http())
        .post('/api/v1/room-loans')
        .set('x-test-user', as('FULL'))
        .send({ ...validLoan(), localRoomName: 'Hallen hos Roller' })
        .expect(201);

      expect(harness.tx['room']!['create']).not.toHaveBeenCalled();
      expect((acts()[0]![0] as Prisma.Sql).values.slice(0, 4)).toEqual([HALL, null, 'Hallen hos Roller', null]);
    });

    it.each([
      ['no windows', { ...validLoan(), windows: [] }],
      ['eleven windows', { ...validLoan(), windows: Array.from({ length: 11 }, (_, i) => ({ dayOfWeek: 1, startTime: `0${i % 10}:00`, endTime: '23:00' })) }],
      ['a clock that is no clock', { ...validLoan(), windows: [{ dayOfWeek: 2, startTime: '10.00', endTime: '11:30' }] }],
      ['hour 25', { ...validLoan(), windows: [{ dayOfWeek: 2, startTime: '25:00', endTime: '26:00' }] }],
      ['minute 99', { ...validLoan(), windows: [{ dayOfWeek: 2, startTime: '10:99', endTime: '11:30' }] }],
      ['second 60', { ...validLoan(), windows: [{ dayOfWeek: 2, startTime: '10:00:60', endTime: '11:30' }] }],
      ['a room type id that is no uuid', { ...validLoan(), localRoomTypeId: 'idrott' }],
      ['weekday 8', { ...validLoan(), windows: [{ dayOfWeek: 8, startTime: '10:00', endTime: '11:30' }] }],
      ['a room id that is no uuid', { ...validLoan(), roomId: 'hallen' }],
      ['a date that is no date', { ...validLoan(), startDate: '19 augusti' }],
      ['a field the API does not take', { ...validLoan(), status: 'APPROVED' }],
      ['a note of 301 characters', { ...validLoan(), note: 'x'.repeat(301) }],
      ['a window that ends before it starts', { ...validLoan(), windows: [{ dayOfWeek: 2, startTime: '11:30', endTime: '10:00' }] }],
      ['more than 400 days', { ...validLoan(), endDate: '2031-09-24' }],
    ])('refuses %s with a 400 and asks the database nothing', async (_what, body) => {
      await request(http()).post('/api/v1/room-loans').set('x-test-user', as('FULL')).send(body).expect(400);
      expect(raw).not.toHaveBeenCalled();
    });

    it('answers a refusal of the database\'s by its code', async () => {
      raw.mockImplementation(async (sql: Prisma.Sql) => {
        const text = sql.strings.join('?');
        if (text.includes('app.sibling_schools()')) return [{ school_id: ROLLER, name: 'RLS Roller' }];
        if (text.includes('app.lendable_rooms()')) {
          return [{ school_id: ROLLER, room_id: HALL, name: 'Roller hall', capacity: 60, room_type_name: null }];
        }
        throw refusal('RL409', 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER');
      });

      const response = await request(http()).post('/api/v1/room-loans').set('x-test-user', as('FULL')).send(validLoan()).expect(409);
      expect(response.body).toMatchObject({ code: 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' });
    });

    it.each(['EXPEDITION', 'LASARE'])('refuses %s by the area', async (profile) => {
      const response = await request(http()).post('/api/v1/room-loans').set('x-test-user', as(profile)).send(validLoan()).expect(403);
      expect(response.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(raw).not.toHaveBeenCalled();
    });

    it('refuses the huvudman\'s reader before the handler', async () => {
      const response = await request(http()).post('/api/v1/room-loans').set('x-test-user', reader()).send(validLoan()).expect(403);
      expect(response.body.code).toBe('HUVUDMAN_READS_ONLY');
      expect(raw).not.toHaveBeenCalled();
    });
  });

  describe('a decision on a loan', () => {
    it.each([
      ['approve', 'app.room_loan_decide(', [LOAN, true]],
      ['decline', 'app.room_loan_decide(', [LOAN, false]],
      ['withdraw', 'app.room_loan_withdraw(', [LOAN]],
      ['revoke', 'app.room_loan_revoke(', [LOAN]],
    ])('%s reaches its function for planering', async (act, fn, values) => {
      const response = await request(http()).post(`/api/v1/room-loans/${LOAN}/${act}`).set('x-test-user', as('FULL')).expect(201);

      expect(acts()).toHaveLength(1);
      expect(sqlText(acts()[0]!)).toContain(fn);
      expect((acts()[0]![0] as Prisma.Sql).values).toEqual(values);
      expect(response.body).toEqual({ lent: [], borrowed: [] });
    });

    it.each(['approve', 'decline', 'withdraw', 'revoke'])('%s refuses the expedition and the huvudman\'s reader', async (act) => {
      const expedition = await request(http()).post(`/api/v1/room-loans/${LOAN}/${act}`).set('x-test-user', as('EXPEDITION')).expect(403);
      expect(expedition.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      const huvudman = await request(http()).post(`/api/v1/room-loans/${LOAN}/${act}`).set('x-test-user', reader()).expect(403);
      expect(huvudman.body.code).toBe('HUVUDMAN_READS_ONLY');
      expect(raw).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });

    it('answers a loan decided already with the 409 the database names', async () => {
      exec.mockRejectedValue(refusal('RL409', 'ROOM_LOAN_ALREADY_DECIDED'));

      const response = await request(http()).post(`/api/v1/room-loans/${LOAN}/approve`).set('x-test-user', as('FULL')).expect(409);

      expect(response.body).toMatchObject({ code: 'ROOM_LOAN_ALREADY_DECIDED' });
    });

    it('answers a loan that is not the school\'s side to act on with a 404', async () => {
      exec.mockRejectedValue(refusal('RL404', 'ROOM_LOAN_NOT_FOUND'));

      const response = await request(http()).post(`/api/v1/room-loans/${LOAN}/revoke`).set('x-test-user', as('FULL')).expect(404);

      expect(response.body).toMatchObject({ code: 'ROOM_LOAN_NOT_FOUND' });
    });

    it('refuses an id that is no uuid with a 400', async () => {
      await request(http()).post('/api/v1/room-loans/lanet/approve').set('x-test-user', as('FULL')).expect(400);
      expect(acts()).toHaveLength(0);
    });
  });
});
