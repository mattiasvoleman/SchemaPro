import * as Linking from 'expo-linking';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { endSessionHere, getSupabase, storedSessionUserId } from '../supabase';
import { deviceOffline } from '../network/deviceOffline';
import { currentApp } from '../../config/appIdentity';
import { appRefusal, isAppRefusal, type AppRefusal } from './appGate';
import { clearCachedSchoolData } from '../database/localDatabase';
import { SecureTokenStore } from './secureTokenStore';
import { releaseOnSignedOut, unregisterOnLogout } from '../pushRegistration';
import type { AuthState } from '../../types';
import { loadWebBrowser } from './webBrowser';
import {
  callbackParams,
  emailDomain,
  isBusy,
  lookupProvider,
  providerHints,
  providerScopes,
  refusalFor,
  type SchoolAccountRefusal,
} from './schoolAccount';

// ─────────────────────────────────────────────────────────────────────────────
// Authentication via Supabase Auth: e-mail and password, or "Logga in med
// skolkonto" (Entra ID or Google Workspace, migration 20261020090000).
//
// After sign-in the app profile (Users.id + role) is resolved from the tenant
// `Users` table under RLS and cached in expo-secure-store so that
// restoreSession() works offline. The Supabase session itself is persisted by
// the secure chunked storage adapter in services/supabase.ts.
// ─────────────────────────────────────────────────────────────────────────────

interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

interface ProfileRow {
  readonly id: string;
  readonly role: string;
}

const SIGNED_OUT: AuthState = { isAuthenticated: false, teacherId: null, role: null };

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'NO_PROFILE'
  | 'LOGIN_FAILED'
  /** The school requires its staff to sign in with the school account (the access-token hook's sso_required). */
  | 'SSO_REQUIRED'
  /** "Logga in med skolkonto" without an address, or one without a domain. */
  | 'SSO_NEEDS_EMAIL'
  /** No school signs in with a school account on that domain. */
  | 'SSO_NOT_FOUND'
  /** The lookup was refused for now (429): wait a minute. */
  | 'SSO_BUSY'
  /** This build has no system sign-in window (expo-web-browser): an app update is needed. */
  | 'SSO_APP_UPDATE_NEEDED'
  /** The account's role belongs in the other app, or in neither (appGate). */
  | AppRefusal
  /** The server ended the session under a signed-in app: revoked (a sign-out on the web is global), timed out, or the account closed. */
  | 'SESSION_EXPIRED'
  | SchoolAccountRefusal;

/**
 * A failed login, as a code the login screen words in the reader's language.
 * Supabase's own message is English prose written for a developer; it is
 * kept as the Error's message for a log, never shown.
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Supabase answers bad credentials with 400 and "invalid_credentials". The
 * access-token hook refuses staff of a school that requires the school
 * account with 403 and its code as the message (measured against GoTrue
 * v2.197.0: {"code":403,"error_code":"unknown","msg":"sso_required"}).
 */
function loginFailure(error: { message?: string; status?: number; code?: string } | null): AuthError {
  if (error?.status === 403 && error.message === 'sso_required') {
    // The hook says it of staff alone (SCHOOL_ADMIN, TEACHER): in the
    // guardian app the advice is the other app, not the school account.
    return new AuthError(currentApp() === 'vardnadshavare' ? 'USE_SCHOOL_APP' : 'SSO_REQUIRED', error.message);
  }
  const invalid = error?.code === 'invalid_credentials' || error?.status === 400;
  return new AuthError(invalid ? 'INVALID_CREDENTIALS' : 'LOGIN_FAILED', error?.message ?? 'Login failed.');
}

/**
 * The session the app holds, counted: every end (endSession, endedByServer)
 * and every sign-in (adoptProfile) moves it on. A recheck that started under
 * an earlier count answers for a session that is gone, and must not end, or
 * re-cache a profile over, the one that followed it (recheckProfile).
 */
let sessionGeneration = 0;

