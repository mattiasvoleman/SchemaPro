import { getSupabase } from '../supabase';
import { clearCachedSchoolData } from '../database/localDatabase';
import { SecureTokenStore } from './secureTokenStore';
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

async function fetchProfile(authId: string): Promise<ProfileRow | null> {
  const { data, error } = await getSupabase()
    .from('Users')
    .select('id, role')
    .eq('authId', authId)
    .maybeSingle<ProfileRow>();
  if (error) throw new Error(error.message);
  return data;
}

export const AuthService = {
  async login(credentials: LoginCredentials): Promise<AuthState> {
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: credentials.email.trim(),
      password: credentials.password,
    });
    if (error || !data.user) {
      throw new Error(error?.message ?? 'Login failed.');
    }

    const profile = await fetchProfile(data.user.id);
    if (!profile) {
      await supabase.auth.signOut();
      throw new Error('No SchemaPro profile is linked to this account.');
    }

    // Cache the profile so restoreSession() works with no connectivity.
    await SecureTokenStore.saveTeacherSession(profile.id, profile.role);

    return { isAuthenticated: true, teacherId: profile.id, role: profile.role };
  },

  async restoreSession(): Promise<AuthState> {
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
  },

  async logout(): Promise<void> {
    await getSupabase().auth.signOut();
    await SecureTokenStore.clearSession();
    // The cached roster goes with the session. Unsent attendance does not —
    // see clearCachedSchoolData for why the queue survives a sign-out.
    await clearCachedSchoolData();
  },
} as const;
