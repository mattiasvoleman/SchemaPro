import { reminderEntries, requestedEntries, type ReminderRow } from './ack-notices';

/**
 * What a request and its reminder tell: the inbox row has the title, behind the
 * login; the e-mail says that a message waits and nothing else.
 */
describe('Kvittens notices', () => {
  it('puts the title in the inbox row and none of it in the e-mail', () => {
    const { meta, email } = requestedEntries('request-1', 'Utflykt till Skansen');
    expect(meta).toEqual({ requestId: 'request-1', title: 'Utflykt till Skansen' });
    expect(email.subject).toBe('Message from the school / Meddelande från skolan');
    expect(email.body).not.toContain('Skansen');
    expect(email.body).toContain('Logga in i Rastra Schema');
    expect(email.body).toContain('Log in to Rastra timetable');
  });

  describe('reminderEntries', () => {
    const row = (overrides: Partial<ReminderRow> = {}): ReminderRow => ({
      notification_id: 'n-1',
      user_id: 'g-1',
      school_id: 'school-1',
      email: 'g1@example.invalid',
      meta: { requestId: 'request-1', title: 'Utflykt' },
      ...overrides,
    });

    it('makes one entry per school, since an entry has one school, with every guardian told in it', () => {
      const entries = reminderEntries([
        row(),
        row({ notification_id: 'n-2', user_id: 'g-2', email: 'g2@example.invalid' }),
        row({ notification_id: 'n-3', user_id: 'g-3', school_id: 'school-2', email: 'g3@example.invalid' }),
      ]);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        schoolId: 'school-1',
        type: 'ACK_REMINDER',
        recipients: [
          { userId: 'g-1', notificationId: 'n-1' },
          { userId: 'g-2', notificationId: 'n-2' },
        ],
      });
      expect(entries[1]).toMatchObject({ schoolId: 'school-2', recipients: [{ userId: 'g-3', notificationId: 'n-3' }] });
    });

    it('names no title, no child and no text in the e-mail, and sends it only to those with an address', () => {
      const [entry] = reminderEntries([row(), row({ notification_id: 'n-2', user_id: 'g-2', email: null })]);
      expect(entry!.email!.recipients).toEqual([{ userId: 'g-1', email: 'g1@example.invalid' }]);
      expect(entry!.recipients).toHaveLength(2);
      expect(entry!.email!.body).not.toContain('Utflykt');
      expect(entry!.meta).toEqual({});
    });

    it('is nothing for no reminders', () => {
      expect(reminderEntries([])).toEqual([]);
    });
  });
});
