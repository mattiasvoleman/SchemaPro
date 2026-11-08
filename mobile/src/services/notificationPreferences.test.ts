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
    expect(preferenceLabel(t, 'ABSENCE_WATCH_DIGEST', true)).toBe('Frånvarosammanställning');
    expect(preferenceLabel(translatorFor('en'), 'ABSENCE_WATCH_DIGEST', true)).toBe('Absence summary');
    expect(preferenceLabel(t, 'LESSON_REPORT_REMINDER', true)).toBe('Påminnelser om öppna lektioner');
    expect(preferenceLabel(translatorFor('en'), 'LESSON_REPORT_REMINDER', true)).toBe('Reminders about open lessons');
    expect(preferenceLabel(t, 'REPORTING_RATE_DIGEST', true)).toBe('Veckobesked om rapporteringsgrad');
    expect(preferenceLabel(translatorFor('en'), 'REPORTING_RATE_DIGEST', true)).toBe('Weekly reporting-rate note');
    expect(preferenceLabel(t, 'EXTERNAL_BOOKING_CLASH', true)).toBe('Externa bokningar som krockar med en lektion');
    expect(preferenceLabel(translatorFor('en'), 'EXTERNAL_BOOKING_CLASH', true)).toBe('External bookings that clash with a lesson');
    expect(preferenceLabel(t, 'ACK_REQUESTED', true)).toBe('Meddelanden som ber om bekräftelse');
    expect(preferenceLabel(translatorFor('en'), 'ACK_REQUESTED', true)).toBe('Messages that ask for confirmation');
    expect(preferenceLabel(t, 'ACK_REMINDER', true)).toBe('Påminnelse om obekräftade meddelanden');
    expect(preferenceLabel(translatorFor('en'), 'ACK_REMINDER', true)).toBe('Reminder about unconfirmed messages');
    expect(preferenceLabel(t, 'LESSON_PUPIL_MOVED', true)).toBe('Elever som byter lektion för en dag');
    expect(preferenceLabel(translatorFor('en'), 'LESSON_PUPIL_MOVED', true)).toBe('Pupils who change lesson for a day');
    expect(preferenceLabel(t, 'LESSON_SUBSTITUTE', true)).toBe('Vikarier på mina lektioner');
    expect(preferenceLabel(t, 'FROM_A_NEWER_GATEWAY', false)).toBe('Andra notiser');
    expect(preferenceLabel(translatorFor('en'), 'FROM_A_NEWER_GATEWAY', false)).toBe('Other notifications');
  });

  it('names the three cover-request types the gateway offers by role, in both languages', () => {
    // TEACHER gets the question and its end, SCHOOL_ADMIN the answer and, in the end's own type, that nobody said yes (TYPES_BY_ROLE).
    expect(
      (['COVER_REQUESTED', 'COVER_REQUEST_CLOSED', 'COVER_REQUEST_ACCEPTED'] as const).map((type) => [
        preferenceLabel(translatorFor('sv'), type, true),
        preferenceLabel(translatorFor('en'), type, true),
      ]),
    ).toEqual([
      ['Förfrågningar om att vikariera', 'Requests to cover a lesson'],
      [
        'Vikarieförfrågningar som tillsatts, dragits tillbaka eller gått ut utan svar',
        'Cover requests that were filled, withdrawn or ran out unanswered',
      ],
      ['Svar på dina vikarieförfrågningar', 'Answers to your cover requests'],
    ]);
  });
});
