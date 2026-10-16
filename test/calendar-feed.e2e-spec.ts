import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { FEED_NOT_FOUND } from '../src/calendar-feed/public-calendar-feed.controller';
import { PER_FEED } from '../src/calendar-feed/calendar-feed-throttler.guard';
import type { FeedDocument } from '../src/calendar-feed/ics';
import { tokenHashOf } from '../src/publication/public-token';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Kalenderprenumeration over HTTP (20261112091000). A person lists, makes and
 * revokes their own feeds, and a calendar asks for one without signing in:
 * iCalendar with a weak ETag, one identical 404 for every address that is
 * no live feed, no cache between, and the feed's own rate limits. What a
 * feed may hold, who may make one and the read log are the database's
 * (RLS sections 145–148, the adapter probe); here the database is mocked.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '66666666-6666-4666-8666-666666666666';
const FEED_ID = '77777777-7777-4777-8777-777777777777';
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const OTHER = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

const WEEK: FeedDocument = {
  audience: 'GUARDIAN',
  scope: CHILD_ID,
  locale: 'sv',
  title: 'Ella',
  school: 'Demoskolan',
  timezone: 'Europe/Stockholm',
  lessons: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      date: '2026-10-12',
      start: '20261012T081000',
      end: '20261012T091000',
      startUtc: '20261012T061000Z',
      endUtc: '20261012T071000Z',
      cancelled: false,
      subject: 'Matematik',
      room: 'Sal 101',
      groups: [],
      teachers: ['ANLI'],
      substitute: false,
      version: '20261001T080000Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      date: '2026-10-13',
      start: '20261013T100000',
      end: '20261013T110000',
      startUtc: '20261013T080000Z',
      endUtc: '20261013T090000Z',
      cancelled: true,
      subject: 'Engelska',
      room: null,
      groups: [],
      teachers: [],
      substitute: false,
      version: '20261005T070000Z',
    },
  ],
  breaks: [{ id: 'b-1', name: 'Höstlov', kind: 'HOLIDAY', from: '20261026', until: '20261031', version: '20260901T120000Z' }],
};

/** The SQL and values of a $queryRaw call, tagged template or Prisma.sql alike. */
const statementOf = (args: unknown[]): { sql: string; values: unknown[] } => {
  const [first, ...rest] = args as [unknown, ...unknown[]];
  if (Array.isArray(first)) return { sql: (first as string[]).join('?'), values: rest };
  const sql = first as { strings?: string[]; values?: unknown[] };
  return { sql: (sql.strings ?? []).join('?'), values: sql.values ?? [] };
};

