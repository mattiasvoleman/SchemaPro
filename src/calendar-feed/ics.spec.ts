import { escapeText, feedIcs as writeIcs, fold, sequenceOf, utcStamp, type FeedDocument, type FeedLesson } from './ics';
import { feedTokenOf } from './feed-token';
import { icsProblems } from './ics-check';

/**
 * A calendar feed written down (Kalenderprenumeration, 20261112091000): what
 * app.calendar_feed answers becomes RFC 5545 lines a calendar takes. Which
 * lessons and which names are the database's (RLS sections 145–148, the
 * adapter probe); this is the writing.
 */

const SCOPE = '66666666-6666-4666-8666-666666666666';
const ASKED = new Date('2026-10-16T05:30:12.345Z');
const feedIcs = (document: FeedDocument, stamp: Date = ASKED) => writeIcs(document, stamp);

const lesson = (overrides: Partial<FeedLesson> = {}): FeedLesson => ({
  id: '11111111-1111-4111-8111-111111111111',
  date: '2026-10-12',
  start: '20261012T081000',
  end: '20261012T091000',
  startUtc: '20261012T061000Z',
  endUtc: '20261012T071000Z',
  cancelled: false,
  subject: 'Matematik',
  room: 'Sal 101',
  groups: [],
  teachers: ['ANLI'],
  substitute: false,
  version: '20261001T080000Z',
  ...overrides,
});

const pupilWeek = (overrides: Partial<FeedDocument> = {}): FeedDocument => ({
  audience: 'GUARDIAN',
  scope: SCOPE,
  locale: 'sv',
  title: 'Ella',
  school: 'Skolan i Exempelby',
  timezone: 'Europe/Stockholm',
  lessons: [lesson()],
  breaks: [],
  ...overrides,
});

/** The calendar unfolded and split into its lines, as a client reads it. */
const linesOf = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');
const eventsOf = (ics: string) =>
  ics
    .replace(/\r\n /g, '')
    .split('BEGIN:VEVENT\r\n')
    .slice(1)
    .map((block) => block.split('\r\nEND:VEVENT')[0]!.split('\r\n'));