/** The profile of a fresh session, cached for offline restore; a session without one is signed out. */
async function adoptProfile(userId: string): Promise<AuthState> {
  // A new session: a recheck still waiting on the one before it is stale.
  sessionGeneration += 1;
  let profile: ProfileRow | null;
  try {
    profile = await fetchProfile(userId);
  } catch (profileError) {
    // Signed in at Auth with no profile cached: ended here, or the next start
    // would restore this session (and, on a shared device, a previous
    // holder's cached profile with it).
    await endSessionHere('local').catch(() => undefined);
    throw new AuthError('LOGIN_FAILED', profileError instanceof Error ? profileError.message : 'Profile read failed.');
  }
  if (!profile) {
    await getSupabase().auth.signOut();
    throw new AuthError('NO_PROFILE', 'No Rastra profile is linked to this account.');
  }
  // Before anything is cached: a refused sign-in leaves no profile behind,
  // registers no push and ends only this new session (scope 'local'), so the
  // person's session in the other app lives on.
  const refusal = appRefusal(currentApp(), profile.role);
  if (refusal) {
    await endSessionHere('local');
    throw new AuthError(refusal, `The ${profile.role} role signs in to the other app.`);
  }

  // Cache the profile so restoreSession() works with no connectivity.
  await SecureTokenStore.saveTeacherSession(profile.id, profile.role, userId);

  return { isAuthenticated: true, teacherId: profile.id, role: profile.role };
}

async function fetchProfile(authId: string): Promise<ProfileRow | null> {
  const { data, error } = await getSupabase()
    .from('Users')
    .select('id, role')
    .eq('authId', authId)
    .maybeSingle<ProfileRow>();
  if (error) throw new Error(error.message);
  return data;
}

/** A cached or fetched profile, through the gate: the state, or the refusal thrown. */
function admitted(teacherId: string, role: string): AuthState {
  const refusal = appRefusal(currentApp(), role);
  if (refusal) throw new AuthError(refusal, `The ${role} role signs in to the other app.`);
  return { isAuthenticated: true, teacherId, role };
}

async function restore(): Promise<AuthState> {
  const stored = await SecureTokenStore.getTeacherSession();
  // Offline with a cached profile, the session is read from storage alone.
  // getSession() would first try to refresh an access token past its hour
  // and give up only after about 25 seconds, while the teacher waits to take
  // the register; the refresh happens once there is a network again.
  //
  // However old the stored session is: offline, nothing on the device can
  // tell a session the server has ended from one it still honours. Only Auth
  // can, when it answers the refresh. A limit by age would end good sessions
  // too, by a rule of the app's rather than the school's Auth settings, and
  // the sign-in it sends the teacher to needs the network that is missing.
  // So the admission stays open until the network can tell, and closes then:
  // an ended session's refresh is refused, supabase-js removes it, and
  // onSessionEnded and recheckProfile sign the app out.
  const offline = stored !== null && (await deviceOffline());
  const { data, error } = offline
    ? { data: { session: null }, error: null }
    : await getSupabase().auth.getSession();
  const sessionUser =
    data.session?.user.id ?? (offline || isAuthRetryableFetchError(error) ? await storedSessionUserId() : null);
  if (!sessionUser) return SIGNED_OUT;
  // The cached profile is this session's person's, or none: a profile left by
  // a session that ended without the logout button is someone else's. One
  // cached before authId was kept is adopted as the session's.
  const cached = stored && (stored.authId === null || stored.authId === sessionUser) ? stored : null;
  if (cached && cached.authId === null) await SecureTokenStore.saveTeacherSession(cached.teacherId, cached.role, sessionUser);

  if (!data.session) {
    // Offline: asked above, or found by supabase-js, which keeps a session
    // past its access token's hour stored and answers no session with a
    // retryable fetch error (measured on auth-js 2.110.2). That is a session
    // this device still holds, and the cached profile lets attendance be
    // taken without the network, as it is with a token still inside its hour.
    return cached ? admitted(cached.teacherId, cached.role) : SIGNED_OUT;
  }

  // The cached role decides, offline too: no request before routing.
  if (cached) return admitted(cached.teacherId, cached.role);

  // Cache miss (e.g. cleared keychain): resolve the profile online.
  let profile: ProfileRow | null;
  try {
    profile = await fetchProfile(data.session.user.id);
  } catch {
    return SIGNED_OUT;
  }
  if (!profile) return SIGNED_OUT;
  const state = admitted(profile.id, profile.role);
  await SecureTokenStore.saveTeacherSession(profile.id, profile.role, data.session.user.id);
  return state;
}

/** Sign-outs the app is making now: the SIGNED_OUT each one causes is not a session the server ended (onSessionEnded). */
let signingOut = 0;

/**
 * Ends the session the app holds: this device off the person's push while
 * the bearer still works, the stored session (removed even offline), the
 * cached profile and the cached roster. Never the attendance queue
 * (clearCachedSchoolData).
 */
