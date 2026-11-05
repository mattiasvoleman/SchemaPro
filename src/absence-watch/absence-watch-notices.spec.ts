import { digestEntries, digestSentences, type DigestRow } from './absence-watch-notices';

const meta = (group: string, open: number, crossed: number) => ({
  group,
  periodStart: '2026-09-21',
  periodEnd: '2026-09-27',
  open,
  crossed,
});
const row = (n: number, group: string, open: number, crossed: number, email: string | null = `user${n}@example.invalid`): DigestRow => ({
  notification_id: `notice-${n}`,
  user_id: `user-${n}`,
  email,
  meta: meta(group, open, crossed),
});

describe('digestSentences', () => {
  it('tells staff how many pupils are over a limit now and how many passed one in the period, in both languages', () => {
    const { en, sv } = digestSentences('MENTOR', 3, 2, '2026-09-21', '2026-09-27');
    expect(en).toBe(
      "3 pupils are over one of the school's absence limits now. 2 pupils passed a limit 2026-09-21 – 2026-09-27. Log in to Rastra timetable to see who.",
    );
    expect(sv).toBe(
      '3 elever är över en av skolans gränser för frånvaro nu. 2 elever passerade en gräns 2026-09-21 – 2026-09-27. Logga in i Rastra Schema för att se vilka.',
    );
  });

  it('never says the pupils who crossed are among those who are over a limit: the two counts are about different pupils', () => {
    // One pupil is over a limit now; three crossed in the period and two of them are back under.
    const { en, sv } = digestSentences('REKTOR', 1, 3, '2026-09-14', '2026-09-20');
    expect(en).toBe(
      "1 pupil is over one of the school's absence limits now. 3 pupils passed a limit 2026-09-14 – 2026-09-20. Log in to Rastra timetable to see who.",
    );
    expect(en).not.toMatch(/of them/);
    expect(sv).not.toMatch(/av dem/);
  });

  it('uses the singular for one pupil, and leaves the crossing out when nobody crossed in the period', () => {
    expect(digestSentences('REKTOR', 1, 0, '2026-09-21', '2026-09-27').en).toBe(
      "1 pupil is over one of the school's absence limits now. Log in to Rastra timetable to see who.",
    );
    expect(digestSentences('KANSLI', 1, 0, '2026-09-21', '2026-09-27').sv).toBe(
      '1 elev är över en av skolans gränser för frånvaro nu. Logga in i Rastra Schema för att se vilka.',
    );
    expect(digestSentences('KANSLI', 2, 1, '2026-09-21', '2026-09-27').sv).toContain('1 elev passerade en gräns');
  });

  it('says who came back under when none is over a limit now', () => {
    expect(digestSentences('MENTOR', 0, 2, '2026-09-21', '2026-09-27').en).toBe(
      '2 pupils passed a limit 2026-09-21 – 2026-09-27 and are under it again. Log in to Rastra timetable to see who.',
    );
    expect(digestSentences('MENTOR', 0, 1, '2026-09-21', '2026-09-27').sv).toBe(
      '1 elev passerade en gräns 2026-09-21 – 2026-09-27 och är under den igen. Logga in i Rastra Schema för att se vilka.',
    );
    expect(digestSentences('MENTOR', 0, 1, '2026-09-21', '2026-09-27').en).toContain('is under it again');
  });

  it('tells a guardian of their children, not of pupils, and counts the children who came back under', () => {
    expect(digestSentences('GUARDIAN', 1, 1, '2026-09-01', '2026-09-30').en).toContain('One of your children is over a limit');
    expect(digestSentences('GUARDIAN', 2, 2, '2026-09-01', '2026-09-30').sv).toContain('2 av dina barn har frånvaro över en gräns');
    expect(digestSentences('GUARDIAN', 0, 1, '2026-09-01', '2026-09-30').sv).toContain('Ett av dina barn passerade en gräns');
    const two = digestSentences('GUARDIAN', 0, 2, '2026-09-01', '2026-09-30');
    expect(two.en).toContain('2 of your children passed a limit');
    expect(two.sv).toContain('2 av dina barn passerade en gräns');
    expect(two.en).not.toContain('One of');
  });

  it.each(['MENTOR', 'REKTOR', 'KANSLI', 'GUARDIAN'] as const)('names no pupil, no minutes and no reason for %s', (group) => {
    for (const [open, crossed] of [
      [3, 2],
      [1, 0],
      [0, 2],
    ] as const) {
      const { en, sv } = digestSentences(group, open, crossed, '2026-09-21', '2026-09-27');
      for (const text of [en, sv]) {
        expect(text).not.toMatch(/min|minut|sick|sjuk|anledning|reason|@/i);
      }
    }
  });
});

describe('digestEntries', () => {
  it('writes one entry for everybody who hears the same, and one more for each other pair of counts', () => {
    const entries = digestEntries('school-1', [row(1, 'MENTOR', 2, 1), row(2, 'MENTOR', 2, 1), row(3, 'MENTOR', 5, 0)]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.recipients.map((r) => r.userId)).toEqual(['user-1', 'user-2']);
    expect(entries[1]!.recipients.map((r) => r.userId)).toEqual(['user-3']);
    expect(entries[1]!.email!.body).toContain('5 pupils are over');
  });

  it('is an ABSENCE_WATCH_DIGEST of the school, carrying the notice ids the database gave', () => {
    const [entry] = digestEntries('school-1', [row(1, 'GUARDIAN', 1, 1)]);
    expect(entry).toMatchObject({
      schoolId: 'school-1',
      type: 'ABSENCE_WATCH_DIGEST',
      meta: meta('GUARDIAN', 1, 1),
      recipients: [{ userId: 'user-1', notificationId: 'notice-1' }],
    });
  });

  it('mails only those with an address, in English then Swedish, and carries no name', () => {
    const [entry] = digestEntries('school-1', [row(1, 'MENTOR', 1, 1), row(2, 'MENTOR', 1, 1, null)]);
    expect(entry!.email!.recipients).toEqual([{ userId: 'user-1', email: 'user1@example.invalid' }]);
    expect(entry!.email!.subject).toBe('Absence summary / Frånvarosammanställning');
    expect(entry!.email!.body.split('\n\n')).toHaveLength(2);
    expect(entry!.recipients).toHaveLength(2);
  });

  it('answers nothing for nothing written', () => {
    expect(digestEntries('school-1', [])).toEqual([]);
  });
});
