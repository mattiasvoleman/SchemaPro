import * as SecureStore from 'expo-secure-store';

// ─────────────────────────────────────────────────────────────────────────────
// All tokens are stored with WHEN_UNLOCKED_THIS_DEVICE_ONLY so they cannot
// be extracted via iCloud backup or migrated to another device.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'sp_jwt';
const TEACHER_ID_KEY = 'sp_teacher_id';
const ROLE_KEY = 'sp_role';
/**
 * Whether an administrator is marked as teaching (Users.teaches): 'true' or
 * 'false'. A profile cached before the mark was kept has no such key, and an
 * absent key reads as false, so a phone updated in the middle of a session
 * behaves as it did until the profile is read again (recheckProfile).
 */
const TEACHES_KEY = 'sp_teaches';
/** Whose profile it is: the Supabase user id, so a start never pairs one person's session with another's cached profile. */
const AUTH_ID_KEY = 'sp_auth_id';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const SecureTokenStore = {
  async saveToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(TOKEN_KEY, token, STORE_OPTIONS);
  },

  async getToken(): Promise<string | null> {
    return SecureStore.getItemAsync(TOKEN_KEY, STORE_OPTIONS);
  },

  async deleteToken(): Promise<void> {
    await SecureStore.deleteItemAsync(TOKEN_KEY, STORE_OPTIONS);
  },

  async saveTeacherSession(teacherId: string, role: string, authId: string, teaches: boolean): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(TEACHER_ID_KEY, teacherId, STORE_OPTIONS),
      SecureStore.setItemAsync(ROLE_KEY, role, STORE_OPTIONS),
      SecureStore.setItemAsync(AUTH_ID_KEY, authId, STORE_OPTIONS),
      // Written every time, false too: a mark the school has taken away must not outlive the profile it was read from.
      SecureStore.setItemAsync(TEACHES_KEY, teaches ? 'true' : 'false', STORE_OPTIONS),
    ]);
  },

  /**
   * authId is null for a profile cached before it was kept (the restore then adopts the session's), and
   * teaches is false for one cached before the mark was kept.
   */
  async getTeacherSession(): Promise<{ teacherId: string; role: string; authId: string | null; teaches: boolean } | null> {
    const [teacherId, role, authId, teaches] = await Promise.all([
      SecureStore.getItemAsync(TEACHER_ID_KEY, STORE_OPTIONS),
      SecureStore.getItemAsync(ROLE_KEY, STORE_OPTIONS),
      SecureStore.getItemAsync(AUTH_ID_KEY, STORE_OPTIONS),
      SecureStore.getItemAsync(TEACHES_KEY, STORE_OPTIONS),
    ]);
    if (!teacherId || !role) return null;
    return { teacherId, role, authId: authId || null, teaches: teaches === 'true' };
  },

  async clearSession(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(TEACHER_ID_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(ROLE_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(AUTH_ID_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(TEACHES_KEY, STORE_OPTIONS),
    ]);
  },
} as const;
