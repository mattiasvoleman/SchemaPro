import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { apiRequest, ApiError } from './api';
import {
  disablePush,
  enablePush,
  ensureAndroidChannel,
  isPushEnabledFor,
  refreshRegistration,
  releasePending,
  serverPushEnabled,
  unregisterOnLogout,
} from './pushRegistration';

/**
 * Push registration on a device several people may share. Under test: push
 * is asked for only when the person turns it on and the school has it; the
 * consent is the signed-in person's own (teacher B never inherits A's
 * switch); logout always ends with this device off A's push — directly, or
 * through the release at the next start when the network was gone — and
 * never hangs on a dead network for more than the 4-second limit.
 */

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-this-device',
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid SecureStore key ${key}`);
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  unregisterForNotificationsAsync: jest.fn(async () => undefined),
  setNotificationChannelAsync: jest.fn(async () => null),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./api', () => ({ ...jest.requireActual('./api'), apiRequest: jest.fn() }));
jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));

// apiRequest is mocked, so nothing here fetches. Defined outright so that
// jest's fake timers, which walk the globals, do not trip expo's lazy fetch
// getter (and its native-module require) after the suite is done.
Object.defineProperty(global, 'fetch', { value: jest.fn(), writable: true, configurable: true });

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const TOKEN = 'ExponentPushToken[abcdefghij]';

type Route = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
let route: Route;
const calls = () => (apiRequest as jest.Mock).mock.calls.map(([path, options]) => [path, options?.body ?? null]);

beforeEach(() => {
  mockStore.clear();
  process.env['EXPO_PUBLIC_EAS_PROJECT_ID'] = 'eas-project';
  route = async (path) => (path === '/api/v1/push/config' ? { enabled: true } : undefined);
  (apiRequest as jest.Mock).mockReset().mockImplementation((path: string, options?: never) => route(path, options));
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ type: 'expo', data: TOKEN });
  (Notifications.unregisterForNotificationsAsync as jest.Mock).mockClear();
});

describe('turning push on', () => {
  it('asks the school first, then the phone, then registers this device with the reader’s language', async () => {
    await expect(enablePush(A, 'sv')).resolves.toBe('ENABLED');
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'eas-project' });
    expect(calls()).toEqual([
      ['/api/v1/push/config', null],
      ['/api/v1/devices', { token: TOKEN, platform: 'ANDROID', locale: 'sv' }],
    ]);
    expect(await isPushEnabledFor(A)).toBe(true);
    expect(mockStore.get(`sp_push_enabled_${A}`)).toBe('1');
  });

  it('asks the phone nothing when the school has push off', async () => {
    route = async (path) => (path === '/api/v1/push/config' ? { enabled: false } : undefined);
    await expect(enablePush(A, 'sv')).resolves.toBe('SERVER_OFF');
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(await isPushEnabledFor(A)).toBe(false);
  });

  it('says the gateway’s PUSH_DISABLED as the school having push off', async () => {
    route = async (path) => {
      if (path === '/api/v1/push/config') return { enabled: true };
      throw new ApiError(409, 'Push är avstängt.', 'PUSH_DISABLED');
    };
    await expect(enablePush(A, 'sv')).resolves.toBe('SERVER_OFF');
    expect(await isPushEnabledFor(A)).toBe(false);
  });

  it('stops at a refusal on the phone, and at a build without an EAS project', async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(enablePush(A, 'sv')).resolves.toBe('DENIED');
    delete process.env['EXPO_PUBLIC_EAS_PROJECT_ID'];
    await expect(enablePush(A, 'sv')).resolves.toBe('UNSUPPORTED');
    expect(calls().filter(([path]) => path === '/api/v1/devices')).toEqual([]);
  });

  it('answers false for the school’s switch when the gateway cannot be reached', async () => {
    route = async () => {
      throw new Error('network');
    };
    await expect(serverPushEnabled()).resolves.toBe(false);
  });
});

describe('consent is per person on a shared device', () => {
  it('never registers B on the strength of A’s switch', async () => {
    await enablePush(A, 'sv');
    (apiRequest as jest.Mock).mockClear();
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
    await expect(refreshRegistration(B, 'sv')).resolves.toBe('OFF');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('refreshes A’s own registration, with a new language, and never asks the phone again', async () => {
    await enablePush(A, 'sv');
    (apiRequest as jest.Mock).mockClear();
    (Notifications.requestPermissionsAsync as jest.Mock).mockClear();
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
    await expect(refreshRegistration(A, 'en')).resolves.toBe('ENABLED');
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(calls()).toContainEqual(['/api/v1/devices', { token: TOKEN, platform: 'ANDROID', locale: 'en' }]);
  });

  it('does not refresh once the phone’s permission is gone', async () => {
    await enablePush(A, 'sv');
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(refreshRegistration(A, 'sv')).resolves.toBe('DENIED');
  });
});

describe('logout never leaves the device registered', () => {
  it('unregisters this device’s row and clears A’s switch', async () => {
    await enablePush(A, 'sv');
    (apiRequest as jest.Mock).mockClear();
    await unregisterOnLogout(A);
    expect(calls()).toEqual([['/api/v1/devices/unregister', { token: TOKEN }]]);
    expect((apiRequest as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(await isPushEnabledFor(A)).toBe(false);
    expect(mockStore.has('sp_push_release')).toBe(false);
  });

  it('gives up after four seconds and leaves the token for release at the next start', async () => {
    jest.useFakeTimers();
    try {
      await enablePush(A, 'sv');
      route = (path, options) =>
        path === '/api/v1/devices/unregister'
          ? new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve(undefined);
      const done = unregisterOnLogout(A);
      await jest.advanceTimersByTimeAsync(3_999);
      expect(mockStore.has('sp_push_release')).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await done;
      expect(mockStore.get('sp_push_release')).toBe(TOKEN);
      expect(Notifications.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
      expect(await isPushEnabledFor(A)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the left-over token at the next signed-in start, whoever signs in', async () => {
    mockStore.set('sp_push_release', TOKEN);
    await releasePending();
    expect(calls()).toEqual([['/api/v1/devices/release', { token: TOKEN }]]);
    expect(mockStore.has('sp_push_release')).toBe(false);
  });

  it('keeps the token for another try when the release cannot reach the gateway', async () => {
    mockStore.set('sp_push_release', TOKEN);
    route = async () => {
      throw new Error('network');
    };
    await releasePending();
    expect(mockStore.get('sp_push_release')).toBe(TOKEN);
  });

  it('does nothing at logout for a person who never turned push on', async () => {
    mockStore.set('sp_push_token', TOKEN);
    await unregisterOnLogout(B);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('drops the row when the person turns push off, and keeps it for release if that fails', async () => {
    await enablePush(A, 'sv');
    route = async () => {
      throw new Error('network');
    };
    await disablePush(A);
    expect(await isPushEnabledFor(A)).toBe(false);
    expect(mockStore.get('sp_push_release')).toBe(TOKEN);
  });
});

describe('the Android channel', () => {
  it('is named in the reader’s language', async () => {
    await ensureAndroidChannel('Skolans notiser');
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
      name: 'Skolans notiser',
      importance: 3,
      lightColor: '#6366f1',
    });
  });
});

it('uses only keys SecureStore accepts (letters, digits, ".", "-", "_")', async () => {
  await enablePush(A, 'sv');
  route = async () => {
    throw new Error('network');
  };
  await unregisterOnLogout(A);
  const keys = (SecureStore.setItemAsync as jest.Mock).mock.calls.map(([key]) => key as string);
  expect(keys).toEqual(expect.arrayContaining([`sp_push_enabled_${A}`, 'sp_push_token', 'sp_push_release']));
  expect(keys.filter((key) => !/^[\w.-]+$/.test(key))).toEqual([]);
});
