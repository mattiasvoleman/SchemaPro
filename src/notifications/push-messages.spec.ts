import { PUSH_TEMPLATES, dateOf, pushKindOf, pushText, whenOf, type PushKind, type PushLocale } from './push-messages';
import type { NotificationKind } from './notifications.service';

const TZ = 'Europe/Stockholm';
const KINDS = Object.keys(PUSH_TEMPLATES.sv) as PushKind[];
const LOCALES: PushLocale[] = ['sv', 'en'];

/** Everything a notice's meta carries today that a push must never repeat. */
const SENSITIVE = {
  studentName: 'Ella Ekström',
  teacherName: 'Karin Lund',
  note: 'Sjukskriven, åter onsdag',
  title: 'Föräldramöte 7B',
  subjectName: 'Modersmål arabiska',
  groupName: 'Särskild undervisningsgrupp',
  roomName: 'Kuratorns rum',
  // An avbokning's name is free text the admin typed.
  name: 'Prao Anpassade grundskolan',
};

const META = {
  ...SENSITIVE,
  startsAt: '2026-10-13T06:00:00.000Z',
  date: '2026-10-13',
  startDate: '2026-10-19',
  endDate: '2026-10-21',
  status: 'APPROVED',
  cover: true,
  lessonCount: 3,
};

