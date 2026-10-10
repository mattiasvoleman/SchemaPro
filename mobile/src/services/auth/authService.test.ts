import { getSupabase } from '../supabase';
import { clearCachedSchoolData } from '../database/localDatabase';
import { SecureTokenStore } from './secureTokenStore';
import { AuthError, AuthService } from './authService';

jest.mock('../supabase', () => ({ getSupabase: jest.fn() }));
jest.mock('../database/localDatabase', () => ({ clearCachedSchoolData: jest.fn(async () => undefined) }));
jest.mock('./secureTokenStore', () => ({
  SecureTokenStore: {
    getTeacherSession: jest.fn(),
    saveTeacherSession: jest.fn(async () => undefined),
    clearSession: jest.fn(async () => undefined),
  },
}));

/**
 * Login failures arrive at the screen as codes it words in the reader's
 * language; logout signs out and clears the cached session.
 */

const order: string[] = [];

function supabase(options: {
  signIn?: { data: { user: { id: string } | null }; error: { message: string; status?: number; code?: string } | null };
  profile?: { id: string; role: string } | null;
}) {
  const signOut = jest.fn(async () => {
    order.push('signOut');
  });
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) builder[method] = () => builder;
  builder['maybeSingle'] = async () => ({ data: options.profile ?? null, error: null });
  (getSupabase as jest.Mock).mockReturnValue({
    auth: { signInWithPassword: jest.fn(async () => options.signIn), signOut },
    from: () => builder,
  });
  return { signOut };
}

beforeEach(() => {
  order.length = 0;
  (SecureTokenStore.clearSession as jest.Mock).mockImplementation(async () => {
    order.push('clearSession');
  });
});

describe('AuthService.login', () => {
  it('says wrong credentials as INVALID_CREDENTIALS', async () => {
    supabase({ signIn: { data: { user: null }, error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } } });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('says anything else as LOGIN_FAILED', async () => {
    supabase({ signIn: { data: { user: null }, error: { message: 'Network request failed' } } });
    const error = await AuthService.login({ email: 'a@b.se', password: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'LOGIN_FAILED' });
  });

  it('says an account without a profile as NO_PROFILE, and signs it out', async () => {
    const { signOut } = supabase({ signIn: { data: { user: { id: 'auth-1' } }, error: null }, profile: null });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code: 'NO_PROFILE' });
    expect(signOut).toHaveBeenCalled();
  });

  it('signs in and caches the profile', async () => {
    supabase({ signIn: { data: { user: { id: 'auth-1' } }, error: null }, profile: { id: 'u-1', role: 'GUARDIAN' } });
    await expect(AuthService.login({ email: ' a@b.se ', password: 'x' })).resolves.toEqual({
      isAuthenticated: true,
      teacherId: 'u-1',
      role: 'GUARDIAN',
    });
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-1', 'GUARDIAN');
  });
});

describe('AuthService.logout', () => {
  it('signs out, then clears the cached session and the cache', async () => {
    supabase({});
    await AuthService.logout();
    expect(order).toEqual(['signOut', 'clearSession']);
    expect(clearCachedSchoolData).toHaveBeenCalled();
  });
});