describe('feedIcs', () => {
  it('is one VCALENDAR in CRLF lines, named for whose week it is, with Stockholm\'s zone defined', () => {
    const ics = feedIcs(pupilWeek());
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = linesOf(ics);
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines).toContain('X-WR-CALNAME:Schema – Ella (Skolan i Exempelby)');
    expect(lines).toContain('BEGIN:VTIMEZONE');
    expect(lines).toContain('TZID:Europe/Stockholm');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(lines).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
  });

  it('writes a lesson on the school\'s clock, its UID its own id and whose week, its version when it last changed', () => {
    const [event] = eventsOf(feedIcs(pupilWeek()));
    expect(event).toEqual([
      `UID:11111111-1111-4111-8111-111111111111.${SCOPE}@schemapro`,
      'DTSTAMP:20261016T053012Z',
      'LAST-MODIFIED:20261001T080000Z',
      `SEQUENCE:${sequenceOf('20261001T080000Z')}`,
      'DTSTART;TZID=Europe/Stockholm:20261012T081000',
      'DTEND;TZID=Europe/Stockholm:20261012T091000',
      'SUMMARY:Matematik',
      'LOCATION:Sal 101',
      'DESCRIPTION:Lärare: ANLI',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
    ]);
  });

  it('is the same bytes until the week is, but for each entry\'s DTSTAMP, the time of the ask', () => {
    const later = feedIcs(pupilWeek(), new Date('2026-10-16T06:00:00Z'));
    expect(feedIcs(pupilWeek())).not.toBe(later);
    expect(feedIcs(pupilWeek()).replace(/^DTSTAMP:.*\r\n/gm, '')).toBe(later.replace(/^DTSTAMP:.*\r\n/gm, ''));
    expect(linesOf(later)).toContain('DTSTAMP:20261016T060000Z');
  });

  it('gives two weeks\' entries of one lesson two UIDs, so a calendar holding both feeds keeps both', () => {
    const ella = linesOf(feedIcs(pupilWeek())).find((line) => line.startsWith('UID:'));
    const hugo = linesOf(feedIcs(pupilWeek({ scope: '88888888-8888-4888-8888-888888888888' }))).find((line) => line.startsWith('UID:'));
    expect(ella).not.toBe(hugo);
  });

  it('keeps a cancelled lesson, says it in the summary, and leaves the time free', () => {
    const [event] = eventsOf(feedIcs(pupilWeek({ lessons: [lesson({ cancelled: true, teachers: [] })] })));
    expect(event).toContain('SUMMARY:Inställd: Matematik');
    expect(event).toContain('STATUS:CANCELLED');
    expect(event).toContain('TRANSP:TRANSPARENT');
    expect(event!.some((line) => line.startsWith('DESCRIPTION'))).toBe(false);
  });

  it('marks a substitute on a family\'s lesson without naming anyone, and a teacher\'s own cover with the lesson\'s groups and colleagues', () => {
    const [family] = eventsOf(feedIcs(pupilWeek({ lessons: [lesson({ substitute: true, teachers: [] })] })));
    expect(family).toContain('DESCRIPTION:Vikarie');
    const [teacher] = eventsOf(
      feedIcs(
        pupilWeek({
          audience: 'TEACHER',
          title: 'Anna Lind',
          lessons: [lesson({ substitute: true, groups: ['7A', 'Spanska 7'], teachers: ['Bo Ek'] })],
        }),
      ),
    );
    expect(teacher).toContain('DESCRIPTION:7A\\, Spanska 7\\nDu är vikarie\\nLärare: Bo Ek');
  });

  it('speaks English when the address was made in English', () => {
    const ics = feedIcs(pupilWeek({ locale: 'en', lessons: [lesson({ cancelled: true }), lesson({ id: 'b', substitute: true })] }));
    const lines = linesOf(ics);
    expect(lines).toContain('X-WR-CALNAME:Timetable – Ella (Skolan i Exempelby)');
    expect(lines).toContain('SUMMARY:Cancelled: Matematik');
    expect(lines).toContain('DESCRIPTION:Substitute');
  });

  it('writes lov and studiedagar as all-day entries of free time', () => {
    const [entry] = eventsOf(
      feedIcs(
        pupilWeek({
          lessons: [],
          breaks: [{ id: 'b-1', name: 'Höstlov', kind: 'HOLIDAY', from: '20261026', until: '20261031', version: '20260901T120000Z' }],
        }),
      ),
    );
    expect(entry).toEqual([
      `UID:break-b-1.${SCOPE}@schemapro`,
      'DTSTAMP:20261016T053012Z',
      'LAST-MODIFIED:20260901T120000Z',
      `SEQUENCE:${sequenceOf('20260901T120000Z')}`,
      'DTSTART;VALUE=DATE:20261026',
      'DTEND;VALUE=DATE:20261031',
      'SUMMARY:Höstlov',
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
    ]);
  });

  it('writes UTC times, and no zone it would not define, for a school on another clock', () => {
    const ics = feedIcs(pupilWeek({ timezone: 'Europe/Helsinki' }));
    const lines = linesOf(ics);
    expect(lines).not.toContain('BEGIN:VTIMEZONE');
    expect(ics).not.toContain('TZID=');
    expect(lines).toContain('DTSTART:20261012T061000Z');
    expect(lines).toContain('DTEND:20261012T071000Z');
  });

  it('escapes what the format reserves in a name the school typed', () => {
    const [event] = eventsOf(feedIcs(pupilWeek({ lessons: [lesson({ subject: 'Bild; form, och\\ text', room: 'Sal 1,2' })] })));
    expect(event).toContain('SUMMARY:Bild\\; form\\, och\\\\ text');
    expect(event).toContain('LOCATION:Sal 1\\,2');
  });

  it('never lets a name the school pasted end a line or carry a control character', () => {
    const ics = feedIcs(pupilWeek({ lessons: [lesson({ subject: 'Bild\rUID:x', room: 'Sal\u0000 1\u001b\u007f\t2' })] }));
    expect(icsProblems(ics)).toEqual([]);
    const [event] = eventsOf(ics);
    expect(event).toContain('SUMMARY:Bild\\nUID:x');
    expect(event).toContain('LOCATION:Sal 1\t2');
    expect(event!.filter((line) => line.startsWith('UID:'))).toHaveLength(1);
  });
});