async function endSession(scope: 'local' | 'global'): Promise<void> {
  // Before the first await: a recheck that finds the session gone after this
  // must not word the logout as an expiry.
  sessionGeneration += 1;
  signingOut += 1;
  try {
    const session = await SecureTokenStore.getTeacherSession();
    if (session) await unregisterOnLogout(session.teacherId);
    await endSessionHere(scope);
    await SecureTokenStore.clearSession();
    await clearCachedSchoolData();
  } finally {
    signingOut -= 1;
  }
}

/**
 * A session the server ended: what endSession clears, less what needs the
 * session. supabase-js has already removed it (or found none), so there is
 * nothing to revoke and no bearer to take the device off push with: the
 * token is kept for release at the next signed-in start and the phone stops
 * receiving now (releaseOnSignedOut). Never the attendance queue. Never
 * throws: the app signs out after it, whatever it could clear.
 */
async function endedByServer(): Promise<void> {
  sessionGeneration += 1;
  // Each step on its own, push first: a local database that failed to open
  // makes clearCachedSchoolData throw, and that must not leave the phone
  // showing the ended person's notices, nor their profile cached.
  await releaseOnSignedOut().catch(() => undefined);
  await SecureTokenStore.clearSession().catch(() => undefined);
  await clearCachedSchoolData().catch(() => undefined);
}

