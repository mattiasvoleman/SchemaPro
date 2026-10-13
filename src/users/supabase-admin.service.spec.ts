import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SupabaseAdminService, UserLookupError } from './supabase-admin.service';

const SUPABASE_URL = 'https://supabase.test';
const SERVICE_KEY = 'service-role-key';
const AUTH_ID = '99999999-9999-4999-8999-999999999999';
const EMAIL = 'invitee@school.se';
/** The Users row the login is for, and when the row was last invited. */
const USER_ID = '66666666-6666-4666-8666-666666666666';
const OWNER = { userId: USER_ID, since: new Date('2026-09-01T08:00:00Z') };

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
const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
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

  /** How GoTrue answers a client that sends X-Supabase-Api-Version, as supabase-js does. */
  const refusal = (code: string, message: string, status: number) =>
    jsonResponse({ code, message }, status, { 'x-supabase-api-version': '2024-01-01' });

  /** A login as getUserById returns it, created for OWNER's row. */
  const ours = (fields: Record<string, unknown> = {}) =>
    jsonResponse({
      id: AUTH_ID,
      app_metadata: { provider: 'email', providers: ['email'], schemaproUserId: USER_ID },
      ...fields,
    });

  /** A login from before the tag: app_metadata as GoTrue writes it, and nothing of ours. */
  const untagged = (fields: Record<string, unknown> = {}) =>
    jsonResponse({
      id: AUTH_ID,
      app_metadata: { provider: 'email', providers: ['email'] },
      ...fields,
    });

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

      await expect(service.inviteUser(EMAIL, USER_ID)).rejects.toThrow(
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

      await expect(service.inviteUser(EMAIL, USER_ID)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call(0);
      expect(url.origin).toBe(SUPABASE_URL);
      expect(url.pathname).toBe('/auth/v1/invite');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body ?? '')).toEqual({
        email: EMAIL,
        data: { schemaproInvitation: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
      expect(header(init, 'authorization')).toBe(`Bearer ${SERVICE_KEY}`);
      expect(header(init, 'apikey')).toBe(SERVICE_KEY);
    });

    describe('the row a created user is tagged with', () => {
      /** GoTrue creating the user: the invitation's data becomes its user_metadata. */
      const creating = (_url: string, init: FetchInit) =>
        Promise.resolve(
          jsonResponse({
            id: AUTH_ID,
            email: EMAIL,
            app_metadata: { provider: 'email', providers: ['email'] },
            user_metadata: (JSON.parse(init.body ?? '{}') as { data?: unknown }).data ?? {},
          }),
        );

      it('tags a user the invitation created with its row, and takes the one-off value off it', async () => {
        fetchMock
          .mockImplementationOnce(creating)
          .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID, email: EMAIL }));

        await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
          authId: AUTH_ID,
          emailSent: true,
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const { url, init } = call(1);
        expect(init.method).toBe('PUT');
        expect(url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
        // GoTrue merges both: other app_metadata keys stay, a null removes one.
        expect(JSON.parse(init.body ?? '')).toEqual({
          app_metadata: { schemaproUserId: USER_ID },
          user_metadata: { schemaproInvitation: null },
        });
      });

      it('leaves a user untagged that GoTrue only sent the invitation again', async () => {
        // An unconfirmed user gets a 200 and the invitation again, and keeps
        // its user_metadata: this call's value is not on it.
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            id: AUTH_ID,
            email: EMAIL,
            app_metadata: { provider: 'email' },
            user_metadata: { schemaproInvitation: 'an-earlier-invitation' },
          }),
        );

        await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
          authId: AUTH_ID,
          emailSent: true,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('still reports the invitation when the tag cannot be written, and logs the pair', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        fetchMock
          .mockImplementationOnce(creating)
          .mockResolvedValueOnce(jsonResponse({ msg: 'Database error updating user' }, 500));

        await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
          authId: AUTH_ID,
          emailSent: true,
        });

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`[user=${USER_ID}] [authId=${AUTH_ID}]`),
        );
      });
    });

    it('sends invitees to the web app update-password page, trailing slash stripped', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await makeService().inviteUser(EMAIL, USER_ID);

      expect(call(0).url.searchParams.get('redirect_to')).toBe(
        'https://app.schemapro.test/update-password',
      );
    });

    it('omits the redirect when no web origin is configured', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await makeService(undefined, []).inviteUser(EMAIL, USER_ID);

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
      await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
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
      await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(2).url.searchParams.get('page')).toBe('2');
    });

    it('passes over identities without an email while looking', async () => {
      // GoTrue also holds phone sign-ups, which carry no email at all. One on
      // the page must not turn the lookup into a crash.
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ msg: 'User already registered' }, 422),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            users: [
              { id: 'phone-only', phone: '46701234567' },
              { id: AUTH_ID, email: EMAIL },
            ],
            aud: 'authenticated',
          }),
        );

      await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
        authId: AUTH_ID,
        emailSent: false,
      });
    });

    describe('how far the lookup pages', () => {
      /** A full page of 200 identities; the last one is the invitee when `match`. */
      const fullPage = (page: number, match = false) =>
        jsonResponse({
          users: Array.from({ length: 200 }, (_, i) =>
            match && i === 199
              ? { id: AUTH_ID, email: EMAIL }
              : { id: `bulk-${page}-${i}`, email: `bulk${page}-${i}@school.se` },
          ),
          aud: 'authenticated',
        });

      it('looks as far as the twentieth page', async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({ msg: 'User already registered' }, 422),
        );
        for (let page = 1; page <= 20; page++) {
          fetchMock.mockResolvedValueOnce(fullPage(page, page === 20));
        }

        await expect(makeService().inviteUser(EMAIL, USER_ID)).resolves.toEqual({
          authId: AUTH_ID,
          emailSent: false,
        });
      });

      it('stops there rather than paging a directory that never ends', async () => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse({ msg: 'invalid email address' }, 400))
          .mockResolvedValue(fullPage(0));

        await expect(makeService().inviteUser(EMAIL, USER_ID)).rejects.toThrow(
          'Supabase invite failed: invalid email address',
        );
        // The invite itself, then twenty pages.
        expect(fetchMock).toHaveBeenCalledTimes(21);
      });
    });

    it('surfaces the GoTrue error when the invite fails and nobody matches', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ msg: 'invalid email address' }, 400))
        .mockResolvedValueOnce(jsonResponse({ users: [], aud: 'authenticated' }));

      await expect(makeService().inviteUser(EMAIL, USER_ID)).rejects.toThrow(
        'Supabase invite failed: invalid email address',
      );
    });
  });

  describe('resendInvitation', () => {
    it('POSTs the invite to the address with the redirect, and resolves', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: AUTH_ID, email: EMAIL }));

      await expect(makeService().resendInvitation(EMAIL)).resolves.toBeUndefined();

      // No one-off value: the user is there already, and nothing is tagged.
      const { url, init } = call(0);
      expect(url.pathname).toBe('/auth/v1/invite');
      expect(url.searchParams.get('redirect_to')).toBe('https://app.schemapro.test/update-password');
      expect(JSON.parse(init.body ?? '')).toEqual({ email: EMAIL });
    });

    it('throws on a refusal instead of looking the address up', async () => {
      // A 429 for the project's e-mail limit: inviteUser() would page the user
      // list, find the login and call it already registered.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' },
          429,
          { 'x-supabase-api-version': '2024-01-01' },
        ),
      );

      await expect(makeService().resendInvitation(EMAIL)).rejects.toThrow(
        'Supabase invite failed: email rate limit exceeded',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses instead of calling out when unconfigured', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(makeService({}).resendInvitation(EMAIL)).rejects.toThrow(
        'Supabase admin client is not configured.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('changeUserEmail', () => {
    it('reads the user, then PUTs the new address with the service-role credentials', async () => {
      fetchMock
        .mockResolvedValueOnce(ours({ email: 'old@school.se' }))
        .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID, email: EMAIL }));

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
        outcome: 'changed',
        confirmed: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0).init.method).toBe('GET');
      expect(call(0).url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
      const { url, init } = call(1);
      expect(init.method).toBe('PUT');
      expect(url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
      expect(JSON.parse(init.body ?? '')).toEqual({ email: EMAIL });
      expect(header(init, 'authorization')).toBe(`Bearer ${SERVICE_KEY}`);
    });

    it('writes nothing when the user already has the address, in any case', async () => {
      fetchMock.mockResolvedValueOnce(ours({ email: 'Invitee@School.SE' }));

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
        outcome: 'unchanged',
        confirmed: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('a login that may not be the row\'s own', () => {
      /** After OWNER's row was last invited, and before. */
      const SINCE = '2026-09-03T06:45:00Z';
      const BEFORE = '2026-08-20T12:00:00Z';

      it('moves nothing for a login created for another row', async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            id: AUTH_ID,
            email: 'old@school.se',
            app_metadata: { provider: 'email', schemaproUserId: '12121212-1212-4212-8212-121212121212' },
            // A tag says whose the login was made for; a sign-in does not change that.
            last_sign_in_at: SINCE,
          }),
        );

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'foreign',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('moves nothing for an untagged login nobody has signed in with since the row was last invited', async () => {
        // Given to the row by address: it can be anybody's.
        fetchMock.mockResolvedValueOnce(untagged({ email: 'old@school.se', last_sign_in_at: BEFORE }));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'foreign',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('takes the person\'s own untagged login for foreign when they signed in only before an invitation sent again', async () => {
        // The trade-off: invited in June, signed in in August, sent the
        // invitation again on 1 September (OWNER.since). That restamped
        // invitedAt and recorded nothing, so until the person signs in again
        // a new address gets a login of its own and this one is left.
        fetchMock.mockResolvedValueOnce(
          untagged({
            email: 'old@school.se',
            invited_at: '2026-06-10T09:00:00Z',
            email_confirmed_at: '2026-06-10T09:20:00Z',
            last_sign_in_at: BEFORE,
          }),
        );

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'foreign',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('moves nothing for an untagged login nobody has ever signed in with', async () => {
        fetchMock.mockResolvedValueOnce(untagged({ email: 'old@school.se' }));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'foreign',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('moves an untagged login somebody has signed in with since, and tags it in the same write', async () => {
        fetchMock
          .mockResolvedValueOnce(untagged({ email: 'old@school.se', last_sign_in_at: SINCE }))
          .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID, email: EMAIL }));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'changed',
          confirmed: false,
        });

        expect(JSON.parse(call(1).init.body ?? '')).toEqual({
          email: EMAIL,
          app_metadata: { schemaproUserId: USER_ID },
        });
      });

      it('tags such a login alone when it already has the address', async () => {
        // The row's next invitation restamps invitedAt, after which the
        // sign-in would no longer count.
        fetchMock
          .mockResolvedValueOnce(untagged({ email: EMAIL, last_sign_in_at: SINCE }))
          .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID, email: EMAIL }));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'unchanged',
          confirmed: false,
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(call(1).init.method).toBe('PUT');
        expect(JSON.parse(call(1).init.body ?? '')).toEqual({
          app_metadata: { schemaproUserId: USER_ID },
        });
      });

      it('still answers unchanged when that tag cannot be written, and logs the pair', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        fetchMock
          .mockResolvedValueOnce(untagged({ email: EMAIL, last_sign_in_at: SINCE }))
          .mockResolvedValueOnce(jsonResponse({ msg: 'Database error updating user' }, 500));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'unchanged',
          confirmed: false,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`[user=${USER_ID}] [authId=${AUTH_ID}]`),
        );
      });

      it('writes nothing to a login that is not the row\'s own but already has the address', async () => {
        // The invitation then finds that login by address, as it always did.
        fetchMock.mockResolvedValueOnce(untagged({ email: EMAIL }));

        await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
          outcome: 'unchanged',
          confirmed: false,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it('says whether the user has confirmed an address, which GoTrue sends no invitation', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ours({ email: 'old@school.se', email_confirmed_at: '2026-09-02T07:30:00Z' }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ id: AUTH_ID, email: EMAIL, email_confirmed_at: '2026-09-02T07:30:00Z' }),
        );

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({
        outcome: 'changed',
        confirmed: true,
      });
    });

    it('says the address is taken when another user holds it', async () => {
      fetchMock
        .mockResolvedValueOnce(ours({ email: 'old@school.se' }))
        .mockResolvedValueOnce(
          refusal('email_exists', 'A user with this email address has already been registered', 422),
        );

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({ outcome: 'taken' });
    });

    it('says the user is missing when GoTrue has no such user', async () => {
      fetchMock.mockResolvedValueOnce(refusal('user_not_found', 'User not found', 404));

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).resolves.toEqual({ outcome: 'missing' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('propagates any other refusal of the change', async () => {
      fetchMock
        .mockResolvedValueOnce(ours({ email: 'old@school.se' }))
        .mockResolvedValueOnce(
          refusal('validation_failed', 'Unable to validate email address: invalid format', 400),
        );

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).rejects.toThrow(
        'Supabase e-mail change failed: Unable to validate email address: invalid format',
      );
    });

    it('propagates a failed lookup without writing', async () => {
      fetchMock.mockResolvedValueOnce(refusal('not_admin', 'User not allowed', 403));

      await expect(makeService().changeUserEmail(AUTH_ID, EMAIL, OWNER)).rejects.toThrow(
        'Supabase user lookup failed: User not allowed',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses instead of calling out when unconfigured', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(makeService({}).changeUserEmail(AUTH_ID, EMAIL, OWNER)).rejects.toThrow(
        'Supabase admin client is not configured.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
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

  describe('deleteOwnedUser', () => {
    it('reads the login, then DELETEs one created for the row', async () => {
      fetchMock
        .mockResolvedValueOnce(ours({ email: 'old@school.se' }))
        .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await expect(makeService().deleteOwnedUser(AUTH_ID, OWNER)).resolves.toBe('deleted');

      expect(call(0).init.method).toBe('GET');
      expect(call(0).url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
      expect(call(1).init.method).toBe('DELETE');
      expect(call(1).url.pathname).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
    });

    it('deletes an untagged login somebody has signed in with since the row was last invited', async () => {
      fetchMock
        .mockResolvedValueOnce(untagged({ email: 'old@school.se', last_sign_in_at: '2026-09-03T06:45:00Z' }))
        .mockResolvedValueOnce(jsonResponse({ id: AUTH_ID }));

      await expect(makeService().deleteOwnedUser(AUTH_ID, OWNER)).resolves.toBe('deleted');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves a login that is not the row\'s own', async () => {
      fetchMock.mockResolvedValueOnce(untagged({ email: 'old@school.se', last_sign_in_at: '2026-08-20T12:00:00Z' }));

      await expect(makeService().deleteOwnedUser(AUTH_ID, OWNER)).resolves.toBe('foreign');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves a login created for another row', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: AUTH_ID,
          app_metadata: { schemaproUserId: '12121212-1212-4212-8212-121212121212' },
        }),
      );

      await expect(makeService().deleteOwnedUser(AUTH_ID, OWNER)).resolves.toBe('foreign');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('says missing when there is no such login', async () => {
      fetchMock.mockResolvedValueOnce(refusal('user_not_found', 'User not found', 404));

      await expect(makeService().deleteOwnedUser(AUTH_ID, OWNER)).resolves.toBe('missing');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('propagates a failed lookup without deleting, as a lookup error', async () => {
      // The caller logs it apart from a failed delete: whose the login is
      // was never decided.
      fetchMock.mockResolvedValueOnce(refusal('not_admin', 'User not allowed', 403));

      const deletion = makeService().deleteOwnedUser(AUTH_ID, OWNER);
      await expect(deletion).rejects.toThrow(UserLookupError);
      await expect(deletion).rejects.toThrow('Supabase user lookup failed: User not allowed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('propagates a failed delete, not as a lookup error', async () => {
      fetchMock
        .mockResolvedValueOnce(ours())
        .mockResolvedValueOnce(jsonResponse({ msg: 'permission denied' }, 403));

      const deletion = makeService().deleteOwnedUser(AUTH_ID, OWNER);
      await expect(deletion).rejects.toThrow('Supabase delete failed: permission denied');
      await expect(deletion).rejects.not.toThrow(UserLookupError);
    });

    it('refuses instead of calling out when unconfigured', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(makeService({}).deleteOwnedUser(AUTH_ID, OWNER)).rejects.toThrow(
        'Supabase admin client is not configured.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
