import request from 'supertest';
import { createTestApp, type TestHarness } from './utils/test-app';
import { tokenHashOf } from '../src/publication/public-token';
import { OPEN_ROUTES } from '../src/publication/open-routes';
import { MISSES } from '../src/publication/viewer-miss-limiter';

/**
 * Schemavisaren over HTTP, without a principal: one identical 404 for every
 * link that does not resolve, the cache and robot headers, the ETag, no
 * cookie, and the two rate limits — per viewer address (trusted from the web
 * server only with its key) and per link. What the document may contain is
 * the database's to decide (app.public_timetable, asserted in the adapter
 * probe against Postgres); here the database is mocked.
 */

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const OTHER = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const KEY = 'test-viewer-proxy-key-of-at-least-32-chars';
const DOC = {
  kind: 'GROUP',
  title: '7A',
  school: 'Demoskolan',
  week: { from: '2026-10-12', to: '2026-10-18', isoWeek: '2026-W42' },
  days: [{ date: '2026-10-12', lessons: [{ start: '08:00', end: '09:00', subject: 'Matematik', groups: ['7A'], room: 'A101', teachers: [], cancelled: false }], meals: [] }],
};

const ORIGINS = ['https://skolan.example', 'https://www.skolan.example:8443'];
/** A code, as the school hands it out and as a person may type it. */
const CODE = 'K7QM2X9DRT4V8WNB5C3H';
const STAFF = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', schoolId: '33333333-3333-4333-8333-333333333333', role: 'TEACHER' });
const sqlOf = (call: { strings: string[] }) => call.strings.join('?');