describe('Kalenderprenumeration (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const as = (role: Role) => asUser({ role, schoolId: SCHOOL_ID });
  let created: unknown;
  let revoked: boolean;
  let audienceOn: boolean;
  const calls = (fragment: string) =>
    harness.tx.$queryRaw.mock.calls.map((call: unknown[]) => statementOf(call)).filter((statement) => statement.sql.includes(fragment));

  beforeEach(async () => {
    // A fresh app per test: the feed's counters live in its guard.
    harness = await createTestApp();
    created = { feed: { id: FEED_ID, audience: 'GUARDIAN', studentId: CHILD_ID, locale: 'sv', createdAt: '2026-10-15T08:00:00+02:00', lastUsedAt: null } };
    revoked = true;
    audienceOn = true;
    harness.tx.calendarFeed.findMany.mockResolvedValue([
      { id: FEED_ID, audience: 'GUARDIAN', studentId: CHILD_ID, locale: 'sv', createdAt: new Date('2026-10-01T06:00:00Z'), lastUsedAt: new Date('2026-10-15T05:00:00Z') },
    ]);
    harness.tx.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const { sql, values } = statementOf(args);
      if (sql.includes('app.calendar_feed_audience_on(')) return [{ enabled: audienceOn }];
      if (sql.includes('app.calendar_feed_create(')) return [{ result: created }];
      if (sql.includes('app.calendar_feed_revoke(')) return [{ revoked }];
      if (sql.includes('app.calendar_feed_counts(')) return [{ audience: 'GUARDIAN', live: BigInt(12) }, { audience: 'TEACHER', live: 3 }];
      if (sql.includes('app.calendar_feed(')) return [{ document: values[0] === tokenHashOf(TOKEN) ? WEEK : null }];
      return [];
    });
    // Listen once, as the viewer's spec does: supertest's ephemeral ports per request meet closed sockets.
    await harness.app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await harness.close();
  });

  describe('a person\'s own feeds', () => {
    it('lists them for every audience, with whether the school has theirs on, and never an address', async () => {
      for (const role of [Role.TEACHER, Role.SCHOOL_ADMIN, Role.STUDENT, Role.GUARDIAN]) {
        const response = await request(http()).get('/api/v1/calendar-feeds').set('x-test-user', as(role)).expect(200);
        expect(response.body).toEqual({
          enabled: true,
          feeds: [{ id: FEED_ID, audience: 'GUARDIAN', studentId: CHILD_ID, locale: 'sv', createdAt: '2026-10-01T06:00:00.000Z', lastUsedAt: '2026-10-15T05:00:00.000Z' }],
        });
      }
      expect(JSON.stringify(harness.tx.calendarFeed.findMany.mock.calls)).not.toContain('tokenHash');
    });

    it('makes one with a fresh address, shown once, and passes on only its hash', async () => {
      const response = await request(http())
        .post('/api/v1/calendar-feeds')
        .set('x-test-user', as(Role.GUARDIAN))
        .send({ studentId: CHILD_ID, locale: 'en' })
        .expect(201);
      expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body.feed).toEqual({ id: FEED_ID, audience: 'GUARDIAN', studentId: CHILD_ID, locale: 'sv', createdAt: '2026-10-15T06:00:00.000Z', lastUsedAt: null });
      const [call] = calls('app.calendar_feed_create(');
      expect(call!.values).toEqual([CHILD_ID, tokenHashOf(response.body.token), 'en']);
      const again = await request(http()).post('/api/v1/calendar-feeds').set('x-test-user', as(Role.GUARDIAN)).send({ studentId: CHILD_ID }).expect(201);
      expect(again.body.token).not.toBe(response.body.token);
    });

    it('says an audience the school has off, and a child who is not the guardian\'s, as the database decides', async () => {
      created = { refused: 'AUDIENCE_OFF' };
      const off = await request(http()).post('/api/v1/calendar-feeds').set('x-test-user', as(Role.TEACHER)).send({}).expect(409);
      expect(off.body.code).toBe('CALENDAR_FEEDS_OFF');
      expect(off.body.token).toBeUndefined();
      created = { refused: 'NOT_YOURS' };
      const stranger = await request(http()).post('/api/v1/calendar-feeds').set('x-test-user', as(Role.GUARDIAN)).send({ studentId: CHILD_ID }).expect(404);
      expect(stranger.body.code).toBe('STUDENT_NOT_FOUND');
    });

    it('refuses what no page sends, before asking the database', async () => {
      for (const body of [{ studentId: 'not-an-id' }, { locale: 'de' }]) {
        await request(http()).post('/api/v1/calendar-feeds').set('x-test-user', as(Role.GUARDIAN)).send(body).expect(400);
      }
      expect(calls('app.calendar_feed_create(')).toHaveLength(0);
    });

    it('revokes one of the person\'s own, and answers 404 for any other', async () => {
      await request(http()).delete(`/api/v1/calendar-feeds/${FEED_ID}`).set('x-test-user', as(Role.STUDENT)).expect(204);
      expect(calls('app.calendar_feed_revoke(')[0]!.values).toEqual([FEED_ID]);
      revoked = false;
      const response = await request(http()).delete(`/api/v1/calendar-feeds/${FEED_ID}`).set('x-test-user', as(Role.STUDENT)).expect(404);
      expect(response.body.code).toBe('CALENDAR_FEED_NOT_FOUND');
      await request(http()).delete('/api/v1/calendar-feeds/nope').set('x-test-user', as(Role.STUDENT)).expect(404);
      expect(calls('app.calendar_feed_revoke(')).toHaveLength(2);
    });

    it('counts the live feeds per audience for the admin, and only for the admin', async () => {
      const response = await request(http()).get('/api/v1/calendar-feeds/counts').set('x-test-user', as(Role.SCHOOL_ADMIN)).expect(200);
      expect(response.body).toEqual({ TEACHER: 3, STUDENT: 0, GUARDIAN: 12 });
      for (const role of [Role.TEACHER, Role.STUDENT, Role.GUARDIAN]) {
        await request(http()).get('/api/v1/calendar-feeds/counts').set('x-test-user', as(role)).expect(403);
      }
    });

    it('lets an administrator of any profile make and revoke their own, which writes nothing of an area', async () => {
      // The expedition writes neither Publicering nor anything else a feed touches: it is the person's own.
      const expedition = asUser({ role: Role.SCHOOL_ADMIN, schoolId: SCHOOL_ID, adminProfile: 'EXPEDITION' });
      created = { feed: { id: FEED_ID, audience: 'TEACHER', studentId: null, locale: 'sv', createdAt: '2026-10-15T08:00:00+02:00', lastUsedAt: null } };
      await request(http()).post('/api/v1/calendar-feeds').set('x-test-user', expedition).send({}).expect(201);
      await request(http()).delete(`/api/v1/calendar-feeds/${FEED_ID}`).set('x-test-user', expedition).expect(204);
      await request(http()).get('/api/v1/calendar-feeds/counts').set('x-test-user', expedition).expect(200);
    });

    it('is nobody\'s without signing in', async () => {
      await request(http()).get('/api/v1/calendar-feeds').expect(401);
      await request(http()).post('/api/v1/calendar-feeds').send({}).expect(401);
    });
  });

  describe('the school\'s switch per audience', () => {
    it('stores the three, and refuses what is no switch and anyone but the admin', async () => {
      harness.tx.publicationSettings.findUnique.mockResolvedValue(null);
      harness.tx.publicationSettings.upsert.mockImplementation(async (args: { create: object }) => ({ schoolId: SCHOOL_ID, ...args.create }));
      const response = await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', as(Role.SCHOOL_ADMIN))
        .send({ calendarFeedTeachers: true, calendarFeedStudents: false, calendarFeedGuardians: true })
        .expect(200);
      expect(harness.tx.publicationSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { calendarFeedTeachers: true, calendarFeedStudents: false, calendarFeedGuardians: true } }),
      );
      expect(response.body).toMatchObject({ calendarFeedTeachers: true, calendarFeedStudents: false, calendarFeedGuardians: true });
      await request(http()).put('/api/v1/publication-settings').set('x-test-user', as(Role.SCHOOL_ADMIN)).send({ calendarFeedGuardians: 'ja' }).expect(400);
      await request(http()).put('/api/v1/publication-settings').set('x-test-user', as(Role.TEACHER)).send({ calendarFeedTeachers: true }).expect(403);
      // The switches are Publicering's: an administrator whose profile does not write it is refused, by the area.
      const expedition = asUser({ role: Role.SCHOOL_ADMIN, schoolId: SCHOOL_ID, adminProfile: 'EXPEDITION' });
      const refused = await request(http()).put('/api/v1/publication-settings').set('x-test-user', expedition).send({ calendarFeedGuardians: false }).expect(403);
      expect(refused.body.code).toBe('AREA_NOT_YOURS');
      expect(harness.tx.publicationSettings.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('the feed, as a calendar asks for it', () => {
    it('answers iCalendar with a weak ETag, no cache between, noindex, no referrer and no cookie', async () => {
      const response = await request(http()).get(`/public/v1/calendar-feeds/${TOKEN}.ics`).expect(200);
      expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
      expect(response.headers['content-disposition']).toBe('inline; filename="schema.ics"');
      expect(response.headers['cache-control']).toBe('private, no-cache');
      // Weak: two answers of one week differ by their DTSTAMP lines.
      expect(response.headers['etag']).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['set-cookie']).toBeUndefined();
      const text = response.text;
      expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
      expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Stockholm');
      // Unfolded, as a calendar reads it: the scoped UID is over 75 octets.
      expect(text.replace(/\r\n /g, '')).toContain(`UID:11111111-1111-4111-8111-111111111111.${CHILD_ID}@schemapro\r\n`);
      expect(text).toContain('DTSTART;TZID=Europe/Stockholm:20261012T081000');
      expect(text).toContain('SUMMARY:Inställd: Engelska\r\n');
      expect(text).toContain('STATUS:CANCELLED');
      expect(text).toContain('DTSTART;VALUE=DATE:20261026');
      // Asked through the feed's door with the address's hash, never the address.
      expect(calls('app.calendar_feed(')[0]!.values).toEqual([tokenHashOf(TOKEN)]);
      expect(JSON.stringify(harness.tx.$queryRaw.mock.calls)).not.toContain(TOKEN);
    });

    it('answers the address without .ics alike, and a 304 to a calendar that has the week, asked a second later or not', async () => {
      const first = await request(http()).get(`/public/v1/calendar-feeds/${TOKEN}`).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const later = await request(http()).get(`/public/v1/calendar-feeds/${TOKEN}.ics`).expect(200);
      // Written at another second (DTSTAMP), the same week: the same ETag.
      expect(later.text).not.toBe(first.text);
      expect(later.headers['etag']).toBe(first.headers['etag']);
      const again = await request(http())
        .get(`/public/v1/calendar-feeds/${TOKEN}.ics`)
        .set('If-None-Match', first.headers['etag'] as string)
        .expect(304);
      expect(again.text).toBe('');
    });

    it('answers one 404 for every address that is no live feed, kept nowhere, and asks nothing for one that cannot be', async () => {
      const unknown = await request(http()).get(`/public/v1/calendar-feeds/${OTHER}.ics`).expect(404);
      const malformed = await request(http()).get('/public/v1/calendar-feeds/short.ics').expect(404);
      for (const answer of [unknown, malformed]) {
        expect(answer.text).toBe(FEED_NOT_FOUND);
        expect(answer.headers['cache-control']).toBe('no-store');
        expect(answer.headers['x-robots-tag']).toBe('noindex, nofollow');
      }
      expect(calls('app.calendar_feed(')).toHaveLength(1);
    });

    it('stops one feed that is asked too often, says when to come back, and leaves the others', async () => {
      for (let ask = 0; ask < PER_FEED.limit; ask++) await request(http()).get(`/public/v1/calendar-feeds/${TOKEN}.ics`).expect(200);
      const refused = await request(http()).get(`/public/v1/calendar-feeds/${TOKEN}.ics`).expect(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(refused.headers['cache-control']).toBe('no-store');
      await request(http()).get(`/public/v1/calendar-feeds/${OTHER}.ics`).expect(404);
      // A malformed address is the controller's 404 and asks the database
      // nothing (the guard counts it for no feed: its spec).
      const asked = calls('app.calendar_feed(').length;
      for (let ask = 0; ask < 5; ask++) await request(http()).get('/public/v1/calendar-feeds/x.ics').expect(404);
      expect(calls('app.calendar_feed(')).toHaveLength(asked);
    });
  });
});
