import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from './supabase-admin.service';

const SUPABASE_URL = 'https://supabase.test';
const SERVICE_KEY = 'service-role-key';
const AUTH_ID = '99999999-9999-4999-8999-999999999999';
const EMAIL = 'invitee@school.se';

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * The specs drive the REAL supabase-js admin client against a mocked global
 * fetch — no module mock — so the request/response mapping the service relies
 * on (422 fallback, 404 tolerance, paging) is exercised for real without a
 * single network call.
 */
const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (): string | null => null },
  json: (): Promise<unknown> => Promise.resolve(body),
  text: (): Promise<string> => Promise.resolve(JSON.stringify(body)),
});

describe('SupabaseAdminService', () => {
  const globalWithFetch = globalThis as { fetch?: unknown };
  const realFetch = globalWithFetch.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalWithFetch.fetch = fetchMock;
  });

  afterEach(() => {
    globalWithFetch.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const makeService = (
    supabase: { url?: string; serviceRoleKey?: string } = {
      url: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
    },
    corsOrigins: string[] = ['https://app.schemapro.test/'],
  ): SupabaseAdminService => {
    const configService = {
      getOrThrow: (key: string): unknown => {
        if (key === 'supabase') return supabase;
        if (key === 'app') return { nodeEnv: 'test', port: 4000, corsOrigins };
        throw new Error(`Unexpected config key: ${key}`);
      },
    };
    return new SupabaseAdminService(configService as unknown as ConfigService);
  };

  const call = (index: number): { url: URL; init: FetchInit } => {
    const [url, init] = fetchMock.mock.calls[index] as [string, FetchInit];
    return { url: new URL(url), init };
  };

  /** Case-insensitive header lookup — the client controls the exact casing. */
  const header = (init: FetchInit, name: string): string | undefined => {
    const match = Object.keys(init.headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    return match !== undefined ? init.headers[match] : undefined;
  };

  describe('without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', () => {
    it('reports unconfigured and warns that invitations are disabled', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const service = makeService({});

      expect(service.isConfigured).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('user invitations are disabled'),
      );
    });

    it('refuses to invite instead of calling out', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ url: SUPABASE_URL }); // key missing

      await expect(service.inviteUser(EMAIL)).rejects.toThrow(
        'Supabase admin client is not configured.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats identity deletion as a no-op', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({});

      await expect(service.deleteUser(AUTH_ID)).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('inviteUser', () => {
    it('POSTs the invite with the service-role credentials and returns the new auth id', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ id: AUTH_ID, email: EMAIL, aud: 'authenticated' }),
      );
      const service = makeService();
      expect(service.isConfigured).toBe(true);

      await expect(service.inviteUser(EMAIL)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call(0);
      expect(url.origin).toBe(SUPABASE_URL);
      expect(url.pathname).toBe('/auth/v1/invite');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body ?? '')).toEqual({ email: EMAIL });
      expect(header(init, 'authorization')).toBe(`Bearer ${SERVICE_KEY}`);
      expect(header(init, 'apikey')).toBe(SERVICE_KEY);
    });

    it('sends invitees to the web app update-password page, trailing slash stripped', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await makeService().inviteUser(EMAIL);

      expect(call(0).url.searchParams.get('redirect_to')).toBe(
        'https://app.schemapro.test/update-password',
      );
    });

    it('omits the redirect when no web origin is configured', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await makeService(undefined, []).inviteUser(EMAIL);

      expect(call(0).url.searchParams.get('redirect_to')).toBeNull();
    });

    it('falls back to a case-insensitive lookup when the email is already registered', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ msg: 'User already registered' }, 422),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            users: [
              { id: 'not-the-one', email: 'other@school.se' },
              { id: AUTH_ID, email: 'Invitee@School.SE' },
            ],
            aud: 'authenticated',
          }),
        );

      // GoTrue answers 422 for an address it already knows and sends nothing,
      // so the caller must not be told an invitation went out.
      await expect(makeService().inviteUser(EMAIL)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: false,
      });

      const { url } = call(1);
      expect(url.pathname).toBe('/auth/v1/admin/users');
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.get('per_page')).toBe('200');
    });

    it('pages through the user list until it finds the match', async () => {
      const fullPage = Array.from({ length: 200 }, (_, i) => ({
        id: `bulk-${i}`,
        email: `bulk${i}@school.se`,
      }));
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ msg: 'User already registered' }, 422),
        )
        .mockResolvedValueOnce(
          jsonResponse({ users: fullPage, aud: 'authenticated' }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            users: [{ id: AUTH_ID, email: EMAIL }],
            aud: 'authenticated',
          }),
        );

      // GoTrue answers 422 for an address it already knows and sends nothing,
      // so the caller must not be told an invitation went out.
      await expect(makeService().inviteUser(EMAIL)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(2).url.searchParams.get('page')).toBe('2');
    });

    it('surfaces the GoTrue error when the invite fails and nobody matches', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ msg: 'invalid email address' }, 400))
        .mockResolvedValueOnce(jsonResponse({ users: [], aud: 'authenticated' }));

      await expect(makeService().inviteUser(EMAIL)).rejects.toThrow(
        'Supabase invite failed: invalid email address',
      );
    });
  });

  describe('deleteUser', () => {
    it('DELETEs the auth user by id with the service-role credentials', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await expect(makeService().deleteUser(AUTH_ID)).resolves.toBeUndefined();

      const { url, init } = call(0);
      expect(init.method).toBe('DELETE');
      expect(url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
      expect(JSON.parse(init.body ?? '')).toEqual({ should_soft_delete: false });
      expect(header(init, 'authorization')).toBe(`Bearer ${SERVICE_KEY}`);
    });

    it('treats an already-missing auth user (404) as success', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ msg: 'User not found' }, 404));

      await expect(makeService().deleteUser(AUTH_ID)).resolves.toBeUndefined();
    });

    it('propagates any other delete failure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ msg: 'permission denied' }, 403),
      );

      await expect(makeService().deleteUser(AUTH_ID)).rejects.toThrow(
        'Supabase delete failed: permission denied',
      );
    });
  });
});
