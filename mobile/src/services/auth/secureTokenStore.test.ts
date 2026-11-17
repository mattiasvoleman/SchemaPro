import * as SecureStore from 'expo-secure-store';
import { SecureTokenStore } from './secureTokenStore';

/**
 * The cached profile: who the person is, which role they hold and, since the
 * administrator who teaches (Users.teaches), whether they are marked. The
 * keychain holds strings, so the mark is the string 'true' or 'false', and a
 * profile cached before the mark was kept has no such key, which reads as
 * not marked: a phone updated in the middle of a session behaves as before
 * until the school's row is read again.
 */

const mockItems = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockItems.set(key, value);
  }),
  getItemAsync: jest.fn(async (key: string) => mockItems.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockItems.delete(key);
  }),
}));

beforeEach(() => {
  mockItems.clear();
});

describe('SecureTokenStore.saveTeacherSession and getTeacherSession', () => {
  it('keeps the mark beside the role, and gives it back as a boolean', async () => {
    await SecureTokenStore.saveTeacherSession('u-1', 'SCHOOL_ADMIN', 'auth-1', true);
    expect(mockItems.get('sp_teaches')).toBe('true');
    await expect(SecureTokenStore.getTeacherSession()).resolves.toEqual({ teacherId: 'u-1', role: 'SCHOOL_ADMIN', authId: 'auth-1', teaches: true });
  });

  it('writes a mark that is gone as false, so one the school has taken away does not outlive its profile', async () => {
    await SecureTokenStore.saveTeacherSession('u-1', 'SCHOOL_ADMIN', 'auth-1', true);
    await SecureTokenStore.saveTeacherSession('u-1', 'SCHOOL_ADMIN', 'auth-1', false);
    expect(mockItems.get('sp_teaches')).toBe('false');
    await expect(SecureTokenStore.getTeacherSession()).resolves.toMatchObject({ teaches: false });
  });

  it('reads a profile cached before the mark was kept as not marked', async () => {
    mockItems.set('sp_teacher_id', 'u-1');
    mockItems.set('sp_role', 'SCHOOL_ADMIN');
    mockItems.set('sp_auth_id', 'auth-1');
    await expect(SecureTokenStore.getTeacherSession()).resolves.toEqual({ teacherId: 'u-1', role: 'SCHOOL_ADMIN', authId: 'auth-1', teaches: false });
  });

  it.each(['TRUE', '1', 'yes', ''])('reads only the string true as a mark, not %p', async (value) => {
    await SecureTokenStore.saveTeacherSession('u-1', 'SCHOOL_ADMIN', 'auth-1', false);
    mockItems.set('sp_teaches', value);
    await expect(SecureTokenStore.getTeacherSession()).resolves.toMatchObject({ teaches: false });
  });

  it('has no session without an id and a role, whatever the mark says', async () => {
    mockItems.set('sp_teaches', 'true');
    await expect(SecureTokenStore.getTeacherSession()).resolves.toBeNull();
    mockItems.set('sp_teacher_id', 'u-1');
    await expect(SecureTokenStore.getTeacherSession()).resolves.toBeNull();
  });

  it('forgets the mark with the rest of the session, so the next person on the phone does not inherit it', async () => {
    await SecureTokenStore.saveTeacherSession('u-1', 'SCHOOL_ADMIN', 'auth-1', true);
    await SecureTokenStore.saveToken('jwt');
    await SecureTokenStore.clearSession();
    expect([...mockItems.keys()]).toEqual([]);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('sp_teaches', expect.anything());
    await expect(SecureTokenStore.getTeacherSession()).resolves.toBeNull();
  });
});
