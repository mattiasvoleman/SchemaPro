import request from 'supertest';
import { createTestApp, type TestHarness } from './utils/test-app';
import { tokenHashOf } from '../src/publication/public-token';

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

describe('the public viewer (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeEach(async () => {
    // A fresh app per test: the viewer's counters live in its guard.
    harness = await createTestApp();
    harness.tx.$queryRaw.mockImplementation(async (statement: { strings: string[]; values: unknown[] }) => {
      const known = statement.values[0] === tokenHashOf(TOKEN);
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
});
