import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { ApiError, apiRequest } from './api';
import { loadLocale } from '../i18n/localeStore';
import type { Locale } from '../i18n/translate';

/**
 * This device's push registration, for the signed-in person only.
 *
 * Push is the school's to turn on (PUSH_NOTIFICATIONS on the gateway, off by
 * default) and the person's to accept: nothing here asks the phone for
 * permission until the person turns the switch on in Settings, and nothing is
 * registered while the gateway says push is off.
 *
 * CONSENT IS PER PERSON, NOT PER DEVICE. A teacher tablet is shared, and a
 * device-wide "push on" would register teacher B for push at B's login without
 * B ever choosing it. The flag is `sp_push_enabled_<userId>`, it is cleared at
 * logout, and only the signed-in person's own flag is ever read. (SecureStore
 * keys allow letters, digits, '.', '-' and '_' only, so the user id follows an
 * underscore rather than the colon the design named.)
 *
 * LOGOUT NEVER LEAVES THE DEVICE REGISTERED. unregisterOnLogout asks the
 * gateway to drop this device's row while the session still has its bearer,
 * with a 4-second limit on the whole call (the bearer read included, which
 * may itself try to refresh an expired session) so a dead network cannot hold
 * the logout. If that fails, the token is kept as `sp_push_release` and the
 * phone's own registration is dropped; at the next signed-in start, whoever
 * signs in, releasePending() asks the gateway to delete whichever row holds
 * the token — holding a device's token is the same authority claiming it
 * already rests on. Without that, A's row would live on and A's notices land
 * on the device B now holds.
 *
 * NOR DOES A SIGN-OUT THE APP DID NOT START. A session can end without the
 * logout button: the refresh token revoked (a sign-out on the web is global),
 * expired, or the account closed. releaseOnSignedOut() runs whenever a start
 * finds no session: the stored token becomes `sp_push_release` and the
 * phone's registration is dropped, so the lock screen stops showing A's
 * notices at once. And startSignedIn() releases a stored token whose holder
 * has not turned push on, whoever left it, before refreshing the signed-in
 * person's own registration.
 */

const ENABLED_PREFIX = 'sp_push_enabled_';
const TOKEN_KEY = 'sp_push_token';
const RELEASE_KEY = 'sp_push_release';
const UNREGISTER_TIMEOUT_MS = 4_000;
export const ANDROID_CHANNEL_ID = 'default';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type PushOutcome = 'ENABLED' | 'OFF' | 'SERVER_OFF' | 'DENIED' | 'UNSUPPORTED' | 'FAILED';

const enabledKey = (userId: string): string => `${ENABLED_PREFIX}${userId}`;

async function readKey(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, STORE_OPTIONS);
  } catch {
    return null;
  }
}

async function dropKey(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, STORE_OPTIONS).catch(() => undefined);
}

function platform(): 'IOS' | 'ANDROID' | null {
  if (Platform.OS === 'ios') return 'IOS';
  if (Platform.OS === 'android') return 'ANDROID';
  return null;
}

/** Whether the school's gateway sends push at all (GET /push/config). */
export async function serverPushEnabled(): Promise<boolean> {
  try {
    const config = await apiRequest<{ enabled: boolean }>('/api/v1/push/config');
    return config?.enabled === true;
  } catch {
    return false;
  }
}

/** Whether the signed-in person turned push on for this device. */
export async function isPushEnabledFor(userId: string): Promise<boolean> {
  return (await readKey(enabledKey(userId))) === '1';
}

/** This install's Expo push token, or null where the build cannot have one. */
async function deviceToken(): Promise<string | null> {
  const projectId = process.env['EXPO_PUBLIC_EAS_PROJECT_ID'];
  if (!projectId || platform() === null) return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

async function register(token: string, locale: Locale): Promise<void> {
  await apiRequest<void>('/api/v1/devices', {
    method: 'POST',
    body: { token, platform: platform(), locale },
  });
  await SecureStore.setItemAsync(TOKEN_KEY, token, STORE_OPTIONS);
}

/**
 * The person turns push on: the school must have it, the phone must allow it
 * (asked here, and only here), and the build must be able to get a token.
 */
export async function enablePush(userId: string, locale: Locale): Promise<PushOutcome> {
  if (!(await serverPushEnabled())) return 'SERVER_OFF';
  if (!process.env['EXPO_PUBLIC_EAS_PROJECT_ID'] || platform() === null) return 'UNSUPPORTED';
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return 'DENIED';
    const token = await deviceToken();
    if (!token) return 'UNSUPPORTED';
    await register(token, locale);
    await SecureStore.setItemAsync(enabledKey(userId), '1', STORE_OPTIONS);
    return 'ENABLED';
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PUSH_DISABLED') return 'SERVER_OFF';
    return 'FAILED';
  }
}

