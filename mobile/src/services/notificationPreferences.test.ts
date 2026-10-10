import { apiRequest } from './api';
import { fetchPreferences, optOutOf, savePreferences, withChoice, type NotificationPreference } from './notificationPreferences';

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
});
