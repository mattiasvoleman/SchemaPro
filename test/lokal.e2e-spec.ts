import { Prisma } from '@prisma/client';
import request from 'supertest';
import { rawSql } from './utils/locking-read';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/*
 * Lokal's routes (K3): who may reach them, what a request must be, and one whole round
 * of every verb and path as an administrator. The mocks stand in for the database, so
 * these hold the role and area gates, the validation and the shape of every answer, and
 * say nothing of row security: RLS sections 440-444 and the adapter probe
 * (scripts/test/probe-lokal.ts) say which row is whose, and the real planning is theirs.
 */

const TYPE_ID = '44444444-4444-4444-8444-444444444441';
const RESOURCE_ID = '44444444-4444-4444-8444-444444444442';
const ROOM_ID = '44444444-4444-4444-8444-444444444443';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555551';
const SERIES_ID = '55555555-5555-4555-8555-555555555552';
const DAY_ID = '55555555-5555-4555-8555-555555555553';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/** The school's calendar day `offset` days from now, as yyyy-mm-dd. */
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const instant = (offset: number, hour: number): string => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const as = (profile: string) => asUser({ adminProfile: profile as never });
const teacher = (userId = ADMIN_ID) => asUser({ role: 'TEACHER' as never, userId });
const admin = asUser({});

const knownError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client });

/** Every route of Lokal, as the guards see it. */
const ROUTES: ReadonlyArray<readonly ['get' | 'post' | 'patch' | 'delete', string]> = [
  ['get', '/api/v1/resource-types'],
  ['post', '/api/v1/resource-types'],
  ['patch', `/api/v1/resource-types/${TYPE_ID}`],
  ['delete', `/api/v1/resource-types/${TYPE_ID}`],
  ['get', '/api/v1/resources'],
  ['get', `/api/v1/resources/availability?from=${instant(1, 8)}&to=${instant(1, 12)}`],
  ['post', '/api/v1/resources'],
  ['patch', `/api/v1/resources/${RESOURCE_ID}`],
  ['delete', `/api/v1/resources/${RESOURCE_ID}`],
  ['get', '/api/v1/resource-bookings'],
  ['post', '/api/v1/resource-bookings'],
  ['patch', `/api/v1/resource-bookings/${BOOKING_ID}/cancel`],
  ['patch', `/api/v1/resource-bookings/${BOOKING_ID}/decide`],
  ['post', '/api/v1/external-bookings/preview'],
  ['post', '/api/v1/external-bookings'],
  ['get', '/api/v1/external-bookings'],
  ['get', '/api/v1/external-bookings/clashes'],
  ['get', `/api/v1/external-bookings/${SERIES_ID}`],
  ['patch', `/api/v1/external-bookings/${SERIES_ID}`],
  ['patch', `/api/v1/external-bookings/${SERIES_ID}/cancel`],
  ['delete', `/api/v1/external-bookings/${SERIES_ID}`],
  ['patch', `/api/v1/external-bookings/${SERIES_ID}/days/${DAY_ID}/cancel`],
  ['get', '/api/v1/utilisation?from=2027-02-01&to=2027-02-07'],
  ['get', '/api/v1/utilisation/csv?from=2027-02-01&to=2027-02-07'],
];

/** What an unstubbed table answers with: nothing at all, as a fresh database does. */
const TABLES: Record<string, string[]> = {
  resourceType: ['findMany', 'findUnique', 'create', 'update', 'delete'],
  resource: ['findMany', 'findUnique', 'create', 'update', 'delete'],
  site: ['findMany'],
  resourceBooking: ['findMany', 'findUnique', 'findFirst', 'create', 'createMany', 'update', 'updateMany'],
  externalBooking: ['findMany', 'findUnique', 'findFirst', 'create', 'update', 'delete', 'count'],
  roomBooking: ['findMany', 'findFirst', 'createMany', 'update', 'updateMany'],
  calendarLesson: ['findMany'],
  room: ['findMany'],
  frameTime: ['findMany'],
  schoolBreak: ['findMany'],
  school: ['findFirst'],
  user: ['findMany'],
  personProtection: ['findMany'],
  notification: ['createMany'],
};

interface World {
  statics: Record<string, unknown>;
  facts: Array<Record<string, unknown>>;
  resourceFacts: Array<Record<string, unknown>>;
  counts: Array<Record<string, unknown>>;
  clashes: Array<Record<string, unknown>>;
  late: Array<Record<string, unknown>>;
}