export const AuthService = {
  async login(credentials: LoginCredentials): Promise<AuthState> {
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: credentials.email.trim(),
      password: credentials.password,
    });
    if (error || !data.user) {
      throw loginFailure(error);
    }
    return adoptProfile(data.user.id);
  },

  /**
   * "Logga in med skolkonto": the gateway is asked which provider the
   * address's domain signs in with (only the domain is sent), Supabase Auth
   * builds the provider's URL with a PKCE challenge, and the system's
   * authentication browser (expo-web-browser) opens it and returns on the
   * app's own scheme, rastra://auth/callback, which must be in the
   * project's redirect allow list (docs/DEPLOYMENT.md). The code is then
   * exchanged for a session with the verifier the client kept in secure
   * storage.
   *
   * expo-web-browser is loaded here, on the tap, and not when the app
   * starts (./webBrowser.ts).
   */
  async loginWithSchoolAccount(email: string): Promise<AuthState> {
    const domain = emailDomain(email);
    if (!domain) throw new AuthError('SSO_NEEDS_EMAIL', 'An address with a domain is needed.');

    let provider: Awaited<ReturnType<typeof lookupProvider>>;
    try {
      provider = await lookupProvider(domain);
    } catch (lookupError) {
      if (isBusy(lookupError)) throw new AuthError('SSO_BUSY', 'The lookup is busy.');
      throw new AuthError('LOGIN_FAILED', lookupError instanceof Error ? lookupError.message : 'Lookup failed.');
    }
    if (!provider) throw new AuthError('SSO_NOT_FOUND', 'No school signs in with a school account on this domain.');

    const supabase = getSupabase();
    const redirectTo = Linking.createURL('auth/callback');
    const scopes = providerScopes(provider);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        queryParams: providerHints(provider, email, domain),
        ...(scopes ? { scopes } : {}),
      },
    });
    if (error || !data?.url) throw new AuthError('LOGIN_FAILED', error?.message ?? 'No sign-in URL.');

    let WebBrowser: ReturnType<typeof loadWebBrowser>;
    try {
      WebBrowser = loadWebBrowser();
    } catch (moduleError) {
      throw new AuthError('SSO_APP_UPDATE_NEEDED', moduleError instanceof Error ? moduleError.message : 'No sign-in window.');
    }
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') throw new AuthError('SSO_CANCELLED', `The sign-in browser closed (${result.type}).`);

    const params = callbackParams(result.url);
    const code = params.get('code');
    if (!code) {
      const reason = params.get('error_code') || params.get('error');
      throw new AuthError(refusalFor(reason), params.get('error_description') ?? reason ?? 'No code.');
    }
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    if (exchanged.error || !exchanged.data?.user) {
      // The hook's code is the message; any other refusal is prose.
      throw new AuthError(refusalFor(exchanged.error?.message), exchanged.error?.message ?? 'No session.');
    }
    return adoptProfile(exchanged.data.user.id);
  },

  /**
   * A start. When it finds no session, the previous holder's ended without
   * the logout button (revoked, expired, closed), so this device is taken
   * off their push here: logout() never ran (pushRegistration).
   */
  async restoreSession(): Promise<AuthState> {
    let state: AuthState;
    try {
      state = await restore();
    } catch (error) {
      if (error instanceof AuthError && isAppRefusal(error.code)) {
        // A session from before the gate, in the app its role does not
        // belong to: ended as the logout button ends one, but for this
        // device only. The login screen says which app to use.
        await endSession('local').catch(() => undefined);
        throw error;
      }
      // useSecureAuth treats a throw as signed out, too.
      await releaseOnSignedOut();
      throw error;
    }
    if (!state.isAuthenticated) await releaseOnSignedOut();
    return state;
  },

  async logout(): Promise<void> {
    // While the bearer still works: this device stops receiving this
    // person's notices (pushRegistration), bounded and never throwing; the
    // cached roster goes with the session, unsent attendance does not (see
    // clearCachedSchoolData for why the queue survives a sign-out).
    await endSession('global');
  },

  /**
   * While signed in: a session the server ended under the app. A sign-out on
   * the web is global and revokes this device's refresh token too, the
   * school can end a person's sessions, and an account can be closed.
   * supabase-js finds out at its next refresh, removes the stored session
   * and says SIGNED_OUT; without this the app would stay in the person's
   * shell on the cached profile with no session behind it, every read empty
   * and every mark held back. `ended` is called once the device holds
   * nothing of the session, and never after the returned unsubscribe. The
   * app's own sign-outs (endSession) say SIGNED_OUT too, and are their
   * caller's to word.
   */
  onSessionEnded(ended: () => void): () => void {
    let watching = true;
    let subscription: { unsubscribe: () => void };
    try {
      subscription = getSupabase().auth.onAuthStateChange((event) => {
        if (event !== 'SIGNED_OUT' || signingOut > 0) return;
        // Not awaited: supabase-js awaits its listeners inside the call that
        // found the session gone, and nothing here needs that call to wait.
        void endedByServer().then(() => {
          if (watching) ended();
        });
      }).data.subscription;
    } catch {
      // A build without a Supabase project signs nobody in to watch.
      return () => undefined;
    }
    return () => {
      watching = false;
      subscription.unsubscribe();
    };
  },

  /**
   * After a signed-in start, once there is a network: the profile as the
   * school has it now. The role can change under a session (an
   * administrator's edit), and the token says nothing of it (the access-token
   * hook leaves the claims as they are). A role this app does not admit ends
   * the session here as at a start; a changed role it admits is cached and
   * returned. A session that is gone (none stored, or its refresh refused)
   * ends here as onSessionEnded ends it. Anything it cannot read leaves the
   * session as it is, and so does a recheck that outlived the session it
   * checked: a logout, a sign-in or the server's end while it waited.
   */
  async recheckProfile(current: AuthState): Promise<AuthState> {
    if (!current.isAuthenticated) return current;
    // getSession() can wait out a refresh's retries, about half a minute. A
    // logout while it waits removes the session without joining that refresh
    // when the device says it is offline (endSessionHere), the next person
    // can sign in, and the answer that finally comes is about a session the
    // app no longer holds: ending "it" would clear the next person's profile,
    // roster and push, and word the logout as an expiry.
    const generation = sessionGeneration;
    const superseded = (): boolean => generation !== sessionGeneration;
    const { data, error } = await getSupabase().auth.getSession();
    if (superseded()) return current;
    if (!data.session) {
      // Auth could not be reached (and for a minute after such a refresh
      // supabase-js gives the same answer from its cache): the session is
      // still held, and the next recheck asks again. Anything else is a
      // session gone: none stored, or its refresh refused and removed.
      if (isAuthRetryableFetchError(error)) return current;
      // Unless one is still stored: a refused refresh keeps a newer session
      // that was saved while it ran (a sign-in landing between its retries)
      // and answers no session for the older one.
      if ((await storedSessionUserId()) !== null || superseded()) return current;
      await endedByServer();
      throw new AuthError('SESSION_EXPIRED', error?.message ?? 'No session is stored.');
    }
    let profile: ProfileRow | null;
    try {
      profile = await fetchProfile(data.session.user.id);
    } catch {
      return current;
    }
    // A role read for a session that has since ended: neither a refusal of
    // nor a profile cached over whatever followed it.
    if (superseded()) return current;
    // No row: deactivated or removed. The gateway refuses it, and the queue
    // banner says so; signing out here would strand unsent attendance.
    if (!profile || (profile.id === current.teacherId && profile.role === current.role)) return current;
    const refusal = appRefusal(currentApp(), profile.role);
    if (refusal) {
      await endSession('local').catch(() => undefined);
      throw new AuthError(refusal, `The ${profile.role} role signs in to the other app.`);
    }
    await SecureTokenStore.saveTeacherSession(profile.id, profile.role, data.session.user.id);
    return { isAuthenticated: true, teacherId: profile.id, role: profile.role };
  },
} as const;
