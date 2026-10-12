import { getSupabase } from '../supabase';
import { clearCachedSchoolData } from '../database/localDatabase';
import { releaseOnSignedOut, unregisterOnLogout } from '../pushRegistration';
import { SecureTokenStore } from './secureTokenStore';
import { ApiError } from '../api';
import { AuthError, AuthService } from './authService';
import { lookupProvider } from './schoolAccount';
import { loadWebBrowser } from './webBrowser';

jest.mock('../supabase', () => ({ getSupabase: jest.fn() }));
const openAuthSessionAsync = jest.fn();
jest.mock('./webBrowser', () => ({ loadWebBrowser: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: jest.fn((path: string) => `schemapro://${path}`) }));
jest.mock('./schoolAccount', () => ({
  ...jest.requireActual('./schoolAccount'),
  lookupProvider: jest.fn(),
}));
jest.mock('../database/localDatabase', () => ({ clearCachedSchoolData: jest.fn(async () => undefined) }));
jest.mock('../pushRegistration', () => ({
  unregisterOnLogout: jest.fn(async () => undefined),
  releaseOnSignedOut: jest.fn(async () => undefined),
}));
jest.mock('./secureTokenStore', () => ({
  SecureTokenStore: {
    getTeacherSession: jest.fn(),
    saveTeacherSession: jest.fn(async () => undefined),
    clearSession: jest.fn(async () => undefined),
  },
}));

/**
 * Login failures arrive at the screen as codes it words in the reader's
 * language, and logout takes this device off the person's push while the
 * session can still say who they are — before the sign-out, never after.
 */

const order: string[] = [];

function supabase(options: {
  signIn?: { data: { user: { id: string } | null }; error: { message: string; status?: number; code?: string } | null };
  profile?: { id: string; role: string } | null;
  session?: { user: { id: string } } | null;
  getSessionThrows?: boolean;
  oauth?: { data: { url: string | null } | null; error: { message: string } | null };
  exchange?: { data: { user: { id: string } | null } | null; error: { message: string; status?: number } | null };
}) {
  const signOut = jest.fn(async () => {
    order.push('signOut');
  });
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) builder[method] = () => builder;
  builder['maybeSingle'] = async () => ({ data: options.profile ?? null, error: null });
  const signInWithOAuth = jest.fn(async () => options.oauth);
  const exchangeCodeForSession = jest.fn(async () => options.exchange);
  (getSupabase as jest.Mock).mockReturnValue({
    auth: {
      signInWithPassword: jest.fn(async () => options.signIn),
      signInWithOAuth,
      exchangeCodeForSession,
      signOut,
      getSession: jest.fn(async () => {
        if (options.getSessionThrows) throw new Error('storage unreadable');
        return { data: { session: options.session ?? null } };
      }),
    },
    from: () => builder,
  });
  return { signOut, signInWithOAuth, exchangeCodeForSession };
}

