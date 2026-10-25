import { apiRequest } from './api';
import { translatorFor } from '../i18n';
import {
  fetchPreferences,
  optOutOf,
  preferenceLabel,
  savePreferences,
  withChoice,
  type NotificationPreference,
} from './notificationPreferences';

jest.mock('./api', () => ({ apiRequest: jest.fn() }));

const family: NotificationPreference[] = [
  { type: 'LESSON_CANCELLED', enabled: true, required: false },
  { type: 'LESSON_SUBSTITUTE', enabled: false, required: false },
  { type: 'ABSENCE_UNREPORTED', enabled: true, required: true },
];

describe('notification preferences', () => {
  it('reads the caller’s own list', async () => {
    (apiRequest as jest.Mock).mockResolvedValue({ types: family });
    await expect(fetchPreferences()).resolves.toEqual(family);
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/notification-preferences');
  });

  it('sends the whole set back, naming only what is switched off and not required', async () => {
    (apiRequest as jest.Mock).mockResolvedValue({ types: family });
    await savePreferences(withChoice(family, 'LESSON_CANCELLED', false));
    expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/notification-preferences', {
      method: 'PUT',
      body: { optOut: ['LESSON_CANCELLED', 'LESSON_SUBSTITUTE'] },
    });
  });

  it('never moves or names a required type', () => {
    expect(withChoice(family, 'ABSENCE_UNREPORTED', false)).toEqual(family);
    expect(optOutOf([{ type: 'ABSENCE_UNREPORTED', enabled: false, required: true }])).toEqual([]);
  });

  it('names a type this build does not know as another notice, never by its key', () => {
    const t = translatorFor('sv');
    expect(preferenceLabel(t, 'SUPERVISION_COVER', true)).toBe('Rastvaktspass som vikarie');
    expect(preferenceLabel(t, 'LESSON_SUBSTITUTE', true)).toBe('Vikarier på mina lektioner');
    expect(preferenceLabel(t, 'FROM_A_NEWER_GATEWAY', false)).toBe('Andra notiser');
    expect(preferenceLabel(translatorFor('en'), 'FROM_A_NEWER_GATEWAY', false)).toBe('Other notifications');
  });
});