describe('the public viewer (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeEach(async () => {
    // A fresh app per test: the viewer's counters live in its guard.
    harness = await createTestApp();
    harness.tx.$queryRaw.mockImplementation(async (statement: { strings: string[]; values: unknown[] }) => {
      const known = statement.values[0] === tokenHashOf(TOKEN) || statement.values[0] === tokenHashOf(CODE);
      if (statement.strings.join('?').includes('app.public_timetable_embed(')) {
        return [{ origins: known ? ORIGINS : null }];
      }
      return known ? [{ doc: DOC }] : [{ doc: null }];
    });
    // Listen once: an unlistened server makes supertest open and close an
    // ephemeral port per request, and across the 600 requests below a pooled
    // keep-alive socket can meet a closed one ("socket hang up", or a hang).
    await harness.app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await harness.close();
  });

  it('answers the document with a minute of public cache, noindex, no referrer, an ETag and no cookie', async () => {
    const response = await request(http()).get(`/public/v1/timetables/${TOKEN}`).expect(200);
    expect(response.body).toEqual(DOC);
    expect(response.headers['cache-control']).toBe('public, max-age=60, s-maxage=60');
    expect(response.headers['cache-control']).not.toContain('stale-while-revalidate');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['etag']).toMatch(/^W\/"/);
    // The database is asked through the viewer's door with the token's hash, never the token.
    expect(harness.tx.$queryRaw.mock.calls[0]![0].values).toEqual([tokenHashOf(TOKEN), null, null]);

    const again = await request(http())
      .get(`/public/v1/timetables/${TOKEN}`)
      .set('If-None-Match', response.headers['etag'] as string)
      .expect(304);
    expect(again.text).toBe('');
  });

  it('answers one identical 404, never cached, for every link that does not resolve', async () => {
    const answers = [];
    for (const path of [
      `/public/v1/timetables/${OTHER}`, // unknown, revoked or switched off: the database says null
      '/public/v1/timetables/short', // malformed: never asked
      `/public/v1/timetables/${TOKEN}?target=not-a-uuid`,
      `/public/v1/timetables/${TOKEN}?date=2026-13-45`,
      // Days V8 rolls over and Postgres refuses (22008): never asked, never a 500.
      `/public/v1/timetables/${TOKEN}?date=2026-02-30`,
      `/public/v1/timetables/${TOKEN}?date=2026-04-31`,
      `/public/v1/timetables/${TOKEN}?date=0000-01-01`,
    ]) {
      answers.push(await request(http()).get(path).expect(404));
    }
    for (const answer of answers) {
      expect(answer.body).toEqual(answers[0]!.body);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('answers the websites a link may be framed by, kept a minute by the web server alone, with the viewer\'s headers', async () => {
    const response = await request(http()).get(`/public/v1/timetables/${TOKEN}/embed`).expect(200);
    expect(response.body).toEqual({ frameAncestors: ORIGINS });
    expect(response.headers['cache-control']).toBe('private, max-age=60');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie']).toBeUndefined();
    // The embed door, with the token's hash and nothing else.
    expect(harness.tx.$queryRaw.mock.calls[0]![0].values).toEqual([tokenHashOf(TOKEN)]);
    expect(harness.tx.$queryRaw.mock.calls[0]![0].strings.join('?')).toContain('app.public_timetable_embed(');
    const again = await request(http())
      .get(`/public/v1/timetables/${TOKEN}/embed`)
      .set('If-None-Match', response.headers['etag'] as string)
      .expect(304);
    expect(again.text).toBe('');
  });

  it('answers the viewer\'s one 404 for a link that may not be embedded, is unknown or is malformed', async () => {
    const viewer404 = await request(http()).get(`/public/v1/timetables/${OTHER}`).expect(404);
    for (const path of [`/public/v1/timetables/${OTHER}/embed`, '/public/v1/timetables/short/embed']) {
      const answer = await request(http()).get(path).expect(404);
      expect(answer.body).toEqual(viewer404.body);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    // The malformed token is never asked about.
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('passes the target and the date on, as the function takes them', async () => {
    await request(http())
      .get(`/public/v1/timetables/${TOKEN}?target=44444444-4444-4444-8444-444444444444&date=2026-10-14`)
      .expect(200);
    expect(harness.tx.$queryRaw.mock.calls[0]![0].values).toEqual([
      tokenHashOf(TOKEN),
      '44444444-4444-4444-8444-444444444444',
      '2026-10-14',
    ]);
  });

  it('limits each viewer address to 120 a minute, trusting the web server\'s address only with its key', async () => {
    for (let i = 0; i < 120; i++) {
      await request(http()).get(`/public/v1/timetables/${TOKEN}`).set('X-Viewer-Client-Ip', '10.0.0.1').set('X-Viewer-Proxy-Key', KEY).expect(200);
    }
    const limited = await request(http())
      .get(`/public/v1/timetables/${TOKEN}`)
      .set('X-Viewer-Client-Ip', '10.0.0.1')
      .set('X-Viewer-Proxy-Key', KEY)
      .expect(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    // Another family behind the same web server has its own bucket.
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set('X-Viewer-Client-Ip', '10.0.0.2').set('X-Viewer-Proxy-Key', KEY).expect(200);
    // A spoofed address without the key is the caller's own address — already
    // spent above? No: the trusted ones were keyed by the forwarded address,
    // so the caller's own bucket is fresh, and a wrong key is ignored.
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set('X-Viewer-Client-Ip', '10.0.0.1').set('X-Viewer-Proxy-Key', 'wrong').expect(200);
  });

  it('limits one link to 600 a minute, whoever reads it', async () => {
    for (let i = 0; i < 600; i++) {
      await request(http())
        .get(`/public/v1/timetables/${TOKEN}`)
        .set('X-Viewer-Client-Ip', `10.1.${Math.floor(i / 100)}.${i % 100}`)
        .set('X-Viewer-Proxy-Key', KEY)
        .expect(200);
    }
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set('X-Viewer-Client-Ip', '10.9.9.9').set('X-Viewer-Proxy-Key', KEY).expect(429);
    // Another link is its own.
    await request(http()).get(`/public/v1/timetables/${OTHER}`).set('X-Viewer-Client-Ip', '10.9.9.9').set('X-Viewer-Proxy-Key', KEY).expect(404);
  });

  it('takes a code however it is typed, and asks the database for the one canonical spelling\'s hash', async () => {
    for (const typed of [CODE, 'K7QM2-X9DRT-4V8WN-B5C3H', 'k7qm2-x9drt-4v8wn-b5c3h', 'K7QM2%20X9DRT%204V8WN%20B5C3H']) {
      await request(http()).get(`/public/v1/timetables/${typed}`).expect(200);
    }
    const asked = harness.tx.$queryRaw.mock.calls.map((call) => call[0].values[0]);
    expect(new Set(asked)).toEqual(new Set([tokenHashOf(CODE)]));
    expect(asked).toHaveLength(4);
  });

  it('refuses an address that has tried too many links or codes that do not exist, before it asks the database, and costs a hit nothing', async () => {
    const as = (ip: string) => ({ 'X-Viewer-Client-Ip': ip, 'X-Viewer-Proxy-Key': KEY });
    // Hits are free, whatever their number (below the address's own limit).
    for (let i = 0; i < 60; i++) await request(http()).get(`/public/v1/timetables/${TOKEN}`).set(as('10.2.0.1')).expect(200);
    // The storage blocks on the hit past the limit, so the limit and one more are answered.
    for (let i = 0; i <= MISSES.limit; i++) {
      await request(http()).get(`/public/v1/timetables/${OTHER}`).set(as('10.2.0.2')).expect(404);
    }
    const calls = harness.tx.$queryRaw.mock.calls.length;
    // The next is refused, and so is a link that would have resolved: the address is spent.
    const refused = await request(http()).get(`/public/v1/timetables/${OTHER}`).set(as('10.2.0.2')).expect(429);
    expect(refused.headers['cache-control']).toBe('no-store');
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set(as('10.2.0.2')).expect(429);
    await request(http()).get(`/public/v1/timetables/${TOKEN}/embed`).set(as('10.2.0.2')).expect(429);
    expect(harness.tx.$queryRaw.mock.calls.length).toBe(calls);
    // Another address is its own, and the same program through a spoofed header is not another.
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set(as('10.2.0.3')).expect(200);
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set({ 'X-Viewer-Client-Ip': '10.2.0.2', 'X-Viewer-Proxy-Key': 'wrong' }).expect(200);
  });

  it('counts a malformed or embedded miss against the address too', async () => {
    const as = { 'X-Viewer-Client-Ip': '10.3.0.1', 'X-Viewer-Proxy-Key': KEY };
    for (let i = 0; i <= MISSES.limit; i++) {
      const path = i % 3 === 0 ? '/public/v1/timetables/short' : i % 3 === 1 ? `/public/v1/timetables/${OTHER}/embed` : `/public/v1/timetables/${TOKEN}?target=nope`;
      await request(http()).get(path).set(as).expect(404);
    }
    await request(http()).get(`/public/v1/timetables/${TOKEN}`).set(as).expect(429);
  });

  describe('the staff door (a viewer for staff)', () => {
    it('is no open route: nobody gets through it without signing in, and a pupil or a guardian does not either', async () => {
      await request(http()).get(`/api/v1/schemavisaren/${TOKEN}`).expect(401);
      for (const role of ['STUDENT', 'GUARDIAN']) {
        const user = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', schoolId: '33333333-3333-4333-8333-333333333333', role });
        await request(http()).get(`/api/v1/schemavisaren/${TOKEN}`).set('x-test-user', user).expect(403);
      }
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('asks the staff door as the signed-in person, and keeps what it answers from every cache', async () => {
      const response = await request(http()).get(`/api/v1/schemavisaren/K7QM2-X9DRT-4V8WN-B5C3H?date=2026-10-14`).set('x-test-user', STAFF).expect(200);
      expect(response.body).toEqual(DOC);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['set-cookie']).toBeUndefined();
      const [call] = harness.tx.$queryRaw.mock.calls;
      expect(sqlOf(call![0])).toContain('app.public_timetable_staff(');
      expect(call![0].values).toEqual([tokenHashOf(CODE), null, '2026-10-14']);
    });

    it('answers the not-found for what the database will not show, and refuses a person who asks for too many that do not exist', async () => {
      for (let i = 0; i <= MISSES.limit; i++) await request(http()).get(`/api/v1/schemavisaren/${OTHER}`).set('x-test-user', STAFF).expect(404);
      await request(http()).get(`/api/v1/schemavisaren/${OTHER}`).set('x-test-user', STAFF).expect(429);
      await request(http()).get(`/api/v1/schemavisaren/${TOKEN}`).set('x-test-user', STAFF).expect(429);
      // Another person is their own.
      const other = JSON.stringify({ ...JSON.parse(STAFF), userId: '55555555-5555-4555-8555-555555555555' });
      await request(http()).get(`/api/v1/schemavisaren/${TOKEN}`).set('x-test-user', other).expect(200);
    });
  });

  // An open route is a decision the school made, or a leak. Every route
  // classed VIEWER (src/publication/open-routes.ts) reaches the database only
  // through the door it names, and answers the viewer's one not-found when
  // that door says nothing: a route that showed anything without asking, or
  // asked something else, fails here. The unclassed ones fail in
  // route-guards.e2e-spec.ts.
  it.each(Object.entries(OPEN_ROUTES).filter(([, entry]) => entry.relation === 'VIEWER'))(
    '%s reaches the database only through its door, and gives a visitor nothing when the door says nothing',
    async (key, entry) => {
      const path = key.split(' ')[1]!.replace(':token', OTHER);
      const door = (entry as { door: string }).door;
      harness.tx.$queryRaw.mockImplementation(async () => [{ doc: null, origins: null }]);
      const response = await request(http()).get(path).expect(404);
      expect(response.body).toEqual({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Schemat finns inte.' });
      expect(response.headers['cache-control']).toBe('no-store');
      const sql = harness.tx.$queryRaw.mock.calls.map((call) => sqlOf(call[0]));
      expect(sql.length).toBeGreaterThan(0);
      for (const statement of sql) expect(statement).toContain(door);
    },
  );
});
