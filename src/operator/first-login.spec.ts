import { CREATED_FOR_ROW } from '../users/supabase-admin.service';
import { FirstLoginError, isRateLimited, makeFirstLogin, type AuthAdminAnswer, type AuthAdminClient, type AuthAdminError } from './first-login';

const ROW = '11111111-1111-4111-8111-111111111111';

function clientOf(parts: Partial<AuthAdminClient['auth']['admin']>) {
  const admin = {
    inviteUserByEmail: jest.fn(),
    createUser: jest.fn(),
    updateUserById: jest.fn(async () => ({ error: null })),
    listUsers: jest.fn(async () => ({ data: { users: [] }, error: null })),
    ...parts,
  };
  return { client: { auth: { admin } } as unknown as AuthAdminClient, admin };
}

const failed = (error: AuthAdminError): AuthAdminAnswer => ({ data: { user: null }, error });

describe('makeFirstLogin: the invitation', () => {
  it('sends the invitation to where the link should land, and tags a login this call made with its row', async () => {
    let nonce: unknown;
    const { client, admin } = clientOf({
      inviteUserByEmail: jest.fn(async (_email: string, options?: { data?: Record<string, unknown> }) => {
        nonce = options?.data?.schemaproInvitation;
        return { data: { user: { id: 'auth-1', user_metadata: { schemaproInvitation: nonce } } }, error: null };
      }),
    });
    const result = await makeFirstLogin(client, { email: 'rektor@skolan.example', userId: ROW, redirectTo: 'https://app.skolan.example/update-password' });
    expect(result).toEqual({ how: 'INVITED', authId: 'auth-1' });
    expect(typeof nonce).toBe('string');
    expect(admin.inviteUserByEmail).toHaveBeenCalledWith('rektor@skolan.example', {
      redirectTo: 'https://app.skolan.example/update-password',
      data: { schemaproInvitation: nonce },
    });
    expect(admin.updateUserById).toHaveBeenCalledWith('auth-1', { app_metadata: { [CREATED_FOR_ROW]: ROW }, user_metadata: { schemaproInvitation: null } });
  });

  it('sends no redirect when there is none: the project\'s Site URL then decides', async () => {
    const { client, admin } = clientOf({ inviteUserByEmail: jest.fn(async () => ({ data: { user: { id: 'a' } }, error: null })) });
    await makeFirstLogin(client, { email: 'a@b.example', userId: ROW });
    expect((admin.inviteUserByEmail as jest.Mock).mock.calls[0]![1]).not.toHaveProperty('redirectTo');
  });

  it('does not tag a login that carries no one-off value of ours: GoTrue returned somebody\'s existing, unconfirmed login', async () => {
    const { client, admin } = clientOf({ inviteUserByEmail: jest.fn(async () => ({ data: { user: { id: 'old', user_metadata: {} } }, error: null })) });
    await expect(makeFirstLogin(client, { email: 'a@b.example', userId: ROW })).resolves.toEqual({ how: 'INVITED', authId: 'old' });
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it('adopts a login the address already has (422 email_exists) and says no mail went out', async () => {
    const { client } = clientOf({
      inviteUserByEmail: jest.fn(async () => failed({ message: 'already registered', status: 422, code: 'email_exists' })),
      listUsers: jest.fn(async () => ({ data: { users: [{ id: 'other', email: 'x@y.example' }, { id: 'mine', email: 'Rektor@Skolan.example' }] }, error: null })),
    });
    await expect(makeFirstLogin(client, { email: 'rektor@skolan.example', userId: ROW })).resolves.toEqual({ how: 'EXISTED', authId: 'mine' });
  });

  it('pages through the users to find the address, at most twenty pages', async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.example` }));
    const listUsers = jest.fn(async ({ page: n }: { page: number }) => ({
      data: { users: n === 3 ? [{ id: 'found', email: 'rektor@skolan.example' }] : page },
      error: null,
    }));
    const { client } = clientOf({ inviteUserByEmail: jest.fn(async () => failed({ message: 'x', status: 422 })), listUsers });
    await expect(makeFirstLogin(client, { email: 'rektor@skolan.example', userId: ROW })).resolves.toEqual({ how: 'EXISTED', authId: 'found' });
    expect(listUsers).toHaveBeenCalledTimes(3);

    const endless = jest.fn(async () => ({ data: { users: page }, error: null }));
    const never = clientOf({ inviteUserByEmail: jest.fn(async () => failed({ message: 'x', status: 422 })), listUsers: endless });
    await expect(makeFirstLogin(never.client, { email: 'nobody@skolan.example', userId: ROW })).rejects.toBeInstanceOf(FirstLoginError);
    expect(endless).toHaveBeenCalledTimes(20);
  });

  it('a project whose mail limit is spent is a RATE_LIMITED refusal that says what to do, and never adopts the address', async () => {
    const { client, admin } = clientOf({
      inviteUserByEmail: jest.fn(async () => failed({ message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' })),
    });
    const error = await makeFirstLogin(client, { email: 'a@b.example', userId: ROW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FirstLoginError);
    expect((error as FirstLoginError).kind).toBe('RATE_LIMITED');
    expect((error as FirstLoginError).message).toContain('--password-env');
    expect(admin.listUsers).not.toHaveBeenCalled();
  });

  it('a server error is the sender refusing, and the sentence points at Authentication → SMTP', async () => {
    const { client } = clientOf({ inviteUserByEmail: jest.fn(async () => failed({ message: 'Error sending invite email', status: 500 })) });
    const error = (await makeFirstLogin(client, { email: 'a@b.example', userId: ROW }).catch((e: unknown) => e)) as FirstLoginError;
    expect(error.kind).toBe('SENDER');
    expect(error.message).toContain('Error sending invite email (HTTP 500)');
    expect(error.message).toContain('Authentication → SMTP');
  });

  it('any other refusal says what Supabase said, and an answer with no user is a refusal too', async () => {
    const { client } = clientOf({ inviteUserByEmail: jest.fn(async () => failed({ message: 'Invalid redirect', status: 400 })) });
    const error = (await makeFirstLogin(client, { email: 'a@b.example', userId: ROW }).catch((e: unknown) => e)) as FirstLoginError;
    expect(error.kind).toBe('OTHER');
    expect(error.message).toBe('Supabase could not send the invitation: Invalid redirect (HTTP 400).');

    const none = clientOf({ inviteUserByEmail: jest.fn(async () => ({ data: { user: null }, error: null })) });
    await expect(makeFirstLogin(none.client, { email: 'a@b.example', userId: ROW })).rejects.toThrow('no user was returned');
  });
});

describe('makeFirstLogin: a password', () => {
  it('makes a confirmed login tagged with its row, and sends nothing', async () => {
    const { client, admin } = clientOf({ createUser: jest.fn(async () => ({ data: { user: { id: 'auth-2' } }, error: null })) });
    const result = await makeFirstLogin(client, { email: 'rektor@skolan.example', userId: ROW, password: 'a-temporary-password' });
    expect(result).toEqual({ how: 'CREATED', authId: 'auth-2' });
    expect(admin.createUser).toHaveBeenCalledWith({
      email: 'rektor@skolan.example',
      password: 'a-temporary-password',
      email_confirm: true,
      app_metadata: { [CREATED_FOR_ROW]: ROW },
    });
    expect(admin.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('adopts an address that has a login already, and refuses what it cannot explain', async () => {
    const exists = clientOf({
      createUser: jest.fn(async () => failed({ message: 'exists', status: 422, code: 'email_exists' })),
      listUsers: jest.fn(async () => ({ data: { users: [{ id: 'there', email: 'rektor@skolan.example' }] }, error: null })),
    });
    await expect(makeFirstLogin(exists.client, { email: 'rektor@skolan.example', userId: ROW, password: 'a-temporary-password' })).resolves.toEqual({ how: 'EXISTED', authId: 'there' });

    const weak = clientOf({ createUser: jest.fn(async () => failed({ message: 'Password should be at least 6 characters', status: 400, code: 'weak_password' })) });
    await expect(makeFirstLogin(weak.client, { email: 'a@b.example', userId: ROW, password: 'a-temporary-password' })).rejects.toThrow('Password should be at least 6 characters');
  });
});

describe('isRateLimited', () => {
  it('is HTTP 429 or the code, either one', () => {
    expect(isRateLimited({ message: '', status: 429 })).toBe(true);
    expect(isRateLimited({ message: '', code: 'over_email_send_rate_limit' })).toBe(true);
    expect(isRateLimited({ message: '', status: 422 })).toBe(false);
  });
});