describe('Lokal (e2e)', () => {
  let harness: TestHarness;
  let world: World;
  const http = () => request(harness.app.getHttpServer());
  const table = (model: string, method: string): jest.Mock => harness.tx[model]![method]!;

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    for (const [model, methods] of Object.entries(TABLES)) {
      for (const method of methods) {
        table(model, method).mockReset();
        if (method === 'findMany') table(model, method).mockResolvedValue([]);
      }
    }
    world = {
      statics: {
        timezone: 'Europe/Stockholm',
        frames: [],
        breaks: [],
        room: { id: ROOM_ID, name: 'Gymnastiksalen', min: null, max: null },
        resource: null,
        loans: [],
      },
      facts: [],
      resourceFacts: [],
      counts: [],
      clashes: [],
      late: [],
    };
    harness.tx.$queryRaw.mockReset();
    harness.tx.$queryRaw.mockImplementation((...call: unknown[]) => {
      const sql = rawSql(call);
      if (sql.includes('AS "timezone"')) return Promise.resolve([world.statics]);
      if (sql.includes('late lessons')) return Promise.resolve(world.late);
      if (sql.includes(`'LESSON' AS "kind"`)) return Promise.resolve(world.facts);
      if (sql.includes('SELECT DISTINCT b."id"')) return Promise.resolve(world.resourceFacts);
      if (sql.includes('count(*)::int AS "total"')) return Promise.resolve(world.counts);
      if (sql.includes('JOIN "ExternalBookings" x')) return Promise.resolve(world.clashes);
      throw new Error(`Unexpected statement: ${sql}`);
    });
    table('school', 'findFirst').mockResolvedValue({ timezone: 'Europe/Stockholm' });
  });

  // -----------------------------------------------------------------------
  // The rows the tables answer with
  // -----------------------------------------------------------------------

  const resourceRow = (patch: Record<string, unknown> = {}) => ({
    id: RESOURCE_ID,
    name: 'Surfplattor',
    resourceTypeId: TYPE_ID,
    quantity: 30,
    siteId: null,
    place: null,
    requiresApproval: false,
    resourceType: { name: 'Utrustning' },
    ...patch,
  });

  const seriesRow = (patch: Record<string, unknown> = {}) => ({
    id: SERIES_ID,
    roomId: ROOM_ID,
    resourceId: null,
    resourceQuantity: null,
    organisation: 'Idrottsföreningen',
    contactName: 'Kim Kontakt',
    contactPhone: '070-1234567',
    contactEmail: 'kim@forening.example',
    purpose: null,
    note: null,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    intervalWeeks: 1,
    startDate: new Date(`${day(10)}T00:00:00.000Z`),
    endDate: new Date(`${day(16)}T00:00:00.000Z`),
    startTime: new Date('1970-01-01T18:00:00.000Z'),
    endTime: new Date('1970-01-01T20:00:00.000Z'),
    skippedDates: [],
    cancelledAt: null,
    registeredById: ADMIN_ID,
    createdAt: new Date('2027-01-19T12:00:00.000Z'),
    room: { name: 'Gymnastiksalen' },
    resource: null,
    ...patch,
  });

  /** A series of every day for a week, 18-20, as the preview and the registration are asked for it. */
  const rule = (patch: Record<string, unknown> = {}) => ({
    target: 'ROOM',
    roomId: ROOM_ID,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startDate: day(10),
    endDate: day(16),
    startTime: '18:00',
    endTime: '20:00',
    ...patch,
  });

  const registration = (patch: Record<string, unknown> = {}) =>
    rule({ organisation: 'Idrottsföreningen', contactName: 'Kim Kontakt', contactPhone: '070-1234567', ...patch });

  const bookingRow = (patch: Record<string, unknown> = {}) => ({
    id: BOOKING_ID,
    resourceId: RESOURCE_ID,
    bookedById: ADMIN_ID,
    title: 'Matteprov',
    quantity: 3,
    startsAt: new Date(instant(5, 8)),
    endsAt: new Date(instant(5, 10)),
    status: 'APPROVED',
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date('2027-01-19T12:00:00.000Z'),
    externalBookingId: null,
    resource: { name: 'Surfplattor' },
    ...patch,
  });

  // -----------------------------------------------------------------------
  // Who may reach what
  // -----------------------------------------------------------------------

  describe('who may reach the routes', () => {
    it.each(ROUTES.map(([verb, path]) => [verb, path.split('?')[0]!, verb, path] as const))('refuses %s %s without a token', async (_verb, _label, verb, path) => {
      await http()[verb](path).send({}).expect(401);
    });

    it('refuses a pupil and a guardian every route', async () => {
      const refused: string[] = [];
      for (const role of ['STUDENT', 'GUARDIAN']) {
        for (const [verb, path] of ROUTES) {
          const response = await http()[verb](path).set('x-test-user', asUser({ role: role as never })).send({});
          if (response.status !== 403) refused.push(`${role} ${verb.toUpperCase()} ${path} answered ${response.status}`);
        }
      }
      expect(refused).toEqual([]);
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('lets a teacher read the resources and book, and write no base data and reach no external booking nor the report', async () => {
      table('resourceType', 'findMany').mockResolvedValue([]);
      const as = teacher();
      for (const path of ['/api/v1/resource-types', '/api/v1/resources', `/api/v1/resources/availability?from=${instant(1, 8)}&to=${instant(1, 12)}`, '/api/v1/resource-bookings']) {
        await http().get(path).set('x-test-user', as).expect(200);
      }

      const refused = ROUTES.filter(([verb, path]) => {
        const readsOrBooks =
          verb === 'get' && /^\/api\/v1\/(resource-types|resources|resource-bookings)/.test(path) ||
          path === '/api/v1/resource-bookings' ||
          path.endsWith('/cancel') && path.includes('/resource-bookings/');
        return !readsOrBooks;
      });
      expect(refused.length).toBeGreaterThan(15);
      const wrong: string[] = [];
      for (const [verb, path] of refused) {
        const response = await http()[verb](path).set('x-test-user', as).send({});
        if (response.status !== 403) wrong.push(`${verb.toUpperCase()} ${path} answered ${response.status}`);
      }
      expect(wrong).toEqual([]);
      expect(table('resource', 'create')).not.toHaveBeenCalled();
      expect(table('resourceType', 'create')).not.toHaveBeenCalled();
      expect(table('externalBooking', 'create')).not.toHaveBeenCalled();
    });

    it('lets a teacher book a resource and cancel their own booking, and not a colleague’s', async () => {
      table('resource', 'findUnique').mockResolvedValue({ id: RESOURCE_ID, requiresApproval: false, quantity: 30 });
      table('resourceBooking', 'create').mockResolvedValue({ id: BOOKING_ID, status: 'APPROVED' });
      await http()
        .post('/api/v1/resource-bookings')
        .set('x-test-user', teacher())
        .send({ resourceId: RESOURCE_ID, title: 'Matteprov', startsAt: instant(5, 8), endsAt: instant(5, 10) })
        .expect(201);

      table('resourceBooking', 'findUnique').mockResolvedValue({ id: BOOKING_ID, bookedById: ADMIN_ID, status: 'APPROVED', externalBookingId: null });
      table('resourceBooking', 'update').mockResolvedValue({ id: BOOKING_ID, status: 'CANCELLED' });
      await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/cancel`).set('x-test-user', teacher()).expect(200);
      await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/cancel`).set('x-test-user', teacher(OTHER_ID)).expect(403);
      expect(table('resourceBooking', 'update')).toHaveBeenCalledTimes(1);
    });

    it('lets every profile read, the Planering profiles write the resources and kinds, and the others not', async () => {
      const planering: Record<string, boolean> = { FULL: true, REKTOR: true, SCHEMALAGGARE: true, EXPEDITION: false, LASARE: false };
      table('resourceType', 'create').mockResolvedValue({ id: TYPE_ID, name: 'Aulan' });
      table('resource', 'create').mockResolvedValue(resourceRow());
      for (const [profile, writes] of Object.entries(planering)) {
        await http().get('/api/v1/resource-types').set('x-test-user', as(profile)).expect(200);
        await http().get('/api/v1/resources').set('x-test-user', as(profile)).expect(200);
        const type = await http().post('/api/v1/resource-types').set('x-test-user', as(profile)).send({ name: 'Aulan' });
        const resource = await http().post('/api/v1/resources').set('x-test-user', as(profile)).send({ name: 'Surfplattor', resourceTypeId: TYPE_ID });
        expect([profile, type.status, resource.status]).toEqual([profile, writes ? 201 : 403, writes ? 201 : 403]);
        if (!writes) {
          expect(type.body.code).toBe('AREA_NOT_YOURS');
          expect(type.body.detail).toContain('Planering');
        }
      }
    });

    it('lets every profile read the external bookings and the report, the Drift profiles write, and the läsare not', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue({ cancelledAt: new Date(), endDate: new Date('2020-01-01T00:00:00.000Z') });
      const drift: Record<string, boolean> = { FULL: true, REKTOR: true, SCHEMALAGGARE: true, EXPEDITION: true, LASARE: false };
      for (const [profile, writes] of Object.entries(drift)) {
        await http().get('/api/v1/external-bookings').set('x-test-user', as(profile)).expect(200);
        await http().get('/api/v1/external-bookings/clashes').set('x-test-user', as(profile)).expect(200);
        await http().get('/api/v1/utilisation?from=2027-02-01&to=2027-02-07').set('x-test-user', as(profile)).expect(200);
        await http().get('/api/v1/utilisation/csv?from=2027-02-01&to=2027-02-07').set('x-test-user', as(profile)).expect(200);
        const removed = await http().delete(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', as(profile));
        expect([profile, removed.status]).toEqual([profile, writes ? 204 : 403]);
        if (!writes) {
          expect(removed.body.code).toBe('AREA_NOT_YOURS');
          expect(removed.body.detail).toContain('Drift');
        }
      }
      // A läsare does not write: not a series, not a cancel, not a change, and not a preview (a POST under Drift).
      const lasare = as('LASARE');
      await http().post('/api/v1/external-bookings/preview').set('x-test-user', lasare).send(rule()).expect(403);
      await http().post('/api/v1/external-bookings').set('x-test-user', lasare).send(registration()).expect(403);
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', lasare).send({ note: 'x' }).expect(403);
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/cancel`).set('x-test-user', lasare).expect(403);
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/${DAY_ID}/cancel`).set('x-test-user', lasare).expect(403);
      await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/decide`).set('x-test-user', lasare).send({ status: 'APPROVED' }).expect(403);
      await http()
        .post('/api/v1/resource-bookings')
        .set('x-test-user', lasare)
        .send({ resourceId: RESOURCE_ID, title: 'Matteprov', startsAt: instant(5, 8), endsAt: instant(5, 10) })
        .expect(403);
      expect(table('externalBooking', 'create')).not.toHaveBeenCalled();
      expect(table('externalBooking', 'update')).not.toHaveBeenCalled();
      expect(table('resourceBooking', 'create')).not.toHaveBeenCalled();
    });

    it('takes a preview and a registration from the Drift profiles alike', async () => {
      table('externalBooking', 'create').mockResolvedValue({ id: SERIES_ID });
      for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
        await http().post('/api/v1/external-bookings/preview').set('x-test-user', as(profile)).send(rule()).expect(201);
        await http().post('/api/v1/external-bookings').set('x-test-user', as(profile)).send(registration()).expect(201);
      }
    });
  });

  // -----------------------------------------------------------------------
  // The kinds of resource
  // -----------------------------------------------------------------------

  describe('resource types', () => {
    it('lists the kinds by name with how many resources each has', async () => {
      table('resourceType', 'findMany').mockResolvedValue([{ id: TYPE_ID, name: 'Utrustning', _count: { resources: 2 } }]);

      const response = await http().get('/api/v1/resource-types').set('x-test-user', admin).expect(200);

      expect(response.body).toEqual([{ id: TYPE_ID, name: 'Utrustning', resources: 2 }]);
    });

    it('creates a kind for the caller’s school and answers it with no resources', async () => {
      table('resourceType', 'create').mockResolvedValue({ id: TYPE_ID, name: 'Aulan' });

      const response = await http().post('/api/v1/resource-types').set('x-test-user', admin).send({ name: '  Aulan ' }).expect(201);

      expect(response.body).toEqual({ id: TYPE_ID, name: 'Aulan', resources: 0 });
      expect(table('resourceType', 'create').mock.calls[0]![0].data).toEqual({ schoolId: SCHOOL_ID, name: 'Aulan' });
    });

    it('renames a kind', async () => {
      table('resourceType', 'update').mockResolvedValue({ id: TYPE_ID, name: 'Aulor', _count: { resources: 1 } });

      const response = await http().patch(`/api/v1/resource-types/${TYPE_ID}`).set('x-test-user', admin).send({ name: 'Aulor' }).expect(200);

      expect(response.body).toEqual({ id: TYPE_ID, name: 'Aulor', resources: 1 });
    });

    it('removes a kind that nothing uses, with a 204', async () => {
      table('resourceType', 'findUnique').mockResolvedValue({ _count: { resources: 0 } });

      await http().delete(`/api/v1/resource-types/${TYPE_ID}`).set('x-test-user', admin).expect(204);

      expect(table('resourceType', 'delete')).toHaveBeenCalledWith({ where: { id: TYPE_ID } });
    });

    it('refuses to remove a kind that is in use, saying how many use it, and a name the school has', async () => {
      table('resourceType', 'findUnique').mockResolvedValue({ _count: { resources: 2 } });
      const used = await http().delete(`/api/v1/resource-types/${TYPE_ID}`).set('x-test-user', admin).expect(400);
      expect(used.body.detail).toBe('Slaget används av 2 resurs(er) och kan inte tas bort. Byt slag på dem först.');
      expect(table('resourceType', 'delete')).not.toHaveBeenCalled();

      table('resourceType', 'create').mockRejectedValue(knownError('P2002', 'Unique constraint failed'));
      await http().post('/api/v1/resource-types').set('x-test-user', admin).send({ name: 'Aulan' }).expect(409);
    });
  });

  // -----------------------------------------------------------------------
  // The resources
  // -----------------------------------------------------------------------

  describe('resources', () => {
    it('lists them by name with their kind and the site they are kept on', async () => {
      table('resource', 'findMany').mockResolvedValue([resourceRow({ siteId: SITE_ID, place: 'Skåp 3' })]);
      table('site', 'findMany').mockResolvedValue([{ id: SITE_ID, name: 'Norra skolan' }]);

      const response = await http().get('/api/v1/resources').set('x-test-user', admin).expect(200);

      expect(response.body).toEqual([
        {
          id: RESOURCE_ID,
          name: 'Surfplattor',
          resourceTypeId: TYPE_ID,
          resourceTypeName: 'Utrustning',
          quantity: 30,
          siteId: SITE_ID,
          siteName: 'Norra skolan',
          place: 'Skåp 3',
          requiresApproval: false,
        },
      ]);
    });

    it('says how many of each nobody holds in a window', async () => {
      table('resource', 'findMany').mockResolvedValue([resourceRow()]);
      table('resourceBooking', 'findMany').mockResolvedValue([
        { resourceId: RESOURCE_ID, quantity: 12, startsAt: new Date(instant(1, 8)), endsAt: new Date(instant(1, 10)) },
      ]);

      const response = await http()
        .get(`/api/v1/resources/availability?from=${instant(1, 8)}&to=${instant(1, 12)}`)
        .set('x-test-user', admin)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ id: RESOURCE_ID, quantity: 30, free: 18 });
    });

    it('refuses a window that ends before it begins, and one longer than 400 days', async () => {
      await http().get(`/api/v1/resources/availability?from=${instant(1, 12)}&to=${instant(1, 8)}`).set('x-test-user', admin).expect(400);
      const long = await http().get(`/api/v1/resources/availability?from=${instant(1, 8)}&to=${instant(500, 8)}`).set('x-test-user', admin).expect(400);
      expect(long.body.detail).toBe('The window is at most 400 days.');
    });

    it('creates a resource for the caller’s school, whatever school the body says', async () => {
      table('resource', 'create').mockResolvedValue(resourceRow());

      const response = await http()
        .post('/api/v1/resources')
        .set('x-test-user', admin)
        .send({ name: ' Surfplattor ', resourceTypeId: TYPE_ID, quantity: 30, requiresApproval: true })
        .expect(201);

      expect(response.body).toMatchObject({ id: RESOURCE_ID, name: 'Surfplattor', quantity: 30 });
      expect(table('resource', 'create').mock.calls[0]![0].data).toMatchObject({ schoolId: SCHOOL_ID, name: 'Surfplattor', requiresApproval: true });
      await http().post('/api/v1/resources').set('x-test-user', admin).send({ name: 'X', resourceTypeId: TYPE_ID, schoolId: OTHER_ID }).expect(400);
    });

    it('changes a resource, and will not lower the quantity under what is booked ahead', async () => {
      table('resource', 'update').mockResolvedValue(resourceRow({ name: 'Plattor', quantity: 20 }));
      const changed = await http().patch(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).send({ name: 'Plattor', quantity: 20 }).expect(200);
      expect(changed.body).toMatchObject({ name: 'Plattor', quantity: 20 });

      table('resourceBooking', 'findMany').mockResolvedValue([
        { quantity: 25, startsAt: new Date(instant(1, 8)), endsAt: new Date(instant(1, 10)) },
      ]);
      const refused = await http().patch(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).send({ quantity: 10 }).expect(400);
      expect(refused.body.detail).toContain('håller upp till 25');
    });

    it('answers 404 for a resource that is not the school’s', async () => {
      table('resource', 'update').mockRejectedValue(knownError('P2025', 'Record not found'));

      await http().patch(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).send({ name: 'X' }).expect(404);
    });

    it('removes a resource nobody lets out, with a 204, and refuses one that is let out, with its code', async () => {
      table('externalBooking', 'count').mockResolvedValue(0);
      await http().delete(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).expect(204);
      expect(table('resource', 'delete')).toHaveBeenCalledWith({ where: { id: RESOURCE_ID } });

      table('externalBooking', 'count').mockResolvedValue(2);
      const refused = await http().delete(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).expect(409);
      expect(refused.body.code).toBe('RESOURCE_IS_LET_OUT');
      expect(table('resource', 'delete')).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // The bookings of resources
  // -----------------------------------------------------------------------

  describe('resource bookings', () => {
    const body = (patch: Record<string, unknown> = {}) => ({ resourceId: RESOURCE_ID, title: 'Matteprov', quantity: 3, startsAt: instant(5, 8), endsAt: instant(5, 10), ...patch });

    it('lists a teacher’s own bookings, and an administrator’s every booking with the booker’s name', async () => {
      table('resourceBooking', 'findMany').mockResolvedValue([bookingRow()]);
      table('user', 'findMany').mockResolvedValue([{ id: ADMIN_ID, firstName: 'Anna', lastName: 'Lind' }]);

      const mine = await http().get('/api/v1/resource-bookings').set('x-test-user', teacher()).expect(200);
      expect(mine.body[0]).toMatchObject({ id: BOOKING_ID, resourceName: 'Surfplattor', quantity: 3, status: 'APPROVED', bookedByName: null, external: false });
      expect(table('resourceBooking', 'findMany').mock.calls[0]![0].where).toEqual({ bookedById: ADMIN_ID });

      const all = await http().get('/api/v1/resource-bookings?status=APPROVED&mine=false').set('x-test-user', admin).expect(200);
      expect(all.body[0]).toMatchObject({ bookedByName: 'Anna Lind' });
      expect(table('resourceBooking', 'findMany').mock.calls[1]![0].where).toEqual({ status: 'APPROVED' });

      await http().get('/api/v1/resource-bookings?mine=true').set('x-test-user', admin).expect(200);
      expect(table('resourceBooking', 'findMany').mock.calls[2]![0].where).toEqual({ bookedById: ADMIN_ID });
    });

    it('books for the caller: waiting for a decision when the resource requires approval and the booker is staff, approved for an administrator', async () => {
      table('resource', 'findUnique').mockResolvedValue({ id: RESOURCE_ID, requiresApproval: true, quantity: 30 });
      table('resourceBooking', 'create').mockImplementation(({ data }: { data: { status: string } }) => Promise.resolve({ id: BOOKING_ID, status: data.status }));

      const waiting = await http().post('/api/v1/resource-bookings').set('x-test-user', teacher()).send(body()).expect(201);
      expect(waiting.body).toEqual({ id: BOOKING_ID, status: 'PENDING' });
      const approved = await http().post('/api/v1/resource-bookings').set('x-test-user', admin).send(body()).expect(201);
      expect(approved.body).toEqual({ id: BOOKING_ID, status: 'APPROVED' });
      expect(table('resourceBooking', 'create').mock.calls[0]![0].data).toMatchObject({ schoolId: SCHOOL_ID, bookedById: ADMIN_ID, quantity: 3 });
    });

    it('answers a quantity that is used up with a 409 and its code, and more than there are with a 400', async () => {
      table('resource', 'findUnique').mockResolvedValue({ id: RESOURCE_ID, requiresApproval: false, quantity: 30 });
      table('resourceBooking', 'create').mockRejectedValue(
        knownError('P2039', 'Database error. Code: `23P01`. Message: `ResourceBookings_quantity_is_kept: 31 of 30`'),
      );
      const used = await http().post('/api/v1/resource-bookings').set('x-test-user', admin).send(body()).expect(409);
      expect(used.body.code).toBe('RESOURCE_QUANTITY_USED');

      const many = await http().post('/api/v1/resource-bookings').set('x-test-user', admin).send(body({ quantity: 31 })).expect(400);
      expect(many.body.detail).toBe('Det finns bara 30 av resursen.');
    });

    it('cancels a booking for its owner or an administrator, and refuses one that is closed', async () => {
      table('resourceBooking', 'findUnique').mockResolvedValue({ id: BOOKING_ID, bookedById: OTHER_ID, status: 'PENDING', externalBookingId: null });
      table('resourceBooking', 'update').mockResolvedValue({ id: BOOKING_ID, status: 'CANCELLED' });
      const cancelled = await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/cancel`).set('x-test-user', admin).expect(200);
      expect(cancelled.body).toEqual({ id: BOOKING_ID, status: 'CANCELLED' });

      table('resourceBooking', 'findUnique').mockResolvedValue({ id: BOOKING_ID, bookedById: OTHER_ID, status: 'CANCELLED', externalBookingId: null });
      await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/cancel`).set('x-test-user', admin).expect(400);
    });

    it('lets an administrator decide a waiting booking once, and tells the booker', async () => {
      table('resourceBooking', 'findUnique').mockResolvedValue({
        id: BOOKING_ID,
        schoolId: SCHOOL_ID,
        bookedById: OTHER_ID,
        title: 'Matteprov',
        startsAt: new Date(instant(5, 8)),
        status: 'PENDING',
        resource: { name: 'Surfplattor' },
      });
      table('resourceBooking', 'update').mockImplementation(({ data }: { data: { status: string } }) => Promise.resolve({ id: BOOKING_ID, status: data.status }));

      const decided = await http()
        .patch(`/api/v1/resource-bookings/${BOOKING_ID}/decide`)
        .set('x-test-user', admin)
        .send({ status: 'REJECTED', note: 'Bussen är på verkstad' })
        .expect(200);

      expect(decided.body).toEqual({ id: BOOKING_ID, status: 'REJECTED' });
      expect(table('resourceBooking', 'update').mock.calls[0]![0].data).toMatchObject({ status: 'REJECTED', decidedById: ADMIN_ID, decisionNote: 'Bussen är på verkstad' });
      expect(table('notification', 'createMany').mock.calls[0]![0].data[0]).toMatchObject({
        schoolId: SCHOOL_ID,
        userId: OTHER_ID,
        type: 'ROOM_BOOKING_DECIDED',
        meta: expect.objectContaining({ status: 'REJECTED', resourceName: 'Surfplattor', note: 'Bussen är på verkstad' }),
      });

      table('resourceBooking', 'findUnique').mockResolvedValue({ id: BOOKING_ID, schoolId: SCHOOL_ID, bookedById: OTHER_ID, title: 'x', startsAt: new Date(), status: 'APPROVED', resource: { name: 'x' } });
      await http().patch(`/api/v1/resource-bookings/${BOOKING_ID}/decide`).set('x-test-user', admin).send({ status: 'APPROVED' }).expect(400);
    });
  });

  // -----------------------------------------------------------------------
  // The external bookings
  // -----------------------------------------------------------------------

  describe('external bookings', () => {
    it('previews the days of a rule, each with what stands in its way', async () => {
      world.facts = [
        { kind: 'LESSON', startsAt: new Date(`${day(10)}T00:00:00.000Z`), endsAt: new Date(`${day(10)}T23:59:00.000Z`), label: 'Idrott 7A', date: null, dow: null, smin: null, emin: null },
      ];

      // A POST that writes nothing, and answers 201 as the route is documented (docs/api/openapi.json).
      const response = await http().post('/api/v1/external-bookings/preview').set('x-test-user', admin).send(rule()).expect(201);

      expect(response.body).toMatchObject({ count: 7, blocked: 1, warned: 0, framesMissing: true });
      expect(response.body.occurrences).toHaveLength(7);
      expect(response.body.occurrences[0]).toEqual({
        date: day(10),
        startsAt: expect.stringMatching(/T1[67]:00:00\.000Z$/),
        endsAt: expect.stringMatching(/T1[89]:00:00\.000Z$/),
        conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }],
      });
      expect(table('externalBooking', 'create')).not.toHaveBeenCalled();
    });

    it('registers a series: the series and one booking for each of its days', async () => {
      table('externalBooking', 'create').mockResolvedValue({ id: SERIES_ID });

      const response = await http()
        .post('/api/v1/external-bookings')
        .set('x-test-user', admin)
        .send(registration({ contactEmail: 'kim@forening.example', purpose: 'Träning', skipConflicts: false }))
        .expect(201);

      expect(response.body).toEqual({ id: SERIES_ID, created: 7, skipped: [] });
      expect(table('externalBooking', 'create').mock.calls[0]![0].data).toMatchObject({
        schoolId: SCHOOL_ID,
        roomId: ROOM_ID,
        organisation: 'Idrottsföreningen',
        contactName: 'Kim Kontakt',
        contactPhone: '070-1234567',
        contactEmail: 'kim@forening.example',
        registeredById: ADMIN_ID,
      });
      expect(table('roomBooking', 'createMany').mock.calls[0]![0].data).toHaveLength(7);
    });

    it('registers a series of a resource with the quantity the hirer holds', async () => {
      world.statics = { ...world.statics, room: null, resource: { id: RESOURCE_ID, name: 'Surfplattor', quantity: 30 } };
      table('externalBooking', 'create').mockResolvedValue({ id: SERIES_ID });

      const response = await http()
        .post('/api/v1/external-bookings')
        .set('x-test-user', admin)
        .send(registration({ target: 'RESOURCE', roomId: undefined, resourceId: RESOURCE_ID, resourceQuantity: 10 }))
        .expect(201);

      expect(response.body.created).toBe(7);
      expect(table('resourceBooking', 'createMany').mock.calls[0]![0].data[0]).toMatchObject({ resourceId: RESOURCE_ID, quantity: 10 });
      expect(table('roomBooking', 'createMany')).not.toHaveBeenCalled();
    });

    it('refuses a series with a day in the way, with its code and the number of days, and books the free days when told to skip', async () => {
      world.facts = [
        { kind: 'LESSON', startsAt: new Date(`${day(10)}T00:00:00.000Z`), endsAt: new Date(`${day(10)}T23:59:00.000Z`), label: 'Idrott 7A', date: null, dow: null, smin: null, emin: null },
      ];
      table('externalBooking', 'create').mockResolvedValue({ id: SERIES_ID });

      const refused = await http().post('/api/v1/external-bookings').set('x-test-user', admin).send(registration()).expect(409);
      expect(refused.body.code).toBe('EXTERNAL_BOOKING_CONFLICTS');
      expect(refused.body.params).toEqual({ blocked: 1 });
      expect(table('externalBooking', 'create')).not.toHaveBeenCalled();

      const skipped = await http().post('/api/v1/external-bookings').set('x-test-user', admin).send(registration({ skipConflicts: true })).expect(201);
      expect(skipped.body.created).toBe(6);
      expect(skipped.body.skipped).toEqual([{ date: day(10), conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] }]);
    });

    it('refuses a registration with no way to reach the contact, and a series that starts in the past', async () => {
      const contact = await http().post('/api/v1/external-bookings').set('x-test-user', admin).send(registration({ contactPhone: undefined })).expect(400);
      expect(contact.body.detail).toBe('Ange telefonnummer eller e-postadress till kontaktpersonen.');

      const past = await http().post('/api/v1/external-bookings').set('x-test-user', admin).send(registration({ startDate: day(-3), endDate: day(3) })).expect(400);
      expect(past.body.detail).toBe('A series cannot start in the past.');
    });

    it('lists the series by state, the active ones when none is asked for', async () => {
      table('externalBooking', 'findMany').mockResolvedValue([seriesRow()]);
      world.counts = [{ id: SERIES_ID, total: 7, upcoming: 7, cancelled: 0 }];
      table('user', 'findMany').mockResolvedValue([{ id: ADMIN_ID, firstName: 'Eva', lastName: 'Expedition' }]);

      const response = await http().get('/api/v1/external-bookings').set('x-test-user', admin).expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        id: SERIES_ID,
        target: { kind: 'ROOM', id: ROOM_ID, name: 'Gymnastiksalen' },
        organisation: 'Idrottsföreningen',
        contactPhone: '070-1234567',
        startTime: '18:00',
        endTime: '20:00',
        registeredByName: 'Eva Expedition',
        days: { total: 7, upcoming: 7, cancelled: 0, skipped: [] },
        clashes: 0,
      });
      expect(table('externalBooking', 'findMany').mock.calls[0]![0].where).toMatchObject({ cancelledAt: null, endDate: { gte: expect.any(Date) } });

      for (const state of ['ended', 'cancelled', 'all']) {
        await http().get(`/api/v1/external-bookings?state=${state}`).set('x-test-user', admin).expect(200);
      }
      expect(table('externalBooking', 'findMany').mock.calls[3]![0].where).toEqual({});
    });

    it('lists the days that stand in a room with a lesson, and takes "clashes" for that and not for an id', async () => {
      world.clashes = [
        {
          seriesId: SERIES_ID,
          dayId: DAY_ID,
          organisation: 'Idrottsföreningen',
          targetName: 'Gymnastiksalen',
          startsAt: new Date(instant(10, 17)),
          endsAt: new Date(instant(10, 19)),
          lesson: 'Idrott 7A',
        },
      ];

      const response = await http().get('/api/v1/external-bookings/clashes').set('x-test-user', admin).expect(200);

      expect(response.body).toEqual([
        {
          seriesId: SERIES_ID,
          dayId: DAY_ID,
          organisation: 'Idrottsföreningen',
          targetName: 'Gymnastiksalen',
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          startsAt: instant(10, 17),
          endsAt: instant(10, 19),
          lesson: 'Idrott 7A',
        },
      ]);
      // Had it been read as a series, the id would not have been a uuid (400) and the series would have been asked for.
      expect(table('externalBooking', 'findUnique')).not.toHaveBeenCalled();
    });

    it('answers a series with its days, and 400 for an id that is not a uuid, 404 for one that is not the school’s', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue(seriesRow());
      table('roomBooking', 'findMany').mockResolvedValue([{ id: DAY_ID, startsAt: new Date(instant(10, 17)), endsAt: new Date(instant(10, 19)), status: 'APPROVED' }]);
      world.clashes = [{ seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: new Date(instant(10, 17)), endsAt: new Date(instant(10, 19)), lesson: 'Idrott 7A' }];

      const response = await http().get(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).expect(200);

      expect(response.body.id).toBe(SERIES_ID);
      expect(response.body.clashes).toBe(1);
      expect(response.body.occurrences).toEqual([
        {
          id: DAY_ID,
          date: expect.any(String),
          startsAt: instant(10, 17),
          endsAt: instant(10, 19),
          status: 'APPROVED',
          conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }],
        },
      ]);

      await http().get('/api/v1/external-bookings/not-an-id').set('x-test-user', admin).expect(400);
      table('externalBooking', 'findUnique').mockResolvedValue(null);
      await http().get(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).expect(404);
    });

    it('changes who a series is for, and will not take the way to reach the contact away', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue({ contactPhone: '070-1234567', contactEmail: null });
      table('externalBooking', 'update').mockResolvedValue(seriesRow({ organisation: 'Nya Föreningen' }));

      const response = await http().patch(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).send({ organisation: ' Nya Föreningen ' }).expect(200);
      expect(response.body.organisation).toBe('Nya Föreningen');
      expect(table('externalBooking', 'update').mock.calls[0]![0].data).toEqual({ organisation: 'Nya Föreningen' });

      const refused = await http().patch(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).send({ contactPhone: null }).expect(400);
      expect(refused.body.detail).toBe('Ange telefonnummer eller e-postadress till kontaktpersonen.');
      expect(table('externalBooking', 'update')).toHaveBeenCalledTimes(1);
    });

    it('cancels a series and the days of it that have not started, once', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue({ cancelledAt: null });
      table('externalBooking', 'update').mockResolvedValue(seriesRow({ cancelledAt: new Date('2027-01-20T10:00:00.000Z') }));
      table('roomBooking', 'updateMany').mockResolvedValue({ count: 7 });
      table('resourceBooking', 'updateMany').mockResolvedValue({ count: 0 });

      const response = await http().patch(`/api/v1/external-bookings/${SERIES_ID}/cancel`).set('x-test-user', admin).expect(200);

      expect(response.body.cancelledAt).toBe('2027-01-20T10:00:00.000Z');
      expect(table('roomBooking', 'updateMany').mock.calls[0]![0]).toMatchObject({
        where: { externalBookingId: SERIES_ID, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'CANCELLED' },
      });

      table('externalBooking', 'findUnique').mockResolvedValue({ cancelledAt: new Date() });
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/cancel`).set('x-test-user', admin).expect(400);
    });

    it('removes a series that is over or cancelled with a 204, and refuses one that is running, with its code', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue({ cancelledAt: new Date(), endDate: new Date(`${day(30)}T00:00:00.000Z`) });
      await http().delete(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).expect(204);
      expect(table('externalBooking', 'delete')).toHaveBeenCalledWith({ where: { id: SERIES_ID } });

      table('externalBooking', 'findUnique').mockResolvedValue({ cancelledAt: null, endDate: new Date(`${day(30)}T00:00:00.000Z`) });
      const running = await http().delete(`/api/v1/external-bookings/${SERIES_ID}`).set('x-test-user', admin).expect(409);
      expect(running.body.code).toBe('EXTERNAL_BOOKING_IS_RUNNING');
      expect(table('externalBooking', 'delete')).toHaveBeenCalledTimes(1);
    });

    it('cancels one day of a series, and refuses a day that is already cancelled or is not the series’', async () => {
      table('externalBooking', 'findUnique').mockResolvedValue({ roomId: ROOM_ID });
      table('roomBooking', 'findFirst').mockResolvedValue({ id: DAY_ID, startsAt: new Date(instant(10, 17)), endsAt: new Date(instant(10, 19)), status: 'APPROVED' });

      const response = await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/${DAY_ID}/cancel`).set('x-test-user', admin).expect(200);

      expect(response.body).toEqual({ id: DAY_ID, date: expect.any(String), startsAt: instant(10, 17), endsAt: instant(10, 19), status: 'CANCELLED', conflicts: [] });
      expect(table('roomBooking', 'update')).toHaveBeenCalledWith({ where: { id: DAY_ID }, data: { status: 'CANCELLED' } });

      table('roomBooking', 'findFirst').mockResolvedValue({ id: DAY_ID, startsAt: new Date(instant(10, 17)), endsAt: new Date(instant(10, 19)), status: 'CANCELLED' });
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/${DAY_ID}/cancel`).set('x-test-user', admin).expect(400);
      table('roomBooking', 'findFirst').mockResolvedValue(null);
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/${DAY_ID}/cancel`).set('x-test-user', admin).expect(404);
      await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/not-an-id/cancel`).set('x-test-user', admin).expect(400);
    });

    it('turns a room that is let out away from its deleter, with the code the web reads', async () => {
      table('externalBooking', 'count').mockResolvedValue(1);

      const response = await http().delete(`/api/v1/rooms/${ROOM_ID}`).set('x-test-user', admin).expect(409);

      expect(response.body.code).toBe('ROOM_IS_LET_OUT');
    });
  });

  // -----------------------------------------------------------------------
  // The utilisation report
  // -----------------------------------------------------------------------

  describe('utilisation', () => {
    const arrange = () => {
      table('frameTime', 'findMany').mockResolvedValue([
        { minGradeLevel: 0, maxGradeLevel: 12, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00.000Z'), endTime: new Date('1970-01-01T16:00:00.000Z') },
      ]);
      table('room', 'findMany').mockResolvedValue([{ id: ROOM_ID, name: 'Gymnastiksalen', minGradeLevel: null, maxGradeLevel: null }]);
      table('resource', 'findMany').mockResolvedValue([{ id: RESOURCE_ID, name: 'Surfplattor', quantity: 30 }]);
      table('roomBooking', 'findMany').mockResolvedValue([
        { roomId: ROOM_ID, startsAt: new Date('2027-02-02T17:00:00.000Z'), endsAt: new Date('2027-02-02T19:00:00.000Z') },
      ]);
    };

    it('answers the report as JSON, per room and resource, for the period asked', async () => {
      arrange();

      const response = await http().get('/api/v1/utilisation?from=2027-02-01&to=2027-02-07').set('x-test-user', admin).expect(200);

      expect(response.body).toMatchObject({ from: '2027-02-01', to: '2027-02-07', timezone: 'Europe/Stockholm', openFrom: '07:00', openTo: '22:00', framesMissing: false, weekStarts: ['2027-02-01'] });
      expect(response.body.rows.map((row: { kind: string; name: string }) => [row.kind, row.name])).toEqual([
        ['ROOM', 'Gymnastiksalen'],
        ['RESOURCE', 'Surfplattor'],
      ]);
      expect(response.body.rows[0].total).toMatchObject({ schoolMinutes: 2400, bookedOutsideMinutes: 120 });
    });

    it('filters on the kind and takes the open hours it is given', async () => {
      arrange();

      const response = await http().get('/api/v1/utilisation?from=2027-02-01&to=2027-02-07&kind=ROOM&openFrom=06:00&openTo=23:00').set('x-test-user', admin).expect(200);

      expect(response.body.rows.map((row: { kind: string }) => row.kind)).toEqual(['ROOM']);
      expect(response.body).toMatchObject({ openFrom: '06:00', openTo: '23:00' });
    });

    it('refuses a period of more than 400 days and open hours that run backwards, from the service', async () => {
      await http().get('/api/v1/utilisation?from=2026-01-01&to=2027-02-05').set('x-test-user', admin).expect(400);
      await http().get('/api/v1/utilisation?from=2027-02-01&to=2027-02-07&openFrom=18:00&openTo=08:00').set('x-test-user', admin).expect(400);
    });

    it('answers the same figures as a file Excel opens: UTF-8 with a BOM, ;, and a name for the download', async () => {
      arrange();

      const response = await http().get('/api/v1/utilisation/csv?from=2027-02-01&to=2027-02-07').set('x-test-user', admin).expect(200);

      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe('attachment; filename="utnyttjande-2027-02-01-2027-02-07.csv"');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text.startsWith('﻿')).toBe(true);
      const lines = response.text.slice(1).split('\r\n');
      expect(lines[0]).toBe('typ;namn;vecka;skoltid_minuter;bokat_skoltid_minuter;andel_skoltid_procent;utanfor_skoltid_minuter;bokat_utanfor_skoltid_minuter;andel_utanfor_skoltid_procent');
      expect(lines[1]!.startsWith('Sal;Gymnastiksalen;Hela perioden;2400;0;0,0;')).toBe(true);
      expect(lines.some((line) => line.startsWith('Resurs;Surfplattor;2027-02-01;'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // What a request must be
  // -----------------------------------------------------------------------

  describe('validation', () => {
    /** A 400 from the pipe: the request is refused before the service, and so before the database, is asked. */
    const refuses = (verb: 'post' | 'patch', path: string, body: unknown) => async () => {
      await http()[verb](path).set('x-test-user', admin).send(body as object).expect(400);
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    };

    const longText = (length: number) => 'x'.repeat(length);

    it('answers a text of only spaces as it answers an empty one: a 400 problem that names the field, and nothing reaches the table', async () => {
      const blank = await http().post('/api/v1/resource-types').set('x-test-user', admin).send({ name: '   ' }).expect(400);
      const empty = await http().post('/api/v1/resource-types').set('x-test-user', admin).send({ name: '' }).expect(400);
      expect(blank.type).toBe('application/problem+json');
      expect(blank.body).toMatchObject({ status: 400, errors: { body: ['name must be longer than or equal to 1 characters'] } });
      expect(blank.body.errors).toEqual(empty.body.errors);
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
      expect(table('resourceType', 'create')).not.toHaveBeenCalled();
    });

    describe('resource types and resources', () => {
      it.each([
        ['no name', {}],
        ['a blank name', { name: '' }],
        ['a name of only spaces, which the table counts as nothing', { name: '   ' }],
        ['a name of 61 characters', { name: longText(61) }],
        ['a name that is a number', { name: 5 }],
        ['a field it does not know', { name: 'Aulan', schoolId: SCHOOL_ID }],
      ])('refuses a kind with %s', (_label, body) => refuses('post', '/api/v1/resource-types', body)());

      it('refuses a rename to a blank or a long name, and an id that is not a uuid', async () => {
        await refuses('patch', `/api/v1/resource-types/${TYPE_ID}`, { name: '' })();
        await refuses('patch', `/api/v1/resource-types/${TYPE_ID}`, { name: '  \t ' })();
        await refuses('patch', `/api/v1/resource-types/${TYPE_ID}`, { name: longText(61) })();
        await refuses('patch', '/api/v1/resource-types/not-an-id', { name: 'x' })();
        await http().delete('/api/v1/resource-types/not-an-id').set('x-test-user', admin).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });

      const good = { name: 'Surfplattor', resourceTypeId: TYPE_ID };
      it.each([
        ['no name', { resourceTypeId: TYPE_ID }],
        ['a name of only spaces', { ...good, name: '   ' }],
        ['a name of 81 characters', { ...good, name: longText(81) }],
        ['no kind', { name: 'Surfplattor' }],
        ['a kind that is not a uuid', { ...good, resourceTypeId: 'plattor' }],
        ['a quantity of 0', { ...good, quantity: 0 }],
        ['a quantity of 1001', { ...good, quantity: 1001 }],
        ['a quantity that is not whole', { ...good, quantity: 1.5 }],
        ['a site that is not a uuid', { ...good, siteId: 'norra' }],
        ['a place of 121 characters', { ...good, place: longText(121) }],
        ['an approval switch that is not a boolean', { ...good, requiresApproval: 'yes' }],
      ])('refuses a resource with %s', (_label, body) => refuses('post', '/api/v1/resources', body)());

      it.each([
        ['a blank name', { name: '' }],
        ['a name of only spaces', { name: '   ' }],
        ['a kind that is not a uuid', { resourceTypeId: 'plattor' }],
        ['a quantity of 0', { quantity: 0 }],
        ['a quantity of 1001', { quantity: 1001 }],
        ['a site that is not a uuid', { siteId: 'norra' }],
        ['a place of 121 characters', { place: longText(121) }],
        ['an approval switch that is not a boolean', { requiresApproval: 1 }],
      ])('refuses a change of a resource to %s', (_label, body) => refuses('patch', `/api/v1/resources/${RESOURCE_ID}`, body)());

      it('takes a site and a place cleared with null', async () => {
        table('resource', 'update').mockResolvedValue(resourceRow());
        await http().patch(`/api/v1/resources/${RESOURCE_ID}`).set('x-test-user', admin).send({ siteId: null, place: null }).expect(200);
        expect(table('resource', 'update').mock.calls[0]![0].data).toEqual({ siteId: null, place: null });
      });

      it('refuses an id that is not a uuid, and a window that is not an instant', async () => {
        await refuses('patch', '/api/v1/resources/not-an-id', { name: 'x' })();
        await http().delete('/api/v1/resources/not-an-id').set('x-test-user', admin).expect(400);
        await http().get('/api/v1/resources/availability').set('x-test-user', admin).expect(400);
        await http().get('/api/v1/resources/availability?from=2027-02-01&to=2027-02-02').set('x-test-user', admin).expect(400);
        await http().get(`/api/v1/resources/availability?from=${instant(1, 8)}&to=${instant(1, 12)}&extra=1`).set('x-test-user', admin).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });

    describe('resource bookings', () => {
      const good = { resourceId: RESOURCE_ID, title: 'Matteprov', startsAt: instant(5, 8), endsAt: instant(5, 10) };
      it.each([
        ['a resource that is not a uuid', { ...good, resourceId: 'plattor' }],
        ['no title', { ...good, title: '' }],
        ['a title of only spaces', { ...good, title: '   ' }],
        ['a title of 121 characters', { ...good, title: longText(121) }],
        ['a quantity of 0', { ...good, quantity: 0 }],
        ['a quantity of 1001', { ...good, quantity: 1001 }],
        ['a start that is not a date', { ...good, startsAt: 'i morgon' }],
        ['an end that is not a date', { ...good, endsAt: '18/8 kl 17' }],
        ['a field it does not know', { ...good, status: 'APPROVED' }],
      ])('refuses a booking with %s', (_label, body) => refuses('post', '/api/v1/resource-bookings', body)());

      it('refuses an end that is not after the start, and one in the past, from the service', async () => {
        table('resource', 'findUnique').mockResolvedValue({ id: RESOURCE_ID, requiresApproval: false, quantity: 30 });
        const backwards = await http().post('/api/v1/resource-bookings').set('x-test-user', admin).send({ ...good, endsAt: good.startsAt }).expect(400);
        expect(backwards.body.detail).toBe('endsAt must be after startsAt.');
        const past = await http().post('/api/v1/resource-bookings').set('x-test-user', admin).send({ ...good, startsAt: instant(-5, 8), endsAt: instant(-5, 10) }).expect(400);
        expect(past.body.detail).toBe('Bookings must be in the future.');
        expect(table('resourceBooking', 'create')).not.toHaveBeenCalled();
      });

      it('refuses a decision that is neither, one with a long note, and ids that are not uuids; and a list filter it does not know', async () => {
        await refuses('patch', `/api/v1/resource-bookings/${BOOKING_ID}/decide`, { status: 'MAYBE' })();
        await refuses('patch', `/api/v1/resource-bookings/${BOOKING_ID}/decide`, { status: 'PENDING' })();
        await refuses('patch', `/api/v1/resource-bookings/${BOOKING_ID}/decide`, { status: 'APPROVED', note: longText(501) })();
        await refuses('patch', '/api/v1/resource-bookings/not-an-id/decide', { status: 'APPROVED' })();
        await http().patch('/api/v1/resource-bookings/not-an-id/cancel').set('x-test-user', admin).expect(400);
        await http().get('/api/v1/resource-bookings?status=DONE').set('x-test-user', admin).expect(400);
        await http().get('/api/v1/resource-bookings?mine=maybe').set('x-test-user', admin).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });

    describe('external bookings', () => {
      it.each([
        ['no target', rule({ target: undefined })],
        ['a target that is neither', rule({ target: 'HALL' })],
        ['a room that is not a uuid', rule({ roomId: 'gympasalen' })],
        ['a resource that is not a uuid', rule({ target: 'RESOURCE', roomId: undefined, resourceId: 'plattor' })],
        ['a quantity of 0', rule({ target: 'RESOURCE', roomId: undefined, resourceId: RESOURCE_ID, resourceQuantity: 0 })],
        ['a quantity of 1001', rule({ target: 'RESOURCE', roomId: undefined, resourceId: RESOURCE_ID, resourceQuantity: 1001 })],
        ['no weekdays', rule({ weekdays: [] })],
        ['a weekday 0', rule({ weekdays: [0] })],
        ['a weekday 8', rule({ weekdays: [8] })],
        ['a weekday that is not whole', rule({ weekdays: [1.5] })],
        ['a weekday twice', rule({ weekdays: [2, 2] })],
        ['eight weekdays', rule({ weekdays: [1, 2, 3, 4, 5, 6, 7, 7] })],
        ['weekdays that are not a list', rule({ weekdays: 2 })],
        ['an interval of 0 weeks', rule({ intervalWeeks: 0 })],
        ['an interval of 5 weeks', rule({ intervalWeeks: 5 })],
        ['a start date that is not a date', rule({ startDate: 'imorgon' })],
        ['a start date that does not exist', rule({ startDate: '2027-02-30' })],
        ['an end date written with a time', rule({ endDate: `${day(16)}T00:00:00Z` })],
        ['a start time that is not a clock', rule({ startTime: '6pm' })],
        ['a start time of 24:00', rule({ startTime: '24:00' })],
        ['a start time without its leading zero', rule({ startTime: '9:00' })],
        ['an end time of 18:60', rule({ endTime: '18:60' })],
        ['a field it does not know', rule({ cancelled: true })],
      ])('refuses a rule with %s, in the preview and in the registration', async (_label, body) => {
        await http().post('/api/v1/external-bookings/preview').set('x-test-user', admin).send(body).expect(400);
        await http().post('/api/v1/external-bookings').set('x-test-user', admin).send({ ...body, organisation: 'Föreningen', contactName: 'Kim', contactPhone: '070-1234567' }).expect(400);
        expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
      });

      it.each([
        ['no organisation', registration({ organisation: undefined })],
        ['a blank organisation', registration({ organisation: '' })],
        ['an organisation of only spaces', registration({ organisation: '   ' })],
        ['a contact name of only spaces', registration({ contactName: ' \t ' })],
        ['a telephone number of 4 characters of which 2 are spaces', registration({ contactPhone: ' 12 ' })],
        ['an organisation of 121 characters', registration({ organisation: longText(121) })],
        ['no contact name', registration({ contactName: undefined })],
        ['a contact name of 121 characters', registration({ contactName: longText(121) })],
        ['a telephone number of 2 characters', registration({ contactPhone: '07' })],
        ['a telephone number of 41 characters', registration({ contactPhone: longText(41) })],
        ['an address that is not one', registration({ contactEmail: 'kim at forening' })],
        ['an address of 255 characters', registration({ contactEmail: `${longText(246)}@test.example` })],
        ['a purpose of 121 characters', registration({ purpose: longText(121) })],
        ['a note of 501 characters', registration({ note: longText(501) })],
        ['a skip switch that is not a boolean', registration({ skipConflicts: 'yes' })],
      ])('refuses a registration with %s', async (_label, body) => {
        await http().post('/api/v1/external-bookings').set('x-test-user', admin).send(body).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
        expect(table('externalBooking', 'create')).not.toHaveBeenCalled();
      });

      it.each([
        ['a blank organisation', { organisation: '' }],
        ['an organisation of only spaces', { organisation: '  ' }],
        ['a contact name of only spaces', { contactName: '   ' }],
        ['a telephone number of 4 characters of which 2 are spaces', { contactPhone: ' 12 ' }],
        ['a contact name of 121 characters', { contactName: longText(121) }],
        ['a telephone number of 2 characters', { contactPhone: '07' }],
        ['an address that is not one', { contactEmail: 'kim' }],
        ['a purpose of 121 characters', { purpose: longText(121) }],
        ['a note of 501 characters', { note: longText(501) }],
        ['a rule, which a series does not change', { weekdays: [1] }],
      ])('refuses a change of a series to %s', (_label, body) => refuses('patch', `/api/v1/external-bookings/${SERIES_ID}`, body)());

      it('refuses an id that is not a uuid on every path that has one, and a state it does not know', async () => {
        await refuses('patch', '/api/v1/external-bookings/not-an-id', { note: 'x' })();
        await http().patch('/api/v1/external-bookings/not-an-id/cancel').set('x-test-user', admin).expect(400);
        await http().delete('/api/v1/external-bookings/not-an-id').set('x-test-user', admin).expect(400);
        await http().patch(`/api/v1/external-bookings/${SERIES_ID}/days/not-an-id/cancel`).set('x-test-user', admin).expect(400);
        await http().patch(`/api/v1/external-bookings/not-an-id/days/${DAY_ID}/cancel`).set('x-test-user', admin).expect(400);
        await http().get('/api/v1/external-bookings?state=soon').set('x-test-user', admin).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });

    describe('utilisation', () => {
      it.each([
        ['no period', ''],
        ['no end', '?from=2027-02-01'],
        ['a start that is not a date', '?from=1+feb&to=2027-02-07'],
        ['a date that does not exist', '?from=2027-02-30&to=2027-03-07'],
        ['a kind it does not know', '?from=2027-02-01&to=2027-02-07&kind=HALL'],
        ['an openFrom that is not a clock', '?from=2027-02-01&to=2027-02-07&openFrom=7'],
        ['an openTo of 25:00', '?from=2027-02-01&to=2027-02-07&openTo=25:00'],
        ['a parameter it does not know', '?from=2027-02-01&to=2027-02-07&week=5'],
      ])('refuses a report with %s, as JSON and as a file', async (_label, query) => {
        await http().get(`/api/v1/utilisation${query}`).set('x-test-user', admin).expect(400);
        await http().get(`/api/v1/utilisation/csv${query}`).set('x-test-user', admin).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });
  });
});
