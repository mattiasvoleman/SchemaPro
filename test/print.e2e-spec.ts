import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Utskrift over HTTP (20261102090000): the admin's print set and the
 * validity of a week resolve, take what the pages send and refuse what they
 * must not; the set is the admin's and the validity any member's; and the
 * school's embedding settings are stored as frame-ancestors sources. The
 * database is mocked: what the doors answer is RLS sections 140–143's and the
 * adapter probe's (pr-a…pr-d).
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SET = {
  kind: 'GROUP',
  school: 'Demoskolan',
  academicYearId: YEAR_ID,
  week: { from: '2026-10-12', to: '2026-10-18', isoWeek: '2026-W42' },
  sheets: [{ id: '55555555-5555-4555-8555-555555555555', title: '7A', days: [] }],
};

/** The SQL and values of a $queryRaw call, tagged template or Prisma.sql alike. */
const statementOf = (args: unknown[]): { sql: string; values: unknown[] } => {
  const [first, ...rest] = args as [unknown, ...unknown[]];
  if (Array.isArray(first)) return { sql: (first as string[]).join('?'), values: rest };
  const sql = first as { strings?: string[]; values?: unknown[] };
  return { sql: (sql.strings ?? []).join('?'), values: sql.values ?? [] };
};

describe('Utskrift (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const as = (role: string) => asUser({ role: role as never, schoolId: SCHOOL_ID });
  let printed: unknown;

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    printed = SET;
    harness.tx.publicationSettings.findUnique.mockResolvedValue(null);
    harness.tx.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const { sql } = statementOf(args);
      if (sql.includes('app.print_timetables(')) return [{ doc: printed }];
      if (sql.includes('app.timetable_validity(')) return [{ from: '2026-08-17', to: '2027-06-11' }];
      return [];
    });
  });

  const printCall = () =>
    harness.tx.$queryRaw.mock.calls.map((call: unknown[]) => statementOf(call)).find((statement) => statement.sql.includes('app.print_timetables('));
  const validityCall = () =>
    harness.tx.$queryRaw.mock.calls.map((call: unknown[]) => statementOf(call)).find((statement) => statement.sql.includes('app.timetable_validity('));

  describe('the print set', () => {
    it('answers the admin the set with its läsår\'s validity, naming teachers as the school\'s public pages do', async () => {
      const response = await request(http())
        .get('/api/v1/print/timetables?kind=GROUP&date=2026-10-14')
        .set('x-test-user', as('SCHOOL_ADMIN'))
        .expect(200);
      expect(response.body).toEqual({
        ...SET,
        validity: [{ from: '2026-08-17', to: '2027-06-11' }],
        teachers: 'NONE',
        meals: true,
      });
      expect(printCall()?.values).toEqual(['GROUP', '2026-10-14', 'NONE', true]);
      expect(validityCall()?.values).toEqual([SET.week.from, SET.week.to, SET.academicYearId]);
    });

    it('signs a teachers\' set when the school names nobody', async () => {
      await request(http()).get('/api/v1/print/timetables?kind=TEACHER&date=2026-10-14').set('x-test-user', as('SCHOOL_ADMIN')).expect(200);
      expect(printCall()?.values).toEqual(['TEACHER', '2026-10-14', 'SIGNATURE', true]);
    });

    it('takes the display and the meals the admin chose', async () => {
      await request(http())
        .get('/api/v1/print/timetables?kind=ROOM&date=2026-10-14&teachers=NAME&meals=false')
        .set('x-test-user', as('SCHOOL_ADMIN'))
        .expect(200);
      expect(printCall()?.values).toEqual(['ROOM', '2026-10-14', 'NAME', false]);
    });

    it('follows the school\'s own display and meals when the admin says nothing', async () => {
      harness.tx.publicationSettings.findUnique.mockResolvedValue({ publicTeacherDisplay: 'NAME', publicShowMeals: false });
      await request(http()).get('/api/v1/print/timetables?kind=GROUP&date=2026-10-14').set('x-test-user', as('SCHOOL_ADMIN')).expect(200);
      expect(printCall()?.values).toEqual(['GROUP', '2026-10-14', 'NAME', false]);
    });

    it('is the admin\'s: a teacher, a pupil and a guardian are refused', async () => {
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
        await request(http()).get('/api/v1/print/timetables?kind=GROUP&date=2026-10-14').set('x-test-user', as(role)).expect(403);
      }
      expect(printCall()).toBeUndefined();
    });

    it('refuses a query the page would not send, before asking the database', async () => {
      for (const query of [
        'date=2026-10-14',
        'kind=CLASS&date=2026-10-14',
        'kind=GROUP',
        'kind=GROUP&date=14/10/2026',
        'kind=GROUP&date=2026-02-30',
        'kind=GROUP&date=2026-10-14&teachers=FULL',
        'kind=GROUP&date=2026-10-14&meals=yes',
        'kind=GROUP&date=2026-10-14&school=other',
      ]) {
        await request(http()).get(`/api/v1/print/timetables?${query}`).set('x-test-user', as('SCHOOL_ADMIN')).expect(400);
      }
      expect(printCall()).toBeUndefined();
    });

    it('refuses a teachers\' set that names nobody, and says a week in no läsår is not there', async () => {
      const unnamed = await request(http())
        .get('/api/v1/print/timetables?kind=TEACHER&date=2026-10-14&teachers=NONE')
        .set('x-test-user', as('SCHOOL_ADMIN'))
        .expect(400);
      expect(unnamed.body.code).toBe('PRINT_TEACHERS_UNNAMED');
      printed = null;
      const outside = await request(http())
        .get('/api/v1/print/timetables?kind=GROUP&date=2031-01-07')
        .set('x-test-user', as('SCHOOL_ADMIN'))
        .expect(404);
      expect(outside.body.code).toBe('PRINT_WEEK_OUTSIDE_YEARS');
    });
  });

  describe('the validity of a week', () => {
    it('answers every member of the school the week of the day and its periods', async () => {
      for (const role of ['SCHOOL_ADMIN', 'TEACHER', 'STUDENT', 'GUARDIAN']) {
        const response = await request(http()).get('/api/v1/timetable-validity?week=2026-10-15').set('x-test-user', as(role)).expect(200);
        expect(response.body).toEqual({
          week: { from: '2026-10-12', to: '2026-10-18' },
          validity: [{ from: '2026-08-17', to: '2027-06-11' }],
        });
      }
      const asked = harness.tx.$queryRaw.mock.calls.map((call: unknown[]) => statementOf(call)).filter((s) => s.sql.includes('app.timetable_validity('));
      // No läsår named: the database takes the one the week reaches into.
      expect(asked[0]?.values).toEqual(['2026-10-12', '2026-10-18', null]);
    });

    it('refuses a week that is no day', async () => {
      for (const week of ['', '2026-10', '2026-02-30', 'idag']) {
        await request(http()).get(`/api/v1/timetable-validity?week=${week}`).set('x-test-user', as('GUARDIAN')).expect(400);
      }
    });
  });

  describe('the embedding settings', () => {
    beforeEach(() => {
      harness.tx.publicationSettings.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
        publishMode: 'DIRECT',
        ...create,
      }));
    });

    it('stores the websites as origins: the case folded, the scheme assumed, a trailing slash and a repeat dropped', async () => {
      await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', as('SCHOOL_ADMIN'))
        .send({
          publicEmbedGroups: true,
          publicEmbedOrigins: [' Skolan.se/ ', 'https://skolan.se', 'https://www.skolan.se:8443', ''],
        })
        .expect(200);
      expect(harness.tx.publicationSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { publicEmbedGroups: true, publicEmbedOrigins: ['https://skolan.se', 'https://www.skolan.se:8443'] },
        }),
      );
    });

    it('refuses what frame-ancestors would not take as an origin, and more than ten', async () => {
      for (const origins of [
        ['http://skolan.se'],
        ['https://skolan.se/schema'],
        ['https://*.skolan.se'],
        ['https://skolan'],
        ['https://user@skolan.se'],
        ['https://skolan.se?x=1'],
        'https://skolan.se',
        [42],
        Array.from({ length: 11 }, (_, n) => `https://s${n}.se`),
      ]) {
        await request(http())
          .put('/api/v1/publication-settings')
          .set('x-test-user', as('SCHOOL_ADMIN'))
          .send({ publicEmbedOrigins: origins })
          .expect(400);
      }
      expect(harness.tx.publicationSettings.upsert).not.toHaveBeenCalled();
    });

    it('is the admin\'s to set', async () => {
      await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', as('TEACHER'))
        .send({ publicEmbedGroups: true })
        .expect(403);
    });
  });
});
