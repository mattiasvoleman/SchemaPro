import { getSupabase } from '../supabase';
import { clearCachedSchoolData } from '../database/localDatabase';
import { SecureTokenStore } from './secureTokenStore';
import { releaseOnSignedOut, unregisterOnLogout } from '../pushRegistration';
import type { AuthState } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Authentication via Supabase Auth (email + password).
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

export type AuthErrorCode = 'INVALID_CREDENTIALS' | 'NO_PROFILE' | 'LOGIN_FAILED';

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

/** Supabase answers bad credentials with 400 and "invalid_credentials". */
function loginFailure(error: { message?: string; status?: number; code?: string } | null): AuthError {
  const invalid = error?.code === 'invalid_credentials' || error?.status === 400;
  return new AuthError(invalid ? 'INVALID_CREDENTIALS' : 'LOGIN_FAILED', error?.message ?? 'Login failed.');
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

async function restore(): Promise<AuthState> {
  const { data } = await getSupabase().auth.getSession();
  if (!data.session) return SIGNED_OUT;

  const cached = await SecureTokenStore.getTeacherSession();
  if (cached) {
    return { isAuthenticated: true, teacherId: cached.teacherId, role: cached.role };
  }

  // Cache miss (e.g. cleared keychain): resolve the profile online.
  try {
    const profile = await fetchProfile(data.session.user.id);
    if (!profile) return SIGNED_OUT;
    await SecureTokenStore.saveTeacherSession(profile.id, profile.role);
    return { isAuthenticated: true, teacherId: profile.id, role: profile.role };
  } catch {
    return SIGNED_OUT;
  }
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

    let profile: ProfileRow | null;
    try {
      profile = await fetchProfile(data.user.id);
    } catch (profileError) {
      throw new AuthError('LOGIN_FAILED', profileError instanceof Error ? profileError.message : 'Profile read failed.');
    }
    if (!profile) {
      await supabase.auth.signOut();
      throw new AuthError('NO_PROFILE', 'No SchemaPro profile is linked to this account.');
    }

    // Cache the profile so restoreSession() works with no connectivity.
    await SecureTokenStore.saveTeacherSession(profile.id, profile.role);

    return { isAuthenticated: true, teacherId: profile.id, role: profile.role };
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
      // useSecureAuth treats a throw as signed out, too.
      await releaseOnSignedOut();
      throw error;
    }
    if (!state.isAuthenticated) await releaseOnSignedOut();
    return state;
  },

  async logout(): Promise<void> {
    // While the bearer still works: this device stops receiving this
    // person's notices (pushRegistration). Bounded and never throws.
    const session = await SecureTokenStore.getTeacherSession();
    if (session) await unregisterOnLogout(session.teacherId);
    await getSupabase().auth.signOut();
    await SecureTokenStore.clearSession();
    // The cached roster goes with the session. Unsent attendance does not —
    // see clearCachedSchoolData for why the queue survives a sign-out.
    await clearCachedSchoolData();
  },
} as const;
