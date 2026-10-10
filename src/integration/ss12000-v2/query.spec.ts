import { adhocActivityId, normaliseUuid, SCHEMAPRO_SS12000_NAMESPACE, uuidV5 } from './ids';
import { DEFAULT_LIMIT, encodePageToken, MAX_LIMIT, page, parseItemQuery, parseQuery } from './query';
import { newWebhookSecret, signatureHeader, verifySignature, webhookSecretAad } from './signing';
import { parseScopes, SCOPES } from './scopes';
import { presentedKey } from './ss12000-v2.guard';
import { vetTarget } from './subscriptions.service';
import { retryDelay, RETRY_DELAYS_MS } from './webhook-delivery.service';

const KEY = '90000000-0000-4000-8000-000000000001';
const OTHER = '90000000-0000-4000-8000-000000000002';

describe('query: S1 parameters', () => {
  it('normalises values as S1 types them and sorts arrays', () => {
    const parsed = parseQuery(
      'GET /groups',
      { groupType: ['Undervisning', 'Klass'], 'meta.modified.after': '2026-10-10T10:00:00+02:00', expandReferenceNames: 'true', limit: '20' },
      KEY,
    );
    expect(parsed.params).toEqual({ groupType: ['Klass', 'Undervisning'], 'meta.modified.after': '2026-10-10T08:00:00.000Z', expandReferenceNames: true });
    expect(parsed.limit).toBe(20);
    expect(parsed.after).toBeNull();
  });

  it('defaults and caps limit, and refuses one below S1\'s minimum', () => {
    expect(parseQuery('GET /rooms', {}, KEY).limit).toBe(DEFAULT_LIMIT);
    expect(parseQuery('GET /rooms', { limit: '99999' }, KEY).limit).toBe(MAX_LIMIT);
    expect(() => parseQuery('GET /rooms', { limit: '0' }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_FILTER' }));
    expect(() => parseQuery('GET /rooms', { limit: '1.5' }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_FILTER' }));
  });

  it.each([
    ['an unknown parameter', 'GET /persons', { role: 'TEACHER' }],
    ['a single value sent twice', 'GET /duties', { dutyRole: ['Lärare', 'Rektor'] }],
    ['an enum value S1 does not list', 'GET /groups', { groupType: 'Klassen' }],
    ['a non-uuid', 'GET /activities', { teacher: 'abc' }],
    ['an impossible date', 'GET /groups', { 'startDate.onOrAfter': '2026-02-30' }],
    ['a date-time without an offset', 'GET /persons', { 'meta.created.after': '2026-10-10T10:00:00' }],
    ['a boolean that is not one', 'GET /rooms', { expandReferenceNames: 'yes' }],
    ['a value that is not a string', 'GET /rooms', { expandReferenceNames: { a: 1 } }],
    ['a value of absurd length', 'GET /persons', { nameContains: 'x'.repeat(600) }],
  ])('refuses %s', (_name, operation, raw) => {
    expect(() => parseQuery(operation, raw as Record<string, unknown>, KEY)).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_FILTER' }));
  });

  it('requires calendarEvents\' window without a token, and lets the token carry it', () => {
    expect(() => parseQuery('GET /calendarEvents', {}, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_FILTER' }));
    const window = { 'startTime.onOrAfter': '2026-10-01T00:00:00Z', 'startTime.onOrBefore': '2026-10-31T00:00:00Z' };
    const first = parseQuery('GET /calendarEvents', window, KEY);
    const token = encodePageToken(KEY, 'GET /calendarEvents', first.params, ['2026-10-02T06:00:00.000Z', 'x']);
    expect(parseQuery('GET /calendarEvents', { pageToken: token }, KEY).params).toEqual(first.params);
    expect(parseQuery('GET /calendarEvents', { pageToken: token, ...window, limit: '3' }, KEY)).toMatchObject({ limit: 3, after: ['2026-10-02T06:00:00.000Z', 'x'] });
    expect(() => parseQuery('GET /calendarEvents', { pageToken: token, 'startTime.onOrAfter': '2026-10-02T00:00:00Z' }, KEY)).toThrow(
      expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }),
    );
    expect(() => parseQuery('GET /calendarEvents', { pageToken: token, sortkey: 'StartTimeDesc' }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
  });

  it('refuses a token of another key, another operation, a forged parameter or no token at all', () => {
    const token = encodePageToken(KEY, 'GET /persons', {}, [null, 'x']);
    expect(() => parseQuery('GET /persons', { pageToken: token }, OTHER)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
    expect(() => parseQuery('GET /groups', { pageToken: token }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
    const forged = encodePageToken(KEY, 'GET /persons', { role: 'x' }, [null, 'x']);
    expect(() => parseQuery('GET /persons', { pageToken: forged }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
    const unnormalised = encodePageToken(KEY, 'GET /persons', { 'meta.created.after': '2026-10-10T10:00:00+02:00' }, [null, 'x']);
    expect(() => parseQuery('GET /persons', { pageToken: unnormalised }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
    for (const junk of ['', '!!!', Buffer.from('[]').toString('base64url'), Buffer.from('{"v":2}').toString('base64url'), Buffer.from('not json').toString('base64url')]) {
      expect(() => parseQuery('GET /persons', { pageToken: junk }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
    }
    expect(() => parseQuery('GET /persons', { pageToken: ['a', 'b'] }, KEY)).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_TOKEN' }));
  });

  it('item operations take S1\'s item parameters only', () => {
    expect(parseItemQuery('GET /persons/{id}', { expand: 'duties' })).toEqual({ expand: ['duties'] });
    expect(() => parseItemQuery('GET /persons/{id}', { limit: '1' })).toThrow(expect.objectContaining({ code: 'INVALID_FILTER' }));
    expect(() => parseQuery('GET /nothing', {}, KEY)).toThrow('no S1 operation');
    expect(() => parseItemQuery('GET /nothing', {})).toThrow('no S1 operation');
  });
});

describe('page: keyset over a total order', () => {
  const items = ['e', 'b', 'd', 'a', 'c'].map((id, at) => ({ id, rank: at % 2 === 0 ? 'x' : null }));
  const walk = (key: Parameters<typeof page>[1]) => {
    const seen: string[] = [];
    let after: [string | number | null, string] | null = null;
    for (let n = 0; n < 10; n++) {
      const result = page(items, key, { params: {}, limit: 2, after }, (position) => JSON.stringify(position));
      seen.push(...result.data.map((item) => item.id));
      if (!result.pageToken) break;
      after = JSON.parse(result.pageToken) as [string | null, string];
    }
    return seen;
  };

  it('walks by id without a sortkey', () => {
    expect(walk(null)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('walks by a value with nulls and ties, in either direction, each item once', () => {
    const ascending = walk({ value: (item: { rank: string | null }) => item.rank, direction: 1 });
    expect(ascending).toEqual(['c', 'd', 'e', 'a', 'b']);
    const descending = walk({ value: (item: { rank: string | null }) => item.rank, direction: -1 });
    expect([...descending].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    const numbers = page([{ id: 'a', n: 2 }, { id: 'b', n: 1 }], { value: (item) => item.n, direction: 1 }, { params: {}, limit: 5, after: null }, () => '');
    expect(numbers.data.map((item) => item.id)).toEqual(['b', 'a']);
    const collated = page([{ id: 'a', s: 'Öst' }, { id: 'b', s: 'Ost' }], { value: (item) => item.s, direction: 1, collate: true }, { params: {}, limit: 5, after: null }, () => '');
    expect(collated.data.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('ids', () => {
  it('UUIDv5 is RFC 4122\'s (the DNS namespace\'s published www.example.com vector)', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('an ad-hoc activity id is stable, version 5, and never the lesson\'s own', () => {
    const lesson = '80000000-0000-4000-8000-000000000003';
    expect(adhocActivityId(lesson)).toBe(adhocActivityId(lesson));
    expect(adhocActivityId(lesson)).toBe(uuidV5(SCHEMAPRO_SS12000_NAMESPACE, `adhoc-activity:${lesson}`));
    expect(adhocActivityId(lesson)).not.toBe(lesson);
    expect(adhocActivityId(lesson)[14]).toBe('5');
  });

  it('accepts any RFC 4122 version, lowercased; nothing else', () => {
    expect(normaliseUuid('BBBBBBBB-0000-1000-8000-000000000021')).toBe('bbbbbbbb-0000-1000-8000-000000000021');
    expect(normaliseUuid('bbbbbbbb-0000-0000-8000-000000000021')).toBeNull();
    expect(normaliseUuid('not-a-uuid')).toBeNull();
    expect(normaliseUuid(42)).toBeNull();
  });
});

describe('scopes', () => {
  it('parses a body\'s scopes into the known set, de-duplicated, in order', () => {
    expect(parseScopes(['groups.read', 'ss12000.v1', 'groups.read'])).toEqual(['ss12000.v1', 'groups.read']);
    expect(parseScopes([])).toBeNull();
    expect(parseScopes(['groups.write'])).toBeNull();
    expect(parseScopes('groups.read')).toBeNull();
    expect(SCOPES).toHaveLength(12);
  });
});

describe('signing', () => {
  it('a receiver verifies the header over the raw body, either of two secrets during a rotation', () => {
    const [a, b] = [newWebhookSecret(), newWebhookSecret()];
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ modifiedEntites: ['Person'], deletedEntities: false });
    const header = signatureHeader([b, a], 1_760_000_000, body);
    expect(header.split(',')).toHaveLength(2);
    expect(verifySignature(header, a, 1_760_000_000, body)).toBe(true);
    expect(verifySignature(header, b, 1_760_000_000, body)).toBe(true);
    expect(verifySignature(header, b, 1_760_000_001, body)).toBe(false);
    expect(verifySignature(header, b, 1_760_000_000, `${body} `)).toBe(false);
    expect(verifySignature('v1=zz', b, 1_760_000_000, body)).toBe(false);
    expect(webhookSecretAad('s', 'k').toString()).toBe('integration-key-webhook:s:k');
  });
});

describe('the key on the request', () => {
  const key = `sp_${'ab'.repeat(24)}`;
  const req = (headers: Record<string, string>) => ({ headers }) as never;
  it('is S1\'s bearer or X-API-Key, of the shape keys are issued in, and never two different ones', () => {
    expect(presentedKey(req({ authorization: `Bearer ${key}` }))).toBe(key);
    expect(presentedKey(req({ authorization: `bearer  ${key}` }))).toBe(key);
    expect(presentedKey(req({ 'x-api-key': key }))).toBe(key);
    expect(presentedKey(req({ authorization: `Bearer ${key}`, 'x-api-key': key }))).toBe(key);
    expect(presentedKey(req({ authorization: `Bearer ${key}`, 'x-api-key': `sp_${'cd'.repeat(24)}` }))).toBeNull();
    expect(presentedKey(req({ authorization: `Basic ${key}` }))).toBeNull();
    expect(presentedKey(req({ 'x-api-key': 'sp_short' }))).toBeNull();
    expect(presentedKey(req({}))).toBeNull();
  });
});

describe('webhook targets and retries', () => {
  it('a target is https without userinfo or fragment; a query is the receiver\'s own', () => {
    expect(vetTarget('https://hooks.vklass.example/ss12000?tenant=1')?.host).toBe('hooks.vklass.example');
    for (const bad of ['http://x.example/', 'https://u:p@x.example/', 'https://x.example/#a', 'ftp://x', 42, `https://x.example/${'a'.repeat(2100)}`]) {
      expect(vetTarget(bad)).toBeNull();
    }
  });

  it('backs off 1 min, 5 min, 30 min, 2 h, then 6 h, each ±20 %', () => {
    expect(retryDelay(0, () => 0.5)).toBe(RETRY_DELAYS_MS[0]);
    expect(retryDelay(4, () => 0.5)).toBe(6 * 3_600_000);
    expect(retryDelay(40, () => 0.5)).toBe(6 * 3_600_000);
    expect(retryDelay(0, () => 0)).toBe(48_000);
    expect(retryDelay(0, () => 1)).toBe(72_000);
  });
});
