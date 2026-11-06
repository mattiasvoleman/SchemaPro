import { PUSH_TEMPLATES, pushKindOf, pushText } from '../notifications/push-messages';
import { digestEntries, digestSentences, reminderEntries, reminderSentences, type NoticeRow } from './reporting-rate-notices';

const reminder = (n: number, count: number, limitDays = 2, email: string | null = `teacher${n}@example.invalid`): NoticeRow => ({
  notification_id: `notice-${n}`,
  user_id: `user-${n}`,
  email,
  meta: { count, limitDays },
});
const digest = (n: number, held = 120, reported = 90, teachers = 8, email: string | null = `rektor${n}@example.invalid`): NoticeRow => ({
  notification_id: `notice-${n}`,
  user_id: `user-${n}`,
  email,
  meta: { periodStart: '2026-10-12', periodEnd: '2026-10-18', held, reported, teachers },
});

/** Nothing a notice says may name a person, a subject, a class, a room or a time of day. */
const NAMES_NOBODY = /@|\d{1,2}:\d{2}|klass|class|ämne|subject|rum\b|room|lärare [A-ZÅÄÖ]/;

describe('reminderSentences', () => {
  it('tells a teacher how many lessons wait and how long the school lets one wait, in both languages', () => {
    const { en, sv } = reminderSentences(3, 2);
    expect(en).toBe(
      '3 new lessons were held at least 2 days ago and have no saved attendance. Older open lessons may remain. Log in to Rastra timetable to see them all.',
    );
    expect(sv).toBe(
      '3 nya lektioner hölls för minst 2 dagar sedan och saknar sparad närvaro. Äldre öppna lektioner kan finnas kvar. Logga in i Rastra Schema för att se alla.',
    );
  });

  it('uses the singular for one lesson and for a limit of one day', () => {
    const { en, sv } = reminderSentences(1, 1);
    expect(en).toContain('1 new lesson was held at least 1 day ago and has no saved attendance');
    expect(sv).toContain('1 ny lektion hölls för minst 1 dag sedan');
    expect(reminderSentences(1, 5).en).toContain('1 new lesson was held at least 5 days ago');
    expect(reminderSentences(2, 1).sv).toContain('2 nya lektioner hölls för minst 1 dag sedan');
  });

  it('names no subject, class, room or time', () => {
    for (const [count, limit] of [[1, 1], [3, 2], [12, 30]] as const) {
      const { en, sv } = reminderSentences(count, limit);
      expect(en).not.toMatch(NAMES_NOBODY);
      expect(sv).not.toMatch(NAMES_NOBODY);
    }
  });
});

describe('digestSentences', () => {
  it('tells a rektor last week’s share for the school as a whole, in both languages', () => {
    const { en, sv } = digestSentences(120, 90, 8, '2026-10-12', '2026-10-18');
    expect(en).toBe(
      'Last week (2026-10-12 – 2026-10-18), 90 of 120 held lessons had a saved register (75%), spread over 8 teachers. Log in to Rastra timetable to see more.',
    );
    expect(sv).toBe(
      'Förra veckan (2026-10-12 – 2026-10-18) hade 90 av 120 hållna lektioner sparad närvaro (75 %), fördelade på 8 lärare. Logga in i Rastra Schema för att se mer.',
    );
  });

  it('rounds the share to a whole percent', () => {
    expect(digestSentences(3, 1, 1, '2026-10-12', '2026-10-18').en).toContain('(33%)');
    expect(digestSentences(3, 2, 1, '2026-10-12', '2026-10-18').sv).toContain('(67 %)');
    expect(digestSentences(200, 199, 9, '2026-10-12', '2026-10-18').en).toContain('(100%)');
  });

  it('uses the singular for one lesson and one teacher', () => {
    const { en, sv } = digestSentences(1, 1, 1, '2026-10-12', '2026-10-18');
    expect(en).toContain('1 of 1 held lesson had a saved register (100%), spread over 1 teacher.');
    expect(sv).toContain('1 av 1 hållen lektion sparad närvaro (100 %), fördelade på 1 lärare.');
  });

  it('leaves the share out rather than divide by nothing', () => {
    const { en, sv } = digestSentences(0, 0, 0, '2026-10-12', '2026-10-18');
    expect(en).toContain('0 of 0 held lessons had a saved register, spread over 0 teachers.');
    expect(sv).not.toContain('%');
  });

  it('names no teacher, subject or class', () => {
    const { en, sv } = digestSentences(120, 90, 8, '2026-10-12', '2026-10-18');
    expect(en).not.toMatch(NAMES_NOBODY);
    expect(sv).not.toMatch(NAMES_NOBODY);
  });
});

