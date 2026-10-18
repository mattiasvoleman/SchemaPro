import { AuthRetryableFetchError } from '@supabase/supabase-js';

/**
 * Ending a session on this device must leave nothing for the next start to
 * restore, offline too: supabase-js returns before removing the stored
 * session when it cannot refresh an expired one (GoTrueClient _signOut).
 */
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-this-device',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
jest.mock('react-native-url-polyfill/auto', () => ({}));
const mockSignOut = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: jest.fn(() => ({ auth: { signOut: mockSignOut } })),
}));

process.env['EXPO_PUBLIC_SUPABASE_URL'] = 'https://projref.supabase.co';
process.env['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] = 'sb_publishable_test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { endSessionHere, storedSessionUserId } = require('./supabase') as typeof import('./supabase');

const KEY = 'sb-projref-auth-token';
beforeEach(() => {
  mockStore.clear();
  for (const [k, v] of [[KEY, '2'], [`${KEY}__chunk_0`, '{"access'], [`${KEY}__chunk_1`, '_token":"x"}'], [`${KEY}-code-verifier`, '1'], [`${KEY}-code-verifier__chunk_0`, 'v'], ['sp_sqlcipher_key', 'k'], ['sp_locale', 'en']] as const) mockStore.set(k, v);
});

it('removes the stored session itself when supabase-js could not reach Auth', async () => {
  mockSignOut.mockResolvedValue({ error: new AuthRetryableFetchError('Network request failed', 0) });
  await endSessionHere('local');
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  expect([...mockStore.keys()].sort()).toEqual(['sp_locale', 'sp_sqlcipher_key']);
});

it('leaves the removal to supabase-js when it signed out', async () => {
  mockSignOut.mockResolvedValue({ error: null });
  await endSessionHere('global');
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'global' });
  expect(mockStore.has(KEY)).toBe(true);
});

it('reads the stored session’s user without the network, and nothing from a broken value', async () => {
  const json = JSON.stringify({ access_token: 'a', refresh_token: 'r', user: { id: 'auth-1' } });
  mockStore.set(KEY, '1');
  mockStore.set(`${KEY}__chunk_0`, json);
  await expect(storedSessionUserId()).resolves.toBe('auth-1');
  mockStore.set(`${KEY}__chunk_0`, '{not json');
  await expect(storedSessionUserId()).resolves.toBeNull();
  mockStore.clear();
  await expect(storedSessionUserId()).resolves.toBeNull();
});
