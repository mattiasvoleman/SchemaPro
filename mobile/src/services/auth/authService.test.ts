import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import * as Network from 'expo-network';
import { endSessionHere, getSupabase, storedSessionUserId } from '../supabase';
import { currentApp } from '../../config/appIdentity';
import { clearCachedSchoolData } from '../database/localDatabase';
import { releaseOnSignedOut, unregisterOnLogout } from '../pushRegistration';
import { SecureTokenStore } from './secureTokenStore';
import { ApiError } from '../api';
import { AuthError, AuthService } from './authService';
import { lookupProvider } from './schoolAccount';
import { loadWebBrowser } from './webBrowser';
import { useSecureAuth } from '../../hooks/useSecureAuth';
import type { AuthState } from '../../types';

jest.mock('../supabase', () => ({ getSupabase: jest.fn(), endSessionHere: jest.fn(), storedSessionUserId: jest.fn(async () => 'auth-1') }));
jest.mock('../../config/appIdentity', () => ({ currentApp: jest.fn(() => 'rastra') }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));
const openAuthSessionAsync = jest.fn();
jest.mock('./webBrowser', () => ({ loadWebBrowser: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: jest.fn((path: string) => `rastra://${path}`) }));
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
/** What the app has subscribed to supabase-js's auth events, as the test's own emitter. */
const authListeners = new Set<(event: string) => void>();
const emit = (event: string): void => authListeners.forEach((listener) => listener(event));

function supabase(options: {
  signIn?: { data: { user: { id: string } | null }; error: { message: string; status?: number; code?: string } | null };
  profile?: { id: string; role: string } | null;
  session?: { user: { id: string } } | null;
  sessionError?: Error | null;
  getSessionThrows?: boolean;
  oauth?: { data: { url: string | null } | null; error: { message: string } | null };
  exchange?: { data: { user: { id: string } | null } | null; error: { message: string; status?: number } | null };
}) {
  const signOut = jest.fn(async () => {
    order.push('signOut');
  });
  const from = jest.fn(() => builder);
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) builder[method] = () => builder;
  builder['maybeSingle'] = async () => ({ data: options.profile ?? null, error: null });
  const signInWithOAuth = jest.fn(async () => options.oauth);
  const exchangeCodeForSession = jest.fn(async () => options.exchange);
  const getSession = jest.fn(async () => {
    if (options.getSessionThrows) throw new Error('storage unreadable');
    return { data: { session: options.session ?? null }, error: options.sessionError ?? null };
  });
  const unsubscribe = jest.fn();
  (getSupabase as jest.Mock).mockReturnValue({
    auth: {
      signInWithPassword: jest.fn(async () => options.signIn),
      signInWithOAuth,
      exchangeCodeForSession,
      signOut,
      getSession,
      onAuthStateChange: jest.fn((listener: (event: string) => void) => {
        authListeners.add(listener);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                unsubscribe();
                authListeners.delete(listener);
              },
            },
          },
        };
      }),
    },
    from,
  });
  return { signOut, signInWithOAuth, exchangeCodeForSession, from, getSession, unsubscribe };
}

beforeEach(() => {
  order.length = 0;
  authListeners.clear();
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
  (currentApp as jest.Mock).mockReturnValue('rastra');
  (endSessionHere as jest.Mock).mockImplementation(async (scope: string) => {
    order.push(`endSessionHere:${scope}`);
  });
  (unregisterOnLogout as jest.Mock).mockImplementation(async () => {
    order.push('unregister');
  });
  (SecureTokenStore.clearSession as jest.Mock).mockImplementation(async () => {
    order.push('clearSession');
  });
  (storedSessionUserId as jest.Mock).mockResolvedValue('auth-1');
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
    (currentApp as jest.Mock).mockReturnValue('vardnadshavare');
    supabase({ signIn: { data: { user: { id: 'auth-1' } }, error: null }, profile: { id: 'u-1', role: 'GUARDIAN' } });
    await expect(AuthService.login({ email: ' a@b.se ', password: 'x' })).resolves.toEqual({
      isAuthenticated: true,
      teacherId: 'u-1',
      role: 'GUARDIAN',
    });
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-1', 'GUARDIAN', 'auth-1');
  });
});

