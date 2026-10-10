import { MockSs12000Provider, s1Organisation } from '../../../test/utils/ss12000-mock-provider';
import { makeTestTls } from '../../../test/utils/test-tls';
import { Ss12000Client, clearTokenCache, type SourceConnection } from './client';
import { Ss12000SourceError } from './errors';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECRET = 'mock-client-secret-0123456789';

describe('Ss12000Client against a local TLS mock provider', () => {
  const tls = makeTestTls();
  let provider: MockSs12000Provider;
  const options = (extra: Record<string, unknown> = {}) => ({
    policy: { allowLoopback: true, ca: tls.ca },
    retryDelaysMs: [1, 1, 1],
    sleep: async () => undefined,
    ...extra,
  });
  const oauth = (patch: Partial<SourceConnection> = {}): SourceConnection => ({
    sourceId: '11111111-1111-4111-8111-111111111111',
    baseUrl: provider.baseUrl,
    authKind: 'OAUTH2_CLIENT_CREDENTIALS',
    tokenUrl: provider.tokenUrl,
    clientId: 'schemapro',
    tokenScope: null,
    tokenAuthStyle: 'BASIC',
    secrets: { CLIENT_SECRET: SECRET },
    ...patch,
  });

  beforeEach(async () => {
    clearTokenCache();
    provider = new MockSs12000Provider(tls, { id: 'schemapro', secret: SECRET });
    await provider.start();
    provider.world.organisations = [s1Organisation(ORG, 'Ekskolan')];
  });

  afterEach(async () => {
    await provider.stop();
  });

  it('obtains a token with HTTP Basic and presents it as S1 BearerAuth', async () => {
    const client = new Ss12000Client(oauth(), options());
    await expect(client.call('GET', `/organisations/${ORG}`)).resolves.toMatchObject({ id: ORG, displayName: 'Ekskolan' });
    const token = provider.requests.find((r) => r.path === '/connect/token');
    expect(token?.authorization).toMatch(/^Basic /);
    expect(provider.dataRequests()[0]!.authorization).toMatch(/^Bearer mock-token-/);
    expect(client.providerClock).toBeInstanceOf(Date);
  });

  it('obtains a token with the client in the form (FORM style)', async () => {
    const client = new Ss12000Client(oauth({ tokenAuthStyle: 'FORM' }), options());
    await client.authenticate();
    expect(provider.requests.find((r) => r.path === '/connect/token')?.authorization).toBeUndefined();
    expect(provider.tokensIssued).toBe(1);
  });

  it('caches the token in memory across clients of the same source and secret, not across secrets', async () => {
    await new Ss12000Client(oauth(), options()).call('GET', `/organisations/${ORG}`);
    await new Ss12000Client(oauth(), options()).call('GET', `/organisations/${ORG}`);
    expect(provider.tokensIssued).toBe(1);
    provider.client.secret = 'rotated-secret-000';
    await new Ss12000Client(oauth({ secrets: { CLIENT_SECRET: 'rotated-secret-000' } }), options()).call('GET', `/organisations/${ORG}`);
    expect(provider.tokensIssued).toBe(2);
  });

  it('answers a refused token with a code, and nothing of the body that echoed the secret', async () => {
    const client = new Ss12000Client(oauth({ secrets: { CLIENT_SECRET: 'wrong-secret-echoed-back' } }), options());
    const error = await client.authenticate().catch((e: unknown) => e);
    expect(error).toEqual(new Ss12000SourceError('SS12000_TOKEN_REFUSED'));
    expect(JSON.stringify(error)).not.toContain('wrong-secret-echoed-back');
    expect(String((error as Error).message)).not.toContain('wrong-secret-echoed-back');
  });

  it('refreshes the token once on a 401 and carries on', async () => {
    const client = new Ss12000Client(oauth(), options());
    await client.authenticate();
    provider.faults.unauthorizedOnce = true;
    await expect(client.call('GET', `/organisations/${ORG}`)).resolves.toMatchObject({ id: ORG });
    expect(provider.tokensIssued).toBe(2);
  });

  it('fails SS12000_UNAUTHORIZED for a static bearer the provider does not know', async () => {
    const client = new Ss12000Client(oauth({ authKind: 'BEARER_TOKEN', tokenUrl: null, clientId: null, secrets: { BEARER_TOKEN: 'nope' } }), options());
    await expect(client.call('GET', `/organisations/${ORG}`)).rejects.toEqual(new Ss12000SourceError('SS12000_UNAUTHORIZED', 401));
  });

  it('honours Retry-After on a 429 and retries 503 up to three times', async () => {
    const waits: number[] = [];
    const client = new Ss12000Client(oauth(), options({ sleep: async (ms: number) => void waits.push(ms) }));
    provider.faults.tooManyOnce = { retryAfterSeconds: 7 };
    await client.call('GET', `/organisations/${ORG}`);
    expect(waits).toEqual([7000]);
    provider.faults.unavailableTimes = 3;
    await client.call('GET', `/organisations/${ORG}`);
    expect(client.stats.retries).toBe(4);
    provider.faults.unavailableTimes = 4;
    await expect(client.call('GET', `/organisations/${ORG}`)).rejects.toThrow('SS12000_HTTP_503');
  });

  it.each([
    ['a redirect, never followed with the bearer', { redirect: true }, 'SS12000_REDIRECT_REFUSED'],
    ['a 500', { serverError: true }, 'SS12000_HTTP_500'],
    ['truncated JSON', { truncatedJson: true }, 'SS12000_INVALID_JSON'],
  ])('fails on %s with a code', async (_label, faults, code) => {
    const client = new Ss12000Client(oauth(), options());
    await client.authenticate();
    Object.assign(provider.faults, faults);
    await expect(client.call('GET', `/organisations/${ORG}`)).rejects.toThrow(code);
    expect(provider.requests.some((r) => r.path === '/steal')).toBe(false);
  });

  it('stops reading a body past the cap', async () => {
    const client = new Ss12000Client(oauth(), options({ maxBytes: 4096 }));
    provider.faults.oversizedBytes = 10_000;
    await expect(client.call('GET', `/organisations/${ORG}`)).rejects.toThrow('SS12000_RESPONSE_TOO_LARGE');
  });

  it('times out a slow answer', async () => {
    const client = new Ss12000Client(oauth(), options({ timeoutMs: 200 }));
    await client.authenticate();
    provider.faults.slowMs = 1500;
    await expect(client.call('GET', `/organisations/${ORG}`)).rejects.toThrow('SS12000_TIMEOUT');
  });

  it('walks pages with the filters first and pageToken + limit only after (S1)', async () => {
    provider.world.organisations = Array.from({ length: 5 }, (_, i) =>
      s1Organisation(`aaaaaaaa-0000-4000-8000-00000000000${i}`, `Skola ${i}`),
    );
    const client = new Ss12000Client(oauth(), options());
    const items = await client.list('/organisations', [['type', 'Skolenhet']], 2);
    expect(items).toHaveLength(5);
    const lists = provider.dataRequests('/organisations');
    expect(lists).toHaveLength(3);
    expect(lists[0]!.query).toEqual([['type', 'Skolenhet'], ['limit', '2']]);
    for (const later of lists.slice(1)) expect(later.query.map(([key]) => key)).toEqual(['pageToken', 'limit']);
    expect(client.stats.pages).toBe(3);
  });

  it('stops at the item cap without walking further', async () => {
    provider.world.organisations = Array.from({ length: 5 }, (_, i) => s1Organisation(`aaaaaaaa-0000-4000-8000-00000000000${i}`, `S${i}`));
    const client = new Ss12000Client(oauth(), options());
    await expect(client.list('/organisations', [], 2, 2)).resolves.toHaveLength(2);
    expect(provider.dataRequests('/organisations')).toHaveLength(1);
  });

  it('calls a page token seen twice a loop', async () => {
    const client = new Ss12000Client(oauth(), options());
    provider.faults.pageLoop = true;
    await expect(client.list('/organisations', [], 1)).rejects.toThrow('SS12000_PAGE_LOOP');
  });

  it('refuses a provider whose certificate the trust store does not know', async () => {
    const client = new Ss12000Client(oauth(), options({ policy: { allowLoopback: true, ca: tls.otherCa } }));
    await expect(client.authenticate()).rejects.toThrow('SS12000_TLS_FAILED');
  });

  it('refuses loopback without the test override', async () => {
    const client = new Ss12000Client(oauth(), options({ policy: { allowLoopback: false, ca: tls.ca } }));
    await expect(client.authenticate()).rejects.toThrow('SS12000_ADDRESS_REFUSED');
  });

  it('resolves a host once and connects to the address it vetted (pinned)', async () => {
    const resolve = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const client = new Ss12000Client(
      oauth({ baseUrl: provider.baseUrl.replace('127.0.0.1', 'localhost'), tokenUrl: provider.tokenUrl.replace('127.0.0.1', 'localhost') }),
      options({ policy: { allowLoopback: true, ca: tls.ca, resolve } }),
    );
    await client.call('GET', `/organisations/${ORG}`);
    // One resolution per request (token, data), each pinned; none after the vetting.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  describe('mutual TLS (MTLS_CLIENT_CERT)', () => {
    let mtls: MockSs12000Provider;
    beforeEach(async () => {
      mtls = new MockSs12000Provider(tls, { id: 'x', secret: 'y' }, { requireClientCert: true, staticBearer: 'edlevo-api-key' });
      await mtls.start();
      mtls.world.organisations = [s1Organisation(ORG, 'Ekskolan')];
    });
    afterEach(async () => {
      await mtls.stop();
    });

    const conn = (secrets: SourceConnection['secrets']): SourceConnection => ({
      sourceId: '11111111-1111-4111-8111-111111111112',
      baseUrl: mtls.baseUrl,
      authKind: 'MTLS_CLIENT_CERT',
      tokenUrl: null,
      clientId: null,
      tokenScope: null,
      tokenAuthStyle: 'BASIC',
      secrets,
    });

    it('presents the client certificate, and a stored bearer beside it', async () => {
      const client = new Ss12000Client(conn({ CLIENT_CERT_PEM: tls.clientCert, CLIENT_KEY_PEM: tls.clientKey, BEARER_TOKEN: 'edlevo-api-key' }), options());
      await expect(client.call('GET', `/organisations/${ORG}`)).resolves.toMatchObject({ id: ORG });
      expect(mtls.dataRequests()[0]!.clientCertificate).toBe(true);
    });

    it('is refused at the handshake without the certificate, and asks for it before connecting', async () => {
      await expect(new Ss12000Client(conn({ BEARER_TOKEN: 'edlevo-api-key' }), options()).call('GET', `/organisations/${ORG}`)).rejects.toThrow(
        'SS12000_SECRET_MISSING',
      );
      expect(mtls.requests).toHaveLength(0);
    });
  });
});
