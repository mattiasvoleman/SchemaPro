import * as SecureStore from 'expo-secure-store';

// ─────────────────────────────────────────────────────────────────────────────
// All tokens are stored with WHEN_UNLOCKED_THIS_DEVICE_ONLY so they cannot
// be extracted via iCloud backup or migrated to another device.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'sp_jwt';
const TEACHER_ID_KEY = 'sp_teacher_id';
const ROLE_KEY = 'sp_role';

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

  async saveTeacherSession(teacherId: string, role: string): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(TEACHER_ID_KEY, teacherId, STORE_OPTIONS),
      SecureStore.setItemAsync(ROLE_KEY, role, STORE_OPTIONS),
    ]);
  },

  async getTeacherSession(): Promise<{ teacherId: string; role: string } | null> {
    const [teacherId, role] = await Promise.all([
      SecureStore.getItemAsync(TEACHER_ID_KEY, STORE_OPTIONS),
      SecureStore.getItemAsync(ROLE_KEY, STORE_OPTIONS),
    ]);
    if (!teacherId || !role) return null;
    return { teacherId, role };
  },

  async clearSession(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(TEACHER_ID_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(ROLE_KEY, STORE_OPTIONS),
    ]);
  },
} as const;
