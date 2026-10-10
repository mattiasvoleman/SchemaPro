import * as SecureStore from 'expo-secure-store';
import { DEFAULT_LOCALE, loadLocale, saveLocale } from './localeStore';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-this-device',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
}));

describe('the stored language', () => {
  it('is Swedish when nothing, or nothing known, is stored, and when the keychain fails', async () => {
    expect(DEFAULT_LOCALE).toBe('sv');
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null);
    await expect(loadLocale()).resolves.toBe('sv');
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('de');
    await expect(loadLocale()).resolves.toBe('sv');
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('locked'));
    await expect(loadLocale()).resolves.toBe('sv');
  });

  it('is English once chosen, under a key that survives logout', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('en');
    await expect(loadLocale()).resolves.toBe('en');
    await saveLocale('en');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('sp_locale', 'en', { keychainAccessible: 'unlocked-this-device' });
  });
});