describe('push messages', () => {
  it('has the same kinds and the same placeholders in Swedish and English', () => {
    expect(Object.keys(PUSH_TEMPLATES.en).sort()).toEqual(KINDS.sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const kind of KINDS) {
      const sv = PUSH_TEMPLATES.sv[kind];
      const en = PUSH_TEMPLATES.en[kind];
      for (const context of [true, false].flatMap((approved) => [1, 3].map((lessons) => ({ approved, lessons })))) {
        const pick = (t: unknown) =>
          typeof t === 'function' ? (t as (c: typeof context) => string)(context) : (t as string);
        expect(holes(pick(en.one))).toEqual(holes(pick(sv.one)));
        expect(holes(pick(en.bare))).toEqual([]);
        expect(holes(pick(sv.bare))).toEqual([]);
      }
      expect(holes(en.many)).toEqual(holes(sv.many));
      expect(sv.title).not.toBe(en.title);
    }
  });

  it.each(KINDS.flatMap((kind) => LOCALES.flatMap((locale) => [1, 3].map((count) => [kind, locale, count] as const))))(
    'never repeats a name, a note, a title, a subject, a group or a room: %s %s ×%d',
    (kind, locale, count) => {
      const text = pushText(kind, META, locale, TZ, count);
      const written = `${text.title} ${text.body}`;
      for (const value of Object.values(SENSITIVE)) {
        for (const word of value.split(' ')) {
          if (word.length > 3) expect(written).not.toContain(word);
        }
      }
      expect(Buffer.byteLength(JSON.stringify(text), 'utf8')).toBeLessThan(300);
      expect(written).not.toMatch(/\{\w+\}/);
    },
  );

  it('says when on the school clock, in each language', () => {
    expect(pushText('LESSON_CANCELLED', META, 'sv', TZ)).toEqual({ title: 'Inställd lektion', body: 'En lektion tis 13 okt 08:00 är inställd.' });
    expect(pushText('LESSON_CANCELLED', META, 'en', TZ)).toEqual({ title: 'Lesson cancelled', body: 'A lesson Tue 13 Oct 08:00 is cancelled.' });
    expect(pushText('LESSON_SUBSTITUTE', META, 'sv', TZ).body).toBe('En lektion tis 13 okt 08:00 har en vikarie.');
    expect(pushText('LESSON_SUBSTITUTE_COVER', META, 'sv', TZ).body).toBe('Du har ett vikariepass tis 13 okt 08:00.');
    expect(pushText('LESSON_COVER_WITHDRAWN', META, 'sv', TZ).body).toBe('Vikariepasset tis 13 okt 08:00 är avbokat.');
    expect(pushText('LESSON_ROOM_CHANGED', META, 'sv', TZ).body).toBe('En lektion tis 13 okt 08:00 har bytt sal.');
    expect(pushText('SCHEDULE_CHANGED', META, 'sv', TZ).body).toBe('Schemat har ändrats.');
    expect(pushText('ABSENCE_UNREPORTED', META, 'sv', TZ).body).toBe('Oanmäld frånvaro 13 okt. Öppna SchemaPro för att se mer.');
    expect(pushText('ABSENCE_UNREPORTED', META, 'en', TZ).body).toBe('Unreported absence 13 Oct. Open SchemaPro to see more.');
    expect(pushText('LEAVE_DECIDED', META, 'sv', TZ).body).toBe('Ledighetsansökan 19 okt–21 okt har beviljats.');
    expect(pushText('LEAVE_DECIDED', { ...META, status: 'REJECTED' }, 'en', TZ).body).toBe('The leave request 19 Oct–21 Oct has been rejected.');
    expect(pushText('ROOM_BOOKING_DECIDED', META, 'sv', TZ).body).toBe('Din lokalbokning tis 13 okt 08:00 har godkänts.');
    expect(pushText('ROOM_BOOKING_DECIDED', { ...META, status: 'REJECTED' }, 'sv', TZ).body).toBe('Din lokalbokning tis 13 okt 08:00 har avslagits.');
    expect(pushText('LESSON_REINSTATED', META, 'sv', TZ)).toEqual({ title: 'Lektion enligt schema', body: 'En lektion tis 13 okt 08:00 blir av som planerat.' });
    expect(pushText('LESSON_REINSTATED', META, 'en', TZ).body).toBe('A lesson Tue 13 Oct 08:00 goes ahead as planned.');
    expect(pushText('LESSON_SUPERVISED_STUDY', META, 'sv', TZ)).toEqual({ title: 'Självstudier', body: 'En lektion tis 13 okt 08:00 blir självstudier under tillsyn.' });
    expect(pushText('LESSON_SUPERVISED_STUDY', META, 'en', TZ).body).toBe('A lesson Tue 13 Oct 08:00 becomes supervised self-study.');
  });

  it('says how many of the person’s lessons an avbokning takes, over which days, and never its name', () => {
    expect(pushText('CANCELLATION_DIGEST', META, 'sv', TZ)).toEqual({ title: 'Inställda lektioner', body: '3 lektioner 19 okt–21 okt är inställda.' });
    expect(pushText('CANCELLATION_DIGEST', META, 'en', TZ).body).toBe('3 lessons 19 Oct–21 Oct are cancelled.');
    const oneDay = { startDate: '2026-10-19', endDate: '2026-10-19', lessonCount: 1 };
    expect(pushText('CANCELLATION_DIGEST', oneDay, 'sv', TZ).body).toBe('En lektion 19 okt är inställd.');
    expect(pushText('CANCELLATION_DIGEST', oneDay, 'en', TZ).body).toBe('A lesson 19 Oct is cancelled.');
    expect(pushText('CANCELLATION_DIGEST_REVERSED', META, 'sv', TZ)).toEqual({
      title: 'Lektioner blir av',
      body: '3 inställda lektioner 19 okt–21 okt blir av som planerat.',
    });
    expect(pushText('CANCELLATION_DIGEST_REVERSED', oneDay, 'en', TZ).body).toBe('A cancelled lesson 19 Oct goes ahead as planned.');
    // Without a count or the days, the bare words.
    expect(pushText('CANCELLATION_DIGEST', { startDate: '2026-10-19', endDate: '2026-10-21' }, 'sv', TZ).body).toBe('Lektioner är inställda.');
    expect(pushText('CANCELLATION_DIGEST', { lessonCount: 2 }, 'sv', TZ).body).toBe('Lektioner är inställda.');
    expect(pushText('CANCELLATION_DIGEST', { ...META, lessonCount: 1.5 }, 'en', TZ).body).toBe('Lessons are cancelled.');
  });

  it('counts several notices of a kind in one push', () => {
    expect(pushText('LESSON_CANCELLED', META, 'sv', TZ, 3).body).toBe('3 lektioner är inställda.');
    expect(pushText('LESSON_SUBSTITUTE_COVER', META, 'en', TZ, 2).body).toBe('You have 2 new cover lessons.');
    expect(pushText('ABSENCE_UNREPORTED', META, 'sv', TZ, 2).body).toBe('2 oanmälda frånvaron 13 okt. Öppna SchemaPro för att se mer.');
    expect(pushText('ABSENCE_UNREPORTED', {}, 'sv', TZ, 2).body).toBe('Oanmäld frånvaro. Öppna SchemaPro för att se mer.');
  });

  it('falls back to a body without a time when the meta has none', () => {
    expect(pushText('LESSON_CANCELLED', {}, 'sv', TZ).body).toBe('En lektion är inställd.');
    expect(pushText('LESSON_CANCELLED', { startsAt: 'not a date' }, 'en', TZ).body).toBe('A lesson is cancelled.');
    expect(pushText('LEAVE_DECIDED', { status: 'APPROVED', startDate: '2026-10-19' }, 'sv', TZ).body).toBe('En ledighetsansökan har beviljats.');
    expect(pushText('ROOM_BOOKING_DECIDED', { status: 'REJECTED' }, 'en', TZ).body).toBe('Your room booking has been rejected.');
  });

  it('crosses the change to winter time on the school clock', () => {
    expect(whenOf('2026-10-24T06:00:00.000Z', 'sv', TZ)).toBe('lör 24 okt 08:00');
    expect(whenOf('2026-10-26T07:00:00.000Z', 'sv', TZ)).toBe('mån 26 okt 08:00');
    expect(whenOf('2026-10-25T00:30:00.000Z', 'en', TZ)).toBe('Sun 25 Oct 02:30');
    expect(whenOf('2026-10-25T01:30:00.000Z', 'en', TZ)).toBe('Sun 25 Oct 02:30');
    expect(whenOf(undefined, 'sv', TZ)).toBeNull();
    expect(dateOf('2026-02-30x', 'sv')).toBeNull();
    expect(dateOf(20261013, 'sv')).toBeNull();
  });

  it('pushes a substitute’s own booking as its own kind, and a teacher’s absence report never', () => {
    expect(pushKindOf('LESSON_SUBSTITUTE', { cover: true })).toBe('LESSON_SUBSTITUTE_COVER');
    expect(pushKindOf('LESSON_SUBSTITUTE', {})).toBe('LESSON_SUBSTITUTE');
    expect(pushKindOf('TEACHER_ABSENCE_REPORTED', {})).toBeNull();
    expect(pushKindOf('CANCELLATION_DIGEST', { reversed: true })).toBe('CANCELLATION_DIGEST_REVERSED');
    expect(pushKindOf('CANCELLATION_DIGEST', { reversed: false })).toBe('CANCELLATION_DIGEST');
    const all: NotificationKind[] = [
      'ABSENCE_UNREPORTED',
      'LEAVE_DECIDED',
      'LESSON_CANCELLED',
      'LESSON_SUBSTITUTE',
      'LESSON_ROOM_CHANGED',
      'SCHEDULE_CHANGED',
      'ROOM_BOOKING_DECIDED',
      'LESSON_COVER_WITHDRAWN',
      'LESSON_REINSTATED',
      'LESSON_SUPERVISED_STUDY',
      'CANCELLATION_DIGEST',
    ];
    for (const type of all) expect(KINDS).toContain(pushKindOf(type, {}));
  });
});
