import * as SecureStore from 'expo-secure-store';
import type { Locale } from './translate';

/**
 * The reader's chosen language, on this device.
 *
 * Swedish unless English was chosen in Settings (or on the login screen).
 * The device's own locale is deliberately not read: the app is a Swedish
 * school's, the school's words (subjects, rooms, the school's notices) are
 * Swedish whatever the phone says, and reading it would need
 * expo-localization — a native module for a default the reader can change in
 * one tap. It survives logout: the language is the device holder's, not the
 * session's, and the login screen should greet them in it.
 */
const LOCALE_KEY = 'sp_locale';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const DEFAULT_LOCALE: Locale = 'sv';

export async function loadLocale(): Promise<Locale> {
  try {
    const stored = await SecureStore.getItemAsync(LOCALE_KEY, STORE_OPTIONS);
    return stored === 'en' || stored === 'sv' ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function saveLocale(locale: Locale): Promise<void> {
  await SecureStore.setItemAsync(LOCALE_KEY, locale, STORE_OPTIONS);
}