describe('AuthService.logout', () => {
  it('takes the device off the person’s push before signing out, then clears the cache', async () => {
    supabase({});
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: 'auth-1' });
    await AuthService.logout();
    expect(unregisterOnLogout).toHaveBeenCalledWith('u-1');
    expect(order).toEqual(['unregister', 'endSessionHere:global', 'clearSession']);
    expect(clearCachedSchoolData).toHaveBeenCalled();
  });

  it('signs out even without a cached session', async () => {
    supabase({});
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
    await AuthService.logout();
    expect(unregisterOnLogout).not.toHaveBeenCalled();
    expect(endSessionHere).toHaveBeenCalledWith('global');
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
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: 'auth-1' });
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
    browser.mockResolvedValue({ type: 'success', url: 'rastra://auth/callback?code=the-code' });

    await expect(AuthService.loginWithSchoolAccount(' Anna@Skola.Example ')).resolves.toEqual({
      isAuthenticated: true,
      teacherId: 'u-9',
      role: 'TEACHER',
    });
    expect(lookup).toHaveBeenCalledWith('skola.example');
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: {
        redirectTo: 'rastra://auth/callback',
        skipBrowserRedirect: true,
        queryParams: { login_hint: 'Anna@Skola.Example', domain_hint: 'skola.example' },
        // Entra returns an address only when asked for it.
        scopes: 'email',
      },
    });
    expect(browser).toHaveBeenCalledWith('https://auth.example/authorize?provider=azure', 'rastra://auth/callback');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('the-code');
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-9', 'TEACHER', 'auth-9');
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

    browser.mockResolvedValue({ type: 'success', url: 'rastra://auth/callback?error=access_denied&error_code=signup_disabled' });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code: 'SSO_NO_ACCOUNT' });
  });

  it('says the access-token hook\'s refusal of the exchange, and a session with no profile', async () => {
    lookup.mockResolvedValue('azure');
    browser.mockResolvedValue({ type: 'success', url: 'rastra://auth/callback?code=c' });
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

// ─────────────────────────────────────────────────────────────────────────────
// The gate: each app admits its own roles, at sign-in, at a start and when the
// role changes under a session; a refused session is ended for this device
// only, and the attendance queue is never touched.
// ─────────────────────────────────────────────────────────────────────────────

const OTHER = { rastra: { role: 'GUARDIAN', code: 'USE_GUARDIAN_APP', own: 'TEACHER' }, vardnadshavare: { role: 'TEACHER', code: 'USE_SCHOOL_APP', own: 'GUARDIAN' } } as const;

describe.each(['rastra', 'vardnadshavare'] as const)('the gate in %s', (app) => {
  const { role: wrong, code, own } = OTHER[app];
  const lookup = lookupProvider as jest.Mock;

  beforeEach(() => {
    (currentApp as jest.Mock).mockReturnValue(app);
    (SecureTokenStore.saveTeacherSession as jest.Mock).mockClear();
    (SecureTokenStore.getTeacherSession as jest.Mock).mockReset();
    (releaseOnSignedOut as jest.Mock).mockClear();
    (unregisterOnLogout as jest.Mock).mockClear();
    (clearCachedSchoolData as jest.Mock).mockClear();
  });

  it('refuses a password sign-in of the other app’s role, caches nothing and ends only this session', async () => {
    supabase({ signIn: { data: { user: { id: 'auth-1' } }, error: null }, profile: { id: 'u-1', role: wrong } });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code });
    expect(endSessionHere).toHaveBeenCalledWith('local');
    expect(SecureTokenStore.saveTeacherSession).not.toHaveBeenCalled();
    expect(unregisterOnLogout).not.toHaveBeenCalled();
    expect(clearCachedSchoolData).not.toHaveBeenCalled();
  });

  it('refuses a school-account sign-in the same way', async () => {
    lookup.mockResolvedValue('azure');
    (loadWebBrowser as jest.Mock).mockReturnValue({ openAuthSessionAsync });
    openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'rastra://auth/callback?code=c' });
    supabase({
      oauth: { data: { url: 'https://auth.example/authorize' }, error: null },
      exchange: { data: { user: { id: 'auth-9' } }, error: null },
      profile: { id: 'u-9', role: wrong },
    });
    await expect(AuthService.loginWithSchoolAccount('anna@skola.example')).rejects.toMatchObject({ code });
    expect(endSessionHere).toHaveBeenCalledWith('local');
    expect(SecureTokenStore.saveTeacherSession).not.toHaveBeenCalled();
  });

  it('admits its own role', async () => {
    supabase({ signIn: { data: { user: { id: 'auth-1' } }, error: null }, profile: { id: 'u-1', role: own } });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    expect(endSessionHere).not.toHaveBeenCalled();
  });

  it('leaves a restored session of its own role untouched, and asks the network nothing', async () => {
    const { from, signOut } = supabase({ session: { user: { id: 'auth-1' } } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: own, authId: 'auth-1' });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    expect(from).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(endSessionHere).not.toHaveBeenCalled();
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('ends a restored session of the other app’s role from the cache alone (offline too), as logout does but for this device', async () => {
    const { from } = supabase({ session: { user: { id: 'auth-1' } } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: wrong, authId: 'auth-1' });
    await expect(AuthService.restoreSession()).rejects.toMatchObject({ code });
    expect(from).not.toHaveBeenCalled();
    expect(order).toEqual(['unregister', 'endSessionHere:local', 'clearSession']);
    expect(unregisterOnLogout).toHaveBeenCalledWith('u-1');
    // The roster cache goes; clearCachedSchoolData keeps the queue by design.
    expect(clearCachedSchoolData).toHaveBeenCalled();
  });

  it('refuses the other app’s role on a cache miss before caching it', async () => {
    supabase({ session: { user: { id: 'auth-1' } }, profile: { id: 'u-1', role: wrong } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue(null);
    await expect(AuthService.restoreSession()).rejects.toMatchObject({ code });
    expect(SecureTokenStore.saveTeacherSession).not.toHaveBeenCalled();
    expect(endSessionHere).toHaveBeenCalledWith('local');
  });

  it('opens a session at once when the device is offline, from storage, without asking supabase-js for one', async () => {
    // getSession() would try to refresh a token past its hour and give up
    // after about 25 s; here it would throw, so a call fails the test.
    supabase({ getSessionThrows: true });
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: own, authId: 'auth-1' });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    // Someone else's cached profile is still not this session's, offline too.
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-2', role: own, authId: 'auth-2' });
    await expect(AuthService.restoreSession()).resolves.toMatchObject({ isAuthenticated: false });
    // And the gate reads the cached role offline as online.
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: wrong, authId: 'auth-1' });
    await expect(AuthService.restoreSession()).rejects.toMatchObject({ code });
  });

  it('counts a network the phone has not validated as offline, and one it cannot read as online', async () => {
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: own, authId: 'auth-1' });
    // Android on a school Wi-Fi it could not confirm reaches the internet.
    supabase({ getSessionThrows: true });
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: false });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    // Unknown never spares the question: supabase-js is asked.
    const { getSession } = supabase({ session: { user: { id: 'auth-1' } } });
    (Network.getNetworkStateAsync as jest.Mock).mockRejectedValue(new Error('ExpoNetwork unavailable'));
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('opens a session offline whose access token is past its hour, from the cached profile', async () => {
    supabase({ session: null, sessionError: new AuthRetryableFetchError('Network request failed', 0) });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: own, authId: 'auth-1' });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: own });
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('follows a role change it admits, and ends the session on one it does not', async () => {
    const same = { isAuthenticated: true, teacherId: 'u-1', role: own } as const;
    const sibling = app === 'rastra' ? 'SCHOOL_ADMIN' : null;
    if (sibling) {
      supabase({ session: { user: { id: 'auth-1' } }, profile: { id: 'u-1', role: sibling } });
      await expect(AuthService.recheckProfile(same)).resolves.toEqual({ ...same, role: sibling });
      expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-1', sibling, 'auth-1');
    }
    supabase({ session: { user: { id: 'auth-1' } }, profile: { id: 'u-1', role: wrong } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: own, authId: 'auth-1' });
    order.length = 0;
    await expect(AuthService.recheckProfile(same)).rejects.toMatchObject({ code });
    // As logout ends a session, for this device only: off the person's push
    // while the bearer works, then the session, then the cache.
    expect(order).toEqual(['unregister', 'endSessionHere:local', 'clearSession']);
    expect(unregisterOnLogout).toHaveBeenCalledWith('u-1');
    expect(clearCachedSchoolData).toHaveBeenCalled();
  });

  it('leaves the session as it is when the profile is gone or Auth cannot be reached', async () => {
    const same = { isAuthenticated: true, teacherId: 'u-1', role: own } as const;
    supabase({ session: { user: { id: 'auth-1' } }, profile: null });
    await expect(AuthService.recheckProfile(same)).resolves.toBe(same);
    supabase({ session: null, sessionError: new AuthRetryableFetchError('Network request failed', 0) });
    await expect(AuthService.recheckProfile(same)).resolves.toBe(same);
    expect(endSessionHere).not.toHaveBeenCalled();
    expect(SecureTokenStore.clearSession).not.toHaveBeenCalled();
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it.each([
    ['none is stored', null],
    ['Auth refused its refresh', new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found')],
  ])('signs out a session the server ended (%s): the cache goes, push is released, the queue stays', async (_case, sessionError) => {
    const same = { isAuthenticated: true, teacherId: 'u-1', role: own } as const;
    const { from } = supabase({ session: null, sessionError });
    // supabase-js has removed it, or there was none: nothing is stored.
    (storedSessionUserId as jest.Mock).mockResolvedValue(null);
    await expect(AuthService.recheckProfile(same)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(from).not.toHaveBeenCalled();
    expect(SecureTokenStore.clearSession).toHaveBeenCalled();
    expect(clearCachedSchoolData).toHaveBeenCalled();
    expect(releaseOnSignedOut).toHaveBeenCalledTimes(1);
    // Nothing left to revoke, and no bearer to unregister with.
    expect(endSessionHere).not.toHaveBeenCalled();
    expect(unregisterOnLogout).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A session the server ends under a signed-in app (a sign-out on the web, a
// revoked or timed-out session): supabase-js removes it at its refresh and
// says SIGNED_OUT, and the app follows, offline-admitted sessions included.
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthService.onSessionEnded', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    (releaseOnSignedOut as jest.Mock).mockClear();
    (clearCachedSchoolData as jest.Mock).mockClear();
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: 'auth-1' });
  });

  it('signs the app out once the device holds nothing of the session, and keeps the queue', async () => {
    supabase({});
    const ended = jest.fn(() => order.push('ended'));
    (releaseOnSignedOut as jest.Mock).mockImplementationOnce(async () => {
      order.push('release');
    });
    AuthService.onSessionEnded(ended);
    emit('SIGNED_OUT');
    await flush();
    // Push first: whatever else cannot be cleared, the phone stops showing
    // the ended person's notices.
    expect(order).toEqual(['release', 'clearSession', 'ended']);
    // The roster cache goes; clearCachedSchoolData keeps the queue by design.
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    // supabase-js has removed the session: nothing to revoke, no bearer to unregister with.
    expect(endSessionHere).not.toHaveBeenCalled();
    expect(unregisterOnLogout).not.toHaveBeenCalled();
  });

  it('leaves the app’s own sign-out to its caller, and every other event alone', async () => {
    supabase({});
    const ended = jest.fn();
    AuthService.onSessionEnded(ended);
    // supabase-js says SIGNED_OUT inside the signOut the logout button makes.
    (endSessionHere as jest.Mock).mockImplementationOnce(async () => emit('SIGNED_OUT'));
    await AuthService.logout();
    for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN', 'USER_UPDATED']) emit(event);
    await flush();
    expect(ended).not.toHaveBeenCalled();
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
  });

  it('calls nobody back once unsubscribed, and watches nothing in a build without a Supabase project', async () => {
    const { unsubscribe } = supabase({});
    const ended = jest.fn();
    const stop = AuthService.onSessionEnded(ended);
    emit('SIGNED_OUT');
    stop();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();

    (getSupabase as jest.Mock).mockImplementationOnce(() => {
      throw new Error('[Supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set.');
    });
    expect(() => AuthService.onSessionEnded(ended)()).not.toThrow();
  });

  it.each([
    // getDb() throws until initDatabase() has opened it, and for good when it failed.
    ['the local database is not open', () => (clearCachedSchoolData as jest.Mock).mockRejectedValueOnce(new Error('[LocalDatabase] Database is not initialized. Call initDatabase() first.'))],
    ['the keychain refuses the cached profile', () => (SecureTokenStore.clearSession as jest.Mock).mockRejectedValueOnce(new Error('User interaction is not allowed.'))],
    ['the push token cannot be read', () => (releaseOnSignedOut as jest.Mock).mockRejectedValueOnce(new Error('User interaction is not allowed.'))],
  ])('does every other step, and signs the app out, when one fails (%s)', async (_case, fail) => {
    supabase({});
    fail();
    const ended = jest.fn();
    AuthService.onSessionEnded(ended);
    emit('SIGNED_OUT');
    await flush();
    expect(releaseOnSignedOut).toHaveBeenCalledTimes(1);
    expect(SecureTokenStore.clearSession).toHaveBeenCalledTimes(1);
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A recheck that outlives its session. getSession() can wait out a refresh's
// retries, about half a minute; meanwhile the logout button can end the
// session without joining that refresh (offline, endSessionHere), the next
// person can sign in, or the listener can end it. The answer that finally
// comes is about a session the app no longer holds, and must not end the one
// that followed, nor word a logout as an expiry.
// ─────────────────────────────────────────────────────────────────────────────

type SessionAnswer = { data: { session: { user: { id: string } } | null }; error: Error | null };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const refused = (): Error => new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found');

describe('AuthService.recheckProfile after its session ended', () => {
  const same = { isAuthenticated: true, teacherId: 'u-1', role: 'TEACHER' } as const;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    (currentApp as jest.Mock).mockReturnValue('rastra');
    (releaseOnSignedOut as jest.Mock).mockClear();
    (clearCachedSchoolData as jest.Mock).mockClear();
    (SecureTokenStore.saveTeacherSession as jest.Mock).mockClear();
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: 'auth-1' });
    // The logout removed the stored session.
    (storedSessionUserId as jest.Mock).mockResolvedValue(null);
  });

  it('says nothing after a logout made while it waited, and clears nothing more', async () => {
    const { getSession } = supabase({});
    const refresh = deferred<SessionAnswer>();
    getSession.mockImplementationOnce(() => refresh.promise);
    const recheck = AuthService.recheckProfile(same);
    await AuthService.logout();
    refresh.resolve({ data: { session: null }, error: refused() });
    await expect(recheck).resolves.toBe(same);
    // The logout's own clean-up, once.
    expect(SecureTokenStore.clearSession).toHaveBeenCalledTimes(1);
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('keeps the session of the next person, who signed in while it waited', async () => {
    const { getSession } = supabase({ signIn: { data: { user: { id: 'auth-2' } }, error: null }, profile: { id: 'u-2', role: 'TEACHER' } });
    const refresh = deferred<SessionAnswer>();
    getSession.mockImplementationOnce(() => refresh.promise);
    const recheck = AuthService.recheckProfile(same);
    await AuthService.logout();
    await expect(AuthService.login({ email: 'b@b.se', password: 'y' })).resolves.toMatchObject({ teacherId: 'u-2' });
    // A's refresh is refused at last; supabase-js keeps B's session, saved meanwhile.
    (storedSessionUserId as jest.Mock).mockResolvedValue('auth-2');
    refresh.resolve({ data: { session: null }, error: refused() });
    await expect(recheck).resolves.toBe(same);
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-2', 'TEACHER', 'auth-2');
    expect(SecureTokenStore.clearSession).toHaveBeenCalledTimes(1);
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('ends nothing while a session is still stored: a refused refresh keeps a newer one', async () => {
    supabase({ session: null, sessionError: refused() });
    (storedSessionUserId as jest.Mock).mockResolvedValue('auth-2');
    await expect(AuthService.recheckProfile(same)).resolves.toBe(same);
    expect(SecureTokenStore.clearSession).not.toHaveBeenCalled();
    expect(clearCachedSchoolData).not.toHaveBeenCalled();
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('counts a sign-in as a new session, for a recheck the screen started just after a logout', async () => {
    // The screen's last render still showed A when the app came to the
    // front; the logout had already ended A's session.
    const { getSession } = supabase({ signIn: { data: { user: { id: 'auth-2' } }, error: null }, profile: { id: 'u-2', role: 'TEACHER' } });
    await AuthService.logout();
    const refresh = deferred<SessionAnswer>();
    getSession.mockImplementationOnce(() => refresh.promise);
    const recheck = AuthService.recheckProfile(same);
    await AuthService.login({ email: 'b@b.se', password: 'y' });
    // storedSessionUserId answers none when the keychain cannot be read.
    refresh.resolve({ data: { session: null }, error: refused() });
    await expect(recheck).resolves.toBe(same);
    expect(SecureTokenStore.clearSession).toHaveBeenCalledTimes(1);
    expect(releaseOnSignedOut).not.toHaveBeenCalled();
  });

  it('asks nothing about a session that ended while it was read', async () => {
    const { getSession, from } = supabase({ profile: { id: 'u-1', role: 'SCHOOL_ADMIN' } });
    const refresh = deferred<SessionAnswer>();
    getSession.mockImplementationOnce(() => refresh.promise);
    const recheck = AuthService.recheckProfile(same);
    await AuthService.logout();
    refresh.resolve({ data: { session: { user: { id: 'auth-1' } } }, error: null });
    await expect(recheck).resolves.toBe(same);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['a role it admits, cached over whatever followed', 'SCHOOL_ADMIN'],
    ['a role it refuses, worded as the other app', 'GUARDIAN'],
  ])('leaves a role read for a session that has since ended alone (%s)', async (_case, role) => {
    const { from } = supabase({ session: { user: { id: 'auth-1' } } });
    const read = deferred<{ data: { id: string; role: string } | null; error: null }>();
    from.mockImplementationOnce(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => read.promise }) }) }));
    const recheck = AuthService.recheckProfile(same);
    await flush();
    expect(from).toHaveBeenCalledTimes(1);
    await AuthService.logout();
    order.length = 0;
    read.resolve({ data: { id: 'u-1', role }, error: null });
    await expect(recheck).resolves.toBe(same);
    expect(SecureTokenStore.saveTeacherSession).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it.each([
    ['inside the refresh that found it gone', 'refresh'],
    ['while it reads the storage', 'storage'],
  ])('leaves a session the listener ended to the listener (%s): one clean-up, one wording', async (_case, when) => {
    const { getSession } = supabase({});
    const ended = jest.fn();
    AuthService.onSessionEnded(ended);
    // supabase-js says SIGNED_OUT to its listeners inside the refresh that was refused.
    getSession.mockImplementationOnce(async () => {
      if (when === 'refresh') emit('SIGNED_OUT');
      return { data: { session: null }, error: refused() };
    });
    (storedSessionUserId as jest.Mock).mockImplementation(async () => {
      if (when === 'storage') emit('SIGNED_OUT');
      return null;
    });
    await expect(AuthService.recheckProfile(same)).resolves.toBe(same);
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(releaseOnSignedOut).toHaveBeenCalledTimes(1);
    expect(clearCachedSchoolData).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// And the hook applies a recheck's answer only to the state it checked: what
// a logout or another person's sign-in set while it waited stays.
// ─────────────────────────────────────────────────────────────────────────────

describe('useSecureAuth.recheckProfile', () => {
  let recheck: jest.SpyInstance;
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    (currentApp as jest.Mock).mockReturnValue('rastra');
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: 'auth-1' });
    recheck = jest.spyOn(AuthService, 'recheckProfile');
  });

  afterEach(() => {
    recheck.mockRestore();
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  function render(): { current: ReturnType<typeof useSecureAuth> } {
    const hook = {} as { current: ReturnType<typeof useSecureAuth> };
    function Probe(): null {
      hook.current = useSecureAuth();
      return null;
    }
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    return hook;
  }

  async function signIn(hook: { current: ReturnType<typeof useSecureAuth> }, authId: string, teacherId: string): Promise<AuthState> {
    supabase({ signIn: { data: { user: { id: authId } }, error: null }, profile: { id: teacherId, role: 'TEACHER' } });
    await act(() => hook.current.login(`${teacherId}@skola.example`, 'x'));
    return hook.current.authState;
  }

  it('keeps the next person signed in on an answer about the one before, and says nothing', async () => {
    const hook = render();
    const checked = await signIn(hook, 'auth-1', 'u-1');
    const answer = deferred<AuthState>();
    recheck.mockImplementationOnce(() => answer.promise);
    const pending = hook.current.recheckProfile(checked);
    await act(() => hook.current.logout());
    await signIn(hook, 'auth-2', 'u-2');
    await act(async () => {
      answer.reject(new AuthError('SESSION_EXPIRED', 'Invalid Refresh Token: Refresh Token Not Found'));
      await pending;
    });
    expect(hook.current.authState).toEqual({ isAuthenticated: true, teacherId: 'u-2', role: 'TEACHER' });
    expect(hook.current.error).toBeNull();

    // The session it checked is still the app's: signed out, and the login screen says why.
    const again = deferred<AuthState>();
    recheck.mockImplementationOnce(() => again.promise);
    const second = hook.current.recheckProfile(hook.current.authState);
    await act(async () => {
      again.reject(new AuthError('SESSION_EXPIRED', 'Invalid Refresh Token: Refresh Token Not Found'));
      await second;
    });
    expect(hook.current.authState).toEqual({ isAuthenticated: false, teacherId: null, role: null });
    expect(hook.current.error).toBe('SESSION_EXPIRED');
  });

  it('does not sign a person back in on a role read before their logout', async () => {
    const hook = render();
    const checked = await signIn(hook, 'auth-1', 'u-1');
    const answer = deferred<AuthState>();
    recheck.mockImplementationOnce(() => answer.promise);
    const pending = hook.current.recheckProfile(checked);
    await act(() => hook.current.logout());
    await act(async () => {
      answer.resolve({ ...checked, role: 'SCHOOL_ADMIN' });
      await pending;
    });
    expect(hook.current.authState).toEqual({ isAuthenticated: false, teacherId: null, role: null });
  });
});

describe('the guardian app and the school-account requirement', () => {
  it('says the staff app, not the school account, when the hook refuses a staff password', async () => {
    (currentApp as jest.Mock).mockReturnValue('vardnadshavare');
    supabase({ signIn: { data: { user: null }, error: { message: 'sso_required', status: 403, code: 'unknown' } } });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code: 'USE_SCHOOL_APP' });
  });
});

describe('the cached profile belongs to the session’s person', () => {
  beforeEach(() => {
    (currentApp as jest.Mock).mockReturnValue('rastra');
    (SecureTokenStore.saveTeacherSession as jest.Mock).mockClear();
  });

  it('never restores one person’s session with another’s cached profile', async () => {
    // A's profile, left by a session that ended without the logout button; B's session.
    const { from } = supabase({ session: { user: { id: 'auth-B' } }, profile: { id: 'u-B', role: 'TEACHER' } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-A', role: 'STUDENT', authId: 'auth-A' });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-B', role: 'TEACHER' });
    expect(from).toHaveBeenCalled();
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-B', 'TEACHER', 'auth-B');
  });

  it('adopts a profile cached before authId was kept, without the network', async () => {
    const { from } = supabase({ session: { user: { id: 'auth-1' } } });
    (SecureTokenStore.getTeacherSession as jest.Mock).mockResolvedValue({ teacherId: 'u-1', role: 'TEACHER', authId: null });
    await expect(AuthService.restoreSession()).resolves.toEqual({ isAuthenticated: true, teacherId: 'u-1', role: 'TEACHER' });
    expect(from).not.toHaveBeenCalled();
    expect(SecureTokenStore.saveTeacherSession).toHaveBeenCalledWith('u-1', 'TEACHER', 'auth-1');
  });

  it('ends a sign-in whose profile could not be read, so no later start restores it', async () => {
    (getSupabase as jest.Mock).mockReturnValue({
      auth: { signInWithPassword: jest.fn(async () => ({ data: { user: { id: 'auth-1' } }, error: null })) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'Network request failed' } }) }) }) }),
    });
    await expect(AuthService.login({ email: 'a@b.se', password: 'x' })).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    expect(endSessionHere).toHaveBeenCalledWith('local');
    expect(SecureTokenStore.saveTeacherSession).not.toHaveBeenCalled();
  });
});