/** The person turns push off: this device's row goes, and the flag with it. */
export async function disablePush(userId: string): Promise<void> {
  await dropKey(enabledKey(userId));
  const token = await readKey(TOKEN_KEY);
  if (!token) return;
  try {
    await apiRequest<void>('/api/v1/devices/unregister', { method: 'POST', body: { token } });
    await dropKey(TOKEN_KEY);
  } catch {
    // The row would otherwise outlive the choice; the next start releases it.
    await keepForRelease(token);
  }
}

/**
 * At a signed-in start, and after a language change: the person's own
 * choice, re-registered so the gateway has this token, its locale and a fresh
 * "last seen". Never asks the phone for permission — a switch the person
 * turned on earlier is not consent to ask again.
 */
export async function refreshRegistration(userId: string, locale: Locale): Promise<PushOutcome> {
  if (!(await isPushEnabledFor(userId))) return 'OFF';
  if (!(await serverPushEnabled())) return 'SERVER_OFF';
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return 'DENIED';
    const token = await deviceToken();
    if (!token) return 'UNSUPPORTED';
    await register(token, locale);
    return 'ENABLED';
  } catch {
    return 'FAILED';
  }
}

/**
 * Before the session ends. Never throws and never takes more than about four
 * seconds: a logout must always complete. The limit covers the whole call,
 * not only the gateway's fetch: apiRequest first reads the bearer, and with
 * an expired session that read is a refresh supabase-js retries for up to
 * 30 seconds, which no abort signal reaches.
 */
export async function unregisterOnLogout(userId: string): Promise<void> {
  const wasOn = await isPushEnabledFor(userId);
  await dropKey(enabledKey(userId));
  const token = await readKey(TOKEN_KEY);
  if (!wasOn || !token) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, UNREGISTER_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([
      apiRequest<void>('/api/v1/devices/unregister', {
        method: 'POST',
        body: { token },
        signal: controller.signal,
      }).then(() => 'done' as const),
      timedOut,
    ]);
    if (outcome === 'timeout') throw new Error('unregister timed out');
    await dropKey(TOKEN_KEY);
  } catch {
    await keepForRelease(token);
  } finally {
    clearTimeout(timer);
  }
}

/** The row stays on the gateway for now: released at the next signed-in start, and the phone stops receiving at once. */
async function keepForRelease(token: string): Promise<void> {
  await SecureStore.setItemAsync(RELEASE_KEY, token, STORE_OPTIONS).catch(() => undefined);
  await dropKey(TOKEN_KEY);
  await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
}

/**
 * A start that finds no session (restoreSession answered signed-out): the
 * previous holder's session ended without the logout button. Their row is
 * released at the next signed-in start; the phone stops receiving now.
 */
export async function releaseOnSignedOut(): Promise<void> {
  const token = await readKey(TOKEN_KEY);
  if (!token) return;
  await keepForRelease(token);
}

/**
 * At the next signed-in start, whoever signed in: a token a failed logout
 * left registered is released (POST /devices/release deletes whichever row
 * holds it). Kept for another try if the gateway cannot be reached.
 */
export async function releasePending(): Promise<void> {
  const token = await readKey(RELEASE_KEY);
  if (!token) return;
  try {
    await apiRequest<void>('/api/v1/devices/release', { method: 'POST', body: { token } });
    await dropKey(RELEASE_KEY);
  } catch {
    // Next start tries again.
  }
}

/**
 * At a signed-in start: first whatever an earlier logout or sign-out left
 * for release; then a stored token whose signed-in holder has not turned push
 * on (it can only be somebody else's, or a choice since withdrawn); then the
 * signed-in person's own registration, in the language stored on the device
 * (read here, not from the screen's context, which starts in Swedish before
 * the stored choice has loaded).
 */
export async function startSignedIn(userId: string): Promise<PushOutcome> {
  await releasePending();
  const stored = await readKey(TOKEN_KEY);
  // A release still pending here means the gateway cannot be reached: the
  // stored token waits for the next start rather than overwrite it.
  if (stored && !(await isPushEnabledFor(userId)) && !(await readKey(RELEASE_KEY))) {
    await keepForRelease(stored);
    await releasePending();
  }
  return refreshRegistration(userId, await loadLocale());
}

/**
 * A tap on a notification the app has not yet acted on. expo-notifications
 * keeps the last response until it is cleared, so without clearing it every
 * later sign-in or role change in the same process would replay it.
 */
export function takeLastTap(): boolean {
  try {
    const response = Notifications.getLastNotificationResponse();
    if (!response) return false;
    Notifications.clearLastNotificationResponse();
    return true;
  } catch {
    return false;
  }
}

/** A tap the running app's listener has acted on: never replayed. */
export function forgetTap(): void {
  try {
    Notifications.clearLastNotificationResponse();
  } catch {
    // Nothing kept to replay.
  }
}

/**
 * Android shows the channel's name in the phone's notification settings, so
 * it is (re)created in the reader's language at start and on a change.
 */
export async function ensureAndroidChannel(name: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name,
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#6366f1',
  }).catch(() => undefined);
}