describe('reminderEntries', () => {
  it('writes one entry for everybody who hears the same and one more for each other pair of counts', () => {
    const entries = reminderEntries('school-1', [reminder(1, 2), reminder(2, 2), reminder(3, 5), reminder(4, 2, 7)]);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.recipients.map((r) => r.userId)).toEqual(['user-1', 'user-2']);
    expect(entries[1]!.recipients.map((r) => r.userId)).toEqual(['user-3']);
    expect(entries[1]!.email!.body).toContain('5 new lessons');
    expect(entries[2]!.email!.body).toContain('at least 7 days');
  });

  it('is a LESSON_REPORT_REMINDER of the school, carrying the notice ids the database gave', () => {
    const [entry] = reminderEntries('school-1', [reminder(1, 2)]);
    expect(entry).toMatchObject({
      schoolId: 'school-1',
      type: 'LESSON_REPORT_REMINDER',
      meta: { count: 2, limitDays: 2 },
      recipients: [{ userId: 'user-1', notificationId: 'notice-1' }],
    });
  });

  it('mails only those with an address, in English then Swedish', () => {
    const [entry] = reminderEntries('school-1', [reminder(1, 2), reminder(2, 2, 2, null)]);
    expect(entry!.email!.recipients).toEqual([{ userId: 'user-1', email: 'teacher1@example.invalid' }]);
    expect(entry!.email!.subject).toBe('Lessons waiting for attendance / Lektioner väntar på närvaro');
    expect(entry!.email!.body.split('\n\n')).toHaveLength(2);
    expect(entry!.recipients).toHaveLength(2);
  });

  it('carries no address in the text, and reads a count it cannot trust as none', () => {
    const [entry] = reminderEntries('school-1', [{ ...reminder(1, 2), meta: { count: 'many', limitDays: -3 } }]);
    expect(entry!.email!.body).not.toContain('@');
    expect(entry!.email!.body).toContain('0 new lessons were held at least 0 days ago');
  });

  it('answers nothing for nothing written', () => {
    expect(reminderEntries('school-1', [])).toEqual([]);
  });
});

describe('digestEntries', () => {
  it('writes one entry for the week, to every rektor, with the numbers once', () => {
    const entries = digestEntries('school-1', [digest(1), digest(2)]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      schoolId: 'school-1',
      type: 'REPORTING_RATE_DIGEST',
      meta: { periodStart: '2026-10-12', periodEnd: '2026-10-18', held: 120, reported: 90, teachers: 8 },
    });
    expect(entries[0]!.recipients).toEqual([
      { userId: 'user-1', notificationId: 'notice-1' },
      { userId: 'user-2', notificationId: 'notice-2' },
    ]);
    expect(entries[0]!.email!.subject).toBe('Reporting rate / Rapporteringsgrad');
    expect(entries[0]!.email!.body).toContain('90 of 120');
    expect(entries[0]!.email!.body).toContain('90 av 120');
  });

  it('mails only those with an address', () => {
    const [entry] = digestEntries('school-1', [digest(1), digest(2, 120, 90, 8, null)]);
    expect(entry!.email!.recipients).toEqual([{ userId: 'user-1', email: 'rektor1@example.invalid' }]);
    expect(entry!.recipients).toHaveLength(2);
  });

  it('keeps two weeks apart if the database ever hands back both', () => {
    const other = { ...digest(3), meta: { periodStart: '2026-10-05', periodEnd: '2026-10-11', held: 100, reported: 80, teachers: 7 } };
    expect(digestEntries('school-1', [digest(1), other])).toHaveLength(2);
  });

  it('answers nothing for nothing written', () => {
    expect(digestEntries('school-1', [])).toEqual([]);
  });
});

describe('what a push says of the two types', () => {
  it.each(['LESSON_REPORT_REMINDER', 'REPORTING_RATE_DIGEST'] as const)('%s has a text in both languages, with no figure, name or time', (type) => {
    const kind = pushKindOf(type, { count: 7, limitDays: 2, held: 120, reported: 90, teachers: 8 })!;
    expect(kind).toBe(type);
    for (const locale of ['sv', 'en'] as const) {
      expect(PUSH_TEMPLATES[locale][kind]).toBeDefined();
      for (const count of [1, 3]) {
        const { title, body } = pushText(kind, { count: 7, limitDays: 2, held: 120, reported: 90, teachers: 8, startsAt: '2026-10-12T08:00:00Z' }, locale, 'Europe/Stockholm', count);
        expect(`${title} ${body}`).not.toMatch(/\d/);
        expect(`${title} ${body}`).not.toMatch(NAMES_NOBODY);
        expect(body.length).toBeGreaterThan(10);
      }
    }
  });
});