beforeEach(() => {
  order.length = 0;
  (unregisterOnLogout as jest.Mock).mockImplementation(async () => {
    order.push('unregister');
  });
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

  it('says the school\'s school-account requirement as SSO_REQUIRED, not as a wrong password', async () => {
    // Auth's answer when the access-token hook refuses (GoTrue v2.197.0).
    supabase({ signIn: { data: { user: null }, error: { message: 'sso_required', status: 403, code: 'unknown' } } });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
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
  it('takes the device off the person’s push before signing out, then clears the cache', async () => {
    supabase({});
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER' });
    await AuthService.logout();
    expect(unregisterOnLogout).toHaveBeenCalledWith('u-1');
    expect(order).toEqual(['unregister', 'signOut', 'clearSession']);
    expect(clearCachedSchoolData).toHaveBeenCalled();
  });

  it('signs out even without a cached session', async () => {
    const { signOut } = supabase({});
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
    await AuthService.logout();
    expect(unregisterOnLogout).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });
});

describe('AuthService.restoreSession', () => {
  beforeEach(() => (releaseOnSignedOut as jest.Mock).mockClear());

  it('takes the device off the previous holder’s push when the session ended without the logout button', async () => {
    supabase({ session: null });
    await expect(AuthService.restoreSession()).resolves.toMatchObject({ isAuthenticated: false });
    expect(releaseOnSignedOut).toHaveBeenCalledTimes(1);
  });

  it('does the same when the profile is gone or the session cannot be read', async () => {
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
    supabase({ session: { user: { id: 'auth-1' } }, profile: null });
    await expect(AuthService.restoreSession()).resolves.toMatchObject({ isAuthenticated: false });
    supabase({ getSessionThrows: true });
    await expect(AuthService.restoreSession()).rejects.toThrow('storage unreadable');
    expect(releaseOnSignedOut).toHaveBeenCalledTimes(2);
  });

  it('leaves push alone for a session that is still there', async () => {
    supabase({ session: { user: { id: 'auth-1' } } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER' });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: 'TEACHER' });
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });
});

describe('AuthService.loginWithSchoolAccount', () => {
  const browser = openAuthSessionAsync;
  const lookup = lookupProvider as jest.Mock;

  beforeEach(() => {
    browser.mockReset();
    lookup.mockReset();
    (loadWebBrowser as jest.Mock).mockReturnValue({ openAuthSessionAsync });
  });

  it('asks about the domain, opens the provider with hints, exchanges the code and caches the profile', async () => {
    lookup.mockResolvedValue('azure');
    const { signInWithOAuth, exchangeCodeForSession } = supabase({
      oauth: { data: { url: 'https://auth.example/authorize?provider=azure' }, error: null },
      exchange: { data: { user: { id: 'auth-9' } }, error: null },
      profile: { id: 'u-9', role: 'TEACHER' },
    });
    browser.mockResolvedValue({ type: 'success', url: 'schemapro://auth/callback?code=the-code' });

    await expect(AuthService.loginWithSchoolAccount(' Anna@Skola.Example ')).resolves.toEqual({
      isAuthenticated: true,
      teacherId: 'u-9',
      role: 'TEACHER',
    });
    expect(lookup).toHaveBeenCalledWith('skola.example');
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: {
        redirectTo: 'schemapro://auth/callback',
        skipBrowserRedirect: true,
        queryParams: { login_hint: 'Anna@Skola.Example', domain_hint: 'skola.example' },
        // Entra returns an address only when asked for it.
        scopes: 'email',
      },
    });
    expect(browser).toHaveBeenCalledWith('https://auth.example/authorize?provider=azure', 'schemapro://auth/callback');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('the-code');
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-9', 'TEACHER');
  });

  it('wants an address with a domain, and asks nobody without one', async () => {
    await expect(AuthService.loginWithSchoolAccount('anna')).rejects.toMatchObject({ code: 'SSO_NEEDS_EMAIL' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('says when no school signs in with a school account on the domain, the lookup is busy, or it fails', async () => {
    lookup.mockResolvedValue(null);
    await expect(AuthService.loginWithSchoolAccount('anna@gmail.example')).rejects.toMatchObject({ code: 'SSO_NOT_FOUND' });
    lookup.mockRejectedValue(new ApiError(429, 'Too Many Requests'));
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_BUSY' });
    lookup.mockRejectedValue(new Error('offline'));
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('asks for an app update when the build has no system sign-in window', async () => {
    lookup.mockResolvedValue('azure');
    supabase({ oauth: { data: { url: 'https://auth.example/authorize' }, error: null } });
    (loadWebBrowser as jest.Mock).mockImplementation(() => {
      throw new Error("Cannot find native module 'ExpoWebBrowser'");
    });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_APP_UPDATE_NEEDED' });
  });

  it('says a closed browser as SSO_CANCELLED, and Auth\'s refusals by their codes', async () => {
    lookup.mockResolvedValue('google');
    supabase({ oauth: { data: { url: 'https://auth.example/authorize' }, error: null } });
    browser.mockResolvedValue({ type: 'cancel' });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_CANCELLED' });

    browser.mockResolvedValue({ type: 'success', url: 'schemapro://auth/callback?error=access_denied&error_code=signup_disabled' });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_NO_ACCOUNT' });
  });

  it('says the access-token hook\'s refusal of the exchange, and a session with no profile', async () => {
    lookup.mockResolvedValue('azure');
    browser.mockResolvedValue({ type: 'success', url: 'schemapro://auth/callback?code=c' });
    supabase({
      oauth: { data: { url: 'https://auth.example/authorize' }, error: null },
      exchange: { data: null, error: { message: 'sso_identity_not_allowed', status: 403 } },
    });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_OTHER_ORGANISATION' });

    const { signOut } = supabase({
      oauth: { data: { url: 'https://auth.example/authorize' }, error: null },
      exchange: { data: { user: { id: 'auth-1' } }, error: null },
      profile: null,
    });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'NO_PROFILE' });
    expect(signOut).toHaveBeenCalled();
  });

  it('says LOGIN_FAILED when Auth gives no sign-in URL', async () => {
    lookup.mockResolvedValue('azure');
    supabase({ oauth: { data: null, error: { message: 'Unsupported provider' } } });
    const error = await AuthService.loginWithSchoolAccount('anna@skola.example').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'LOGIN_FAILED' });
    expect(browser).not.toHaveBeenCalled();
  });
});