describe('the feed as a calendar takes it', () => {
  it('is well formed, a long Swedish name, a cancelled lesson, a day off and both clocks alike', () => {
    const week = pupilWeek({
      lessons: [lesson({ subject: `Svenska som andraspråk ${'och ämnesövergripande '.repeat(4)}`, teachers: ['Åsa Öberg', 'Ärla Ång'] }), lesson({ id: 'b', cancelled: true })],
      breaks: [{ id: 'h', name: 'Höstlov', kind: 'HOLIDAY', from: '20261026', until: '20261031', version: '20260901T120000Z' }],
    });
    expect(icsProblems(feedIcs(week))).toEqual([]);
    expect(icsProblems(feedIcs({ ...week, timezone: 'Europe/Helsinki' }))).toEqual([]);
    expect(icsProblems(feedIcs({ ...week, lessons: [], breaks: [] }))).toEqual([]);
  });

  it('is found wanting where a calendar would be', () => {
    expect(icsProblems('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=X:20261012T081000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')).toEqual([
      'TZID X is defined by no VTIMEZONE before it',
      'a VEVENT has no UID',
      'a VEVENT has no DTSTAMP',
    ]);
    expect(icsProblems('BEGIN:VCALENDAR\r\nX-A:a\rb\r\nX-B:\u0007\r\nEND:VCALENDAR\r\n')).toEqual([
      'a CR stands alone',
      'a control character is in the text',
    ]);
  });
});

describe('fold', () => {
  it('keeps every physical line to 75 octets, breaking between code points, never inside one', () => {
    const line = `SUMMARY:${'Åäö'.repeat(40)}`;
    const folded = fold(line);
    for (const physical of folded.split('\r\n')) expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(folded.split('\r\n').slice(1).every((physical) => physical.startsWith(' '))).toBe(true);
  });

  it('leaves a short line alone', () => {
    expect(fold('SUMMARY:Matematik')).toBe('SUMMARY:Matematik');
  });
});

describe('escapeText, utcStamp and sequenceOf', () => {
  it('escapes a line break of any kind as \\n, and drops every other control character but the tab', () => {
    expect(escapeText('a\nb\r\nc\rd')).toBe('a\\nb\\nc\\nd');
    expect(escapeText('a\u0000b\u0008c\td\u000be\u001ff\u007fg')).toBe('abc\tdefg');
  });

  it('writes a moment as UTC to the second', () => {
    expect(utcStamp(ASKED)).toBe('20261016T053012Z');
  });

  it('grows with the version, and is 0 for one it cannot read or one before 2024', () => {
    expect(sequenceOf('20261001T080001Z')).toBe(sequenceOf('20261001T080000Z') + 1);
    expect(sequenceOf('nonsense')).toBe(0);
    expect(sequenceOf('20200101T000000Z')).toBe(0);
  });
});

describe('feedTokenOf', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  it('takes a token with or without .ics, and nothing else', () => {
    expect(feedTokenOf(token)).toBe(token);
    expect(feedTokenOf(`${token}.ics`)).toBe(token);
    expect(feedTokenOf(`${token}.ical`)).toBeNull();
    expect(feedTokenOf('short.ics')).toBeNull();
    expect(feedTokenOf(undefined)).toBeNull();
    expect(feedTokenOf(`${token}x`)).toBeNull();
  });
});
